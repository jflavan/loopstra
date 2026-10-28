import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateConfig, type Config } from "../../src/config";
import { Git, NO_AUTO_MAINTENANCE } from "../../src/git";
import { riskEvidence, riskNote, riskySet, scoreRisk, type Risk } from "../../src/risk";
import { run, tempGitRepo } from "../helpers";

function config(risky: Record<string, unknown> = {}): Config {
  return validateConfig({ version: 1, commands: { test: "x" }, gates: { merge: { risky } } });
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/** A repository on a branch off main, with `onMain` committed on main first and `onBranch` committed on the branch. */
async function branchWith(onBranch: Record<string, string | Uint8Array>, onMain: Record<string, string | Uint8Array> = {}): Promise<Git> {
  const repo = await tempGitRepo();
  cleanups.push(repo.cleanup);
  const commit = async (files: Record<string, string | Uint8Array>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.path, path)), { recursive: true });
      writeFileSync(join(repo.path, path), content);
    }
    await run(["git", "add", "-A"], repo.path);
    await run(["git", ...NO_AUTO_MAINTENANCE, "commit", "-q", "-m", message], repo.path);
  };
  if (Object.keys(onMain).length) await commit(onMain, "main");
  await run(["git", "checkout", "-q", "-b", "intent/x"], repo.path);
  await commit(onBranch, "branch");
  return new Git(repo.path);
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

describe("riskySet", () => {
  test("only paths or a size make anything risky", () => {
    expect(riskySet(config())).toBe(false);
    expect(riskySet(config({ human: "status" }))).toBe(false);
    expect(riskySet(config({ paths: ["x"] }))).toBe(true);
    expect(riskySet(config({ lines: 10 }))).toBe(true);
  });
});

describe("scoreRisk", () => {
  test("with nothing set, no change is risky", async () => {
    const wt = await branchWith({ ".github/workflows/ci.yml": "on: push\n" });
    expect(await scoreRisk(wt, "main", config())).toEqual({ risky: false, files: [], lines: 1, overLines: false });
  });

  test("a pattern matches repository paths: .github/** anything under it, a bare name only at the top, **/ at any depth", async () => {
    const wt = await branchWith({
      ".github/workflows/ci.yml": "on: push\n",
      "package.json": "{}\n",
      "web/package.json": "{}\n",
      "db/migrations/1.sql": "create table t;\n",
      "src/a.ts": "x\n",
    });
    const r = await scoreRisk(wt, "main", config({ paths: [".github/**", "package.json", "**/migrations/**"] }));
    expect(r.risky).toBe(true);
    expect(r.files).toEqual([".github/workflows/ci.yml", "db/migrations/1.sql", "package.json"]);
    expect(r.overLines).toBe(false);
  });

  test("records under intent/ never count, neither as files nor as lines", async () => {
    const wt = await branchWith({ "intent/x/intent.md": lines(50), "src/a.ts": "x\n" });
    const r = await scoreRisk(wt, "main", config({ paths: ["**"], lines: 5 }));
    expect(r).toEqual({ risky: true, files: ["src/a.ts"], lines: 1, overLines: false, limit: 5 });
    const only = await branchWith({ "intent/x/intent.md": lines(50) });
    expect(await scoreRisk(only, "main", config({ paths: ["**"], lines: 5 }))).toEqual({ risky: false, files: [], lines: 0, overLines: false, limit: 5 });
  });

  test("lines added and deleted add up; over the size set is risky, at it is not", async () => {
    const wt = await branchWith({ "src/a.ts": lines(4), "src/b.ts": "" }, { "src/b.ts": lines(2) });
    expect(await scoreRisk(wt, "main", config({ lines: 6 }))).toEqual({ risky: false, files: [], lines: 6, overLines: false, limit: 6 });
    expect(await scoreRisk(wt, "main", config({ lines: 5 }))).toEqual({ risky: true, files: [], lines: 6, overLines: true, limit: 5 });
  });

  test("a binary file adds no lines, but its path still counts", async () => {
    const wt = await branchWith({ "assets/logo.bin": new Uint8Array([0, 1, 2, 0, 255]) });
    expect(await scoreRisk(wt, "main", config({ paths: ["assets/**"], lines: 1 }))).toEqual({ risky: true, files: ["assets/logo.bin"], lines: 0, overLines: false, limit: 1 });
  });

  test("a file renamed into a risky path counts under its new name; one renamed out counts under its old one", async () => {
    const into = await branchWith({}, { "ci/build.yml": lines(30) });
    mkdirSync(join(into.cwd, ".github", "workflows"), { recursive: true });
    await into.run(["mv", "ci/build.yml", ".github/workflows/build.yml"]);
    await into.run([...NO_AUTO_MAINTENANCE, "commit", "-q", "-m", "move"]);
    expect(await scoreRisk(into, "main", config({ paths: [".github/**"] }))).toEqual({ risky: true, files: [".github/workflows/build.yml"], lines: 0, overLines: false });

    const out = await branchWith({}, { ".github/workflows/build.yml": lines(30) });
    mkdirSync(join(out.cwd, "ci"), { recursive: true });
    await out.run(["mv", ".github/workflows/build.yml", "ci/build.yml"]);
    await out.run([...NO_AUTO_MAINTENANCE, "commit", "-q", "-m", "move"]);
    expect((await scoreRisk(out, "main", config({ paths: [".github/**"] }))).files).toEqual([".github/workflows/build.yml"]);
  });

  test("paths with spaces and letters outside ASCII match as they are", async () => {
    const wt = await branchWith({ "docs/read me.md": "x\n", "docs/café.md": "y\n" });
    const r = await scoreRisk(wt, "main", config({ paths: ["docs/read me.md", "docs/caf*"] }));
    expect(r.files).toEqual(["docs/café.md", "docs/read me.md"]);
  });

  test("only the branch's own changes count, not what main gained since it parted", async () => {
    const wt = await branchWith({ "src/a.ts": "x\n" });
    await wt.run(["checkout", "-q", "main"]);
    mkdirSync(join(wt.cwd, ".github"), { recursive: true });
    writeFileSync(join(wt.cwd, ".github", "ci.yml"), "on: push\n");
    await wt.run(["add", "-A"]);
    await wt.run([...NO_AUTO_MAINTENANCE, "commit", "-q", "-m", "main moves"]);
    await wt.run(["checkout", "-q", "intent/x"]);
    expect((await scoreRisk(wt, "main", config({ paths: [".github/**"] }))).risky).toBe(false);
  });
});

describe("the words", () => {
  const risk = (files: string[], over?: { lines: number; limit: number }): Risk => ({
    risky: files.length > 0 || !!over, files, lines: over?.lines ?? 3, overLines: !!over, ...(over ? { limit: over.limit } : {}),
  });
  const many = Array.from({ length: 12 }, (_, i) => `f${i}.yml`);

  test("the gate row names up to 10 files, then how many more, and the size when it tripped", () => {
    expect(riskEvidence(risk([]))).toBe("nothing risky");
    expect(riskEvidence(risk(["a", "b"]))).toBe("touches a and b");
    expect(riskEvidence(risk(many))).toBe(`touches ${many.slice(0, 10).join(", ")} and 2 more`);
    expect(riskEvidence(risk([], { lines: 1612, limit: 1500 }))).toBe("1612 lines changed (over 1500)");
    expect(riskEvidence(risk(["a"], { lines: 1612, limit: 1500 }))).toBe("touches a; 1612 lines changed (over 1500)");
  });

  test("the owner's note names up to 3 files and says who decides and how", () => {
    expect(riskNote(risk([".github/workflows/ci.yml", "package.json"]), "pr")).toBe(
      "This change touches files set to need a person before merging: .github/workflows/ci.yml and package.json. Approve the pull request on GitHub, or set status to merge-approved. To stop this change, set it to closed.",
    );
    expect(riskNote(risk(["a", "b", "c", "d", "e"]), "status")).toBe(
      "This change touches files set to need a person before merging: a, b, c and 2 more. Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.",
    );
    expect(riskNote(risk([], { lines: 1612, limit: 1500 }), "status")).toBe(
      "This change has 1612 changed lines, more than the 1500 set to need a person before merging. Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.",
    );
    expect(riskNote(risk(["a"], { lines: 1612, limit: 1500 }), "pr")).toBe(
      "This change touches files set to need a person before merging: a. It also has 1612 changed lines, more than the 1500 set. Approve the pull request on GitHub, or set status to merge-approved. To stop this change, set it to closed.",
    );
  });
});
