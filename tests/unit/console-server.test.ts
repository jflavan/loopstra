import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../../src/console/hub";
import { serveConsole } from "../../src/console/server";
import type { SessionMessage } from "../../src/console/types";
import { Trace } from "../../src/trace";
import { config, intent, sseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

/** A set-up folder with a change "one" whose build phase ended and left a prompt and a transcript. */
async function seeded() {
  const t = tempDir();
  await config(t.path);
  await intent(t.path, "one", "status: building");
  const trace = Trace.open(t.path);
  const seq = trace.phaseStart("one", "build", "agent");
  trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
  trace.close();
  const dir = join(t.path, ".loopstra", "runs", "one", "phases", "1-build");
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "prompt.md"), "# the prompt <b>");
  await Bun.write(join(dir, "raw.jsonl"), [
    { type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } },
    { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, structured_output: { summary: "Done." } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(""));
  await Bun.write(join(t.path, ".loopstra", "secret.txt"), "no");
  await Bun.write(join(t.path, "secret.txt"), "no");
  return t;
}

/** A console on a free port, with its hub at hand so a test can wait for it to let go of the trace. */
async function withConsole(fn: (base: string, hub: Hub) => Promise<void>) {
  const t = await seeded();
  const hub = new Hub(t.path);
  const server = serveConsole(t.path, 0, { hub });
  try {
    await fn(`http://127.0.0.1:${server.port}`, hub);
  } finally {
    server.stop(true);
    await until(() => hub.latest() === null);
    await hub.whenStopped();
    t.cleanup();
  }
}

describe("the console's server", () => {
  test("serves the page on every screen's path, with the scripts and styles it names", async () => {
    await withConsole(async (base) => {
      for (const path of ["/", "/inbox", "/changes", "/activity", "/spend", "/c/one", "/c/one/code", "/s/one/1"]) {
        const r = await fetch(base + path);
        expect({ path, status: r.status }).toEqual({ path, status: 200 });
        expect(r.headers.get("content-type")).toContain("text/html");
        const html = await r.text();
        expect(html).toContain('<div id="app">');
        const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
        expect(assets.length).toBeGreaterThan(0);
        for (const a of assets) expect({ a, status: (await fetch(base + a)).status }).toEqual({ a, status: 200 });
      }
    });
  });

  test("data needs a local host name, and nothing but chat takes anything but GET", async () => {
    await withConsole(async (base) => {
      for (const path of ["/api/spend", "/api/events", "/api/changes/one", "/files/one/phases/1-build/prompt.md", "/docs/one/intent.md"]) {
        expect({ path, status: (await fetch(base + path, { headers: { host: "evil.test" } })).status }).toEqual({ path, status: 403 });
        expect({ path, status: (await fetch(base + path)).status }).toEqual({ path, status: 200 });
      }
      expect((await fetch(base + "/api/spend", { headers: { host: "localhost" } })).status).toBe(200);
      expect((await fetch(base + "/api/spend", { method: "POST" })).status).toBe(405);
      expect((await fetch(base + "/api/chat?thread=tab-abcdefgh")).status).toBe(404); // no chat in this console
      expect((await fetch(base + "/nope")).status).toBe(404);
    });
  });

  test("the live stream starts with a snapshot of every section", async () => {
    await withConsole(async (base) => {
      const [first] = await sseFrames(`${base}/api/stream`, 1);
      expect(first!.data).toMatchObject({ type: "snapshot", meta: { chat: false }, sections: { changes: [{ slug: "one" }] } });
      expect(Number(first!.id)).toBeGreaterThan(0);
    });
  });

  test("a change's page, its diff, activity and spend", async () => {
    await withConsole(async (base) => {
      expect(await (await fetch(`${base}/api/changes/one`)).json()).toMatchObject({ slug: "one", phases: [{ name: "build", status: "success" }] });
      for (const bad of ["/api/changes/nope", "/api/changes/..%2Fx", "/api/changes/One"]) expect({ bad, status: (await fetch(base + bad)).status }).toEqual({ bad, status: 404 });
      expect(await (await fetch(`${base}/api/changes/one/diff`)).json()).toEqual({ exists: false, stat: "", patch: "", cut: false });
      const events = await (await fetch(`${base}/api/events`)).json() as { items: Array<{ text: string }>; next: number | null };
      expect(events.items.map((a) => a.text)).toContain("Build passed ($0.10).");
      expect((await fetch(`${base}/api/events?slug=..%2Fx`)).status).toBe(400);
      const spend = await (await fetch(`${base}/api/spend`)).json() as { totals: { allUsd: number } };
      expect(spend.totals.allUsd).toBeCloseTo(0.1);
    });
  });

  test("a session's stream sends its transcript and ends; a phase that does not exist is not found", async () => {
    await withConsole(async (base) => {
      const frames = await sseFrames(`${base}/api/sessions/one/1/stream`, 5);
      expect(frames.map((f) => (f.data as SessionMessage).type)).toEqual(["phase", "item", "item", "phase", "end"]);
      expect((await fetch(`${base}/api/sessions/one/9/stream`)).status).toBe(404);
      expect((await fetch(`${base}/api/sessions/..%2Fx/1/stream`)).status).toBe(404);
    });
  });

  test("a change's own documents and run files are served read-only as plain text, and nothing else is", async () => {
    await withConsole(async (base) => {
      const doc = await fetch(`${base}/docs/one/intent.md`);
      expect(doc.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await doc.text()).toContain("# Intent: one");
      const file = await fetch(`${base}/files/one/phases/1-build/prompt.md`);
      expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await file.text()).toBe("# the prompt <b>");
      for (const bad of [
        "/docs/one/plan.md", "/docs/one/secret.txt", "/docs/one/..%2F..%2Fsecret.txt", "/docs/..%2F..%2Fsecret.txt/intent.md", "/docs/One/intent.md",
        "/docs/one%2F..%2Fone/intent.md", "/docs/one", "/docs/", "/docs/one/intent.md/x",
        "/files/one%2F..%2F..%2Fsecret.txt", "/files/..%5C..%5Csecret.txt", "/files/..%2Fsecret.txt", "/files/C:%5CWindows%5Cwin.ini", "/files/",
      ]) {
        const r = await fetch(base + bad);
        expect({ bad, status: r.status }).toEqual({ bad, status: 404 });
        expect(await r.text()).not.toBe("no");
      }
    });
  });
});
