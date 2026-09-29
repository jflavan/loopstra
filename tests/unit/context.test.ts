import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import {
  StepContext, block, blockNote, blockWithDetail, clearMarker, MainCheckoutMoved, OFF_MAIN_NOTE, onceMarker,
  readArtifact, setStatus, writeArtifact, loadSessions, saveSession,
} from "../../src/context";
import { tempGitRepo } from "../helpers";

async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("intent");
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const intent = await readIntent(repo.path, "x");
  const ctx = new StepContext(repo.path, cfg, trace, intent);
  return { repo, ctx, trace };
}

describe("StepContext", () => {
  test("setStatus writes frontmatter, records resume_from on approved states, commits, and traces", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review", "Read spec.md.");
    let i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toBe("Read spec.md.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
    await setStatus(ctx, "spec-approved");
    i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("spec-approved");
    expect(i.file.frontmatter.note).toBe("");
    const log = await new Git(repo.path).log(1);
    expect(log[0]).toContain("loopstra(x)");
    expect(trace.events("x").some((e) => e.type === "status_change")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("resume_from follows a status a person approved by hand, even with a stale resume_from already set", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review");
    await setStatus(ctx, "spec-approved");
    await ctx.reload();
    // Simulate a person editing the status directly (skipping the runtime), leaving resume_from stale.
    await writeIntent(ctx.intent, { status: "plan-approved" });
    await ctx.reload();
    await setStatus(ctx, "building");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("plan-approved");
    trace.close(); repo.cleanup();
  });

  test("accepted through spec-approved then planning yields resume_from spec-approved", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review");
    await setStatus(ctx, "spec-approved");
    await setStatus(ctx, "planning");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("spec-approved");
    trace.close(); repo.cleanup();
  });

  test("block sets blocked with a note and keeps resume_from", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await block(ctx, "The intent needs a Done when section.");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The intent needs a Done when section. When that is sorted out, set status to accepted to try again.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
    trace.close(); repo.cleanup();
  });

  test("block owns the retry wording: it adds the status to set, unless the note already says one", async () => {
    const { repo, ctx, trace } = await setup();
    // From an approved status, that status is the one to set again. A passing hiccup (the assistant
    // crashed or took too long) needs nothing sorted out first: just try again.
    expect(blockNote(ctx, "The assistant stopped unexpectedly.")).toBe("The assistant stopped unexpectedly. To try again, set status to accepted.");
    expect(blockNote(ctx, "The finished change could not be checked. The assistant took too long on this step.")).toBe("The finished change could not be checked. The assistant took too long on this step. To try again, set status to accepted.");
    await setStatus(ctx, "designing");
    expect(blockNote(ctx, "A project command failed.")).toBe("A project command failed. When that is sorted out, set status to accepted to try again.");
    expect(blockNote(ctx, "The pull request could not be merged.", "merge-approved")).toBe("The pull request could not be merged. When that is sorted out, set status to merge-approved to try again.");
    // A note that already says what to set is left as it is.
    for (const n of ["Update intent.md, then set status to accepted.", "Read review.md, then change the status line to merge-approved.", "Decide, then set this one to done or closed."]) {
      expect(blockNote(ctx, n)).toBe(n);
    }
    trace.close(); repo.cleanup();
  });

  test("artifacts read and write in the intent folder and are committed", async () => {
    const { repo, ctx, trace } = await setup();
    expect(await readArtifact(ctx, "spec.md")).toBeNull();
    await writeArtifact(ctx, "spec.md", "# Spec\n");
    expect(await readArtifact(ctx, "spec.md")).toBe("# Spec\n");
    expect(ctx.intent.artifacts.has("spec.md")).toBe(true);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("with the main checkout on another branch, status and artifact writes refuse before touching anything", async () => {
    const { repo, ctx, trace } = await setup();
    await new Git(repo.path).run(["checkout", "-q", "-b", "someone-elses-work"]);
    const head = await new Git(repo.path).headSha();
    await expect(setStatus(ctx, "designing")).rejects.toBeInstanceOf(MainCheckoutMoved);
    await expect(writeArtifact(ctx, "spec.md", "# Spec\n")).rejects.toThrow(OFF_MAIN_NOTE);
    expect(existsSync(join(repo.path, "intent", "x", "spec.md"))).toBe(false);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    expect(await new Git(repo.path).headSha()).toBe(head);
    trace.close(); repo.cleanup();
  });

  test("block on a moved main checkout commits nothing, returns the plain note, and traces why", async () => {
    const { repo, ctx, trace } = await setup();
    await new Git(repo.path).run(["checkout", "-q", "-b", "someone-elses-work"]);
    const r = await block(ctx, "The tests kept failing.");
    expect(r).toEqual({ ok: false, note: OFF_MAIN_NOTE });
    expect(await new Git(repo.path).isDirty()).toBe(false);
    expect((await readIntent(repo.path, "x")).file.frontmatter.status).toBe("accepted");
    const err = trace.events("x").find((e) => e.type === "error");
    expect(err?.payload).toContain("The tests kept failing.");
    expect(err?.payload).toContain("someone-elses-work");
    trace.close(); repo.cleanup();
  });

  test("blockWithDetail puts the plain note on the intent and the detail in the trace", async () => {
    const { repo, ctx, trace } = await setup();
    await blockWithDetail(ctx, "A project command failed.", "`bun run lint` exited 2");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.note).toBe("A project command failed. When that is sorted out, set status to accepted to try again.");
    expect(trace.events("x").some((e) => e.type === "error" && e.payload.includes("bun run lint"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("onceMarker is true only the first time; clearMarker resets it", async () => {
    const { repo, ctx, trace } = await setup();
    expect(onceMarker(ctx, "replanned")).toBe(true);
    expect(onceMarker(ctx, "replanned")).toBe(false);
    clearMarker(ctx, "replanned");
    expect(onceMarker(ctx, "replanned")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("sessions persist per intent", async () => {
    const { repo, ctx, trace } = await setup();
    expect(loadSessions(ctx)).toEqual({});
    saveSession(ctx, "build", "sid-1");
    expect(loadSessions(ctx)).toEqual({ build: "sid-1" });
    trace.close(); repo.cleanup();
  });

  test("loadSessions returns {} for a corrupt sessions.json", async () => {
    const { repo, ctx, trace } = await setup();
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "sessions.json"), "not json");
    expect(loadSessions(ctx)).toEqual({});
    trace.close(); repo.cleanup();
  });
});
