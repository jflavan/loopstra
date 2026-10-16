import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CLAUDE, tempDir } from "../helpers";

/** A one-line fixture whose result names it, so a test sees which fixture was replayed. */
function fixture(dir: string, name: string) {
  writeFileSync(join(dir, `${name}.jsonl`), JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: name, total_cost_usd: 0, usage: {} }) + "\n");
}

/** Runs the fake as the runtime would for one phase on one model, and gives the fixture it replayed. */
async function replayed(dir: string, phase: string, model: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [process.execPath, FAKE_CLAUDE, "-p", "--model", model],
    env: { ...process.env, LOOPSTRA_PHASE: phase, LOOPSTRA_FAKE_FIXTURE_DIR: dir, LOOPSTRA_FAKE_FIXTURE: "", LOOPSTRA_FAKE_DELAY_MS: "" },
    stdin: new Blob(["a prompt"]), stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return (JSON.parse(out.trim().split("\n").at(-1)!) as { session_id: string }).session_id;
}

describe("the fake claude's fixtures for one model", () => {
  test("<phase>@<model>.jsonl is chosen only for the matching --model", async () => {
    const dir = tempDir();
    try {
      fixture(dir.path, "spec-check@sonnet");
      fixture(dir.path, "spec-check");
      expect(await replayed(dir.path, "spec-check", "sonnet")).toBe("spec-check@sonnet");
      expect(await replayed(dir.path, "spec-check", "opus")).toBe("spec-check");
    } finally { dir.cleanup(); }
  });

  test("<phase>@<model>-<n>.jsonl sequences count each model on its own", async () => {
    const dir = tempDir();
    try {
      for (const name of ["review@opus-1", "review@opus-2", "review@sonnet-1", "review@sonnet-2"]) fixture(dir.path, name);
      expect(await replayed(dir.path, "review", "opus")).toBe("review@opus-1");
      expect(await replayed(dir.path, "review", "sonnet")).toBe("review@sonnet-1");
      expect(await replayed(dir.path, "review", "sonnet")).toBe("review@sonnet-2");
      expect(await replayed(dir.path, "review", "opus")).toBe("review@opus-2");
    } finally { dir.cleanup(); }
  });

  test("the plain <phase>-<n> sequence still counts every call of the phase", async () => {
    const dir = tempDir();
    try {
      for (const name of ["plan-1", "plan-2", "plan@sonnet-1"]) fixture(dir.path, name);
      expect(await replayed(dir.path, "plan", "sonnet")).toBe("plan@sonnet-1");
      expect(await replayed(dir.path, "plan", "opus")).toBe("plan-2");
    } finally { dir.cleanup(); }
  });
});
