import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CLAUDE, tempDir } from "../helpers";

/** A one-line fixture whose result names it (by `id`, its name by default), so a test sees which fixture was replayed. */
function fixture(dir: string, name: string, id = name) {
  writeFileSync(join(dir, `${name}.jsonl`), JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id, total_cost_usd: 0, usage: {} }) + "\n");
}

/** Runs the fake as the runtime would for one phase of one change on one model, and gives the fixture it replayed. */
async function replayed(dir: string, phase: string, model: string, slug = ""): Promise<string> {
  const proc = Bun.spawn({
    cmd: [process.execPath, FAKE_CLAUDE, "-p", "--model", model],
    // In the fixture folder: a shipped fixture the fake falls back to may write files where it runs.
    cwd: dir,
    env: { ...process.env, LOOPSTRA_PHASE: phase, LOOPSTRA_SLUG: slug, LOOPSTRA_FAKE_FIXTURE_DIR: dir, LOOPSTRA_FAKE_FIXTURE: "", LOOPSTRA_FAKE_DELAY_MS: "" },
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

  test("a <slug>/ folder holds that change's own sequences, so two changes' sessions of one phase can start together", async () => {
    const dir = tempDir();
    try {
      for (const slug of ["add-numbers", "say-goodbye"]) {
        mkdirSync(join(dir.path, slug));
        for (const n of [1, 2]) fixture(join(dir.path, slug), `build-${n}`, `${slug}/build-${n}`);
      }
      fixture(join(dir.path, "say-goodbye"), "review", "say-goodbye/review");
      fixture(dir.path, "build-1", "shared/build-1");
      fixture(dir.path, "review", "shared/review");
      const both = () => Promise.all([
        replayed(dir.path, "build", "opus", "add-numbers"),
        replayed(dir.path, "build", "opus", "say-goodbye"),
      ]);
      expect(await both()).toEqual(["add-numbers/build-1", "say-goodbye/build-1"]);
      expect(await both()).toEqual(["add-numbers/build-2", "say-goodbye/build-2"]);
      expect(readFileSync(join(dir.path, "add-numbers", ".count-build"), "utf8")).toBe("2");
      expect(readFileSync(join(dir.path, "say-goodbye", ".count-build"), "utf8")).toBe("2");
      // A change's own <phase>.jsonl comes first; without one, the shared folder's is used.
      expect(await replayed(dir.path, "review", "opus", "say-goodbye")).toBe("say-goodbye/review");
      expect(await replayed(dir.path, "review", "opus", "add-numbers")).toBe("shared/review");
      // A change without its own folder still uses the shared one, whose count the others never touched.
      expect(await replayed(dir.path, "build", "opus", "other")).toBe("shared/build-1");
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
