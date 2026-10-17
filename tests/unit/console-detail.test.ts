import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { changeDetail, spendView } from "../../src/console/detail";
import { resolveDocument, resolveRunFile } from "../../src/console/files";
import { buildModel } from "../../src/console/model";
import { writeHeartbeat } from "../../src/heartbeat";
import { templateSha } from "../../src/judges";
import { Trace } from "../../src/trace";
import { config, intent, setStarted } from "../console-helpers";
import { tempDir } from "../helpers";

/** A change "one" with a finished build phase that left a prompt and an envelope, and two files outside the runs folder. */
async function seeded() {
  const t = tempDir();
  await intent(t.path, "one", "status: building");
  const trace = Trace.open(t.path);
  const seq = trace.phaseStart("one", "build", "agent");
  trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
  trace.close();
  const dir = join(t.path, ".loopstra", "runs", "one", "phases", "1-build");
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "prompt.md"), "# the prompt <b>");
  await Bun.write(join(dir, "envelope.json"), "{}");
  await Bun.write(join(t.path, ".loopstra", "secret.txt"), "no");
  await Bun.write(join(t.path, "secret.txt"), "no");
  return t;
}

describe("a change's page", () => {
  test("its phases with the files they left and the commands they were refused, its gates and its documents", async () => {
    const t = await seeded();
    const trace = Trace.open(t.path);
    try {
      await Bun.write(join(t.path, "intent", "one", "spec.md"), "# Spec\n");
      trace.gate("one", "plan", "headings", "pass", "ok");
      const fix = trace.phaseStart("one", "fix-1", "agent");
      trace.phaseEnd("one", fix, { status: "fail", denied: ["Bash(git tag v1)"] });
      const d = await changeDetail(t.path, trace, "one");
      expect(d).toMatchObject({ slug: "one", status: "building", stage: "build", dependsOn: [] });
      expect(d!.documents).toEqual([{ name: "intent.md", url: "/docs/one/intent.md" }, { name: "spec.md", url: "/docs/one/spec.md" }]);
      expect(d!.phases[0]).toMatchObject({
        seq: 1, name: "build", status: "success", costUsd: 0.1, denied: [],
        files: [{ name: "prompt.md", url: "/files/one/phases/1-build/prompt.md" }, { name: "envelope.json", url: "/files/one/phases/1-build/envelope.json" }],
      });
      expect(d!.phases[1]).toMatchObject({ name: "fix-1", status: "fail", denied: ["Bash(git tag v1)"], files: [] });
      expect(d!.gates[0]).toMatchObject({ gate: "plan", check: "headings", result: "pass" });
      expect(await changeDetail(t.path, trace, "nope")).toBeNull();
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("it says the change is running just when the board does: a live loop working on it, in a step started this tick", async () => {
    const t = await seeded();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      const seq = trace.phaseStart("one", "fix-1", "agent");
      const now = new Date();
      const iso = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
      setStarted(t.path, "one", seq, iso(10));
      const both = async () => [(await changeDetail(t.path, trace, "one", now))!.running, (await buildModel(t.path, trace, now)).sections.changes[0]!.running];

      // A row left running, with no loop at all: a killed process's.
      expect(await both()).toEqual([false, false]);
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "one" }, working: ["one"], stopping: false, stopped: false });
      expect(await both()).toEqual([true, true]);
      // The step started before the current tick: left over from an earlier run.
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(5), lastBeatAt: iso(1), current: { slug: "one" }, working: ["one"], stopping: false, stopped: false });
      expect(await both()).toEqual([false, false]);
      // The loop is working on something else.
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "two" }, working: ["two"], stopping: false, stopped: false });
      expect(await both()).toEqual([false, false]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("only files under .loopstra/runs resolve", async () => {
    const t = await seeded();
    try {
      expect(resolveRunFile(t.path, "one/phases/1-build/prompt.md")).not.toBeNull();
      for (const bad of [
        "../secret.txt", "one/../../secret.txt", "one/../../../secret.txt", "..\\secret.txt", "one\\..\\..\\secret.txt",
        join(t.path, "secret.txt"), "/etc/passwd", "C:\\Windows\\win.ini", "C:secret.txt", "one/phases/1-build",
        "one/phases/1-build/missing.md", "", "one/phases/1-build/prompt.md\0", "one/phases/1-build/prompt.md:stream",
      ]) {
        expect({ bad, r: resolveRunFile(t.path, bad) }).toEqual({ bad, r: null });
      }
    } finally {
      t.cleanup();
    }
  });

  test("only a change's own known documents resolve", async () => {
    const t = await seeded();
    try {
      await Bun.write(join(t.path, "intent", "one", "spec.md"), "# Spec\n");
      expect(resolveDocument(t.path, "one", "spec.md")).not.toBeNull();
      expect(resolveDocument(t.path, "one", "plan.md")).toBeNull();
      expect(resolveDocument(t.path, "one", "secret.txt")).toBeNull();
      expect(resolveDocument(t.path, "One", "intent.md")).toBeNull();
      expect(resolveDocument(t.path, "..", "intent.md")).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a linked folder does not serve files from outside the intent folder or the runs folder", async () => {
    const t = await seeded();
    try {
      const outside = join(t.path, "outside");
      mkdirSync(outside);
      await Bun.write(join(outside, "intent.md"), "---\nstatus: draft\n---\n# Intent: x\n");
      await Bun.write(join(outside, "prompt.md"), "no");
      try {
        symlinkSync(outside, join(t.path, "intent", "linked"), "junction");
        symlinkSync(outside, join(t.path, ".loopstra", "runs", "linked"), "junction");
      } catch {
        console.warn("skipped: this system does not allow making links");
        return;
      }
      expect(resolveDocument(t.path, "linked", "intent.md")).toBeNull();
      expect(resolveRunFile(t.path, "linked/prompt.md")).toBeNull();
      expect(resolveDocument(t.path, "one", "intent.md")).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });
});

describe("spend", () => {
  test("per change, per kind of step, per hour, and chat's", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building", "One");
      await intent(t.path, "two", "status: designing", "Two");
      const build = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", build, { status: "success", costUsd: 0.5 });
      const f1 = trace.phaseStart("one", "fix-1", "agent"); trace.phaseEnd("one", f1, { status: "fail", costUsd: 0.2 });
      const f2 = trace.phaseStart("one", "fix-2", "agent"); trace.phaseEnd("one", f2, { status: "success", costUsd: 0.1 });
      trace.phaseStart("one", "fix-3", "agent", 3); // running, holding $3: not spending
      const d = trace.phaseStart("two", "design", "agent"); trace.phaseEnd("two", d, { status: "success", costUsd: 1 });
      const c = trace.phaseStart("_chat", "orchestrator", "agent"); trace.phaseEnd("_chat", c, { status: "success", costUsd: 0.25 });
      const now = new Date();
      setStarted(t.path, "one", build, new Date(now.getTime() - 90 * 60_000).toISOString());

      const v = await spendView(t.path, trace, null, now);
      expect(v.totals.allUsd).toBeCloseTo(2.05);
      expect(v.chatUsd).toBeCloseTo(0.25);
      expect(v.perChange.map((x) => [x.slug, x.title])).toEqual([["two", "Two"], ["one", "One"]]);
      expect(v.perChange[1]!.costUsd).toBeCloseTo(0.8);
      expect(v.perPhase.find((p) => p.name === "fix")).toMatchObject({ count: 3 });
      expect(v.perPhase.find((p) => p.name === "fix")!.costUsd).toBeCloseTo(0.3);
      expect(v.perPhase.find((p) => p.name === "chat")!.costUsd).toBeCloseTo(0.25);
      expect(v.byHour).toHaveLength(48);
      expect(v.byHour.reduce((n, h) => n + h.costUsd, 0)).toBeCloseTo(2.05);
      expect(v.byHour.at(-1)!.costUsd).toBeCloseTo(1.55); // everything but the build, which started 90 minutes ago
      expect(v.judges).toBeNull();
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("the cheaper judges: left out while off and never compared; otherwise their report, with the newest five false passes", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      await Bun.write(join(t.path, "loopstra", "prompts", "review.md"), "review prompt");
      expect((await spendView(t.path, trace, await loadConfig(t.path))).judges).toBeNull();

      await config(t.path, "speed:\n  cheap_judges: shadow\n");
      const shadow = (await spendView(t.path, trace, await loadConfig(t.path))).judges!;
      expect(shadow).toMatchObject({ setting: "shadow", cheapModel: "sonnet", strongModel: "opus", spentUsd: 0, falsePasses: [] });

      await config(t.path);
      for (let i = 1; i <= 7; i++) {
        trace.judge(`change-${i}`, {
          judge: "review", trace_name: "review-1", mode: "shadow", how: "shadow", cheap_model: "sonnet", strong_model: "opus",
          template_sha: templateSha(t.path, "review")!, prompt_sha: `change-${i}`, cheap: "pass", strong: "reject",
          cheap_usd: 0.1, strong_usd: 0.3, cheap_ms: 1000, strong_ms: 3000,
        });
      }
      const off = (await spendView(t.path, trace, await loadConfig(t.path))).judges!;
      expect(off.setting).toBe("off");
      expect(off.judges.find((j) => j.judge === "review")).toMatchObject({ compared: 7, falsePasses: 7 });
      expect(off.falsePasses.map((p) => p.slug)).toEqual(["change-7", "change-6", "change-5", "change-4", "change-3"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
