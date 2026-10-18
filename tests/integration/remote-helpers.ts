import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE, run, TEMPLATES, tempDir, tempGitRepo } from "../helpers";

export const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

export const SLUG = "add-numbers";
export const BRANCH = `intent/${SLUG}`;
export const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

export interface FakePr { number: number; state: string; reviewDecision: string; checks: string; checksHead?: string; merged: boolean; mergeCommit?: string; createdAt?: string; title?: string; body?: string; comments: string[] }

/**
 * A bare "GitHub" remote and a clone of it with Loopstra set up and one intent at plan-approved.
 * The fake gh merges on the bare remote for real, the way GitHub would.
 */
export async function remoteSetup(config = "") {
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  const repo = await tempGitRepo();
  await run(["git", "remote", "add", "origin", remote.path], repo.path);
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: bun test\n${config}`);
  await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await Bun.write(join(repo.path, "tests", "smoke.test.ts"), 'import { expect, test } from "bun:test";\ntest("smoke", () => { expect(1 + 1).toBe(2); });\n');
  mkdirSync(join(repo.path, "intent", SLUG), { recursive: true });
  await Bun.write(join(repo.path, "intent", SLUG, "intent.md"), "---\nstatus: plan-approved\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n");
  await Bun.write(join(repo.path, "intent", SLUG, "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(repo.path, "intent", SLUG, "plan.md"), PLAN);
  await new Git(repo.path).commitAll("setup");
  await run(["git", "push", "-q", "-u", "origin", "main"], repo.path);
  // The fake gh keeps its pull requests next to the bare repository (git ignores the extra files).
  const state = join(remote.path, "fake-gh.json");
  const log = join(remote.path, "fake-gh.log");
  const env = { LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_STATE: state, LOOPSTRA_FAKE_GH_REMOTE: remote.path, LOOPSTRA_FAKE_GH_LOG: log };
  const pr = async (): Promise<FakePr> => (await Bun.file(state).json()).prs[BRANCH];
  const setPr = async (patch: Partial<FakePr>) => {
    const s = await Bun.file(state).json();
    Object.assign(s.prs[BRANCH], patch);
    await Bun.write(state, JSON.stringify(s));
  };
  const ghCalls = async (): Promise<string[][]> => existsSync(log) ? (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l)) : [];
  const cleanup = () => { repo.cleanup(); remote.cleanup(); };
  return { repo: repo.path, remote: remote.path, env, pr, setPr, ghCalls, cleanup };
}

export async function intentOf(repo: string) {
  return (await readIntent(repo, SLUG)).file.frontmatter;
}

/** A separate clone of the remote, as a person elsewhere (or GitHub's web editor) would use. */
export async function elsewhere(remote: string) {
  const t = tempDir("loopstra-elsewhere-");
  await run(["git", "clone", "-q", remote, "."], t.path);
  await run(["git", "config", "user.email", "person@example.com"], t.path);
  await run(["git", "config", "user.name", "Person"], t.path);
  return t;
}

export async function onRemoteMain(remote: string, path: string): Promise<boolean> {
  return (await run(["git", "cat-file", "-e", `main:${path}`], remote)).code === 0;
}

/** The change's branch head on the remote. */
export async function headOn(remote: string): Promise<string> {
  return (await run(["git", "rev-parse", BRANCH], remote)).out.trim();
}

export function inTrace<T>(repo: string, fn: (t: Trace) => T): T {
  const t = Trace.open(repo);
  try { return fn(t); } finally { t.close(); }
}

/**
 * A bun script for the fake gh's knobs: a person pushes a commit adding src/person.ts to the change's
 * branch on the remote, the first time it runs (`done` exists after).
 */
export async function personPushesOnce(remote: string): Promise<{ script: string; done: string }> {
  const done = join(remote, "person-pushed");
  const script = join(remote, "person-pushes.ts");
  await Bun.write(script, [
    'import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    `if (!existsSync(${JSON.stringify(done)})) {`,
    '  const dir = mkdtempSync(join(tmpdir(), "loopstra-person-"));',
    '  const git = (...a: string[]) => Bun.spawnSync({ cmd: ["git", "-c", "user.name=Person", "-c", "user.email=person@example.com", ...a], cwd: dir });',
    `  git("clone", "-q", "-b", ${JSON.stringify(BRANCH)}, ${JSON.stringify(remote)}, ".");`,
    '  writeFileSync(join(dir, "src", "person.ts"), "export const person = 1;");',
    '  git("add", "-A");',
    '  git("commit", "-q", "-m", "person: a fix");',
    `  git("push", "-q", "origin", ${JSON.stringify(BRANCH)});`,
    '  rmSync(dir, { recursive: true, force: true });',
    `  writeFileSync(${JSON.stringify(done)}, "");`,
    "}",
    "",
  ].join("\n"));
  return { script, done };
}
