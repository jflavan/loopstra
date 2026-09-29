import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { OFF_MAIN_NOTE } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE as FAKE, TEMPLATES, tempGitRepo, withEnv } from "../helpers";

const INTENT = "---\nstatus: accepted\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n";

/**
 * A target repo with Loopstra config and prompts, one accepted intent (add-numbers), one draft
 * (later), and a passing test of its own so main is green from the first health check.
 */
async function targetRepo(config = "") {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: bun test\n${config}`);
  await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await Bun.write(join(repo.path, "tests", "smoke.test.ts"), 'import { expect, test } from "bun:test";\ntest("smoke", () => { expect(1 + 1).toBe(2); });\n');
  mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), INTENT);
  mkdirSync(join(repo.path, "intent", "later"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "later", "intent.md"), "---\nstatus: draft\n---\n# Intent: later\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("setup");
  return repo;
}

async function onMain(repo: string, path: string): Promise<boolean> {
  return (await new Git(repo).run(["cat-file", "-e", `main:${path}`], true)).code === 0;
}

function intentFolders(repo: string): string[] {
  const base = join(repo, "intent");
  return readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory()).sort();
}

async function statusOf(repo: string, slug = "add-numbers"): Promise<string> {
  return (await readIntent(repo, slug)).file.frontmatter.status;
}

/** A person edits the status line in intent.md and commits it. */
async function personSets(repo: string, status: "merge-approved" | "done"): Promise<void> {
  const i = await readIntent(repo, "add-numbers");
  await writeIntent(i, { status, note: "" });
  await new Git(repo).commitPaths(["intent/add-numbers"], `person: ${status}`);
}

describe("the loop", () => {
  test("drives one intent from accepted to done across ticks, one step per tick, with no remote", async () => {
    const repo = await targetRepo();
    await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE }, async () => {
      const seen: string[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await tick(repo.path);
        const status = await statusOf(repo.path);
        seen.push(`${r.picked ?? "-"}:${status}`);
        // Nothing reaches main before the merge.
        if (status !== "merged" && status !== "done") expect(await onMain(repo.path, "src/add.ts")).toBe(false);
        if (status === "done") break;
      }
      expect(seen).toEqual([
        "add-numbers:spec-approved",
        "add-numbers:plan-approved",
        "add-numbers:reviewing",
        "add-numbers:merged",
        "add-numbers:done",
      ]);
      expect(await onMain(repo.path, "src/add.ts")).toBe(true);
      expect(existsSync(join(repo.path, "intent", "add-numbers", "outcome.md"))).toBe(true);
      expect(await Bun.file(join(repo.path, "intent", "queue.md")).text()).toContain("add-numbers");
      // No surprise intents (main stayed green), the draft untouched, and nothing left behind.
      expect(intentFolders(repo.path)).toEqual(["add-numbers", "later"]);
      expect(await statusOf(repo.path, "later")).toBe("draft");
      expect(await new Git(repo.path).branchExists("intent/add-numbers")).toBe(false);
      expect(existsSync(join(repo.path, ".loopstra", "worktrees", "add-numbers"))).toBe(false);
      expect(existsSync(join(repo.path, ".loopstra", "health-pending"))).toBe(false);
      // Only the generated queue may be unsaved: it rides along in the next runtime commit.
      expect((await new Git(repo.path).run(["status", "--porcelain"])).out.trim()).toMatch(/^(M intent\/queue\.md)?$/);
      const trace = Trace.open(repo.path);
      try {
        expect(trace.signals().map((s) => s.result)).toEqual(["pass", "pass"]);
      } finally {
        trace.close();
      }
      const idle = await tick(repo.path);
      expect(idle.picked).toBeNull();
    });
    repo.cleanup();
  }, 120_000);

  test("with people on the merge and done gates: the loop waits, and each person's status change moves it on", async () => {
    const repo = await targetRepo("gates:\n  merge:\n    human: status\n  done:\n    human: status\n");
    await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE }, async () => {
      for (const expected of ["spec-approved", "plan-approved", "reviewing", "merge-review"]) {
        await tick(repo.path);
        expect(await statusOf(repo.path)).toBe(expected);
      }
      // Waiting for a person: the loop has nothing to do, and main does not have the change.
      expect((await tick(repo.path)).picked).toBeNull();
      expect(await onMain(repo.path, "src/add.ts")).toBe(false);

      await personSets(repo.path, "merge-approved");
      await tick(repo.path);
      expect(await statusOf(repo.path)).toBe("merged");
      expect(await onMain(repo.path, "src/add.ts")).toBe(true);

      await tick(repo.path);
      const waiting = await readIntent(repo.path, "add-numbers");
      expect(waiting.file.frontmatter.status).toBe("verifying");
      expect(waiting.artifacts.has("outcome.md")).toBe(true);
      expect(await Bun.file(join(repo.path, "intent", "add-numbers", "lessons.md")).text()).toContain("## Lessons");
      expect((await tick(repo.path)).picked).toBeNull();

      await personSets(repo.path, "done");
      expect((await tick(repo.path)).picked).toBeNull();
      expect(await statusOf(repo.path)).toBe("done");
      expect(intentFolders(repo.path)).toEqual(["add-numbers", "later"]);
    });
    repo.cleanup();
  }, 120_000);

  test("with the main checkout on another branch, a tick pauses in plain words and commits nothing", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
    mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), INTENT);
    const git = new Git(repo.path);
    await git.commitAll("setup");
    await git.run(["checkout", "-q", "-b", "someone-elses-work"]);
    const head = await git.headSha();
    await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE }, async () => {
      const r = await tick(repo.path);
      expect(r.picked).toBeNull();
      expect(r.paused).toBe(OFF_MAIN_NOTE);
    });
    expect(await git.headSha()).toBe(head);
    expect(await git.isDirty()).toBe(false);
    expect(await statusOf(repo.path)).toBe("accepted");
    repo.cleanup();
  });

  test("a bad config does not crash a tick", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\nbogus: true\n");
    const r = await tick(repo.path);
    expect(r.picked).toBeNull();
    expect(r.error).toMatch(/bogus/);
    repo.cleanup();
  });
});
