import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { configPath, loadConfig, NOT_SET_UP, type Config } from "../config";
import { errorText } from "../shell";
import { ConfigDocument } from "./document";
import { DefaultsPrompt, SetupStopped, StreamPrompt, type Prompt } from "./prompt";
import { SECTIONS } from "./sections";
import type { Check, Section, SetupContext } from "./types";

export const NEEDS_TERMINAL = "loopstra setup asks questions: run it in a terminal, or use --defaults (take every suggestion) or --check (only check).";

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
}

/**
 * `loopstra setup`: each section asks its questions, the config is checked and saved once (with its
 * comments), then the checks run. Quitting, or a config that would not load, saves nothing. Returns
 * the exit code: 0 once saved (a failed check is listed, not an error), 1 when nothing could be saved;
 * with --check, 1 when any check fails.
 */
export async function setup(root: string, o: SetupOptions = {}): Promise<number> {
  const output = o.output ?? process.stdout;
  const out = (line: string) => { output.write(`${line}\n`); };
  if (!existsSync(configPath(root))) { out(NOT_SET_UP); return 1; }
  const sections = o.section ? SECTIONS.filter((s) => s.name === o.section) : SECTIONS;
  if (o.section && !sections.length) {
    out(`There is no setup section called ${o.section}. Sections: ${SECTIONS.map((s) => s.name).join(", ")}.`);
    return 1;
  }
  const env = o.env ?? process.env;
  if (o.check) return checkOnly(root, sections, env, out);
  if (!o.defaults && !(o.interactive ?? process.stdin.isTTY)) { out(NEEDS_TERMINAL); return 1; }

  let doc: ConfigDocument;
  try { doc = ConfigDocument.load(root); } catch (e) { out(errorText(e)); return 1; }
  const ask: Prompt = o.defaults ? new DefaultsPrompt(out) : o.prompt ?? new StreamPrompt(o.input ?? process.stdin, output);
  const ctx: SetupContext = { root, doc, ask, env };
  try {
    for (const s of sections) {
      out(`\n${s.title}`);
      await s.ask(ctx);
    }
  } catch (e) {
    if (e instanceof SetupStopped) { out(e.message); return 1; }
    throw e;
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
  report(await runChecks(sections, ctx, cfg), out);
  return 0;
}

async function checkOnly(root: string, sections: Section[], env: SetupContext["env"], out: (line: string) => void): Promise<number> {
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch (e) { out(errorText(e)); return 1; }
  const checks = await runChecks(sections, { root, doc: ConfigDocument.load(root), ask: new DefaultsPrompt(() => {}), env }, cfg);
  report(checks, out);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

async function runChecks(sections: Section[], ctx: SetupContext, cfg: Config): Promise<Check[]> {
  const all: Check[] = [];
  for (const s of sections) {
    try { all.push(...(await s.check(ctx, cfg))); }
    catch (e) { all.push({ level: "fail", text: `${s.title}: the check could not run: ${errorText(e)}` }); }
  }
  return all;
}

const MARK: Record<Check["level"], string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function report(checks: Check[], out: (line: string) => void): void {
  if (!checks.length) return;
  out("\nChecks:");
  for (const c of checks) out(`  ${MARK[c.level]}  ${c.text}`);
  const toFix = checks.filter((c) => c.level !== "ok").length;
  if (toFix) out(`\nTo fix: ${toFix} item${toFix > 1 ? "s" : ""} above. Run loopstra setup <section> again once fixed, or loopstra setup --check.`);
}
