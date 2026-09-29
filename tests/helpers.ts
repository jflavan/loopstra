import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_CLAUDE_ENV } from "../src/claude";
import { configPath, loadConfig } from "../src/config";
import { StepContext } from "../src/context";
import { Git } from "../src/git";
import { readIntent } from "../src/intents";
import { Trace } from "../src/trace";

/** The fake `claude` executable and the shipped prompt templates, as file system paths. */
export const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude/claude.ts", import.meta.url));
export const TEMPLATES = fileURLToPath(new URL("../templates/prompts", import.meta.url));

export function tempDir(prefix = "loopstra-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export async function tempGitRepo(): Promise<{ path: string; cleanup: () => void }> {
  const t = tempDir("loopstra-repo-");
  await run(["git", "init", "-q", "-b", "main"], t.path);
  await run(["git", "config", "user.email", "loopstra-test@example.com"], t.path);
  await run(["git", "config", "user.name", "Loopstra Test"], t.path);
  await Bun.write(join(t.path, "README.md"), "# test repo\n");
  // .loopstra/ holds the trace db and run artifacts the runtime creates as a side effect
  // of opening a Trace or StepContext; ignoring it keeps `isDirty()` meaningful for tests
  // that check the repo is clean after committing only the paths they intended to commit.
  await Bun.write(join(t.path, ".gitignore"), ".loopstra/\n");
  await run(["git", "add", "-A"], t.path);
  await run(["git", "commit", "-q", "-m", "init"], t.path);
  return t;
}

export interface SetupOptions {
  /** The `commands` block of the config. Defaults to a test command that always passes. */
  commands?: Record<string, string>;
  /** Further config YAML appended after `commands` (gates, stages, ...). */
  config?: string;
}

/**
 * A temp repo with prompts, config, and one intent `add-numbers` at `status`, plus a StepContext on
 * it. The fake claude is set in the environment until `repo.cleanup()`, which restores what was there.
 */
export async function setupRepo(status: string, opts: SetupOptions = {}) {
  const temp = await tempGitRepo();
  const restoreEnv = setEnv({ [FAKE_CLAUDE_ENV]: FAKE_CLAUDE });
  const repo = { path: temp.path, cleanup: () => { restoreEnv(); temp.cleanup(); } };
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  const commands = Object.entries(opts.commands ?? { test: "echo ok" }).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}\n`).join("");
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n${commands}${opts.config ?? ""}`);
  mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), `---\nstatus: ${status}\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n`);
  await new Git(repo.path).commitAll("intent");
  return { repo, ...(await openRepo(repo.path)) };
}

/** A fresh Trace and a StepContext on the `add-numbers` intent of a repository setupRepo made (or a copy of one). */
export async function openRepo(path: string): Promise<{ ctx: StepContext; trace: Trace }> {
  const trace = Trace.open(path);
  return { ctx: new StepContext(path, await loadConfig(path), trace, await readIntent(path, "add-numbers")), trace };
}

/**
 * A copy of a prepared repository in a fresh temp directory, with the links between it and its
 * worktrees under .loopstra/worktrees repaired, so tests that start from the same state build it
 * once and copy it (a copy takes a fraction of a rebuild). Close the template's trace first.
 */
export async function copyRepo(template: string): Promise<{ path: string; cleanup: () => void }> {
  const t = tempDir("loopstra-repo-");
  cpSync(template, t.path, { recursive: true });
  const worktrees = join(t.path, ".loopstra", "worktrees");
  // Point each copied worktree and its admin entry at the copy. `git worktree repair` is not used:
  // older git (2.34) follows the copied link back to the template and rewires the template instead.
  for (const name of existsSync(worktrees) ? readdirSync(worktrees) : []) {
    const wt = join(worktrees, name);
    const admin = join(t.path, ".git", "worktrees", name);
    if (!existsSync(admin)) continue;
    writeFileSync(join(wt, ".git"), `gitdir: ${admin.replaceAll("\\", "/")}\n`);
    writeFileSync(join(admin, "gitdir"), `${join(wt, ".git").replaceAll("\\", "/")}\n`);
  }
  return t;
}

/** The newest commit in a checkout, as "<short sha> <subject>". */
export async function lastCommit(cwd: string): Promise<string> {
  return (await new Git(cwd).run(["log", "-1", "--format=%h %s"])).out.trim();
}

/** Sets environment variables and returns a function that puts back what was there before. */
export function setEnv(vars: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Runs `fn` with environment overrides, restoring the previous values afterwards even if it throws. */
export async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const restore = setEnv(vars);
  try {
    return await fn();
  } finally {
    restore();
  }
}
