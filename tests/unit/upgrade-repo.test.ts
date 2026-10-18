import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../src/init";
import { writeHeartbeat, type Heartbeat } from "../../src/heartbeat";
import { readStamp, textSha, writeStamp } from "../../src/stamp";
import { templatePath } from "../../src/package";
import type { Migration } from "../../src/upgrade/migrations";
import { LOOP_RUNNING, statusPaths, upgradeRepo, type RepoDeps } from "../../src/upgrade/repo";
import type { ShippedIndex } from "../../src/shipped";
import { run, tempGitRepo } from "../helpers";

const OLD_SKILL = "old skill text\n";
const SKILL = ".claude/skills/loopstra/SKILL.md";

/** A repository set up by init, with a test command, all committed on main. */
async function setUpRepo() {
  const repo = await tempGitRepo();
  await init(repo.path);
  const cfg = join(repo.path, "loopstra", "config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace('test: ""', 'test: "bun test"'));
  await run(["git", "add", "-A"], repo.path);
  await run(["git", "commit", "-q", "-m", "set up"], repo.path);
  return repo;
}

/** Makes the skill an unedited copy of an older shipped text, recorded in a stamp of version 0.8.0, committed. */
async function olderSkill(root: string) {
  writeFileSync(join(root, SKILL), OLD_SKILL);
  writeStamp(root, { loopstra: "0.8.0", files: { ...readStamp(root)!.files, [SKILL]: { base: textSha(OLD_SKILL) } } });
  await run(["git", "commit", "-qam", "older"], root);
}

const deps = (index: ShippedIndex = {}, texts: Record<string, string> = {}, version = "0.9.0"): RepoDeps => ({
  index: async () => index,
  fetchText: async (_t: string, commit: string) => texts[commit] ?? null,
  version: async () => version,
  notes: async () => "- feat: something new",
});

const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  pid: process.pid, startedAt: new Date().toISOString(), lastTickAt: null, lastBeatAt: new Date().toISOString(),
  current: null, stopping: false, stopped: false, ...over,
});

const status = async (root: string) => (await run(["git", "status", "--porcelain"], root)).out.trim();
const head = async (root: string) => (await run(["git", "rev-parse", "HEAD"], root)).out.trim();

describe("upgradeRepo", () => {
  test("a repository already up to date: nothing to commit", async () => {
    const repo = await setUpRepo();
    try {
      const r = await upgradeRepo(repo.path, { check: false }, deps({}, {}, readStamp(repo.path)!.loopstra));
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(false);
      expect(readStamp(repo.path)!.loopstra).toMatch(/^0\.0\.0-dev/);
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("an unedited managed file is replaced and committed as Loopstra, with the versions and notes", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(true);
      expect(r.files.find((f) => f.path === SKILL)!.outcome).toBe("replaced");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(readFileSync(templatePath("skill", "SKILL.md"), "utf8"));
      expect(readStamp(repo.path)).toMatchObject({ loopstra: "0.9.0", files: { [SKILL]: { base: textSha(readFileSync(templatePath("skill", "SKILL.md"), "utf8")) } } });
      const log = (await run(["git", "log", "-1", "--format=%an%n%B"], repo.path)).out;
      expect(log).toContain("Loopstra\nloopstra: upgrade to 0.9.0 (from 0.8.0)\n\n- feat: something new");
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("no release notes in the commit from a development checkout's stamp", async () => {
    const repo = await setUpRepo();
    try {
      writeFileSync(join(repo.path, SKILL), OLD_SKILL);
      writeStamp(repo.path, { loopstra: "0.0.0-dev+abc1234", files: { ...readStamp(repo.path)!.files, [SKILL]: { base: textSha(OLD_SKILL) } } });
      await run(["git", "commit", "-qam", "older"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.committed).toBe(true);
      expect((await run(["git", "log", "-1", "--format=%B"], repo.path)).out.trim()).toBe("loopstra: upgrade to 0.9.0 (from 0.0.0-dev+abc1234)");
    } finally { repo.cleanup(); }
  });

  test("a person's other staged work stays staged and out of the commit", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      writeFileSync(join(repo.path, "notes.txt"), "mine\n");
      await run(["git", "add", "notes.txt"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.committed).toBe(true);
      expect((await run(["git", "show", "--name-only", "--format=", "HEAD"], repo.path)).out).not.toContain("notes.txt");
      expect(await status(repo.path)).toBe("A  notes.txt");
    } finally { repo.cleanup(); }
  });

  test("--check reports and writes nothing", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const before = readFileSync(join(repo.path, "loopstra", "stamp.json"), "utf8");
      const r = await upgradeRepo(repo.path, { check: true }, deps());
      expect(r.ok).toBe(true);
      expect(r.files.find((f) => f.path === SKILL)!.outcome).toBe("replaced");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      expect(readFileSync(join(repo.path, "loopstra", "stamp.json"), "utf8")).toBe(before);
      expect(r.committed).toBe(false);
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("a conflicted file is listed and left out of the commit", async () => {
    const repo = await setUpRepo();
    try {
      const review = join(repo.path, "REVIEW.md");
      const shipped = readFileSync(templatePath("REVIEW.md"), "utf8");
      const firstLine = shipped.split("\n")[0]!;
      const base = shipped.replace(firstLine, "# Base title");
      writeFileSync(review, shipped.replace(firstLine, "# Our title"));
      writeStamp(repo.path, { loopstra: "0.8.0", files: { ...readStamp(repo.path)!.files, "REVIEW.md": { base: textSha(base) } } });
      await run(["git", "commit", "-qam", "older"], repo.path);
      const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: textSha(base), commit: "b1" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index, { b1: base }));
      expect(r.ok).toBe(true);
      expect(r.files.find((f) => f.path === "REVIEW.md")!.outcome).toBe("conflict");
      expect(readFileSync(review, "utf8")).toContain("<<<<<<<");
      // The stamp (with the new version and REVIEW.md's new base) is committed; REVIEW.md is not.
      expect(r.committed).toBe(true);
      expect(readStamp(repo.path)!.files["REVIEW.md"]).toEqual({ base: textSha(shipped) });
      expect(await status(repo.path)).toBe("M REVIEW.md");
    } finally { repo.cleanup(); }
  });

  test("refuses off main, with uncommitted managed files, or with the loop running", async () => {
    const repo = await setUpRepo();
    try {
      writeFileSync(join(repo.path, "REVIEW.md"), "edited, not committed\n");
      let r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("These files have changes that are not committed: REVIEW.md. Commit or undo them, then run loopstra upgrade again.");
      await run(["git", "checkout", "-q", "REVIEW.md"], repo.path);

      writeHeartbeat(repo.path, beat());
      r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toBe(LOOP_RUNNING);
      expect(LOOP_RUNNING).toBe("The loop is running. Stop it (Ctrl-C in its terminal), run loopstra upgrade, then start it again.");
      // Not responding, but its process is alive: it may still be running.
      writeHeartbeat(repo.path, beat({ lastBeatAt: new Date(Date.now() - 3_600_000).toISOString() }));
      expect((await upgradeRepo(repo.path, { check: false }, deps())).refusal).toBe(LOOP_RUNNING);
      writeHeartbeat(repo.path, beat({ stopped: true }));

      await run(["git", "checkout", "-q", "-b", "other"], repo.path);
      r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toBe("The checkout is on other, not main. Switch to main, then run loopstra upgrade again.");
      // Off main, --check refuses too.
      expect((await upgradeRepo(repo.path, { check: true }, deps())).refusal).toBe(r.refusal!);
    } finally { repo.cleanup(); }
  });

  test("--check goes on with the loop running and uncommitted files, and says a real upgrade would refuse", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      writeFileSync(join(repo.path, "REVIEW.md"), "edited, not committed\n");
      writeHeartbeat(repo.path, beat());
      const r = await upgradeRepo(repo.path, { check: true }, deps());
      expect(r.ok).toBe(true);
      expect(r.refusal).toBeUndefined();
      expect(r.warnings).toEqual([LOOP_RUNNING, "These files have changes that are not committed: REVIEW.md. Commit or undo them, then run loopstra upgrade again."]);
      expect(r.files.find((f) => f.path === SKILL)!.outcome).toBe("replaced");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      expect(await status(repo.path)).toBe("M REVIEW.md");
      expect((await upgradeRepo(repo.path, { check: false }, deps())).refusal).toBe(LOOP_RUNNING);
    } finally { repo.cleanup(); }
  });

  test("a renamed managed file is named by both its paths", async () => {
    const repo = await setUpRepo();
    try {
      // REVIEW.md moved to a new prompt override: git reports one rename, "R  <new>\0<old>\0".
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      await run(["git", "mv", "REVIEW.md", "loopstra/prompts/review.md"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toBe("These files have changes that are not committed: loopstra/prompts/review.md, REVIEW.md. Commit or undo them, then run loopstra upgrade again.");
    } finally { repo.cleanup(); }
  });

  test("a folder that is not set up is refused", async () => {
    const repo = await tempGitRepo();
    try {
      expect((await upgradeRepo(repo.path, { check: false }, deps())).refusal).toBe("This folder is not set up for Loopstra. Run loopstra init first.");
    } finally { repo.cleanup(); }
  });

  test("a config no migration changes is left as it is, even one the loop would not load", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const cfg = join(repo.path, "loopstra", "config.yaml");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace('test: "bun test"', 'test: ""'));
      await run(["git", "commit", "-qam", "no test command"], repo.path);
      const before = readFileSync(cfg, "utf8");
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(true);
      expect(r.changed).not.toContain("loopstra/config.yaml");
      expect(readFileSync(cfg, "utf8")).toBe(before);
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("a migration whose result would not load, or that throws, is refused, and nothing is written", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const at = await head(repo.path);
      const cfg = readFileSync(join(repo.path, "loopstra", "config.yaml"), "utf8");
      const cases: Array<{ migrations: Migration[]; says: string }> = [
        { migrations: [{ from: 1, run: (doc) => { doc.set("no_such_setting", 1); } }], says: "no_such_setting" },
        { migrations: [{ from: 1, run: () => { throw new Error("cannot rename it"); } }], says: "cannot rename it" },
      ];
      for (const c of cases) {
        const r = await upgradeRepo(repo.path, { check: false }, { ...deps(), migrations: c.migrations });
        expect(r.ok).toBe(false);
        expect(r.refusal).toStartWith("The config could not be brought up to date, so nothing was changed: ");
        expect(r.refusal).toContain(c.says);
        expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
        expect(readFileSync(join(repo.path, "loopstra", "config.yaml"), "utf8")).toBe(cfg);
        expect(await status(repo.path)).toBe("");
        expect(await head(repo.path)).toBe(at);
      }
    } finally { repo.cleanup(); }
  });

  test("offline: a hand-made override with known shipped versions, none readable, is refused and nothing is written", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "my own review prompt\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "an override made by hand"], repo.path);
      const at = await head(repo.path);
      const stamp = readFileSync(join(repo.path, "loopstra", "stamp.json"), "utf8");
      const index: ShippedIndex = { "templates/prompts/review.md": [{ sha: "abc", commit: "c" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index));
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("Loopstra's shipped versions of loopstra/prompts/review.md could not be read to merge from; check the connection and run loopstra upgrade again.");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      expect(readFileSync(join(repo.path, "loopstra", "stamp.json"), "utf8")).toBe(stamp);
      expect(await head(repo.path)).toBe(at);
    } finally { repo.cleanup(); }
  });

  test("a hand-made override with no known shipped version takes today's text as its base", async () => {
    const repo = await setUpRepo();
    try {
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "my own review prompt\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "an override made by hand"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(true);
      expect(r.files.find((f) => f.path === "loopstra/prompts/review.md")!.outcome).toBe("unchanged");
      expect(readStamp(repo.path)!.files["loopstra/prompts/review.md"]).toEqual({ base: textSha(readFileSync(templatePath("prompts", "review.md"), "utf8")) });
      expect(readFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "utf8")).toBe("my own review prompt\n");
    } finally { repo.cleanup(); }
  });

  test("a repository with no stamp is adopted: unedited prompt copies go, the old hook goes", async () => {
    const repo = await setUpRepo();
    try {
      const promptText = readFileSync(templatePath("prompts", "review.md"), "utf8");
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), promptText);
      mkdirSync(join(repo.path, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(repo.path, ".claude", "hooks", "loopstra-protect-tests.ts"), "// hook");
      writeFileSync(join(repo.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "bun loopstra-protect-tests.ts" }] }] } }));
      rmSync(join(repo.path, "loopstra", "stamp.json"));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "legacy"], repo.path);
      const index: ShippedIndex = { "templates/prompts/review.md": [{ sha: textSha(promptText), commit: "c" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index));
      expect(r.ok).toBe(true);
      expect(r.from).toBeNull();
      expect(r.committed).toBe(true);
      expect(existsSync(join(repo.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(r.removed).toEqual(["loopstra/prompts/review.md", ".claude/hooks/loopstra-protect-tests.ts", ".claude/settings.json"]);
      expect(readStamp(repo.path)!.loopstra).toBe("0.9.0");
      expect((await run(["git", "log", "-1", "--format=%B"], repo.path)).out.trim()).toBe("loopstra: upgrade to 0.9.0");
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("offline adoption is refused and writes nothing", async () => {
    const repo = await setUpRepo();
    try {
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "my own review prompt\n");
      rmSync(join(repo.path, "loopstra", "stamp.json"));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "legacy"], repo.path);
      const at = await head(repo.path);
      // The prompt has shipped versions, but none can be read.
      const index: ShippedIndex = { "templates/prompts/review.md": [{ sha: "abc", commit: "c" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index));
      expect(r.ok).toBe(false);
      expect(r.refusal).toContain("loopstra/prompts/review.md");
      expect(r.refusal).toContain("check the connection");
      expect(existsSync(join(repo.path, "loopstra", "stamp.json"))).toBe(false);
      expect(await status(repo.path)).toBe("");
      expect(await head(repo.path)).toBe(at);
    } finally { repo.cleanup(); }
  });

  test("with a stamp, the person's own settings are not watched: uncommitted, they do not stop the upgrade", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      mkdirSync(join(repo.path, ".claude"), { recursive: true });
      writeFileSync(join(repo.path, ".claude", "settings.json"), JSON.stringify({ model: "mine" }));
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(true);
      expect(await status(repo.path)).toBe("?? .claude/settings.json");
    } finally { repo.cleanup(); }
  });

  test("with no stamp, settings adoption would change must be committed first", async () => {
    const repo = await setUpRepo();
    try {
      const hooked = { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "bun loopstra-protect-tests.ts" }] }] } };
      writeFileSync(join(repo.path, ".claude", "settings.json"), JSON.stringify(hooked));
      rmSync(join(repo.path, "loopstra", "stamp.json"));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "legacy"], repo.path);
      writeFileSync(join(repo.path, ".claude", "settings.json"), JSON.stringify({ model: "x", ...hooked }));
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toBe("These files have changes that are not committed: .claude/settings.json. Commit or undo them, then run loopstra upgrade again.");
      expect(existsSync(join(repo.path, "loopstra", "stamp.json"))).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a repository from before the stamp, init run again, is still adopted by upgrade", async () => {
    const repo = await setUpRepo();
    try {
      const promptText = readFileSync(templatePath("prompts", "review.md"), "utf8");
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), promptText);
      mkdirSync(join(repo.path, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(repo.path, ".claude", "hooks", "loopstra-protect-tests.ts"), "// hook");
      rmSync(join(repo.path, "loopstra", "stamp.json"));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "legacy"], repo.path);
      await init(repo.path);
      expect(existsSync(join(repo.path, "loopstra", "stamp.json"))).toBe(false);
      const index: ShippedIndex = { "templates/prompts/review.md": [{ sha: textSha(promptText), commit: "c" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index));
      expect(r.ok).toBe(true);
      expect(r.removed).toEqual(["loopstra/prompts/review.md", ".claude/hooks/loopstra-protect-tests.ts"]);
      expect(existsSync(join(repo.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(readStamp(repo.path)!.loopstra).toBe("0.9.0");
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("a merge under way on main is refused; --check says so and goes on", async () => {
    const repo = await setUpRepo();
    try {
      await run(["git", "checkout", "-q", "-b", "side"], repo.path);
      writeFileSync(join(repo.path, "README.md"), "side\n");
      await run(["git", "commit", "-qam", "side"], repo.path);
      await run(["git", "checkout", "-q", "main"], repo.path);
      writeFileSync(join(repo.path, "README.md"), "main\n");
      await run(["git", "commit", "-qam", "main"], repo.path);
      await run(["git", "merge", "-q", "side"], repo.path);
      const merging = "A merge is in progress on main. Finish or abort it, then run loopstra upgrade again.";
      expect((await upgradeRepo(repo.path, { check: false }, deps())).refusal).toBe(merging);
      const check = await upgradeRepo(repo.path, { check: true }, deps());
      expect(check.ok).toBe(true);
      expect(check.warnings).toEqual([merging]);
    } finally { repo.cleanup(); }
  });

  test("a commit git refuses after the writes is reported in plain words", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      // prepare-commit-msg runs even with --no-verify.
      const hook = join(repo.path, ".git", "hooks", "prepare-commit-msg");
      writeFileSync(hook, "#!/bin/sh\necho 'no commits today' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      const at = await head(repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(false);
      expect(r.committed).toBe(false);
      expect(r.refusal).toBe("The files were brought up to date but could not be committed (git said: no commits today). Commit them by hand.");
      expect(r.written).toBe(true);
      expect(r.files.find((f) => f.path === SKILL)!.outcome).toBe("replaced");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(readFileSync(templatePath("skill", "SKILL.md"), "utf8"));
      expect(await head(repo.path)).toBe(at);
    } finally { repo.cleanup(); }
  });

  test("a repository on a newer release than the installed one is refused, in both modes, and nothing is written", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      writeStamp(repo.path, { ...readStamp(repo.path)!, loopstra: "0.10.0" });
      await run(["git", "commit", "-qam", "a teammate upgraded"], repo.path);
      const at = await head(repo.path);
      const says = "This repository is on Loopstra 0.10.0, newer than the installed 0.9.0. Install it with bun add -g loopstra@0.10.0, then run loopstra upgrade again.";
      for (const check of [false, true]) {
        const r = await upgradeRepo(repo.path, { check }, deps());
        expect({ check, ok: r.ok, refusal: r.refusal, written: r.written }).toEqual({ check, ok: false, refusal: says, written: false });
      }
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      expect(await head(repo.path)).toBe(at);
      // A development checkout's stamp, or a development checkout running, is not compared.
      writeStamp(repo.path, { ...readStamp(repo.path)!, loopstra: "0.0.0-dev+abc1234" });
      await run(["git", "commit", "-qam", "stamped by a checkout"], repo.path);
      expect((await upgradeRepo(repo.path, { check: true }, deps())).ok).toBe(true);
      writeStamp(repo.path, { ...readStamp(repo.path)!, loopstra: "0.10.0" });
      await run(["git", "commit", "-qam", "a teammate upgraded"], repo.path);
      expect((await upgradeRepo(repo.path, { check: true }, deps({}, {}, "0.0.0-dev+def5678"))).ok).toBe(true);
    } finally { repo.cleanup(); }
  });

  test("the result names the main branch, and whether files were written", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const check = await upgradeRepo(repo.path, { check: true }, deps());
      expect({ main: check.main, written: check.written }).toEqual({ main: "main", written: false });
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect({ main: r.main, written: r.written, committed: r.committed }).toEqual({ main: "main", written: true, committed: true });
    } finally { repo.cleanup(); }
  });

  test("an index that cannot be read is refused in plain words; release notes that cannot be read are left out", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, { ...deps(), index: async () => { throw new Error("shipped.json is not valid JSON"); } });
      expect(r.refusal).toBe("Loopstra's list of shipped files could not be read: shipped.json is not valid JSON");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      const ok = await upgradeRepo(repo.path, { check: false }, { ...deps(), notes: async () => { throw new Error("offline"); } });
      expect(ok.committed).toBe(true);
      expect((await run(["git", "log", "-1", "--format=%B"], repo.path)).out.trim()).toBe("loopstra: upgrade to 0.9.0 (from 0.8.0)");
    } finally { repo.cleanup(); }
  });

  test("a repository that ignores .claude/ (the skill never tracked) is upgraded and committed", async () => {
    const repo = await setUpRepo();
    try {
      writeFileSync(join(repo.path, ".gitignore"), ".loopstra/\n.claude/\n");
      await run(["git", "rm", "-q", "-r", "--cached", ".claude"], repo.path);
      await run(["git", "commit", "-qam", "keep .claude/ out of git"], repo.path);
      writeFileSync(join(repo.path, SKILL), OLD_SKILL);
      writeStamp(repo.path, { loopstra: "0.8.0", files: { ...readStamp(repo.path)!.files, [SKILL]: { base: textSha(OLD_SKILL) } } });
      await run(["git", "commit", "-qam", "older"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(true);
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(readFileSync(templatePath("skill", "SKILL.md"), "utf8"));
      expect((await run(["git", "show", "--name-only", "--format=", "HEAD"], repo.path)).out.trim()).toBe("loopstra/stamp.json");
      expect(await status(repo.path)).toBe("");
    } finally { repo.cleanup(); }
  });

  test("a stamp that cannot be read is refused, also with --check, and nothing is adopted", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const stampFile = join(repo.path, "loopstra", "stamp.json");
      writeFileSync(stampFile, `<<<<<<< ours\n${readFileSync(stampFile, "utf8")}=======\n{}\n>>>>>>> theirs\n`);
      await run(["git", "commit", "-qam", "a bad merge"], repo.path);
      const at = await head(repo.path);
      const refusal = "loopstra/stamp.json cannot be read (for example, it has merge conflict markers). Fix it, commit it, then run loopstra upgrade again.";
      for (const check of [false, true]) expect((await upgradeRepo(repo.path, { check }, deps())).refusal).toBe(refusal);
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      expect(await status(repo.path)).toBe("");
      expect(await head(repo.path)).toBe(at);
    } finally { repo.cleanup(); }
  });

  test("a deleted prompt override leaves the stamp, and customize can make it again", async () => {
    const repo = await setUpRepo();
    try {
      const { customize } = await import("../../src/commands/customize");
      expect((await customize(repo.path, "review")).ok).toBe(true);
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "our review prompt"], repo.path);
      await run(["git", "rm", "-q", "loopstra/prompts/review.md"], repo.path);
      await run(["git", "commit", "-qm", "back to the shipped review prompt"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.files.find((f) => f.path === "loopstra/prompts/review.md")!.outcome).toBe("dropped");
      expect(readStamp(repo.path)!.files["loopstra/prompts/review.md"]).toBeUndefined();
      expect(r.committed).toBe(true);
      expect(await status(repo.path)).toBe("");
      // The next upgrade no longer knows of it.
      expect((await upgradeRepo(repo.path, { check: true }, deps())).files.map((f) => f.path)).not.toContain("loopstra/prompts/review.md");
      expect((await customize(repo.path, "review")).ok).toBe(true);
      expect(existsSync(join(repo.path, "loopstra", "prompts", "review.md"))).toBe(true);
    } finally { repo.cleanup(); }
  });

  test("a staging that fails after the writes is reported, not taken for a commit", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      writeFileSync(join(repo.path, ".git", "index.lock"), "");
      const at = await head(repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(false);
      expect(r.written).toBe(true);
      expect(r.committed).toBe(false);
      expect(r.refusal).toStartWith("The files were brought up to date but could not be committed (git said: ");
      expect(r.refusal).toContain("lock file");
      expect(await head(repo.path)).toBe(at);
    } finally { repo.cleanup(); }
  });
});

describe("statusPaths", () => {
  test("reads NUL-separated entries: a path with spaces as it is, both paths of a rename", () => {
    expect(statusPaths(" M REVIEW.md\0?? loopstra/prompts/my review.md\0R  intent/README.md\0REVIEW.md\0")).toEqual([
      "REVIEW.md", "loopstra/prompts/my review.md", "intent/README.md",
    ]);
    expect(statusPaths("")).toEqual([]);
  });
});
