import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyRequests } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { Hub, type HubOptions } from "../../src/console/hub";
import { JSON_IDLE_SECONDS, read, serveConsole } from "../../src/console/server";
import type { SessionMessage } from "../../src/console/types";
import { readLoopHold } from "../../src/heartbeat";
import { pendingRequests } from "../../src/requests";
import { Trace } from "../../src/trace";
import { wakeStamp } from "../../src/wake";
import { chatRepo, INTENT } from "../chat-helpers";
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
async function withConsole(fn: (base: string, hub: Hub) => Promise<void>, hubOpts: HubOptions = {}) {
  const t = await seeded();
  const hub = new Hub(t.path, hubOpts);
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

  test("the page carries its content security policy, and every script it runs comes from the console itself", async () => {
    await withConsole(async (base) => {
      const html = await (await fetch(base + "/")).text();
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'">`);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attrs, body] of scripts) {
        expect(body!.trim()).toBe(""); // script-src 'self' would block an inline one
        expect(attrs).toMatch(/\bsrc="\/[^/"]/);
      }
      for (const [, url] of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) expect(url).toMatch(/^(\/[^/]|data:)/);
    });
  });

  test("data needs a local host name, and nothing but chat takes anything but GET", async () => {
    await withConsole(async (base) => {
      for (const path of ["/api/spend", "/api/events", "/api/changes/one", "/files/one/phases/1-build/prompt.md", "/docs/one/intent.md"]) {
        expect({ path, status: (await fetch(base + path, { headers: { host: "evil.test" } })).status }).toEqual({ path, status: 403 });
        expect({ path, status: (await fetch(base + path)).status }).toEqual({ path, status: 200 });
      }
      // The streams and the diff check it too, before any stream is opened or git is run.
      for (const path of ["/api/stream", "/api/sessions/one/1/stream", "/api/changes/one/diff"]) {
        const r = await fetch(base + path, { headers: { host: "evil.test" } });
        expect({ path, status: r.status }).toEqual({ path, status: 403 });
        await r.body?.cancel();
      }
      expect((await fetch(base + "/api/spend", { headers: { host: "localhost" } })).status).toBe(200);
      expect((await fetch(base + "/api/spend", { headers: { host: "[::1]:4646" } })).status).toBe(200);
      expect((await fetch(base + "/api/spend", { method: "POST" })).status).toBe(405);
      expect((await fetch(base + "/api/chat?thread=tab-abcdefgh")).status).toBe(404); // no chat in this console
      expect((await fetch(base + "/nope")).status).toBe(404);
    });
  });

  test("a route that fails answers 500 in plain words, with no stack, and says one line on stderr", async () => {
    const t = tempDir();
    await config(t.path);
    await Bun.write(join(t.path, ".loopstra"), "a file where the trace's folder should be"); // the trace cannot be opened
    const hub = new Hub(t.path);
    const server = serveConsole(t.path, 0, { hub });
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/spend`);
      expect(r.status).toBe(500);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await r.text()).toBe("Server error");
      expect(said).toHaveBeenCalledTimes(1);
      expect(String(said.mock.calls[0]![0])).not.toContain("\n");
    } finally {
      said.mockRestore();
      server.stop(true);
      await hub.whenStopped();
      t.cleanup();
    }
  });

  test("the live stream starts with a snapshot of every section", async () => {
    await withConsole(async (base) => {
      const [first] = await sseFrames(`${base}/api/stream`, 1);
      expect(first!.data).toMatchObject({ type: "snapshot", meta: { chat: false }, sections: { changes: [{ slug: "one" }] } });
      expect(Number(first!.id)).toBeGreaterThan(0);
    });
  });

  test("a page that leaves the live stream lets the hub go", async () => {
    await withConsole(async (base, hub) => {
      const ac = new AbortController();
      const r = await fetch(`${base}/api/stream`, { signal: ac.signal });
      const reader = r.body!.getReader();
      await reader.read(); // the snapshot: the hub is running for this page
      expect(hub.latest()).not.toBeNull();
      ac.abort();
      await reader.cancel().catch(() => {});
      await until(() => hub.latest() === null);
      await hub.whenStopped();
    }, { intervalMs: 60_000, pingMs: 60_000 }); // no look or ping in the meantime finds the page gone by failing to write to it
  });

  test("a page opening a new stream names the newest event it saw in ?after=, and gets the ones it missed before its snapshot", async () => {
    await withConsole(async (base) => {
      const frames = await sseFrames(`${base}/api/stream?after=1`, 2);
      expect(frames.map((f) => (f.data as { type: string }).type)).toEqual(["event", "snapshot"]);
      expect((frames[0]!.data as { item: { text: string } }).item.text).toBe("Build passed ($0.10).");
      // The browser's own Last-Event-ID, sent when it reconnects by itself, is newer than the address it was opened with.
      const resumed = await sseFrames(`${base}/api/stream?after=1`, 1, { "last-event-id": frames[1]!.id! });
      expect((resumed[0]!.data as { type: string }).type).toBe("snapshot");
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

  // Bun drops a request after 10 s of silence by default, and git may take 30 s on a big diff. A real
  // 10 s wait would make the suite slow, so this checks the request that matters: that each JSON route
  // asks the server for a longer limit, longer than git's, before it starts work.
  test("the JSON routes ask for an idle limit above git's, and the files do not need one", async () => {
    const t = await seeded();
    const hub = new Hub(t.path);
    try {
      for (const path of ["/api/changes/one", "/api/changes/one/diff", "/api/events", "/api/spend"]) {
        const calls: Array<[Request, number]> = [];
        const req = new Request(`http://127.0.0.1${path}`);
        const res = await read(t.path, hub, req, new URL(req.url), { timeout: (r, s) => void calls.push([r, s]) });
        expect({ path, ok: res?.status, calls: calls.map(([r, s]) => [r === req, s]) }).toEqual({ path, ok: 200, calls: [[true, JSON_IDLE_SECONDS]] });
      }
      expect(JSON_IDLE_SECONDS).toBeGreaterThan(30);
    } finally {
      t.cleanup();
    }
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

/** A person on the plan gate, so Approve and Send back are theirs to give. */
const PEOPLE = "gates:\n  plan: { human: status }\n";

/**
 * A console on a git repository on main (applyRequests commits there) with change "a" at
 * plan-review. Stopped, and its hub let go, before the repository is removed.
 */
async function withRepoConsole(fn: (base: string, root: string) => Promise<void>) {
  const r = await chatRepo({ intents: { a: INTENT("plan-review", "a") }, config: PEOPLE });
  const hub = new Hub(r.root);
  const server = serveConsole(r.root, 0, { hub });
  try {
    await fn(`http://127.0.0.1:${server.port}`, r.root);
  } finally {
    server.stop(true);
    await until(() => hub.latest() === null);
    await hub.whenStopped();
    r.cleanup();
  }
}

async function applyAll(root: string): Promise<void> {
  const trace = Trace.open(root, () => {});
  try { await applyRequests(root, await loadConfig(root), trace); } finally { trace.close(); }
}

describe("writes", () => {
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });

  test("an action is submitted, followed and read once", async () => {
    await withRepoConsole(async (base, root) => {
      const r = await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" });
      expect(r.status).toBe(202);
      const { id, loop } = await r.json() as { id: string; loop: string };
      expect(loop).toBe("stopped");
      expect(pendingRequests(root).map((q) => [q.id, q.kind, q.via, q.transport])).toEqual([[id, "approve", "the dashboard", "console"]]);
      expect(await (await fetch(`${base}/api/requests/${id}`)).json()).toEqual({ state: "pending" });
      // The loop applies it.
      await applyAll(root);
      // Only GET reads a result: a HEAD would take it with no body to carry it.
      expect((await fetch(`${base}/api/requests/${id}`, { method: "HEAD" })).status).toBe(405);
      expect(await (await fetch(`${base}/api/requests/${id}`)).json()).toMatchObject({ state: "done", ok: true, status: "plan-approved" });
      expect((await fetch(`${base}/api/requests/${id}`)).status).toBe(404);
    });
  }, 30_000);

  test("an action the change does not offer now, or a status it is no longer at, is refused with plain words", async () => {
    await withRepoConsole(async (base) => {
      const stale = await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "spec-review" });
      expect(stale.status).toBe(409);
      expect((await stale.json() as { error: string }).error).toBe("a is plan-review now, not spec-review. The page shows it as it is now.");
      const wrong = await post(base, "/api/requests", { kind: "retry", slug: "a", expect: "plan-review", to: "accepted" });
      expect(wrong.status).toBe(409);
      expect((await post(base, "/api/requests", { kind: "approve", slug: "../x", expect: "plan-review" })).status).toBe(400);
      expect((await post(base, "/api/requests", { kind: "send-back", slug: "a", expect: "plan-review", note: "  " })).status).toBe(400);
      expect((await post(base, "/api/requests", { kind: "approve", slug: "nope", expect: "plan-review" })).status).toBe(404);
    });
  }, 30_000);

  test("an undo is taken only for the step that really happened last", async () => {
    await withRepoConsole(async (base, root) => {
      // Never approved: there is nothing to take back.
      expect((await post(base, "/api/requests", { kind: "undo", slug: "a", expect: "plan-review", to: "spec-review", note: "" })).status).toBe(409);
      await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" });
      await applyAll(root);
      expect((await post(base, "/api/requests", { kind: "undo", slug: "a", expect: "plan-approved", to: "plan-review", note: "" })).status).toBe(202);
    });
  }, 30_000);

  test("a waiting request can be cancelled once", async () => {
    await withRepoConsole(async (base) => {
      const { id } = await (await post(base, "/api/requests", { kind: "hold", slug: "a", expect: "plan-review", reason: "" })).json() as { id: string };
      const del = () => fetch(`${base}/api/requests/${id}`, { method: "DELETE", headers: { origin: base } });
      expect(await (await del()).json()).toEqual({ cancelled: true });
      expect((await del()).status).toBe(409);
    });
  }, 30_000);

  test("pause and resume the loop", async () => {
    await withRepoConsole(async (base, root) => {
      expect(await (await post(base, "/api/loop", { action: "pause" })).json()).toMatchObject({ held: { by: expect.any(String) } });
      expect(readLoopHold(root)).not.toBeNull();
      const stamp = wakeStamp(root);
      expect(await (await post(base, "/api/loop", { action: "resume" })).json()).toEqual({ held: null });
      expect(readLoopHold(root)).toBeNull();
      expect(wakeStamp(root)).not.toBe(stamp);
      expect((await post(base, "/api/loop", { action: "explode" })).status).toBe(400);
    });
  }, 30_000);

  test("a write from another origin, without JSON, or to another host name is refused", async () => {
    await withRepoConsole(async (base, root) => {
      expect((await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" }, { origin: "http://evil.example" })).status).toBe(403);
      expect((await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" }, { origin: "" })).status).toBe(403);
      expect((await fetch(`${base}/api/requests`, { method: "POST", headers: { origin: base, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await fetch(`${base}/api/requests`, { method: "POST", headers: { origin: base, "content-type": "text/plain; charset=application/json" }, body: "{}" })).status).toBe(415);
      expect((await fetch(`${base}/api/loop`, { method: "POST", headers: { origin: base, "content-type": "application/json", host: "evil.example" }, body: '{"action":"pause"}' })).status).toBe(403);
      expect((await fetch(`${base}/api/requests/000000000000001-1-0000`, { method: "DELETE", headers: { origin: "http://evil.example" } })).status).toBe(403);
      expect(readLoopHold(root)).toBeNull();
      expect(pendingRequests(root)).toEqual([]);
    });
  }, 30_000);
});
