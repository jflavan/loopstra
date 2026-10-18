import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "../console-helpers";
import { FAKE_CLAUDE, fixture as shipped, fixtureDir, tempDir } from "../helpers";

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

  test("a wait_for line holds the session until that file exists, so a test decides when it ends", async () => {
    const dir = tempDir();
    try {
      const release = join(dir.path, "release");
      writeFileSync(join(dir.path, "intake.jsonl"), [
        JSON.stringify({ type: "fake_action", wait_for: release }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "held", total_cost_usd: 0, usage: {} }),
      ].join("\n") + "\n");
      let ended = false;
      const session = replayed(dir.path, "intake", "opus").then((id) => { ended = true; return id; });
      await Bun.sleep(1500);
      expect(ended).toBe(false);
      writeFileSync(release, "");
      expect(await session).toBe("held");
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

describe("stream-json input", () => {
  const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

  /** Runs the fake with stream-json input kept open: the test writes messages and reads stdout lines as they come. */
  function live(env: Record<string, string>, extraArgs: string[] = []) {
    const p = Bun.spawn({
      cmd: [process.execPath, FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--replay-user-messages", "--output-format", "stream-json", ...extraArgs],
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, LOOPSTRA_FAKE_FIXTURE: "", LOOPSTRA_FAKE_FIXTURE_DIR: "", LOOPSTRA_FAKE_DELAY_MS: "", ...env },
    });
    const lines: Array<Record<string, unknown>> = [];
    const reading = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lines.push(JSON.parse(l)); }
      }
    })();
    return {
      send: (t: string) => { p.stdin.write(user(t)); void p.stdin.flush(); },
      close: () => { void p.stdin.end(); },
      kill: () => p.kill(),
      lines,
      done: async () => { const code = await p.exited; await reading; return code; },
    };
  }
  const results = (ls: Array<Record<string, unknown>>) => ls.filter((l) => l.type === "result") as Array<{ total_cost_usd: number; structured_output: { summary?: string } }>;
  const replays = (ls: Array<Record<string, unknown>>) => ls.filter((l) => l.type === "user" && l.isReplay).map((l) => ((l.message as { content: Array<{ text: string }> }).content[0]!.text));

  test("the prompt is echoed, the fixture plays, and closing stdin ends it", async () => {
    const s = live({ LOOPSTRA_PHASE: "design" });
    s.send("write the spec");
    await until(() => results(s.lines).length === 1);
    s.close();
    expect(await s.done()).toBe(0);
    expect(replays(s.lines)).toEqual(["write the spec"]);
    // The echo carries the session id, from the fixture, before any of its lines.
    expect(s.lines[0]).toMatchObject({ type: "user", isReplay: true, session_id: "fake-design" });
    expect(results(s.lines)[0]!.structured_output.summary).toBe("spec written");
  }, 30_000);

  test("a message during a turn is answered by that turn; one after its result gets a turn of its own", async () => {
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: `${JSON.stringify({ type: "fake_action", wait_for: gate })}\n${shipped("design")}` });
    try {
      const s = live({ LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_STEER_LOG: join(t.path, "steer.jsonl") });
      s.send("write the spec");
      await until(() => replays(s.lines).length === 1);
      s.send("cover negatives");
      await until(() => replays(s.lines).length === 2);
      writeFileSync(gate, "");
      await until(() => results(s.lines).length === 1);
      expect(results(s.lines)[0]!.structured_output.summary).toBe("heard: cover negatives");
      s.send("and zero");
      await until(() => results(s.lines).length === 2);
      s.close();
      expect(await s.done()).toBe(0);
      expect(replays(s.lines)).toEqual(["write the spec", "cover negatives", "and zero"]);
      expect(results(s.lines)[1]!.structured_output.summary).toBe("heard: and zero");
      expect(results(s.lines).map((r) => r.total_cost_usd)).toEqual([0.05, 0.1]);
      expect(readFileSync(join(t.path, "steer.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).at)).toEqual(["mid", "queued"]);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 30_000);

  test("messages written before stdin closes still get their turns once the current one ends", async () => {
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: `${JSON.stringify({ type: "fake_action", wait_for: gate })}\n${shipped("design")}` });
    try {
      const s = live({ LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path });
      s.send("write the spec");
      await until(() => replays(s.lines).length === 1);
      writeFileSync(gate, "");
      await until(() => results(s.lines).length === 1);
      s.send("one");
      s.send("two");
      s.close();
      expect(await s.done()).toBe(0);
      expect(results(s.lines).map((r) => r.structured_output.summary)).toEqual(["spec written", "heard: one", "heard: two"]);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 30_000);

  test("the prompt is the first message: it picks the fixture and is what LOOPSTRA_FAKE_ARGS records; an error result exits 1", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    try {
      const s = live({ LOOPSTRA_FAKE_ARGS: argsFile });
      s.send("FIXTURE:budget please");
      await until(() => results(s.lines).length === 1);
      s.close();
      expect(await s.done()).toBe(1);
      expect(JSON.parse(readFileSync(argsFile, "utf8")).prompt).toBe("FIXTURE:budget please");
    } finally { t.cleanup(); }
  }, 30_000);

  test("hang still never ends, but echoes what it is sent", async () => {
    const t = tempDir();
    const log = join(t.path, "steer.jsonl");
    const s = live({ LOOPSTRA_FAKE_STEER_LOG: log });
    try {
      s.send("FIXTURE:hang");
      await until(() => s.lines.some((l) => l.type === "system"));
      s.send("hello");
      await until(() => replays(s.lines).includes("hello"));
      s.close();
      await Bun.sleep(300);
      expect(results(s.lines)).toEqual([]);
      expect(JSON.parse(readFileSync(log, "utf8").trim()).text).toBe("hello");
    } finally {
      s.kill();
      await s.done();
      t.cleanup();
    }
  }, 30_000);
});
