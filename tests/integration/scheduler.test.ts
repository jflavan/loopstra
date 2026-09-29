import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { missingTools, start, tick } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { setupRepo, TEMPLATES } from "../helpers";

afterEach(() => resetStop());

const SLUG = "add-numbers";

/** A commit-msg hook that refuses commits whose message matches `pattern` (a grep pattern). */
async function refuseCommits(repo: string, pattern: string): Promise<void> {
  await Bun.write(join(repo, ".git", "hooks", "commit-msg"), `#!/bin/sh\nif grep -q "${pattern}" "$1"; then exit 1; fi\nexit 0\n`);
}

describe("scheduler resilience", () => {
  test("an exception inside a step blocks the intent with a plain note and the detail in the trace", async () => {
    const { repo, trace } = await setupRepo("accepted");
    await refuseCommits(repo.path, "accepted.*designing");
    const r = await tick(repo.path);
    expect(r.picked).toBe(SLUG);
    const i = await readIntent(repo.path, SLUG);
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("Something unexpected went wrong in this step. An engineer can find the details in the trace. To try again, set status to accepted.");
    expect(trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes("\"where\":\"step\""))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("when even blocking fails, the tick traces it and the loop carries on", async () => {
    const { repo, trace } = await setupRepo("accepted");
    await refuseCommits(repo.path, `loopstra(${SLUG})`);
    const r = await tick(repo.path);
    expect(r.picked).toBe(SLUG);
    expect(r.result?.ok).toBe(false);
    expect(trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes("\"where\":\"block\""))).toBe(true);
    const again = await tick(repo.path);
    expect(again.crashed).toBeUndefined();
    trace.close(); repo.cleanup();
  });

  test("an unreadable intent is listed for a person and the others still run", async () => {
    const { repo, trace } = await setupRepo("accepted");
    mkdirSync(join(repo.path, "intent", "broken"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "broken", "intent.md"), "---\nstatus: nearly-done\n---\n# Intent: broken\n");
    await new Git(repo.path).commitAll("a broken intent");
    const r = await tick(repo.path);
    expect(r.picked).toBe(SLUG);
    expect(r.crashed).toBeUndefined();
    const queue = await Bun.file(join(repo.path, "intent", "queue.md")).text();
    const needs = queue.slice(queue.indexOf("## Needs a person"), queue.indexOf("## Drafts"));
    expect(needs).toContain("| broken |");
    expect(needs).toContain("The status line at the top of intent.md has a value Loopstra does not understand.");
    expect(needs).not.toMatch(/Invalid|enum|zod/i);
    expect(trace.events("broken").some((e) => e.type === "error")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("a stop during a step interrupts it without blocking, and the next tick resumes it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:hang");
    const stopper = (async () => {
      while (!trace.phases(SLUG).some((p) => p.name === "intake")) await Bun.sleep(50);
      requestStop();
    })();
    const r = await tick(repo.path);
    await stopper;
    expect(r.stopped).toBe(true);
    expect(r.picked).toBe(SLUG);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
    expect(trace.phases(SLUG).map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);

    resetStop();
    cpSync(join(TEMPLATES, "intake.md"), join(repo.path, "loopstra", "prompts", "intake.md"));
    await tick(repo.path);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("spec-approved");
    trace.close(); repo.cleanup();
  }, 60_000);

  test("start keeps going after a problem and a stop cuts its sleep short", async () => {
    const { repo, trace } = await setupRepo("draft");
    await Bun.write(configPath(repo.path), "version: 1\nbogus: true\n");
    const started = Date.now();
    setTimeout(() => requestStop(), 500);
    await start(repo.path, { once: false, installSignals: false });
    // The config problem falls back to a 60 second poll; the stop ends the sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
    trace.close(); repo.cleanup();
  }, 30_000);

  test("a merged change's leftover worktree and branch are cleaned up on a later tick", async () => {
    const { repo, ctx, trace } = await setupRepo("done");
    const git = new Git(repo.path);
    await git.createBranch(ctx.branch, "main");
    await git.worktreeAdd(ctx.worktreeDir, ctx.branch);
    await tick(repo.path);
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    expect(await git.branchExists(ctx.branch)).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("start names a missing tool in plain words", () => {
    expect(missingTools({ PATH: "" })).toBe("git was not found. Install Git, then start Loopstra again.");
    expect(missingTools({ PATH: process.env.PATH ?? process.env.Path, LOOPSTRA_CLAUDE_EXECUTABLE: "fake" })).toBeNull();
  });
});
