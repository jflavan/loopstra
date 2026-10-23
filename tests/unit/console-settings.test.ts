import { describe, expect, test } from "bun:test";
import { settingsView } from "../../src/console/settings";
import { Trace } from "../../src/trace";
import { config, withTrace } from "../console-helpers";
import { tempDir } from "../helpers";

async function view(root: string) {
  const trace = Trace.open(root);
  try { return await settingsView(root, trace); } finally { trace.close(); }
}

describe("the settings view", () => {
  test("under defaults: four models, six groups, and each step's muted default", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const v = await view(t.path);
      expect(v.problem).toBeNull();
      expect(v.version).toMatch(/^[0-9a-f]{64}$/);
      expect(v.models.map((m) => m.ref)).toEqual(["cheap", "default", "strong", "max"]);
      expect(v.groups.map((g) => g.group)).toEqual(["design", "plan", "build", "review", "verify", "chat"]);
      expect(v.groups[0]!.path).toBe("stages.design.model");
      expect(v.groups[5]!.path).toBe("chat.model");
      const steps = v.groups.flatMap((g) => g.steps);
      expect(steps.find((s) => s.key === "done-check")).toMatchObject({ own: null, effective: "strong", byDefault: "strong", path: "stages.verify.steps.done-check" });
      expect(steps.find((s) => s.key === "revise")!.byDefault).toBe("follows build: default");
      expect(steps.find((s) => s.key === "orchestrator")!.path).toBeNull();
    } finally { t.cleanup(); }
  });

  test("the last run of a named model is the name it was asked for and the name Claude Code reported", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      withTrace(t.path, (tr) => tr.recordModelRun({ ref: "strong", asked: "opus", ran: "claude-opus-5-5", result: "ok", slug: "a-b", seq: 1 }));
      const v = await view(t.path);
      expect(v.models[2]!.last).toMatchObject({ asked: "opus", ran: "claude-opus-5-5", result: "ok" });
      expect(v.models[0]!.last).toBeNull();
    } finally { t.cleanup(); }
  });

  test("a config that does not load gives a problem and no groups", async () => {
    const t = tempDir();
    try {
      await config(t.path, "stages:\n  build:\n    model: nope\n");
      const v = await view(t.path);
      expect(v.problem).toBeTruthy();
      expect(v.groups).toEqual([]);
    } finally { t.cleanup(); }
  });
});
