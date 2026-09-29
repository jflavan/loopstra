import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderStatus } from "../../src/commands/status";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("renderStatus", () => {
  test("shows each intent with plain status, phase, cost, and note", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "one"), { recursive: true });
    await Bun.write(join(t.path, "intent", "one", "intent.md"), "---\nstatus: blocked\npriority: high\nnote: Tests failed three times.\n---\n# Intent: one\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    const trace = Trace.open(t.path);
    trace.upsertIntent("one", "blocked", "high");
    const seq = trace.phaseStart("one", "fix", "agent");
    trace.phaseEnd("one", seq, { status: "fail", costUsd: 0.5, error: "tests red" });
    trace.close();
    const text = await renderStatus(t.path);
    expect(text).toContain("one");
    expect(text).toContain("needs a person");
    expect(text).toContain("fix");
    expect(text).toContain("$0.50");
    expect(text).toContain("Tests failed three times.");
    t.cleanup();
  });

  test("lists an unreadable intent with what to fix", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "broken"), { recursive: true });
    await Bun.write(join(t.path, "intent", "broken", "intent.md"), "---\nstatus: nearly-done\n---\n# Intent: broken\n");
    const text = await renderStatus(t.path);
    expect(text).toContain("broken");
    expect(text).toContain("needs a person");
    expect(text).toContain("The status line at the top of intent.md");
    t.cleanup();
  });

  test("says so when there are no intents", async () => {
    const t = tempDir();
    expect(await renderStatus(t.path)).toMatch(/No intents yet/);
    t.cleanup();
  });
});
