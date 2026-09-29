import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import { StepContext, block, readArtifact, setStatus, writeArtifact, loadSessions, saveSession } from "../../src/context";
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

  test("block sets blocked with a note and keeps resume_from", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await block(ctx, "The intent needs a Done when section.");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The intent needs a Done when section.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
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

  test("sessions persist per intent", async () => {
    const { repo, ctx, trace } = await setup();
    expect(loadSessions(ctx)).toEqual({});
    saveSession(ctx, "build", "sid-1");
    expect(loadSessions(ctx)).toEqual({ build: "sid-1" });
    trace.close(); repo.cleanup();
  });
});
