import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyRequests } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { Hub, type HubOptions } from "../../src/console/hub";
import { JSON_IDLE_SECONDS, read, serveConsole } from "../../src/console/server";
import type { SessionMessage } from "../../src/console/types";
import { writeJson } from "../../src/fsutil";
import { localUser } from "../../src/chat/transports/shared";
import { readLoopHold, writeHeartbeat } from "../../src/heartbeat";
import { changeStoppedBy, inboxFor } from "../../src/inbox";
import { ui } from "../../src/commands/ui";
import { pendingRequests } from "../../src/requests";
import { requestStop, resetStop } from "../../src/stop";
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
    await server.stop(true);
    await until(() => hub.latest() === null);
    await hub.whenStopped();
    t.cleanup();
  }
}

describe("the console's server", () => {
  test("serves the page on every screen's path, with the scripts and styles it names", async () => {
    await withConsole(async (base) => {
      for (const path of ["/", "/inbox", "/changes", "/activity", "/agents", "/spend", "/c/one", "/c/one/code", "/s/one/1"]) {
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
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
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
      for (const path of ["/api/stream", "/api/agents/stream", "/api/sessions/one/1/stream", "/api/changes/one/diff"]) {
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
      await server.stop(true);
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

  test("a HEAD on a stream answers its headers, opens no stream and leaves no page connected", async () => {
    await withConsole(async (base, hub) => {
      for (const path of ["/api/stream", "/api/agents/stream", "/api/sessions/one/1/stream"]) {
        const r = await fetch(base + path, { method: "HEAD" });
        expect({ path, status: r.status, type: r.headers.get("content-type") }).toEqual({ path, status: 200, type: "text/event-stream; charset=utf-8" });
        expect(await r.text()).toBe("");
      }
      await Bun.sleep(100);
      expect(hub.latest()).toBeNull();
    }, { intervalMs: 60_000, pingMs: 60_000 });
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

  test("the agents stream answers with a sync when nothing runs", async () => {
    await withConsole(async (base) => {
      const frames = await sseFrames(`${base}/api/agents/stream`, 1);
      expect(frames.map((f) => f.data)).toEqual([{ type: "sync", keys: [] }]);
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

  test("a session's stream resumes at the start of the line a frame id names, from the header or the address", async () => {
    await withConsole(async (base) => {
      const url = `${base}/api/sessions/one/1/stream`;
      const all = await sseFrames(url, 5);
      const firstEnd = all[1]!.id!;
      // A row inside the second line has an id like "<its start>.<k>": the stream goes on from that start.
      const types = (frames: Awaited<ReturnType<typeof sseFrames>>) => frames.map((f) => { const m = f.data as SessionMessage; return m.type === "item" ? m.item.kind : m.type; });
      expect(types(await sseFrames(url, 4, { "last-event-id": `${firstEnd}.3` }))).toEqual(["phase", "result", "phase", "end"]);
      expect(types(await sseFrames(`${url}?from=${firstEnd}.3`, 4))).toEqual(["phase", "result", "phase", "end"]);
      expect(types(await sseFrames(`${url}?from=${firstEnd}`, 4))).toEqual(["phase", "result", "phase", "end"]);
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
      // Read fresh every time: a document the page reads again after the change moved on must not come from the browser's cache.
      for (const r of [doc, file, await fetch(`${base}/api/changes/one`), await fetch(`${base}/api/events`), await fetch(`${base}/api/spend`)]) {
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
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
    await server.stop(true);
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

  test("a result is read by the page's own fetch, not by another site's request, and no answer is cached", async () => {
    await withRepoConsole(async (base, root) => {
      const sent = await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" });
      expect(sent.headers.get("cache-control")).toBe("no-store");
      const { id } = await sent.json() as { id: string };
      // The address bar (no site) reads it; a pending result stays.
      const pending = await fetch(`${base}/api/requests/${id}`, { headers: { "sec-fetch-site": "none" } });
      expect({ status: pending.status, cache: pending.headers.get("cache-control") }).toEqual({ status: 200, cache: "no-store" });
      await applyAll(root);
      // An <img src> or a link on another site: the browser says where it comes from, and it is refused, so the result is still there for the page.
      for (const site of ["cross-site", "same-site"]) {
        const r = await fetch(`${base}/api/requests/${id}`, { headers: { "sec-fetch-site": site } });
        expect({ site, status: r.status }).toEqual({ site, status: 403 });
      }
      expect(await (await fetch(`${base}/api/requests/${id}`, { headers: { "sec-fetch-site": "same-origin" } })).json()).toMatchObject({ state: "done", ok: true });
      expect((await fetch(`${base}/api/requests/${id}`)).status).toBe(404);
      // The method is checked before the Origin: a GET of the collection is not a write that lacks one.
      expect((await fetch(`${base}/api/requests`)).status).toBe(405);
      expect((await fetch(`${base}/api/requests/${id}`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" })).status).toBe(405);
      const refused = await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" });
      expect({ status: refused.status, cache: refused.headers.get("cache-control") }).toEqual({ status: 409, cache: "no-store" });
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

  test("a priority is one of the priorities, or null for none stated (as an undo puts back); nothing else", async () => {
    await withRepoConsole(async (base, root) => {
      expect((await post(base, "/api/requests", { kind: "priority", slug: "a", expect: "plan-review", priority: "high" })).status).toBe(202);
      expect((await post(base, "/api/requests", { kind: "priority", slug: "a", expect: "plan-review", priority: null })).status).toBe(202);
      expect(pendingRequests(root).map((q) => (q.kind === "priority" ? q.priority : "?"))).toEqual(["high", null]);
      for (const bad of ["bogus", "", undefined, 3]) {
        const r = await post(base, "/api/requests", { kind: "priority", slug: "a", expect: "plan-review", priority: bad });
        expect({ bad, status: r.status }).toEqual({ bad, status: 400 });
      }
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

  test("a body over a megabyte is not read: the connection is dropped and nothing is written", async () => {
    await withRepoConsole(async (base, root) => {
      const body = { kind: "approve", slug: "a", expect: "plan-review", pad: "x".repeat(2 * 1024 * 1024) };
      const r = await post(base, "/api/requests", body).catch(() => null);
      expect(r === null || r.status >= 400).toBe(true);
      expect(pendingRequests(root)).toEqual([]);
      // The console is still there for the next, ordinary write.
      expect((await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" })).status).toBe(202);
    });
  }, 30_000);
});

/**
 * A console on a repository whose loop works on "d" (designing): its design session and its spec-check
 * run now (rows started since the heartbeat's tick); "q" (designing) has an open question, "a" none.
 */
async function withSteerConsole(fn: (base: string, root: string, seqs: { design: number; check: number; ended: number }) => Promise<void>) {
  const asking = INTENT("designing", "q").replace("status: designing", "status: designing\nquestion: open");
  const r = await chatRepo({ intents: { a: INTENT("plan-review", "a"), d: INTENT("designing", "d"), q: asking }, config: PEOPLE });
  const now = Date.now();
  writeHeartbeat(r.root, { pid: process.pid, startedAt: new Date(now - 600_000).toISOString(), lastTickAt: new Date(now - 20_000).toISOString(), lastBeatAt: new Date(now).toISOString(), current: { slug: "d" }, working: ["d"], stopping: false, stopped: false });
  const trace = Trace.open(r.root, () => {});
  const ended = trace.phaseStart("d", "intake", "agent");
  trace.phaseEnd("d", ended, { status: "success", costUsd: 0.1 });
  const design = trace.phaseStart("d", "design", "agent");
  const check = trace.phaseStart("d", "spec-check", "agent");
  trace.close();
  const hub = new Hub(r.root);
  const server = serveConsole(r.root, 0, { hub });
  try {
    await fn(`http://127.0.0.1:${server.port}`, r.root, { design, check, ended });
  } finally {
    await server.stop(true);
    await until(() => hub.latest() === null);
    await hub.whenStopped();
    r.cleanup();
  }
}

describe("steering", () => {
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });
  const holds = (root: string) => pendingRequests(root).filter((q) => q.kind === "hold");

  test("a message to a running work session lands in its inbox, by this machine's user, from the dashboard", async () => {
    await withSteerConsole(async (base, root, { design }) => {
      const r = await post(base, `/api/sessions/d/${design}/message`, { kind: "message", text: " Cover negatives. " });
      expect(r.status).toBe(202);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const { id } = await r.json() as { id: string };
      expect(inboxFor(root, "d", design)).toEqual([expect.objectContaining({ id, seq: design, kind: "message", text: "Cover negatives.", by: localUser(), via: "the dashboard" })]);
      expect((await post(base, `/api/sessions/d/${design}/message`, { kind: "redirect", text: "Use two steps." })).status).toBe(202);
      expect(inboxFor(root, "d", design).map((m) => m.kind)).toEqual(["message", "redirect"]);
      expect(holds(root)).toEqual([]);
      expect(changeStoppedBy(root, "d")).toBeNull();
    });
  }, 30_000);

  test("a check cannot be messaged; a session that is not running cannot be steered; a message is 1 to 4000 characters", async () => {
    await withSteerConsole(async (base, root, { design, check, ended }) => {
      const toCheck = await post(base, `/api/sessions/d/${check}/message`, { kind: "message", text: "hi" });
      expect(toCheck.status).toBe(409);
      expect((await toCheck.json() as { error: string }).error).toBe("Checks cannot be messaged. Approve or send back instead.");
      for (const [slug, seq] of [["d", ended], ["d", 99], ["a", design]] as const) {
        const r = await post(base, `/api/sessions/${slug}/${seq}/message`, { kind: "message", text: "hi" });
        expect({ slug, seq, status: r.status }).toEqual({ slug, seq, status: 409 });
        expect((await r.json() as { error: string }).error).toBe("That session is not running.");
      }
      for (const text of ["  ", "x".repeat(4001), 3]) {
        expect((await post(base, `/api/sessions/d/${design}/message`, { kind: "message", text })).status).toBe(400);
      }
      expect((await post(base, `/api/sessions/d/${design}/message`, { kind: "explode", text: "hi" })).status).toBe(400);
      expect((await post(base, `/api/sessions/D_x/${design}/message`, { kind: "message", text: "hi" })).status).toBe(404);
      expect(inboxFor(root, "d", design)).toEqual([]);
      expect(inboxFor(root, "d", check)).toEqual([]);
    });
  }, 30_000);

  test("stop on a running session, a check too, writes a stop and leaves a hold request", async () => {
    await withSteerConsole(async (base, root, { check }) => {
      const r = await post(base, `/api/sessions/d/${check}/message`, { kind: "stop" });
      expect(r.status).toBe(202);
      expect(inboxFor(root, "d", check)).toEqual([expect.objectContaining({ kind: "stop", text: "", by: localUser(), via: "the dashboard" })]);
      expect(holds(root)).toEqual([expect.objectContaining({ kind: "hold", slug: "d", expect: "designing", reason: "Stopped", via: "the dashboard", transport: "console" })]);
      // The change's stop too, so a stop that crosses into the next phase still lands.
      expect(changeStoppedBy(root, "d")).toBe(localUser());
    });
  }, 30_000);

  test("stopping a change stops every running session of it and leaves one hold; with nothing running it is refused", async () => {
    await withSteerConsole(async (base, root, { design, check }) => {
      const r = await post(base, "/api/changes/d/stop", {});
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ stopped: 2 });
      expect(inboxFor(root, "d", design).map((m) => m.kind)).toEqual(["stop"]);
      expect(inboxFor(root, "d", check).map((m) => m.kind)).toEqual(["stop"]);
      expect(holds(root)).toHaveLength(1);
      // Code phases read no inbox: the change's stop ends the step at its next phase.
      expect(changeStoppedBy(root, "d")).toBe(localUser());
      const idle = await post(base, "/api/changes/a/stop", {});
      expect(idle.status).toBe(409);
      expect((await idle.json() as { error: string }).error).toBe("Nothing of a is running.");
      expect((await post(base, "/api/changes/nope/stop", {})).status).toBe(404);
      expect(changeStoppedBy(root, "a")).toBeNull();
    });
  }, 30_000);

  test("an answer is taken while the change's question is open, and refused without one", async () => {
    await withSteerConsole(async (base, root) => {
      const ok = await post(base, "/api/requests", { kind: "answer", slug: "q", text: "Leave them out." });
      expect(ok.status).toBe(202);
      expect(pendingRequests(root).filter((x) => x.kind === "answer")).toEqual([expect.objectContaining({ slug: "q", text: "Leave them out.", via: "the dashboard" })]);
      expect((await post(base, "/api/requests", { kind: "answer", slug: "d", text: "Leave them out." })).status).toBe(409);
      expect((await post(base, "/api/requests", { kind: "answer", slug: "q", text: " " })).status).toBe(400);
      expect((await post(base, "/api/requests", { kind: "answer", slug: "q", text: "x".repeat(4001) })).status).toBe(400);
      // One naming the question it answers: taken while that question waits, refused once another does.
      const at = "2026-10-17T12:00:00.000Z";
      writeJson(join(root, ".loopstra", "runs", "q", "question.json"), { status: "designing", count: 1, open: { phase: "design", traceName: "design", seq: 3, sessionId: "s", text: "Archived too?", why: "", options: [], at } });
      expect((await post(base, "/api/requests", { kind: "answer", slug: "q", text: "Leave them out.", question: at })).status).toBe(202);
      expect(pendingRequests(root).filter((x) => x.kind === "answer").at(-1)).toMatchObject({ question: at });
      const changed = await post(base, "/api/requests", { kind: "answer", slug: "q", text: "Leave them out.", question: "2026-10-17T11:00:00.000Z" });
      expect(changed.status).toBe(409);
      expect((await changed.json() as { error: string }).error).toBe("q's question changed since; nothing changed. Read the new one.");
      expect((await post(base, "/api/requests", { kind: "answer", slug: "q", text: "Leave them out.", question: 5 })).status).toBe(400);
    });
  }, 30_000);

  test("every steering write refuses another origin and anything but JSON", async () => {
    await withSteerConsole(async (base, root, { design }) => {
      const writes: Array<[string, unknown]> = [
        [`/api/sessions/d/${design}/message`, { kind: "message", text: "hi" }],
        [`/api/sessions/d/${design}/message`, { kind: "stop" }],
        ["/api/changes/d/stop", {}],
        ["/api/requests", { kind: "answer", slug: "q", text: "yes" }],
      ];
      for (const [path, body] of writes) {
        expect({ path, status: (await post(base, path, body, { origin: "http://evil.example" })).status }).toEqual({ path, status: 403 });
        expect({ path, status: (await post(base, path, body, { origin: "" })).status }).toEqual({ path, status: 403 });
        const plain = await fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "text/plain" }, body: JSON.stringify(body) });
        expect({ path, status: plain.status }).toEqual({ path, status: 415 });
      }
      expect((await fetch(`${base}/api/changes/d/stop`)).status).toBe(405);
      expect(inboxFor(root, "d", design)).toEqual([]);
      expect(pendingRequests(root)).toEqual([]);
    });
  }, 30_000);
});

describe("loopstra ui", () => {
  test("a port that is in use is said in one line, with the way out, and nothing is started", async () => {
    const r = await chatRepo();
    const busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    const said = spyOn(console, "error").mockImplementation(() => {});
    const logged = spyOn(console, "log").mockImplementation(() => {});
    try {
      const port = busy.port!;
      expect(await ui(r.root, port, false)).toBe(1);
      expect(said.mock.calls.map((c) => String(c[0]))).toEqual([`Port ${port} is in use: pick another with --port <n>.`]);
      expect(logged).not.toHaveBeenCalled();
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("busy");
    } finally {
      said.mockRestore();
      logged.mockRestore();
      await busy.stop(true);
      resetStop();
      r.cleanup();
    }
  }, 30_000);

  test("ends on a stop request (Ctrl-C), with the console and its chat stopped", async () => {
    const r = await chatRepo();
    const said = spyOn(console, "log").mockImplementation(() => {});
    try {
      const done = ui(r.root, 0, true);
      await until(() => said.mock.calls.length > 0);
      const port = /127\.0\.0\.1:(\d+)/.exec(String(said.mock.calls[0]![0]))![1];
      requestStop();
      expect(await done).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      said.mockRestore();
      resetStop();
      r.cleanup();
    }
  }, 30_000);

  test("the first Ctrl-C says the console is stopping, not the loop's step", async () => {
    const r = await chatRepo();
    const said = spyOn(console, "log").mockImplementation(() => {});
    try {
      const done = ui(r.root, 0, false);
      await until(() => said.mock.calls.length > 0);
      process.emit("SIGINT", "SIGINT");
      expect(await done).toBe(0);
      expect(said.mock.calls.map((c) => String(c[0])).slice(1)).toEqual(["\nStopping the console. Press Ctrl-C again to exit at once."]);
    } finally {
      said.mockRestore();
      resetStop();
      r.cleanup();
    }
  }, 30_000);
});
