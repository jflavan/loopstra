import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderStatus } from "../../src/commands/status";
import { configPath } from "../../src/config";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

const BODY = "\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n";

async function intent(root: string, slug: string, fm: string): Promise<void> {
  mkdirSync(join(root, "intent", slug), { recursive: true });
  await Bun.write(join(root, "intent", slug, "intent.md"), `---\n${fm}\n---\n# Intent: ${slug}\n${BODY}`);
}

async function config(root: string): Promise<void> {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  await Bun.write(configPath(root), "version: 1\ncommands:\n  test: echo ok\n");
}

describe("renderStatus", () => {
  test("shows each intent with plain status, phase, cost, and note", async () => {
    const t = tempDir();
    await intent(t.path, "one", "status: blocked\npriority: high\nnote: Tests failed three times.");
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

  test("a Needs attention block sits under the loop line, the same list as the dashboard's", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "busy", "status: building");
      expect((await renderStatus(t.path, 100)).split("\n").slice(0, 3)).toEqual(["Loop: Stopped", "", "Nothing needs you right now."]);
      await intent(t.path, "stuck", "status: blocked\nnote: The tests failed three times.");
      await intent(t.path, "idea", "status: draft");
      const text = await renderStatus(t.path, 100);
      const block = text.slice(0, text.indexOf("\n\nChange"));
      expect(block).toBe([
        "Loop: Stopped",
        "",
        "Needs attention:",
        "- Blocked (stuck): The tests failed three times.",
        "- Waiting for you (idea): A draft. When it says what you want, change the status line to accepted.",
        "  To drop it, set it to closed.",
      ].join("\n"));
    } finally {
      t.cleanup();
    }
  });

  test("a change waiting for another says why in its note; a wait only a person can end needs attention", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "first", "status: accepted");
      await intent(t.path, "second", "status: accepted\ndepends_on: first");
      await intent(t.path, "third", "status: accepted\ndepends_on: [frist]");
      const text = await renderStatus(t.path, 200);
      expect(text).toContain("Waits for first to be merged (now: waiting to be designed).");
      const block = text.slice(0, text.indexOf("\n\nChange"));
      expect(block).not.toContain("(second)");
      expect(block).toContain("- Waiting for you (third): Waits for frist, which Loopstra cannot find or read in intent/. Fix the name in depends_on, or remove it.");
    } finally {
      t.cleanup();
    }
  });

  test("never pads the last column, and wraps long notes to the width", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "quiet", "status: building");
      const long = "The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change.";
      await intent(t.path, "stuck", `status: blocked\nnote: "${long}"`);
      const text = await renderStatus(t.path, 100);
      const lines = text.trimEnd().split("\n");
      for (const l of lines) {
        expect(l).toBe(l.trimEnd());
        expect(l.length).toBeLessThanOrEqual(100);
      }
      // The note continues on the next lines, under its own column.
      const noteAt = lines.find((l) => l.startsWith("Change"))!.indexOf("Note");
      const at = lines.findIndex((l) => l.startsWith("stuck"));
      expect(lines[at]!.slice(noteAt)).toStartWith("The reviewer");
      expect(lines[at + 1]!.slice(0, noteAt).trim()).toBe("");
      expect(lines.slice(at).map((l) => l.slice(noteAt)).join(" ")).toContain("An engineer needs to look at the change.");
    } finally {
      t.cleanup();
    }
  });
});
