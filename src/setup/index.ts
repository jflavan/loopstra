import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { ConfigError, configPath, NOT_SET_UP, type Config } from "../config";
import { errorText, within } from "../shell";
import { ConfigDocument } from "./document";
import { DefaultsPrompt, SetupStopped, StreamPrompt, type Prompt } from "./prompt";
import { SECTIONS } from "./sections";
import type { Check, Section, SetupContext } from "./types";

export const NEEDS_TERMINAL = "loopstra setup asks questions: run it in a terminal, or use --defaults (take every suggestion) or --check (only check).";

export const SETUP_USAGE = "Usage: loopstra setup [section] [--defaults | --check]";

export interface SetupOptions {
  /** One section by name; all of them when absent. */
  section?: string;
  defaults?: boolean;
  check?: boolean;
  input?: Readable;
  output?: Writable;
  /** Whether a person is at the input; process.stdin.isTTY when absent. */
  interactive?: boolean;
  /** A prompt already reading the input (init's offer), so the stream is read by one reader only. */
  prompt?: Prompt;
  env?: Record<string, string | undefined>;
  /** The sections to choose from; SECTIONS when absent (tests pass their own). */
  sections?: Section[];
  /** How long one section's checks may take; claude.timeout_minutes plus a minute when absent. */
  checkMs?: number;
}

/** `loopstra setup --help`: the usage line, then each section's name and title. */
export function setupHelp(sections: Section[] = SECTIONS): string {
  const width = Math.max(...sections.map((s) => s.name.length)) + 2;
  return `${SETUP_USAGE}\n\nSections:\n${sections.map((s) => `  ${s.name.padEnd(width)}${s.title}\n`).join("")}`;
}

/**
 * The command line after `setup`: at most one section, and --defaults or --check (not both); with
 * --help or -h, only { help: true }. Null when it is none of those.
 */
export function parseSetupArgs(args: readonly string[]): (Pick<SetupOptions, "section" | "defaults" | "check"> & { help?: true }) | null {
  if (args.some((a) => a === "--help" || a === "-h")) return { help: true };
  const flags = args.filter((a) => a.startsWith("-"));
  const names = args.filter((a) => !a.startsWith("-"));
  if (names.length > 1 || flags.some((f) => f !== "--defaults" && f !== "--check")) return null;
  const defaults = flags.includes("--defaults");
  const check = flags.includes("--check");
  if (defaults && check) return null;
  return { section: names[0], defaults, check };
}

/**
 * `loopstra setup`: each section asks its questions, the config is checked and saved once (with its
 * comments), then the checks run. Quitting, a section that fails, or a config that would not load
 * saves nothing. Returns the exit code: 0 once saved (a failed check is listed, not an error), 1 when
 * nothing could be saved; with --check, 1 when the config does not load or any check fails.
 * A prompt it is given is closed whichever way it ends.
 */
export async function setup(root: string, o: SetupOptions = {}): Promise<number> {
  try {
    return await runSetup(root, o);
  } finally {
    o.prompt?.close();
  }
}

async function runSetup(root: string, o: SetupOptions): Promise<number> {
  const output = o.output ?? process.stdout;
  const out = (line: string) => { output.write(`${line}\n`); };
  if (!existsSync(configPath(root))) { out(NOT_SET_UP); return 1; }
  const all = o.sections ?? SECTIONS;
  const sections = o.section ? all.filter((s) => s.name === o.section) : all;
  if (o.section && !sections.length) {
    out(`There is no setup section called ${o.section}. Sections: ${all.map((s) => s.name).join(", ")}.`);
    return 1;
  }
  const env = o.env ?? process.env;
  if (o.check) return checkOnly(root, sections, env, out, o.checkMs);
  if (!o.defaults && !(o.interactive ?? process.stdin.isTTY)) { out(NEEDS_TERMINAL); return 1; }

  let doc: ConfigDocument;
  try { doc = ConfigDocument.load(root); } catch (e) { out(errorText(e)); return 1; }
  try { doc.validate(); } catch (e) {
    // The questions can fix a value under a key a section edits; not an unknown key, and not the rest of the file.
    const covered = new Set(sections.flatMap((s) => s.covers));
    const problems = e instanceof ConfigError ? e.problems : [];
    if (!problems.length || problems.some((p) => p.unknownKey || !covered.has(p.path[0] ?? ""))) {
      out(`Fix these in loopstra/config.yaml first:\n${problems.length ? problems.map((p) => `- ${p.text}`).join("\n") : errorText(e)}`);
      return 1;
    }
    out(`Note: loopstra/config.yaml has problems now; the questions below can fix them:\n${problems.map((p) => `- ${p.text}`).join("\n")}`);
  }
  const ask: Prompt = o.defaults ? new DefaultsPrompt(out) : o.prompt ?? new StreamPrompt(o.input ?? process.stdin, output);
  const ctx: SetupContext = { root, doc, ask, env };
  try {
    for (const s of sections) {
      out(`\n${s.title}`);
      await s.ask(ctx);
    }
  } catch (e) {
    out(e instanceof SetupStopped ? e.message : `\nNot saved: ${errorText(e)}`);
    return 1;
  } finally {
    ask.close();
  }

  let cfg: Config;
  try {
    cfg = doc.validate();
    out(doc.save() ? "\nSaved loopstra/config.yaml. Commit it on the main branch so every checkout uses it." : "\nNo changes.");
  } catch (e) {
    out(`\nNot saved: ${errorText(e)}`);
    return 1;
  }
  report(await runChecks(sections, ctx, cfg, o.checkMs), out);
  return 0;
}

async function checkOnly(root: string, sections: Section[], env: SetupContext["env"], out: (line: string) => void, checkMs?: number): Promise<number> {
  let doc: ConfigDocument;
  let cfg: Config;
  try {
    doc = ConfigDocument.load(root);
    cfg = doc.validate();
  } catch (e) { out(errorText(e)); return 1; }
  out("loopstra/config.yaml loads.");
  const checks = await runChecks(sections, { root, doc, ask: new DefaultsPrompt(() => {}), env }, cfg, checkMs);
  report(checks, out);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

/** "3 minutes", or "5 seconds" under a minute. */
function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

/** Every section's checks at the same time, each under the time limit, listed in section order and marked with their section. */
async function runChecks(sections: Section[], ctx: SetupContext, cfg: Config, checkMs?: number): Promise<Check[]> {
  const limit = checkMs ?? (cfg.claude.timeout_minutes + 1) * 60_000;
  const late = Symbol("late");
  const one = async (s: Section): Promise<Check[]> => {
    try {
      const checks = await within(s.check(ctx, cfg), limit, late);
      if (checks === late) return [{ level: "fail", text: `${s.title}: the check did not finish in ${duration(limit)}` }];
      return checks;
    } catch (e) { return [{ level: "fail", text: `${s.title}: the check could not run: ${errorText(e)}` }]; }
  };
  const all = await Promise.all(sections.map(async (s) => (await one(s)).map((c) => ({ ...c, section: s.name }))));
  return all.flat();
}

const MARK: Record<Check["level"], string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function report(checks: Check[], out: (line: string) => void): void {
  if (!checks.length) return;
  out("\nChecks:");
  for (const c of checks) out(`  ${MARK[c.level]}  ${c.text}`);
  const toFix = checks.filter((c) => c.level !== "ok");
  if (!toFix.length) return;
  // The command takes one section at a time, so each is named as its own command.
  const runs = [...new Set(toFix.map((c) => c.section))].map((name) => (name ? `loopstra setup ${name}` : "loopstra setup"));
  const which = runs.length > 1 ? `${runs.slice(0, -1).join(", ")} or ${runs.at(-1)}` : runs[0];
  out(`\nTo fix: ${toFix.length} item${toFix.length > 1 ? "s" : ""} above. Run ${which} again once fixed, or loopstra setup --check.`);
}
