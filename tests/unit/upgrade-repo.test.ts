import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../src/init";
import { writeHeartbeat, type Heartbeat } from "../../src/heartbeat";
import { readStamp, textSha, writeStamp } from "../../src/stamp";
import { templatePath } from "../../src/package";
import { LOOP_RUNNING, upgradeRepo, type RepoDeps } from "../../src/upgrade/repo";
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
      // The stamp (with the new version and REVIEW.md's old base) is committed; REVIEW.md is not.
      expect(r.committed).toBe(true);
      expect(readStamp(repo.path)!.files["REVIEW.md"]).toEqual({ base: textSha(base) });
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
    } finally { repo.cleanup(); }
  });

  test("a folder that is not set up is refused", async () => {
    const repo = await tempGitRepo();
    try {
      expect((await upgradeRepo(repo.path, { check: false }, deps())).refusal).toBe("This folder is not set up for Loopstra. Run loopstra init first.");
    } finally { repo.cleanup(); }
  });

  test("a config that would not load is refused, and nothing is written", async () => {
    const repo = await setUpRepo();
    try {
      await olderSkill(repo.path);
      const cfg = join(repo.path, "loopstra", "config.yaml");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace('test: "bun test"', 'test: ""'));
      await run(["git", "commit", "-qam", "no test command"], repo.path);
      const at = await head(repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(false);
      expect(r.refusal).toStartWith("The config could not be brought up to date, so nothing was changed: ");
      expect(r.refusal).toContain("commands.test");
      expect(readFileSync(join(repo.path, SKILL), "utf8")).toBe(OLD_SKILL);
      expect(await status(repo.path)).toBe("");
      expect(await head(repo.path)).toBe(at);
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
});
