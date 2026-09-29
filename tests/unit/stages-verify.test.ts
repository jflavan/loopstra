import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { NEEDS_PERSON_DONE_NOTE, runVerifyStep } from "../../src/stages/verify";
import { setupRepo } from "../helpers";

async function merged(opts: { config?: string; doneCheck?: string } = {}) {
  const s = await setupRepo("merged", { config: opts.config });
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), "# Plan\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "review.md"), "# Review\n");
  if (opts.doneCheck) await Bun.write(join(s.repo.path, "loopstra", "prompts", "done-check.md"), `{{done_when}} FIXTURE:${opts.doneCheck}`);
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  return s;
}

async function outcomeOf(repo: string): Promise<string> {
  return Bun.file(join(repo, "intent", "add-numbers", "outcome.md")).text();
}

async function lessonsOf(repo: string): Promise<string> {
  return Bun.file(join(repo, "intent", "add-numbers", "lessons.md")).text();
}

describe("verify stage", () => {
  test("merged → done: outcome.md for the owner, lessons.md for engineers, both written by the runtime and committed", async () => {
    const { repo, ctx, trace } = await merged({ config: "stages:\n  verify:\n    skills:\n      - checking-results\n" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    expect(i.file.frontmatter.note).toBe("");
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## Evidence");
    expect(outcome).not.toContain("Lessons");
    expect(outcome).not.toContain("CLAUDE.md");
    expect(outcome).not.toContain("For a person to confirm");
    const lessons = await lessonsOf(repo.path);
    expect(lessons).toContain("## Lessons");
    expect(lessons).toContain("## Proposed CLAUDE.md additions");
    expect(lessons).toContain("doc comment");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    expect((await new Git(repo.path).run(["cat-file", "-e", "main:intent/add-numbers/lessons.md"], true)).code).toBe(0);
    // Both judges are told the verify stage's skills.
    for (const name of ["done-check", "lessons"]) {
      const p = trace.phases("add-numbers").find((x) => x.name === name)!;
      expect(await Bun.file(join(ctx.runDir, "phases", `${p.seq}-${name}`, "prompt.md")).text()).toContain("`checking-results`");
    }
    expect(trace.gates("add-numbers").map((g) => `${g.gate}/${g.check}:${g.result}`)).toEqual(["done/done-check:pass"]);
    trace.close(); repo.cleanup();
  });

  test("the done-check runs in a throwaway copy of main, so what it builds never reaches the owner's checkout", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-writes" });
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(existsSync(join(repo.path, "built-by-done-check.txt"))).toBe(false);
    expect(existsSync(join(repo.path, ".loopstra", "verify", "add-numbers"))).toBe(false);
    expect((await new Git(repo.path).run(["worktree", "list"])).out.trim().split("\n")).toHaveLength(1);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("verify before and after commands run around the done-check and outcome", async () => {
    const { repo, ctx, trace } = await merged({ config: "stages:\n  verify:\n    before:\n      - echo before\n    after:\n      - echo after\n" });
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(trace.phases("add-numbers").map((p) => p.name)).toEqual(["verify-before", "done-check", "lessons", "verify-after"]);
    trace.close(); repo.cleanup();
  });

  test("with a person on the done gate: outcome and lessons are written, verifying waits, and the person sets done", async () => {
    const { repo, ctx, trace } = await merged({ config: "gates:\n  done:\n    human: status\n    agent: true\nstages:\n  verify:\n    after:\n      - echo after\n" });
    await runVerifyStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("verifying");
    expect(i.file.frontmatter.note).toContain("outcome.md");
    expect(i.file.frontmatter.note).toContain("done");
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## Evidence");
    expect(await lessonsOf(repo.path)).toContain("## Lessons");
    expect(trace.phases("add-numbers").map((p) => p.name)).toEqual(["done-check", "lessons", "verify-after"]);

    // Stepping the waiting status does nothing.
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("verifying");
    expect(trace.phases("add-numbers")).toHaveLength(3);

    await writeIntent(ctx.intent, { status: "done", note: "" });
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    trace.close(); repo.cleanup();
  });

  test("unmet criteria block in plain words, with the outcome written for the person", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-unmet" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("not met");
    expect(i.file.frontmatter.note).toContain("outcome.md");
    expect(i.file.frontmatter.note).not.toContain("returns 4");
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## Not met");
    expect(outcome).toContain("add(1, 2) returns 3.");
    expect(await lessonsOf(repo.path)).toContain("## Lessons");
    trace.close(); repo.cleanup();
  });

  test("results that need a person never block: done, with a note and a section in outcome.md", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-needs-person" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    expect(i.file.frontmatter.note).toBe(NEEDS_PERSON_DONE_NOTE);
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## For a person to confirm");
    expect(outcome).toContain("Accountants find it easier to use.");
    trace.close(); repo.cleanup();
  });

  test("a judge that cannot finish blocks as a failed check, never as criteria unmet", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "agent-fail" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The final check could not be completed; an engineer should look. When that is sorted out, set status to merged to try again.");
    expect(i.file.frontmatter.resume_from).toBe("merged");
    expect(i.artifacts.has("outcome.md")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("verifying with nobody on the done gate finishes as done", async () => {
    const { repo, ctx, trace } = await merged();
    await Bun.write(join(repo.path, "intent", "add-numbers", "outcome.md"), "# Outcome\n");
    await writeIntent(ctx.intent, { status: "verifying" });
    await new Git(repo.path).commitAll("verifying");
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(trace.phases("add-numbers")).toHaveLength(0);
    trace.close(); repo.cleanup();
  });
});
