import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runDesignStep } from "../../src/stages/design";
import type { Trace } from "../../src/trace";
import { FIRST_NEEDS } from "../../src/judges";
import { FAKE_CLAUDE, seedCaught, setupRepo, tempDir, withEnv } from "../helpers";

const HUMAN_SPEC = "gates:\n  spec:\n    human: status\n";

function statusesSeen(trace: Trace): string[] {
  return trace.events("add-numbers").filter((e) => e.type === "status_change").map((e) => (JSON.parse(e.payload) as { to: string }).to);
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

describe("design stage", () => {
  test("with no human gate, accepted → spec-approved in one step: spec written, checks run in the same step", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const r = await runDesignStep(ctx);
    expect(r.ok).toBe(true);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(i.file.frontmatter.priority).toBe("high");
    expect(i.artifacts.has("spec.md")).toBe(true);
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
    expect(statusesSeen(trace)).not.toContain("spec-review");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("with a human gate, checks run first and spec-review waits; stepping it again never advances", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: HUMAN_SPEC });
    await runDesignStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toContain("spec-approved");
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
    const phasesBefore = phaseNames(trace).length;

    await ctx.reload();
    const r = await runDesignStep(ctx);
    expect(r.ok).toBe(true);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(phaseNames(trace).length).toBe(phasesBefore);
    trace.close(); repo.cleanup();
  });

  test("a rejected spec is written once more with the findings, then blocks in plain words, never reaching spec-review", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: HUMAN_SPEC });
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{intent}} {{spec}} FIXTURE:spec-check-reject");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["intake", "design", "spec-check", "design", "spec-check"]);
    expect(statusesSeen(trace)).not.toContain("spec-review");
    const note = i.file.frontmatter.note;
    expect(note).toContain("spec-approved");
    expect(note).toContain("accepted");
    expect(note).not.toMatch(/spec-check|headings|\(|:/);
    const second = await Bun.file(join(ctx.runDir, "phases", "4-design", "prompt.md")).text();
    expect(second).toContain("negative numbers");
    trace.close(); repo.cleanup();
  });

  test("when the spec checker itself fails, the intent blocks without a rewrite", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{spec}} FIXTURE:budget");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["intake", "design", "spec-check"]);
    expect(i.file.frontmatter.note).toContain("could not be checked");
    trace.close(); repo.cleanup();
  });

  test("design is read-only and runs in plan mode, like plan", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "gates:\n  spec:\n    agent: false\n" });
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runDesignStep(ctx));
    expect(phaseNames(trace)).toEqual(["intake", "design"]);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.env.LOOPSTRA_PHASE).toBe("design");
    expect(recorded.args).toEqual(expect.arrayContaining(["--permission-mode", "plan", "--allowedTools", "Read,Glob,Grep"]));
    trace.close(); repo.cleanup();
  });

  test("a leftover redesigned marker is cleared at accepted", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "redesigned"), "");
    await runDesignStep(ctx);
    expect(existsSync(join(ctx.runDir, "redesigned"))).toBe(false);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    trace.close(); repo.cleanup();
  });

  test("an owner's stated priority survives intake and is shown to the intake prompt", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: accepted\n", "status: accepted\npriority: urgent\n"));
    await new Git(repo.path).commitAll("owner priority");
    await ctx.reload();
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(i.file.frontmatter.priority).toBe("urgent");
    const intakePrompt = await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "phases", "1-intake", "prompt.md")).text();
    expect(intakePrompt).toContain("Priority the owner stated: urgent");
    trace.close(); repo.cleanup();
  });

  test("with no stated priority, intake's priority is written and the prompt says not stated", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await runDesignStep(ctx);
    const intakePrompt = await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "phases", "1-intake", "prompt.md")).text();
    expect(intakePrompt).toContain("Priority the owner stated: not stated");
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.priority).toBe("high");
    trace.close(); repo.cleanup();
  });

  test("intake with a question blocks the intent", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("Which portal page");
    trace.close(); repo.cleanup();
  });

  test("a failing before command blocks with a plain note; the command and its output go to the trace", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "stages:\n  design:\n    before:\n      - bun -e \"console.log('lint says no'); process.exit(3)\"\n" });
    const r = await runDesignStep(ctx);
    expect(r.ok).toBe(false);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("A project command that runs before the design stage failed. An engineer needs to look at it. When that is sorted out, set status to accepted to try again.");
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("lint says no"))).toBe(true);
    expect(phaseNames(trace)).toEqual(["design-before"]);
    trace.close(); repo.cleanup();
  });

  test("intake's question is the note, with how to continue; nothing else runs", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.note).toBe("Which portal page should show the status? Update intent.md, then set status to accepted.");
    expect(phaseNames(trace)).toEqual(["intake"]);
    trace.close(); repo.cleanup();
  });
});

describe("cheaper judges on the spec check", () => {
  const judgeNotes = (trace: Trace) => trace.events("add-numbers").filter((e) => e.type === "judge").map((e) => (JSON.parse(e.payload) as { note: string }).note);

  test("shadow: a cheaper pass of a spec the strong judge rejects changes nothing; the rewrite gets the strong judge's findings", async () => {
    const dir = fixtureDir({ "spec-check@sonnet": fixture("spec-check"), "spec-check@opus-1": fixture("spec-check-reject") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: shadow\n" });
        await runDesignStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        const second = trace.phases("add-numbers").filter((p) => p.name === "design")[1]!;
        expect(await Bun.file(join(ctx.runDir, "phases", `${second.seq}-design`, "prompt.md")).text()).toContain("The spec never mentions negative numbers.");
        // The cheaper judge writes no gate rows: only the strong spec-check's.
        expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:fail", "headings:pass", "spec-check:pass"]);
        expect(trace.judgeRows().map((r) => `${r.cheap}/${r.strong}`)).toEqual(["pass/reject", "pass/pass"]);
        expect(judgeNotes(trace)[0]).toBe("the cheaper judge (sonnet) passed what the strong judge (opus) rejected; the strong judge decided");
        expect(phaseNames(trace).filter((n) => n === "spec-check-cheap")).toHaveLength(2);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("first, earned: a cheaper pass decides alone and the gate's evidence names the cheaper judge", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: first\n" });
    seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    expect(phaseNames(trace)).toEqual(["intake", "design", "spec-check-cheap"]);
    expect(trace.gates("add-numbers").find((g) => g.check === "spec-check")?.evidence).toBe("spec covers the intent (decided by the cheaper judge, sonnet)");
    trace.close(); repo.cleanup();
  });
});

/** A shipped fake-claude fixture's text. */
function fixture(name: string): string {
  return readFileSync(join(dirname(FAKE_CLAUDE), "fixtures", `${name}.jsonl`), "utf8");
}

/** A LOOPSTRA_FAKE_FIXTURE_DIR holding these fixtures (name without .jsonl → text). */
function fixtureDir(files: Record<string, string>): { path: string; cleanup: () => void } {
  const dir = tempDir("loopstra-fixtures-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir.path, `${name}.jsonl`), text);
  return dir;
}
