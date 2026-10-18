# Agents View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new console screen, Agents (`/agents`), showing every active agent as a tile with its live transcript and the controls to message, redirect, stop, answer and ask the orchestrator about it.

**Architecture:** One new SSE route, `/api/agents/stream`, follows every running change session (read from the hub's newest model) with the same per-session follower the session stream uses, tagging each message with `<slug>:<seq>`. The page keeps tile state in a pure module (`src/ui/agents.ts`) and draws a grid of tiles from it plus question tiles (from `changes`) and an orchestrator tile (the drawer's chat component). `Transcript` and `Steer` gain a `compact` mode.

**Tech Stack:** Bun (server, tests: `bun test`), TypeScript, Preact + @preact/signals, SSE.

Spec: `docs/superpowers/specs/2026-10-18-agents-view-design.md`.

**Notes for the engineer**
- Never run `python`/`python3` here (it is a Store stub that hangs). Use `bun`.
- Run one test file with `bun test tests/unit/<file>.test.ts --timeout 30000`. Run everything with `bun run test` (4 shards) and `bun run typecheck`.
- Code style: comments are full sentences in plain words, explaining why; match the surrounding files. Agent output is untrusted: never use `dangerouslySetInnerHTML` (the `Markdown` part already escapes).
- Windows CI is slow: tests wait for conditions with `until(...)`, never fixed sleeps.

---

## File structure

| File | Responsibility |
|---|---|
| `src/console/session.ts` (modify) | Split: `followSession` (follows one session, emits typed messages) and `streamSession` (frames them for `/api/sessions/<slug>/<seq>/stream`). |
| `src/console/types.ts` (modify) | `AgentMessage`, `agentKey`. |
| `src/console/agents.ts` (create) | `streamAgents`: the multiplexed stream. |
| `src/console/server.ts` (modify) | Route `/api/agents/stream`; serve the page on `/agents`. |
| `src/ui/agents.ts` (create) | Pure tile state: `apply`, `prune`, `slots`, `parseTarget`, `FADE_MS`. |
| `src/ui/transcript.ts` (modify) | `lastCost(shown)` (moved from `Session.tsx`). |
| `src/ui/diff.ts` (modify) | `diffCounts(text)`. |
| `src/ui/router.ts`, `src/ui/app.tsx`, `src/ui/parts/Rail.tsx`, `src/ui/parts/Icon.tsx`, `src/ui/shortcuts.ts`, `src/ui/parts/Palette.tsx` (modify) | The route, the rail item and badge, `g w`, the palette command. |
| `src/ui/parts/Transcript.tsx` (modify) | `compact` prop. |
| `src/ui/parts/Steer.tsx` (modify) | `compact` prop and `extra` slot. |
| `src/ui/parts/Drawer.tsx` (modify) | Export `Chat` with an `autoFocus` prop. |
| `src/ui/parts/AgentTile.tsx` (create) | Running/finished tile, question tile, orchestrator tile. |
| `src/ui/views/Agents.tsx` (create) | The grid, the stream, hash targeting. |
| `src/ui/views/Live.tsx` (modify) | Watch/Message link to `/agents#…`. |
| `src/ui/views/Session.tsx` (modify) | Use `lastCost` from `transcript.ts`. |
| `src/ui/theme.css` (modify) | Grid, tile, compact transcript, highlight, fade. |
| `tests/unit/console-agents.test.ts` (create) | `streamAgents`. |
| `tests/unit/console-server.test.ts`, `tests/unit/ui-logic.test.ts` (modify) | Route, page path, tile state, router, helpers. |
| `README.md`, spec (modify) | Docs. |

---

### Task 1: Split the session follower out of `streamSession`

**Files:**
- Modify: `src/console/session.ts`
- Test: `tests/unit/console-session.test.ts` (existing tests must pass unchanged; one new test)

- [ ] **Step 1: Write the failing test** — append inside `describe("a session's stream", ...)` in `tests/unit/console-session.test.ts`, and add `followSession` to the import from `../../src/console/session`:

```ts
  test("a follower gets the same messages as typed values, with each item's offset", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    let stop: (() => void) | null = null;
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", seq, "build"), lines([...START, ...REST]));
      trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
      const got: Array<{ msg: SessionMessage; offset?: number }> = [];
      let closed = false;
      stop = followSession(t.path, "one", seq, 0, (msg, offset) => { got.push({ msg, offset }); return true; }, () => { closed = true; }, 20);
      await until(() => closed);
      expect(got.map((g) => g.msg.type)).toEqual(["phase", "item", "item", "item", "item", "phase", "end"]);
      expect(got.filter((g) => g.msg.type === "item").every((g) => typeof g.offset === "number")).toBe(true);
      expect(got[0]!.offset).toBeUndefined();
    } finally {
      stop?.();
      trace.close();
      t.cleanup();
    }
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/console-session.test.ts --timeout 30000`
Expected: FAIL — `followSession` is not exported.

- [ ] **Step 3: Implement** — in `src/console/session.ts`, rename the body of `streamSession` into `followSession`, replacing every `send(frame(X, offset))` with `emit(X, offset)` and `send(frame(X))` with `emit(X)`; then define `streamSession` on top of it. The full new exports:

```ts
/** What a follower is told: one message, with an item's resume offset; false once whoever reads it is gone (it then stops). */
export type Emit = (msg: SessionMessage, offset?: number) => boolean;

/**
 * Follows one phase's transcript from byte `from`: first the phase, then each item with its offset
 * (see TranscriptReader.read). Checks the file every `intervalMs` (watching a growing file is
 * unreliable on Windows). Once the phase has ended and its file is read to the end, emits the phase
 * again and `end`, then calls `close`. If anything goes wrong it closes too, and never throws. Gives
 * the function that stops it, or null when there is no such phase (or the trace or the phase cannot
 * be read).
 */
export function followSession(root: string, slug: string, seq: number, from: number, emit: Emit, close: () => void, intervalMs = 250): (() => void) | null {
  // ...the existing body of streamSession, with these replacements:
  //   if (!send(frame({ type: "item", item } satisfies SessionMessage, offset)))  ->  if (!emit({ type: "item", item }, offset))
  //   send(frame(phaseMessage(p)));                                               ->  emit(phaseMessage(p));
  //   send(frame({ type: "end" } satisfies SessionMessage));                      ->  emit({ type: "end" });
  //   run(() => { send(frame(phaseMessage(first))); });                           ->  run(() => { emit(phaseMessage(first)); });
}

/**
 * Streams one phase's transcript to a page (see followSession), each item with its offset as the
 * frame's id, so a page that reconnects continues there.
 */
export function streamSession(root: string, slug: string, seq: number, from: number, send: Send, close: () => void, intervalMs = 250): (() => void) | null {
  return followSession(root, slug, seq, from, (msg, offset) => send(frame(msg, offset)), close, intervalMs);
}
```

Write the whole `followSession` body out (it is the current `streamSession` body with the four replacements above; nothing else changes). The `sent` helper becomes:

```ts
  const sent = (items: ReturnType<TranscriptReader["read"]>): boolean => {
    for (const { item, offset } of items) {
      if (!emit({ type: "item", item }, offset)) {
        stop();
        return false;
      }
    }
    return true;
  };
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/console-session.test.ts tests/unit/console-server.test.ts --timeout 30000`
Expected: PASS, all.

- [ ] **Step 5: Commit**

```bash
git add src/console/session.ts tests/unit/console-session.test.ts
git commit -m "refactor(console): followSession emits typed messages; streamSession frames them"
```

---

### Task 2: The agents stream

**Files:**
- Modify: `src/console/types.ts`
- Create: `src/console/agents.ts`
- Test: `tests/unit/console-agents.test.ts`

- [ ] **Step 1: Add the message type** — in `src/console/types.ts`, after `SessionMessage`:

```ts
/** A running session's key on the Agents screen. */
export const agentKey = (slug: string, seq: number): string => `${slug}:${seq}`;

/**
 * A message on /api/agents/stream: `open` when it starts following a running session, then that
 * session's own messages (see SessionMessage) with its key. `sync`, sent once after the first look,
 * names every session it follows, so a page that reconnected can tell which of its tiles ended
 * while it was away.
 */
export type AgentMessage =
  | { type: "open"; agent: RunningPhase }
  | { type: "sync"; keys: string[] }
  | (SessionMessage & { key: string });
```

- [ ] **Step 2: Write the failing test** — create `tests/unit/console-agents.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamAgents } from "../../src/console/agents";
import { Hub } from "../../src/console/hub";
import type { AgentMessage } from "../../src/console/types";
import { writeHeartbeat } from "../../src/heartbeat";
import { Trace } from "../../src/trace";
import { config, intent, parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

const lines = (events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const TEXT = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const RESULT = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, structured_output: { summary: "Done." } };

function raw(root: string, slug: string, seq: number, name: string): string {
  const dir = join(root, ".loopstra", "runs", slug, "phases", `${seq}-${name}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "raw.jsonl");
}

/** A repository whose loop is running and working on `slugs`, a minute into its tick. */
async function repo(slugs: string[]) {
  const t = tempDir();
  await config(t.path);
  for (const s of slugs) await intent(t.path, s, "status: building", `Title ${s}`);
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600_000), lastTickAt: iso(60_000), lastBeatAt: iso(0), current: { slug: slugs[0]! }, working: slugs, stopping: false, stopped: false });
  return t;
}

function page() {
  const frames: string[] = [];
  return { frames, send: (f: string) => { frames.push(f); return true; }, msgs: () => parseFrames(frames.join("")).map((f) => f.data as AgentMessage) };
}

describe("the agents stream", () => {
  test("announces each running session, sends its rows with its key, says when it ends, and stops everything when the page goes", async () => {
    const t = await repo(["one", "two"]);
    const trace = Trace.open(t.path);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    let stop: (() => void) | null = null;
    try {
      const one = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", one, "build"), lines([TEXT("Looking.")]));
      const p = page();
      stop = await streamAgents(t.path, hub, p.send, 20);
      const k1 = `one:${one}`;
      await until(() => p.msgs().some((m) => m.type === "item" && m.key === k1));
      const first = p.msgs();
      expect(first[0]).toMatchObject({ type: "open", agent: { slug: "one", seq: one, title: "Title one", name: "build" } });
      expect(first.find((m) => m.type === "sync")).toEqual({ type: "sync", keys: [k1] });
      expect(first.find((m) => m.type === "item")).toMatchObject({ type: "item", key: k1, item: { kind: "text", text: "Looking." } });

      // A second session starting later is announced too.
      const two = trace.phaseStart("two", "plan", "agent");
      writeFileSync(raw(t.path, "two", two, "plan"), lines([TEXT("Planning.")]));
      const k2 = `two:${two}`;
      await until(() => p.msgs().some((m) => m.type === "item" && m.key === k2));
      expect(p.msgs().filter((m) => m.type === "open").map((m) => (m as Extract<AgentMessage, { type: "open" }>).agent.slug)).toEqual(["one", "two"]);

      // The first ends: its last rows, its phase, then its end.
      appendFileSync(raw(t.path, "one", one, "build"), lines([RESULT]));
      trace.phaseEnd("one", one, { status: "success", costUsd: 0.1 });
      await until(() => p.msgs().some((m) => m.type === "end" && m.key === k1));
      const ofOne = p.msgs().filter((m) => "key" in m && m.key === k1).map((m) => m.type);
      expect(ofOne.slice(-3)).toEqual(["item", "phase", "end"]);
      // Announced once, however many looks saw it.
      expect(p.msgs().filter((m) => m.type === "open")).toHaveLength(2);

      stop();
      stop = null;
      const sent = p.frames.length;
      appendFileSync(raw(t.path, "two", two, "plan"), lines([TEXT("More.")]));
      await until(() => hub.latest() === null);
      expect(p.frames.length).toBe(sent);
    } finally {
      stop?.();
      await hub.whenStopped();
      trace.close();
      t.cleanup();
    }
  });

  test("a page that comes back is sent every running session again from its start, and sync names only those", async () => {
    const t = await repo(["one"]);
    const trace = Trace.open(t.path);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    const stops: Array<() => void> = [];
    try {
      const done = trace.phaseStart("one", "design", "agent");
      trace.phaseEnd("one", done, { status: "success", costUsd: 0.1 });
      const one = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", one, "build"), lines([TEXT("a"), TEXT("b")]));
      const first = page();
      stops.push(await streamAgents(t.path, hub, first.send, 20));
      await until(() => first.msgs().filter((m) => m.type === "item").length === 2);
      const again = page();
      stops.push(await streamAgents(t.path, hub, again.send, 20));
      await until(() => again.msgs().filter((m) => m.type === "item").length === 2);
      expect(again.msgs().find((m) => m.type === "sync")).toEqual({ type: "sync", keys: [`one:${one}`] });
    } finally {
      for (const s of stops) s();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      trace.close();
      t.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test tests/unit/console-agents.test.ts --timeout 30000`
Expected: FAIL — cannot find module `../../src/console/agents`.

- [ ] **Step 4: Implement** — create `src/console/agents.ts`:

```ts
import { frame, type Hub, type Send } from "./hub";
import { followSession } from "./session";
import { agentKey, type AgentMessage } from "./types";

/**
 * The Agents screen's stream: every running change session, each message tagged with the session's
 * key. It keeps the hub looking for as long as it is open (as a page that ignores the hub's frames)
 * and, every `intervalMs`, reads the running sessions from the hub's newest model. A session it has
 * not seen yet is announced with `open` and then followed to its end, the way its own session stream
 * would be (from its start, so a page that comes back gets every row again). After its first look it
 * sends `sync` with the keys it follows. Gives the function that stops it all, once the page is gone.
 */
export async function streamAgents(root: string, hub: Hub, send: Send, intervalMs = 250): Promise<() => void> {
  const followers = new Map<string, () => void>();
  const seen = new Set<string>();
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let off: (() => Promise<void>) | null = null;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    for (const unfollow of followers.values()) unfollow();
    followers.clear();
    void off?.();
  };
  /** Sends one message; false once the page is gone (everything is then stopped). */
  const out = (msg: AgentMessage): boolean => {
    if (done) return false;
    if (send(frame(msg))) return true;
    stop();
    return false;
  };
  const look = () => {
    for (const agent of hub.latest()?.sections.running.now ?? []) {
      const key = agentKey(agent.slug, agent.seq);
      if (done || seen.has(key)) continue;
      seen.add(key);
      if (!out({ type: "open", agent })) return;
      const unfollow = followSession(root, agent.slug, agent.seq, 0, (msg) => out({ ...msg, key }), () => followers.delete(key), intervalMs);
      // The hub saw it running, but its row is gone now: it can only have ended.
      if (!unfollow) out({ type: "end", key });
      else if (!done) followers.set(key, unfollow);
      else unfollow();
    }
  };
  off = await hub.connect(() => !done);
  look();
  out({ type: "sync", keys: [...seen] });
  if (!done) timer = setInterval(look, intervalMs);
  return stop;
}
```

- [ ] **Step 5: Run the test**

Run: `bun test tests/unit/console-agents.test.ts --timeout 30000`
Expected: PASS (both tests). If `title` is not "Title one", check `intent()`'s fourth argument sets the H1 the model reads titles from, and adjust the expectation to what `changes` shows for that intent.

- [ ] **Step 6: Commit**

```bash
git add src/console/types.ts src/console/agents.ts tests/unit/console-agents.test.ts
git commit -m "feat(console): one stream for every running agent, tagged by session"
```

---

### Task 3: Route the stream and the page

**Files:**
- Modify: `src/console/server.ts`
- Test: `tests/unit/console-server.test.ts`

- [ ] **Step 1: Write the failing tests** — in `tests/unit/console-server.test.ts`: add `"/agents"` to the path list in the test "serves the page on every screen's path…" (line ~59), add `"/api/agents/stream"` to the host-check list (line ~93, `for (const path of ["/api/stream", ...])`), and add this test in `describe("the console's server", ...)`:

```ts
  test("the agents stream answers with a sync when nothing runs", async () => {
    await withConsole(async (base) => {
      const frames = await sseFrames(`${base}/api/agents/stream`, 1);
      expect(frames.map((f) => f.data)).toEqual([{ type: "sync", keys: [] }]);
    });
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test tests/unit/console-server.test.ts --timeout 30000`
Expected: FAIL — `/agents` is 404 and the stream is not found.

- [ ] **Step 3: Implement** — in `src/console/server.ts`:

```ts
import { streamAgents } from "./agents";
```

In `routes`, add `"/agents": page` after `"/activity": page`. In `read`, after the `/api/stream` block:

```ts
  if (path === "/api/agents/stream") return sse(server, req, (send) => streamAgents(root, hub, send));
```

Update the `read` doc comment's route list to name `/api/agents/stream`.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/console-server.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/console/server.ts tests/unit/console-server.test.ts
git commit -m "feat(console): serve /agents and /api/agents/stream"
```

---

### Task 4: Tile state on the page

**Files:**
- Create: `src/ui/agents.ts`
- Modify: `src/ui/transcript.ts`, `src/ui/views/Session.tsx`
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing tests** — add to the imports of `tests/unit/ui-logic.test.ts`:

```ts
import { apply, FADE_MS, parseTarget, prune, slots, type Tile } from "../../src/ui/agents";
import type { AgentMessage, RunningPhase } from "../../src/console/types";
```

and change the `transcript` import to `import { addItems, EMPTY, lastCost } from "../../src/ui/transcript";`. Append:

```ts
describe("the agents screen's tiles", () => {
  const agent = (slug: string, seq: number, started = "2026-10-18T10:00:00.000Z"): RunningPhase => ({ slug, title: `T ${slug}`, seq, name: "build", model: null, started, now: "", strip: [], steerable: true });
  const open = (slug: string, seq: number): AgentMessage => ({ type: "open", agent: agent(slug, seq) });
  const text = (key: string, t: string): AgentMessage => ({ type: "item", key, item: { kind: "text", text: t } });
  const keys = (tiles: Tile[]) => tiles.map((x) => x.key);

  test("open adds a tile at the end; rows go to their tile; open again starts the tile over in its place", () => {
    let tiles = apply([], [open("a", 1), text("a:1", "x"), open("b", 2), text("b:2", "y"), text("a:1", "z")], 0);
    expect(keys(tiles)).toEqual(["a:1", "b:2"]);
    expect(tiles[0]!.shown.items).toEqual([{ kind: "text", text: "x" }, { kind: "text", text: "z" }]);
    tiles = apply(tiles, [open("a", 1), text("a:1", "again")], 5);
    expect(keys(tiles)).toEqual(["a:1", "b:2"]);
    expect(tiles[0]!.shown.items).toEqual([{ kind: "text", text: "again" }]);
    // Rows for a session the page never saw opened are dropped.
    expect(apply(tiles, [text("c:9", "?")], 6)).toBe(tiles);
  });

  test("a phase message is kept; end marks the tile ended; it stays FADE_MS, then goes", () => {
    let tiles = apply([], [open("a", 1), { type: "phase", key: "a:1", name: "build", status: "success", started: "s", ended: "e" }, { type: "end", key: "a:1" }], 1000);
    expect(tiles[0]!.phase?.status).toBe("success");
    expect(tiles[0]!.endedAt).toBe(1000);
    expect(prune(tiles, 1000 + FADE_MS - 1)).toBe(tiles);
    expect(prune(tiles, 1000 + FADE_MS)).toEqual([]);
  });

  test("sync ends the running tiles it does not name", () => {
    const tiles = apply([], [open("a", 1), open("b", 2), { type: "sync", keys: ["b:2"] }], 7);
    expect(tiles.map((x) => [x.key, x.endedAt])).toEqual([["a:1", 7], ["b:2", null]]);
  });

  test("slots: questions first, then tiles as they came, then the orchestrator; a change with a question shows no finished tile", () => {
    const tiles = apply([], [open("a", 1), open("b", 2), { type: "end", key: "a:1" }], 0);
    const q = { slug: "a", question: { text: "?", why: "", options: [], phase: "build", at: "t" } };
    const changes = [{ slug: "b", question: null }, q] as unknown as Parameters<typeof slots>[1];
    expect(slots(tiles, changes, true).map((s) => (s.kind === "agent" ? s.tile.key : s.kind === "question" ? `q:${s.change.slug}` : "chat"))).toEqual(["q:a", "b:2", "chat"]);
    expect(slots(tiles, null, false).map((s) => s.kind)).toEqual(["agent", "agent"]);
  });

  test("a link's target: a session, and whether to put the cursor in its box", () => {
    expect(parseTarget("#one:3")).toEqual({ key: "one:3", message: false });
    expect(parseTarget("#one:3:message")).toEqual({ key: "one:3", message: true });
    for (const bad of ["", "#", "#one", "#One:3", "#one:x", "#one:3:other"]) expect(parseTarget(bad)).toBeNull();
  });

  test("the cost a transcript's last result names", () => {
    expect(lastCost(EMPTY)).toBeNull();
    expect(lastCost(addItems(EMPTY, [{ kind: "result", ok: true, summary: "", costUsd: 0.5 }, { kind: "text", text: "after" }]))).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test tests/unit/ui-logic.test.ts --timeout 30000`
Expected: FAIL — module `src/ui/agents` not found.

- [ ] **Step 3: Move `costOfLastResult` into `src/ui/transcript.ts`** as `lastCost`:

```ts
/** The cost the newest result row names, or null when there is none (a chat turn has no change page to read it from). */
export function lastCost(shown: Shown): number | null {
  for (let k = shown.items.length - 1; k >= 0; k--) {
    const it = shown.items[k]!;
    if (it.kind === "result") return it.costUsd;
  }
  return null;
}
```

In `src/ui/views/Session.tsx`, delete `costOfLastResult`, import `lastCost` from `../transcript` (beside `addItems, EMPTY, type Shown`), and replace `costOfLastResult(shown)` with `lastCost(shown)`.

- [ ] **Step 4: Create `src/ui/agents.ts`**

```ts
import type { AgentMessage, ChangeSummary, RunningPhase, SessionMessage, TranscriptItem } from "../console/types";
import { agentKey, ANY_SLUG } from "../console/types";
import { addItems, EMPTY, type Shown } from "./transcript";

/** How long a finished session's tile stays, so it does not vanish while someone is typing to it. */
export const FADE_MS = 60_000;

/** One session on the Agents screen. `endedAt`: when the page heard it ended (ms), null while it runs. */
export interface Tile {
  key: string;
  agent: RunningPhase;
  shown: Shown;
  phase: Extract<SessionMessage, { type: "phase" }> | null;
  endedAt: number | null;
}

/** What the grid shows, in its order. */
export type Slot =
  | { kind: "question"; change: ChangeSummary }
  | { kind: "agent"; tile: Tile }
  | { kind: "chat" };

/**
 * `tiles` with `msgs` applied, at time `now`; `tiles` itself is left as it was, and comes back as it
 * was when nothing changed. Rows are gathered per tile and added in one go, since a session coming
 * back sends hundreds at once. A new session's tile goes at the end, so no tile moves under the
 * person; `open` for a known one starts its rows over (the stream sends them again from the start).
 */
export function apply(tiles: Tile[], msgs: AgentMessage[], now: number): Tile[] {
  let out = tiles;
  const pending = new Map<string, TranscriptItem[]>();
  const edit = (key: string, fn: (t: Tile) => Tile) => {
    const k = out.findIndex((t) => t.key === key);
    if (k < 0) return;
    if (out === tiles) out = [...tiles];
    out[k] = fn(out[k]!);
  };
  const flush = (key: string) => {
    const rows = pending.get(key);
    if (!rows) return;
    pending.delete(key);
    edit(key, (t) => ({ ...t, shown: addItems(t.shown, rows) }));
  };
  for (const m of msgs) {
    if (m.type === "open") {
      const key = agentKey(m.agent.slug, m.agent.seq);
      pending.delete(key);
      const fresh: Tile = { key, agent: m.agent, shown: EMPTY, phase: null, endedAt: null };
      if (out.some((t) => t.key === key)) edit(key, () => fresh);
      else out = [...out, fresh];
    } else if (m.type === "sync") {
      const live = new Set(m.keys);
      for (const t of out) if (t.endedAt === null && !live.has(t.key)) { flush(t.key); edit(t.key, (x) => ({ ...x, endedAt: now })); }
    } else if (m.type === "item") {
      if (!out.some((t) => t.key === m.key)) continue;
      pending.set(m.key, [...(pending.get(m.key) ?? []), m.item]);
    } else if (m.type === "phase") {
      flush(m.key);
      const { key: _key, ...phase } = m;
      edit(m.key, (t) => ({ ...t, phase }));
    } else if (m.type === "end") {
      flush(m.key);
      edit(m.key, (t) => (t.endedAt === null ? { ...t, endedAt: now } : t));
    }
  }
  for (const key of [...pending.keys()]) flush(key);
  return out;
}

/** `tiles` without the finished ones that have stayed FADE_MS; the same array when none has. */
export function prune(tiles: Tile[], now: number): Tile[] {
  const kept = tiles.filter((t) => t.endedAt === null || now - t.endedAt < FADE_MS);
  return kept.length === tiles.length ? tiles : kept;
}

/**
 * The grid in order: changes with a question first (they need a person), then the tiles as they
 * came, then the orchestrator when chat is on. A change waiting on its question has ended its session;
 * that finished tile is left out, so the change shows once.
 */
export function slots(tiles: Tile[], changes: ChangeSummary[] | null, chat: boolean): Slot[] {
  const asking = (changes ?? []).filter((c) => c.question);
  const asks = new Set(asking.map((c) => c.slug));
  return [
    ...asking.map((change): Slot => ({ kind: "question", change })),
    ...tiles.filter((t) => !(t.endedAt !== null && asks.has(t.agent.slug))).map((tile): Slot => ({ kind: "agent", tile })),
    ...(chat ? [{ kind: "chat" } as Slot] : []),
  ];
}

/** The tile a link points at (`#<slug>:<seq>`, or `#<slug>:<seq>:message` to put the cursor in its box), or null. */
export function parseTarget(hash: string): { key: string; message: boolean } | null {
  const m = hash.match(/^#([^:]+):(\d+)(:message)?$/);
  if (!m || !ANY_SLUG.test(m[1]!)) return null;
  return { key: agentKey(m[1]!, Number(m[2])), message: !!m[3] };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/ui-logic.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/agents.ts src/ui/transcript.ts src/ui/views/Session.tsx tests/unit/ui-logic.test.ts
git commit -m "feat(console): the agents screen's tile state"
```

---

### Task 5: Route, rail, key and palette

**Files:**
- Modify: `src/ui/router.ts`, `src/ui/app.tsx`, `src/ui/parts/Rail.tsx`, `src/ui/parts/Icon.tsx`, `src/ui/shortcuts.ts`, `src/ui/parts/Palette.tsx`
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing test** — in `describe("routes", ...)` add `expect(parseRoute("/agents")).toEqual({ name: "agents" });` and add `{ name: "agents" }` to the `all` list.

- [ ] **Step 2: Run to see it fail**

Run: `bun test tests/unit/ui-logic.test.ts --timeout 30000`
Expected: FAIL — `/agents` parses as missing.

- [ ] **Step 3: Implement**

`src/ui/router.ts`: add `| { name: "agents" }` to the first line of `Route`, and in `parseRoute` make the one-part list `(a === "inbox" || a === "changes" || a === "activity" || a === "agents" || a === "spend")`.

`src/ui/app.tsx`: `import { Agents } from "./views/Agents";` and `case "agents": return <Agents />;` after the activity case. (The view comes in Task 9; until then create `src/ui/views/Agents.tsx` with `export function Agents() { return <section class="view"><h1>Agents</h1></section>; }` so the page builds.)

`src/ui/parts/Icon.tsx`: add to the paths map, after `activity`:

```ts
  agents: "M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z",
```

`src/ui/parts/Rail.tsx`: add after the Activity entry:

```ts
  { href: "/agents", label: "Agents", icon: "agents", on: ["agents"] },
```

and inside the component, beside `agents`:

```ts
  const asking = changes.value?.filter((c) => c.question).length ?? 0;
```

(import `changes` from `../store`), and after the Live chip line:

```tsx
          {s.href === "/agents" && agents + asking > 0 && <span class={asking ? "count" : "chip"}>{agents + asking}</span>}
```

`src/ui/shortcuts.ts`: after the `g a` entry:

```ts
  { keys: "g w", action: "go:/agents", label: "Go to Agents" },
```

`src/ui/parts/Palette.tsx`: after the activity command:

```ts
    { id: "agents", title: "Go to Agents", hint: "g w", run: () => navigate("/agents") },
```

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts --timeout 30000 && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui
git commit -m "feat(console): the Agents screen's route, rail item, key and command"
```

---

### Task 6: A compact transcript

**Files:**
- Modify: `src/ui/diff.ts`, `src/ui/parts/Transcript.tsx`, `src/ui/theme.css`
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing test** — import `diffCounts` beside `parseDiff`, and add to `describe("diffs", ...)`:

```ts
  test("an edit's added and removed lines, as counts", () => {
    expect(diffCounts("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n")).toEqual({ added: 2, removed: 1 });
    expect(diffCounts("")).toEqual({ added: 0, removed: 0 });
  });
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test tests/unit/ui-logic.test.ts --timeout 30000`
Expected: FAIL — `diffCounts` not exported.

- [ ] **Step 3: Implement** — in `src/ui/diff.ts`:

```ts
/** How many lines a diff adds and removes. */
export function diffCounts(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of parseDiff(text)) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}
```

In `src/ui/parts/Transcript.tsx`:
- The props become `{ shown, live, done, compact = false }: { shown: Shown; live: boolean; done: boolean; compact?: boolean }`.
- The wrapper: `<div class={`transcript-wrap${compact ? " compact" : ""}`}>`.
- Pass `compact` to rows: `<Row ... compact={compact} />`; `Row` takes `compact: boolean` and passes it to `EditRow`.
- The jump button's words: `{compact ? "↓ live" : "Jump to live ↓"}`.
- `EditRow` takes `compact` and starts closed when compact, and shows the counts in its head:

```tsx
function EditRow({ item, result, compact }: { item: Extract<TranscriptItem, { kind: "edit" }>; result: Result; compact: boolean }) {
  // A small edit shows at once on the session's page; a whole written file, and any edit on a tile, waits to be opened.
  const [open, setOpen] = useState(!compact && item.tool !== "Write");
  const counts = compact ? diffCounts(item.diff) : null;
  return (
    <div class={`t-edit ${stateOf(result)}`}>
      <button class="t-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="t-state" aria-hidden="true" />
        <span class="t-name">{item.tool === "Write" ? "Wrote" : "Edited"}</span>
        <span class="t-target">{item.path}</span>
        {counts && <span class="t-counts"><span class="add">+{counts.added}</span> <span class="del">−{counts.removed}</span></span>}
      </button>
      {open && (
        <div class="t-body">
          <Diff text={item.diff} />
          {result && !result.ok && <Output text={result.output} />}
        </div>
      )}
    </div>
  );
}
```

(import `diffCounts` from `../diff`). In `src/ui/theme.css`, after the `.jump:hover` rule:

```css
.transcript-wrap.compact .transcript { height: 300px; max-height: none; padding-bottom: 8px; }
.transcript-wrap.compact .jump { right: 8px; bottom: 8px; }
.t-counts { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.t-counts .add { color: var(--ok); }
.t-counts .del { color: var(--bad); }
```

- [ ] **Step 4: Run tests and type check**

Run: `bun test tests/unit/ui-logic.test.ts --timeout 30000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/diff.ts src/ui/parts/Transcript.tsx src/ui/theme.css tests/unit/ui-logic.test.ts
git commit -m "feat(console): a compact transcript for tiles"
```

---

### Task 7: A compact steering box

**Files:**
- Modify: `src/ui/parts/Steer.tsx`, `src/ui/theme.css`

- [ ] **Step 1: Implement** — `Steer` takes `{ slug, seq, offer, compact = false, extra }: { slug: string; seq: number; offer: SteerOffer; compact?: boolean; extra?: ComponentChildren }` (import `type ComponentChildren` from `preact`, and add `inputRef` below). Keep every state and handler as it is. Replace the returned markup with:

```tsx
  const field = compact ? (
    <input
      ref={inputRef} type="text" value={text} maxLength={4000} disabled={stopping}
      placeholder="Tell the agent something"
      aria-label="Tell the agent something"
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void send("message"); } }}
    />
  ) : (
    <textarea
      value={text} maxLength={4000} disabled={stopping}
      placeholder="Tell the agent something. It reads it at its next step, and it is kept in conversation.md."
      aria-label="Tell the agent something"
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={(e) => { if (sendsMessage(e)) { e.preventDefault(); void send("message"); } }}
    />
  );
  return (
    <div ref={box} class={`panel steer${compact ? " compact" : ""}`} role="region" aria-label="Steer this session" tabIndex={-1}>
      {offer.message && !compact && field}
      <div class="steer-row">
        {offer.message && compact && field}
        {offer.message ? (
          <>
            <button type="button" class="btn primary" disabled={busy || stopping || !text.trim()} onClick={() => void send("message")}>{compact ? "Send" : "Send message"}</button>
            <button type="button" class="btn" disabled={busy || stopping || !text.trim()} title="The text replaces what the session was doing" onClick={() => void send("redirect")}>Redirect</button>
            {!compact && <span class="muted hide-narrow">{sendKey} sends the message</span>}
          </>
        ) : <span class="muted">{offer.note}</span>}
        {!compact && <span class="grow" />}
        {extra}
        {stopButtonEl}
      </div>
      {confirming && (
        <div class="control-form" role="group" aria-label="Confirm stopping" onKeyDown={escape}>
          <span>Stop this session? The change is held until someone releases it.</span>
          <button ref={confirmButton} type="button" class="btn danger" disabled={busy} onClick={() => void stop()}>Stop it</button>
          <button type="button" class="btn" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
```

`stopButtonEl`'s words become `{stopping ? "Stopping…" : compact ? "Stop" : "Stop session"}`. Add `const inputRef = useRef<HTMLInputElement>(null);` beside the other refs; it is not used further yet (the Agents view focuses the input by selector, see Task 9) — leave it out if the type check flags it unused.

In `src/ui/theme.css`, after `.steer-row`:

```css
.steer.compact { margin: 0; padding: 8px; gap: 6px; }
.steer.compact .steer-row { flex-wrap: nowrap; }
.steer.compact input[type="text"] { flex: 1; min-width: 0; }
@media (max-width: 520px) { .steer.compact .steer-row { flex-wrap: wrap; } }
```

- [ ] **Step 2: Type check and bundle**

Run: `bun run typecheck && bun test tests/unit/console-page.test.ts --timeout 30000`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/parts/Steer.tsx src/ui/theme.css
git commit -m "feat(console): a compact steering box for tiles"
```

---

### Task 8: The drawer's chat, reusable

**Files:**
- Modify: `src/ui/parts/Drawer.tsx`

- [ ] **Step 1: Implement** — export `Chat` and give it `autoFocus`:

```tsx
/**
 * The conversation with the orchestrator, in the drawer and on the Agents screen. One thread per tab,
 * so both show the same conversation. `autoFocus`: the cursor goes to the box when it opens; either
 * way it goes there when `about` changes to something.
 */
export function Chat({ about, autoFocus = true }: { about: About | null; autoFocus?: boolean }) {
```

and replace the focus effect with:

```tsx
  // The cursor is in the box when the drawer opens, and when a button elsewhere points it at another change or session.
  const opened = useRef(false);
  useEffect(() => {
    if (autoFocus || (opened.current && about)) box.current?.focus();
    opened.current = true;
  }, [about?.slug, about?.title, about?.seq]);
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/parts/Drawer.tsx
git commit -m "refactor(console): the drawer's chat can be shown elsewhere"
```

---

### Task 9: The tiles and the Agents screen

**Files:**
- Create: `src/ui/parts/AgentTile.tsx`
- Replace: `src/ui/views/Agents.tsx`
- Modify: `src/ui/theme.css`

- [ ] **Step 1: Create `src/ui/parts/AgentTile.tsx`**

```tsx
import type { ChangeSummary } from "../../console/types";
import type { Tile } from "../agents";
import type { About } from "../chat";
import { costSoFar, duration, shortModel, stepWord, usd } from "../format";
import { steerOffer } from "../requests";
import { meta, now } from "../store";
import { lastCost } from "../transcript";
import { Actions } from "./Actions";
import { Chat } from "./Drawer";
import { Icon } from "./Icon";
import { Link } from "./Link";
import { Steer } from "./Steer";
import { Transcript } from "./Transcript";

/** The element id of a tile, for links and focus. */
export const tileId = (key: string): string => `agent-${key.replace(":", "-")}`;

/** One session: its live transcript and its controls; once it has ended, greyed, with how it ended. `onAsk`: point the orchestrator at it (null when chat is off). */
export function AgentTile({ tile, onAsk }: { tile: Tile; onAsk: (() => void) | null }) {
  const t = now.value;
  const a = tile.agent;
  const ended = tile.endedAt !== null;
  const status = tile.phase?.status ?? "running";
  const offer = steerOffer(a.name, status, ended);
  const until = tile.phase?.ended ? Date.parse(tile.phase.ended) : ended ? tile.endedAt! : t;
  const rate = meta.value?.usdPerMinute;
  const cost = ended ? lastCost(tile.shown) : rate === undefined ? null : costSoFar(a.started, t, rate);
  return (
    <article id={tileId(tile.key)} class={`card tile${ended ? " ended" : " live"}`} aria-label={`${a.title}, ${a.name}`}>
      <div class="card-head">
        <Link href={`/c/${a.slug}`} class="card-title">{a.title}</Link>
        <span class="muted nowrap">› {a.name}{a.model ? ` · ${shortModel(a.model)}` : ""}</span>
        <span class="grow" />
        <span class="muted nowrap tabular">{duration(until - Date.parse(a.started))}{cost !== null ? ` · ${usd(cost, !ended)}` : ""}</span>
        <Link href={`/s/${a.slug}/${a.seq}`} class="ghost" title="Open the session's page"><Icon name="open" /></Link>
      </div>
      {!tile.shown.items.length && !ended
        ? <p class="muted tile-wait">Starting…</p>
        : <Transcript shown={tile.shown} live={!ended} done={ended} compact />}
      {ended ? (
        <p class="muted tile-end">{status === "running" ? "Ended" : stepWord(status)}</p>
      ) : offer && (
        <Steer slug={a.slug} seq={a.seq} offer={offer} compact
          extra={onAsk && <button type="button" class="btn" title="Ask the orchestrator about this agent" onClick={onAsk}><Icon name="chat" /></button>} />
      )}
    </article>
  );
}

/** A change whose agent asked a question: the question, and the Answer button (the inbox's form). */
export function QuestionTile({ change }: { change: ChangeSummary }) {
  const q = change.question!;
  return (
    <article class="card tile asks" aria-label={`${change.title} asks a question`}>
      <div class="card-head">
        <Link href={`/c/${change.slug}`} class="card-title">{change.title}</Link>
        <span class="muted nowrap">› {q.phase}</span>
        <span class="grow" />
        <span class="badge warn">Asks a question</span>
      </div>
      <div class="tile-question">
        <b>{q.text}</b>
        {q.why && <span class="muted">{q.why}</span>}
      </div>
      <Actions change={change} compact />
    </article>
  );
}

/** The orchestrator, with what a tile pointed it at. */
export function ChatTile({ about, label, onClear }: { about: About | null; label: string | null; onClear: () => void }) {
  return (
    <article id="agent-chat" class="card tile chat-tile" aria-label="The orchestrator">
      <div class="card-head">
        <b class="card-title">Orchestrator</b>
        <span class="grow" />
        {label && (
          <span class="chip">
            About {label}
            <button type="button" class="ghost" aria-label="Stop asking about this" onClick={onClear}><Icon name="close" /></button>
          </span>
        )}
      </div>
      {meta.value && !meta.value.chat ? <p class="muted">Chat is off in this console: it was started with --no-chat.</p> : <Chat about={about} autoFocus={false} />}
    </article>
  );
}
```

Check `src/ui/parts/Icon.tsx` for icons named `open` and `chat`; if either is missing, add one to its map (`open: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"`, `chat: "M4 5h16v11H9l-5 4z"`).

- [ ] **Step 2: Write `src/ui/views/Agents.tsx`**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentMessage } from "../../console/types";
import { apply, parseTarget, prune, slots, type Tile } from "../agents";
import type { About } from "../chat";
import { duration } from "../format";
import { AgentTile, ChatTile, QuestionTile, tileId } from "../parts/AgentTile";
import { changes, loop, meta, now } from "../store";

/** How long the page waits before opening the agents stream again after the browser gave up on it. */
const RETRY_MS = 2000;

export function Agents() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [down, setDown] = useState(false);
  const [about, setAbout] = useState<{ about: About; label: string } | null>(null);
  // The tile a link pointed at, until it has been shown (it may arrive after the page opens).
  const target = useRef(parseTarget(location.hash));

  useEffect(() => {
    let buffer: AgentMessage[] = [];
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setTiles((t) => apply(t, batch, Date.now()));
    };
    // Rows arrive in bursts; drawing them ten times a second keeps many sessions smooth.
    const timer = setInterval(flush, 100);
    const open = () => {
      const s = new EventSource("/api/agents/stream");
      source = s;
      s.onopen = () => setDown(false);
      s.onmessage = (ev) => {
        try { buffer.push(JSON.parse(ev.data as string) as AgentMessage); } catch { /* a bad frame is skipped */ }
      };
      s.onerror = () => {
        setDown(true);
        // The browser reconnects by itself unless it gave up; then the page opens a new stream.
        if (s.readyState === EventSource.CLOSED && !retry) retry = setTimeout(() => { retry = null; open(); }, RETRY_MS);
      };
    };
    open();
    return () => {
      clearInterval(timer);
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  const t = now.value;
  // Finished tiles leave after a while; read on the clock's tick, which redraws this screen anyway.
  useEffect(() => { setTiles((x) => prune(x, Date.now())); }, [t]);

  const chatOn = !!meta.value?.chat;
  const shown = slots(tiles, changes.value, chatOn);

  // Scrolls to the tile a link named once it is there, highlights it, and for Message puts the cursor in its box.
  useEffect(() => {
    const want = target.current;
    if (!want) return;
    const el = document.getElementById(tileId(want.key));
    if (!el) return;
    target.current = null;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
    if (want.message) el.querySelector<HTMLInputElement>(".steer input")?.focus();
  }, [shown.length, tiles]);

  const ask = (tile: Tile) => () => {
    const a = tile.agent;
    setAbout({ about: { slug: a.slug, title: a.title, seq: a.seq }, label: `${a.title} › ${a.name}` });
    document.getElementById("agent-chat")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const working = tiles.filter((x) => x.endedAt === null).length;
  const l = loop.value;
  return (
    <section class="view wide">
      <div class="view-head">
        <h1>Agents</h1>
        <span class="muted">{working ? `${working} ${working === 1 ? "agent is" : "agents are"} working` : ""}</span>
      </div>
      {down && <p class="muted" role="status">Reconnecting…</p>}
      {!working && !shown.some((s) => s.kind === "question") && (
        <div class="empty">No agent is working.{l?.nextCheck ? ` The next check is in ${duration(Math.max(0, Date.parse(l.nextCheck) - t))}.` : ""}</div>
      )}
      <div class="tiles">
        {shown.map((s) => s.kind === "question" ? <QuestionTile key={`q:${s.change.slug}`} change={s.change} />
          : s.kind === "agent" ? <AgentTile key={s.tile.key} tile={s.tile} onAsk={chatOn ? ask(s.tile) : null} />
          : <ChatTile key="chat" about={about?.about ?? null} label={about?.label ?? null} onClear={() => setAbout(null)} />)}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Styles** — append to `src/ui/theme.css` (after the `.card-foot` rule):

```css
.view.wide { max-width: none; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr)); gap: 14px; align-items: start; }
.tile { gap: 8px; min-width: 0; }
.tile .card-head { flex-wrap: wrap; }
.tile .nowrap { white-space: nowrap; }
.tile .tabular { font-variant-numeric: tabular-nums; }
.tile.ended { opacity: 0.6; transition: opacity var(--spring-time) var(--spring); }
.tile.asks { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.tile-question { display: grid; gap: 4px; }
.tile-wait, .tile-end { margin: 0; }
.tile.flash { box-shadow: 0 0 0 3px var(--ring); }
.chat-tile .chat-log { max-height: 300px; min-height: 120px; padding: 0; }
.chat-tile .chat-form { padding: 8px 0 0; }
```

- [ ] **Step 4: Type check, bundle, all UI tests**

Run: `bun run typecheck && bun test tests/unit/console-page.test.ts tests/unit/ui-logic.test.ts --timeout 30000`
Expected: PASS (the bundle stays under the page test's size limit; if it does not, report the size rather than raising the limit).

- [ ] **Step 5: Commit**

```bash
git add src/ui
git commit -m "feat(console): the Agents screen, a grid of steerable tiles"
```

---

### Task 10: Live points at the tiles

**Files:**
- Modify: `src/ui/views/Live.tsx`

- [ ] **Step 1: Implement** — in `AgentCard`, the footer's two links become:

```tsx
        {p.steerable && <Link href={`/agents#${p.slug}:${p.seq}:message`} class="link" title="Send this session a message from its tile">Message</Link>}
        <Link href={`/agents#${p.slug}:${p.seq}`} class="btn">Watch</Link>
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/views/Live.tsx
git commit -m "feat(console): Live's Watch and Message open the agent's tile"
```

---

### Task 11: Docs

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-18-agents-view-design.md`

- [ ] **Step 1: README** — in the console list, after the **Activity** bullet:

```markdown
- **Agents:** every active agent at once, a tile each: its live transcript (scroll up to read back), and a box to message, redirect or stop it without leaving the grid. Agents waiting on your answer come first, with Answer; a finished session stays a minute, greyed. The orchestrator has a tile too, and 💬 on an agent's tile asks it about that agent. Live's Watch and Message open the agent's tile; the tile's ⤢ opens its full session page.
```

In the Steering section, change "Open its session (from Live, or a change's timeline). Above the transcript is a box with three buttons:" to "Open its tile on Agents, or its session (from a tile, or a change's timeline). Each has a box with three buttons:". Add `G W` to any list of keys the README gives.

- [ ] **Step 2: Spec** — record the deviations: the orchestrator tile reuses the drawer's exported `Chat` (no `useChat` hook); the question tile links to the change, not the session; the agents stream sends `sync` (not event ids) so a page that came back ends the tiles of sessions that ended meanwhile; the agents stream sends no pings.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-18-agents-view-design.md
git commit -m "docs: the Agents screen"
```

---

### Task 12: Verify

- [ ] **Step 1:** `bun run typecheck` — no errors.
- [ ] **Step 2:** `bun run test` — every shard passes. Note the count.
- [ ] **Step 3:** Browser check: run the console against a repository with a fake loop (heartbeat working on two changes, two running phases whose `raw.jsonl` grows, one change with `question: open`), open `/agents`, and check: tiles appear, rows stream, the question tile is first, Message/Redirect/Stop from a tile write inbox files, 💬 tags the orchestrator tile, a phase ending greys its tile and it leaves after a minute, Live's Watch scrolls to and highlights the tile, the layout is one column at phone width.
