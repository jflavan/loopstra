# Console Part 2 (Controls) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person act on changes and on the loop from the console (and from chat): approve, send back with a note, retry, start, close, priority, hold and release a change, and pause or resume the loop, with every action applied by the loop itself.

**Architecture:** Every action is a JSON request file in `.loopstra/requests/` (the one way in, shared with chat). The loop applies requests through `commitRecord`, at the start of each tick and from a small applier that runs beside the tick every 2 s, so an action lands while steps run. Each request names the status the person saw (`expect`) and is refused when the change moved on. The console posts requests, follows their results for a toast with Undo, and shows pending ones. Pausing the loop is not a request: the console writes `.loopstra/hold.json`, and the tick starts no new step while it exists. A held change (`hold:` in its frontmatter) is skipped by the scheduler.

**Tech Stack:** Bun 1.4, TypeScript, zod, Preact 10 + @preact/signals (the console page), bun:test.

**Spec:** `docs/superpowers/specs/2026-10-17-console-design.md`, section "Part 2: Controls". Part 3 (steering, including "Stop session") is out of scope.

**Worktree:** `C:\Source\Repos\loopstra-controls`, branch `feat/console-controls` (made from `feat/console`, which holds Part 1). Run everything from that folder.

**Machine notes:** there is no usable Python on this machine (`python3` is the Microsoft Store stub and hangs forever). Never call python; use bun for any scripting. Tests: `bun test <file>` for one file, `bun run test` for everything (4 shards, about 4 minutes), `bun run typecheck`.

---

## Decisions made while planning (record them in docs/decisions.md in Task 18)

1. **Strict compare-and-swap only for status changes.** Approve, send back, retry, start, close and undo apply only when the status is still the one the person saw. Priority, hold and release apply to any open change (not done or closed) even if its status moved on meanwhile: a running change moves through statuses every few minutes, and refusing a hold because it went from designing to spec-review would be wrong. The request still carries `expect` for its wording.
2. **A request is claimed before it is applied.** The applier renames `<id>.json` into `.loopstra/requests/applying/` first. Cancelling (the console's Undo before the loop got to it) deletes `<id>.json`; once claimed, it can no longer be cancelled, and Undo sends the reverse request instead. This makes "Cancelled; nothing changed" always true.
3. **Requests wake the loop through a file.** `submitRequest` touches `.loopstra/wake`; the loop's sleep between ticks checks that file every second and starts the next tick at once. A wake during a tick makes the next sleep end at once. The approval is applied within about two seconds; its next step starts on the next tick (a tick waits for every lane, as before).
4. **Send back reaches the agent.** The note is written into `note:` (as the spec says) and also kept in the run folder (`.loopstra/runs/<slug>/sent-back.md`). The next spec or plan writing session gets it as findings to address, and the next build session gets it as `{{feedback}}`. It is removed once that session's work is saved.
5. **Undo exists for approve, send back, priority and hold.** Close asks for confirmation instead. Retry and start begin work at once, and release is undone by holding again. A pending request (not yet claimed) is cancelled. One already applied is reversed by an `undo` request (approve and send back), a `priority` request (the old priority) or a `release` request (hold).
6. **Retry offers what the block says.** A block's `status_change` event now carries `retry` (the status blockNote tells a person to set). Retry buttons are that status first, then every status the note names in a sentence about the status ("Set status to spec-approved to accept the spec as it is, or to accepted to write it again" offers both). Never draft, blocked, done or closed.
7. **Chat requests keep their own trace event.** Start and new-intent requests still trace `chat-request` (Activity and tests know it). The new kinds trace `request`.
8. **Console requests use transport `console`.** Chat's service never takes their results. The page reads its own result by id.

## File map

| File | What it does |
|---|---|
| `src/intents.ts` (modify) | `hold:` frontmatter field; `patchFrontmatter`/`writeIntent` can remove keys; held changes show in queue.md |
| `src/wake.ts` (create) | `.loopstra/wake`: `touchWake`, `wakeStamp` |
| `src/heartbeat.ts` (modify) | `.loopstra/hold.json` (the loop's pause): `readLoopHold`, `holdLoop`, `releaseLoop`, `loopHoldText`; `heartbeatState` shows it |
| `src/scheduler.ts` (modify) | skips held changes; starts no step while the loop is held; `sleepBetweenTicks` wakes on the wake file; runs the applier |
| `src/context.ts` (modify) | `statusPatch`, `retryTarget`, block's `retry` in the trace; the sent-back note in the run folder |
| `src/trace.ts` (modify) | `statusChange` takes extra payload fields; event type `request` |
| `src/actions.ts` (create) | pure rules: what each change offers, where each action takes it, retry targets, undo pairs, wording |
| `src/requests.ts` (create, from `src/chat/requests.ts`) | the request files: submit, pending, claim, cancel, results, old-folder drain, prune |
| `src/apply.ts` (create, from `src/chat/requests.ts`) | applying requests (every kind) and the applier beside the tick |
| `src/chat/requests.ts` (delete) | moved to the two files above |
| `src/stages/artifact.ts`, `src/stages/build.ts`, `src/prompts.ts`, `templates/prompts/build.md` (modify) | the sent-back note reaches the next writing or build session |
| `src/attention.ts` (modify) | "Held" items; the loop's pause |
| `src/console/types.ts`, `src/console/model.ts`, `src/console/detail.ts`, `src/console/hub.ts`, `src/console/describe.ts` (modify) | offers, held, pending requests, the loop's hold, Activity wording |
| `src/console/writes.ts` (create), `src/console/server.ts` (modify) | `POST/GET/DELETE /api/requests…`, `POST /api/loop` |
| `src/ui/requests.ts` (create) | the page's side of a request: send, follow the result, cancel, undo |
| `src/ui/store.ts`, `src/ui/parts/Toasts.tsx` (modify) | toasts with an action button and their own duration; `requests` signal |
| `src/ui/parts/Actions.tsx` (create), `src/ui/theme.css` (modify) | the buttons and their small forms |
| `src/ui/views/Change.tsx`, `src/ui/views/Inbox.tsx`, `src/ui/views/Changes.tsx`, `src/ui/parts/TopBar.tsx`, `src/ui/parts/Palette.tsx`, `src/ui/parts/Help.tsx` (modify) | where the controls appear |
| `src/chat/schemas.ts`, `src/chat/threads.ts`, `src/chat/orchestrator.ts`, `src/chat/publish.ts`, `src/chat/service.ts`, `templates/prompts/orchestrator.md` (modify) | chat proposes the same actions and submits them after a plain yes |
| docs (modify) | README, `templates/intent-README.md`, `templates/skill/SKILL.md`, `docs/decisions.md` |

---

### Task 1: `hold:` in intent.md, and removing a frontmatter line

**Files:**
- Modify: `src/intents.ts`
- Test: `tests/unit/intents-frontmatter.test.ts`, `tests/unit/intents-patch.test.ts`, `tests/unit/intents-queue.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/intents-frontmatter.test.ts` (add any import it lacks: `parseIntentFile` from `../../src/intents`):

```ts
describe("hold", () => {
  test("a hold line is read as plain text; blank or absent reads as no hold", () => {
    const held = parseIntentFile("---\nstatus: building\nhold: waiting for legal (John, the dashboard)\n---\n# Intent: x\n");
    expect(held.frontmatter.hold).toBe("waiting for legal (John, the dashboard)");
    expect(parseIntentFile("---\nstatus: building\nhold:\n---\n# Intent: x\n").frontmatter.hold).toBe("");
    expect(parseIntentFile("---\nstatus: building\n---\n# Intent: x\n").frontmatter.hold).toBe("");
  });
});
```

Append to `tests/unit/intents-patch.test.ts` (imports: `patchFrontmatter`, `writeIntent`, `readIntent` from `../../src/intents`; `tempDir` from `../helpers`; `join` from `node:path`; `mkdirSync` from `node:fs`):

```ts
describe("removing a line", () => {
  test("a removed key's line goes, with its comment and any lines it went on over; the rest stays as it was", () => {
    const raw = "---\nstatus: building # now\nhold: >-\n  waiting for\n  legal\npriority: high\n---\n# Intent: x\n";
    expect(patchFrontmatter(raw, {}, ["hold"])).toBe("---\nstatus: building # now\npriority: high\n---\n# Intent: x\n");
  });

  test("removing a key that is not there changes nothing; patch and remove together", () => {
    const raw = "---\r\nstatus: building\r\n---\r\nbody\r\n";
    expect(patchFrontmatter(raw, {}, ["hold"])).toBe(raw);
    expect(patchFrontmatter("---\nstatus: building\nhold: x\n---\n", { status: "closed" }, ["hold"])).toBe("---\nstatus: closed\n---\n");
  });

  test("writeIntent removes keys it is told to, and refuses when the status moved on", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "a"), { recursive: true });
      await Bun.write(join(t.path, "intent", "a", "intent.md"), "---\nstatus: building\nhold: x\n---\n# Intent: a\n");
      const i = await readIntent(t.path, "a");
      expect(await writeIntent(i, {}, { expectStatus: "reviewing", remove: ["hold"] })).toBe(false);
      expect(await writeIntent(i, {}, { expectStatus: "building", remove: ["hold"] })).toBe(true);
      expect(await Bun.file(join(t.path, "intent", "a", "intent.md")).text()).toBe("---\nstatus: building\n---\n# Intent: a\n");
      expect(i.file.frontmatter.hold).toBe("");
    } finally {
      t.cleanup();
    }
  });
});
```

Append to `tests/unit/intents-queue.test.ts` (it already builds intents; if it has no helper, add this one):

```ts
function held(slug: string, status: string, hold: string): Intent {
  return { slug, dir: "", artifacts: new Set(["intent.md", "spec.md", "plan.md"]), file: parseIntentFile(`---\nstatus: ${status}\nhold: ${JSON.stringify(hold)}\n---\n# Intent: ${slug}\n`) };
}

test("a held change is under Needs a person, and its note says it is held and why", () => {
  const q = renderQueue([held("a", "building", "waiting for legal (John, the dashboard)")]);
  const needs = q.slice(q.indexOf("## Needs a person"), q.indexOf("## Finished"));
  expect(needs).toContain("| a | normal | building and testing | Held: waiting for legal (John, the dashboard). |");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/intents-frontmatter.test.ts tests/unit/intents-patch.test.ts tests/unit/intents-queue.test.ts`
Expected: FAIL (`hold` is an unrecognized key; `patchFrontmatter` ignores a third argument; the queue has no held note).

- [ ] **Step 3: Implement**

In `src/intents.ts`:

1. In `Frontmatter`, after `resume_from`, add:

```ts
  /**
   * Optional: why the change is held. While it is set, the scheduler starts no step for the change.
   * Written by the runtime (a hold from the console or chat) or by a person; blank reads as absent.
   */
  hold: blankableString,
```

2. Give `patchFrontmatter` a third parameter and remove those keys' lines. Replace the function's signature and the start of its body, and add the removal pass inside the `else` branch, before the `for (const [key, value] of entries)` loop:

```ts
export function patchFrontmatter(raw: string, patch: Record<string, string>, remove: readonly string[] = []): string {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const text = raw.slice(bom.length);
  const parts = text.split(/(?<=\n)/);
  const content = (p: string) => p.replace(/\r?\n$/, "");
  const eol = /\r\n/.exec(text) ? "\r\n" : "\n";
  const entries = Object.entries(patch);
  if (!entries.length && !remove.length) return raw;

  const close = content(parts[0] ?? "").trimEnd() === "---" ? parts.findIndex((p, i) => i > 0 && content(p).trimEnd() === "---") : -1;
  let out: string;
  if (close < 0) {
    if (!entries.length) return raw;
    out = bom + ["---", ...entries.map(([k, v]) => `${k}: ${scalar(v)}`), "---"].join(eol) + eol + text;
  } else {
    const head = parts.slice(0, close);
    const tail = parts.slice(close);
    for (const key of remove) {
      const at = head.findIndex((p, i) => i > 0 && new RegExp(`^${key}\\s*:`).test(content(p)));
      if (at < 0) continue;
      // The key's line and any lines its value went on over (a block or folded scalar).
      let end = at + 1;
      while (end < head.length && /^(\s+\S|\s*$)/.test(content(head[end]!))) end++;
      while (end > at + 1 && !content(head[end - 1]!).trim()) end--;
      head.splice(at, end - at);
    }
    for (const [key, value] of entries) {
```

Keep the rest of the `for` loop and the function as they are, but change the end so the check covers removed keys and the fallback drops them:

```ts
  if (patched(out, patch, remove)) return out;
  // Fallback: rewrite the whole frontmatter from what the file says, with the patch on top.
  const file = parseIntentFile(raw);
  const merged: Record<string, unknown> = { ...file.frontmatter, ...patch };
  for (const key of remove) delete merged[key];
  const next = Frontmatter.parse(merged);
  return serializeIntentFile({ ...file, frontmatter: next });
}

/** True when `text` parses, has every patched value, and has no value left for a removed key. */
function patched(text: string, patch: Record<string, string>, remove: readonly string[] = []): boolean {
  try {
    const fm = parseIntentFile(text).frontmatter as Record<string, unknown>;
    return Object.entries(patch).every(([k, v]) => (fm[k] ?? "") === v) && remove.every((k) => (fm[k] ?? "") === "");
  } catch {
    return false;
  }
}
```

3. `writeIntent` takes `remove`:

```ts
export async function writeIntent(intent: Intent, patch: Partial<Frontmatter>, opts: { expectStatus?: Status; remove?: Array<keyof Frontmatter> } = {}): Promise<boolean> {
  const path = join(intent.dir, "intent.md");
  const onDisk = existsSync(path) ? await Bun.file(path).text() : serializeIntentFile(intent.file);
  if (opts.expectStatus !== undefined && parseIntentFile(onDisk).frontmatter.status !== opts.expectStatus) return false;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) values[k] = String(v);
  const text = patchFrontmatter(onDisk, values, opts.remove ?? []);
  await Bun.write(path, text);
  intent.file = parseIntentFile(text);
  return true;
}
```

Update the doc comment above `writeIntent`: "With `remove`, those keys' lines are taken out."

4. Held changes in the queue. Add this helper near `shownNote` and use it there:

```ts
/** "Held: <why>." for a held change, or "". */
export function heldNote(intent: Intent): string {
  const hold = intent.file.frontmatter.hold.trim();
  return hold ? `Held: ${hold.replace(/[.\s]+$/, "")}.` : "";
}

/** The note shown for a change: that it is held, why it waits for others, then its own note. */
export function shownNote(intent: Intent, intents: Intent[], heldBy?: string): string {
  return [heldNote(intent), waitNote(intent, intents, heldBy), intent.file.frontmatter.note].filter(Boolean).join(" ");
}
```

In `renderQueue`, a held change that is not finished needs a person:

```ts
  const waiting = ordered.filter((i) => !finished.includes(i) && (waitsForPerson(i, human) || !!i.file.frontmatter.hold.trim()));
```

- [ ] **Step 4: Run them to see them pass, then the type check**

Run: `bun test tests/unit/intents-frontmatter.test.ts tests/unit/intents-patch.test.ts tests/unit/intents-queue.test.ts && bun run typecheck`
Expected: PASS, and the type check is clean. If another test builds a `Frontmatter` literal by hand and the type check now wants `hold`, add `hold: ""` there.

- [ ] **Step 5: Commit**

```bash
git add src/intents.ts tests/unit/intents-frontmatter.test.ts tests/unit/intents-patch.test.ts tests/unit/intents-queue.test.ts
git commit -m "feat(intents): a hold line, and frontmatter lines that can be removed"
```

---

### Task 2: the loop's pause file, and the wake file

**Files:**
- Create: `src/wake.ts`
- Modify: `src/heartbeat.ts`
- Test: `tests/unit/heartbeat.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/heartbeat.test.ts` (imports as needed: `holdLoop`, `readLoopHold`, `releaseLoop`, `loopHoldText`, `heartbeatState` from `../../src/heartbeat`; `touchWake`, `wakeStamp` from `../../src/wake`; `tempDir` from `../helpers`):

```ts
describe("the loop's pause by a person", () => {
  test("hold, read, release; releasing twice is fine", () => {
    const t = tempDir();
    try {
      expect(readLoopHold(t.path)).toBeNull();
      const h = holdLoop(t.path, "John");
      expect(readLoopHold(t.path)).toEqual(h);
      expect(h.by).toBe("John");
      expect(loopHoldText(h)).toBe("Paused by John: running steps finish, nothing new starts.");
      expect(releaseLoop(t.path)).toBe(true);
      expect(releaseLoop(t.path)).toBe(false);
      expect(readLoopHold(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a running loop that is held reads paused and still lists what it works on; a stopped one says what its next start does", () => {
    const now = new Date("2026-10-17T10:00:00Z");
    const beat = { pid: process.pid, startedAt: "2026-10-17T09:00:00Z", lastTickAt: "2026-10-17T09:59:50Z", lastBeatAt: "2026-10-17T09:59:58Z", current: { slug: "a" }, working: ["a"], stopping: false, stopped: false };
    const hold = { by: "John", at: "2026-10-17T09:59:00Z" };
    const held = heartbeatState(beat, 60, now, { pause: null, hold });
    expect(held).toEqual({ state: "paused", text: "Paused by John: running steps finish, nothing new starts.", working: [{ slug: "a" }] });
    const stopped = heartbeatState({ ...beat, stopped: true }, 60, now, { pause: null, hold });
    expect(stopped.state).toBe("stopped");
    expect(stopped.text).toEndWith("Paused by John: the next start starts nothing until it is resumed.");
  });
});

describe("the wake file", () => {
  test("each touch changes the stamp; no file is an empty stamp", () => {
    const t = tempDir();
    try {
      expect(wakeStamp(t.path)).toBe("");
      touchWake(t.path);
      const a = wakeStamp(t.path);
      touchWake(t.path);
      expect(a).not.toBe("");
      expect(wakeStamp(t.path)).not.toBe(a);
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/heartbeat.test.ts`
Expected: FAIL (the functions do not exist).

- [ ] **Step 3: Implement**

Create `src/wake.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `.loopstra/wake`: written whenever someone asks the loop for something (a request, a resume). The
 * loop's sleep between ticks checks it every second and starts the next tick as soon as it changes.
 */
export function wakePath(root: string): string {
  return join(root, ".loopstra", "wake");
}

let touches = 0;

/** Asks the loop to start its next tick now. Never throws: without the file the loop starts on its poll as before. */
export function touchWake(root: string): void {
  try {
    mkdirSync(dirname(wakePath(root)), { recursive: true });
    writeFileSync(wakePath(root), `${Date.now()}-${process.pid}-${touches++}`);
  } catch { /* the loop's own poll still comes */ }
}

/** What the wake file says now ("" when there is none); a change means someone woke the loop. */
export function wakeStamp(root: string): string {
  try { return readFileSync(wakePath(root), "utf8"); } catch { return ""; }
}
```

In `src/heartbeat.ts`, add after the `Pause` functions (before `clockText` is fine; it needs `writeFileAtomic`, already imported):

```ts
/**
 * The loop paused by a person, `.loopstra/hold.json` (`{ by, at }`). While it exists the tick
 * starts no new step; running steps and the pull request watcher finish what they are doing. It
 * is not the outage pause (paused.json) and never clears by itself.
 */
export interface LoopHold { by: string; at: string }

function loopHoldPath(root: string): string {
  return join(root, ".loopstra", "hold.json");
}

/** The person's pause, or null. */
export function readLoopHold(root: string): LoopHold | null {
  try {
    const h = JSON.parse(readFileSync(loopHoldPath(root), "utf8")) as LoopHold;
    return typeof h?.by === "string" && typeof h.at === "string" ? h : null;
  } catch {
    return null;
  }
}

/** Pauses the loop for `by` (whole file, temp then rename). */
export function holdLoop(root: string, by: string, now: Date = new Date()): LoopHold {
  const hold: LoopHold = { by, at: now.toISOString() };
  writeFileAtomic(loopHoldPath(root), JSON.stringify(hold, null, 2));
  return hold;
}

/** Ends the person's pause; false when there was none. */
export function releaseLoop(root: string): boolean {
  const had = readLoopHold(root) !== null;
  rmSync(loopHoldPath(root), { force: true });
  return had;
}

/** The loop line while a person has paused it. */
export function loopHoldText(h: LoopHold): string {
  return `Paused by ${h.by}: running steps finish, nothing new starts.`;
}
```

Give `heartbeatState` the hold. Change its `opts` type to `{ pause?: Pause | null; hold?: LoopHold | null; alive?: (pid: number) => boolean }`, then:
- in `stopped(text)`, after the `waits` part, append ` Paused by ${hold.by}: the next start starts nothing until it is resumed.` when `opts.hold` is set (the text before it ends with "." when `waits` is set; when it is not, add a "." first so the line reads "Stopped. Paused by John: …" or "Stopped — last check 3 min ago. Paused by John: …");
- after the `pausedUntil` line (the outage pause wins, since nothing runs then), add:

```ts
  if (opts.hold) return { state: "paused", text: loopHoldText(opts.hold), working: workingOf(hb) };
```

Pass the hold where the loop line is read:
- `loopStatusLine` in `src/heartbeat.ts`: `{ pause: readPause(root), hold: readLoopHold(root) }`;
- `loopNow` in `src/console/model.ts`: `{ pause: readPause(root), hold: readLoopHold(root) }` (import `readLoopHold`);
- `loopWhen` in `src/chat/orchestrator.ts`: the same, and, before its last line, `if (loop.state === "paused" && hold) return \`The loop is paused by ${hold.by}; it ${what} once it is resumed. I will say here when it has.\`` where `const hold = readLoopHold(this.root)` is read once at the top.

- [ ] **Step 4: Run them to see them pass, then the type check**

Run: `bun test tests/unit/heartbeat.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/wake.ts src/heartbeat.ts src/console/model.ts src/chat/orchestrator.ts tests/unit/heartbeat.test.ts
git commit -m "feat(loop): a pause a person sets, and a file that wakes the loop"
```

---

### Task 3: the scheduler skips held changes, honours the loop's pause, and wakes early

**Files:**
- Modify: `src/scheduler.ts`
- Test: `tests/integration/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Look at the top of `tests/integration/scheduler.test.ts` to see how it makes a repository with intents and runs `tick` (it uses `setupRepo` / `copyRepo` from `tests/helpers.ts` and the fake claude). Add, in the same style (the `setupRepo(status)` helper makes a repo with change `add-numbers` at that status):

```ts
describe("holds", () => {
  test("a held change gets no step; released, it runs again", async () => {
    const repo = await setupRepo("accepted");
    try {
      const path = join(repo.path, "intent", "add-numbers", "intent.md");
      await Bun.write(path, (await Bun.file(path).text()).replace("status: accepted", "status: accepted\nhold: waiting for legal"));
      await run(["git", "commit", "-qam", "hold it"], repo.path);
      const r = await tick(repo.path);
      expect(r.steps ?? []).toEqual([]);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("accepted");
      await Bun.write(path, (await Bun.file(path).text()).replace("hold: waiting for legal\n", ""));
      await run(["git", "commit", "-qam", "release it"], repo.path);
      const again = await tick(repo.path);
      expect(again.picked).toBe("add-numbers");
    } finally {
      repo.cleanup();
    }
  });

  test("while a person has paused the loop, the tick starts no step and says so", async () => {
    const repo = await setupRepo("accepted");
    try {
      holdLoop(repo.path, "John");
      const r = await tick(repo.path);
      expect(r.paused).toBe("Paused by John: running steps finish, nothing new starts.");
      expect(r.steps).toBeUndefined();
      releaseLoop(repo.path);
      expect((await tick(repo.path)).picked).toBe("add-numbers");
    } finally {
      repo.cleanup();
    }
  });
});

describe("sleeping between ticks", () => {
  test("ends at once when the wake file changed since the tick began, early when it changes, else at the timeout", async () => {
    const t = tempDir();
    try {
      const seen = wakeStamp(t.path);
      touchWake(t.path);
      expect(await sleepBetweenTicks(t.path, 60_000, seen, 20)).toBe("woken");
      const now = wakeStamp(t.path);
      setTimeout(() => touchWake(t.path), 50);
      const t0 = Date.now();
      expect(await sleepBetweenTicks(t.path, 60_000, now, 20)).toBe("woken");
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(await sleepBetweenTicks(t.path, 30, wakeStamp(t.path), 10)).toBe("timeout");
    } finally {
      t.cleanup();
    }
  });
});
```

Imports to add: `holdLoop`, `releaseLoop` from `../../src/heartbeat`; `touchWake`, `wakeStamp` from `../../src/wake`; `sleepBetweenTicks` from `../../src/scheduler`; `readIntent` from `../../src/intents`; `run`, `tempDir`, `setupRepo` from `../helpers` (whichever the file does not import yet). If `setupRepo`'s intent text has no `status: accepted` line exactly, read the file first and adapt the `replace` to what is there.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/integration/scheduler.test.ts -t "holds|sleeping"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/scheduler.ts`:

1. Imports: add `readLoopHold`, `loopHoldText` to the `./heartbeat` import, and `import { wakeStamp } from "./wake";`.

2. A held change is never a lane's or the watcher's. Change `forLane` and the watcher's `watching`:

```ts
/** True when a change is a lane's to run now: runnable, not held, and (with a remote) not watching its pull request. */
function forLane(i: Intent, human: HumanGates, hasRemote: boolean): boolean {
  return isRunnable(i, human, hasRemote) && !held(i) && !(hasRemote && WATCHING_PR.has(i.file.frontmatter.status));
}

/** A person (or chat) has put the change on hold (`hold:` in intent.md): no step starts for it. */
function held(i: Intent): boolean {
  return i.file.frontmatter.hold.trim() !== "";
}
```

and in `watchOnce`:

```ts
  const watching = (i: Intent) => WATCHING_PR.has(i.file.frontmatter.status) && isRunnable(i, human, true) && !held(i);
```

3. The loop's pause. In `tick`, right after `heartbeatDayPause(root, null);` (the line after the day-budget block), add:

```ts
    // A person paused the loop (.loopstra/hold.json): nothing new starts until they resume it.
    const loopHold = readLoopHold(root);
    if (loopHold) {
      out.paused = loopHoldText(loopHold);
      trace.eventOnChange("_loop", "pause", "", { reason: out.paused, held: true }, "reason");
      return out;
    }
```

In `runLane`, the first line of the loop becomes `if (shared.halt || stopRequested() || readLoopHold(root)) return [];`. In `watchOnce`, `if (shared.halt || stopRequested()) return false;` becomes `if (shared.halt || stopRequested() || readLoopHold(root)) return false;`. (A pause set during the tick lets running steps finish and starts nothing more.)

4. Sleeping between ticks. Add, next to `sleepUnlessStopped`:

```ts
/**
 * The loop's wait between ticks: up to `ms`, ending early on a stop or when `.loopstra/wake` no
 * longer says `seen` (someone asked for something: a request, a resume). `seen` is read when the
 * tick began, so a wake during the tick ends this wait at once. Checks the file every `checkMs`.
 */
export async function sleepBetweenTicks(root: string, ms: number, seen: string, checkMs = 1000): Promise<"woken" | "timeout" | "stop"> {
  if (wakeStamp(root) !== seen) return "woken";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check: ReturnType<typeof setInterval> | undefined;
  try {
    return await Promise.race([
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); }),
      stopPromise().then(() => "stop" as const),
      new Promise<"woken">((resolve) => { check = setInterval(() => { if (wakeStamp(root) !== seen) resolve("woken"); }, checkMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(check);
  }
}
```

In `start`, read the stamp as each tick begins and sleep with it. Inside the `for (;;)`, before `beat.tickStarted();` add `const seen = wakeStamp(root);`, and replace `await sleepUnlessStopped(poll * 1000);` with `await sleepBetweenTicks(root, poll * 1000, seen);`.

- [ ] **Step 4: Run them to see them pass**

Run: `bun test tests/integration/scheduler.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/integration/scheduler.test.ts
git commit -m "feat(scheduler): skip held changes, honour a person's pause, wake on request"
```

---

### Task 4: a block records which status retries it; `statusPatch` for everyone

**Files:**
- Modify: `src/context.ts`, `src/trace.ts`
- Test: `tests/unit/context.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/context.test.ts` (it already has `setupRepo`/`openRepo` style helpers; use them; `block` from `../../src/context`):

```ts
describe("the retry status of a block", () => {
  test("the block's status_change carries the status its note tells a person to set", async () => {
    const repo = await setupRepo("plan-approved");
    try {
      const { ctx, trace } = await openRepo(repo.path);
      await block(ctx, "The build broke.");
      const e = trace.lastEvent("add-numbers", "status_change")!;
      expect(JSON.parse(e.payload)).toMatchObject({ from: "plan-approved", to: "blocked", retry: "plan-approved" });
      trace.close();
    } finally {
      repo.cleanup();
    }
  });

  test("a note that already says what to set gives no retry of its own", async () => {
    const repo = await setupRepo("plan-approved");
    try {
      const { ctx, trace } = await openRepo(repo.path);
      await block(ctx, "Set status to accepted to write it again.");
      const p = JSON.parse(trace.lastEvent("add-numbers", "status_change")!.payload) as { retry?: string };
      expect(p.retry).toBeUndefined();
      trace.close();
    } finally {
      repo.cleanup();
    }
  });

  test("statusPatch keeps resume_from on the approved state", () => {
    expect(statusPatch("plan-review", "plan-approved", "")).toEqual({ status: "plan-approved", note: "", resume_from: "plan-approved" });
    expect(statusPatch("plan-approved", "building", "x")).toEqual({ status: "building", note: "x", resume_from: "plan-approved" });
    expect(statusPatch("building", "blocked", "y")).toEqual({ status: "blocked", note: "y" });
  });
});
```

(Import `statusPatch` from `../../src/context`. If `setupRepo` in this file takes other arguments, match them.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/context.test.ts -t "retry status"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/trace.ts`: `statusChange` takes more payload fields, and `request` is an event type:

```ts
  statusChange(slug: string, from: string, to: string, note = "", extra: Record<string, unknown> = {}): void {
    this.event(slug, "status_change", { from, to, note, ...extra });
  }
```

and add `| "request"` to `EventType` (after `"chat-pr"`).

`src/context.ts`:

```ts
/**
 * The frontmatter a status change writes: the status, the note, and resume_from following the
 * approved state (entered, or being left). The runtime's steps and the requests people make both use it.
 */
export function statusPatch(from: Status, to: Status, note: string): Partial<Frontmatter> {
  const patch: Partial<Frontmatter> = { status: to, note };
  // resume_from always follows the approved state being left, even if it was already set:
  // a person may have set an approved status by hand, and the marker must follow.
  if (APPROVED.has(to)) patch.resume_from = to;
  else if (APPROVED.has(from)) patch.resume_from = from;
  return patch;
}
```

(`Frontmatter` is the type from `./intents`; add it to the import.) `setStatus` uses it and passes extra fields through:

```ts
/** Writes the status and commits it (see commitRecord). `extra` goes into the traced status change. */
export async function setStatus(ctx: StepContext, status: Status, note = "", extra: Record<string, unknown> = {}): Promise<void> {
  const from = ctx.intent.file.frontmatter.status;
  const patch = statusPatch(from, status, note);
  await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, `${from} → ${status}`, async () => {
    await writeForStep(ctx, patch);
    ctx.trace.upsertIntent(ctx.slug, status, effectivePriority(ctx.intent.file.frontmatter));
    ctx.trace.statusChange(ctx.slug, from, status, note, extra);
  });
}
```

Split the retry status out of `blockNote` so `block` can record it:

```ts
/**
 * The status a person sets to try a block again, as blockNote words it: `retryFrom` when given, else
 * the approved status the change is resumed from. Null when the note already says what to set, or
 * there is no approved status to go back to.
 */
export function retryTarget(ctx: StepContext, note: string, retryFrom?: Status): Status | null {
  if (saysWhatToSet(note)) return null;
  const from = ctx.intent.file.frontmatter.status;
  return retryFrom ?? (APPROVED.has(from) ? from : ctx.intent.file.frontmatter.resume_from) ?? null;
}

export function blockNote(ctx: StepContext, note: string, retryFrom?: Status): string {
  const resume = retryTarget(ctx, note, retryFrom);
  if (!resume) return note;
  if (note.includes(CRASH_NOTE) || note.includes(TIMEOUT_NOTE)) return `${note} To try again, set status to ${resume}.`;
  return `${note} When that is sorted out, set status to ${resume} to try again.`;
}
```

(Keep `blockNote`'s doc comment.) In `block`, record it:

```ts
  const note = blockNote(ctx, reason, opts.retryFrom);
  const retry = retryTarget(ctx, reason, opts.retryFrom);
  try {
    await setStatus(ctx, "blocked", note, retry ? { retry } : {});
```

- [ ] **Step 4: Run them to see them pass**

Run: `bun test tests/unit/context.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/trace.ts tests/unit/context.test.ts
git commit -m "feat(context): a block records its retry status; statusPatch shared"
```

---
### Task 5: the rules of each action (`src/actions.ts`)

Pure functions only: what a change offers a person now, where each action takes it, which statuses a block may be retried from, which undo is allowed, and the words for commits, results and questions. The console's server, the applier and chat all use these, so they agree.

**Files:**
- Create: `src/actions.ts`
- Modify: `src/console/types.ts` (the `Offer` and `ActionKind` types and the priority names live here, because the page imports this file and must not import server code)
- Test: `tests/unit/actions.test.ts`

- [ ] **Step 1: Add the shared types to `src/console/types.ts`**

```ts
/** What a person can do to a change from the console or chat. */
export type ActionKind = "approve" | "send-back" | "retry" | "accept" | "close" | "priority" | "hold" | "release";

/** One action a change offers now: its kind, its button's words, and the status it leads to (when it sets one). */
export interface Offer { kind: ActionKind; label: string; to?: string; confirm?: boolean }

/** The priorities, in order (the same list as src/intents.ts; the page cannot import that file). */
export const PRIORITY_NAMES = ["urgent", "high", "normal", "low"] as const;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/actions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { askText, doneWords, offers, requestLabel, resultText, retryTargets, targetOf, undoAllowed } from "../../src/actions";
import { humanGates, parseIntentFile, type Frontmatter } from "../../src/intents";

const fm = (status: string, more = ""): Frontmatter => parseIntentFile(`---\nstatus: ${status}\n${more}---\n# Intent: x\n`).frontmatter;
const everyone = { spec: "status", plan: "status", merge: "status", done: "status" } as const;
const nobody = humanGates(null);
const kinds = (o: Array<{ kind: string }>) => o.map((x) => x.kind);

describe("what a change offers", () => {
  test("a review with a person on its gate offers approve and send back; with nobody, neither", () => {
    expect(kinds(offers(fm("plan-review"), everyone, []))).toEqual(["approve", "send-back", "hold", "priority", "close"]);
    expect(offers(fm("plan-review"), everyone, [])[0]).toEqual({ kind: "approve", label: "Approve the plan", to: "plan-approved" });
    expect(kinds(offers(fm("plan-review"), nobody, []))).toEqual(["hold", "priority", "close"]);
    expect(offers(fm("verifying"), everyone, [])[0]).toEqual({ kind: "approve", label: "Confirm it is done", to: "done" });
    expect(kinds(offers(fm("verifying"), everyone, []))).not.toContain("send-back");
  });

  test("a draft offers start; a blocked change offers one retry per target; finished changes offer nothing", () => {
    expect(kinds(offers(fm("draft"), everyone, []))).toEqual(["accept", "priority", "close"]);
    expect(offers(fm("blocked"), everyone, ["plan-approved", "accepted"]).filter((o) => o.kind === "retry")).toEqual([
      { kind: "retry", label: "Retry from plan-approved", to: "plan-approved" },
      { kind: "retry", label: "Retry from accepted", to: "accepted" },
    ]);
    expect(offers(fm("done"), everyone, [])).toEqual([]);
    expect(offers(fm("closed"), everyone, [])).toEqual([]);
  });

  test("a held change offers release instead of hold, even a draft or a blocked one held by hand", () => {
    expect(kinds(offers(fm("building", "hold: x\n"), everyone, []))).toEqual(["release", "priority", "close"]);
    expect(kinds(offers(fm("draft", "hold: x\n"), everyone, []))).toContain("release");
    expect(offers(fm("closed"), everyone, []).length).toBe(0);
    expect(offers(fm("building"), everyone, []).find((o) => o.kind === "close")).toEqual({ kind: "close", label: "Close", to: "closed", confirm: true });
  });
});

describe("retry targets", () => {
  test("the block's own status first, then each status a sentence about the status names; never draft, blocked, done or closed", () => {
    expect(retryTargets("The spec did not pass its automatic check. Set status to spec-approved to accept the spec as it is, or to accepted to write it again.", null)).toEqual(["spec-approved", "accepted"]);
    expect(retryTargets("The build broke. When that is sorted out, set status to plan-approved to try again.", "plan-approved")).toEqual(["plan-approved"]);
    expect(retryTargets("Set status back to an earlier approved state, or to closed.", null)).toEqual([]);
    expect(retryTargets("It waits to be merged into building soon.", null)).toEqual([]);
    expect(retryTargets("", "merge-approved")).toEqual(["merge-approved"]);
  });
});

describe("where an action leads, and undo", () => {
  test("targets", () => {
    expect(targetOf({ kind: "approve", expect: "spec-review" })).toBe("spec-approved");
    expect(targetOf({ kind: "send-back", expect: "merge-review" })).toBe("plan-approved");
    expect(targetOf({ kind: "retry", expect: "blocked", to: "accepted" })).toBe("accepted");
    expect(targetOf({ kind: "close", expect: "building" })).toBe("closed");
    expect(targetOf({ kind: "undo", expect: "plan-approved", to: "plan-review" })).toBe("plan-review");
    expect(targetOf({ kind: "accept", expect: "draft" })).toBe("accepted");
    expect(targetOf({ kind: "approve", expect: "building" })).toBeNull();
  });

  test("undo only goes back from what approve or send back set, to the review it came from", () => {
    expect(undoAllowed("plan-approved", "plan-review")).toBe(true);
    expect(undoAllowed("accepted", "spec-review")).toBe(true);
    expect(undoAllowed("done", "verifying")).toBe(true);
    expect(undoAllowed("plan-approved", "merge-review")).toBe(true);
    expect(undoAllowed("building", "plan-review")).toBe(false);
    expect(undoAllowed("closed", "building")).toBe(false);
  });
});

describe("words", () => {
  test("commit words, labels, questions and results", () => {
    expect(doneWords({ kind: "approve", expect: "plan-review" })).toBe("plan approved");
    expect(doneWords({ kind: "send-back", expect: "merge-review" })).toBe("build sent back");
    expect(doneWords({ kind: "priority", expect: "building", priority: "high" })).toBe("priority set to high");
    expect(doneWords({ kind: "undo", expect: "plan-approved", to: "plan-review" })).toBe("undone, back to plan-review");
    expect(requestLabel({ kind: "approve", expect: "spec-review" })).toBe("Approve the spec");
    expect(requestLabel({ kind: "hold", expect: "building" })).toBe("Hold");
    expect(askText({ kind: "approve", expect: "plan-review" }, "csv-export")).toBe("Approve the plan of csv-export?");
    expect(askText({ kind: "close", expect: "building" }, "csv-export")).toBe("Close csv-export? It stops for good.");
    expect(resultText({ kind: "approve", expect: "plan-review" }, "csv-export", "plan-approved")).toBe("Plan approved: csv-export is now plan approved, waiting to build.");
    expect(resultText({ kind: "hold", expect: "building" }, "csv-export", "building")).toBe("csv-export is held: the loop starts no step for it until it is released.");
  });
});
```


- [ ] **Step 3: Run them to see them fail**

Run: `bun test tests/unit/actions.test.ts`
Expected: FAIL (no `src/actions.ts`).

- [ ] **Step 4: Implement `src/actions.ts`**

```ts
import type { ActionKind, Offer } from "./console/types";
import { plainStatus, REVIEW_GATE, STATUSES, type Frontmatter, type HumanGates, type Priority, type Status } from "./intents";
import type { Trace } from "./trace";

/*
 * What a person can do to a change, and where each action takes it. Pure rules: the console's
 * server offers them, the loop checks them again when it applies a request, and chat proposes them.
 */

/** Where Approve takes a change waiting at each review status. */
export const APPROVE_TO: Readonly<Partial<Record<Status, Status>>> = { "spec-review": "spec-approved", "plan-review": "plan-approved", "merge-review": "merge-approved", verifying: "done" };

/** Where Send back takes it: the approved status before the work under review, so that work is done again. */
export const SEND_BACK_TO: Readonly<Partial<Record<Status, Status>>> = { "spec-review": "accepted", "plan-review": "spec-approved", "merge-review": "plan-approved" };

/** The work each review status shows a person. */
const REVIEWED: Readonly<Partial<Record<Status, string>>> = { "spec-review": "spec", "plan-review": "plan", "merge-review": "build", verifying: "result" };

const APPROVE_LABEL: Readonly<Partial<Record<Status, string>>> = { "spec-review": "Approve the spec", "plan-review": "Approve the plan", "merge-review": "Approve the merge", verifying: "Confirm it is done" };

/** Statuses a retry never sets: they are not somewhere work goes on from. */
const NOT_RETRY: ReadonlySet<string> = new Set(["draft", "blocked", "done", "closed"]);

/** Not finished: done and closed changes offer nothing. */
export function isOpen(s: Status): boolean {
  return s !== "done" && s !== "closed";
}

/** True when a person sits on the gate of this review status (so Approve and Send back are theirs to give). */
export function personReviews(s: Status, human: HumanGates): boolean {
  const gate = REVIEW_GATE[s];
  return !!gate && human[gate] !== "none";
}

/**
 * Where a blocked change can be retried from: `fromBlock` (the status the block itself recorded,
 * see retryTarget in context.ts) first, then every status named as "to <status>" in a sentence of
 * the note that is about the status. Never draft, blocked, done or closed (Close is its own action).
 */
export function retryTargets(note: string, fromBlock: Status | null): Status[] {
  const out: Status[] = [];
  const add = (s: string) => {
    if ((STATUSES as readonly string[]).includes(s) && !NOT_RETRY.has(s) && !out.includes(s as Status)) out.push(s as Status);
  };
  if (fromBlock) add(fromBlock);
  for (const sentence of note.split(/(?<=[.!?])\s+/)) {
    if (!/\bstatus\b/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/\bto ([a-z]+(?:-[a-z]+)*)\b/g)) add(m[1]!);
  }
  return out;
}

/** retryTargets for a change as the trace has it: the newest block's recorded retry, and the note on the change now. */
export function retryOptions(trace: Trace, slug: string, note: string): Status[] {
  const e = trace.lastEvent(slug, "status_change", '"to":"blocked"');
  let fromBlock: Status | null = null;
  if (e) {
    try {
      const r = (JSON.parse(e.payload) as { retry?: unknown }).retry;
      if (typeof r === "string" && (STATUSES as readonly string[]).includes(r)) fromBlock = r as Status;
    } catch { /* an unreadable payload: the note alone */ }
  }
  return retryTargets(note, fromBlock);
}

/** What a change offers a person now. `retry`: its retry targets (see retryOptions); only a blocked change uses them. */
export function offers(fm: Frontmatter, human: HumanGates, retry: Status[]): Offer[] {
  const s = fm.status;
  const out: Offer[] = [];
  if (personReviews(s, human) && APPROVE_TO[s]) {
    out.push({ kind: "approve", label: APPROVE_LABEL[s]!, to: APPROVE_TO[s] });
    if (SEND_BACK_TO[s]) out.push({ kind: "send-back", label: "Send back", to: SEND_BACK_TO[s] });
  }
  if (s === "blocked") for (const to of retry) out.push({ kind: "retry", label: `Retry from ${to}`, to });
  if (s === "draft") out.push({ kind: "accept", label: "Start", to: "accepted" });
  if (!isOpen(s)) return out;
  if (fm.hold.trim()) out.push({ kind: "release", label: "Release" });
  else if (s !== "draft" && s !== "blocked") out.push({ kind: "hold", label: "Hold" });
  out.push({ kind: "priority", label: "Priority" });
  out.push({ kind: "close", label: "Close", to: "closed", confirm: true });
  return out;
}

/** The parts of a request these rules read. */
export interface RequestShape { kind: ActionKind | "undo"; expect: Status; to?: Status; priority?: Priority }

/** The status a status-changing request leads to, from the request alone; null for one that sets no status, or that is not allowed from `expect`. */
export function targetOf(r: RequestShape): Status | null {
  switch (r.kind) {
    case "approve": return APPROVE_TO[r.expect] ?? null;
    case "send-back": return SEND_BACK_TO[r.expect] ?? null;
    case "retry": case "undo": return r.to ?? null;
    case "close": return "closed";
    case "accept": return "accepted";
    default: return null;
  }
}

/** True when going from `from` back to `to` undoes an approve or a send back (`to` is the review it came from). */
export function undoAllowed(from: Status, to: Status): boolean {
  return APPROVE_TO[to] === from || SEND_BACK_TO[to] === from;
}

/** What a request did, for the commit subject and the trace: "plan approved", "build sent back". */
export function doneWords(r: RequestShape): string {
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? "confirmed done" : `${REVIEWED[r.expect] ?? "work"} approved`;
    case "send-back": return `${REVIEWED[r.expect] ?? "work"} sent back`;
    case "retry": return `retried from ${r.to}`;
    case "accept": return "accepted";
    case "close": return "closed";
    case "priority": return `priority set to ${r.priority}`;
    case "hold": return "held";
    case "release": return "released";
    case "undo": return `undone, back to ${r.to}`;
  }
}

/** A request as a short label, for the page's pending list and its toasts: "Approve the plan". */
export function requestLabel(r: RequestShape): string {
  switch (r.kind) {
    case "approve": return APPROVE_LABEL[r.expect] ?? "Approve";
    case "send-back": return "Send back";
    case "retry": return `Retry from ${r.to}`;
    case "accept": return "Start";
    case "close": return "Close";
    case "priority": return `Set priority to ${r.priority}`;
    case "hold": return "Hold";
    case "release": return "Release";
    case "undo": return `Undo, back to ${r.to}`;
  }
}

/** The question chat asks before it submits a request. */
export function askText(r: RequestShape, slug: string): string {
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? `Confirm ${slug} is done?` : r.expect === "merge-review" ? `Approve merging ${slug}?` : `Approve the ${REVIEWED[r.expect] ?? "work"} of ${slug}?`;
    case "send-back": return `Send ${slug} back with your note, so its ${REVIEWED[r.expect] ?? "work"} is done again?`;
    case "retry": return `Retry ${slug} from ${r.to}?`;
    case "accept": return `Start work on ${slug} now?`;
    case "close": return `Close ${slug}? It stops for good.`;
    case "priority": return `Set ${slug}'s priority to ${r.priority}?`;
    case "hold": return `Hold ${slug}, so the loop starts no step for it?`;
    case "release": return `Release ${slug}, so the loop goes on with it?`;
    case "undo": return `Take ${slug} back to ${r.to}?`;
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The plain result of a request that was applied; `now` is the change's status after it. */
export function resultText(r: RequestShape, slug: string, now: Status): string {
  switch (r.kind) {
    case "priority": return `${slug} now has priority ${r.priority}.`;
    case "hold": return `${slug} is held: the loop starts no step for it until it is released.`;
    case "release": return `${slug} is released: the loop goes on with it.`;
    default: return `${capital(doneWords(r))}: ${slug} is now ${plainStatus(now)}.`;
  }
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `bun test tests/unit/actions.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/actions.ts src/console/types.ts tests/unit/actions.test.ts
git commit -m "feat(actions): the rules of what a person can do to a change"
```

---

### Task 6: the request files (`src/requests.ts`)

`src/chat/requests.ts` splits in two: the files (this task) and the applying (Task 7). Requests and results move from `.loopstra/chat/requests|results/` to `.loopstra/requests/` and `.loopstra/requests/results/`; requests being applied sit in `.loopstra/requests/applying/`.

**Files:**
- Create: `src/requests.ts`
- Modify: `src/chat/orchestrator.ts`, `src/chat/publish.ts`, `src/chat/service.ts` (imports and the new `via` field)
- Test: `tests/unit/requests.test.ts`; update `tests/integration/chat.test.ts`, `tests/unit/chat-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/requests.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyingRequests, cancelRequest, claimRequest, CONSOLE, drainOld, finishRequest, pendingRequests, pruneResults, requestState, requestsDir, submitRequest, takeResults } from "../../src/requests";
import { wakeStamp } from "../../src/wake";
import { tempDir } from "../helpers";

const by = { by: "u1", byName: "Ana", via: "the dashboard", transport: CONSOLE, thread: "" };

describe("request files", () => {
  test("submit writes a request in order and wakes the loop", () => {
    const t = tempDir();
    try {
      const before = wakeStamp(t.path);
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      const b = submitRequest(t.path, { ...by, kind: "hold", slug: "b", expect: "building", reason: "legal" });
      expect(wakeStamp(t.path)).not.toBe(before);
      expect(pendingRequests(t.path).map((r) => r.id)).toEqual([a.id, b.id]);
      expect(a.at).toBeTruthy();
    } finally {
      t.cleanup();
    }
  });

  test("a claimed request can no longer be cancelled; a pending one can, once", () => {
    const t = tempDir();
    try {
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      const b = submitRequest(t.path, { ...by, kind: "close", slug: "b", expect: "building" });
      expect(claimRequest(t.path, a.id)).toBe(true);
      expect(claimRequest(t.path, a.id)).toBe(false);
      expect(cancelRequest(t.path, a.id)).toBe(false);
      expect(applyingRequests(t.path).map((r) => r.id)).toEqual([a.id]);
      expect(requestState(t.path, a.id)).toEqual({ state: "pending" });
      expect(cancelRequest(t.path, b.id)).toBe(true);
      expect(cancelRequest(t.path, b.id)).toBe(false);
      expect(requestState(t.path, b.id)).toBeNull();
      expect(pendingRequests(t.path).map((r) => r.id)).toEqual([a.id]);
    } finally {
      t.cleanup();
    }
  });

  test("a finished request leaves a result the console takes once by id, and chat takes by transport", () => {
    const t = tempDir();
    try {
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      const c = submitRequest(t.path, { by: "u", byName: "Bo", via: "Slack", transport: "slack", thread: "T1", kind: "accept", slug: "c" });
      for (const r of [a, c]) { claimRequest(t.path, r.id); finishRequest(t.path, applyingRequests(t.path).find((x) => x.id === r.id)!, { ok: true, text: "done", status: "plan-approved" }); }
      expect(applyingRequests(t.path)).toEqual([]);
      // Chat never takes the console's results.
      expect(takeResults(t.path, new Set(["slack", CONSOLE])).map((r) => r.id)).toEqual([c.id]);
      expect(requestState(t.path, a.id)).toMatchObject({ state: "done", ok: true, text: "done", status: "plan-approved" });
      expect(requestState(t.path, a.id)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("ids that are not request ids are refused, not looked up as paths", () => {
    const t = tempDir();
    try {
      expect(cancelRequest(t.path, "../hold")).toBe(false);
      expect(requestState(t.path, "..\\x")).toBeNull();
      expect(claimRequest(t.path, "a/b")).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("the old chat folders are drained once; old results older than a day are pruned", () => {
    const t = tempDir();
    try {
      const old = join(t.path, ".loopstra", "chat");
      mkdirSync(join(old, "requests"), { recursive: true });
      mkdirSync(join(old, "results"), { recursive: true });
      writeFileSync(join(old, "requests", "000000000000001-1-0000.json"), JSON.stringify({ id: "000000000000001-1-0000", kind: "accept", slug: "a", by: "u", byName: "U", transport: "terminal", thread: "local", at: "x" }));
      writeFileSync(join(old, "results", "000000000000002-1-0000.json"), JSON.stringify({ id: "000000000000002-1-0000", transport: "terminal", thread: "local", text: "t", at: "x" }));
      drainOld(t.path);
      expect(existsSync(join(old, "requests"))).toBe(false);
      expect(pendingRequests(t.path).map((r) => [r.id, r.via])).toEqual([["000000000000001-1-0000", "chat"]]);
      expect(takeResults(t.path, new Set(["terminal"])).map((r) => r.id)).toEqual(["000000000000002-1-0000"]);
      const stale = join(requestsDir(t.path), "results", "000000000000003-1-0000.json");
      mkdirSync(join(requestsDir(t.path), "results"), { recursive: true });
      writeFileSync(stale, "{}");
      const twoDays = (Date.now() - 2 * 86_400_000) / 1000;
      utimesSync(stale, twoDays, twoDays);
      pruneResults(t.path);
      expect(readdirSync(join(requestsDir(t.path), "results"))).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/requests.test.ts`
Expected: FAIL (no `src/requests.ts`).

- [ ] **Step 3: Implement `src/requests.ts`**

```ts
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Priority, Status } from "./intents";
import { chatDir, readJson, writeJson } from "./chat/threads";
import { touchWake } from "./wake";

/**
 * Requests: the one way people change things the loop owns. Only the loop writes the main checkout,
 * so two processes never commit there at once. Chat and the console leave a request in
 * `.loopstra/requests/`; the loop claims it (moves it to `applying/`), applies it (src/apply.ts),
 * and leaves a plain-words result in `results/` for whoever asked.
 */

/** The console's transport name: its results are read by id by the page that asked, never by chat. */
export const CONSOLE = "console";

/**
 * `via`: where the person was, in words ("the dashboard", "Slack"), for the commit and the trace.
 * `written`: the slugs whose intent.md the loop already wrote for this request. A request whose
 * commit failed is tried again, and must not then read its own write as someone else's.
 */
interface RequestBase { id: string; by: string; byName: string; via: string; transport: string; thread: string; at: string; written?: string[] }

/** What a request asks for. `expect` is the status the person saw. */
export type RequestBody =
  | { kind: "accept"; slug: string }
  | { kind: "new"; title: string; intents: Array<{ slug: string; text: string; update: boolean }> }
  | { kind: "approve"; slug: string; expect: Status }
  | { kind: "send-back"; slug: string; expect: Status; note: string }
  | { kind: "retry"; slug: string; expect: "blocked"; to: Status }
  | { kind: "close"; slug: string; expect: Status }
  | { kind: "priority"; slug: string; expect: Status; priority: Priority }
  | { kind: "hold"; slug: string; expect: Status; reason: string }
  | { kind: "release"; slug: string; expect: Status }
  /** Takes back an approve or a send back (see undoAllowed): from `expect` to `to`, restoring the note it replaced. */
  | { kind: "undo"; slug: string; expect: Status; to: Status; note: string };

export type Request = RequestBase & RequestBody;

/** What submitRequest takes: everything but the id and the time. */
export type Submission = Omit<RequestBase, "id" | "at" | "written"> & RequestBody;

/** What the loop did with a request. `status` is the change's status after it (null when there is no change). */
export interface RequestResult { id: string; kind: string; slug: string | null; transport: string; thread: string; text: string; ok: boolean; status: Status | null; at: string }

/** The part of a result the applier works out. */
export interface Outcome { text: string; ok: boolean; status: Status | null }

export function requestsDir(root: string): string { return join(root, ".loopstra", "requests"); }
function applyingDir(root: string): string { return join(requestsDir(root), "applying"); }
function resultsDir(root: string): string { return join(requestsDir(root), "results"); }

/** A request id (see newId): anything else is never used as a file name. */
const ID = /^\d{15}-\d+-\d{4,}$/;

let counter = 0;
/** Sorts in the order requests were made. */
function newId(): string {
  return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(4, "0")}`;
}

/** Leaves a request for the loop and wakes it (see touchWake). */
export function submitRequest(root: string, req: Submission): Request {
  const full = { ...req, id: newId(), at: new Date().toISOString() } as Request;
  writeJson(join(requestsDir(root), `${full.id}.json`), full);
  touchWake(root);
  return full;
}

function readDir(dir: string): Request[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
    .map((n) => readJson<Request>(join(dir, n)))
    .filter((r): r is Request => !!r && typeof r.id === "string" && ID.test(r.id))
    // Requests chat left before `via` existed came from chat.
    .map((r) => ({ ...r, via: r.via ?? "chat" }));
}

/** Requests not yet claimed. */
function waiting(root: string): Request[] { return readDir(requestsDir(root)); }

/** Requests the loop has not finished, claimed or not, oldest first: what the console shows as waiting. */
export function pendingRequests(root: string): Request[] {
  return [...waiting(root), ...applyingRequests(root)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Requests the loop claimed and has not finished (a pass that failed, or one cut short), oldest first. */
export function applyingRequests(root: string): Request[] { return readDir(applyingDir(root)); }

/** The ids of the requests waiting to be claimed, oldest first. */
export function waitingIds(root: string): string[] { return waiting(root).map((r) => r.id); }

/** Takes a request for applying: false when it is gone (cancelled, or claimed already). */
export function claimRequest(root: string, id: string): boolean {
  if (!ID.test(id)) return false;
  mkdirSync(applyingDir(root), { recursive: true });
  try {
    renameSync(join(requestsDir(root), `${id}.json`), join(applyingDir(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Writes a claimed request back (its `written` list changed). */
export function saveApplying(root: string, req: Request): void {
  writeJson(join(applyingDir(root), `${req.id}.json`), req);
}

/** Leaves the result for whoever asked and removes the claimed request. */
export function finishRequest(root: string, req: Request, o: Outcome): void {
  const slug = "slug" in req ? req.slug : null;
  writeJson(join(resultsDir(root), `${req.id}.json`), { id: req.id, kind: req.kind, slug, transport: req.transport, thread: req.thread, text: o.text, ok: o.ok, status: o.status, at: new Date().toISOString() } satisfies RequestResult);
  rmSync(join(applyingDir(root), `${req.id}.json`), { force: true });
}

/** Cancels a request the loop has not claimed yet: true when it was still waiting (it is gone now). */
export function cancelRequest(root: string, id: string): boolean {
  if (!ID.test(id)) return false;
  try {
    unlinkSync(join(requestsDir(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a request is: still waiting or being applied, done (its result, which this removes, so it
 * is read once), or null (unknown, cancelled, or its result was already read).
 */
export function requestState(root: string, id: string): ({ state: "pending" } | ({ state: "done" } & RequestResult)) | null {
  if (!ID.test(id)) return null;
  if (existsSync(join(requestsDir(root), `${id}.json`)) || existsSync(join(applyingDir(root), `${id}.json`))) return { state: "pending" };
  const path = join(resultsDir(root), `${id}.json`);
  const r = readJson<RequestResult>(path);
  if (!r) return null;
  rmSync(path, { force: true });
  return { state: "done", ...r };
}

/**
 * Results the loop left for the given transports, oldest first; each is removed as it is taken, so
 * it is passed on once. Results for transports another process serves (and the console's) are left.
 */
export function takeResults(root: string, transports: ReadonlySet<string>): RequestResult[] {
  const dir = resultsDir(root);
  if (!existsSync(dir)) return [];
  const out: RequestResult[] = [];
  for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const r = readJson<RequestResult>(join(dir, n));
    if (r && (r.transport === CONSOLE || !transports.has(r.transport))) continue;
    rmSync(join(dir, n), { force: true });
    if (r) out.push(r);
  }
  return out;
}

/** Moves what chat left in the folders it used before (`.loopstra/chat/requests|results/`) into the new ones. */
export function drainOld(root: string): void {
  for (const [from, to] of [[join(chatDir(root), "requests"), requestsDir(root)], [join(chatDir(root), "results"), resultsDir(root)]] as const) {
    if (!existsSync(from)) continue;
    mkdirSync(to, { recursive: true });
    for (const n of readdirSync(from)) {
      try { renameSync(join(from, n), join(to, n)); } catch { /* left for the next pass */ }
    }
    try { rmdirSync(from); } catch { /* not empty yet */ }
  }
}

/** How long a result nobody read is kept (the page that asked went away). */
const RESULT_KEPT_MS = 24 * 60 * 60_000;

/** Removes results nobody read for a day. */
export function pruneResults(root: string, now = Date.now()): void {
  const dir = resultsDir(root);
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    try { if (now - statSync(join(dir, n)).mtimeMs > RESULT_KEPT_MS) rmSync(join(dir, n), { force: true }); } catch { /* gone already */ }
  }
}
```

- [ ] **Step 4: Point chat at the new file**

- `src/chat/orchestrator.ts`: `import { submitRequest } from "../requests";` and in `doAccept` add `via: m.via` to the submitted request.
- `src/chat/publish.ts`: `import { submitRequest } from "../requests";` and add `via: o.via` to its `submitRequest` call (the `new` request).
- `src/chat/service.ts`: `import { takeResults } from "../requests";`.
- Leave `src/chat/requests.ts` in place for now (Task 7 moves the applying out and deletes it); change only its `pendingRequests`/`takeResults`/`submitRequest` users above.
- Tests: in `tests/integration/chat.test.ts` and `tests/unit/chat-orchestrator.test.ts`, import `pendingRequests`, `takeResults`, `submitRequest` from `../../src/requests`; where a test writes a request file under `join(chatDir(r.root), "requests", ...)`, write it under `join(requestsDir(r.root), ...)` instead (import `requestsDir`), and add `via: "the terminal"` (or the transport's words) to each submitted request.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/requests.test.ts && bun run typecheck`
Expected: PASS; clean. (`tests/integration/chat.test.ts` still applies requests through `src/chat/requests.ts`, which reads the old folder: it passes again after Task 7. Do not run it yet.)

- [ ] **Step 6: Commit**

```bash
git add src/requests.ts src/chat/orchestrator.ts src/chat/publish.ts src/chat/service.ts tests/unit/requests.test.ts tests/integration/chat.test.ts tests/unit/chat-orchestrator.test.ts
git commit -m "feat(requests): one folder of requests for chat and the console, claimed before applied"
```

---

### Task 7: applying every kind of request (`src/apply.ts`)

**Files:**
- Create: `src/apply.ts` (with `applyAccept` and `applyNew` moved from `src/chat/requests.ts`)
- Delete: `src/chat/requests.ts`
- Modify: `src/context.ts` (the sent-back note in the run folder), `src/scheduler.ts` (calls `applyRequests`)
- Test: `tests/unit/apply.test.ts`; `tests/integration/chat.test.ts` passes again

- [ ] **Step 1: The sent-back note's run-folder file, in `src/context.ts`**

```ts
/** Run-folder file: the note a person sent the change back with, for the next writing or build session (see takeSentBack). */
export const SENT_BACK = "sent-back.md";

/** Keeps the note a person sent a change back with, until the next session of the stage it went back to has used it. */
export function writeSentBack(root: string, slug: string, note: string): void {
  const dir = join(root, ".loopstra", "runs", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SENT_BACK), note);
}

/** Drops a kept sent-back note (its send back was undone). */
export function dropSentBack(root: string, slug: string): void {
  rmSync(join(root, ".loopstra", "runs", slug, SENT_BACK), { force: true });
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/apply.test.ts`. It needs a git repository on main with a loopstra config and intents committed; `chatRepo` in `tests/chat-helpers.ts` makes exactly that (`chatRepo({ intents: { slug: text } })` gives `{ root, cfg?, cleanup }`; read the helper and use what it returns: it is the same kind of repo `tests/integration/chat.test.ts` applies requests in). The intent text helper `INTENT(status, title)` is there too. The config's gates must have a person on spec and plan: pass `config` to `chatRepo` with `gates:` set to `human: status` for spec, plan, merge and done if the default does not (look at `templates/config.yaml` for the shape).

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRequests } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { readIntent } from "../../src/intents";
import { CONSOLE, requestState, submitRequest } from "../../src/requests";
import { Trace } from "../../src/trace";
import { chatRepo, INTENT } from "../chat-helpers";
import { lastCommit } from "../helpers";

const by = { by: "u1", byName: "John", via: "the dashboard", transport: CONSOLE, thread: "" };
const withNote = (status: string, note: string) => INTENT(status, "x").replace(`status: ${status}`, `status: ${status}\nnote: ${JSON.stringify(note)}`);

async function apply(root: string): Promise<number> {
  const trace = Trace.open(root);
  try { return await applyRequests(root, await loadConfig(root), trace); } finally { trace.close(); }
}

describe("applying requests", () => {
  test("approve: the status moves on, the note is cleared, the commit and the trace say who and where", async () => {
    const r = await chatRepo({ intents: { a: withNote("plan-review", "Read plan.md.") } });
    try {
      const q = submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      expect(await apply(r.root)).toBe(1);
      const i = await readIntent(r.root, "a");
      expect(i.file.frontmatter).toMatchObject({ status: "plan-approved", note: "", resume_from: "plan-approved" });
      expect(await lastCommit(r.root)).toContain("loopstra(a): plan approved by John from the dashboard");
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: true, status: "plan-approved", text: "Plan approved: a is now plan approved, waiting to build." });
      const trace = Trace.open(r.root);
      expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ kind: "approve", by: "John", via: "the dashboard", result: "applied", from: "plan-review", to: "plan-approved" });
      trace.close();
    } finally {
      r.cleanup();
    }
  });

  test("a change that moved on is left alone, and the result says so", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const q = submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("building");
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "a moved on to building; nothing changed." });
    } finally {
      r.cleanup();
    }
  });

  test("send back: back to the approved status before, the note says who and why, and the agent's note is kept", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") } });
    try {
      submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      await apply(r.root);
      const fm = (await readIntent(r.root, "a")).file.frontmatter;
      expect(fm.status).toBe("spec-approved");
      expect(fm.note).toBe("Sent back by John from the dashboard: Split step 3.");
      expect(readFileSync(join(r.root, ".loopstra", "runs", "a", "sent-back.md"), "utf8")).toBe("Split step 3.");
    } finally {
      r.cleanup();
    }
  });

  test("undo of a send back restores the review and its note, and drops the kept note", async () => {
    const r = await chatRepo({ intents: { a: withNote("plan-review", "Read plan.md.") } });
    try {
      submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      await apply(r.root);
      submitRequest(r.root, { ...by, kind: "undo", slug: "a", expect: "spec-approved", to: "plan-review", note: "Read plan.md." });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter).toMatchObject({ status: "plan-review", note: "Read plan.md." });
      expect(existsSync(join(r.root, ".loopstra", "runs", "a", "sent-back.md"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("retry only to a status the block names; close from any open status", async () => {
    const r = await chatRepo({ intents: { a: withNote("blocked", "The build broke. When that is sorted out, set status to plan-approved to try again."), b: INTENT("building", "y") } });
    try {
      const bad = submitRequest(r.root, { ...by, kind: "retry", slug: "a", expect: "blocked", to: "merged" });
      await apply(r.root);
      expect(requestState(r.root, bad.id)).toMatchObject({ ok: false, text: "a cannot be retried from merged; its note names plan-approved." });
      submitRequest(r.root, { ...by, kind: "retry", slug: "a", expect: "blocked", to: "plan-approved" });
      submitRequest(r.root, { ...by, kind: "close", slug: "b", expect: "building" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("plan-approved");
      expect((await readIntent(r.root, "b")).file.frontmatter).toMatchObject({ status: "closed", note: "Closed by John from the dashboard." });
    } finally {
      r.cleanup();
    }
  });

  test("hold, release and priority apply to any open change, even one whose status moved on", async () => {
    const r = await chatRepo({ intents: { a: INTENT("designing", "x"), d: INTENT("done", "z") } });
    try {
      submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "accepted", reason: "waiting for legal" });
      submitRequest(r.root, { ...by, kind: "priority", slug: "a", expect: "accepted", priority: "high" });
      const done = submitRequest(r.root, { ...by, kind: "hold", slug: "d", expect: "done", reason: "" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter).toMatchObject({ status: "designing", hold: "waiting for legal (John, the dashboard)", priority: "high" });
      expect(requestState(r.root, done.id)).toMatchObject({ ok: false, text: "d is done; nothing changed." });
      submitRequest(r.root, { ...by, kind: "release", slug: "a", expect: "designing" });
      await apply(r.root);
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8")).not.toContain("hold:");
    } finally {
      r.cleanup();
    }
  });

  test("an approve with nobody on the gate is refused: the loop does that review itself", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: "gates:\n  plan:\n    human: none\n" });
    try {
      const q = submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      await apply(r.root);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "a cannot be approved now: nobody reviews that step, so the loop goes on by itself." });
    } finally {
      r.cleanup();
    }
  });

  test("a change that does not exist gets a plain answer", async () => {
    const r = await chatRepo({ intents: {} });
    try {
      const q = submitRequest(r.root, { ...by, kind: "close", slug: "nope", expect: "building" });
      await apply(r.root);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, status: null, text: "There is no change called nope in the main code." });
    } finally {
      r.cleanup();
    }
  });
});
```

Adapt to `chatRepo`'s real shape (its config option may be a full YAML string to append, or a partial; read it). If `chatRepo`'s default gates have nobody on plan, set them in every test above that approves or sends back.

- [ ] **Step 3: Run them to see them fail**

Run: `bun test tests/unit/apply.test.ts`
Expected: FAIL (no `src/apply.ts`).

- [ ] **Step 4: Implement `src/apply.ts`**

Move `applyAccept`, `applyNew` and `markWritten` from `src/chat/requests.ts` into `src/apply.ts`, changing them to the new types: they take `Extract<Request, ...>`, `markWritten` becomes `saveApplying` after updating `req.written`, `applyAccept` commits `accepted by ${oneLine(req.byName, 80)} from ${req.via}`, and both return an `Outcome` (`{ text, ok, status }`): `applyAccept` gives `status: "accepted"` and `ok: true` when it started the change, else `ok: false` and the status it found (null when missing); `applyNew` gives `ok: added.length > 0`, `status: null`. Keep their trace events (`chat-request`) as they are. Then write the rest:

```ts
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { doneWords, isOpen, personReviews, resultText, retryOptions, targetOf, undoAllowed } from "./actions";
import type { Config } from "./config";
import { commitRecord, dropSentBack, MainCheckoutMoved, statusPatch, writeSentBack } from "./context";
import { effectivePriority, humanGates, parseIntentFile, readIntent, SLUG, writeIntent, type Frontmatter, type Intent, type Status } from "./intents";
import { applyingRequests, claimRequest, drainOld, finishRequest, pruneResults, saveApplying, waitingIds, type Outcome, type Request } from "./requests";
import { errorText } from "./shell";
import { StopRequested } from "./stop";
import type { Trace } from "./trace";
import { oneLine } from "./chat/threads";

type StatusRequest = Extract<Request, { kind: "approve" | "send-back" | "retry" | "close" | "undo" }>;
type FieldRequest = Extract<Request, { kind: "priority" | "hold" | "release" }>;

/** One pass at a time per process: the tick's and the applier's never overlap (see applyRequests). */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Applies every waiting request on the main checkout, as the loop: claims each (see claimRequest),
 * then applies the claimed ones oldest first through commitRecord. A request that hits an unexpected
 * problem (a commit refused, the checkout off main) is traced and stays claimed for the next pass; one
 * that cannot be done gets a plain result saying why. Passes run one after another, never side by side.
 * Gives how many were finished.
 */
export function applyRequests(root: string, cfg: Config, trace: Trace): Promise<number> {
  const next = chain.then(() => applyPass(root, cfg, trace), () => applyPass(root, cfg, trace));
  chain = next.catch(() => {});
  return next;
}

async function applyPass(root: string, cfg: Config, trace: Trace): Promise<number> {
  drainOld(root);
  pruneResults(root);
  for (const id of waitingIds(root)) claimRequest(root, id);
  let applied = 0;
  for (const req of applyingRequests(root)) {
    try {
      finishRequest(root, req, await applyOne(root, cfg, trace, req));
      applied++;
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      // Traced once while it stays the same: a checkout off main would otherwise add a line every 2 s.
      trace.eventOnChange("_loop", "error", `"where":"request","id":"${req.id}"`, { where: "request", id: req.id, kind: req.kind, error: e instanceof MainCheckoutMoved ? e.message : errorText(e) }, "error");
    }
  }
  return applied;
}

function applyOne(root: string, cfg: Config, trace: Trace, req: Request): Promise<Outcome> {
  switch (req.kind) {
    case "accept": return applyAccept(root, cfg.main_branch, trace, req);
    case "new": return applyNew(root, cfg.main_branch, trace, req);
    case "priority": case "hold": case "release": return applyField(root, cfg, trace, req);
    default: return applyStatus(root, cfg, trace, req);
  }
}

/** Who and where, for a commit subject or a note: "John from the dashboard". */
function byWhom(req: Request): string {
  return `${oneLine(req.byName, 80)} from ${oneLine(req.via, 40)}`;
}

/** The change a request is about, or the plain reason it cannot be read. */
async function current(root: string, slug: string): Promise<{ intent: Intent } | { problem: string }> {
  if (!SLUG.test(slug) || !existsSync(join(root, "intent", slug, "intent.md"))) return { problem: `There is no change called ${slug} in the main code.` };
  try {
    return { intent: await readIntent(root, slug) };
  } catch {
    return { problem: `${slug}'s intent.md cannot be read, so nothing changed. Fix it, then try again.` };
  }
}

function traced(trace: Trace, req: StatusRequest | FieldRequest, result: string, more: Record<string, unknown> = {}): void {
  trace.event(req.slug, "request", { id: req.id, kind: req.kind, by: req.byName, byId: req.by, via: req.via, transport: req.transport, result, ...more });
}

/** Why a status request is not something the change can do from `expect`, or null when it is. */
function notAllowed(req: StatusRequest, fm: Frontmatter, cfg: Config, trace: Trace): string | null {
  const human = humanGates(cfg);
  switch (req.kind) {
    case "approve": case "send-back":
      if (!targetOf(req)) return `${req.slug} cannot be ${req.kind === "approve" ? "approved" : "sent back"} while it is ${req.expect}.`;
      return personReviews(req.expect, human) ? null : `${req.slug} cannot be ${req.kind === "approve" ? "approved" : "sent back"} now: nobody reviews that step, so the loop goes on by itself.`;
    case "retry": {
      const options = retryOptions(trace, req.slug, fm.note);
      if (options.includes(req.to)) return null;
      return options.length ? `${req.slug} cannot be retried from ${req.to}; its note names ${options.join(" or ")}.` : `${req.slug} cannot be retried from ${req.to}; its note names no status to retry from.`;
    }
    case "close": return isOpen(req.expect) ? null : `${req.slug} is ${req.expect} already.`;
    case "undo": return undoAllowed(req.expect, req.to) ? null : `${req.slug} cannot go back from ${req.expect} to ${req.to}.`;
  }
}

/** The note a status request leaves on the change. */
function noteFor(req: StatusRequest): string {
  switch (req.kind) {
    case "send-back": return `Sent back by ${byWhom(req)}: ${req.note.trim()}`;
    case "close": return `Closed by ${byWhom(req)}.`;
    case "undo": return req.note;
    default: return "";
  }
}

/**
 * Approve, send back, retry, close and undo: only when the status is still the one the person saw
 * (`expect`), and only when the action is allowed from it. Committed as "<what> by <who> from <where>".
 */
async function applyStatus(root: string, cfg: Config, trace: Trace, req: StatusRequest): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const was = found.intent.file.frontmatter.status;
  const to = targetOf(req);
  // Written by an earlier try of this request whose commit failed: commit it now.
  const ours = (req.written ?? []).includes(req.slug) && was === to;
  if (!ours && was !== req.expect) { traced(trace, req, "moved-on", { status: was }); return { ok: false, status: was, text: `${req.slug} moved on to ${was}; nothing changed.` }; }
  const problem = ours ? null : notAllowed(req, found.intent.file.frontmatter, cfg, trace);
  if (problem || !to) { traced(trace, req, "refused", { status: was }); return { ok: false, status: was, text: problem ?? `${req.slug} cannot do that now.` }; }
  const note = noteFor(req);
  let refused = null as Status | null;
  await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async () => {
    if (ours) return;
    const fresh = await readIntent(root, req.slug);
    if (!(await writeIntent(fresh, statusPatch(req.expect, to, note), { expectStatus: req.expect }))) {
      refused = fresh.file.frontmatter.status;
      return false;
    }
    req.written = [...new Set([...(req.written ?? []), req.slug])];
    saveApplying(root, req);
  });
  if (refused !== null) { traced(trace, req, "moved-on", { status: refused }); return { ok: false, status: refused, text: `${req.slug} moved on to ${refused}; nothing changed.` }; }
  trace.upsertIntent(req.slug, to, effectivePriority(found.intent.file.frontmatter));
  trace.statusChange(req.slug, req.expect, to, note, { by: req.byName, via: req.via });
  traced(trace, req, "applied", { from: req.expect, to, what: doneWords(req) });
  if (req.kind === "send-back") writeSentBack(root, req.slug, req.note.trim());
  if (req.kind === "undo") dropSentBack(root, req.slug);
  return { ok: true, status: to, text: resultText(req, req.slug, to) };
}

/** The hold line for a hold request: the reason, then who and where. */
function holdLine(req: Extract<Request, { kind: "hold" }>): string {
  const reason = oneLine(req.reason, 300).replace(/[.\s]+$/, "") || "held";
  return `${reason} (${oneLine(req.byName, 80)}, ${oneLine(req.via, 40)})`;
}

/**
 * Priority, hold and release: on any open change, whatever its status now (a running change moves
 * on every few minutes; a hold must still land). Committed like the status requests.
 */
async function applyField(root: string, cfg: Config, trace: Trace, req: FieldRequest): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const fm = found.intent.file.frontmatter;
  if (!isOpen(fm.status)) { traced(trace, req, "refused", { status: fm.status }); return { ok: false, status: fm.status, text: `${req.slug} is ${fm.status}; nothing changed.` }; }
  if (req.kind === "hold" && fm.hold.trim()) return { ok: false, status: fm.status, text: `${req.slug} is held already; nothing changed.` };
  if (req.kind === "release" && !fm.hold.trim()) return { ok: false, status: fm.status, text: `${req.slug} is not held; nothing changed.` };
  const patch: Partial<Frontmatter> = req.kind === "priority" ? { priority: req.priority } : req.kind === "hold" ? { hold: holdLine(req) } : {};
  const remove: Array<keyof Frontmatter> = req.kind === "release" ? ["hold"] : [];
  await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async () => {
    await writeIntent(await readIntent(root, req.slug), patch, { remove });
  });
  if (req.kind === "priority") trace.upsertIntent(req.slug, fm.status, req.priority);
  traced(trace, req, "applied", { status: fm.status, what: doneWords(req) });
  return { ok: true, status: fm.status, text: resultText(req, req.slug, fm.status) };
}
```

(Keep `parseIntentFile` and `mkdirSync` imports only if `applyNew` still uses them after the move.)

Then:
- `src/scheduler.ts`: `import { applyRequests } from "./apply";` and replace `await applyChatRequests(root, cfg, trace);` with `await applyRequests(root, cfg, trace);` (the comment above it: "What people asked for (chat, the console): only the loop writes main.").
- Delete `src/chat/requests.ts`. Fix every import of it the type check finds (`tests/integration/chat.test.ts`, `tests/unit/chat-orchestrator.test.ts` already moved in Task 6).

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/apply.test.ts tests/integration/chat.test.ts tests/unit/chat-orchestrator.test.ts && bun run typecheck`
Expected: PASS; clean. If a chat test asserted the old commit subject "accepted by U from chat", it now reads "accepted by U from <via>": update the expectation to the `via` the test submitted.

- [ ] **Step 6: Commit**

```bash
git add -A src/apply.ts src/chat/requests.ts src/context.ts src/scheduler.ts tests/unit/apply.test.ts tests/integration/chat.test.ts tests/unit/chat-orchestrator.test.ts
git commit -m "feat(apply): the loop applies approve, send back, retry, close, priority, hold, release and undo"
```

---

### Task 8: the applier runs beside the tick

**Files:**
- Modify: `src/apply.ts`, `src/scheduler.ts`
- Test: `tests/unit/apply.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/apply.test.ts` (import `armApplier`, `startApplier` from `../../src/apply`; `until` from `../console-helpers`):

```ts
describe("the applier", () => {
  test("once armed, it applies a request within a couple of seconds and stops cleanly", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const applier = startApplier(r.root, { everyMs: 50 });
    try {
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      await Bun.sleep(200);
      // Not armed yet: the first tick has not put a cut-short move of main back.
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      armApplier(r.root);
      await until(async () => (await readIntent(r.root, "a")).file.frontmatter.hold !== "", 5_000);
    } finally {
      await applier.stop();
      r.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/apply.test.ts -t "the applier"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/apply.ts`:

```ts
import { resolve } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { loadConfig } from "./config";
import { requestsDir } from "./requests";
import { stopRequested } from "./stop";
import { Trace } from "./trace";

/** The roots whose loop has settled the main checkout this run (see armApplier). */
const armed = new Set<string>();

/**
 * Lets the applier at `root` apply requests. The tick calls it once it has applied requests itself:
 * by then a move of main that a kill cut short has been put back, and the checkout is on main.
 */
export function armApplier(root: string): void {
  armed.add(resolve(root));
}

/**
 * Applies requests beside the tick, so one lands while steps run: every `everyMs` (2 s) and when a
 * file appears in `.loopstra/requests/`, once the tick has armed it. Each pass loads the config and
 * opens the trace itself. Never throws; `stop` waits for a pass in flight.
 */
export function startApplier(root: string, opts: { everyMs?: number } = {}): { stop(): Promise<void> } {
  const key = resolve(root);
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const pass = () => {
    if (stopped || inFlight || !armed.has(key) || stopRequested()) return;
    inFlight = (async () => {
      let cfg: Config;
      try { cfg = await loadConfig(root); } catch { return; }
      const trace = Trace.open(root, () => {});
      try { await applyRequests(root, cfg, trace); } catch { /* a stop, or traced inside; the next pass tries again */ } finally { trace.close(); }
    })().finally(() => { inFlight = null; });
  };
  const timer = setInterval(pass, opts.everyMs ?? 2_000);
  let watcher: FSWatcher | null = null;
  try {
    mkdirSync(requestsDir(root), { recursive: true });
    watcher = watch(requestsDir(root), () => pass());
  } catch { /* the timer alone */ }
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
      armed.delete(key);
      await inFlight;
    },
  };
}
```

(Check how `Trace.open` is called elsewhere with a second argument, as `src/chat/orchestrator.ts` does: `Trace.open(this.root, () => {})`; match it. If it takes no second argument in this version, drop it.)

In `src/scheduler.ts`:
- `import { applyRequests, armApplier, startApplier } from "./apply";`
- in `tick`, right after `await applyRequests(root, cfg, trace);` add `armApplier(root);`;
- in `start`, after `const beat = startHeartbeat(root);` add `const applier = startApplier(root);`, and in the `finally` add `await applier.stop();` before `beat.stopped();`.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/apply.test.ts tests/integration/scheduler.test.ts tests/integration/loop.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/apply.ts src/scheduler.ts tests/unit/apply.test.ts
git commit -m "feat(apply): requests land while steps run"
```

---

### Task 9: the note a change was sent back with reaches the next session

**Files:**
- Modify: `src/context.ts`, `src/stages/artifact.ts`, `src/stages/build.ts`, `src/prompts.ts`, `templates/prompts/build.md`
- Test: `tests/unit/stages-design.test.ts`, `tests/unit/stages-build.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/stages-design.test.ts`, add (in the file's style: `setupRepo("accepted")`, `openRepo`, `runDesignStep`; the design session's prompt is saved at `<runDir>/phases/<seq>-design/prompt.md`):

```ts
test("a change sent back with a note gives the note to the next design session, once", async () => {
  const repo = await setupRepo("accepted");
  try {
    writeSentBack(repo.path, "add-numbers", "Cover negative numbers too.");
    const { ctx, trace } = await openRepo(repo.path);
    await runDesignStep(ctx);
    const design = trace.phases("add-numbers").find((p) => p.name === "design")!;
    const prompt = await Bun.file(join(ctx.runDir, "phases", `${design.seq}-design`, "prompt.md")).text();
    expect(prompt).toContain("A person sent the earlier version back with this note:\nCover negative numbers too.");
    expect(existsSync(join(ctx.runDir, "sent-back.md"))).toBe(false);
    trace.close();
  } finally {
    repo.cleanup();
  }
});
```

In `tests/unit/stages-build.test.ts`, the same for the build (in its style; `setupRepo("plan-approved")` with a plan, `runBuildStep`): write the note, run the step, and expect the build prompt (`phases/<seq>-build/prompt.md`) to contain `Cover negative numbers too.` and `sent-back.md` to be gone. Also expect a build with no note to say `(none)` where the feedback goes: `expect(prompt).toContain("A person's notes on an earlier build of this change; address each one:\n\n(none)")`.

Imports: `writeSentBack` from `../../src/context`; `existsSync` from `node:fs`; `join` from `node:path`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/stages-design.test.ts tests/unit/stages-build.test.ts -t "sent back|notes"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/context.ts`, beside `writeSentBack`:

```ts
/** The note the change was sent back with, worded for a session ("" when there is none). */
export function sentBackNote(ctx: StepContext): string {
  const note = readMarker(ctx, SENT_BACK)?.trim() ?? "";
  return note ? `A person sent the earlier version back with this note:\n${note}` : "";
}
```

`src/stages/artifact.ts`, in `write` (the one writing session), give the person's note with the findings and drop it once the artifact is written:

```ts
async function write<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>, findings: string): Promise<StepResult> {
  // A person's note from sending the change back comes first; the check's findings (a rewrite) after it.
  const all = [sentBackNote(ctx), findings].filter(Boolean).join("\n\n");
  const phase = writerPhase(ctx, s, await artifacts(ctx), all);
  // Rendered once, so an answer written earlier is matched against exactly what the session is sent.
  const prompt = await phasePrompt(ctx, phase);
  const r = (await s.take?.(ctx, phase, prompt)) ?? await agentPhase(ctx, phase, prompt);
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, s.artifact, s.text(r.envelope));
  clearMarker(ctx, SENT_BACK);
  return runHookCommands(ctx, "after", s.stage);
}
```

(Import `sentBackNote` and `SENT_BACK` from `../context`.)

`src/prompts.ts`: add `"feedback"` to `PROMPT_VARS`.

`templates/prompts/build.md`: after the spec section (the lines that show `{{spec}}`), add:

```
A person's notes on an earlier build of this change; address each one:

{{feedback}}
```

`src/stages/build.ts`: give the note to the build session and drop it once the work is saved:

```ts
  const build = await agentPhase(ctx, {
    name: "build", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
    vars: { plan: a.plan, spec: a.spec, test_command: ctx.cfg.commands.test, feedback: readMarker(ctx, SENT_BACK)?.trim() ?? "" }, skills: stage.skills,
  });
  if (!build.ok) return block(ctx, build.note);
  // The build session is what fix, reconcile, and revise resume.
  if (build.sessionId) saveSession(ctx, "build", build.sessionId);
  const saved = await saveWork(ctx, wt, build.envelope.commit_message || `loopstra(${ctx.slug}): build`);
  if (!saved.ok) return block(ctx, saved.note, saved);
  clearMarker(ctx, SENT_BACK);
```

(Import `readMarker` and `SENT_BACK` from `../context`.) If `tests/unit/templates.test.ts` or `templates-roundtrip.test.ts` lists each template's variables, add `feedback` for build there.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/stages-design.test.ts tests/unit/stages-build.test.ts tests/unit/stages-plan.test.ts tests/unit/templates.test.ts tests/unit/templates-roundtrip.test.ts tests/unit/prompts.test.ts && bun run typecheck`
Expected: PASS; clean. A plan-ahead test that compares a stored prompt with a fresh one is unaffected: with no sent-back note the prompt is the same as before.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/stages/artifact.ts src/stages/build.ts src/prompts.ts templates/prompts/build.md tests/unit/stages-design.test.ts tests/unit/stages-build.test.ts tests/unit/templates.test.ts tests/unit/templates-roundtrip.test.ts
git commit -m "feat(stages): a send back's note reaches the next writing or build session"
```

---
### Task 10: "Held" and the loop's pause in Needs attention

**Files:**
- Modify: `src/attention.ts`
- Test: `tests/unit/status.test.ts` (it covers `attention`; if another test file does, such as one named for attention, use that one)

- [ ] **Step 1: Write the failing tests**

In the file that tests `attention(...)`, add (in its style for making a repo with intents and a trace):

```ts
test("a held change is in the list as Held, with why; a person's pause of the loop is there too", async () => {
  // make a repo with intent "a" at building with `hold: waiting for legal (John, the dashboard)`
  // and call holdLoop(root, "John")
  const items = await attention(root, cfg, trace, new Date());
  expect(items.find((i) => i.kind === "held")).toEqual({
    kind: "held", label: "Held", slug: "a", title: "a",
    what: "Held: waiting for legal (John, the dashboard). The loop starts no step for it until it is released, in the console or by removing the hold line from intent.md.",
  });
  expect(items[0]).toEqual({
    kind: "paused", label: "Paused", slug: null, title: "Loopstra is paused",
    what: "Paused by John: running steps finish, nothing new starts. Resume it in the console, or delete .loopstra/hold.json.",
  });
});
```

Fill in the setup with the helpers that file already uses (for example `tests/console-helpers.ts` `intent(root, slug, fm)` writes an intent with the given frontmatter lines).

- [ ] **Step 2: Run it to see it fail**

Expected: FAIL (no `held` kind).

- [ ] **Step 3: Implement**

In `src/attention.ts`:
- `AttentionItem["kind"]` gains `"held"`; `ATTENTION_LABEL` gains `held: "Held"`.
- Import `readLoopHold`, `loopHoldText` from `./heartbeat` and `heldNote` from `./intents`.
- First thing after `const add = ...`:

```ts
  // A person paused the loop: nothing new starts until they resume it.
  const loopHold = readLoopHold(root);
  if (loopHold) add("paused", null, "Loopstra is paused", `${loopHoldText(loopHold)} Resume it in the console, or delete .loopstra/hold.json.`);
```

- After the loop that adds blocked changes:

```ts
  for (const i of intents) {
    const s = i.file.frontmatter.status;
    if (!heldNote(i) || s === "done" || s === "closed") continue;
    add("held", i.slug, i.file.title || i.slug, `${heldNote(i)} The loop starts no step for it until it is released, in the console or by removing the hold line from intent.md.`);
  }
```

Update the doc comment of `attention` to list held changes after blocked ones.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/status.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/attention.ts tests/unit/status.test.ts
git commit -m "feat(attention): held changes and a person's pause need attention"
```

---

### Task 11: Activity says who did what

**Files:**
- Modify: `src/console/describe.ts`
- Test: `tests/unit/console-describe.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/console-describe.test.ts` (in its style; `describeEvent` takes an event row, check its signature at the top of `src/console/describe.ts`):

```ts
test("requests: who did what, and from where; ones not applied say why", () => {
  const row = (payload: object) => ({ id: 1, slug: "a", phase_seq: null, type: "request" as const, ts: "2026-10-17T10:00:00Z", payload: JSON.stringify(payload) });
  expect(describeEvent(row({ kind: "approve", by: "John", via: "the dashboard", result: "applied", what: "plan approved" }))).toBe("Plan approved by John from the dashboard.");
  expect(describeEvent(row({ kind: "hold", by: "Ana", via: "Slack", result: "applied", what: "held" }))).toBe("Held by Ana from Slack.");
  expect(describeEvent(row({ kind: "approve", by: "John", via: "the dashboard", result: "moved-on", status: "building" }))).toBe("John's approve from the dashboard was not applied: the change had moved on to building.");
  expect(describeEvent(row({ kind: "retry", by: "John", via: "the dashboard", result: "refused" }))).toBe("John's retry from the dashboard was not applied.");
});
```

(If `describeEvent` needs more arguments, such as a phase namer, pass what the other tests pass.)

- [ ] **Step 2: Run it to see it fail**

Expected: FAIL (`request` returns null or the default).

- [ ] **Step 3: Implement**

In `src/console/describe.ts`'s switch, next to `case "chat-request":`:

```ts
    case "request": {
      const who = str(p.by) || "Someone";
      const where = p.via ? ` from ${str(p.via)}` : "";
      if (p.result === "applied") return `${capital(str(p.what) || str(p.kind))} by ${who}${where}.`;
      if (p.result === "moved-on") return `${who}'s ${str(p.kind)}${where} was not applied: the change had moved on${p.status ? ` to ${str(p.status)}` : ""}.`;
      return `${who}'s ${str(p.kind)}${where} was not applied.`;
    }
```

(`str` and `capital` are the file's own helpers; if they are named differently, use those.)

- [ ] **Step 4: Run the test**

Run: `bun test tests/unit/console-describe.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/console/describe.ts tests/unit/console-describe.test.ts
git commit -m "feat(console): Activity says who approved, held or closed what"
```

---

### Task 12: the console's model knows offers, holds and waiting requests

**Files:**
- Modify: `src/console/types.ts`, `src/console/model.ts`, `src/console/detail.ts`, `src/console/hub.ts`
- Test: `tests/unit/console-model.test.ts`, `tests/unit/console-hub.test.ts`

- [ ] **Step 1: Types**

In `src/console/types.ts`:

```ts
/** A request the loop has not finished: shown beside its change ("Waiting for the loop: Approve the plan"). */
export interface PendingRequest { id: string; kind: string; slug: string | null; label: string; byName: string; via: string; at: string }
```

`ChangeSummary` gains:

```ts
  /** Why it is held (the hold line), or null. */
  held: string | null;
  /** What a person can do to it now (see src/actions.ts). */
  offers: Offer[];
```

`LoopSection` gains `held: { by: string; at: string } | null;` (the person's pause, see `readLoopHold`).
`Sections` gains `requests: PendingRequest[];` and `SECTION_NAMES` gains `"requests"` (at the end).

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/console-model.test.ts` (it uses `tests/console-helpers.ts`: `intent(root, slug, fm)`, `config(root, extra)`, `model(root, now)`):

```ts
describe("controls", () => {
  test("each change carries what it offers and whether it is held; pending requests and the loop's pause are there", async () => {
    // a repo with config gates human: status for plan, intent "a" at plan-review, "b" at building with a hold line
    const m = await model(root);
    const a = m.sections.changes.find((c) => c.slug === "a")!;
    expect(a.offers.map((o) => o.kind)).toEqual(["approve", "send-back", "hold", "priority", "close"]);
    expect(a.held).toBeNull();
    const b = m.sections.changes.find((c) => c.slug === "b")!;
    expect(b.held).toBe("waiting for legal");
    expect(b.offers.map((o) => o.kind)).toEqual(["release", "priority", "close"]);
    submitRequest(root, { by: "u", byName: "John", via: "the dashboard", transport: CONSOLE, thread: "", kind: "approve", slug: "a", expect: "plan-review" });
    holdLoop(root, "John");
    const m2 = await model(root);
    expect(m2.sections.requests).toEqual([expect.objectContaining({ kind: "approve", slug: "a", label: "Approve the plan", byName: "John", via: "the dashboard" })]);
    expect(m2.sections.loop.held).toMatchObject({ by: "John" });
  });

  test("a blocked change offers retry from what its block recorded", async () => {
    // intent "c" at blocked with note "The build broke. When that is sorted out, set status to plan-approved to try again."
    const m = await model(root);
    expect(m.sections.changes.find((c) => c.slug === "c")!.offers.filter((o) => o.kind === "retry")).toEqual([{ kind: "retry", label: "Retry from plan-approved", to: "plan-approved" }]);
  });
});
```

In `tests/unit/console-hub.test.ts`, add a test in its style: with a connected hub, `holdLoop(root, "John")` makes a `section` message for `loop` with `held` set arrive, and `submitRequest(...)` makes a `requests` section arrive (use the file's existing helper that collects frames and waits with `until`).

- [ ] **Step 3: Run them to see them fail**

Run: `bun test tests/unit/console-model.test.ts tests/unit/console-hub.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

`src/console/model.ts`:
- imports: `offers`, `requestLabel`, `retryOptions` from `../actions`; `readLoopHold` from `../heartbeat`; `humanGates`, `type HumanGates` from `../intents`; `pendingRequests` from `../requests`; `type PendingRequest` from `./types`.
- `changeSummary` takes the gates and computes the new fields:

```ts
export function changeSummary(trace: Trace, i: Intent, all: Intent[], heldBy: string | undefined, busy: ReadonlySet<string>, now: Date, human: HumanGates): ChangeSummary {
  const fm = i.file.frontmatter;
  const since = statusSince(trace, i);
  return {
    slug: i.slug, title: i.file.title || i.slug, status: fm.status, plain: plainStatus(fm.status), priority: effectivePriority(fm),
    stage: STAGE[fm.status], since, inStatus: since ? agoText(now.getTime() - Date.parse(since)) : null,
    costUsd: endedCost(trace.phases(i.slug)), waiting: waitNote(i, all, heldBy) || null, note: fm.note, running: busy.has(i.slug),
    held: fm.hold.trim() || null,
    offers: offers(fm, human, fm.status === "blocked" ? retryOptions(trace, i.slug, fm.note) : []),
  };
}
```

- in `buildModel`: `const human = humanGates(cfg);`, pass it to `changeSummary`; the loop section gets `held: readLoopHold(root)`; and a new part:

```ts
  const requests = await safely("waiting requests", () => pendingRequests(root).map(pendingView), [] as PendingRequest[]);
```

returned in `sections` as `requests`. Add:

```ts
/** A waiting request as the page shows it. */
function pendingView(r: Request): PendingRequest {
  const slug = "slug" in r ? r.slug : null;
  const label = r.kind === "new" ? `Add ${r.intents.length} written intent${r.intents.length === 1 ? "" : "s"}` : requestLabel(r as Parameters<typeof requestLabel>[0]);
  return { id: r.id, kind: r.kind, slug, label, byName: r.byName, via: r.via, at: r.at };
}
```

(`requestLabel` takes the `RequestShape`; an `accept` request has no `expect`, which `requestLabel` does not read for it. Import `type Request` from `../requests`.)
- `src/console/detail.ts`: where it calls `changeSummary`, pass `humanGates(cfg)` with the config it loads (or `humanGates(null)` when it has none).
- `src/console/hub.ts`, `signatureOf`: add the hold file and the request folders to what is stamped:

```ts
    for (const p of [heartbeatPath(this.root), join(this.root, ".loopstra", "paused.json"), join(this.root, ".loopstra", "hold.json"), join(this.root, "loopstra", "config.yaml")]) parts.push(stamp(p));
    parts.push(requestsKey(this.root));
```

with, at the bottom of the file:

```ts
/** The waiting and claimed requests by name: a request made or finished changes the console. */
function requestsKey(root: string): string {
  const names = (dir: string) => { try { return readdirSync(dir).filter((n) => n.endsWith(".json")).sort().join(","); } catch { return ""; } };
  return `${names(requestsDir(root))};${names(join(requestsDir(root), "applying"))}`;
}
```

(Import `requestsDir` from `../requests`.) Also add a public method so the server can ask for a quick look after a write:

```ts
  /** Something was just written (a request, the loop's pause): look again soon instead of on the next poll. */
  poke(): void {
    if (this.clients.size) this.lookSoon();
  }
```

Fix every other `changeSummary` caller and every test that builds a `Sections`, `ChangeSummary` or `LoopSection` by hand (the type check lists them; `tests/unit/ui-logic.test.ts` probably has a fixture: add `held: null, offers: []`, `held: null` and `requests: []`).

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/console-model.test.ts tests/unit/console-hub.test.ts tests/unit/console-detail.test.ts tests/unit/ui-logic.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/console tests/unit/console-model.test.ts tests/unit/console-hub.test.ts tests/unit/console-detail.test.ts tests/unit/ui-logic.test.ts
git commit -m "feat(console): offers, holds, waiting requests and the loop's pause in the model"
```

---

### Task 13: the console's write routes

**Files:**
- Create: `src/console/writes.ts`
- Modify: `src/console/server.ts`
- Test: `tests/unit/console-server.test.ts`

The routes (every one checks the host like the data routes; every write needs `Origin` equal to the page's own; POST bodies need `content-type: application/json`):

| Route | Does |
|---|---|
| `POST /api/requests` | validates the action against the change as it is now, submits it, wakes the loop; 202 `{ id, loop }` (`loop` is the loop's state: `running`, `paused`, `stopped`, `not-responding`) |
| `GET /api/requests/<id>` | `{ state: "pending" }`, or `{ state: "done", ok, text, status }` (read once), or 404 |
| `DELETE /api/requests/<id>` | cancels it if the loop has not claimed it: `{ cancelled: true }`, else 409 `{ cancelled: false }` |
| `POST /api/loop` | `{ action: "pause" }` writes `.loopstra/hold.json`; `{ action: "resume" }` removes it and wakes the loop; 200 `{ held }` |

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/console-server.test.ts` (in its style: it starts `serveConsole(root, 0)` on a temp repo and fetches it; the repo needs a config with `gates: plan: human: status` and intent `a` at `plan-review`):

```ts
describe("writes", () => {
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });

  test("an action is submitted, followed and read once", async () => {
    const r = await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" });
    expect(r.status).toBe(202);
    const { id, loop } = await r.json() as { id: string; loop: string };
    expect(loop).toBe("stopped");
    expect(pendingRequests(root).map((q) => [q.id, q.kind, q.via, q.transport])).toEqual([[id, "approve", "the dashboard", "console"]]);
    expect(await (await fetch(`${base}/api/requests/${id}`)).json()).toEqual({ state: "pending" });
    // the loop applies it
    const trace = Trace.open(root);
    await applyRequests(root, await loadConfig(root), trace);
    trace.close();
    expect(await (await fetch(`${base}/api/requests/${id}`)).json()).toMatchObject({ state: "done", ok: true, status: "plan-approved" });
    expect((await fetch(`${base}/api/requests/${id}`)).status).toBe(404);
  });

  test("an action the change does not offer now, or a status it is no longer at, is refused with plain words", async () => {
    const stale = await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "spec-review" });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: string }).error).toBe("a is plan-review now, not spec-review. The page shows it as it is now.");
    const wrong = await post(base, "/api/requests", { kind: "retry", slug: "a", expect: "plan-review", to: "accepted" });
    expect(wrong.status).toBe(409);
    expect((await post(base, "/api/requests", { kind: "approve", slug: "../x", expect: "plan-review" })).status).toBe(400);
    expect((await post(base, "/api/requests", { kind: "send-back", slug: "a", expect: "plan-review", note: "  " })).status).toBe(400);
  });

  test("a waiting request can be cancelled once", async () => {
    const { id } = await (await post(base, "/api/requests", { kind: "hold", slug: "a", expect: "plan-review", reason: "" })).json() as { id: string };
    const del = () => fetch(`${base}/api/requests/${id}`, { method: "DELETE", headers: { origin: base } });
    expect(await (await del()).json()).toEqual({ cancelled: true });
    expect((await del()).status).toBe(409);
  });

  test("pause and resume the loop", async () => {
    expect(await (await post(base, "/api/loop", { action: "pause" })).json()).toMatchObject({ held: { by: expect.any(String) } });
    expect(readLoopHold(root)).not.toBeNull();
    const stamp = wakeStamp(root);
    expect(await (await post(base, "/api/loop", { action: "resume" })).json()).toEqual({ held: null });
    expect(readLoopHold(root)).toBeNull();
    expect(wakeStamp(root)).not.toBe(stamp);
  });

  test("a write from another origin, without JSON, or to another host name is refused", async () => {
    expect((await post(base, "/api/requests", { kind: "approve", slug: "a", expect: "plan-review" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(`${base}/api/requests`, { method: "POST", headers: { origin: base, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await fetch(`${base}/api/loop`, { method: "POST", headers: { origin: base, "content-type": "application/json", host: "evil.example" }, body: '{"action":"pause"}' })).status).toBe(403);
    expect((await fetch(`${base}/api/requests/000000000000001-1-0000`, { method: "DELETE", headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect(readLoopHold(root)).toBeNull();
  });
});
```

(`base` is the server's `http://127.0.0.1:<port>`. Imports: `pendingRequests` from `../../src/requests`; `applyRequests` from `../../src/apply`; `loadConfig` from `../../src/config`; `Trace` from `../../src/trace`; `readLoopHold` from `../../src/heartbeat`; `wakeStamp` from `../../src/wake`. The repo must be a git repository on main for `applyRequests` to commit: use the same repo setup `tests/unit/apply.test.ts` uses, `chatRepo`. If setting a `host` header with fetch does not reach the server as written, test the host check the way the file's existing host tests do.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/console-server.test.ts -t writes`
Expected: FAIL (405 Read only).

- [ ] **Step 3: Implement `src/console/writes.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { offers, retryOptions, undoAllowed } from "../actions";
import { localUser } from "../chat/transports/shared";
import { loadConfig, type Config } from "../config";
import { holdLoop, readLoopHold, releaseLoop } from "../heartbeat";
import { humanGates, PRIORITIES, readIntent, SLUG, STATUSES, type Priority, type Status } from "../intents";
import { cancelRequest, CONSOLE, requestState, submitRequest, type RequestBody } from "../requests";
import { Trace } from "../trace";
import { touchWake } from "../wake";
import type { Hub } from "./hub";
import { loopNow } from "./model";

/** The longest note a send back takes, and the longest hold reason. */
const MAX_NOTE = 4_000;
const MAX_REASON = 300;
const KINDS = ["approve", "send-back", "retry", "accept", "close", "priority", "hold", "release", "undo"] as const;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (error: string, status = 409) => json({ error }, status);

/**
 * The console's writes: requests for the loop (`/api/requests`, with GET and DELETE of one by id)
 * and the loop's pause (`/api/loop`). Null for any other path. Every write must come from the page
 * itself (its Origin), and a POST must be JSON: a page framed or opened by another site cannot send
 * either (see "Safety of writes" in the spec).
 */
export async function writes(root: string, hub: Hub, req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const one = path.match(/^\/api\/requests\/([^/]+)$/);
  if (path !== "/api/requests" && path !== "/api/loop" && !one) return null;
  if (one && (req.method === "GET" || req.method === "HEAD")) {
    const s = requestState(root, decodeURIComponent(one[1]!));
    return s ? json(s.state === "pending" ? { state: "pending" } : { state: "done", ok: s.ok, text: s.text, status: s.status }) : json({ error: "unknown request" }, 404);
  }
  if (req.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
  if (one && req.method === "DELETE") {
    const cancelled = cancelRequest(root, decodeURIComponent(one[1]!));
    hub.poke();
    return json({ cancelled }, cancelled ? 200 : 409);
  }
  if (req.method !== "POST" || one) return new Response("Method not allowed", { status: 405 });
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new Response("Expected JSON", { status: 415 });
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return refuse("The request was not JSON.", 400); }
  if (typeof body !== "object" || body === null) return refuse("The request was not an object.", 400);
  const answer = path === "/api/loop" ? loop(root, body) : await action(root, body);
  hub.poke();
  return answer;
}

function loop(root: string, body: Record<string, unknown>): Response {
  if (body.action === "pause") return json({ held: readLoopHold(root) ?? holdLoop(root, localUser()) });
  if (body.action === "resume") {
    releaseLoop(root);
    touchWake(root);
    return json({ held: null });
  }
  return refuse("Say pause or resume.", 400);
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const isStatus = (v: unknown): v is Status => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

/** The body as a request, or why it is not one (a 400). */
function parse(body: Record<string, unknown>): RequestBody | string {
  const kind = str(body.kind);
  const slug = str(body.slug);
  if (!kind || !(KINDS as readonly string[]).includes(kind)) return "Unknown action.";
  if (!slug || !SLUG.test(slug)) return "Unknown change.";
  if (kind === "accept") return { kind, slug };
  const expect = body.expect;
  if (!isStatus(expect)) return "Say which status the change was at.";
  switch (kind) {
    case "approve": case "close": case "release": return { kind, slug, expect };
    case "send-back": {
      const note = str(body.note)?.trim() ?? "";
      if (!note || note.length > MAX_NOTE) return `Say what should change (at most ${MAX_NOTE} characters).`;
      return { kind, slug, expect, note };
    }
    case "retry": return isStatus(body.to) && expect === "blocked" ? { kind, slug, expect, to: body.to } : "Say which status to retry from.";
    case "undo": return isStatus(body.to) && typeof body.note === "string" && body.note.length <= MAX_NOTE ? { kind, slug, expect, to: body.to, note: body.note } : "Say which status to go back to.";
    case "priority": return typeof body.priority === "string" && (PRIORITIES as readonly string[]).includes(body.priority) ? { kind, slug, expect, priority: body.priority as Priority } : "Unknown priority.";
    case "hold": {
      const reason = str(body.reason)?.trim() ?? "";
      return reason.length <= MAX_REASON ? { kind, slug, expect, reason } : `A reason is at most ${MAX_REASON} characters.`;
    }
  }
  return "Unknown action.";
}

/**
 * Checks the action against the change as it is now (the loop checks again when it applies it),
 * then leaves it for the loop. The answer says whether the loop is running, so the page can say
 * "applies when the loop starts".
 */
async function action(root: string, body: Record<string, unknown>): Promise<Response> {
  const r = parse(body);
  if (typeof r === "string") return refuse(r, 400);
  if (!existsSync(join(root, "intent", r.slug, "intent.md"))) return refuse(`There is no change called ${r.slug}.`, 404);
  let cfg: Config | null = null;
  try { cfg = await loadConfig(root); } catch { /* nobody on any gate, as the model reads it too */ }
  let fm;
  try { fm = (await readIntent(root, r.slug)).file.frontmatter; } catch { return refuse(`${r.slug}'s intent.md cannot be read.`); }
  const expect = r.kind === "accept" ? "draft" : r.expect;
  const status = fm.status;
  const fieldOnly = r.kind === "priority" || r.kind === "hold" || r.kind === "release";
  if (!fieldOnly && status !== expect) return refuse(`${r.slug} is ${status} now, not ${expect}. The page shows it as it is now.`);
  if (r.kind === "undo") {
    if (!undoAllowed(r.expect, r.to)) return refuse("That cannot be undone now.");
  } else {
    const trace = Trace.open(root);
    let offered;
    try { offered = offers(fm, humanGates(cfg), status === "blocked" ? retryOptions(trace, r.slug, fm.note) : []); } finally { trace.close(); }
    const ok = offered.some((o) => o.kind === r.kind && (r.kind !== "retry" || o.to === r.to));
    if (!ok) return refuse(`That is not something ${r.slug} can do now.`);
  }
  const user = localUser();
  const sent = submitRequest(root, { ...r, by: user, byName: user, via: "the dashboard", transport: CONSOLE, thread: "" });
  return json({ id: sent.id, loop: loopNow(root, cfg?.poll_seconds ?? 60, new Date()).state }, 202);
}
```

In `src/console/server.ts`:
- `import { writes } from "./writes";`
- in `fetch`, after the `/api/chat` line and before the `Read only` line:

```ts
      const written = await writes(root, hub, req, url);
      if (written) return written;
```

- update the doc comment of `serveConsole` ("Read-only, apart from `/api/chat` …") to: "Its only writes are `/api/chat` (when `chat` is given), `/api/requests` and `/api/loop` (see writes.ts); each needs the page's own Origin."
- `server.timeout(req, JSON_IDLE_SECONDS)` is not needed for these quick routes.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/console-server.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/console/writes.ts src/console/server.ts tests/unit/console-server.test.ts
git commit -m "feat(console): routes to act on a change and to pause the loop"
```

---
### Task 14: the page's side of a request

**Files:**
- Create: `src/ui/requests.ts`
- Modify: `src/ui/store.ts`, `src/ui/parts/Toasts.tsx`, `src/ui/theme.css`
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/ui-logic.test.ts`:

```ts
import { bodyFor, nextPoll, undoFor } from "../../src/ui/requests";

describe("requests from the page", () => {
  const change = { slug: "a", status: "plan-review", note: "Read plan.md.", priority: "normal" } as unknown as import("../../src/console/types").ChangeSummary;

  test("the body names the change, the status the person saw, and what the action needs", () => {
    expect(bodyFor(change, { kind: "approve", label: "Approve the plan", to: "plan-approved" })).toEqual({ kind: "approve", slug: "a", expect: "plan-review" });
    expect(bodyFor(change, { kind: "send-back", label: "Send back", to: "spec-approved" }, { note: "Split it." })).toEqual({ kind: "send-back", slug: "a", expect: "plan-review", note: "Split it." });
    expect(bodyFor({ ...change, status: "blocked" }, { kind: "retry", label: "Retry from accepted", to: "accepted" })).toEqual({ kind: "retry", slug: "a", expect: "blocked", to: "accepted" });
    expect(bodyFor(change, { kind: "priority", label: "Priority" }, { priority: "high" })).toEqual({ kind: "priority", slug: "a", expect: "plan-review", priority: "high" });
    expect(bodyFor(change, { kind: "hold", label: "Hold" }, { reason: "legal" })).toEqual({ kind: "hold", slug: "a", expect: "plan-review", reason: "legal" });
  });

  test("undo puts back what the action changed, from where it left the change", () => {
    const before = { note: "Read plan.md.", priority: "normal" };
    expect(undoFor({ kind: "approve", slug: "a", expect: "plan-review" }, before, "plan-approved")).toEqual({ kind: "undo", slug: "a", expect: "plan-approved", to: "plan-review", note: "Read plan.md." });
    expect(undoFor({ kind: "send-back", slug: "a", expect: "plan-review", note: "x" }, before, "spec-approved")).toEqual({ kind: "undo", slug: "a", expect: "spec-approved", to: "plan-review", note: "Read plan.md." });
    expect(undoFor({ kind: "priority", slug: "a", expect: "building", priority: "high" }, before, "building")).toEqual({ kind: "priority", slug: "a", expect: "building", priority: "normal" });
    expect(undoFor({ kind: "hold", slug: "a", expect: "building", reason: "" }, before, "building")).toEqual({ kind: "release", slug: "a", expect: "building" });
    expect(undoFor({ kind: "close", slug: "a", expect: "building" }, before, "closed")).toBeNull();
    expect(undoFor({ kind: "approve", slug: "a", expect: "plan-review" }, before, null)).toBeNull();
  });

  test("results are asked for every second for half a minute, then every 5 s, for about ten minutes", () => {
    expect(nextPoll(0)).toBe(1000);
    expect(nextPoll(29)).toBe(1000);
    expect(nextPoll(30)).toBe(5000);
    expect(nextPoll(143)).toBe(5000);
    expect(nextPoll(144)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/ui-logic.test.ts -t "requests from the page"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/ui/store.ts`: toasts take an action button and a duration, and the waiting requests get a signal:

```ts
export const requests = computed(() => state.value.sections.requests ?? null);

export interface Toast { id: number; text: string; kind: "info" | "bad"; action?: { label: string; run: () => void } }
export const toasts = signal<Toast[]>([]);
let toastId = 0;

/** Shows a toast for `ms` (6 s unless said), with an optional button (Undo). */
export function toast(text: string, kind: Toast["kind"] = "info", opts: { action?: Toast["action"]; ms?: number } = {}): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind, action: opts.action }];
  setTimeout(() => dismiss(id), opts.ms ?? 6000);
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
```

`src/ui/parts/Toasts.tsx`:

```tsx
import { dismiss, toasts } from "../store";

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && <button class="btn" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
```

`src/ui/theme.css`, next to the toast rules:

```css
.toast { display: flex; align-items: center; gap: 12px; }
.toast .btn { background: transparent; color: inherit; border-color: currentColor; padding: 2px 10px; }
```

Create `src/ui/requests.ts`:

```ts
import type { ChangeSummary, Offer } from "../console/types";
import { toast } from "./store";

/** What the page posts to /api/requests. */
export interface ActionBody { kind: string; slug: string; expect?: string; to?: string; note?: string; priority?: string; reason?: string }

/** What the change was before an action, so an undo can put it back. */
export interface Before { note: string; priority: string }

/** The request for an offer on a change: the change, the status the person saw, and what the action needs. */
export function bodyFor(c: ChangeSummary, offer: Offer, input: { note?: string; priority?: string; reason?: string } = {}): ActionBody {
  const b: ActionBody = { kind: offer.kind, slug: c.slug, expect: c.status };
  if (offer.kind === "retry") b.to = offer.to;
  if (offer.kind === "send-back") b.note = input.note ?? "";
  if (offer.kind === "priority") b.priority = input.priority;
  if (offer.kind === "hold") b.reason = input.reason ?? "";
  return b;
}

/** The actions with an Undo (see decision 5 in the plan): close asks first, the others start work. */
export const UNDOABLE: ReadonlySet<string> = new Set(["approve", "send-back", "priority", "hold"]);

/** The request that takes back `b`, once the loop applied it and left the change at `status`; null when there is none. */
export function undoFor(b: ActionBody, before: Before, status: string | null): ActionBody | null {
  if (!status) return null;
  switch (b.kind) {
    case "approve": case "send-back": return { kind: "undo", slug: b.slug, expect: status, to: b.expect, note: before.note };
    case "priority": return { kind: "priority", slug: b.slug, expect: status, priority: before.priority };
    case "hold": return { kind: "release", slug: b.slug, expect: status };
    default: return null;
  }
}

/** How long to wait before asking for a result again, by how many times it was asked; null: stop asking. */
export function nextPoll(asked: number): number | null {
  if (asked < 30) return 1000;
  if (asked < 144) return 5000;
  return null;
}

export interface Done { state: "done"; ok: boolean; text: string; status: string | null }

const JSON_POST = { "content-type": "application/json" };

/** Posts JSON to the console; gives the reply, or the plain words of why it failed. */
async function post(url: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { method: "POST", headers: JSON_POST, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (r.ok) return { ok: true, data };
    return { ok: false, error: typeof data.error === "string" ? data.error : `The console said no (${r.status}).` };
  } catch {
    return { ok: false, error: "The console could not be reached." };
  }
}

/** Asks the loop to stop the change's request if it has not started on it; true when it was stopped. */
export async function cancel(id: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

/** Asks for a request's result until it is done (see nextPoll); gives back a stopper. A request the console no longer knows ends quietly. */
export function follow(id: string, onDone: (d: Done) => void): () => void {
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const ask = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`/api/requests/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
      if (r.status === 404) return;
      const s = await r.json() as { state: string } & Partial<Done>;
      if (s.state === "done") { onDone({ state: "done", ok: !!s.ok, text: s.text ?? "", status: s.status ?? null }); return; }
    } catch { /* asked again below */ }
    const wait = nextPoll(++asked);
    if (wait !== null && !stopped) timer = setTimeout(() => void ask(), wait);
  };
  timer = setTimeout(() => void ask(), nextPoll(0)!);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/**
 * Sends an action and keeps the person told: a toast at once (with Undo for 10 s when the action has
 * one), then the loop's answer. Undo cancels the request if the loop has not claimed it yet;
 * otherwise it waits for the answer and sends the reverse (see undoFor). `label` names the action
 * in the toasts. Gives whether it was sent.
 */
export async function act(b: ActionBody, before: Before, label: string, opts: { undo?: boolean } = {}): Promise<boolean> {
  const sent = await post("/api/requests", b);
  if (!sent.ok) {
    toast(sent.error, "bad");
    return false;
  }
  const id = String(sent.data.id);
  const loop = String(sent.data.loop ?? "");
  let done: Done | null = null;
  let afterUndo: ((d: Done) => void) | null = null;
  const undo = async () => {
    if (await cancel(id)) {
      afterUndo = () => {};
      toast("Cancelled; nothing changed.");
      return;
    }
    const reverse = (d: Done) => {
      const back = d.ok ? undoFor(b, before, d.status) : null;
      if (back) void act(back, before, "Undo", { undo: false });
      else toast(d.text, d.ok ? "info" : "bad");
    };
    if (done) reverse(done);
    else afterUndo = reverse;
  };
  const withUndo = opts.undo !== false && UNDOABLE.has(b.kind);
  const said = loop === "stopped" || loop === "not-responding" ? `${label}: saved. It applies when the loop runs.` : `${label}: sent to the loop.`;
  toast(said, "info", withUndo ? { action: { label: "Undo", run: () => void undo() }, ms: 10_000 } : {});
  follow(id, (d) => {
    done = d;
    if (afterUndo) { afterUndo(d); return; }
    toast(d.text, d.ok ? "info" : "bad");
  });
  return true;
}

/** Pauses or resumes the loop, and says what that means. */
export async function setLoopHeld(held: boolean): Promise<void> {
  const r = await post("/api/loop", { action: held ? "pause" : "resume" });
  if (!r.ok) { toast(r.error, "bad"); return; }
  toast(held ? "The loop is paused: running steps finish, nothing new starts." : "The loop goes on.");
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/requests.ts src/ui/store.ts src/ui/parts/Toasts.tsx src/ui/theme.css tests/unit/ui-logic.test.ts
git commit -m "feat(ui): send an action, follow its result, undo it"
```

---

### Task 15: the controls on the change page, in the inbox and on the board

**Files:**
- Create: `src/ui/parts/Actions.tsx`
- Modify: `src/ui/views/Change.tsx`, `src/ui/views/Inbox.tsx`, `src/ui/views/Changes.tsx`, `src/ui/parts/Help.tsx`, `src/ui/theme.css`
- Test: `tests/unit/console-page.test.ts` (the bundle still builds and stays under its size limit)

- [ ] **Step 1: Create `src/ui/parts/Actions.tsx`**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { PRIORITY_NAMES, type ChangeSummary, type Offer } from "../../console/types";
import { act, bodyFor } from "../requests";
import { requests } from "../store";

/** Actions that open a small form first: a note, a reason, or a confirmation. */
type Form = "send-back" | "hold" | "close";
const FORMS: ReadonlySet<string> = new Set(["send-back", "hold", "close"]);
/** Drawn as the main button. */
const PRIMARY: ReadonlySet<string> = new Set(["approve", "retry", "accept"]);
/** What the inbox shows: what decides where the change goes next. */
const COMPACT: ReadonlySet<string> = new Set(["approve", "send-back", "retry", "accept", "release"]);

/**
 * The controls for one change: its offers as buttons (send back, hold and close open a small form
 * first), and the requests it has waiting for the loop. `compact` shows only the deciding ones.
 */
export function Actions({ change, compact = false }: { change: ChangeSummary; compact?: boolean }) {
  const [form, setForm] = useState<Form | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, [form]);
  const waiting = (requests.value ?? []).filter((r) => r.slug === change.slug);
  const shown = change.offers.filter((o) => !compact || COMPACT.has(o.kind));
  if (!shown.length && !waiting.length) return null;
  const close = () => { setForm(null); setText(""); };
  const run = async (o: Offer, input: { note?: string; priority?: string; reason?: string } = {}) => {
    setBusy(true);
    try {
      await act(bodyFor(change, o, input), { note: change.note, priority: change.priority }, `${o.label}, ${change.slug}`);
    } finally {
      setBusy(false);
      close();
    }
  };
  const offer = (kind: string) => shown.find((o) => o.kind === kind)!;
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class="controls" onClick={stop}>
      {waiting.length > 0 && <span class="badge warn">Waiting for the loop: {waiting.map((w) => w.label).join(", ")}</span>}
      {form === null && shown.map((o) => o.kind === "priority" ? (
        <label key="priority" class="prio-pick">
          Priority
          <select value={change.priority} disabled={busy} onChange={(e) => { const p = e.currentTarget.value; if (p !== change.priority) void run(o, { priority: p }); }}>
            {PRIORITY_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      ) : (
        <button key={`${o.kind}:${o.to ?? ""}`} type="button" disabled={busy}
          class={`btn${PRIMARY.has(o.kind) ? " primary" : ""}${o.kind === "close" ? " danger" : ""}`}
          onClick={() => (FORMS.has(o.kind) ? setForm(o.kind as Form) : void run(o))}>
          {o.label}
        </button>
      ))}
      {form === "send-back" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(offer("send-back"), { note: text }); }}>
          <textarea ref={field} value={text} placeholder="What should change? The agent gets this note." aria-label="What should change" maxLength={4000} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Escape") close(); }} />
          <button class="btn primary" type="submit" disabled={busy || !text.trim()}>Send back</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form === "hold" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); void run(offer("hold"), { reason: text }); }}>
          <input ref={field} type="text" value={text} placeholder="Why? (optional)" aria-label="Why it is held" maxLength={300} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Escape") close(); }} />
          <button class="btn primary" type="submit" disabled={busy}>Hold</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form === "close" && (
        <div class="control-form" role="group" aria-label="Confirm closing">
          <span>Close {change.slug}? It stops for good.</span>
          <button class="btn danger" type="button" disabled={busy} onClick={() => void run(offer("close"))}>Close it</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </div>
      )}
    </div>
  );
}
```

`src/ui/theme.css`:

```css
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.control-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.control-form textarea { width: 100%; min-height: 72px; resize: vertical; }
.control-form input[type="text"] { flex: 1 1 200px; min-width: 0; }
.btn.danger { border-color: var(--bad); color: var(--bad); }
.prio-pick { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); }
```

(If the form controls have no base style for textarea and text inputs, give them the same border, radius and background the page's search input uses.)

- [ ] **Step 2: Place them**

`src/ui/views/Change.tsx`:
- import `Actions` from `../parts/Actions`;
- in the header, after the priority chip: `{d.held && <span class="badge warn" title={d.held}>Held</span>}`;
- right after the `view-head` div: `<Actions change={summary ?? d} />` (the summary comes with every update, so its offers are current; the detail is the fallback before the first one).

`src/ui/views/Inbox.tsx`:
- import `Actions`, `changes` (from `../store`), `act`, `bodyFor` (from `../requests`);
- `Item` looks up its change: `const change = it.slug ? changes.value?.find((c) => c.slug === it.slug) : undefined;` and renders `{change && <Actions change={change} compact />}` inside `.actions`, before the Open link;
- a key: `a` approves the selected item's change when it offers Approve:

```ts
    screenKeys.set("a", () => {
      const it = inbox.value?.[atRef.current];
      const c = it?.slug ? changes.value?.find((x) => x.slug === it.slug) : undefined;
      const o = c?.offers.find((x) => x.kind === "approve");
      if (c && o) void act(bodyFor(c, o), { note: c.note, priority: c.priority }, `${o.label}, ${c.slug}`);
    });
```

(and remove `"a"` in the cleanup list with j, k and o). The hint line under the list becomes: `<kbd>J</kbd> <kbd>K</kbd> move, <kbd>O</kbd> opens the change, <kbd>A</kbd> approves it.`
- the item kinds drawn in red stay as they are; `held` is drawn like a waiting item.

`src/ui/views/Changes.tsx`: on the board card, in the first `ccard-meta` line, after the priority chip: `{c.held && <span class="badge warn" title={c.held}>Held</span>}`; in the list view, the same after the priority cell's chip.

`src/ui/parts/Help.tsx`: after the O line, `<dt><kbd>A</kbd></dt><dd>Approve the inbox item you are on</dd>`.

- [ ] **Step 3: Check the bundle and the type check**

Run: `bun test tests/unit/console-page.test.ts tests/unit/ui-logic.test.ts && bun run typecheck`
Expected: PASS (the page bundles, under 80 KB gzipped); clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui
git commit -m "feat(ui): approve, send back, retry, start, hold, release, priority and close on the change page and in the inbox"
```

---

### Task 16: pause and resume the loop from the top bar and the palette

**Files:**
- Modify: `src/ui/parts/TopBar.tsx`, `src/ui/parts/Icon.tsx`, `src/ui/parts/Palette.tsx`, `src/ui/format.ts` (only if `pillText` needs the hold)
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing test**

`pillText` (in `src/ui/format.ts`) turns the loop section into the top bar's words. A held loop must read as paused by its person. Add to `tests/unit/ui-logic.test.ts`, with the loop fixture that file already uses for `pillText` (copy it and set `state: "paused"`, `text: "Paused by John: running steps finish, nothing new starts."`, `held: { by: "John", at: "…" }`, `working: [{ slug: "a", phase: "build" }]`):

```ts
test("a loop a person paused says so in the top bar, even while its last steps finish", () => {
  expect(pillText(heldLoop)).toBe("Paused by John");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/ui-logic.test.ts -t "a person paused"`
Expected: FAIL (it shows what the paused text or the working list gives today).

- [ ] **Step 3: Implement**

In `pillText`, first: `if (l.held) return \`Paused by ${l.held.by}\`;`.

`src/ui/parts/Icon.tsx`: add `pause: "M9 5v14M15 5v14"` and `play: "M7 5l12 7-12 7z"` to `PATHS`.

`src/ui/parts/TopBar.tsx`: import `setLoopHeld` from `../requests`; before the search button:

```tsx
      {l && (
        <button class="ghost" onClick={() => void setLoopHeld(!l.held)}
          title={l.held ? `Paused by ${l.held.by}. Resume: the loop goes on.` : "Pause the loop: running steps finish, nothing new starts."}
          aria-label={l.held ? "Resume the loop" : "Pause the loop"}>
          <Icon name={l.held ? "play" : "pause"} /><span class="hide-narrow">{l.held ? "Resume" : "Pause"}</span>
        </button>
      )}
```

`src/ui/parts/Palette.tsx`: import `loop` from `../store` and `setLoopHeld` from `../requests`; after the `theme` command:

```ts
    loop.value?.held
      ? { id: "resume", title: "Resume the loop", run: () => void setLoopHeld(false) }
      : { id: "pause", title: "Pause the loop", hint: "running steps finish", run: () => void setLoopHeld(true) },
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui tests/unit/ui-logic.test.ts
git commit -m "feat(ui): pause and resume the loop"
```

---

### Task 17: chat proposes the same actions

**Files:**
- Modify: `src/chat/schemas.ts`, `src/chat/threads.ts`, `src/chat/orchestrator.ts`, `templates/prompts/orchestrator.md`, `tests/chat-helpers.ts`
- Test: `tests/unit/chat-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/chat-helpers.ts`, `turn` gains `action`:

```ts
export const turn = (reply: string, extra: { handoff?: unknown; accept?: unknown; action?: unknown } = {}) => ({ reply, handoff: extra.handoff ?? null, accept: extra.accept ?? null, action: extra.action ?? null });
```

Add to `tests/unit/chat-orchestrator.test.ts`, beside the accepting test (same setup: `chatRepo` with intents, `r.answer("orchestrator", n, turn(...))`, `message(...)`, `sink()`; the repo's config needs a person on the plan gate):

```ts
test("an action: only someone who may is asked, only a yes leaves a request, and it names the status seen", async () => {
  // intents: "csv-export" at plan-review
  await r.answer("orchestrator", 1, turn("Sure.", { action: { kind: "approve", slug: "csv-export", note: "", priority: null } }));
  await r.answer("orchestrator", 2, turn("Sure.", { action: { kind: "approve", slug: "csv-export", note: "", priority: null } }));
  const out = sink();
  await o.handle(message("approve it", { canAccept: false, acceptors: "<@U1>", thread: "x" }), out.send);
  expect(out.sent.at(-1)).toBe("You cannot change work from here; <@U1> can. They can ask me, or edit intent/csv-export/intent.md.");
  await o.handle(message("approve the plan"), out.send);
  expect(out.sent.at(-1)).toBe("Approve the plan of csv-export? Reply yes to go ahead.");
  expect(pendingRequests(r.root)).toEqual([]);
  await o.handle(message("yes"), out.send);
  expect(pendingRequests(r.root).map((q) => [q.kind, "slug" in q ? q.slug : "", "expect" in q ? q.expect : "", q.via])).toEqual([["approve", "csv-export", "plan-review", "the terminal"]]);
  expect(out.sent.at(-1)).toStartWith("Asked the loop to do it.");
});

test("an action the change does not offer now is explained, not asked", async () => {
  // intents: "csv-export" at building
  await r.answer("orchestrator", 1, turn("Sure.", { action: { kind: "approve", slug: "csv-export", note: "", priority: null } }));
  const out = sink();
  await o.handle(message("approve it"), out.send);
  expect(out.sent.at(-1)).toBe("csv-export is building and testing now, so that is not something I can do to it.");
});

test("send back needs a note", async () => {
  // intents: "csv-export" at plan-review
  await r.answer("orchestrator", 1, turn("Sure.", { action: { kind: "send-back", slug: "csv-export", note: " ", priority: null } }));
  const out = sink();
  await o.handle(message("send it back"), out.send);
  expect(out.sent.at(-1)).toBe("Tell me what should change, and I will send it back with that note.");
});
```

(The default `message()` is from the terminal with `via` "the terminal"; check `tests/chat-helpers.ts` and adjust the expected `via`.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/chat-orchestrator.test.ts -t "action"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/chat/schemas.ts`:

```ts
/** The actions chat may propose on a change (start is `accept`, above). */
export const ACTION_KINDS = ["approve", "send-back", "retry", "close", "priority", "hold", "release"] as const;

/** An action the orchestrator proposes; the runtime asks the person before submitting it. `note`: send back's note, or hold's reason. */
export const ProposedAction = z.object({
  kind: z.enum(ACTION_KINDS),
  slug: z.string(),
  note: z.string(),
  priority: z.enum(PRIORITIES).nullable(),
});
export type ProposedAction = z.infer<typeof ProposedAction>;
```

and in `OrchestratorTurn`, after `accept`: `action: ProposedAction.nullable(),`. Update its doc comment: "`handoff`, `accept` and `action` are proposals; the runtime asks a person before acting on any."

`src/chat/threads.ts`: `Pending` gains `| { kind: "action"; request: RequestBody; ask: string; by: string; at: string }` (`import type { RequestBody } from "../requests";`).

`src/chat/orchestrator.ts`:
- imports: `askText`, `offers`, `retryOptions`, `type RequestShape` from `../actions`; `humanGates`, `plainStatus`, `readIntent`, `type Status` from `../intents`; `type RequestBody` from `../requests`; `type ProposedAction` from `./schemas`;
- in `turn`, after the `accept` branch: `else if (turn.action) await this.proposeAction(cfg, trace, t, m, turn.action, say);`
- in `handle`, the yes branch: `if (pending.kind === "handoff") … else if (pending.kind === "action") await this.doAction(cfg, m, pending.request, say); else await this.doAccept(…)`; and the declined text for an action: `` `You proposed: "${pending.ask}" ${why}, so nothing was done. Propose it again if it still stands.` ``
- the two new methods:

```ts
  /** Checks an action against the change as it is now, words the question, and waits for the person's yes. */
  private async proposeAction(cfg: Config, trace: Trace, t: ThreadState, m: IncomingMessage, a: ProposedAction, say: Send): Promise<void> {
    const slug = a.slug.trim();
    if (!m.canAccept) {
      await say(`You cannot change work from here; ${m.acceptors} can. They can ask me, or edit intent/${slug}/intent.md.`);
      return;
    }
    if (!SLUG.test(slug) || !existsSync(join(this.root, "intent", slug, "intent.md"))) { await say(`There is no change called ${slug} in the main code.`); return; }
    let fm;
    try { fm = (await readIntent(this.root, slug)).file.frontmatter; } catch { await say(`${slug}'s intent.md cannot be read, so I cannot do that.`); return; }
    const offer = offers(fm, humanGates(cfg), fm.status === "blocked" ? retryOptions(trace, slug, fm.note) : []).find((o) => o.kind === a.kind);
    if (!offer) { await say(`${slug} is ${plainStatus(fm.status)} now, so that is not something I can do to it.`); return; }
    const note = a.note.trim();
    const expect = fm.status;
    let request: RequestBody;
    switch (a.kind) {
      case "send-back":
        if (!note) { await say("Tell me what should change, and I will send it back with that note."); return; }
        request = { kind: "send-back", slug, expect, note };
        break;
      case "retry": request = { kind: "retry", slug, expect: "blocked", to: offer.to as Status }; break;
      case "priority":
        if (!a.priority) { await say("Which priority: urgent, high, normal or low?"); return; }
        request = { kind: "priority", slug, expect, priority: a.priority };
        break;
      case "hold": request = { kind: "hold", slug, expect, reason: note }; break;
      default: request = { kind: a.kind, slug, expect };
    }
    const ask = askText(request as RequestShape, slug);
    t.pending = { kind: "action", request, ask, by: m.authorId, at: new Date().toISOString() };
    await say(`${ask} Reply yes to go ahead.`);
  }

  private async doAction(cfg: Config, m: IncomingMessage, request: RequestBody, say: Send): Promise<void> {
    if (!m.canAccept) { await say(`Only ${m.acceptors} can do that, so I have not.`); return; }
    submitRequest(this.root, { ...request, by: m.authorId, byName: m.authorName, via: m.via, transport: m.transport, thread: m.thread });
    await say(`Asked the loop to do it. ${this.loopWhen(cfg, "does it")}`);
  }
```

- the context line in `messageBlock` that says what the person may do: `` `From: ${name}, ${m.canAccept ? "who may ask you to start drafts and to act on changes" : `who may not start drafts or act on changes (${m.acceptors} may)`}` ``.

`templates/prompts/orchestrator.md`: replace the last two sentences of "## Starting work" ("Anything else (approving a spec, retrying a blocked change, closing one) you explain: …") with:

```
## Acting on a change

The same people can ask you to act on a change: approve a spec, plan, merge or result waiting for a person (`approve`), send it back with what should change (`send-back`, the note in `note`), retry a blocked change (`retry`), close one (`close`), set its priority (`priority`, with `priority`), hold it so the loop starts no step for it (`hold`, why in `note`), or release a hold (`release`). Set `action` to one of these, with the change's `slug`, only when they ask for it; Loopstra checks the change can do that now, asks them to confirm, and then the loop applies it and says here how it went. Never say an action happened before that answer comes back. Leave `action` null otherwise, and leave `accept` and `action` null in the same turn as each other. If the context says they cannot accept, tell them so and leave `action` null.
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/chat-orchestrator.test.ts tests/integration/chat.test.ts tests/unit/templates.test.ts && bun run typecheck`
Expected: PASS; clean. (If a templates test pins the orchestrator prompt's sha or text, update it.)

- [ ] **Step 5: Commit**

```bash
git add src/chat tests/chat-helpers.ts tests/unit/chat-orchestrator.test.ts templates/prompts/orchestrator.md
git commit -m "feat(chat): the orchestrator proposes approve, send back, retry, close, priority, hold and release"
```

---

### Task 18: documentation

**Files:**
- Modify: `README.md`, `templates/intent-README.md`, `templates/skill/SKILL.md`, `docs/decisions.md`, `docs/superpowers/specs/2026-10-17-console-design.md`

- [ ] **Step 1: Write it**

- `README.md`, the console's paragraph (the "Watch" part written in Part 1): add what a person can now do from it, in two or three sentences: approve, send back with a note, retry, start, hold, release, set priority and close a change, and pause or resume the loop; every action is a request the loop applies within a couple of seconds, refused when the change moved on, with Undo for a few seconds. Chat can do the same after a plain yes.
- `templates/intent-README.md`: where it lists the frontmatter lines a person can write, add `hold:` ("Write a reason here to hold the change: the loop starts no step for it until the line is removed. The console's Hold and Release buttons write and remove it."). Where it says how to approve or retry (by editing the status line), add one sentence that the console's buttons and chat do the same, and that editing the file still works.
- `templates/skill/SKILL.md`: if it documents the frontmatter or how a person moves a change on, add the `hold:` line and the console controls the same way; if it does not, leave it.
- `docs/decisions.md`: a section "## The console, part 2: controls (2026-10-17)" with the eight decisions at the top of this plan, each in one or two sentences, in the file's style.
- The spec, under "# Part 2: Controls": a line saying it is built, and pointing at this plan; note the two places the build differs from the text (priority, hold and release apply whatever the status now; Stop session waits for part 3).

- [ ] **Step 2: Check the docs tests**

Run: `bun test tests/unit/templates.test.ts tests/unit/templates-roundtrip.test.ts tests/unit/init.test.ts`
Expected: PASS (`init` copies `templates/intent-README.md`; a test may pin parts of it).

- [ ] **Step 3: Commit**

```bash
git add README.md templates docs
git commit -m "docs: the console's controls"
```

---

### Task 19: verify everything

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run test` → every test passes (the known flake `tests/integration/lanes.test.ts` "three changes at once through every step" under load: run that file alone to confirm, and say so if it is the only failure).
- [ ] **Step 3: In the browser** (the controller does this with the demo folder from Part 1): start `loopstra ui` on a demo repository with a running loop and changes at plan-review, blocked and building; then:
  - approve from the change page: the toast offers Undo, the change moves on within a few seconds, Activity says "Plan approved by <you> from the dashboard.";
  - Undo straight away: "Cancelled; nothing changed.";
  - send back with a note: the change goes back a step, and the note is on it;
  - retry a blocked change;
  - hold and release from the change page; the board shows Held;
  - pause the loop from the top bar: the pill says "Paused by <you>", the inbox has the pause, no new step starts; resume;
  - press A in the inbox on a plan-review item;
  - at 375 px wide the controls wrap with no sideways scroll, in dark and light;
  - no console errors.
