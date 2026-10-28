import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CLAUDE_ENV } from "../../src/claude";
import { readMarker, writeMarker, type StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runBuildStep } from "../../src/stages/build";
import { catchUp, CONFLICT_NOTE, outOfDate, RESOLUTION, RESOLUTIONS, roundsAllowed } from "../../src/stages/catch-up";
import { EARLY_REVIEW } from "../../src/stages/early-review";
import { CAUGHT_UP_NOTE, conflictsWhileWaiting, runMergeStep } from "../../src/stages/merge";
import { CATCHING_UP, openBranchWorktree } from "../../src/stages/shared";
import type { Trace } from "../../src/trace";
import { copyRepo, FAKE_CLAUDE, fixtureDir, openRepo, setEnv, setupRepo, withEnv, writeIntentOnDisk } from "../helpers";

const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";
/** A person on the merge gate, and one review round: a resolution's review must not need a second one. */
const PERSON_ONE_ROUND = "gates:\n  merge:\n    human: status\nstages:\n  review:\n    max_rounds: 1\n";

/** What the build writes to src/add.ts (tests/fake-claude/fixtures/build.jsonl). */
const BUILT = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
/** What main gets meanwhile: another change that also added src/add.ts. */
const MAINS = "// added on main by another change\nexport const ZERO = 0;\n";
/** Both kept. */
const RESOLVED = `${MAINS}${BUILT}`;

/** A resolve session's fixture: it writes `content` to src/add.ts (unless null) and answers `resolved`. */
function resolveFixture(content: string | null, resolved: boolean, reason = ""): string {
  const lines: unknown[] = [{ type: "system", subtype: "init", session_id: "fake-resolve", cwd: "/", tools: [], model: "fake" }];
  if (content !== null) lines.push({ type: "fake_action", write: { path: "src/add.ts", content } });
  lines.push({
    type: "result", subtype: "success", is_error: false, session_id: "fake-resolve", total_cost_usd: 0.1, usage: {}, result: "ok",
    structured_output: { status: "success", summary: "resolved", resolved, reason, summary_markdown: "Kept main's ZERO and this change's add." },
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const templates = new Map<string, { path: string; cleanup: () => void }>();
let restoreEnv = () => {};

beforeAll(async () => {
  restoreEnv = setEnv({ [FAKE_CLAUDE_ENV]: FAKE_CLAUDE });
  // Built (status reviewing), and the same after its first review (merge-review, a person on the gate).
  const s = await build(PERSON_ONE_ROUND);
  s.trace.close();
  templates.set("built", s.repo);
  const r = await copy("built");
  await runMergeStep(r.ctx);
  r.trace.close();
  templates.set("reviewed", r.repo);
}, 120_000);

afterAll(() => {
  for (const t of templates.values()) t.cleanup();
  restoreEnv();
});

async function build(config: string) {
  const s = await setupRepo("plan-approved", { commands: { test: "bun test" }, config });
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), PLAN);
  await Bun.write(join(s.repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  await runBuildStep(s.ctx);
  await s.ctx.reload();
  return s;
}

async function copy(state: "built" | "reviewed") {
  const repo = await copyRepo(templates.get(state)!.path);
  return { repo, ...(await openRepo(repo.path)) };
}

/** Another change lands on main: `src/add.ts` with other content (a conflict), or another file (none). */
async function mainMoves(repo: string, conflicting = true): Promise<void> {
  await Bun.write(join(repo, "src", conflicting ? "add.ts" : "other.ts"), MAINS);
  await new Git(repo).commitAll("other-change: something else on main");
}

/** Runs the change's steps with these resolve fixtures; the prompts each session got are returned. */
async function withResolve<T>(fixtures: Record<string, string>, fn: () => Promise<T>): Promise<{ result: T; prompts: Array<{ phase: string; prompt: string }> }> {
  const dir = fixtureDir(fixtures);
  const promptsFile = join(dir.path, "prompts.jsonl");
  try {
    const result = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path, LOOPSTRA_FAKE_PROMPTS: promptsFile }, fn);
    const prompts = existsSync(promptsFile) ? readFileSync(promptsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { phase: string; prompt: string }) : [];
    return { result, prompts };
  } finally {
    dir.cleanup();
  }
}

async function status(repo: string): Promise<{ status: string; note: string }> {
  const fm = (await readIntent(repo, "add-numbers")).file.frontmatter;
  return { status: fm.status, note: fm.note };
}

async function branchFile(repo: string, path: string): Promise<string> {
  return (await new Git(repo).run(["show", `intent/add-numbers:${path}`])).out;
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

async function personSets(ctx: StepContext, to: "merge-approved"): Promise<void> {
  await ctx.reload();
  await writeIntentOnDisk(ctx.intent, { status: to, note: "" });
  await ctx.git.commitPaths([`intent/${ctx.slug}`], `person: ${to}`);
  await ctx.reload();
}

describe("the merge checks resolve a conflict with main", () => {
  test("resolved, tested, then reviewed once more with the resolution in the prompt, without using up the review rounds", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      await mainMoves(repo.path);
      await personSets(ctx, "merge-approved");
      const { prompts } = await withResolve({ resolve: resolveFixture(RESOLVED, true) }, async () => {
        await runMergeStep(ctx); // the merge checks resolve it and send it back to review
        expect((await status(repo.path)).status).toBe("reviewing");
        await ctx.reload();
        await runMergeStep(ctx); // the review round that sees the resolution, then the gate again
      });
      // Back with the person: what they approve now is what will merge.
      expect(await status(repo.path)).toMatchObject({ status: "merge-review" });
      expect(await branchFile(repo.path, "src/add.ts")).toBe(RESOLVED);
      // Main moved on since only by records (the status changes); its code is all on the branch.
      expect(await outOfDate(new Git(repo.path), "main", "intent/add-numbers")).toBe(false);
      const names = phaseNames(trace);
      expect(names).toContain("resolve");
      expect(names.indexOf("merge-test-1")).toBeGreaterThan(names.indexOf("resolve"));
      // max_rounds is 1, and round 2 ran: the resolution's review is on top of them.
      expect(names).toContain("review-2");
      const resolve = prompts.find((p) => p.phase === "resolve")!;
      expect(resolve.prompt).toContain("### src/add.ts");
      expect(resolve.prompt).toMatch(/<<<<<<< /);
      expect(resolve.prompt).toContain("other-change: something else on main");
      const review = prompts.filter((p) => p.phase === "review").at(-1)!;
      expect(review.prompt).toContain("conflicts in src/add.ts were resolved by an agent");
      expect(review.prompt).toContain("Kept main's ZERO and this change's add.");
      // Seen by a review that passed: not shown again.
      expect(readMarker(ctx, RESOLUTION)).toBeNull();
      expect(trace.gates("add-numbers").some((g) => g.check === "up-to-date" && g.evidence.includes("resolved conflicts with main in src/add.ts"))).toBe(true);
      // The branch's commits were squashed into one on top of main.
      const log = (await new Git(repo.path).run(["log", "--format=%s", "main..intent/add-numbers"])).out.trim().split("\n");
      expect(log).toEqual(["loopstra(add-numbers): brought up to date with main"]);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a session that cannot resolve it blocks with conflict.md, and leaves the branch and main as they were", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      const before = (await new Git(repo.path).run(["rev-parse", "intent/add-numbers"])).out.trim();
      await mainMoves(repo.path);
      await personSets(ctx, "merge-approved");
      await withResolve({ resolve: resolveFixture(null, false, "the two changes want different things from add.ts") }, () => runMergeStep(ctx));
      const s = await status(repo.path);
      expect(s.status).toBe("blocked");
      expect(s.note).toContain("conflict.md");
      expect(s.note).not.toMatch(/<<<<|CONFLICT \(|\bgit\b|rebase/);
      expect((await new Git(repo.path).run(["rev-parse", "intent/add-numbers"])).out.trim()).toBe(before);
      expect(await new Git(ctx.worktreeDir).isDirty()).toBe(false);
      expect(await new Git(repo.path).isDirty()).toBe(false);
      const record = (await new Git(repo.path).run(["show", "main:intent/add-numbers/conflict.md"])).out;
      expect(record).toContain("the two changes want different things from add.ts");
      expect(record).toContain("### src/add.ts");
      expect(readMarker(ctx, CATCHING_UP)).toBeNull();
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("conflict markers left behind count as not resolved", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      await mainMoves(repo.path);
      await personSets(ctx, "merge-approved");
      await withResolve({ resolve: resolveFixture(`<<<<<<< main\n${MAINS}=======\n${BUILT}>>>>>>> change\n`, true) }, () => runMergeStep(ctx));
      expect((await status(repo.path)).status).toBe("blocked");
      expect((await new Git(repo.path).run(["show", "main:intent/add-numbers/conflict.md"])).out).toContain("conflict markers were left in src/add.ts");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a resolution that keeps main's side of the conflict is saved, and output files the session's commands left are not", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      await mainMoves(repo.path);
      const fixture = resolveFixture(MAINS, true).replace(
        '{"type":"result"',
        `${JSON.stringify({ type: "fake_action", write: { path: "coverage/lcov.info", content: "TN:\n" } })}\n{"type":"result"`,
      );
      // Main's version of the conflicted file is kept; the change's other files stay.
      const { result } = await withResolve({ resolve: fixture }, () => catchUp(ctx));
      expect(result).toMatchObject({ ok: true, outcome: "resolved" });
      const git = new Git(repo.path);
      expect(await branchFile(repo.path, "src/add.ts")).toBe(MAINS);
      expect((await git.run(["cat-file", "-e", "intent/add-numbers:coverage/lcov.info"], true)).code).not.toBe(0);
      expect(await new Git(ctx.worktreeDir).isDirty()).toBe(false);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a binary file both sides changed is left to a person", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      const wt = new Git(ctx.worktreeDir);
      writeFileSync(join(ctx.worktreeDir, "logo.bin"), Buffer.from([0, 1, 2, 3]));
      await wt.commitAll("a logo");
      writeFileSync(join(repo.path, "logo.bin"), Buffer.from([0, 9, 9, 9]));
      await new Git(repo.path).commitAll("other-change: another logo");
      const { result } = await withResolve({ resolve: resolveFixture(null, true) }, () => catchUp(ctx));
      expect(result).toMatchObject({ ok: false, note: CONFLICT_NOTE });
      expect(phaseNames(trace)).not.toContain("resolve");
      expect((await new Git(repo.path).run(["show", "main:intent/add-numbers/conflict.md"])).out).toContain("logo.bin, which is a binary file a person needs to choose between");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("with resolution turned off (max_resolutions: 0), a conflict blocks with conflict.md naming the files", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      await mainMoves(repo.path);
      const off = { ...ctx.cfg, stages: { ...ctx.cfg.stages, review: { ...ctx.cfg.stages.review, max_resolutions: 0 } } };
      const r = await catchUp(Object.assign(Object.create(Object.getPrototypeOf(ctx) as object) as StepContext, ctx, { cfg: off }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.note).toContain("turned off");
      expect((await new Git(repo.path).run(["show", "main:intent/add-numbers/conflict.md"])).out).toContain("src/add.ts");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("with the resolutions used up, the change blocks without a resolve session", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      writeMarker(ctx, RESOLUTIONS, "3");
      await mainMoves(repo.path);
      await personSets(ctx, "merge-approved");
      await runMergeStep(ctx);
      const s = await status(repo.path);
      expect(s.status).toBe("blocked");
      expect(s.note).toContain("as many times as allowed");
      expect(phaseNames(trace)).not.toContain("resolve");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);
});

describe("a change waiting for a person is kept mergeable", () => {
  test("main gains a conflicting change: resolved, tested, and back to reviewing with a plain note", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      await mainMoves(repo.path);
      expect(await conflictsWhileWaiting(ctx.git, "main", ctx.branch)).toBe(true);
      await withResolve({ resolve: resolveFixture(RESOLVED, true) }, () => runMergeStep(ctx));
      expect(await status(repo.path)).toEqual({ status: "reviewing", note: CAUGHT_UP_NOTE });
      expect(phaseNames(trace)).toEqual(expect.arrayContaining(["catch-up", "resolve", "save-resolution", "resolve-test-1"]));
      expect(await branchFile(repo.path, "src/add.ts")).toBe(RESOLVED);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("main gains a change elsewhere: the waiting change is left alone", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      const before = (await new Git(repo.path).run(["rev-parse", "intent/add-numbers"])).out.trim();
      await mainMoves(repo.path, false);
      expect(await conflictsWhileWaiting(ctx.git, "main", ctx.branch)).toBe(false);
      await runMergeStep(ctx);
      expect((await status(repo.path)).status).toBe("merge-review");
      expect((await new Git(repo.path).run(["rev-parse", "intent/add-numbers"])).out.trim()).toBe(before);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);
});

describe("review start", () => {
  test("main gained conflicting code since the build: resolved and tested before round 1, which sees the resolution", async () => {
    const { repo, ctx, trace } = await copy("built");
    try {
      rmSync(join(ctx.runDir, EARLY_REVIEW), { force: true });
      await mainMoves(repo.path);
      const { prompts } = await withResolve({ resolve: resolveFixture(RESOLVED, true) }, () => runMergeStep(ctx));
      expect((await status(repo.path)).status).toBe("merge-review");
      const names = phaseNames(trace);
      expect(names.indexOf("resolve-test-1")).toBeGreaterThan(names.indexOf("resolve"));
      expect(names.indexOf("review-1")).toBeGreaterThan(names.indexOf("resolve-test-1"));
      expect(prompts.find((p) => p.phase === "review")!.prompt).toContain("conflicts in src/add.ts were resolved by an agent");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("main gained only records: the branch is not rebased there, and the review kept from the build is used", async () => {
    const { repo, ctx, trace } = await copy("built");
    try {
      await Bun.write(join(repo.path, "intent", "add-numbers", "notes.md"), "a record\n");
      await new Git(repo.path).commitAll("a record on main");
      expect(existsSync(join(ctx.runDir, EARLY_REVIEW))).toBe(true);
      await runMergeStep(ctx);
      expect(phaseNames(trace)).not.toContain("catch-up");
      expect(phaseNames(trace)).not.toContain("review-1");
      expect((await status(repo.path)).status).toBe("merge-review");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);
});

describe("catchUp", () => {
  test("a person's commits keep their credit in the squashed commit", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      const wt = new Git(ctx.worktreeDir);
      writeFileSync(join(ctx.worktreeDir, "NOTES.md"), "from a person\n");
      await wt.run(["add", "NOTES.md"]);
      await wt.run(["-c", "user.name=Pat Person", "-c", "user.email=pat@example.com", "commit", "-q", "--no-verify", "-m", "docs: a note"]);
      await mainMoves(repo.path);
      const { result } = await withResolve({ resolve: resolveFixture(RESOLVED, true) }, () => catchUp(ctx));
      expect(result).toMatchObject({ ok: true, outcome: "resolved", files: ["src/add.ts"] });
      const message = (await wt.run(["log", "-1", "--format=%B"])).out;
      expect(message).toContain("- docs: a note");
      expect(message).toContain("Co-authored-by: Pat Person <pat@example.com>");
      expect(roundsAllowed(ctx)).toBe(2);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a branch that already has main is current, and one main moved past without a conflict is rebased", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      // Main has records the branch lacks (the status changes since it was built): rebased once, then current.
      await catchUp(ctx);
      expect(await catchUp(ctx)).toEqual({ ok: true, outcome: "current", files: [] });
      await mainMoves(repo.path, false);
      expect(await catchUp(ctx)).toEqual({ ok: true, outcome: "rebased", files: [] });
      expect(await new Git(repo.path).isAncestor("main", "intent/add-numbers")).toBe(true);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a resolution cut short (a crash) is undone the next time the worktree is opened", async () => {
    const { repo, ctx, trace } = await copy("reviewed");
    try {
      const wt = new Git(ctx.worktreeDir);
      const before = await wt.headSha();
      await mainMoves(repo.path);
      // What a crash mid-resolution leaves: the branch moved to main, the squash half done, the marker.
      writeMarker(ctx, CATCHING_UP, before);
      await wt.run(["reset", "-q", "--hard", "main"]);
      await wt.run(["merge", "--squash", before], true);
      writeFileSync(join(ctx.worktreeDir, "stray.txt"), "left by the session\n");
      expect(await openBranchWorktree(ctx)).toEqual({ ok: true });
      expect(await wt.headSha()).toBe(before);
      expect(await wt.isDirty()).toBe(false);
      expect(readMarker(ctx, CATCHING_UP)).toBeNull();
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("the failure note is plain", () => {
    expect(CONFLICT_NOTE).not.toMatch(/\bgit\b|rebase|squash/);
  });
});
