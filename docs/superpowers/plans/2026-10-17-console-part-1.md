# Console (part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `loopstra ui`'s one-page dashboard with the console from `docs/superpowers/specs/2026-10-17-console-design.md` (part 1): a fast Preact app with live streams of every running agent, an inbox, a board of changes, per-change pages, session transcripts, activity, spend and the orchestrator in a drawer. Read-only apart from chat, as today.

**Architecture:** The server side lives in `src/console/`: a model of five sections built from the intent files, the trace and the heartbeat; a hub that watches for changes and pushes only the sections that changed over one SSE stream; a session stream that turns a phase's `raw.jsonl` into transcript items; and read endpoints for a change, its diff, activity and spend. The page lives in `src/ui/`: `Bun.serve` bundles `index.html` and its TSX at start-up (an HTML import), so there is no build step. Pure logic (routing, keys, the palette's matching, diffs, Markdown, the store's reducer) is in plain `.ts` files with unit tests; views are thin `.tsx` files over it.

**Tech Stack:** Bun 1.4.2 (`Bun.serve` routes with HTML imports, `bun:test`, `bun:sqlite`), TypeScript, Preact 10 with `@preact/signals` 2, `marked` 16, hand-written CSS.

**Where:** the worktree `C:\Source\Repos\loopstra-console`, branch `feat/console` (made from `main` at `4c36646`). Run every command from that folder. Another session works on `feat/simpler-core` in `C:\Source\Repos\loopstra`; do not touch that checkout.

---

## Facts this plan relies on (checked with Bun 1.4.2 before writing it)

- `import page from "../ui/index.html"` gives an `HTMLBundle`. In `Bun.serve({ routes: { "/": page, "/c/*": page }, fetch })` with `development: false`, Bun bundles and minifies the page's `<script type="module" src="./app.tsx">` and `<link rel="stylesheet">` once, serves them at `/chunk-<hash>.js` and `.css` itself, and sends every path the routes do not match to `fetch`. Requests for the page and its chunks never reach `fetch`.
- The JSX settings come from the nearest `tsconfig.json` (`"jsx": "react-jsx", "jsxImportSource": "preact"`).
- `Bun.build({ entrypoints: ["src/ui/index.html"], minify: true })` works inside `bun test`. Preact, signals and marked together come to about 20 KB gzipped.
- `Bun.serve` closes a connection after 10 s with nothing sent (`idleTimeout`). An SSE response calls `server.timeout(req, 0)` to lift that for its own request.
- `new URL(req.url).hostname` is taken from the request's Host header (`evil.test`, `[::1]`).
- `marked`'s `Marked` instance accepts renderer overrides for `html`, `link` and `image` (token objects; `this.parser.parseInline(token.tokens)` renders a link's text).
- The CLI's `stream-json` lines look like this (from a real build session): `assistant` events with `message.content` blocks of `text`, `thinking` and `tool_use` (`id`, `name`, `input`); `user` events with `tool_result` blocks (`tool_use_id`, `content` as a string or an array of `{type:"text",text}`, `is_error`); `system` events (`init` with `cwd` and `model`, `permission_denied` with `tool_use_id` and `message`, plus `thinking_tokens`, `task_*` and `hook_*`, which are not shown); `rate_limit_event`; `tool_progress`; and `result` (`subtype`, `is_error`, `total_cost_usd`, `structured_output`).

## File structure

**New, server side (`src/console/`):**

| File | Responsibility |
|---|---|
| `src/tools.ts` | A tool call's target in one line, and what a session is doing in words. Shared by the trace's session summaries and the transcript. |
| `src/console/types.ts` | Every shape the server sends and the page reads. Types and plain constants only: the page imports it. |
| `src/console/describe.ts` | Trace events as plain sentences for Activity; pages of events. |
| `src/console/transcript.ts` | Raw `stream-json` events to transcript items; reading `raw.jsonl` from a byte offset. |
| `src/console/model.ts` | The five sections (`loop`, `inbox`, `changes`, `running`, `totals`). |
| `src/console/files.ts` | `resolveRunFile` and `resolveDocument`, moved from `src/commands/ui.ts`. |
| `src/console/detail.ts` | One change's page data, and the Spend screen's figures. |
| `src/console/diff.ts` | A change's branch against main, cut to a size limit. |
| `src/console/hub.ts` | The live stream: watching, rebuilding, sending what changed. |
| `src/console/session.ts` | One phase's transcript as a stream. |
| `src/console/server.ts` | Routes, the Host check, SSE responses. |

**New, page (`src/ui/`):** `index.html`, `theme.css`, `app.tsx`; pure modules `format.ts`, `router.ts`, `keys.ts`, `palette.ts`, `diff.ts`, `markdown.ts`, `transcript.ts`, `store.ts`; DOM helpers `nav.ts`, `shortcuts.ts`, `theme.ts`, `alerts.ts`; components in `parts/` (`Link`, `Icon`, `TopBar`, `Rail`, `Toasts`, `Palette`, `Help`, `Markdown`, `Diff`, `Transcript`, `Drawer`) and screens in `views/` (`Live`, `Session`, `Inbox`, `Changes`, `Change`, `Activity`, `Spend`).

**Changed:** `package.json`, `tsconfig.json`, `src/trace.ts` (queries), `src/phases.ts` (summaries keep tool targets and the model), `src/intents.ts` (`waitNote`), `src/commands/ui.ts` (becomes the command only), `src/cli.ts`, `README.md`, `docs/decisions.md`, `tests/unit/chat-transports.test.ts`.

**Removed:** the old `src/ui/index.html` page (the path is reused by the new one), `buildState` and `/api/state`, `tests/unit/ui.test.ts` (its tests move to the new console test files).

**New tests:** `tests/console-helpers.ts`; `tests/unit/console-trace.test.ts`, `tools.test.ts`, `console-describe.test.ts`, `console-transcript.test.ts`, `console-model.test.ts`, `console-detail.test.ts`, `console-diff.test.ts`, `console-hub.test.ts`, `console-session.test.ts`, `console-server.test.ts`, `ui-logic.test.ts`, `console-page.test.ts`.

## Conventions to follow

- Comments are plain sentences that say why, in the style of the surrounding code. No comment restates the code.
- Owner-facing words are plain: no branch names, no commands, no raw output.
- Every test that makes a temp folder cleans it up in `finally`; every `Trace.open` is closed.
- Commit after each task with the message given, ending with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (pass it as a second `-m`).
- `bun run test` runs the suite in shards; `bun test <file>` runs one file. `bun run typecheck` must stay clean.

---

### Task 1: Workspace and dependencies

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Install and check the starting point**

Run: `bun install && bun run typecheck && bun run test`
Expected: typecheck prints nothing; the suite ends with `... pass, 0 fail`.

- [ ] **Step 2: Add the page's dependencies**

Run: `bun add preact@10.29.8 @preact/signals@2.11.3 marked@16.4.2`
Expected: `package.json` `dependencies` now lists `"@preact/signals": "^2.11.3"`, `"marked": "^16.4.2"`, `"preact": "^10.29.8"` beside `yaml` and `zod`, and `bun.lock` is updated.

- [ ] **Step 3: Tell TypeScript and Bun's bundler how JSX compiles**

Replace `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun-types"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 4: Check nothing changed for the existing code**

Run: `bun run typecheck`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tsconfig.json
git commit -m "build(console): add preact, signals and marked; compile JSX for preact" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Trace queries for the console

**Files:**
- Modify: `src/trace.ts` (add methods to `class Trace`, after `recentEvents`)
- Test: `tests/unit/console-trace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-trace.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("trace queries for the console", () => {
  test("the newest event id, pages of older events, events after an id, and one phase's events", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      expect(trace.lastEventId()).toBe(0);
      const a = trace.phaseStart("one", "build", "agent"); // event 1
      trace.event("one", "claude_event", { type: "system", subtype: "init", model: "m" }, a); // 2
      trace.event("one", "claude_event", { type: "assistant", items: ["tool:Bash"] }, a); // 3
      trace.event("two", "tick", {}); // 4
      trace.phaseEnd("one", a, { status: "success", costUsd: 0.5 }); // 5
      expect(trace.lastEventId()).toBe(5);
      expect(trace.eventsBefore(0, 2).map((e) => e.id)).toEqual([5, 4]);
      expect(trace.eventsBefore(4, 10).map((e) => e.id)).toEqual([3, 2, 1]);
      expect(trace.eventsBefore(0, 10, "two").map((e) => e.id)).toEqual([4]);
      expect(trace.eventsAfter(2, 2).map((e) => e.id)).toEqual([3, 4]);
      expect(trace.phaseEvents("one", a, 2).map((e) => e.id)).toEqual([3, 5]);
      expect(trace.firstEvent("one", a, "claude_event")?.id).toBe(2);
      expect(trace.phase("one", a)).toMatchObject({ name: "build", status: "success", cost_usd: 0.5 });
      expect(trace.phase("one", 99)).toBeNull();
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("every phase in the order they started, and the newest ended ones first", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const a = trace.phaseStart("one", "build", "agent");
      trace.phaseEnd("one", a, { status: "success" });
      trace.phaseStart("two", "design", "agent");
      const c = trace.phaseStart("_chat", "orchestrator", "agent");
      trace.phaseEnd("_chat", c, { status: "success" });
      expect(trace.allPhases().map((p) => p.slug)).toEqual(["one", "two", "_chat"]);
      expect(trace.recentPhases(5).map((p) => p.slug)).toEqual(["_chat", "one"]);
      expect(trace.recentPhases(1).map((p) => p.slug)).toEqual(["_chat"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-trace.test.ts`
Expected: FAIL with `trace.lastEventId is not a function`.

- [ ] **Step 3: Add the queries**

In `src/trace.ts`, inside `class Trace`, directly after the `recentEvents` method, add:

```ts
  /** The newest event's id, or 0 when there is none. */
  lastEventId(): number {
    return this.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0;
  }

  /** Up to `limit` events after `afterId`, oldest first. */
  eventsAfter(afterId: number, limit: number): EventRow[] {
    return this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, limit);
  }

  /** Up to `limit` events older than `beforeId` (any, when it is 0), newest first; only one slug's when given. */
  eventsBefore(beforeId: number, limit: number, slug?: string): EventRow[] {
    const before = beforeId > 0 ? beforeId : Number.MAX_SAFE_INTEGER;
    return slug
      ? this.db.query<EventRow, [string, number, number]>("SELECT * FROM events WHERE slug = ? AND id < ? ORDER BY id DESC LIMIT ?").all(slug, before, limit)
      : this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit);
  }

  /** The newest `limit` events of one phase, oldest first. */
  phaseEvents(slug: string, seq: number, limit: number): EventRow[] {
    return this.db.query<EventRow, [string, number, number]>(
      "SELECT * FROM events WHERE slug = ? AND phase_seq = ? ORDER BY id DESC LIMIT ?").all(slug, seq, limit).reverse();
  }

  /** The first event of a type in one phase, or null. */
  firstEvent(slug: string, seq: number, type: EventType): EventRow | null {
    return this.db.query<EventRow, [string, number, string]>(
      "SELECT * FROM events WHERE slug = ? AND phase_seq = ? AND type = ? ORDER BY id LIMIT 1").get(slug, seq, type) ?? null;
  }

  /** One phase, or null. */
  phase(slug: string, seq: number): PhaseRow | null {
    return this.db.query<PhaseRow, [string, number]>("SELECT * FROM phases WHERE slug = ? AND seq = ?").get(slug, seq) ?? null;
  }

  /** Every phase of every slug (chat's too), in the order they started. */
  allPhases(): PhaseRow[] {
    return this.db.query<PhaseRow, []>("SELECT * FROM phases ORDER BY started, rowid").all();
  }

  /** The newest `limit` ended phases of any slug, newest first. */
  recentPhases(limit: number): PhaseRow[] {
    return this.db.query<PhaseRow, [number]>("SELECT * FROM phases WHERE ended IS NOT NULL ORDER BY ended DESC, rowid DESC LIMIT ?").all(limit);
  }
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/unit/console-trace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/trace.ts tests/unit/console-trace.test.ts
git commit -m "feat(console): trace queries for the newest events, pages of older ones and a phase's own" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tool targets, and session summaries that keep them

The Live screen's "now:" line ("Running bun test") reads the `claude_event` rows the loop already writes. Today they keep only the tool's name, so the summary gains each tool's target, and the init event keeps the model.

**Files:**
- Create: `src/tools.ts`
- Modify: `src/phases.ts:429` (the `summarize` call) and `src/phases.ts:519-526` (`summarize`)
- Test: `tests/unit/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { summarize } from "../../src/phases";
import { nowText, relativePath, toolTarget } from "../../src/tools";

describe("tool calls in a few words", () => {
  test("a tool call's target: the command's first line, the file, the pattern", () => {
    expect(toolTarget("Bash", { command: "bun test\nmore" })).toBe("bun test");
    expect(toolTarget("Edit", { file_path: "C:\\repo\\wt\\src\\a.ts" }, "C:\\repo\\wt")).toBe("src/a.ts");
    expect(toolTarget("Read", { file_path: "/home/x/wt/README.md" }, "/home/x/wt/")).toBe("README.md");
    expect(toolTarget("Read", { file_path: "/elsewhere/a.md" }, "/home/x/wt")).toBe("/elsewhere/a.md");
    expect(toolTarget("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolTarget("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(toolTarget("Mystery", { x: 1 })).toBe("");
    expect(toolTarget("Bash", null)).toBe("");
    expect(toolTarget("Bash", { command: "x".repeat(200) })).toHaveLength(120);
    expect(relativePath("", "/wt")).toBe("");
  });

  test("what a session is doing, in words", () => {
    expect(nowText("Bash", "bun test")).toBe("Running bun test");
    expect(nowText("Edit", "src/a.ts")).toBe("Editing src/a.ts");
    expect(nowText("TodoWrite", "")).toBe("Updating its todo list");
    expect(nowText("Frobnicate", "")).toBe("Using Frobnicate");
  });

  test("the trace's session summary keeps each tool's target and the session's model", () => {
    expect(summarize({ type: "assistant", message: { content: [
      { type: "text", text: "Looking" },
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
      { type: "thinking" },
    ] } }, "/wt")).toEqual({ type: "assistant", items: ["text:Looking", "tool:Bash", "thinking"], targets: ["", "bun test", ""] });
    expect(summarize({ type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/wt" })).toEqual({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
    expect(summarize({ type: "result", subtype: "success", total_cost_usd: 0.2 })).toEqual({ type: "result", subtype: "success", cost: 0.2 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/tools.test.ts`
Expected: FAIL: `Cannot find module '../../src/tools'`.

- [ ] **Step 3: Write `src/tools.ts`**

```ts
/** The longest target shown for one tool call. */
const TARGET_MAX = 120;

/** `path` relative to `cwd` when it lies inside it, with forward slashes; otherwise `path` as it is. */
export function relativePath(path: string, cwd?: string): string {
  if (!path) return "";
  const p = path.replaceAll("\\", "/");
  const base = cwd?.replaceAll("\\", "/").replace(/\/+$/, "");
  // Case-blind, so a Windows drive letter written either way still matches; this is for display only.
  if (base && p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return p.slice(base.length + 1);
  return p;
}

/** What a tool call works on, in one short line: the command, the file, the pattern. "" when nothing fits. */
export function toolTarget(name: string, input: unknown, cwd?: string): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let target: string;
  switch (name) {
    case "Bash": target = str(i.command).split(/\r?\n/)[0] ?? ""; break;
    case "Read": case "Edit": case "MultiEdit": case "Write": target = relativePath(str(i.file_path), cwd); break;
    case "NotebookEdit": target = relativePath(str(i.notebook_path), cwd); break;
    case "Grep": case "Glob": target = str(i.pattern); break;
    case "WebFetch": target = str(i.url); break;
    case "WebSearch": target = str(i.query); break;
    case "Task": case "Agent": target = str(i.description); break;
    case "Skill": target = str(i.skill); break;
    default: target = "";
  }
  return target.length > TARGET_MAX ? `${target.slice(0, TARGET_MAX - 1)}…` : target;
}

const VERBS: Record<string, string> = {
  Bash: "Running", Read: "Reading", Edit: "Editing", MultiEdit: "Editing", Write: "Writing", NotebookEdit: "Editing",
  Grep: "Searching for", Glob: "Looking for", WebFetch: "Fetching", WebSearch: "Searching the web for",
  Task: "Handing off", Agent: "Handing off", Skill: "Using the skill", TodoWrite: "Updating its todo list",
  StructuredOutput: "Writing its answer",
};

/** What a session is doing, from its newest tool call: "Running bun test", "Editing src/a.ts". */
export function nowText(tool: string, target: string): string {
  const verb = VERBS[tool] ?? `Using ${tool}`;
  return target ? `${verb} ${target}` : verb;
}
```

- [ ] **Step 4: Make `summarize` keep targets and the model**

In `src/phases.ts`, add `import { toolTarget } from "./tools";` beside the other imports, and replace the `summarize` function (lines 519-526) with:

```ts
/** A raw session event, cut down for the trace: tools with their targets, text, the model, the result. */
export function summarize(e: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  if (e.type === "assistant") {
    const content = (e as { message?: { content?: Array<{ type: string; name?: string; text?: string; input?: unknown }> } }).message?.content ?? [];
    return {
      type: "assistant",
      items: content.map((c) => c.type === "tool_use" ? `tool:${c.name}` : c.type === "text" ? `text:${(c.text ?? "").slice(0, 120)}` : c.type),
      targets: content.map((c) => c.type === "tool_use" ? toolTarget(c.name ?? "", c.input, cwd) : ""),
    };
  }
  if (e.type === "result") return { type: "result", subtype: e.subtype, cost: e.total_cost_usd };
  if (e.type === "system" && e.subtype === "init") return { type: "system", subtype: "init", model: typeof e.model === "string" ? e.model : null };
  return { type: e.type, subtype: e.subtype };
}
```

and change the call at line 429 from `summarize(e)` to `summarize(e, spec.cwd ?? ctx.root)`:

```ts
        if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e, spec.cwd ?? ctx.root), seq);
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/tools.test.ts tests/unit/phases.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts src/phases.ts tests/unit/tools.test.ts
git commit -m "feat(console): session summaries keep each tool's target and the session's model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The console's shared types

**Files:**
- Create: `src/console/types.ts`

- [ ] **Step 1: Write the types**

Create `src/console/types.ts`:

```ts
import type { AttentionItem } from "../attention";
import type { JudgesView } from "../commands/judges";
import type { LoopStatus } from "../heartbeat";

/*
 * What the console's server sends and its page reads. Only types and plain constants live here: the
 * page imports this file, so it must never pull in server code (type-only imports are erased).
 */

/** A board column: where a change is, or is heading next. */
export type Stage = "draft" | "design" | "plan" | "build" | "review" | "merge" | "verify" | "done" | "blocked" | "closed";

export interface ChangeSummary {
  slug: string; title: string; status: string; plain: string; priority: string; stage: Stage;
  /** When the change entered its status (best known), and how long ago in words ("2 h"). */
  since: string | null; inStatus: string | null;
  /** What its ended phases cost. */
  costUsd: number;
  /** Why it waits for other changes, in plain words, or null. */
  waiting: string | null;
  /** Its own note from intent.md. */
  note: string;
  /** A step of it is running now. */
  running: boolean;
}

export interface RunningPhase {
  slug: string; title: string; seq: number; name: string;
  /** The model the session runs on, from its first event; null until it has said. */
  model: string | null;
  started: string;
  /** What it is doing, in a few words: "Running bun test", "Editing src/parser.ts". */
  now: string;
  /** Its newest activity, oldest first: one entry per tool call, piece of text, or result. */
  strip: Array<"tool" | "text" | "result">;
}

export interface FinishedPhase {
  slug: string; seq: number; name: string; status: string; ended: string; durationMs: number; costUsd: number;
}

export interface LoopSection extends LoopStatus {
  /** When the next tick is due while the loop sleeps between ticks; null otherwise. */
  nextCheck: string | null;
}

export interface Totals { todayUsd: number; weekUsd: number; allUsd: number }

export interface Sections {
  loop: LoopSection;
  inbox: AttentionItem[];
  changes: ChangeSummary[];
  running: { now: RunningPhase[]; recent: FinishedPhase[] };
  totals: Totals;
}
export type SectionName = keyof Sections;
export const SECTION_NAMES: readonly SectionName[] = ["loop", "inbox", "changes", "running", "totals"];

export interface Meta {
  /** Whether this console has the orchestrator's chat. */
  chat: boolean;
  /** The rate a running session's cost is estimated at. */
  usdPerMinute: number;
  pollSeconds: number;
}

/** One trace event for Activity: in plain words (null when it only matters to an engineer), and as a technical line. */
export interface ActivityItem { id: number; slug: string; seq: number | null; ts: string; type: string; text: string | null; technical: string }

/** A message on /api/stream. */
export type StreamMessage =
  | { type: "snapshot"; meta: Meta; sections: Sections }
  | { type: "section"; name: SectionName; value: Sections[SectionName] }
  | { type: "event"; item: ActivityItem };

export interface PhaseView {
  seq: number; name: string; kind: string; status: string; started: string; ended: string | null;
  /** Ended minus started; for a running phase, so far. */
  durationMs: number; costUsd: number; error: string | null;
  files: Array<{ name: string; url: string }>;
  /** Commands the session was not allowed to run (allow-rule text). */
  denied: string[];
}

export interface ChangeDetail extends ChangeSummary {
  dependsOn: string[];
  /** The change's own documents in intent/<slug>/, served read-only. */
  documents: Array<{ name: string; url: string }>;
  phases: PhaseView[];
  gates: Array<{ gate: string; check: string; result: string; evidence: string; ts: string }>;
}

export type TranscriptItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; tool: string; target: string; input: unknown }
  | { kind: "tool-result"; id: string; ok: boolean; output: string }
  | { kind: "edit"; id: string; tool: string; path: string; diff: string }
  | { kind: "todos"; items: Array<{ text: string; state: string }> }
  | { kind: "result"; ok: boolean; summary: string; costUsd: number | null };

/** A message on /api/sessions/<slug>/<seq>/stream. */
export type SessionMessage =
  | { type: "phase"; name: string; status: string; started: string; ended: string | null }
  | { type: "item"; item: TranscriptItem }
  | { type: "end" };

export interface DiffView {
  /** False when the change has no branch (not built yet, or merged and cleaned up). */
  exists: boolean;
  stat: string;
  patch: string;
  /** The patch was cut at the size limit. */
  cut: boolean;
}

export interface SpendView {
  totals: Totals;
  chatUsd: number;
  perChange: Array<{ slug: string; title: string; costUsd: number }>;
  perPhase: Array<{ name: string; costUsd: number; count: number }>;
  /** The last 48 hours, oldest first, one entry per hour (its start, ISO). */
  byHour: Array<{ hour: string; costUsd: number }>;
  judges: JudgesView | null;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/console/types.ts
git commit -m "feat(console): the shapes the console's server sends and its page reads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Trace events in plain words

**Files:**
- Create: `src/console/describe.ts`
- Test: `tests/unit/console-describe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-describe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { activityItem, describeEvent, eventsPage, phaseNamer, technicalText } from "../../src/console/describe";
import { Trace, type EventRow } from "../../src/trace";
import { tempDir } from "../helpers";

const row = (type: string, payload: unknown, over: Partial<EventRow> = {}): EventRow => ({
  id: 1, slug: "csv-export", phase_seq: null, type: type as EventRow["type"], ts: "2026-10-17T12:00:00.000Z", payload: JSON.stringify(payload), ...over,
});

describe("events in plain words", () => {
  test("each kind an owner cares about reads as a sentence; ticks and raw session events do not", () => {
    expect(describeEvent(row("status_change", { from: "plan-approved", to: "building", note: "" }))).toBe("Building and testing.");
    expect(describeEvent(row("phase_start", { name: "build", kind: "agent" }))).toBe("Started build.");
    expect(describeEvent(row("phase_end", { status: "success", cost_usd: 0.42, error: null }, { phase_seq: 3 }), () => "build")).toBe("Build passed ($0.42).");
    expect(describeEvent(row("phase_end", { status: "fail", cost_usd: 0, error: "agent-fail: tests failed\nmore" }, { phase_seq: 3 }), () => "fix-1"))
      .toBe("Fix-1 failed: agent-fail: tests failed.");
    expect(describeEvent(row("phase_end", { status: "interrupted", cost_usd: 0 }))).toBe("A step was interrupted.");
    expect(describeEvent(row("gate_check", { gate: "spec", check: "headings", result: "pass", evidence: "" }))).toBe("Spec gate, headings: passed.");
    expect(describeEvent(row("command", { command: "bun test", code: 0 }))).toBe("Ran bun test.");
    expect(describeEvent(row("command", { command: "bun test", code: 1, lastLine: "x" }))).toBe("Ran bun test: exit code 1.");
    expect(describeEvent(row("command", { command: "bun test", note: "stopped" }))).toBe("Stopped bun test.");
    expect(describeEvent(row("signal", { name: "main_health", result: "fail", output: "" }, { slug: "_signals" }))).toBe("The tests on main fail.");
    expect(describeEvent(row("error", { where: "scan", problem: "The status line is wrong" }))).toBe("Problem (scan): The status line is wrong");
    expect(describeEvent(row("pause", { reason: "The assistant is unavailable." }))).toBe("Paused: The assistant is unavailable.");
    expect(describeEvent(row("chat-request", { kind: "accept", by: "ana", result: "accepted" }))).toBe("ana accepted it from chat.");
    expect(describeEvent(row("tick", {}))).toBeNull();
    expect(describeEvent(row("claude_event", { type: "assistant" }))).toBeNull();
  });

  test("the technical line is the type and the payload's fields on one line", () => {
    expect(technicalText(row("command", { command: "bun test\n--bail", code: 0 }))).toBe("command command=bun test --bail code=0");
    expect(technicalText(row("tick", {}))).toBe("tick");
    expect(activityItem(row("tick", {}))).toEqual({ id: 1, slug: "csv-export", seq: null, ts: "2026-10-17T12:00:00.000Z", type: "tick", text: null, technical: "tick" });
  });

  test("phases are named from the trace, and pages of activity go back in time", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      trace.event("_loop", "tick", {});
      trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
      const name = phaseNamer(trace);
      expect(name("one", seq)).toBe("build");
      expect(name("one", 99)).toBeUndefined();

      const plain = eventsPage(trace, 0, undefined, false);
      expect(plain.items.map((a) => a.text)).toEqual(["Build passed ($0.10).", "Started build."]);
      expect(plain.next).toBeNull();
      expect(eventsPage(trace, 0, undefined, true).items.map((a) => a.type)).toEqual(["phase_end", "tick", "phase_start"]);
      expect(eventsPage(trace, 0, "_loop", true).items.map((a) => a.type)).toEqual(["tick"]);
      const newest = eventsPage(trace, 0, undefined, true).items[0]!.id;
      expect(eventsPage(trace, newest, undefined, true).items.map((a) => a.type)).toEqual(["tick", "phase_start"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-describe.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/describe'`.

- [ ] **Step 3: Write `src/console/describe.ts`**

```ts
import { plainStatus, STATUSES, type Status } from "../intents";
import type { EventRow, Trace } from "../trace";
import type { ActivityItem } from "./types";

type Payload = Record<string, unknown>;

function parse(text: string): Payload {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : { value: v };
  } catch {
    return { value: text };
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const plain = (v: unknown): string => ((STATUSES as readonly string[]).includes(str(v)) ? plainStatus(str(v) as Status) : str(v));
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const money = (v: unknown): string => (typeof v === "number" && v >= 0.005 ? ` ($${v.toFixed(2)})` : "");
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The first non-blank line of `v`, cut to `n` characters. */
function firstLine(v: unknown, n = 160): string {
  const line = str(v).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

const ENDED: Record<string, string> = { success: "passed", fail: "failed", interrupted: "was interrupted" };
const HEALTH: Record<string, string> = { pass: "pass", fail: "fail", error: "could not be checked", waiting: "are waiting" };
const GATE: Record<string, string> = { pass: "passed", fail: "failed", waiting: "waiting" };

/**
 * An event in plain words, for the console's Activity, or null when it only matters to an engineer
 * (ticks, raw session events). `phaseName` names the phase an event belongs to.
 */
export function describeEvent(e: EventRow, phaseName: (slug: string, seq: number) => string | undefined = () => undefined): string | null {
  const p = parse(e.payload);
  switch (e.type) {
    case "status_change": return `${capital(plain(p.to))}.`;
    case "phase_start": return `Started ${str(p.name)}.`;
    case "phase_end": {
      const name = e.phase_seq !== null ? phaseName(e.slug, e.phase_seq) : undefined;
      const why = p.status === "fail" && p.error ? `: ${firstLine(p.error)}` : "";
      return sentence(`${capital(name ?? "a step")} ${ENDED[str(p.status)] ?? str(p.status)}${money(p.cost_usd)}${why}`);
    }
    case "gate_check": return `${capital(str(p.gate))} gate, ${str(p.check)}: ${GATE[str(p.result)] ?? str(p.result)}.`;
    case "command":
      if (p.note) return `Stopped ${firstLine(p.command, 80)}.`;
      return p.code === 0 ? `Ran ${firstLine(p.command, 80)}.` : `Ran ${firstLine(p.command, 80)}: exit code ${str(p.code)}.`;
    case "error": return `Problem${p.where ? ` (${str(p.where)})` : ""}: ${firstLine(p.what ?? p.problem ?? p.error ?? p.value)}`;
    case "signal":
      if (p.name === "main_health") return `The tests on main ${HEALTH[str(p.result)] ?? str(p.result)}.`;
      return p.output ? firstLine(p.output) : `${str(p.name)}: ${str(p.result)}.`;
    case "stop": return "The loop is stopping.";
    case "pause": return `Paused: ${firstLine(p.reason)}`;
    case "person-changed-status": return `A person set the status to ${plain(p.to)} while a step ran, so the step wrote nothing.`;
    case "stale-lock-removed": return "Removed a lock a stopped process left behind.";
    case "chat-message": return `${str(p.from) || "Someone"} wrote in chat.`;
    case "chat-request":
      if (p.result === "accepted") return `${str(p.by)} accepted it from chat.`;
      return p.kind === "new" ? `Chat wrote this change up for ${str(p.by)}.` : `A chat request was not applied (${str(p.result)}).`;
    case "chat-pr": return "Chat's pull request of new intents changed.";
    case "judge": return firstLine(p.note) || null;
    default: return null;
  }
}

/** The event as one technical line: its type and its payload's fields, like `loopstra tail`. */
export function technicalText(e: EventRow): string {
  const fields = Object.entries(parse(e.payload))
    .filter(([k]) => k !== "stack")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ").replace(/\s*\r?\n\s*/g, " ");
  const line = `${e.type} ${fields}`.trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

export function activityItem(e: EventRow, phaseName?: (slug: string, seq: number) => string | undefined): ActivityItem {
  return { id: e.id, slug: e.slug, seq: e.phase_seq, ts: e.ts, type: e.type, text: describeEvent(e, phaseName), technical: technicalText(e) };
}

/** Names phases by change and seq, reading a change's phases again only when it meets a seq it has not seen. */
export function phaseNamer(trace: Trace): (slug: string, seq: number) => string | undefined {
  const known = new Map<string, Map<number, string>>();
  return (slug, seq) => {
    let names = known.get(slug);
    if (!names?.has(seq)) {
      names = new Map(trace.phases(slug).map((p) => [p.seq, p.name]));
      known.set(slug, names);
    }
    return names.get(seq);
  };
}

/** How many items one page of Activity holds, and how many events one request reads at most. */
const PAGE = 200;
const SCAN = 2_000;

/**
 * A page of Activity, newest first: up to 200 items older than `before` (from the newest, when 0),
 * only those in plain words unless `technical`, optionally of one slug. `next` is the `before` of
 * the following page, or null at the start of the trace.
 */
export function eventsPage(trace: Trace, before: number, slug: string | undefined, technical: boolean): { items: ActivityItem[]; next: number | null } {
  const name = phaseNamer(trace);
  const items: ActivityItem[] = [];
  let cursor = before;
  for (let scanned = 0; scanned < SCAN && items.length < PAGE;) {
    const rows = trace.eventsBefore(cursor, PAGE, slug);
    if (!rows.length) return { items, next: null };
    for (const e of rows) {
      cursor = e.id;
      const a = activityItem(e, name);
      if (technical || a.text !== null) items.push(a);
      if (items.length >= PAGE) break;
    }
    scanned += rows.length;
  }
  return { items, next: cursor };
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/unit/console-describe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/console/describe.ts tests/unit/console-describe.test.ts
git commit -m "feat(console): trace events in plain words, and pages of activity" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Session transcripts

**Files:**
- Create: `src/console/transcript.ts`
- Test: `tests/unit/console-transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-transcript.test.ts`. The raw events are modelled on a real build session's `raw.jsonl` (same shapes, made-up content):

```ts
import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_MAX, toItems, TranscriptReader } from "../../src/console/transcript";
import type { TranscriptItem } from "../../src/console/types";
import { tempDir } from "../helpers";

const CWD = "C:\\repo\\.loopstra\\worktrees\\csv";
const RAW: Array<Record<string, unknown>> = [
  { type: "system", subtype: "init", cwd: CWD, session_id: "s", model: "claude-sonnet-5-5" },
  { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Reading the parser first." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: `${CWD}\\src\\csv.ts` } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export function parse() {}" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${CWD}\\src\\csv.ts`, old_string: "a\nb", new_string: "a\nc" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok" }] }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [{ content: "Write tests", status: "completed", activeForm: "x" }, { content: "Ship", status: "in_progress" }] } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "bun test" } }] } },
  { type: "system", subtype: "permission_denied", tool_use_id: "t4", message: "Contains simple_expansion" },
  { type: "rate_limit_event", rate_limit_info: {} },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t5", name: "StructuredOutput", input: { status: "success" } }] } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, structured_output: { status: "success", summary: "Added the export." } },
];

const EXPECTED: TranscriptItem[] = [
  { kind: "text", text: "Reading the parser first." },
  { kind: "tool", id: "t1", tool: "Read", target: "src/csv.ts", input: { file_path: `${CWD}\\src\\csv.ts` } },
  { kind: "tool-result", id: "t1", ok: true, output: "export function parse() {}" },
  { kind: "edit", id: "t2", tool: "Edit", path: "src/csv.ts", diff: "--- src/csv.ts\n+++ src/csv.ts\n@@ edit @@\n-a\n-b\n+a\n+c" },
  { kind: "tool-result", id: "t2", ok: true, output: "ok" },
  { kind: "todos", items: [{ text: "Write tests", state: "completed" }, { text: "Ship", state: "in_progress" }] },
  { kind: "tool", id: "t4", tool: "Bash", target: "bun test", input: { command: "bun test" } },
  { kind: "tool-result", id: "t4", ok: false, output: "Not allowed: Contains simple_expansion" },
  { kind: "result", ok: true, summary: "Added the export.", costUsd: 0.42 },
];

const jsonl = (events: Array<Record<string, unknown>>) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

describe("session transcripts", () => {
  test("raw events become items; thinking, hooks, limits and the answer tool are left out", () => {
    expect(RAW.flatMap((e) => toItems(e, CWD))).toEqual(EXPECTED);
  });

  test("a written file shows its first 400 lines; a long output is cut; a failed session's result says so", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const [write] = toItems({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/wt/a.txt", content } }] } }, "/wt");
    expect(write).toMatchObject({ kind: "edit", path: "a.txt" });
    const diff = (write as Extract<TranscriptItem, { kind: "edit" }>).diff.split("\n");
    expect(diff.slice(0, 3)).toEqual(["--- a.txt", "+++ a.txt", "@@ new file @@"]);
    expect(diff.filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toHaveLength(400);
    expect(diff.at(-1)).toBe("\\ 100 more lines");
    const [big] = toItems({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "x".repeat(OUTPUT_MAX + 10), is_error: true }] } });
    expect(big).toMatchObject({ kind: "tool-result", ok: false });
    expect((big as { output: string }).output.endsWith("… (cut)")).toBe(true);
    expect(toItems({ type: "result", subtype: "error_max_turns", is_error: true, result: "Too many turns" }))
      .toEqual([{ kind: "result", ok: false, summary: "Too many turns", costUsd: null }]);
  });

  test("the reader goes line by line from an offset, waits for a line to be finished, and knows the session's folder", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      const reader = new TranscriptReader(path);
      expect(reader.read()).toEqual([]);
      expect(reader.atEnd()).toBe(true);
      writeFileSync(path, jsonl(RAW.slice(0, 4)));
      const first = reader.read();
      expect(first.map((r) => r.item)).toEqual(EXPECTED.slice(0, 3));
      expect(first[0]!.offset).toBe(first[1]!.offset); // two items from one line share its end
      expect(first[2]!.offset).toBeGreaterThan(first[1]!.offset);
      expect(reader.atEnd()).toBe(true);

      const line = JSON.stringify(RAW[4]);
      appendFileSync(path, line.slice(0, 20));
      expect(reader.read()).toEqual([]);
      expect(reader.atEnd()).toBe(false);
      appendFileSync(path, `${line.slice(20)}\n`);
      expect(reader.read().map((r) => r.item)).toEqual([EXPECTED[3]]);

      // A reader started part way still shortens paths: it reads the init line first.
      const later = new TranscriptReader(path, first[2]!.offset);
      expect(later.read().map((r) => r.item)).toEqual([EXPECTED[3]]);
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-transcript.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/transcript'`.

- [ ] **Step 3: Write `src/console/transcript.ts`**

```ts
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { relativePath, toolTarget } from "../tools";
import type { TranscriptItem } from "./types";

/** The longest tool output one item carries. */
export const OUTPUT_MAX = 256 * 1024;
/** The most lines of a written file shown as an edit. */
const WRITE_LINES = 400;
/** The most of a raw file one read takes. */
const READ_MAX = 4 * 1024 * 1024;

type Raw = Record<string, unknown>;
type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function cut(text: string): string {
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n… (cut)` : text;
}

/** A tool result's content as text: a string, or the text parts of a list. */
function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Block[]).map((c) => (c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

const signed = (text: string, sign: "+" | "-"): string[] => text.split(/\r?\n/).map((l) => `${sign}${l}`);

/** An edit as unified-diff text: a file header, then one hunk per change. */
function editDiff(tool: string, path: string, input: Raw): string {
  const head = [`--- ${path}`, `+++ ${path}`];
  if (tool === "Write") {
    const all = String(input.content ?? "").split(/\r?\n/);
    const more = all.length > WRITE_LINES ? [`\\ ${all.length - WRITE_LINES} more lines`] : [];
    return [...head, "@@ new file @@", ...all.slice(0, WRITE_LINES).map((l) => `+${l}`), ...more].join("\n");
  }
  const edits = tool === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Raw[]) : [input];
  return [...head, ...edits.flatMap((e) => ["@@ edit @@", ...signed(String(e.old_string ?? ""), "-"), ...signed(String(e.new_string ?? ""), "+")])].join("\n");
}

const EDITS = new Set(["Edit", "MultiEdit", "Write"]);
/** Tools whose calls are not shown: the session's answer shows as its result instead. */
const HIDDEN = new Set(["StructuredOutput"]);

/**
 * One raw `stream-json` event as transcript items. `cwd`, the session's folder from its init event,
 * shortens paths. Events the console does not show (thinking, hooks, rate limits, progress) give none.
 */
export function toItems(e: Raw, cwd?: string): TranscriptItem[] {
  if (e.type === "assistant" || e.type === "user") {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const out: TranscriptItem[] = [];
    for (const b of content as Block[]) {
      if (e.type === "assistant" && b.type === "text" && b.text?.trim()) {
        out.push({ kind: "text", text: b.text });
      } else if (e.type === "assistant" && b.type === "tool_use" && b.name && b.id && !HIDDEN.has(b.name)) {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Raw;
        if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
          out.push({ kind: "todos", items: (input.todos as Raw[]).map((t) => ({ text: String(t.content ?? ""), state: String(t.status ?? "") })) });
        } else if (EDITS.has(b.name)) {
          const path = relativePath(String(input.file_path ?? ""), cwd);
          out.push({ kind: "edit", id: b.id, tool: b.name, path, diff: editDiff(b.name, path, input) });
        } else {
          out.push({ kind: "tool", id: b.id, tool: b.name, target: toolTarget(b.name, input, cwd), input });
        }
      } else if (e.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        out.push({ kind: "tool-result", id: b.tool_use_id, ok: b.is_error !== true, output: cut(outputText(b.content)) });
      }
    }
    return out;
  }
  if (e.type === "system" && e.subtype === "permission_denied" && typeof e.tool_use_id === "string") {
    return [{ kind: "tool-result", id: e.tool_use_id, ok: false, output: `Not allowed: ${String(e.message ?? e.decision_reason ?? "")}` }];
  }
  if (e.type === "result") {
    const answer = e.structured_output as { summary?: unknown } | undefined;
    const summary = typeof answer?.summary === "string" ? answer.summary : typeof e.result === "string" ? e.result : "";
    return [{ kind: "result", ok: e.subtype === "success" && e.is_error !== true, summary, costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null }];
  }
  return [];
}

/** The folder a session's init event names, read from the start of its raw file. */
function initCwd(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      try {
        const e = JSON.parse(line) as Raw;
        if (e.type === "system" && e.subtype === "init") return typeof e.cwd === "string" ? e.cwd : undefined;
      } catch { /* a cut-off line */ }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Reads a phase's raw.jsonl as transcript items from a byte offset, one finished line at a time. */
export class TranscriptReader {
  private cwd: string | undefined;
  private cwdRead = false;

  constructor(private readonly path: string, public offset = 0) {}

  /** Whether everything written so far has been read. */
  atEnd(): boolean {
    return !existsSync(this.path) || statSync(this.path).size <= this.offset;
  }

  /** The items of the finished lines after the offset, each with the offset just after its line. */
  read(maxBytes = READ_MAX): Array<{ item: TranscriptItem; offset: number }> {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size <= this.offset) return [];
    if (!this.cwdRead) {
      this.cwd = initCwd(this.path);
      this.cwdRead = true;
    }
    const fd = openSync(this.path, "r");
    let buf: Buffer;
    try {
      const want = Buffer.alloc(Math.min(size - this.offset, maxBytes));
      buf = want.subarray(0, readSync(fd, want, 0, want.length, this.offset));
    } finally {
      closeSync(fd);
    }
    const out: Array<{ item: TranscriptItem; offset: number }> = [];
    let start = 0;
    for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
      const line = buf.subarray(start, nl).toString("utf8");
      start = nl + 1;
      let e: Raw;
      try { e = JSON.parse(line) as Raw; } catch { continue; }
      if (e.type === "system" && e.subtype === "init" && typeof e.cwd === "string") this.cwd = e.cwd;
      for (const item of toItems(e, this.cwd)) out.push({ item, offset: this.offset + nl + 1 });
    }
    // A line longer than one whole read is skipped, so one huge event cannot stall the stream.
    if (start === 0 && buf.length === maxBytes) start = buf.length;
    this.offset += start;
    return out;
  }
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/unit/console-transcript.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/console/transcript.ts tests/unit/console-transcript.test.ts
git commit -m "feat(console): session transcripts from raw stream-json, read from a byte offset" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The model's five sections

**Files:**
- Create: `tests/console-helpers.ts`
- Modify: `src/intents.ts:433-440` (`shownNote`; add `waitNote`)
- Create: `src/console/model.ts`
- Test: `tests/unit/console-model.test.ts`

- [ ] **Step 1: Write the shared test helpers**

Create `tests/console-helpers.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../src/config";
import { buildModel, type Model } from "../src/console/model";
import { Trace } from "../src/trace";

const BODY = "# Intent: {title}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n";

/** Writes intent/<slug>/intent.md with the given frontmatter lines. */
export async function intent(root: string, slug: string, fm: string, title = slug): Promise<void> {
  mkdirSync(join(root, "intent", slug), { recursive: true });
  await Bun.write(join(root, "intent", slug, "intent.md"), `---\n${fm}\n---\n${BODY.replace("{title}", title)}`);
}

/** Writes loopstra/config.yaml: a test command, then `extra` YAML. */
export async function config(root: string, extra = ""): Promise<void> {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  await Bun.write(configPath(root), `version: 1\ncommands:\n  test: echo ok\n${extra}`);
}

/** Moves a phase's start (and end) time, which the trace otherwise stamps with the real clock. */
export function setStarted(root: string, slug: string, seq: number, iso: string): void {
  const db = new Database(join(root, ".loopstra", "trace.db"));
  try { db.run("UPDATE phases SET started = ?, ended = ? WHERE slug = ? AND seq = ?", [iso, iso, slug, seq]); } finally { db.close(); }
}

/** The console's model of a repository, with a trace opened and closed around it. */
export async function model(root: string, now: Date = new Date(), opts: { chat?: boolean } = {}): Promise<Model> {
  const trace = Trace.open(root);
  try { return await buildModel(root, trace, now, opts); } finally { trace.close(); }
}

/** Waits until `check` holds, or throws after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

/** One SSE frame's fields; `data` parsed from JSON. */
export interface Frame { id: string | null; event: string | null; data: unknown }

export function parseFrames(text: string): Frame[] {
  return text.split("\n\n").filter((f) => f.trim()).map((f) => {
    const field = (name: string) => f.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
    const data = field("data");
    return { id: field("id"), event: field("event"), data: data === null ? null : JSON.parse(data) as unknown };
  });
}

/** The first `count` frames carrying data on an SSE stream (fewer if it ends); the request is aborted after. */
export async function sseFrames(url: string, count: number, headers: Record<string, string> = {}): Promise<Frame[]> {
  const ac = new AbortController();
  const r = await fetch(url, { signal: ac.signal, headers });
  if (!r.body) throw new Error(`no stream: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const end = text.lastIndexOf("\n\n");
      const frames = parseFrames(end < 0 ? "" : text.slice(0, end + 2)).filter((f) => f.data !== null);
      if (frames.length >= count) return frames.slice(0, count);
      const { value, done } = await reader.read();
      if (done) return frames;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    ac.abort();
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/console-model.test.ts`. The "needs attention" and "totals" tests are the ones from the old `tests/unit/ui.test.ts`, now reading `sections.inbox` and `sections.changes`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildModel, nowLine, stripOf } from "../../src/console/model";
import { pauseAfterUnavailable, writeHeartbeat } from "../../src/heartbeat";
import { SYNC_TEXT } from "../../src/remote";
import { tick } from "../../src/scheduler";
import { Trace } from "../../src/trace";
import { config, intent, model, setStarted } from "../console-helpers";
import { tempDir } from "../helpers";

describe("changes", () => {
  test("in queue order, with plain status, stage, cost and why they wait", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building\npriority: high", "One");
      await intent(t.path, "two", "status: accepted\ndepends_on: one");
      const trace = Trace.open(t.path);
      const a = trace.phaseStart("one", "build", "agent");
      trace.phaseEnd("one", a, { status: "success", costUsd: 0.3 });
      trace.phaseStart("one", "fix-1", "agent", 2); // running, holding $2: a hold is not spending
      trace.close();
      const m = await model(t.path);
      expect(m.sections.changes.map((c) => c.slug)).toEqual(["one", "two"]);
      expect(m.sections.changes[0]).toMatchObject({ title: "One", status: "building", plain: "building and testing", priority: "high", stage: "build", waiting: null, running: false });
      expect(m.sections.changes[0]?.costUsd).toBeCloseTo(0.3);
      expect(m.sections.changes[1]).toMatchObject({ stage: "design", priority: "normal", costUsd: 0 });
      expect(m.sections.changes[1]?.waiting).toContain("one");
      expect(m.meta).toEqual({ chat: false, usdPerMinute: 0.2, pollSeconds: 60 });
      expect((await model(t.path, new Date(), { chat: true })).meta.chat).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

describe("the loop and running steps", () => {
  test("the loop state comes from the heartbeat, with each change's running phases", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      await intent(t.path, "one", "status: building");
      const trace = Trace.open(t.path);
      trace.phaseStart("one", "build", "agent");
      trace.close();
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "stopped", text: "Stopped", nextCheck: null });
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "one" }, stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "running", text: "Running — working on one, last check 20s ago", working: [{ slug: "one", phase: "build" }] });
      // Two phases at once: both are named, in the order they started. A row left running before
      // this tick (its process was killed) is not.
      setStarted(t.path, "one", 1, iso(60));
      const t2 = Trace.open(t.path);
      t2.phaseStart("one", "verify", "agent");
      t2.phaseStart("one", "early-review", "agent");
      t2.close();
      expect((await model(t.path, now)).sections.loop).toMatchObject({ working: [{ slug: "one", phase: "verify + early-review" }] });
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(3600), lastTickAt: iso(840), lastBeatAt: iso(840), current: null, stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "not-responding", text: "Not responding (last check 14 min ago)" });
      writeHeartbeat(t.path, { pid: 999_999, startedAt: iso(3600), lastTickAt: iso(840), lastBeatAt: iso(840), current: null, stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "stopped", text: "Stopped — it did not shut down cleanly (last check 14 min ago)" });
    } finally {
      t.cleanup();
    }
  });

  test("while the loop sleeps between ticks, it says when the next one is due", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: null, working: [], stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop.nextCheck).toBe(new Date(Date.parse(iso(20)) + 60_000).toISOString());
    } finally {
      t.cleanup();
    }
  });

  test("a running step's card: its model, what it is doing, and its activity", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      await intent(t.path, "one", "status: building", "One");
      const trace = Trace.open(t.path);
      const old = trace.phaseStart("one", "plan", "agent");
      const seq = trace.phaseStart("one", "build", "agent");
      trace.event("one", "claude_event", { type: "system", subtype: "init", model: "claude-sonnet-5-5" }, seq);
      trace.event("one", "claude_event", { type: "assistant", items: ["text:Reading the parser first.", "tool:Read"], targets: ["", "src/csv.ts"] }, seq);
      trace.event("one", "claude_event", { type: "user" }, seq);
      trace.event("one", "claude_event", { type: "assistant", items: ["tool:Bash"], targets: ["bun test"] }, seq);
      trace.close();
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      setStarted(t.path, "one", old, iso(600));
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(900), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "one" }, working: ["one"], stopping: false, stopped: false });
      const m = await model(t.path, now);
      expect(m.sections.running.now).toEqual([{
        slug: "one", title: "One", seq, name: "build", model: "claude-sonnet-5-5", started: expect.any(String),
        now: "Running bun test", strip: ["text", "tool", "tool"],
      }]);
      expect(m.sections.changes[0]?.running).toBe(true);
      expect(m.sections.loop.working).toEqual([{ slug: "one", phase: "build" }]);
    } finally {
      t.cleanup();
    }
  });

  test("what a session is doing, from its newest summaries", () => {
    expect(nowLine([])).toBe("Starting");
    expect(nowLine([{ type: "assistant", items: ["text:Reading the parser first.\nmore"], targets: [""] }])).toBe("Reading the parser first.");
    expect(nowLine([{ type: "assistant", items: ["thinking"] }])).toBe("Thinking");
    expect(nowLine([{ type: "assistant", items: ["tool:Edit"], targets: ["src/a.ts"] }, { type: "user" }])).toBe("Editing src/a.ts");
    expect(nowLine([{ type: "result" }])).toBe("Finishing");
    expect(stripOf([{ type: "assistant", items: ["text:a", "tool:Bash", "thinking"] }, { type: "result" }])).toEqual(["text", "tool", "result"]);
  });

  test("the newest finished steps, without chat's", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const trace = Trace.open(t.path);
      const a = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", a, { status: "success", costUsd: 0.2 });
      const c = trace.phaseStart("_chat", "orchestrator", "agent"); trace.phaseEnd("_chat", c, { status: "success" });
      const b = trace.phaseStart("two", "design", "agent"); trace.phaseEnd("two", b, { status: "fail" });
      trace.close();
      const m = await model(t.path);
      expect(m.sections.running.recent.map((p) => [p.slug, p.name, p.status])).toEqual([["two", "design", "fail"], ["one", "build", "success"]]);
    } finally {
      t.cleanup();
    }
  });

  test("a part that cannot be read becomes a problem in the inbox, and the rest still come", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      await intent(t.path, "one", "status: accepted");
      const broken = new Proxy(trace, {
        get(target, key) {
          if (key === "allPhases") return () => { throw new Error("disk on fire"); };
          const v = Reflect.get(target, key) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const m = await buildModel(t.path, broken);
      expect(m.sections.changes.map((c) => c.slug)).toEqual(["one"]);
      expect(m.sections.totals).toEqual({ todayUsd: 0, weekUsd: 0, allUsd: 0 });
      expect(m.sections.inbox).toEqual([{ kind: "config", label: "Console", slug: null, title: "Part of the console could not be read", what: "costs: disk on fire" }]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});

describe("needs attention", () => {
  test("lists blocked, waiting for a person, unreadable, and a red main", async () => {
    const t = tempDir();
    try {
      await config(t.path, "gates:\n  spec:\n    human: status\n");
      await intent(t.path, "stuck", "status: blocked\nnote: The tests failed three times.");
      await intent(t.path, "spec-ready", "status: spec-review\nnote: Read spec.md. When you are happy with it, change the status line to spec-approved.");
      await intent(t.path, "idea", "status: draft");
      await intent(t.path, "plan-ready", "status: plan-review");
      await intent(t.path, "busy", "status: building");
      mkdirSync(join(t.path, "intent", "broken"), { recursive: true });
      await Bun.write(join(t.path, "intent", "broken", "intent.md"), "---\nstatus: nearly-done\n---\n# Intent: broken\n");
      const trace = Trace.open(t.path);
      trace.signal("main_health", "pass", "");
      trace.signal("main_health", "fail", "1 failing");
      trace.close();

      const inbox = (await model(t.path)).sections.inbox;
      const by = Object.fromEntries(inbox.map((a) => [a.slug ?? a.kind, a]));
      expect(inbox[0]).toMatchObject({ kind: "health", slug: null });
      expect(inbox[0]?.what).toContain("The tests on main are failing");
      expect(by.stuck).toMatchObject({ kind: "blocked", label: "Blocked", what: "The tests failed three times." });
      expect(by["spec-ready"]).toMatchObject({ kind: "waiting", label: "Waiting for you", what: "Read spec.md. When you are happy with it, change the status line to spec-approved." });
      expect(by.idea).toMatchObject({ kind: "waiting", label: "Waiting for you" });
      expect(by.idea?.what).toContain("accepted");
      expect(by.broken).toMatchObject({ kind: "unreadable" });
      expect(by.broken?.what).toContain("The status line at the top of intent.md");
      expect(by["plan-ready"]).toBeUndefined();
      expect(by.busy).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  test("before main has ever passed, red tests say so instead of calling main failing", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const trace = Trace.open(t.path);
      trace.signal("main_health", "fail", "MSB1009: Project file does not exist.");
      trace.signal("main_health", "error", "install failed");
      trace.signal("main_health", "fail", "MSB1009: Project file does not exist.");
      trace.close();
      const inbox = (await model(t.path)).sections.inbox;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.what).toMatch(/^The tests on main have not passed yet \(checked .* ago\)\. On a new repository that is expected until the first change merges\.$/);
      const t2 = Trace.open(t.path);
      t2.signal("main_health", "pass", "");
      t2.signal("main_health", "fail", "1 failing");
      t2.close();
      expect((await model(t.path)).sections.inbox[0]?.what).toContain("The tests on main are failing");
    } finally {
      t.cleanup();
    }
  });

  test("a check that could not run, and a config problem, need a person too; green main does not", async () => {
    const t = tempDir();
    try {
      await intent(t.path, "busy", "status: building");
      const trace = Trace.open(t.path);
      trace.signal("main_health", "error", "install failed");
      trace.close();
      const inbox = (await model(t.path)).sections.inbox;
      expect(inbox.map((a) => a.kind).sort()).toEqual(["config", "health"]);
      expect(inbox.find((a) => a.kind === "config")?.what).toContain("loopstra init");
      await config(t.path);
      const t2 = Trace.open(t.path);
      t2.signal("main_health", "pass", "");
      t2.close();
      expect((await model(t.path)).sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a pause because the assistant is unavailable is listed first, until it runs out", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const p = pauseAfterUnavailable(t.path);
      expect((await model(t.path)).sections.inbox).toEqual([{ kind: "paused", label: "Paused", slug: null, title: "Loopstra is paused", what: p.reason }]);
      expect((await model(t.path, new Date(Date.parse(p.until) + 1000))).sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a config problem the loop hit is traced by the tick and listed", async () => {
    const t = tempDir();
    try {
      await Bun.write(join(t.path, "loopstra", "config.yaml"), "version: 1\nbogus: true\n");
      const r = await tick(t.path);
      expect(r.error).toContain("bogus");
      const inbox = (await model(t.path)).sections.inbox;
      expect(inbox.find((a) => a.kind === "config")).toMatchObject({ label: "Settings", what: expect.stringContaining("bogus") });
    } finally {
      t.cleanup();
    }
  });

  test("main out of step with GitHub needs a person; back in step it does not", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const trace = Trace.open(t.path);
      trace.signal("main_sync", "waiting", SYNC_TEXT.ownCommits);
      trace.close();
      expect((await model(t.path)).sections.inbox).toEqual([{ kind: "sync", label: "GitHub", slug: null, title: "Main and GitHub", what: SYNC_TEXT.ownCommits }]);
      const t2 = Trace.open(t.path);
      t2.signal("main_sync", "pass", SYNC_TEXT.inStep);
      t2.close();
      expect((await model(t.path)).sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe("totals", () => {
  test("cost today, this week and overall, per change, and time in the current status", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building");
      await intent(t.path, "two", "status: accepted");
      const trace = Trace.open(t.path);
      const a = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", a, { status: "success", costUsd: 0.3 });
      const b = trace.phaseStart("one", "fix-1", "agent"); trace.phaseEnd("one", b, { status: "fail", costUsd: 1 });
      const c = trace.phaseStart("two", "intake", "agent"); trace.phaseEnd("two", c, { status: "success", costUsd: 2 });
      trace.statusChange("one", "plan-approved", "building");
      trace.close();
      // Wednesday 30 September 2026, noon, local time. The week starts on Monday the 28th.
      const now = new Date(2026, 8, 30, 12, 0, 0);
      setStarted(t.path, "one", a, new Date(2026, 8, 30, 9, 0, 0).toISOString());
      setStarted(t.path, "one", b, new Date(2026, 8, 28, 10, 0, 0).toISOString());
      setStarted(t.path, "two", c, new Date(2026, 8, 20, 10, 0, 0).toISOString());
      const m = await model(t.path, now);
      expect(m.sections.totals.todayUsd).toBeCloseTo(0.3);
      expect(m.sections.totals.weekUsd).toBeCloseTo(1.3);
      expect(m.sections.totals.allUsd).toBeCloseTo(3.3);
      expect(m.sections.changes.find((x) => x.slug === "one")?.costUsd).toBeCloseTo(1.3);
      // The status change was traced just now (real clock); check against a clock two hours on.
      const later = await model(t.path, new Date(Date.now() + 2 * 3600_000));
      expect(later.sections.changes.find((x) => x.slug === "one")?.inStatus).toBe("2 h");
      // No traced change into its status: the time since intent.md was last written.
      expect(later.sections.changes.find((x) => x.slug === "two")?.inStatus).toBe("2 h");
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `bun test tests/unit/console-model.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/model'`.

- [ ] **Step 4: Share the "why it waits" words in `src/intents.ts`**

Replace `shownNote` (lines 433-440) with these two functions, so the console and `queue.md` word a wait the same way:

```ts
/**
 * Why a change waits for others, in words ("" when it does not). `heldBy`: the change it waits for
 * because both change the same files (see fileHolds).
 */
export function waitNote(intent: Intent, intents: Intent[], heldBy?: string): string {
  const sameFiles = heldBy ? `Waits for ${heldBy} to be merged first, because both change the same files.` : null;
  return [dependencyNote(intent, intents), sameFiles].filter(Boolean).join(" ");
}

/** The note shown for a change: why it waits for others, if it does, then its own note. */
export function shownNote(intent: Intent, intents: Intent[], heldBy?: string): string {
  return [waitNote(intent, intents, heldBy), intent.file.frontmatter.note].filter(Boolean).join(" ");
}
```

- [ ] **Step 5: Write `src/console/model.ts`**

```ts
import { statSync } from "node:fs";
import { join } from "node:path";
import { attention, type AttentionItem } from "../attention";
import { CHAT_SLUG, startOfToday, USD_PER_MINUTE } from "../budget";
import { loadConfig, type Config } from "../config";
import { agoText, heartbeatState, readHeartbeat, readPause } from "../heartbeat";
import { effectivePriority, orderQueue, plainStatus, scanRepo, waitNote, type Intent, type Status } from "../intents";
import { sameFileHolds } from "../scheduler";
import { errorText } from "../shell";
import { nowText } from "../tools";
import type { EventRow, PhaseRow, Trace } from "../trace";
import type { ChangeSummary, FinishedPhase, LoopSection, Meta, RunningPhase, Sections, Stage, Totals } from "./types";

/** The board column of each status: where the change is, or is heading next. */
const STAGE: Record<Status, Stage> = {
  draft: "draft", accepted: "design", designing: "design", "spec-review": "design",
  "spec-approved": "plan", planning: "plan", "plan-review": "plan",
  "plan-approved": "build", building: "build", reviewing: "review",
  "merge-review": "merge", "merge-approved": "merge", merged: "verify", verifying: "verify",
  done: "done", blocked: "blocked", closed: "closed",
};

/** How many entries a running step's activity strip shows. */
const STRIP = 30;

export interface Model { meta: Meta; sections: Sections }

/** A `claude_event` row's payload: see `summarize` in src/phases.ts. */
interface Summary { type?: string; subtype?: string; items?: string[]; targets?: string[]; model?: string | null }

/**
 * Everything the console shows on every screen, from the intent files, the trace and the heartbeat.
 * Each part is built on its own: one that fails becomes a problem in the inbox, and the rest still
 * go out.
 */
export async function buildModel(root: string, trace: Trace, now: Date = new Date(), opts: { chat?: boolean } = {}): Promise<Model> {
  let config: Config | { problem: string };
  try { config = await loadConfig(root); } catch (e) { config = { problem: errorText(e) }; }
  const cfg = "problem" in config ? null : config;
  const pollSeconds = cfg?.poll_seconds ?? 60;
  const problems: string[] = [];
  const safely = async <T>(what: string, fn: () => T | Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { problems.push(`${what}: ${errorText(e)}`); return fallback; }
  };

  const ordered = orderQueue((await scanRepo(root)).intents);
  const titles = new Map(ordered.map((i) => [i.slug, i.file.title || i.slug]));
  const beat = readHeartbeat(root);
  const hb = heartbeatState(beat, pollSeconds, now, { pause: readPause(root) });
  const runningNow = await safely("running steps", () => runningPhases(trace, hb.working.map((w) => w.slug), beat?.lastTickAt ?? null, titles), [] as RunningPhase[]);
  const busy = new Set(runningNow.map((p) => p.slug));
  const loop: LoopSection = {
    ...hb,
    working: hb.working.map((w) => ({ slug: w.slug, phase: runningNow.filter((p) => p.slug === w.slug).map((p) => p.name).join(" + ") || null })),
    nextCheck: hb.state === "running" && !hb.working.length && beat?.lastTickAt
      ? new Date(Date.parse(beat.lastTickAt) + pollSeconds * 1000).toISOString() : null,
  };
  const holds = cfg ? await safely("same-file waits", () => sameFileHolds(cfg.speed.max_parallel_changes, ordered), new Map<string, string>()) : new Map<string, string>();
  const changes = await safely("changes", () => ordered.map((i) => changeSummary(trace, i, ordered, holds.get(i.slug), busy, now)), [] as ChangeSummary[]);
  const inbox = await safely("needs attention", () => attention(root, config, trace, now), [] as AttentionItem[]);
  const recent = await safely("finished steps", () => recentPhases(trace), [] as FinishedPhase[]);
  const totals = await safely("costs", () => totalsOf(trace.allPhases(), now), { todayUsd: 0, weekUsd: 0, allUsd: 0 });
  for (const what of problems) inbox.push({ kind: "config", label: "Console", slug: null, title: "Part of the console could not be read", what });
  return {
    meta: { chat: opts.chat ?? false, usdPerMinute: USD_PER_MINUTE, pollSeconds },
    sections: { loop, inbox, changes, running: { now: runningNow, recent }, totals },
  };
}

/** One change as the board and the lists show it. `heldBy`: the change it waits for over the same files. */
export function changeSummary(trace: Trace, i: Intent, all: Intent[], heldBy: string | undefined, busy: ReadonlySet<string>, now: Date): ChangeSummary {
  const fm = i.file.frontmatter;
  const since = statusSince(trace, i);
  return {
    slug: i.slug, title: i.file.title || i.slug, status: fm.status, plain: plainStatus(fm.status), priority: effectivePriority(fm),
    stage: STAGE[fm.status], since, inStatus: since ? agoText(now.getTime() - Date.parse(since)) : null,
    costUsd: endedCost(trace.phases(i.slug)), waiting: waitNote(i, all, heldBy) || null, note: fm.note, running: busy.has(i.slug),
  };
}

/** What phases cost; a running one's budget hold is not spending. */
export function endedCost(phases: PhaseRow[]): number {
  return phases.reduce((n, p) => n + (p.status === "running" ? 0 : p.cost_usd ?? 0), 0);
}

/**
 * When the change entered its status: the newest traced change into it, if that is the newest traced
 * change at all; otherwise (a person edited the status) when intent.md was last written.
 */
function statusSince(trace: Trace, i: Intent): string | null {
  const last = trace.lastEvent(i.slug, "status_change");
  if (last && (parse(last.payload) as { to?: string }).to === i.file.frontmatter.status) return last.ts;
  try { return statSync(join(i.dir, "intent.md")).mtime.toISOString(); } catch { return null; }
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * The phases running now for the changes the heartbeat names, in the order they started. Only those
 * started since the tick began (`since`): a row a killed process left running is not current.
 */
function runningPhases(trace: Trace, working: string[], since: string | null, titles: ReadonlyMap<string, string>): RunningPhase[] {
  const out: RunningPhase[] = [];
  for (const slug of working) {
    for (const p of trace.phases(slug)) {
      if (p.status !== "running" || (since && p.started < since)) continue;
      const events = trace.phaseEvents(slug, p.seq, STRIP * 2).filter((e) => e.type === "claude_event").map((e) => parse(e.payload) as Summary);
      out.push({
        slug, title: titles.get(slug) ?? slug, seq: p.seq, name: p.name, started: p.started,
        model: modelOf(trace.firstEvent(slug, p.seq, "claude_event")),
        now: p.kind === "agent" ? nowLine(events) : `Running ${p.name}`,
        strip: stripOf(events),
      });
    }
  }
  return out;
}

function modelOf(e: EventRow | null): string | null {
  const s = (e ? parse(e.payload) : {}) as Summary;
  return s.type === "system" && s.subtype === "init" && typeof s.model === "string" ? s.model : null;
}

/** What a session is doing, from its newest summaries: its last tool call or line of text. */
export function nowLine(events: Summary[]): string {
  for (let k = events.length - 1; k >= 0; k--) {
    const s = events[k]!;
    if (s.type === "result") return "Finishing";
    if (s.type !== "assistant" || !s.items?.length) continue;
    for (let j = s.items.length - 1; j >= 0; j--) {
      const item = s.items[j]!;
      if (item.startsWith("tool:")) return nowText(item.slice(5), s.targets?.[j] ?? "");
      if (item.startsWith("text:")) {
        const text = item.slice(5).split(/\r?\n/)[0]!.trim();
        if (text) return text;
      }
    }
    return "Thinking";
  }
  return "Starting";
}

/** A session's newest activity, one entry per tool call, piece of text, or result. */
export function stripOf(events: Summary[]): RunningPhase["strip"] {
  const out: RunningPhase["strip"] = [];
  for (const s of events) {
    if (s.type === "result") out.push("result");
    else if (s.type === "assistant") {
      for (const item of s.items ?? []) {
        if (item.startsWith("tool:")) out.push("tool");
        else if (item.startsWith("text:")) out.push("text");
      }
    }
  }
  return out.slice(-STRIP);
}

/** The five newest finished steps of any change; chat's turns are left out. */
function recentPhases(trace: Trace): FinishedPhase[] {
  return trace.recentPhases(20).filter((p) => p.slug !== CHAT_SLUG).slice(0, 5).map((p) => ({
    slug: p.slug, seq: p.seq, name: p.name, status: p.status, ended: p.ended!,
    durationMs: Math.max(0, Date.parse(p.ended!) - Date.parse(p.started)), costUsd: p.cost_usd ?? 0,
  }));
}

/** What was spent today, this week (from Monday, local time) and in all, chat included. */
export function totalsOf(phases: PhaseRow[], now: Date): Totals {
  const day = new Date(startOfToday(now));
  const week = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  let todayUsd = 0, weekUsd = 0, allUsd = 0;
  for (const p of phases) {
    const cost = p.status === "running" ? 0 : p.cost_usd ?? 0;
    const t = Date.parse(p.started);
    allUsd += cost;
    if (t >= week.getTime()) weekUsd += cost;
    if (t >= day.getTime()) todayUsd += cost;
  }
  return { todayUsd, weekUsd, allUsd };
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/unit/console-model.test.ts tests/unit/intents-queue.test.ts`
Expected: PASS. (`intents-queue` covers `shownNote` and `renderQueue`, which must read as before.)

- [ ] **Step 7: Commit**

```bash
git add tests/console-helpers.ts tests/unit/console-model.test.ts src/console/model.ts src/intents.ts
git commit -m "feat(console): the model's sections: loop, inbox, changes, running steps and totals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Run files, a change's page, and spend

**Files:**
- Create: `src/console/files.ts` (moved out of `src/commands/ui.ts`)
- Modify: `src/commands/ui.ts` (import the moved functions instead of defining them)
- Create: `src/console/detail.ts`
- Test: `tests/unit/console-detail.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-detail.test.ts`. The run-file tests are the old ones from `tests/unit/ui.test.ts`; the cheaper-judges test moves from the old dashboard state to the Spend screen:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { changeDetail, spendView } from "../../src/console/detail";
import { resolveDocument, resolveRunFile } from "../../src/console/files";
import { templateSha } from "../../src/judges";
import { Trace } from "../../src/trace";
import { config, intent, setStarted } from "../console-helpers";
import { tempDir } from "../helpers";

/** A change "one" with a finished build phase that left a prompt and an envelope, and two files outside the runs folder. */
async function seeded() {
  const t = tempDir();
  await intent(t.path, "one", "status: building");
  const trace = Trace.open(t.path);
  const seq = trace.phaseStart("one", "build", "agent");
  trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
  trace.close();
  const dir = join(t.path, ".loopstra", "runs", "one", "phases", "1-build");
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "prompt.md"), "# the prompt <b>");
  await Bun.write(join(dir, "envelope.json"), "{}");
  await Bun.write(join(t.path, ".loopstra", "secret.txt"), "no");
  await Bun.write(join(t.path, "secret.txt"), "no");
  return t;
}

describe("a change's page", () => {
  test("its phases with the files they left and the commands they were refused, its gates and its documents", async () => {
    const t = await seeded();
    const trace = Trace.open(t.path);
    try {
      await Bun.write(join(t.path, "intent", "one", "spec.md"), "# Spec\n");
      trace.gate("one", "plan", "headings", "pass", "ok");
      const fix = trace.phaseStart("one", "fix-1", "agent");
      trace.phaseEnd("one", fix, { status: "fail", denied: ["Bash(git tag v1)"] });
      const d = await changeDetail(t.path, trace, "one");
      expect(d).toMatchObject({ slug: "one", status: "building", stage: "build", dependsOn: [] });
      expect(d!.documents).toEqual([{ name: "intent.md", url: "/docs/one/intent.md" }, { name: "spec.md", url: "/docs/one/spec.md" }]);
      expect(d!.phases[0]).toMatchObject({
        seq: 1, name: "build", status: "success", costUsd: 0.1, denied: [],
        files: [{ name: "prompt.md", url: "/files/one/phases/1-build/prompt.md" }, { name: "envelope.json", url: "/files/one/phases/1-build/envelope.json" }],
      });
      expect(d!.phases[1]).toMatchObject({ name: "fix-1", status: "fail", denied: ["Bash(git tag v1)"], files: [] });
      expect(d!.gates[0]).toMatchObject({ gate: "plan", check: "headings", result: "pass" });
      expect(await changeDetail(t.path, trace, "nope")).toBeNull();
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("only files under .loopstra/runs resolve", async () => {
    const t = await seeded();
    try {
      expect(resolveRunFile(t.path, "one/phases/1-build/prompt.md")).not.toBeNull();
      for (const bad of [
        "../secret.txt", "one/../../secret.txt", "one/../../../secret.txt", "..\\secret.txt", "one\\..\\..\\secret.txt",
        join(t.path, "secret.txt"), "/etc/passwd", "C:\\Windows\\win.ini", "C:secret.txt", "one/phases/1-build",
        "one/phases/1-build/missing.md", "", "one/phases/1-build/prompt.md\0", "one/phases/1-build/prompt.md:stream",
      ]) {
        expect({ bad, r: resolveRunFile(t.path, bad) }).toEqual({ bad, r: null });
      }
    } finally {
      t.cleanup();
    }
  });

  test("only a change's own known documents resolve", async () => {
    const t = await seeded();
    try {
      await Bun.write(join(t.path, "intent", "one", "spec.md"), "# Spec\n");
      expect(resolveDocument(t.path, "one", "spec.md")).not.toBeNull();
      expect(resolveDocument(t.path, "one", "plan.md")).toBeNull();
      expect(resolveDocument(t.path, "one", "secret.txt")).toBeNull();
      expect(resolveDocument(t.path, "One", "intent.md")).toBeNull();
      expect(resolveDocument(t.path, "..", "intent.md")).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});

describe("spend", () => {
  test("per change, per kind of step, per hour, and chat's", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building", "One");
      await intent(t.path, "two", "status: designing", "Two");
      const build = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", build, { status: "success", costUsd: 0.5 });
      const f1 = trace.phaseStart("one", "fix-1", "agent"); trace.phaseEnd("one", f1, { status: "fail", costUsd: 0.2 });
      const f2 = trace.phaseStart("one", "fix-2", "agent"); trace.phaseEnd("one", f2, { status: "success", costUsd: 0.1 });
      trace.phaseStart("one", "fix-3", "agent", 3); // running, holding $3: not spending
      const d = trace.phaseStart("two", "design", "agent"); trace.phaseEnd("two", d, { status: "success", costUsd: 1 });
      const c = trace.phaseStart("_chat", "orchestrator", "agent"); trace.phaseEnd("_chat", c, { status: "success", costUsd: 0.25 });
      const now = new Date();
      setStarted(t.path, "one", build, new Date(now.getTime() - 90 * 60_000).toISOString());

      const v = await spendView(t.path, trace, null, now);
      expect(v.totals.allUsd).toBeCloseTo(2.05);
      expect(v.chatUsd).toBeCloseTo(0.25);
      expect(v.perChange.map((x) => [x.slug, x.title])).toEqual([["two", "Two"], ["one", "One"]]);
      expect(v.perChange[1]!.costUsd).toBeCloseTo(0.8);
      expect(v.perPhase.find((p) => p.name === "fix")).toMatchObject({ count: 3 });
      expect(v.perPhase.find((p) => p.name === "fix")!.costUsd).toBeCloseTo(0.3);
      expect(v.perPhase.find((p) => p.name === "chat")!.costUsd).toBeCloseTo(0.25);
      expect(v.byHour).toHaveLength(48);
      expect(v.byHour.reduce((n, h) => n + h.costUsd, 0)).toBeCloseTo(2.05);
      expect(v.byHour.at(-1)!.costUsd).toBeCloseTo(1.55); // everything but the build, which started 90 minutes ago
      expect(v.judges).toBeNull();
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("the cheaper judges: left out while off and never compared; otherwise their report, with the newest five false passes", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      await Bun.write(join(t.path, "loopstra", "prompts", "review.md"), "review prompt");
      expect((await spendView(t.path, trace, await loadConfig(t.path))).judges).toBeNull();

      await config(t.path, "speed:\n  cheap_judges: shadow\n");
      const shadow = (await spendView(t.path, trace, await loadConfig(t.path))).judges!;
      expect(shadow).toMatchObject({ setting: "shadow", cheapModel: "sonnet", strongModel: "opus", spentUsd: 0, falsePasses: [] });

      await config(t.path);
      for (let i = 1; i <= 7; i++) {
        trace.judge(`change-${i}`, {
          judge: "review", trace_name: "review-1", mode: "shadow", how: "shadow", cheap_model: "sonnet", strong_model: "opus",
          template_sha: templateSha(t.path, "review")!, prompt_sha: `change-${i}`, cheap: "pass", strong: "reject",
          cheap_usd: 0.1, strong_usd: 0.3, cheap_ms: 1000, strong_ms: 3000,
        });
      }
      const off = (await spendView(t.path, trace, await loadConfig(t.path))).judges!;
      expect(off.setting).toBe("off");
      expect(off.judges.find((j) => j.judge === "review")).toMatchObject({ compared: 7, falsePasses: 7 });
      expect(off.falsePasses.map((p) => p.slug)).toEqual(["change-7", "change-6", "change-5", "change-4", "change-3"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-detail.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/detail'`.

- [ ] **Step 3: Move the run-file helpers to `src/console/files.ts`**

Create `src/console/files.ts` with the three functions cut from `src/commands/ui.ts` (unchanged apart from the module), plus the list of phase files:

```ts
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ARTIFACTS, intentRoot, SLUG } from "../intents";

/** Files a phase can leave behind, in the order the console lists them. */
export const PHASE_FILES = ["prompt.md", "envelope.json", "raw.jsonl"] as const;

export function runsDir(root: string): string {
  return join(root, ".loopstra", "runs");
}

/**
 * The real path of a file under `.loopstra/runs/`, or null. `rel` is the part of the URL after
 * `/files/`, already decoded. Refuses `..`, absolute and drive paths, stream names, anything that
 * is not a regular file, and anything whose real path (after links) leaves the runs directory.
 */
export function resolveRunFile(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.includes(":") || isAbsolute(rel) || /^[\\/]/.test(rel)) return null;
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) return null;
  const base = runsDir(root);
  if (!existsSync(base)) return null;
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(resolve(base, ...parts));
    if (!real.startsWith(realBase + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * The real path of one of a change's own documents, `intent/<slug>/<name>`, or null. The slug must
 * be a valid change name and the name one of the documents Loopstra knows (intent.md, spec.md, ...);
 * the real path (after links) must stay inside the change's folder and be a regular file.
 */
export function resolveDocument(root: string, slug: string, name: string): string | null {
  if (!SLUG.test(slug) || !(ARTIFACTS as readonly string[]).includes(name)) return null;
  const dir = join(intentRoot(root), slug);
  try {
    const realDir = realpathSync(dir);
    const real = realpathSync(join(dir, name));
    if (!real.startsWith(realDir + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
```

In `src/commands/ui.ts`, delete its own `PHASE_FILES`, `runsDir`, `resolveRunFile` and `resolveDocument`, and add near the other imports:

```ts
import { PHASE_FILES, resolveDocument, resolveRunFile, runsDir } from "../console/files";
export { resolveDocument, resolveRunFile } from "../console/files";
```

(The old page still runs until Task 14 replaces it; the re-export keeps its tests passing until then.) Remove imports that become unused (`isAbsolute`, `resolve`, `sep`, `realpathSync`, `intentRoot`, `SLUG` if nothing else in the file uses them); `bun run typecheck` and the editor will say which.

- [ ] **Step 4: Write `src/console/detail.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SLUG } from "../budget";
import { judgesView } from "../commands/judges";
import { loadConfig, type Config } from "../config";
import { readHeartbeat } from "../heartbeat";
import { ARTIFACTS, orderQueue, scanRepo } from "../intents";
import { sameFileHolds } from "../scheduler";
import type { Trace } from "../trace";
import { PHASE_FILES, runsDir } from "./files";
import { changeSummary, totalsOf } from "./model";
import type { ChangeDetail, PhaseView, SpendView } from "./types";

/** One change with everything its page shows, or null when there is no such change. */
export async function changeDetail(root: string, trace: Trace, slug: string, now: Date = new Date()): Promise<ChangeDetail | null> {
  const ordered = orderQueue((await scanRepo(root)).intents);
  const i = ordered.find((x) => x.slug === slug);
  if (!i) return null;
  let lanes = 1;
  try { lanes = (await loadConfig(root)).speed.max_parallel_changes; } catch { /* the inbox says what is wrong with the config */ }
  const holds = await sameFileHolds(lanes, ordered);
  const rows = trace.phases(slug);
  // Running since the current tick began; a row a killed process left running is not.
  const tickStart = readHeartbeat(root)?.lastTickAt ?? null;
  const busy = new Set(rows.some((p) => p.status === "running" && (!tickStart || p.started >= tickStart)) ? [slug] : []);
  const denied = trace.deniedCommands(slug);
  const phases: PhaseView[] = rows.map((p) => {
    const end = p.ended ? Date.parse(p.ended) : now.getTime();
    const dir = `${p.seq}-${p.name}`;
    const files = PHASE_FILES
      .filter((f) => existsSync(join(runsDir(root), slug, "phases", dir, f)))
      .map((f) => ({ name: f, url: `/files/${[slug, "phases", dir, f].map(encodeURIComponent).join("/")}` }));
    return {
      seq: p.seq, name: p.name, kind: p.kind, status: p.status, started: p.started, ended: p.ended,
      durationMs: Math.max(0, end - Date.parse(p.started)), costUsd: p.status === "running" ? 0 : p.cost_usd ?? 0, error: p.error,
      files, denied: denied.get(p.seq) ?? [],
    };
  });
  return {
    ...changeSummary(trace, i, ordered, holds.get(slug), busy, now),
    dependsOn: i.file.frontmatter.depends_on ?? [],
    documents: ARTIFACTS.filter((a) => i.artifacts.has(a)).map((a) => ({ name: a, url: `/docs/${slug}/${a}` })),
    phases,
    gates: trace.gates(slug),
  };
}

/** How many hours the Spend screen's chart covers. */
const HOURS = 48;

/** What the Spend screen shows. `cfg` is null when the config cannot be read (the judges are then left out). */
export async function spendView(root: string, trace: Trace, cfg: Config | null, now: Date = new Date()): Promise<SpendView> {
  const all = trace.allPhases();
  const titles = new Map((await scanRepo(root)).intents.map((i) => [i.slug, i.file.title || i.slug]));
  const perChange = new Map<string, number>();
  const perPhase = new Map<string, { costUsd: number; count: number }>();
  const firstHour = Math.floor(now.getTime() / 3_600_000) - (HOURS - 1);
  const byHour = Array.from({ length: HOURS }, (_, k) => ({ hour: new Date((firstHour + k) * 3_600_000).toISOString(), costUsd: 0 }));
  let chatUsd = 0;
  for (const p of all) {
    const cost = p.status === "running" ? 0 : p.cost_usd ?? 0;
    if (p.slug === CHAT_SLUG) chatUsd += cost;
    else perChange.set(p.slug, (perChange.get(p.slug) ?? 0) + cost);
    // Rounds of the same step count as one kind: fix-1 and fix-2 are both "fix".
    const name = p.slug === CHAT_SLUG ? "chat" : p.name.replace(/-\d+$/, "");
    const kind = perPhase.get(name) ?? { costUsd: 0, count: 0 };
    perPhase.set(name, { costUsd: kind.costUsd + cost, count: kind.count + 1 });
    const h = Math.floor(Date.parse(p.started) / 3_600_000) - firstHour;
    if (h >= 0 && h < HOURS) byHour[h]!.costUsd += cost;
  }
  return {
    totals: totalsOf(all, now),
    chatUsd,
    perChange: [...perChange].map(([slug, costUsd]) => ({ slug, title: titles.get(slug) ?? slug, costUsd })).sort((a, b) => b.costUsd - a.costUsd),
    perPhase: [...perPhase].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    byHour,
    judges: cfg ? judgesState(root, cfg, trace) : null,
  };
}

/** The cheaper judges' report, shown only once they are on or have been compared at all. */
function judgesState(root: string, cfg: Config, trace: Trace): SpendView["judges"] {
  const v = judgesView(root, cfg, trace);
  if (v.setting === "off" && !v.total) return null;
  return { ...v, falsePasses: v.falsePasses.slice(0, 5) };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/console-detail.test.ts tests/unit/ui.test.ts`
Expected: PASS (the old dashboard's tests still pass through the re-export).

- [ ] **Step 6: Commit**

```bash
git add src/console/files.ts src/console/detail.ts src/commands/ui.ts tests/unit/console-detail.test.ts
git commit -m "feat(console): a change's page and the spend figures; run-file checks move to the console" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: A change's diff against main

**Files:**
- Create: `src/console/diff.ts`
- Test: `tests/unit/console-diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-diff.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { changeDiff, cutDiff, DIFF_MAX_CHARS, DIFF_MAX_LINES } from "../../src/console/diff";
import { run, tempGitRepo } from "../helpers";

describe("a change's diff", () => {
  test("its branch against main, and none for a change without a branch", async () => {
    const repo = await tempGitRepo();
    try {
      await run(["git", "checkout", "-q", "-b", "intent/csv"], repo.path);
      await Bun.write(join(repo.path, "src.txt"), "hello\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "add"], repo.path);
      await run(["git", "checkout", "-q", "main"], repo.path);
      const d = await changeDiff(repo.path, "main", "csv");
      expect(d).toMatchObject({ exists: true, cut: false });
      expect(d.stat).toContain("src.txt");
      expect(d.patch).toContain("+hello");
      expect(await changeDiff(repo.path, "main", "nope")).toEqual({ exists: false, stat: "", patch: "", cut: false });
    } finally {
      repo.cleanup();
    }
  });

  test("a long diff is cut, by lines and by size", () => {
    const long = Array.from({ length: DIFF_MAX_LINES + 10 }, (_, i) => `+${i}`).join("\n");
    expect(cutDiff(long).cut).toBe(true);
    expect(cutDiff(long).text.split("\n")).toHaveLength(DIFF_MAX_LINES);
    expect(cutDiff("x".repeat(DIFF_MAX_CHARS + 5)).text).toHaveLength(DIFF_MAX_CHARS);
    expect(cutDiff("+a\n-b")).toEqual({ text: "+a\n-b", cut: false });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-diff.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/diff'`.

- [ ] **Step 3: Write `src/console/diff.ts`**

```ts
import { Git } from "../git";
import type { DiffView } from "./types";

export const DIFF_MAX_CHARS = 1_000_000;
export const DIFF_MAX_LINES = 5_000;

/** A change's branch against main (`main...intent/<slug>`: what the branch adds since they parted), cut to the limits. */
export async function changeDiff(root: string, mainBranch: string, slug: string): Promise<DiffView> {
  const git = new Git(root);
  const branch = `intent/${slug}`;
  if ((await git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], true)).code !== 0) {
    return { exists: false, stat: "", patch: "", cut: false };
  }
  const range = `${mainBranch}...${branch}`;
  const stat = (await git.run(["diff", "--no-color", "--no-ext-diff", "--stat", range], true)).out;
  const { text, cut } = cutDiff((await git.run(["diff", "--no-color", "--no-ext-diff", range], true)).out);
  return { exists: true, stat, patch: text, cut };
}

/** `text` cut to DIFF_MAX_CHARS characters and DIFF_MAX_LINES lines. */
export function cutDiff(text: string): { text: string; cut: boolean } {
  let out = text;
  let cut = false;
  if (out.length > DIFF_MAX_CHARS) { out = out.slice(0, DIFF_MAX_CHARS); cut = true; }
  const lines = out.split("\n");
  if (lines.length > DIFF_MAX_LINES) { out = lines.slice(0, DIFF_MAX_LINES).join("\n"); cut = true; }
  return { text: out, cut };
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/unit/console-diff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/console/diff.ts tests/unit/console-diff.test.ts
git commit -m "feat(console): a change's branch diff against main, cut to a size limit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The hub: one live stream for every open page

**Files:**
- Create: `src/console/hub.ts`
- Test: `tests/unit/console-hub.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-hub.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Hub, PING } from "../../src/console/hub";
import type { StreamMessage } from "../../src/console/types";
import { Trace } from "../../src/trace";
import { config, intent, parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

/** A page: collects what the hub sends it, until it is closed. */
function page() {
  const frames: string[] = [];
  let open = true;
  return {
    frames,
    send: (text: string) => { if (!open) return false; frames.push(text); return true; },
    close: () => { open = false; },
    messages: () => parseFrames(frames.join("")).filter((f) => f.data !== null && f.event === null).map((f) => ({ id: f.id, msg: f.data as StreamMessage })),
  };
}

const FAST = { intervalMs: 20, minRebuildMs: 0, pingMs: 60_000 };

describe("the console's live stream", () => {
  test("a page gets a snapshot, then only the sections that change, and new events in plain words", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, FAST);
    let off = async () => {};
    try {
      await config(t.path);
      await intent(t.path, "one", "status: accepted");
      const p = page();
      off = await hub.connect(p.send);
      const [first] = p.messages();
      if (first?.msg.type !== "snapshot") throw new Error("the first message is not a snapshot");
      expect(first.id).toBe("0");
      expect(first.msg.sections.changes.map((c) => c.slug)).toEqual(["one"]);

      await intent(t.path, "two", "status: accepted");
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
      const trace = Trace.open(t.path);
      trace.statusChange("one", "accepted", "designing");
      trace.close();
      await until(() => p.messages().some((m) => m.msg.type === "event"));
      const ev = p.messages().find((m) => m.msg.type === "event")!;
      expect(ev.msg).toMatchObject({ type: "event", item: { slug: "one", type: "status_change", text: "Designing." } });
      expect(Number(ev.id)).toBeGreaterThan(0);
      // Nothing about the totals changed, so they were never sent again.
      expect(p.messages().some((m) => m.msg.type === "section" && m.msg.name === "totals")).toBe(false);
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("a page that comes back gets the events it missed, then a snapshot", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, FAST);
    let off = async () => {};
    try {
      await config(t.path);
      const trace = Trace.open(t.path);
      trace.event("_loop", "tick", {});
      const mark = trace.lastEventId();
      trace.phaseStart("one", "build", "agent");
      trace.event("_loop", "tick", {});
      trace.close();
      const p = page();
      off = await hub.connect(p.send, mark);
      const msgs = p.messages();
      expect(msgs.map((m) => m.msg.type)).toEqual(["event", "snapshot"]);
      expect(msgs[0]!.msg).toMatchObject({ item: { text: "Started build." } });
      expect(msgs[1]!.id).toBe(String(mark + 2));
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("pings keep a quiet stream alive", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, { ...FAST, pingMs: 30 });
    let off = async () => {};
    try {
      await config(t.path);
      const p = page();
      off = await hub.connect(p.send);
      await until(() => p.frames.includes(PING));
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("a page that cannot be written to is dropped, and with no page left the hub stops", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, { ...FAST, pingMs: 30 });
    try {
      await config(t.path);
      const p = page();
      await hub.connect(p.send);
      expect(hub.latest()).not.toBeNull();
      p.close();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-hub.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/hub'`.

- [ ] **Step 3: Write `src/console/hub.ts`**

```ts
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { heartbeatPath } from "../heartbeat";
import { intentRoot } from "../intents";
import { errorText } from "../shell";
import { Trace } from "../trace";
import { activityItem, phaseNamer } from "./describe";
import { buildModel, type Model } from "./model";
import { SECTION_NAMES, type ActivityItem, type SectionName, type StreamMessage } from "./types";

/** Writes one frame to a page; false when the page is gone. */
export type Send = (text: string) => boolean;

/** An SSE frame carrying `msg` as JSON, with an id when given. */
export function frame(msg: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(msg)}\n\n`;
}

/** Sent while nothing else is, so a page can tell a quiet stream from a dead one (comments do not reach its code). */
export const PING = "event: ping\ndata: {}\n\n";

export interface HubOptions {
  chat?: boolean;
  /** How often it looks for changes (ms). */
  intervalMs?: number;
  /** The least time between a watched file changing and the rebuild it causes (ms). */
  minRebuildMs?: number;
  pingMs?: number;
}

/** The most events read for one look, or for a page catching up. */
const CATCH_UP = 500;

function mtime(path: string): string {
  try { return String(statSync(path).mtimeMs); } catch { return "-"; }
}

/**
 * The console's live stream: one per server, shared by every open page. While any page is connected
 * it looks for changes (every `intervalMs`, and soon after a watched file changes), rebuilds the
 * model when anything did, and sends each page the sections that differ and the new events in plain
 * words. With no page connected it holds nothing open and does nothing.
 */
export class Hub {
  private readonly clients = new Set<Send>();
  private connecting = 0;
  private trace: Trace | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private soon: ReturnType<typeof setTimeout> | null = null;
  private watchers: FSWatcher[] = [];
  private model: Model | null = null;
  private readonly sent = new Map<SectionName, string>();
  private signature = "";
  private lastEventId = 0;
  private lastBuild = 0;
  private running: Promise<void> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private readonly noted = new Set<string>();
  private name: ((slug: string, seq: number) => string | undefined) | undefined;

  constructor(private readonly root: string, private readonly opts: HubOptions = {}) {}

  /** The newest model, or null while no page is connected. */
  latest(): Model | null {
    return this.model;
  }

  /** Resolves once the hub has let go of everything after its last page left. */
  whenStopped(): Promise<void> {
    return this.stopping;
  }

  /**
   * Adds a page. A page coming back (`lastEventId` above 0) first gets the events it missed; every
   * page then gets a snapshot whose id is the newest event, so its next reconnect continues from
   * there. Gives the function that removes the page.
   */
  async connect(send: Send, lastEventId = 0): Promise<() => Promise<void>> {
    this.connecting++;
    try {
      this.start();
      await this.look(true);
      if (lastEventId > 0) for (const item of this.events(lastEventId, false)) send(frame({ type: "event", item } satisfies StreamMessage, item.id));
      if (this.model) send(frame({ type: "snapshot", meta: this.model.meta, sections: this.model.sections } satisfies StreamMessage, this.lastEventId));
      this.clients.add(send);
    } finally {
      this.connecting--;
    }
    return () => this.remove(send);
  }

  private remove(send: Send): Promise<void> {
    this.clients.delete(send);
    return this.clients.size || this.connecting ? Promise.resolve() : this.stop();
  }

  private start(): void {
    if (this.trace) return;
    this.trace = Trace.open(this.root);
    this.name = phaseNamer(this.trace);
    this.lastEventId = this.trace.lastEventId();
    this.timers = [
      setInterval(() => void this.look(), this.opts.intervalMs ?? 500),
      setInterval(() => this.broadcast(PING), this.opts.pingMs ?? 15_000),
    ];
    // Watching only makes a change show sooner; the timer finds it anyway where watching does not work.
    for (const [dir, recursive] of [[intentRoot(this.root), true], [join(this.root, ".loopstra"), false]] as const) {
      try {
        const w = watch(dir, { recursive }, () => this.lookSoon());
        w.on("error", () => { /* polling still runs */ });
        this.watchers.push(w);
      } catch { /* the folder is missing, or this system cannot watch it */ }
    }
  }

  private stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const trace = this.trace;
    this.trace = null;
    this.model = null;
    this.sent.clear();
    this.signature = "";
    // A look still running uses the trace; it is closed once that look ends.
    this.stopping = (this.running ?? Promise.resolve()).finally(() => trace?.close());
    return this.stopping;
  }

  private lookSoon(): void {
    if (this.soon || !this.trace) return;
    const wait = Math.max(0, (this.opts.minRebuildMs ?? 250) - (Date.now() - this.lastBuild));
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.look();
    }, wait);
  }

  /** Rebuilds and sends what changed, when anything did (always, when forced). One look at a time. */
  private look(force = false): Promise<void> {
    if (this.running) return this.running;
    const trace = this.trace;
    if (!trace) return Promise.resolve();
    this.running = (async () => {
      try {
        const signature = this.signatureOf(trace);
        if (!force && this.model && signature === this.signature) return;
        this.signature = signature;
        this.lastBuild = Date.now();
        const model = await buildModel(this.root, trace, new Date(), { chat: this.opts.chat });
        if (this.trace !== trace) return;
        this.model = model;
        for (const name of SECTION_NAMES) {
          const json = JSON.stringify(model.sections[name]);
          const before = this.sent.get(name);
          this.sent.set(name, json);
          if (before !== undefined && before !== json) this.broadcast(frame({ type: "section", name, value: model.sections[name] } satisfies StreamMessage));
        }
        for (const item of this.events(this.lastEventId, true)) this.broadcast(frame({ type: "event", item } satisfies StreamMessage, item.id));
      } catch (e) {
        this.note(errorText(e));
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * A cheap fingerprint of what the model reads: the newest event, the heartbeat, the pause, the
   * config and every intent's file. The ten-second bucket keeps "last check 20s ago" and the ages fresh.
   */
  private signatureOf(trace: Trace): string {
    const parts = [String(trace.lastEventId()), String(Math.floor(Date.now() / 10_000))];
    for (const p of [heartbeatPath(this.root), join(this.root, ".loopstra", "paused.json"), join(this.root, "loopstra", "config.yaml")]) parts.push(mtime(p));
    const dir = intentRoot(this.root);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* no intent folder yet */ }
    for (const n of names.sort()) parts.push(n, mtime(join(dir, n)), mtime(join(dir, n, "intent.md")));
    return parts.join("|");
  }

  /** The plain-words events after `afterId`; with `advance`, the hub's own mark moves past every event read. */
  private events(afterId: number, advance: boolean): ActivityItem[] {
    if (!this.trace) return [];
    const rows = this.trace.eventsAfter(afterId, CATCH_UP);
    if (advance && rows.length) this.lastEventId = rows.at(-1)!.id;
    return rows.map((e) => activityItem(e, this.name)).filter((a) => a.text !== null);
  }

  private broadcast(text: string): void {
    for (const send of [...this.clients]) if (!send(text)) void this.remove(send);
  }

  /** Traces a problem once, not on every look. */
  private note(what: string): void {
    if (this.noted.has(what)) return;
    this.noted.add(what);
    try { this.trace?.event("_loop", "error", { where: "console", what }); } catch { /* the console never stops over its own trace */ }
  }
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/unit/console-hub.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/console/hub.ts tests/unit/console-hub.test.ts
git commit -m "feat(console): the hub sends every open page the sections that changed and new events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: One phase's transcript as a stream

**Files:**
- Create: `src/console/session.ts`
- Test: `tests/unit/console-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamSession } from "../../src/console/session";
import type { SessionMessage, TranscriptItem } from "../../src/console/types";
import { Trace } from "../../src/trace";
import { parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

const lines = (events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const START = [
  { type: "system", subtype: "init", cwd: "/wt", model: "m" },
  { type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] } },
];
const REST = [
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 pass" }] } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, structured_output: { summary: "Done." } },
];

/** A page for one session stream. */
function page() {
  const frames: string[] = [];
  const p = { frames, closed: false, send: (f: string) => { frames.push(f); return true; }, close: () => { p.closed = true; } };
  return p;
}
const messages = (frames: string[]) => parseFrames(frames.join("")).map((f) => ({ id: f.id, msg: f.data as SessionMessage }));
const kinds = (frames: string[]) => messages(frames).flatMap((m) => (m.msg.type === "item" ? [(m.msg.item as TranscriptItem).kind] : []));

describe("a session's stream", () => {
  test("sends the transcript as it is written, says when the phase has ended, and can start from an offset", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    const stops: Array<() => void> = [];
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      const dir = join(t.path, ".loopstra", "runs", "one", "phases", `${seq}-build`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "raw.jsonl"), lines(START));
      const p = page();
      stops.push(streamSession(t.path, "one", seq, 0, p.send, p.close, 20)!);
      await until(() => kinds(p.frames).length === 2);
      expect(messages(p.frames)[0]!.msg).toMatchObject({ type: "phase", name: "build", status: "running", ended: null });

      appendFileSync(join(dir, "raw.jsonl"), lines(REST));
      trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
      await until(() => p.closed);
      expect(kinds(p.frames)).toEqual(["text", "tool", "tool-result", "result"]);
      expect(messages(p.frames).slice(-2).map((m) => m.msg)).toEqual([
        { type: "phase", name: "build", status: "success", started: expect.any(String), ended: expect.any(String) },
        { type: "end" },
      ]);
      const ids = messages(p.frames).filter((m) => m.msg.type === "item").map((m) => Number(m.id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));

      // From the offset after the tool's result: only what came after it.
      const later = page();
      stops.push(streamSession(t.path, "one", seq, ids[2]!, later.send, later.close, 20)!);
      await until(() => later.closed);
      expect(kinds(later.frames)).toEqual(["result"]);
    } finally {
      for (const stop of stops) stop();
      trace.close();
      t.cleanup();
    }
  });

  test("no stream for a phase that does not exist", () => {
    const t = tempDir();
    try {
      expect(streamSession(t.path, "one", 99, 0, () => true, () => {})).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-session.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/session'`.

- [ ] **Step 3: Write `src/console/session.ts`**

```ts
import { join } from "node:path";
import { Trace, type PhaseRow } from "../trace";
import { runsDir } from "./files";
import { frame, type Send } from "./hub";
import { TranscriptReader } from "./transcript";
import type { SessionMessage } from "./types";

const phaseMessage = (p: PhaseRow): SessionMessage => ({ type: "phase", name: p.name, status: p.status, started: p.started, ended: p.ended });

/**
 * Streams one phase's transcript from byte `from`: first the phase, then each item with the offset
 * after its line as its id, so a page that reconnects continues there. Checks the file every
 * `intervalMs` (watching a growing file is unreliable on Windows). Once the phase has ended and its
 * file is read to the end, sends the phase again and `end`, then closes. Gives the function that
 * stops it, or null when there is no such phase.
 */
export function streamSession(root: string, slug: string, seq: number, from: number, send: Send, close: () => void, intervalMs = 250): (() => void) | null {
  const trace = Trace.open(root);
  const first = trace.phase(slug, seq);
  if (!first) {
    trace.close();
    return null;
  }
  const reader = new TranscriptReader(join(runsDir(root), slug, "phases", `${seq}-${first.name}`, "raw.jsonl"), from);
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    trace.close();
  };
  const step = () => {
    if (done) return;
    for (const { item, offset } of reader.read()) {
      if (!send(frame({ type: "item", item } satisfies SessionMessage, offset))) return stop();
    }
    const p = trace.phase(slug, seq);
    if (p?.ended && reader.atEnd()) {
      send(frame(phaseMessage(p)));
      send(frame({ type: "end" } satisfies SessionMessage));
      stop();
      close();
    }
  };
  send(frame(phaseMessage(first)));
  timer = setInterval(step, intervalMs);
  step();
  return stop;
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/unit/console-session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/console/session.ts tests/unit/console-session.test.ts
git commit -m "feat(console): one phase's transcript as a stream that ends with the phase" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The page's logic

Everything the page decides without a DOM lives in plain `.ts` files with tests. The views later only render it.

**Files:**
- Create: `src/ui/format.ts`, `src/ui/router.ts`, `src/ui/keys.ts`, `src/ui/palette.ts`, `src/ui/diff.ts`, `src/ui/markdown.ts`, `src/ui/transcript.ts`, `src/ui/store.ts`
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ui-logic.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ActivityItem, Sections } from "../../src/console/types";
import { parseDiff } from "../../src/ui/diff";
import { costSoFar, duration, pillText, shortModel, usd } from "../../src/ui/format";
import { keyMatcher, keyName, typingIn } from "../../src/ui/keys";
import { renderMarkdown, stripFrontmatter } from "../../src/ui/markdown";
import { filterCommands, fuzzyScore } from "../../src/ui/palette";
import { parseRoute, routePath, type Route } from "../../src/ui/router";
import { ACTIVITY_MAX, applyMessage, type State } from "../../src/ui/store";
import { addItems, EMPTY } from "../../src/ui/transcript";

describe("formatting", () => {
  test("money, durations, running costs, models and the loop pill", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.814)).toBe("$0.81");
    expect(usd(0.81, true)).toBe("~$0.81");
    expect(usd(1234.4)).toBe("$1,234");
    expect(duration(45_000)).toBe("45s");
    expect(duration(372_000)).toBe("6m 12s");
    expect(duration(7_380_000)).toBe("2h 3m");
    expect(duration(100 * 3_600_000)).toBe("4d 4h");
    expect(costSoFar(new Date(0).toISOString(), 5 * 60_000, 0.2)).toBeCloseTo(1);
    expect(shortModel("claude-sonnet-5-5")).toBe("sonnet 5.5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(shortModel("opus")).toBe("opus");
    expect(pillText({ state: "running", text: "Running — working on a and b, last check 3s ago", working: [{ slug: "a" }, { slug: "b" }] })).toBe("Running · 2 agents");
    expect(pillText({ state: "running", text: "Running — last check 3s ago", working: [] })).toBe("Running");
    expect(pillText({ state: "running", text: "Stopping — last check 3s ago", working: [{ slug: "a" }] })).toBe("Stopping");
    expect(pillText({ state: "not-responding", text: "Not responding (last check 14 min ago)", working: [] })).toBe("Not responding");
  });
});

describe("routes", () => {
  test("paths become screens and back", () => {
    expect(parseRoute("/")).toEqual({ name: "live" });
    expect(parseRoute("/inbox")).toEqual({ name: "inbox" });
    expect(parseRoute("/c/csv-export")).toEqual({ name: "change", slug: "csv-export", tab: "overview" });
    expect(parseRoute("/c/csv-export/code")).toEqual({ name: "change", slug: "csv-export", tab: "code" });
    expect(parseRoute("/s/csv-export/12")).toEqual({ name: "session", slug: "csv-export", seq: 12 });
    expect(parseRoute("/s/_chat/3")).toEqual({ name: "session", slug: "_chat", seq: 3 });
    for (const bad of ["/c/Bad", "/c/one/nope", "/s/one/x", "/nope", "/c/one/code/more", "/c/%E0%A4%A"]) expect(parseRoute(bad)).toEqual({ name: "missing", path: bad });
    const all: Route[] = [
      { name: "live" }, { name: "inbox" }, { name: "changes" }, { name: "activity" }, { name: "spend" },
      { name: "change", slug: "a", tab: "overview" }, { name: "change", slug: "a", tab: "gates" }, { name: "session", slug: "a", seq: 4 },
    ];
    for (const r of all) expect(parseRoute(routePath(r))).toEqual(r);
  });
});

describe("keys", () => {
  test("sequences must be finished in time; a wrong second key starts over with that key", () => {
    const press = keyMatcher([{ keys: "g l", action: "live" }, { keys: "g i", action: "inbox" }, { keys: "mod+k", action: "palette" }, { keys: "?", action: "help" }]);
    expect(press("g", 0)).toBeNull();
    expect(press("l", 100)).toBe("live");
    expect(press("g", 200)).toBeNull();
    expect(press("i", 2000)).toBeNull();
    expect(press("mod+k", 2100)).toBe("palette");
    expect(press("g", 3000)).toBeNull();
    expect(press("?", 3100)).toBe("help");
  });

  test("key names, and typing in a field is not a shortcut", () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(keyName(key("K", { ctrlKey: true }))).toBe("mod+k");
    expect(keyName(key("j", { metaKey: true }))).toBe("mod+j");
    expect(keyName(key("Escape"))).toBe("escape");
    expect(keyName(key("J"))).toBe("j");
    expect(keyName(key("x", { altKey: true }))).toBeNull();
    expect(typingIn({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(typingIn({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(typingIn({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});

describe("the command palette's matching", () => {
  test("letters in order, runs and word starts first, ties kept in order", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("cx", "csv-export")).not.toBeNull();
    expect(fuzzyScore("xz", "csv-export")).toBeNull();
    expect(fuzzyScore("csv", "Open csv-export")!).toBeGreaterThan(fuzzyScore("csv", "Choose some values")!);
    const items = [{ title: "Go to Inbox" }, { title: "Open csv-export" }, { title: "Open dark-mode" }];
    expect(filterCommands(items, "")).toEqual(items);
    expect(filterCommands(items, "dark").map((i) => i.title)).toEqual(["Open dark-mode"]);
    expect(filterCommands(items, "op").map((i) => i.title)).toEqual(["Open csv-export", "Open dark-mode"]);
  });
});

describe("diffs", () => {
  test("git's diffs and an edit's diff become rows; a deleted line that looks like a header stays a line", () => {
    const git = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n--- sql comment\n\\ No newline at end of file\n";
    expect(parseDiff(git)).toEqual([
      { kind: "file", text: "src/a.ts" }, { kind: "hunk", text: "@@ -1,2 +1,2 @@" }, { kind: "ctx", text: "keep" },
      { kind: "del", text: "old" }, { kind: "add", text: "new" }, { kind: "del", text: "-- sql comment" }, { kind: "meta", text: "\\ No newline at end of file" },
    ]);
    expect(parseDiff("--- src/csv.ts\n+++ src/csv.ts\n@@ edit @@\n-a\n+c")).toEqual([
      { kind: "file", text: "src/csv.ts" }, { kind: "hunk", text: "@@ edit @@" }, { kind: "del", text: "a" }, { kind: "add", text: "c" },
    ]);
  });
});

describe("markdown", () => {
  test("raw HTML is shown as text, only safe links are links, and frontmatter is left out", () => {
    const html = renderMarkdown("# Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[ok](https://x.y) [bad](javascript:alert(1)) ![pic](http://e/x.png)\n\n| a | b |\n|---|---|\n| 1 | <b>2</b> |\n");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://x.y" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).toContain("&lt;b&gt;2&lt;/b&gt;");
    expect(html).toContain("<table>");
    expect(stripFrontmatter("---\nstatus: draft\n---\n# Intent: x\n")).toBe("# Intent: x\n");
    expect(stripFrontmatter("# No frontmatter\n")).toBe("# No frontmatter\n");
  });
});

describe("a transcript on the page", () => {
  test("results attach to their calls, the todo list is the newest one, and the old state is left alone", () => {
    const s = addItems(EMPTY, [
      { kind: "text", text: "a" },
      { kind: "tool", id: "t1", tool: "Bash", target: "x", input: {} },
      { kind: "todos", items: [{ text: "x", state: "pending" }] },
    ]);
    const s2 = addItems(s, [{ kind: "tool-result", id: "t1", ok: true, output: "done" }, { kind: "todos", items: [] }]);
    expect(s2.items.map((i) => i.kind)).toEqual(["text", "tool"]);
    expect(s2.results.t1).toEqual({ ok: true, output: "done" });
    expect(s2.todos).toEqual([]);
    expect(s.results).toEqual({});
  });
});

describe("the page's state", () => {
  const sections: Sections = {
    loop: { state: "stopped", text: "Stopped", working: [], nextCheck: null },
    inbox: [], changes: [], running: { now: [], recent: [] }, totals: { todayUsd: 0, weekUsd: 0, allUsd: 0 },
  };

  test("a snapshot sets everything; a section replaces only itself; events are kept once, up to a limit", () => {
    let s: State = { meta: null, sections: {}, activity: [] };
    s = applyMessage(s, { type: "snapshot", meta: { chat: true, usdPerMinute: 0.2, pollSeconds: 60 }, sections });
    expect(s.meta?.chat).toBe(true);
    const changes = s.sections.changes;
    s = applyMessage(s, { type: "section", name: "inbox", value: [{ kind: "blocked", label: "Blocked", slug: "a", title: "A", what: "w" }] });
    expect(s.sections.inbox).toHaveLength(1);
    expect(s.sections.changes).toBe(changes); // untouched sections keep their identity, so their screens do not redraw
    const item = (id: number): ActivityItem => ({ id, slug: "a", seq: null, ts: "t", type: "phase_start", text: "Started build.", technical: "x" });
    s = applyMessage(s, { type: "event", item: item(5) });
    s = applyMessage(s, { type: "event", item: item(5) });
    expect(s.activity.map((a) => a.id)).toEqual([5]);
    for (let i = 6; i < ACTIVITY_MAX + 20; i++) s = applyMessage(s, { type: "event", item: item(i) });
    expect(s.activity).toHaveLength(ACTIVITY_MAX);
    expect(s.activity.at(-1)?.id).toBe(ACTIVITY_MAX + 19);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/ui-logic.test.ts`
Expected: FAIL: `Cannot find module '../../src/ui/diff'`.

- [ ] **Step 3: Write `src/ui/format.ts`**

```ts
import type { LoopSection } from "../console/types";

/** "$0.81"; "~$0.81" for an estimate; "$0" for nothing worth a cent. */
export function usd(n: number, estimate = false): string {
  const v = n < 0.005 ? "$0" : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
  return estimate ? `~${v}` : v;
}

/** "45s", "6m 12s", "2h 3m", "4d 4h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long ago, short: "now", "4s", "3m", "2h", "5d". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** "14:02" in local time, with the day in front when it is not today. */
export function clock(iso: string, now: number): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

/** A running session's estimated cost: the minutes so far times the rate (the CLI reports cost only at the end). */
export function costSoFar(started: string, now: number, usdPerMinute: number): number {
  return Math.max(0, (now - Date.parse(started)) / 60_000) * usdPerMinute;
}

/** "claude-sonnet-5-5" as "sonnet 5.5". */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)(?:-\d{8})?$/, " $1.$2").replace(/-/g, " ");
}

const STATE: Record<LoopSection["state"], string> = { running: "Running", paused: "Paused", stopped: "Stopped", "not-responding": "Not responding" };

/** The loop pill's words: its state and how many agents work. The full sentence goes in its tooltip. */
export function pillText(loop: Pick<LoopSection, "state" | "text"> & { working: unknown[] }): string {
  if (loop.text.startsWith("Stopping")) return "Stopping";
  const n = loop.working.length;
  return n ? `${STATE[loop.state]} · ${n} ${n === 1 ? "agent" : "agents"}` : STATE[loop.state];
}
```

- [ ] **Step 4: Write `src/ui/router.ts`**

```ts
export type Tab = "overview" | "documents" | "timeline" | "code" | "gates";
export const TABS: readonly Tab[] = ["overview", "documents", "timeline", "code", "gates"];

export type Route =
  | { name: "live" } | { name: "inbox" } | { name: "changes" } | { name: "activity" } | { name: "spend" }
  | { name: "change"; slug: string; tab: Tab }
  | { name: "session"; slug: string; seq: number }
  | { name: "missing"; path: string };

/** A change's name, or one of the trace's own (`_chat`). The server's page routes match these paths. */
const SLUG = /^_?[a-z0-9][a-z0-9-]*$/;

function decode(part: string): string | null {
  try { return decodeURIComponent(part); } catch { return null; }
}

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(decode);
  const missing: Route = { name: "missing", path };
  if (parts.some((p) => p === null)) return missing;
  const [a, b, c] = parts as string[];
  if (!a) return { name: "live" };
  if (parts.length === 1 && (a === "inbox" || a === "changes" || a === "activity" || a === "spend")) return { name: a };
  if (a === "c" && b && SLUG.test(b) && !b.startsWith("_") && parts.length <= 3) {
    if (!c) return { name: "change", slug: b, tab: "overview" };
    if ((TABS as readonly string[]).includes(c)) return { name: "change", slug: b, tab: c as Tab };
  }
  if (a === "s" && b && SLUG.test(b) && c && /^\d+$/.test(c) && parts.length === 3) return { name: "session", slug: b, seq: Number(c) };
  return missing;
}

export function routePath(r: Route): string {
  switch (r.name) {
    case "live": return "/";
    case "change": return r.tab === "overview" ? `/c/${r.slug}` : `/c/${r.slug}/${r.tab}`;
    case "session": return `/s/${r.slug}/${r.seq}`;
    case "missing": return r.path;
    default: return `/${r.name}`;
  }
}
```

- [ ] **Step 5: Write `src/ui/keys.ts`**

```ts
export interface Binding { keys: string; action: string }

/**
 * Turns key names into actions. A sequence ("g l") must be finished within `windowMs`; a second key
 * that does not continue one starts over with that key on its own.
 */
export function keyMatcher(bindings: Binding[], windowMs = 1000): (key: string, now: number) => string | null {
  let pending: { keys: string[]; at: number } | null = null;
  return (key, now) => {
    const prefix = pending && now - pending.at <= windowMs ? pending.keys : [];
    for (const seq of prefix.length ? [[...prefix, key], [key]] : [[key]]) {
      const joined = seq.join(" ");
      const exact = bindings.find((b) => b.keys === joined);
      if (exact) {
        pending = null;
        return exact.action;
      }
      if (bindings.some((b) => b.keys.startsWith(`${joined} `))) {
        pending = { keys: seq, at: now };
        return null;
      }
    }
    pending = null;
    return null;
  };
}

/** "mod+k" for Ctrl or Cmd with K, "escape", "j"; null with Alt, which the page leaves to the browser. */
export function keyName(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.altKey) return null;
  const key = e.key.toLowerCase();
  return e.ctrlKey || e.metaKey ? `mod+${key}` : key;
}

/** Whether a key press lands in something a person types into. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName ?? ""));
}
```

- [ ] **Step 6: Write `src/ui/palette.ts`**

```ts
export interface Command { id: string; title: string; hint?: string; run: () => void }

/**
 * How well `query` matches `text`: null when its letters are not all there in order; otherwise
 * higher for letters that follow each other and for letters that start a word.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || /[\s\-_/]/.test(t[i - 1]!)) score += 2;
    prev = i;
    from = i + 1;
  }
  return score;
}

/** The items whose title matches, best first (ties keep their order), at most `limit`. */
export function filterCommands<T extends { title: string }>(items: T[], query: string, limit = 12): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item.title) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
```

- [ ] **Step 7: Write `src/ui/diff.ts`**

```ts
export type DiffRow = { kind: "file" | "hunk" | "add" | "del" | "ctx" | "meta"; text: string };

/**
 * Unified diff text as rows: git's (`diff --git`, its header, hunks) or an edit's from a transcript
 * (`--- path`, `+++ path`, hunks). A `---` line counts as a header only when a `+++` line follows it.
 */
export function parseDiff(text: string): DiffRow[] {
  const lines = text.split(/\r?\n/);
  const rows: DiffRow[] = [];
  let header = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (line.startsWith("diff --git ")) {
      rows.push({ kind: "file", text: line.replace(/^diff --git a\/.+? b\//, "") });
      header = true;
    } else if (line.startsWith("--- ") && lines[k + 1]?.startsWith("+++ ")) {
      if (!header) rows.push({ kind: "file", text: line.slice(4).replace(/^a\//, "") });
      k++;
    } else if (header && !line.startsWith("@@")) {
      // git's index, mode and rename lines are left out; a binary file says so.
      if (line.startsWith("Binary files")) rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("@@")) {
      rows.push({ kind: "hunk", text: line });
      header = false;
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", text: line.slice(1) });
    else if (line) rows.push({ kind: "meta", text: line });
  }
  return rows;
}
```

- [ ] **Step 8: Write `src/ui/markdown.ts`**

```ts
import { Marked } from "marked";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Links go to the web or stay relative; anything else (javascript:, data:, file:) is shown as its text. */
function safeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * Markdown from documents, notes and agents is untrusted: raw HTML is shown as text, images as
 * their alt text (nothing is fetched), and only safe links are links, opening in a new tab.
 */
const md = new Marked({ gfm: true, async: false });
md.use({
  renderer: {
    html(token) { return escapeHtml(token.text); },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      return safeHref(token.href) ? `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token) { return escapeHtml(token.text || token.href); },
  },
});

export function renderMarkdown(text: string): string {
  return md.parse(text) as string;
}

/** intent.md without its status block, which the page shows on its own. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}
```

- [ ] **Step 9: Write `src/ui/transcript.ts`**

```ts
import type { TranscriptItem } from "../console/types";

/** What a transcript shows: its items in order, each call's result by id, and the newest todo list. */
export interface Shown {
  items: Array<Exclude<TranscriptItem, { kind: "tool-result" | "todos" }>>;
  results: Record<string, { ok: boolean; output: string }>;
  todos: Array<{ text: string; state: string }> | null;
}

export const EMPTY: Shown = { items: [], results: {}, todos: null };

/** `s` with `more` added; `s` itself is left as it was. */
export function addItems(s: Shown, more: TranscriptItem[]): Shown {
  const items = [...s.items];
  const results = { ...s.results };
  let todos = s.todos;
  for (const it of more) {
    if (it.kind === "tool-result") results[it.id] = { ok: it.ok, output: it.output };
    else if (it.kind === "todos") todos = it.items;
    else items.push(it);
  }
  return { items, results, todos };
}
```

- [ ] **Step 10: Write `src/ui/store.ts`**

```ts
import { computed, signal } from "@preact/signals";
import type { ActivityItem, Meta, Sections, StreamMessage } from "../console/types";

export interface State { meta: Meta | null; sections: Partial<Sections>; activity: ActivityItem[] }

/** The most live events the page keeps. */
export const ACTIVITY_MAX = 500;
/** How long the stream may be silent (pings included) before the page says it is reconnecting. */
export const STALE_MS = 20_000;

/** What one stream message does to the state. Sections it does not touch keep their identity. */
export function applyMessage(s: State, msg: StreamMessage): State {
  switch (msg.type) {
    case "snapshot": return { meta: msg.meta, sections: { ...msg.sections }, activity: s.activity };
    case "section": return { ...s, sections: { ...s.sections, [msg.name]: msg.value } };
    case "event":
      if (s.activity.some((a) => a.id === msg.item.id)) return s;
      return { ...s, activity: [...s.activity, msg.item].slice(-ACTIVITY_MAX) };
  }
}

export const state = signal<State>({ meta: null, sections: {}, activity: [] });
export const meta = computed(() => state.value.meta);
export const loop = computed(() => state.value.sections.loop ?? null);
export const inbox = computed(() => state.value.sections.inbox ?? null);
export const changes = computed(() => state.value.sections.changes ?? null);
export const running = computed(() => state.value.sections.running ?? null);
export const totals = computed(() => state.value.sections.totals ?? null);
export const activity = computed(() => state.value.activity);

export type Connection = "connecting" | "live" | "stale";
export const connection = signal<Connection>("connecting");
/** The time, refreshed every second, for clocks and ages. */
export const now = signal(Date.now());

/** The orchestrator's drawer; `about` is what it was opened from ("csv-export"), or null. */
export const drawer = signal<{ open: boolean; about: string | null }>({ open: false, about: null });
export const paletteOpen = signal(false);
export const helpOpen = signal(false);

export function openDrawer(about: string | null = null): void {
  drawer.value = { open: true, about };
}

export interface Toast { id: number; text: string; kind: "info" | "bad" }
export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, 6000);
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.json() as T;
}

/**
 * Opens the live stream. EventSource reconnects by itself (sending the newest id it saw, so the
 * server can send the events it missed); when it gives up, this opens a new one, waiting 1, 2, 4,
 * then 8 seconds.
 */
export function connect(): void {
  let last = Date.now();
  let wait = 1000;
  const open = () => {
    const source = new EventSource("/api/stream");
    const alive = () => {
      last = Date.now();
      wait = 1000;
      connection.value = "live";
    };
    source.onmessage = (ev) => {
      alive();
      try { state.value = applyMessage(state.value, JSON.parse(ev.data as string) as StreamMessage); } catch { /* a bad frame is skipped */ }
    };
    source.addEventListener("ping", alive);
    source.onerror = () => {
      connection.value = "stale";
      if (source.readyState === EventSource.CLOSED) {
        setTimeout(open, wait);
        wait = Math.min(wait * 2, 8000);
      }
    };
  };
  open();
  setInterval(() => {
    now.value = Date.now();
    if (connection.value === "live" && Date.now() - last > STALE_MS) connection.value = "stale";
  }, 1000);
}
```

- [ ] **Step 11: Run the test to make sure it passes**

Run: `bun test tests/unit/ui-logic.test.ts && bun run typecheck`
Expected: PASS (11 tests); typecheck prints nothing.

- [ ] **Step 12: Commit**

```bash
git add src/ui/format.ts src/ui/router.ts src/ui/keys.ts src/ui/palette.ts src/ui/diff.ts src/ui/markdown.ts src/ui/transcript.ts src/ui/store.ts tests/unit/ui-logic.test.ts
git commit -m "feat(console): the page's logic: routes, keys, matching, diffs, safe markdown, transcript and stream state" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The server takes over `loopstra ui`

This swaps the old page and `/api/state` for the console's server, with a placeholder page that Task 14 fills in.

**Files:**
- Create: `src/console/server.ts`
- Replace: `src/ui/index.html` (the old page goes), `src/commands/ui.ts`
- Create: `src/ui/app.tsx`, `src/ui/theme.css` (placeholders, filled in by Task 14)
- Modify: `src/cli.ts:21` (help line) and `src/cli.ts:85-102` (the `ui` command)
- Delete: `tests/unit/ui.test.ts` (its tests moved to the console test files in Tasks 7 and 8, and to this task's)
- Modify: `tests/unit/chat-transports.test.ts:9`, `:61`, `:85-88`, `:94-111`
- Test: `tests/unit/console-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/unit/console-server.test.ts`
Expected: FAIL: `Cannot find module '../../src/console/server'`.

- [ ] **Step 3: Replace the page with the new one's frame**

Replace `src/ui/index.html` (the whole old page goes) with:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loopstra</title>
<link rel="icon" id="favicon" href="data:,">
<link rel="stylesheet" href="./theme.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="./app.tsx"></script>
</body>
</html>
```

Create the placeholder `src/ui/theme.css`:

```css
body { margin: 0; background: #0d0e11; color: #e8eaee; font: 14px/1.5 system-ui, sans-serif; }
```

Create the placeholder `src/ui/app.tsx`:

```tsx
import { render } from "preact";

render(<p>Loopstra</p>, document.getElementById("app")!);
```

- [ ] **Step 4: Write `src/console/server.ts`**

```ts
import page from "../ui/index.html";
import type { DashboardTransport } from "../chat/transports/dashboard";
import { loadConfig, type Config } from "../config";
import { SLUG } from "../intents";
import { Trace } from "../trace";
import { eventsPage } from "./describe";
import { changeDetail, spendView } from "./detail";
import { changeDiff } from "./diff";
import { resolveDocument, resolveRunFile } from "./files";
import { Hub, type Send } from "./hub";
import { streamSession } from "./session";

/** Host names the console answers to: a page on another name that resolves here (DNS rebinding) gets nothing. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A change's name, or one of the trace's own (_chat, _loop, _signals). */
const ANY_SLUG = /^_?[a-z0-9][a-z0-9-]*$/;
const PLAIN_TEXT = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };
const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

type Timeouts = { timeout(req: Request, seconds: number): void };

/**
 * The console on 127.0.0.1. Bun bundles the page once at start and serves it and its chunks itself,
 * on the screens' paths (the page's router knows the same ones). They are the same static code for
 * everyone and never reach `fetch`, so only the data routes check the host. Read-only, apart from
 * `/api/chat` when `chat` is given (see DashboardTransport).
 */
export function serveConsole(root: string, port = 4646, opts: { chat?: DashboardTransport; hub?: Hub } = {}): ReturnType<typeof Bun.serve> {
  const hub = opts.hub ?? new Hub(root, { chat: !!opts.chat });
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,
    routes: { "/": page, "/inbox": page, "/changes": page, "/activity": page, "/spend": page, "/c/*": page, "/s/*": page },
    async fetch(req, server) {
      const url = new URL(req.url);
      if (!LOCAL_HOSTS.has(url.hostname)) return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/api/chat" && opts.chat) return opts.chat.handle(req, url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Read only", { status: 405 });
      return (await read(root, hub, req, url, server)) ?? NOT_FOUND();
    },
  });
}

/**
 * The data routes: `/api/stream`, `/api/changes/<slug>` and its `/diff`, `/api/sessions/<slug>/<seq>/stream`,
 * `/api/events`, `/api/spend`, run files under `/files/`, a change's documents under `/docs/`. Null: not found.
 */
async function read(root: string, hub: Hub, req: Request, url: URL, server: Timeouts): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/stream") {
    const last = Number(req.headers.get("last-event-id") ?? 0);
    return sse(server, req, async (send) => {
      const off = await hub.connect(send, Number.isFinite(last) && last > 0 ? last : 0);
      return () => void off();
    });
  }
  const change = path.match(/^\/api\/changes\/([^/]+)(\/diff)?$/);
  if (change) {
    const slug = decode(change[1]!);
    if (!slug || !SLUG.test(slug)) return null;
    if (change[2]) return Response.json(await changeDiff(root, (await config(root))?.main_branch ?? "main", slug));
    const d = await withTrace(root, (t) => changeDetail(root, t, slug));
    return d ? Response.json(d) : null;
  }
  const session = path.match(/^\/api\/sessions\/([^/]+)\/(\d+)\/stream$/);
  if (session) {
    const slug = decode(session[1]!);
    const seq = Number(session[2]);
    if (!slug || !ANY_SLUG.test(slug)) return null;
    if (!(await withTrace(root, (t) => t.phase(slug, seq) !== null))) return null;
    const from = Number(req.headers.get("last-event-id") ?? url.searchParams.get("from") ?? 0);
    return sse(server, req, (send, close) => streamSession(root, slug, seq, Number.isFinite(from) && from > 0 ? from : 0, send, close) ?? (() => {}));
  }
  if (path === "/api/events") {
    const slug = url.searchParams.get("slug") || undefined;
    if (slug && !ANY_SLUG.test(slug)) return Response.json({ error: "slug" }, { status: 400 });
    const before = Number(url.searchParams.get("before") ?? 0);
    return Response.json(await withTrace(root, (t) => eventsPage(t, Number.isFinite(before) && before > 0 ? before : 0, slug, url.searchParams.get("technical") === "1")));
  }
  if (path === "/api/spend") {
    const cfg = await config(root);
    return Response.json(await withTrace(root, (t) => spendView(root, t, cfg)));
  }
  if (path.startsWith("/files/")) {
    const rel = decode(path.slice("/files/".length));
    const file = rel === null ? null : resolveRunFile(root, rel);
    return file ? new Response(Bun.file(file), { headers: PLAIN_TEXT }) : null;
  }
  if (path.startsWith("/docs/")) {
    const parts = path.slice("/docs/".length).split("/").map(decode);
    const file = parts.length === 2 && parts[0] && parts[1] ? resolveDocument(root, parts[0], parts[1]) : null;
    return file ? new Response(Bun.file(file), { headers: PLAIN_TEXT }) : null;
  }
  return null;
}

/**
 * An SSE response. `start` gets a writer and a closer and gives back the function that stops it,
 * which runs once, when the page goes away. The request's idle limit is lifted, since a quiet
 * stream is still alive.
 */
function sse(server: Timeouts, req: Request, start: (send: Send, close: () => void) => (() => void) | Promise<() => void>): Response {
  server.timeout(req, 0);
  let stop: (() => void) | null = null;
  let gone = false;
  const end = () => {
    if (gone) return;
    gone = true;
    stop?.();
  };
  const stream = new ReadableStream<string>({
    async start(controller) {
      const send: Send = (text) => {
        if (gone) return false;
        try { controller.enqueue(text); return true; } catch { return false; }
      };
      const close = () => { try { controller.close(); } catch { /* already closed */ } };
      stop = await start(send, close);
      if (gone) stop();
    },
    cancel: end,
  });
  req.signal.addEventListener("abort", end);
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function decode(part: string): string | null {
  try { return decodeURIComponent(part); } catch { return null; }
}

async function config(root: string): Promise<Config | null> {
  try { return await loadConfig(root); } catch { return null; }
}

async function withTrace<T>(root: string, fn: (t: Trace) => T | Promise<T>): Promise<T> {
  const trace = Trace.open(root);
  try { return await fn(trace); } finally { trace.close(); }
}
```

- [ ] **Step 5: Make `src/commands/ui.ts` the command only**

Replace the whole file with:

```ts
import { serveConsole } from "../console/server";

/** `loopstra ui`: the console on 127.0.0.1, with the orchestrator's chat unless `chat` is false. Runs until the process ends. */
export async function ui(root: string, port: number, chat: boolean): Promise<number> {
  let dashboard: import("../chat/transports/dashboard").DashboardTransport | undefined;
  if (chat) {
    const { DashboardTransport } = await import("../chat/transports/dashboard");
    const { ChatService } = await import("../chat/service");
    dashboard = new DashboardTransport(root);
    await new ChatService(root, [dashboard]).start();
  }
  const server = serveConsole(root, port, { chat: dashboard });
  console.log(`Loopstra console: http://127.0.0.1:${server.port}  (Ctrl-C to stop)`);
  await new Promise(() => {});
  return 0;
}
```

In `src/cli.ts`, change the help line (line 21) to:

```
  ui        the console: live agents, inbox, changes and chat (--port <n>, default 4646; --no-chat)
```

and replace the `case "ui"` block (lines 85-102) with:

```ts
    case "ui": {
      if (!setUp()) return 1;
      const flag = rest.indexOf("--port");
      const port = flag >= 0 ? Number(rest[flag + 1]) : 4646;
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("Usage: loopstra ui [--port <number>]"); return 1; }
      const { ui } = await import("./commands/ui");
      return ui(root, port, !rest.includes("--no-chat"));
    }
```

- [ ] **Step 6: Point the chat tests at the console**

In `tests/unit/chat-transports.test.ts`:

1. Replace `import { buildState, serveUi } from "../../src/commands/ui";` (line 9) with:

```ts
import { Hub } from "../../src/console/hub";
import { serveConsole } from "../../src/console/server";
import { model, sseFrames } from "../console-helpers";
```

2. In "posts need the page's own origin; the reply is read back from the thread", replace `const server = serveUi(r.root, 0, { chat: dash });` with:

```ts
    const hub = new Hub(r.root, { chat: true });
    const server = serveConsole(r.root, 0, { chat: dash, hub });
```

replace the three lines after `// Everything else stays read-only, and the page is told it has a chat panel.` with:

```ts
      // Everything else stays read-only, and the page is told it has chat.
      expect((await fetch(`${base}/api/spend`, { method: "POST" })).status).toBe(405);
      const [first] = await sseFrames(`${base}/api/stream`, 1);
      expect(first!.data).toMatchObject({ type: "snapshot", meta: { chat: true } });
```

and make its `finally` wait for the hub before cleaning up:

```ts
    } finally {
      server.stop(true);
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      await service.stop();
      r.cleanup();
    }
```

3. In "without chat, /api/chat is not there and the totals include what chat spent", replace

```ts
      const state = await buildState(r.root, 0);
      expect(state.chat).toBe(false);
      expect(state.totals.todayUsd).toBeCloseTo(0.25);
      const server = serveUi(r.root, 0);
```

with

```ts
      const m = await model(r.root);
      expect(m.meta.chat).toBe(false);
      expect(m.sections.totals.todayUsd).toBeCloseTo(0.25);
      const server = serveConsole(r.root, 0);
```

- [ ] **Step 7: Remove the old dashboard's tests**

Run: `git rm tests/unit/ui.test.ts`

Their cases now live in `console-model.test.ts` (loop state, running phases, needs attention, totals), `console-detail.test.ts` (phase files, run files, documents, cheaper judges) and `console-server.test.ts` (serving). The checks that grepped the old page's source for strings are gone with it; the page's behaviour is covered by `ui-logic.test.ts` and the manual check in Task 27.

- [ ] **Step 8: Run the tests**

Run: `bun test tests/unit/console-server.test.ts tests/unit/chat-transports.test.ts tests/unit/cli.test.ts && bun run typecheck`
Expected: PASS; typecheck prints nothing.

- [ ] **Step 9: Commit**

```bash
git add -A src/console/server.ts src/commands/ui.ts src/cli.ts src/ui tests/unit/console-server.test.ts tests/unit/chat-transports.test.ts tests/unit/ui.test.ts
git commit -m "feat(console): loopstra ui serves the console; the old dashboard page and /api/state are gone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The look, and the frame around every screen

From here on the work is the page's look and its views. They have no unit tests of their own: their logic is in Task 12's tested modules, `bun run typecheck` checks them, Task 24's test bundles them, and Task 26 checks them by hand in a browser. Each task ends with the typecheck and the bundle building.

**Files:**
- Replace: `src/ui/theme.css`, `src/ui/app.tsx`
- Create: `src/ui/nav.ts`, `src/ui/theme.ts`, `src/ui/shortcuts.ts` (stub), `src/ui/alerts.ts` (stub)
- Create: `src/ui/parts/Link.tsx`, `src/ui/parts/Icon.tsx`, `src/ui/parts/TopBar.tsx`, `src/ui/parts/Rail.tsx`, `src/ui/parts/Toasts.tsx`
- Create (stubs, replaced by later tasks): `src/ui/parts/Palette.tsx`, `src/ui/parts/Help.tsx`, `src/ui/parts/Drawer.tsx`, `src/ui/views/Live.tsx`, `Session.tsx`, `Inbox.tsx`, `Changes.tsx`, `Change.tsx`, `Activity.tsx`, `Spend.tsx`

- [ ] **Step 1: Write the stylesheet**

Replace `src/ui/theme.css` with:

```css
/* The console's look. Colours are tokens on :root; dark is designed first, light follows the system or the toggle. */
:root {
  color-scheme: dark;
  --bg: #0d0e11; --bg-raised: #14161b; --bg-sunk: #0a0b0d; --bg-hover: #1b1e25;
  --line: #252932; --line-strong: #343945;
  --fg: #e8eaee; --fg-2: #a9afbb; --fg-3: #737a88;
  --accent: #8b9bff; --accent-bg: rgba(139, 155, 255, 0.14);
  --ok: #4fd18b; --ok-bg: rgba(79, 209, 139, 0.12);
  --warn: #f2b84b; --warn-bg: rgba(242, 184, 75, 0.13);
  --bad: #ff6b72; --bad-bg: rgba(255, 107, 114, 0.13);
  --shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  --radius: 10px; --radius-sm: 6px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
  font: 14px/1.5 var(--font);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg: #f7f8fa; --bg-raised: #ffffff; --bg-sunk: #eef0f4; --bg-hover: #f0f2f6;
    --line: #e2e5eb; --line-strong: #cfd4dc;
    --fg: #16181d; --fg-2: #4a505c; --fg-3: #7a8190;
    --accent: #4b5bdc; --accent-bg: rgba(75, 91, 220, 0.1);
    --ok: #17864b; --ok-bg: rgba(23, 134, 75, 0.1);
    --warn: #9a6200; --warn-bg: rgba(154, 98, 0, 0.1);
    --bad: #c4262e; --bad-bg: rgba(196, 38, 46, 0.09);
    --shadow: 0 12px 40px rgba(20, 24, 33, 0.15);
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f7f8fa; --bg-raised: #ffffff; --bg-sunk: #eef0f4; --bg-hover: #f0f2f6;
  --line: #e2e5eb; --line-strong: #cfd4dc;
  --fg: #16181d; --fg-2: #4a505c; --fg-3: #7a8190;
  --accent: #4b5bdc; --accent-bg: rgba(75, 91, 220, 0.1);
  --ok: #17864b; --ok-bg: rgba(23, 134, 75, 0.1);
  --warn: #9a6200; --warn-bg: rgba(154, 98, 0, 0.1);
  --bad: #c4262e; --bad-bg: rgba(196, 38, 46, 0.09);
  --shadow: 0 12px 40px rgba(20, 24, 33, 0.15);
}

* { box-sizing: border-box; }
html, body, #app { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
a:hover { color: var(--accent); }
button { font: inherit; color: inherit; }
code, pre, kbd, .mono { font-family: var(--mono); font-size: 12.5px; }
h1 { font-size: 20px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 12px; font-weight: 600; color: var(--fg-2); text-transform: uppercase; letter-spacing: 0.06em; margin: 28px 0 10px; }
.muted { color: var(--fg-3); }
.grow { flex: 1; }
.icon { width: 18px; height: 18px; flex: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }

/* The frame */
.shell { display: grid; grid-template-columns: 200px minmax(0, 1fr); grid-template-rows: 52px minmax(0, 1fr); height: 100vh; }
.topbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--bg-raised); }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 650; margin-right: 6px; }
.brand .logo { width: 20px; height: 20px; color: var(--accent); }
.rail { display: flex; flex-direction: column; gap: 2px; padding: 12px 8px; border-right: 1px solid var(--line); background: var(--bg-raised); }
.rail-item { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: var(--radius-sm); color: var(--fg-2); }
.rail-item:hover { background: var(--bg-hover); color: var(--fg); }
.rail-item.on { background: var(--accent-bg); color: var(--fg); }
.rail-item .count, .rail-item .chip { margin-left: auto; }
.main { overflow: auto; padding: 24px 28px 80px; }
.view { max-width: 1180px; margin: 0 auto; }
.view-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
@media (max-width: 860px) {
  .shell { grid-template-columns: 52px minmax(0, 1fr); }
  .rail .label, .rail .count, .rail .chip, .hide-narrow { display: none; }
  .main { padding: 16px; }
}

/* Controls */
.btn, .ghost { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: var(--radius-sm); border: 1px solid var(--line-strong); background: var(--bg-raised); cursor: pointer; white-space: nowrap; }
.btn:hover { border-color: var(--accent); color: var(--fg); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.on { border-color: var(--accent); }
.ghost { border-color: transparent; background: transparent; color: var(--fg-2); }
.ghost:hover { background: var(--bg-hover); color: var(--fg); }
.link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; }
kbd { padding: 1px 5px; border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px; color: var(--fg-3); font-size: 11px; }
input[type="search"], input[type="text"], textarea, select { font: inherit; color: var(--fg); background: var(--bg-sunk); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 6px 10px; }
.count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--bad); color: #fff; font-size: 11px; font-weight: 700; text-align: center; line-height: 18px; }

/* The loop pill, and anything live */
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 3px 11px; border-radius: 999px; background: var(--bg-hover); color: var(--fg-2); font-weight: 600; font-size: 13px; white-space: nowrap; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); }
.pill.running { background: var(--ok-bg); color: var(--ok); }
.pill.running .dot { background: var(--ok); animation: pulse 1.6s ease-in-out infinite; }
.pill.paused { background: var(--warn-bg); color: var(--warn); }
.pill.paused .dot { background: var(--warn); }
.pill.not-responding { background: var(--bad-bg); color: var(--bad); }
.pill.not-responding .dot { background: var(--bad); }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.8); } }
.pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 1.6s ease-in-out infinite; flex: none; }
.reconnecting { position: fixed; top: 52px; left: 0; right: 0; padding: 6px; text-align: center; background: var(--warn-bg); color: var(--warn); z-index: 10; font-size: 13px; }

/* Chips, badges, statuses */
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; background: var(--bg-hover); color: var(--fg-2); font-size: 12px; white-space: nowrap; }
.badge { display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 12px; background: var(--bg-hover); color: var(--fg-2); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.bad { background: var(--bad-bg); color: var(--bad); }
.prio { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-3); }
.prio.urgent { color: var(--bad); }
.prio.high { color: var(--warn); }
.status { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--bg-hover); white-space: nowrap; }
.status.success, .status.pass, .status.done, .status.merged { background: var(--ok-bg); color: var(--ok); }
.status.fail, .status.blocked { background: var(--bad-bg); color: var(--bad); }
.status.running, .status.waiting, .status.interrupted { background: var(--warn-bg); color: var(--warn); }

/* Live */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-raised); }
.card.live { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-now { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.card-foot { display: flex; align-items: center; gap: 12px; color: var(--fg-3); font-variant-numeric: tabular-nums; font-size: 13px; }
.strip { display: flex; align-items: flex-end; gap: 2px; height: 18px; }
.strip i { flex: 1; max-width: 6px; border-radius: 2px; background: var(--line-strong); height: 40%; }
.strip i.tool { background: var(--accent); height: 100%; }
.strip i.text { background: var(--fg-3); height: 60%; }
.strip i.result { background: var(--ok); height: 100%; }
.empty { padding: 28px; border: 1px dashed var(--line-strong); border-radius: var(--radius); color: var(--fg-3); text-align: center; }
.rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-raised); }
.rows li { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.rows li:first-child { border-top: 0; }
.rows .when { margin-left: auto; color: var(--fg-3); font-variant-numeric: tabular-nums; font-size: 13px; }

/* Inbox */
.inbox { display: grid; gap: 10px; }
.inbox-item { display: grid; gap: 6px; padding: 12px 16px; border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: var(--radius); background: var(--bg-raised); }
.inbox-item.bad { border-left-color: var(--bad); }
.inbox-item.selected { border-color: var(--accent); }
.inbox-item .kind { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-3); }
.inbox-item .actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.calm { padding: 20px; border-radius: var(--radius); background: var(--ok-bg); color: var(--ok); }

/* Changes */
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
.column { display: flex; flex-direction: column; gap: 8px; min-height: 120px; padding: 10px; border-radius: var(--radius); background: var(--bg-sunk); }
.col-head { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--fg-2); text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 4px 6px; }
.column.blocked .col-head { color: var(--bad); }
.ccard { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-raised); }
.ccard:hover { border-color: var(--line-strong); color: inherit; }
.ccard.running { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.ccard-title { display: flex; align-items: center; gap: 7px; font-weight: 550; }
.ccard-meta { display: flex; justify-content: space-between; gap: 10px; color: var(--fg-3); font-size: 12px; font-variant-numeric: tabular-nums; }
table.list { width: 100%; border-collapse: collapse; background: var(--bg-raised); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
table.list th, table.list td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.list th { font-size: 12px; font-weight: 600; color: var(--fg-3); }
table.list tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
details.folded { margin-top: 16px; }
details.folded summary { cursor: pointer; color: var(--fg-2); margin-bottom: 10px; }

/* A change's page */
.stepper { display: flex; gap: 4px; margin: 0 0 18px; flex-wrap: wrap; }
.step { flex: 1; min-width: 70px; padding: 6px 8px 4px; border-top: 3px solid var(--line-strong); color: var(--fg-3); font-size: 12px; }
.step.done { border-top-color: var(--ok); color: var(--fg-2); }
.step.now { border-top-color: var(--accent); color: var(--fg); font-weight: 600; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 18px; overflow-x: auto; }
.tab { padding: 8px 12px; color: var(--fg-2); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tab.on { color: var(--fg); border-bottom-color: var(--accent); }
.facts { display: flex; gap: 18px; flex-wrap: wrap; color: var(--fg-2); }
.facts b { color: var(--fg); font-weight: 600; }
.panel { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-raised); }
.panel > h2:first-child { margin-top: 0; }
.stack { display: grid; gap: 16px; }
.doc-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.timeline { display: grid; gap: 4px; }
.tl-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 130px; gap: 12px; align-items: center; padding: 4px 6px; border-radius: var(--radius-sm); }
a.tl-row:hover { background: var(--bg-hover); color: inherit; }
.tl-name { font-family: var(--mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-track { position: relative; height: 12px; border-radius: 3px; background: var(--bg-sunk); }
.tl-bar { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: var(--fg-3); min-width: 3px; }
.tl-bar.success { background: var(--ok); }
.tl-bar.fail { background: var(--bad); }
.tl-bar.running { background: var(--accent); animation: pulse 1.6s infinite; }
.tl-bar.interrupted { background: var(--warn); }
.tl-meta { color: var(--fg-3); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }

/* Markdown */
.md { overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h1 { font-size: 18px; margin: 18px 0 8px; }
.md h2 { font-size: 15px; text-transform: none; letter-spacing: 0; color: var(--fg); margin: 18px 0 8px; }
.md h3 { font-size: 14px; margin: 14px 0 6px; }
.md a { color: var(--accent); text-decoration: underline; }
.md code { padding: 1px 5px; border-radius: 4px; background: var(--bg-sunk); }
.md pre { padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-sunk); overflow-x: auto; }
.md pre code { padding: 0; background: none; }
.md table { border-collapse: collapse; }
.md th, .md td { border: 1px solid var(--line); padding: 4px 8px; }
.md blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line-strong); color: var(--fg-2); }

/* Diffs */
.diff { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-sunk); overflow-x: auto; }
.diff div { padding: 0 12px; white-space: pre; min-width: max-content; }
.diff .d-file { padding: 6px 12px; background: var(--bg-hover); font-weight: 600; }
.d-hunk { color: var(--accent); background: var(--accent-bg); }
.d-add { background: var(--ok-bg); }
.d-add::before { content: "+ "; color: var(--ok); }
.d-del { background: var(--bad-bg); }
.d-del::before { content: "- "; color: var(--bad); }
.d-ctx::before { content: "  "; }
.d-meta { color: var(--fg-3); }

/* Sessions */
.session { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 18px; align-items: start; }
@media (max-width: 1080px) { .session { grid-template-columns: minmax(0, 1fr); } }
.transcript-wrap { position: relative; }
.transcript { display: grid; gap: 8px; max-height: calc(100vh - 190px); overflow: auto; padding: 2px 4px 24px 0; }
/* The browser skips laying out and painting rows that are off screen, so a session of thousands of rows stays smooth. */
.transcript > * { content-visibility: auto; contain-intrinsic-size: auto 40px; }
.t-tool, .t-edit { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-raised); }
.t-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 12px; border: 0; background: none; cursor: pointer; text-align: left; min-width: 0; }
.t-state { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); flex: none; }
.ok > .t-head .t-state { background: var(--ok); }
.bad > .t-head .t-state { background: var(--bad); }
.pending > .t-head .t-state { background: var(--accent); animation: pulse 1.6s infinite; }
.t-name { font-weight: 600; font-size: 13px; }
.t-target { font-family: var(--mono); font-size: 12.5px; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-body { padding: 0 12px 12px; display: grid; gap: 8px; }
.t-body pre { margin: 0; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-sunk); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; }
.t-result { display: grid; gap: 6px; padding: 12px 14px; border-radius: var(--radius); }
.t-result.ok { background: var(--ok-bg); }
.t-result.bad { background: var(--bad-bg); }
.t-live { display: flex; align-items: center; gap: 8px; color: var(--fg-3); padding: 6px 2px; }
.jump { position: absolute; right: 16px; bottom: 16px; box-shadow: var(--shadow); }
.side { display: grid; gap: 14px; position: sticky; top: 0; }
.side dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 13px; }
.side dt { color: var(--fg-3); }
.side dd { margin: 0; overflow-wrap: anywhere; }
.todos { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
.todos li::before { content: "○ "; color: var(--fg-3); }
.todos li.completed { color: var(--fg-3); text-decoration: line-through; }
.todos li.completed::before { content: "● "; color: var(--ok); }
.todos li.in_progress::before { content: "◐ "; color: var(--accent); }

/* Activity and spend */
.feed { list-style: none; margin: 0; padding: 0; }
.feed li { display: grid; grid-template-columns: 90px 150px minmax(0, 1fr); gap: 12px; padding: 7px 4px; border-bottom: 1px solid var(--line); }
.feed .t { color: var(--fg-3); font-variant-numeric: tabular-nums; font-size: 13px; }
.feed .tech { font-family: var(--mono); font-size: 12px; color: var(--fg-2); overflow-wrap: anywhere; }
@media (max-width: 700px) { .feed li { grid-template-columns: 1fr; gap: 2px; } }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.tile { padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-raised); }
.tile .v { display: block; font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
.bars { display: grid; gap: 6px; }
.bar-row { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr) 80px; gap: 12px; align-items: center; }
.bar-track { height: 10px; border-radius: 3px; background: var(--bg-sunk); }
.bar-fill { height: 100%; border-radius: 3px; background: var(--accent); }
.hours { display: flex; align-items: flex-end; gap: 2px; height: 120px; padding: 8px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-raised); }
.hours i { flex: 1; min-height: 1px; border-radius: 2px 2px 0 0; background: var(--accent); opacity: 0.85; }

/* The drawer, the palette, help, toasts */
.drawer { position: fixed; top: 52px; right: 0; bottom: 0; width: min(440px, 100vw); display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg-raised); box-shadow: var(--shadow); z-index: 20; }
.drawer header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.drawer .about { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer .pad { padding: 16px; }
.chat-log { flex: 1; overflow: auto; padding: 14px; display: grid; gap: 10px; align-content: start; }
.msg { max-width: 88%; padding: 8px 12px; border-radius: 12px; overflow-wrap: anywhere; }
.msg.person { justify-self: end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
.msg.loopstra { justify-self: start; background: var(--bg-hover); border-bottom-left-radius: 4px; }
.msg.announce { justify-self: stretch; max-width: none; background: var(--warn-bg); color: var(--warn); font-size: 13px; border-radius: var(--radius-sm); }
.chat-form { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--line); }
.chat-form textarea { flex: 1; min-width: 0; resize: none; }
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; z-index: 30; }
.palette { width: min(600px, calc(100vw - 32px)); border: 1px solid var(--line-strong); border-radius: 12px; background: var(--bg-raised); box-shadow: var(--shadow); overflow: hidden; }
.palette input { width: 100%; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 14px 16px; font-size: 15px; background: transparent; outline: none; }
.palette ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow: auto; }
.palette li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; }
.palette li.on { background: var(--accent-bg); }
.help { width: min(460px, calc(100vw - 32px)); padding: 18px 20px; border-radius: 12px; background: var(--bg-raised); border: 1px solid var(--line-strong); box-shadow: var(--shadow); }
.help dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 12px 0 0; }
.help dd { margin: 0; }
.toasts { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: grid; gap: 8px; z-index: 40; }
.toast { padding: 10px 16px; border-radius: var(--radius); background: var(--fg); color: var(--bg); box-shadow: var(--shadow); }
.toast.bad { background: var(--bad); color: #fff; }
```

- [ ] **Step 2: Write the routing, theme and stub helpers**

`src/ui/nav.ts`:

```ts
import { signal } from "@preact/signals";
import { parseRoute, type Route } from "./router";

/** The screen the page shows. */
export const route = signal<Route>(parseRoute(location.pathname));

/** Goes to `path` without reloading the page. */
export function navigate(path: string): void {
  if (path !== location.pathname) history.pushState(null, "", path);
  route.value = parseRoute(location.pathname);
  document.getElementById("main")?.scrollTo(0, 0);
}

/** Follows the browser's back and forward buttons. */
export function listenToHistory(): void {
  addEventListener("popstate", () => { route.value = parseRoute(location.pathname); });
}
```

`src/ui/theme.ts`:

```ts
import { signal } from "@preact/signals";

export type Theme = "system" | "light" | "dark";
const KEY = "loopstra-theme";

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export const theme = signal<Theme>(read());

export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/** The system's theme, then dark, then light. */
export function cycleTheme(): void {
  const next: Theme = theme.value === "system" ? "dark" : theme.value === "dark" ? "light" : "system";
  theme.value = next;
  applyTheme(next);
  try { localStorage.setItem(KEY, next); } catch { /* kept for this visit only */ }
}
```

`src/ui/shortcuts.ts` (stub; Task 15 replaces it):

```ts
export const screenKeys = new Map<string, () => void>();
export function installKeys(): void {}
```

`src/ui/alerts.ts` (stub; Task 15 replaces it):

```ts
export function startAlerts(): void {}
```

- [ ] **Step 3: Write the frame's parts**

`src/ui/parts/Link.tsx`:

```tsx
import type { ComponentChildren } from "preact";
import { navigate } from "../nav";

/** A link inside the console: a plain click changes screen without reloading; a modified click opens a tab as usual. */
export function Link(props: { href: string; class?: string; title?: string; children?: ComponentChildren }) {
  return (
    <a
      href={props.href}
      class={props.class}
      title={props.title}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
```

`src/ui/parts/Icon.tsx`:

```tsx
const PATHS: Record<string, string> = {
  logo: "M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5",
  live: "M3 12h4l3-8 4 16 3-8h4",
  inbox: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  changes: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z",
  activity: "M5 6h14M5 12h14M5 18h9",
  spend: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3",
  ask: "M4 5h16v11H9l-5 4z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20h4",
  theme: "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z",
  close: "M6 6l12 12M18 6L6 18",
};

/** A line icon in the text's colour. */
export function Icon({ name, class: cls = "icon" }: { name: string; class?: string }) {
  return (
    <svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
```

`src/ui/parts/TopBar.tsx`:

```tsx
import { pillText, usd } from "../format";
import { inbox, loop, openDrawer, paletteOpen, totals } from "../store";
import { cycleTheme, theme } from "../theme";
import { Icon } from "./Icon";
import { Link } from "./Link";

export function TopBar() {
  const l = loop.value;
  const t = totals.value;
  const n = inbox.value?.length ?? 0;
  return (
    <header class="topbar">
      <Link href="/" class="brand"><Icon name="logo" class="logo" /><span class="hide-narrow">Loopstra</span></Link>
      <span class={`pill ${l?.state ?? ""}`} title={l?.text ?? "Connecting to the console…"}>
        <span class="dot" aria-hidden="true" />
        {l ? pillText(l) : "Connecting…"}
      </span>
      <span class="grow" />
      {t && <span class="muted hide-narrow" title="Spent today, chat included">{usd(t.todayUsd)} today</span>}
      <button class="ghost" onClick={() => { paletteOpen.value = true; }} title="Search and commands (Ctrl K)">
        <Icon name="search" /><span class="hide-narrow">Search</span><kbd class="hide-narrow">Ctrl K</kbd>
      </button>
      <button class="ghost" onClick={() => openDrawer()} title="Ask the orchestrator (Ctrl J)"><Icon name="ask" /><span class="hide-narrow">Ask</span></button>
      <Link href="/inbox" class="ghost" title={n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}>
        <Icon name="bell" />{n > 0 && <span class="count">{n}</span>}
      </Link>
      <button class="ghost" onClick={cycleTheme} title={`Theme: ${theme.value}. Click to change.`} aria-label="Change the theme"><Icon name="theme" /></button>
    </header>
  );
}
```

`src/ui/parts/Rail.tsx`:

```tsx
import { route } from "../nav";
import { inbox, running } from "../store";
import { Icon } from "./Icon";
import { Link } from "./Link";

const SCREENS = [
  { href: "/", label: "Live", icon: "live", on: ["live", "session"] },
  { href: "/inbox", label: "Inbox", icon: "inbox", on: ["inbox"] },
  { href: "/changes", label: "Changes", icon: "changes", on: ["changes", "change"] },
  { href: "/activity", label: "Activity", icon: "activity", on: ["activity"] },
  { href: "/spend", label: "Spend", icon: "spend", on: ["spend"] },
];

export function Rail() {
  const at = route.value.name;
  const agents = running.value?.now.length ?? 0;
  const waiting = inbox.value?.length ?? 0;
  return (
    <nav class="rail" aria-label="Screens">
      {SCREENS.map((s) => (
        <Link key={s.href} href={s.href} class={`rail-item${s.on.includes(at) ? " on" : ""}`} title={s.label}>
          <Icon name={s.icon} />
          <span class="label">{s.label}</span>
          {s.href === "/" && agents > 0 && <span class="chip">{agents}</span>}
          {s.href === "/inbox" && waiting > 0 && <span class="count">{waiting}</span>}
        </Link>
      ))}
    </nav>
  );
}
```

`src/ui/parts/Toasts.tsx`:

```tsx
import { toasts } from "../store";

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}
```

- [ ] **Step 4: Write the stubs later tasks replace**

`src/ui/parts/Palette.tsx`, `src/ui/parts/Help.tsx` and `src/ui/parts/Drawer.tsx`, each:

```tsx
export function Palette() { return null; }
```

(with `Help` and `Drawer` as the function names in their own files).

`src/ui/views/Live.tsx`, `Inbox.tsx`, `Changes.tsx`, `Activity.tsx`, `Spend.tsx`, each like this one, with its own name and title:

```tsx
export function Live() {
  return <section class="view"><div class="view-head"><h1>Live</h1></div></section>;
}
```

`src/ui/views/Change.tsx`:

```tsx
import type { Tab } from "../router";

export function Change({ slug }: { slug: string; tab: Tab }) {
  return <section class="view"><div class="view-head"><h1>{slug}</h1></div></section>;
}
```

`src/ui/views/Session.tsx`:

```tsx
export function Session({ slug, seq }: { slug: string; seq: number }) {
  return <section class="view"><div class="view-head"><h1>{slug} · step {seq}</h1></div></section>;
}
```

- [ ] **Step 5: Write the app**

Replace `src/ui/app.tsx` with:

```tsx
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { startAlerts } from "./alerts";
import { listenToHistory, route } from "./nav";
import { Drawer } from "./parts/Drawer";
import { Help } from "./parts/Help";
import { Link } from "./parts/Link";
import { Palette } from "./parts/Palette";
import { Rail } from "./parts/Rail";
import { Toasts } from "./parts/Toasts";
import { TopBar } from "./parts/TopBar";
import { installKeys } from "./shortcuts";
import { connect, connection } from "./store";
import { applyTheme, theme } from "./theme";
import { Activity } from "./views/Activity";
import { Change } from "./views/Change";
import { Changes } from "./views/Changes";
import { Inbox } from "./views/Inbox";
import { Live } from "./views/Live";
import { Session } from "./views/Session";
import { Spend } from "./views/Spend";

function Screen() {
  const r = route.value;
  switch (r.name) {
    case "live": return <Live />;
    case "inbox": return <Inbox />;
    case "changes": return <Changes />;
    case "change": return <Change slug={r.slug} tab={r.tab} />;
    case "session": return <Session slug={r.slug} seq={r.seq} />;
    case "activity": return <Activity />;
    case "spend": return <Spend />;
    case "missing":
      return (
        <section class="view">
          <h1>Nothing here</h1>
          <p class="muted">There is no screen at {r.path}. <Link href="/">Go to Live</Link>.</p>
        </section>
      );
  }
}

function App() {
  useEffect(() => {
    connect();
    listenToHistory();
    installKeys();
    startAlerts();
  }, []);
  return (
    <div class="shell">
      <TopBar />
      <Rail />
      <main class="main" id="main"><Screen /></main>
      {connection.value === "stale" && <div class="reconnecting" role="status">Reconnecting… what you see may be out of date.</div>}
      <Drawer />
      <Palette />
      <Help />
      <Toasts />
    </div>
  );
}

applyTheme(theme.value);
render(<App />, document.getElementById("app")!);
```

- [ ] **Step 6: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: typecheck prints nothing; `bun build` lists an `index.html`, one `.js` and one `.css` file with no errors. (`node_modules/` is ignored by git, so the output never lands in a commit.)

- [ ] **Step 7: Commit**

```bash
git add src/ui
git commit -m "feat(console): the look and the frame: top bar, rail, routes, theme, toasts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Keys, the command palette, help and alerts

**Files:**
- Replace: `src/ui/shortcuts.ts`, `src/ui/alerts.ts`, `src/ui/parts/Palette.tsx`, `src/ui/parts/Help.tsx`

- [ ] **Step 1: Write `src/ui/shortcuts.ts`**

```ts
import { keyMatcher, keyName, typingIn, type Binding } from "./keys";
import { navigate } from "./nav";
import { drawer, helpOpen, paletteOpen } from "./store";

export const SHORTCUTS: Array<Binding & { label: string }> = [
  { keys: "mod+k", action: "palette", label: "Search and commands" },
  { keys: "mod+j", action: "drawer", label: "Ask the orchestrator" },
  { keys: "g l", action: "go:/", label: "Go to Live" },
  { keys: "g i", action: "go:/inbox", label: "Go to Inbox" },
  { keys: "g c", action: "go:/changes", label: "Go to Changes" },
  { keys: "g a", action: "go:/activity", label: "Go to Activity" },
  { keys: "g s", action: "go:/spend", label: "Go to Spend" },
  { keys: "?", action: "help", label: "Show these keys" },
  { keys: "escape", action: "escape", label: "Close what is open" },
];

/** Keys one screen handles while it is shown (the inbox's j, k and o): it adds them when it opens and removes them when it closes. */
export const screenKeys = new Map<string, () => void>();

export function installKeys(): void {
  const press = keyMatcher(SHORTCUTS);
  addEventListener("keydown", (e) => {
    const name = keyName(e);
    if (!name) return;
    const typing = typingIn(e.target);
    // In a text box, letters are typing: only Ctrl or Cmd shortcuts and Escape count there.
    if (typing && !name.startsWith("mod+") && name !== "escape") return;
    const action = press(name, Date.now());
    if (!action) {
      const handler = screenKeys.get(name);
      if (handler && !typing && !paletteOpen.value) {
        e.preventDefault();
        handler();
      }
      return;
    }
    e.preventDefault();
    if (action === "palette") paletteOpen.value = !paletteOpen.value;
    else if (action === "drawer") drawer.value = { ...drawer.value, open: !drawer.value.open };
    else if (action === "help") helpOpen.value = !helpOpen.value;
    else if (action === "escape") {
      paletteOpen.value = false;
      helpOpen.value = false;
      drawer.value = { ...drawer.value, open: false };
    } else if (action.startsWith("go:")) navigate(action.slice(3));
  });
}
```

- [ ] **Step 2: Write `src/ui/alerts.ts`**

```ts
import { effect } from "@preact/signals";
import type { AttentionItem } from "../attention";
import { inbox, loop } from "./store";

const KEY = "loopstra-notify";

export function notificationsOn(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

/** Turns browser notifications on (asking the browser's permission first) or off; gives what they ended up as. */
export async function setNotifications(on: boolean): Promise<boolean> {
  if (on) {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return false;
  }
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* kept for this visit only */ }
  return on;
}

/** An item's identity across updates: its wording ("checked 3 min ago") may change, it does not. */
const itemKey = (it: AttentionItem) => `${it.kind}|${it.slug ?? ""}|${it.title}`;

const COLOR: Record<string, string> = { running: "#4fd18b", paused: "#f2b84b", stopped: "#737a88", "not-responding": "#ff6b72" };

/** The tab's icon: a ring in the loop's colour, with a red dot while something needs a person. */
function setFavicon(state: string, dot: boolean): void {
  const ring = COLOR[state] ?? COLOR.stopped!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="none" stroke="${ring}" stroke-width="5"/>${dot ? '<circle cx="25" cy="7" r="6" fill="#ff6b72"/>' : ""}</svg>`;
  const link = document.getElementById("favicon") as HTMLLinkElement | null;
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Keeps the tab's title ("(3) Loopstra") and icon up to date with the inbox, and, when notifications
 * are on and the tab is in the background, shows one for each item that was not there before.
 */
export function startAlerts(): void {
  let seen: Set<string> | null = null;
  effect(() => {
    const items = inbox.value;
    const state = loop.value?.state ?? "stopped";
    if (!items) return;
    document.title = items.length ? `(${items.length}) Loopstra` : "Loopstra";
    setFavicon(state, items.length > 0);
    if (seen && notificationsOn() && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      for (const it of items) if (!seen.has(itemKey(it))) new Notification(`${it.label}: ${it.title}`, { body: it.what, tag: itemKey(it) });
    }
    seen = new Set(items.map(itemKey));
  });
}
```

- [ ] **Step 3: Write `src/ui/parts/Palette.tsx`**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { notificationsOn, setNotifications } from "../alerts";
import { navigate } from "../nav";
import { filterCommands, type Command } from "../palette";
import { changes, openDrawer, paletteOpen, running, toast } from "../store";
import { cycleTheme } from "../theme";

/** Everything the palette can do: go to a screen, watch an agent, open a change, and a few settings. */
function commands(): Command[] {
  const list: Command[] = [
    { id: "live", title: "Go to Live", hint: "g l", run: () => navigate("/") },
    { id: "inbox", title: "Go to Inbox", hint: "g i", run: () => navigate("/inbox") },
    { id: "changes", title: "Go to Changes", hint: "g c", run: () => navigate("/changes") },
    { id: "activity", title: "Go to Activity", hint: "g a", run: () => navigate("/activity") },
    { id: "spend", title: "Go to Spend", hint: "g s", run: () => navigate("/spend") },
    { id: "ask", title: "Ask the orchestrator", hint: "Ctrl J", run: () => openDrawer() },
    { id: "theme", title: "Change the theme", run: cycleTheme },
    {
      id: "notify",
      title: notificationsOn() ? "Turn off notifications" : "Turn on notifications",
      run: () => void setNotifications(!notificationsOn()).then((on) =>
        toast(on ? "You will be told when something needs you while this tab is in the background." : "Notifications are off.")),
    },
  ];
  for (const p of running.value?.now ?? []) list.push({ id: `s:${p.slug}:${p.seq}`, title: `Watch ${p.title}: ${p.name}`, hint: "running", run: () => navigate(`/s/${p.slug}/${p.seq}`) });
  for (const c of changes.value ?? []) list.push({ id: `c:${c.slug}`, title: `Open ${c.title}`, hint: c.plain, run: () => navigate(`/c/${c.slug}`) });
  return list;
}

export function Palette() {
  return paletteOpen.value ? <PaletteBox /> : null;
}

function PaletteBox() {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const items = filterCommands(commands(), query);
  const close = () => { paletteOpen.value = false; };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  return (
    <div class="overlay" onClick={close}>
      <div class="palette" role="dialog" aria-label="Search and commands" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          value={query}
          placeholder="Open a change, watch an agent, or run a command…"
          aria-label="Search"
          onInput={(e) => { setQuery(e.currentTarget.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(Math.min(at + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(at - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(items[at]); }
          }}
        />
        <ul role="listbox">
          {items.map((c, k) => (
            <li key={c.id} role="option" aria-selected={k === at} class={k === at ? "on" : ""} onMouseEnter={() => setAt(k)} onClick={() => run(c)}>
              <span>{c.title}</span>
              {c.hint && <span class="muted">{c.hint}</span>}
            </li>
          ))}
          {!items.length && <li class="muted">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `src/ui/parts/Help.tsx`**

```tsx
import { Fragment } from "preact";
import { SHORTCUTS } from "../shortcuts";
import { helpOpen } from "../store";

const keyLabel = (keys: string) => keys.replace("mod+", "Ctrl ").replace("escape", "Esc").toUpperCase();

export function Help() {
  if (!helpOpen.value) return null;
  const close = () => { helpOpen.value = false; };
  return (
    <div class="overlay" onClick={close}>
      <div class="help" role="dialog" aria-label="Keys" onClick={(e) => e.stopPropagation()}>
        <b>Keys</b>
        <dl>
          {SHORTCUTS.map((s) => (
            <Fragment key={s.keys}>
              <dt><kbd>{keyLabel(s.keys)}</kbd></dt>
              <dd>{s.label}</dd>
            </Fragment>
          ))}
          <dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Move through the inbox</dd>
          <dt><kbd>O</kbd></dt><dd>Open the inbox item you are on</dd>
        </dl>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 6: Commit**

```bash
git add src/ui/shortcuts.ts src/ui/alerts.ts src/ui/parts/Palette.tsx src/ui/parts/Help.tsx
git commit -m "feat(console): keys, the command palette, a keys overlay, and the tab's title, icon and notifications" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Markdown, diffs and transcripts

**Files:**
- Create: `src/ui/parts/Markdown.tsx`, `src/ui/parts/Diff.tsx`, `src/ui/parts/Transcript.tsx`

- [ ] **Step 1: Write `src/ui/parts/Markdown.tsx`**

```tsx
import { useMemo } from "preact/hooks";
import { renderMarkdown } from "../markdown";

/** Markdown drawn safely: renderMarkdown never passes raw HTML through, so its output can be set as HTML. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
```

- [ ] **Step 2: Write `src/ui/parts/Diff.tsx`**

```tsx
import { useMemo } from "preact/hooks";
import { parseDiff } from "../diff";

export function Diff({ text }: { text: string }) {
  const rows = useMemo(() => parseDiff(text), [text]);
  if (!rows.length) return <p class="muted">No changes.</p>;
  return <div class="diff">{rows.map((r, k) => <div key={k} class={`d-${r.kind}`}>{r.text || " "}</div>)}</div>;
}
```

- [ ] **Step 3: Write `src/ui/parts/Transcript.tsx`**

```tsx
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TranscriptItem } from "../../console/types";
import { usd } from "../format";
import type { Shown } from "../transcript";
import { Diff } from "./Diff";
import { Markdown } from "./Markdown";

/** How many of the newest rows are drawn before "Show earlier". */
const SHOWN = 1500;
/** Output lines shown before "Show all". */
const OUTPUT_LINES = 200;

type Result = Shown["results"][string] | undefined;

/** A session's transcript. It follows the newest row until the person scrolls up, then offers to jump back. */
export function Transcript({ shown, live }: { shown: Shown; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [all, setAll] = useState(false);
  const skipped = all ? 0 : Math.max(0, shown.items.length - SHOWN);
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);
  const onScroll = () => {
    const b = box.current;
    if (b) setFollow(b.scrollHeight - b.scrollTop - b.clientHeight < 80);
  };
  return (
    <div class="transcript-wrap">
      <div class="transcript" ref={box} onScroll={onScroll}>
        {skipped > 0 && <button class="link" onClick={() => setAll(true)}>Show {skipped} earlier rows</button>}
        {shown.items.slice(skipped).map((item, k) => <Row key={skipped + k} item={item} result={"id" in item ? shown.results[item.id] : undefined} />)}
        {!shown.items.length && !live && <p class="muted">This step left no transcript.</p>}
        {live && <div class="t-live"><span class="pulse" aria-hidden="true" /> Working…</div>}
      </div>
      {!follow && <button class="btn jump" onClick={() => setFollow(true)}>Jump to live ↓</button>}
    </div>
  );
}

function Row({ item, result }: { item: Shown["items"][number]; result: Result }) {
  switch (item.kind) {
    case "text": return <Markdown text={item.text} />;
    case "tool": return <ToolRow item={item} result={result} />;
    case "edit": return <EditRow item={item} result={result} />;
    case "result":
      return (
        <div class={`t-result ${item.ok ? "ok" : "bad"}`}>
          <span><b>{item.ok ? "Finished" : "Ended with a problem"}</b>{item.costUsd !== null && <span class="muted"> · {usd(item.costUsd)}</span>}</span>
          {item.summary && <Markdown text={item.summary} />}
        </div>
      );
  }
}

const stateOf = (result: Result): string => (!result ? "pending" : result.ok ? "ok" : "bad");

function ToolRow({ item, result }: { item: Extract<TranscriptItem, { kind: "tool" }>; result: Result }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`t-tool ${stateOf(result)}`}>
      <button class="t-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="t-state" aria-hidden="true" />
        <span class="t-name">{item.tool}</span>
        <span class="t-target">{item.target}</span>
      </button>
      {open && (
        <div class="t-body">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {result ? <Output text={result.output} /> : <span class="muted">Still running…</span>}
        </div>
      )}
    </div>
  );
}

function EditRow({ item, result }: { item: Extract<TranscriptItem, { kind: "edit" }>; result: Result }) {
  // A small edit shows at once; a whole written file waits to be opened.
  const [open, setOpen] = useState(item.tool !== "Write");
  return (
    <div class={`t-edit ${stateOf(result)}`}>
      <button class="t-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="t-state" aria-hidden="true" />
        <span class="t-name">{item.tool === "Write" ? "Wrote" : "Edited"}</span>
        <span class="t-target">{item.path}</span>
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

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  return (
    <>
      <pre>{(all ? lines : lines.slice(0, OUTPUT_LINES)).join("\n")}</pre>
      {!all && lines.length > OUTPUT_LINES && <button class="link" onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
    </>
  );
}
```

- [ ] **Step 4: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 5: Commit**

```bash
git add src/ui/parts/Markdown.tsx src/ui/parts/Diff.tsx src/ui/parts/Transcript.tsx
git commit -m "feat(console): safe markdown, diffs, and a transcript that follows the live end" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Live

**Files:**
- Replace: `src/ui/views/Live.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import type { RunningPhase } from "../../console/types";
import { ago, costSoFar, duration, shortModel, usd } from "../format";
import { Link } from "../parts/Link";
import { changes, loop, meta, now, running } from "../store";

/** Changes waiting their turn: in progress, or approved and ready for their next step. */
const WAITING = new Set(["accepted", "designing", "spec-approved", "planning", "plan-approved", "building", "reviewing", "merge-approved", "merged", "verifying"]);

export function Live() {
  const r = running.value;
  const list = changes.value;
  const l = loop.value;
  const m = meta.value;
  const t = now.value;
  if (!r || !list || !l || !m) return <section class="view"><p class="muted">Connecting…</p></section>;
  const busy = new Set(r.now.map((p) => p.slug));
  const next = list.filter((c) => !busy.has(c.slug) && WAITING.has(c.status)).slice(0, 6);
  const when = (iso: string) => {
    const a = ago(iso, t);
    return a === "now" ? "just now" : `${a} ago`;
  };
  return (
    <section class="view">
      <div class="view-head">
        <h1>Live</h1>
        <span class="muted">{r.now.length ? `${r.now.length} ${r.now.length === 1 ? "agent is" : "agents are"} working` : l.text}</span>
      </div>
      {r.now.length ? (
        <div class="cards">{r.now.map((p) => <AgentCard key={`${p.slug}:${p.seq}`} p={p} t={t} rate={m.usdPerMinute} />)}</div>
      ) : (
        <div class="empty">Nothing is running.{l.nextCheck ? ` The next check is in ${duration(Math.max(0, Date.parse(l.nextCheck) - t))}.` : ""}</div>
      )}
      <h2>Up next</h2>
      {next.length ? (
        <ul class="rows">
          {next.map((c) => (
            <li key={c.slug}>
              <Link href={`/c/${c.slug}`}><b>{c.title}</b></Link>
              <span class="muted">{c.plain}</span>
              {c.waiting && <span class="badge warn">{c.waiting}</span>}
              <span class="when">{c.inStatus ? `for ${c.inStatus}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : <p class="muted">Nothing is waiting its turn.</p>}
      <h2>Just finished</h2>
      {r.recent.length ? (
        <ul class="rows">
          {r.recent.map((p) => (
            <li key={`${p.slug}:${p.seq}`}>
              <span class={`status ${p.status}`}>{p.status === "success" ? "passed" : p.status === "fail" ? "failed" : p.status}</span>
              <Link href={`/s/${p.slug}/${p.seq}`}>{p.slug} · {p.name}</Link>
              <span class="when">{duration(p.durationMs)} · {usd(p.costUsd)} · {when(p.ended)}</span>
            </li>
          ))}
        </ul>
      ) : <p class="muted">No step has finished yet.</p>}
    </section>
  );
}

function AgentCard({ p, t, rate }: { p: RunningPhase; t: number; rate: number }) {
  return (
    <article class="card live">
      <div class="card-head">
        <Link href={`/c/${p.slug}`} class="card-title">{p.title}</Link>
        <span class="grow" />
        <span class="chip">{p.name}{p.model ? ` · ${shortModel(p.model)}` : ""}</span>
      </div>
      <div class="card-now" title={p.now}><span class="pulse" aria-hidden="true" />{p.now}</div>
      <div class="strip" aria-hidden="true">{p.strip.map((k, i) => <i key={i} class={k} />)}</div>
      <div class="card-foot">
        <span title="Running for">{duration(t - Date.parse(p.started))}</span>
        <span title="An estimate: the real cost is recorded when the step ends">{usd(costSoFar(p.started, t, rate), true)}</span>
        <span class="grow" />
        <Link href={`/s/${p.slug}/${p.seq}`} class="btn">Watch</Link>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/views/Live.tsx
git commit -m "feat(console): Live: a card per running agent, what is up next and what just finished" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: A session

**Files:**
- Replace: `src/ui/views/Session.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useEffect, useState } from "preact/hooks";
import type { ChangeDetail, PhaseView, SessionMessage, TranscriptItem } from "../../console/types";
import { clock, costSoFar, duration, shortModel, usd } from "../format";
import { Link } from "../parts/Link";
import { Transcript } from "../parts/Transcript";
import { changes, getJson, meta, now, openDrawer, running } from "../store";
import { addItems, EMPTY, type Shown } from "../transcript";

type Phase = Extract<SessionMessage, { type: "phase" }>;

export function Session({ slug, seq }: { slug: string; seq: number }) {
  const [shown, setShown] = useState<Shown>(EMPTY);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [ended, setEnded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [detail, setDetail] = useState<PhaseView | null>(null);

  useEffect(() => {
    setShown(EMPTY);
    setPhase(null);
    setEnded(false);
    setMissing(false);
    let buffer: TranscriptItem[] = [];
    // Rows arrive in bursts; drawing them ten times a second keeps a long session smooth.
    const flush = setInterval(() => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setShown((s) => addItems(s, batch));
    }, 100);
    const source = new EventSource(`/api/sessions/${encodeURIComponent(slug)}/${seq}/stream`);
    source.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string) as SessionMessage;
      if (m.type === "item") buffer.push(m.item);
      else if (m.type === "phase") setPhase(m);
      else {
        setEnded(true);
        source.close();
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setMissing(true);
    };
    return () => {
      clearInterval(flush);
      source.close();
    };
  }, [slug, seq]);

  // The step's cost, files and refused commands, read again when its status changes. Chat has no change page.
  const status = phase?.status;
  useEffect(() => {
    if (slug.startsWith("_")) return;
    let live = true;
    getJson<ChangeDetail>(`/api/changes/${slug}`).then((d) => { if (live) setDetail(d.phases.find((p) => p.seq === seq) ?? null); }, () => {});
    return () => { live = false; };
  }, [slug, seq, status]);

  if (missing && !phase) {
    return (
      <section class="view">
        <h1>No such step</h1>
        <p class="muted">There is no step {seq} for {slug}. <Link href={`/c/${slug}`}>Open the change</Link>.</p>
      </section>
    );
  }
  const t = now.value;
  const card = running.value?.now.find((p) => p.slug === slug && p.seq === seq);
  const title = changes.value?.find((c) => c.slug === slug)?.title ?? slug;
  const live = phase?.status === "running" && !ended;
  const elapsed = phase ? (phase.ended ? Date.parse(phase.ended) : t) - Date.parse(phase.started) : 0;
  return (
    <section class="view">
      <div class="view-head">
        <h1>
          {slug.startsWith("_") ? title : <Link href={`/c/${slug}`}>{title}</Link>}
          <span class="muted"> › {phase?.name ?? `step ${seq}`}</span>
        </h1>
        {phase && <span class={`status ${phase.status}`}>{phase.status}</span>}
        {live && <span class="pulse" aria-label="live" />}
      </div>
      <div class="session">
        <Transcript shown={shown} live={live} />
        <aside class="side">
          {shown.todos && shown.todos.length > 0 && (
            <div class="panel">
              <h2>Its todo list</h2>
              <ul class="todos">{shown.todos.map((td, k) => <li key={k} class={td.state}>{td.text}</li>)}</ul>
            </div>
          )}
          <div class="panel">
            <dl>
              {card?.model && <><dt>Model</dt><dd>{shortModel(card.model)}</dd></>}
              {phase && <><dt>Started</dt><dd>{clock(phase.started, t)}</dd></>}
              {phase && <><dt>{live ? "Running for" : "Took"}</dt><dd>{duration(elapsed)}</dd></>}
              <dt>Cost</dt>
              <dd>{live && phase ? usd(costSoFar(phase.started, t, meta.value?.usdPerMinute ?? 0.2), true) : usd(detail?.costUsd ?? 0)}</dd>
              {detail?.error && <><dt>Problem</dt><dd>{detail.error}</dd></>}
            </dl>
            {detail && detail.denied.length > 0 && <p class="muted">Not allowed: {detail.denied.join(", ")}</p>}
            {detail && detail.files.length > 0 && <p>{detail.files.map((f) => <a key={f.name} href={f.url} target="_blank" rel="noopener noreferrer" class="chip">{f.name}</a>)}</p>}
          </div>
          {!slug.startsWith("_") && <button class="btn" onClick={() => openDrawer(title)}>Ask the orchestrator about this</button>}
        </aside>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/views/Session.tsx
git commit -m "feat(console): a session's live transcript, with its todo list, cost and files beside it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Inbox

**Files:**
- Replace: `src/ui/views/Inbox.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../attention";
import { navigate } from "../nav";
import { Link } from "../parts/Link";
import { screenKeys } from "../shortcuts";
import { inbox, openDrawer } from "../store";

/** Kinds that mean something is wrong rather than waiting: drawn in red. */
const BAD = new Set(["blocked", "health", "unreadable", "config"]);

export function Inbox() {
  const items = inbox.value;
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const sel = Math.min(at, Math.max(0, (items?.length ?? 1) - 1));
  atRef.current = sel;
  useEffect(() => {
    const last = () => Math.max(0, (inbox.value?.length ?? 1) - 1);
    screenKeys.set("j", () => setAt((k) => Math.min(k + 1, last())));
    screenKeys.set("k", () => setAt((k) => Math.max(k - 1, 0)));
    screenKeys.set("o", () => {
      const it = inbox.value?.[atRef.current];
      if (it?.slug) navigate(`/c/${it.slug}`);
    });
    return () => { for (const k of ["j", "k", "o"]) screenKeys.delete(k); };
  }, []);
  useEffect(() => { document.getElementById(`inbox-${sel}`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  if (!items) return <section class="view"><p class="muted">Connecting…</p></section>;
  return (
    <section class="view">
      <div class="view-head">
        <h1>Inbox</h1>
        {items.length > 0 && <span class="muted">{items.length} {items.length === 1 ? "thing needs" : "things need"} you</span>}
      </div>
      {items.length === 0 ? <div class="calm">Nothing needs you right now.</div> : (
        <div class="inbox">
          {items.map((it, k) => <Item key={`${it.kind}:${it.slug ?? ""}:${it.title}`} it={it} index={k} selected={k === sel} onSelect={() => setAt(k)} />)}
        </div>
      )}
      {items.length > 0 && <p class="muted"><kbd>J</kbd> <kbd>K</kbd> move, <kbd>O</kbd> opens the change.</p>}
    </section>
  );
}

function Item({ it, index, selected, onSelect }: { it: AttentionItem; index: number; selected: boolean; onSelect: () => void }) {
  return (
    <article id={`inbox-${index}`} class={`inbox-item${BAD.has(it.kind) ? " bad" : ""}${selected ? " selected" : ""}`} onClick={onSelect}>
      <span class="kind">{it.label}</span>
      <b>{it.slug ? <Link href={`/c/${it.slug}`}>{it.title}</Link> : it.title}</b>
      <span>{it.what}</span>
      <div class="actions">
        {it.slug && <Link href={`/c/${it.slug}`} class="btn">Open</Link>}
        <button class="btn" onClick={(e) => { e.stopPropagation(); openDrawer(it.title); }}>Ask the orchestrator</button>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/views/Inbox.tsx
git commit -m "feat(console): the inbox, moved through with the keyboard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Changes

**Files:**
- Replace: `src/ui/views/Changes.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useState } from "preact/hooks";
import type { ChangeSummary, Stage } from "../../console/types";
import { usd } from "../format";
import { fuzzyScore } from "../palette";
import { Link } from "../parts/Link";
import { changes } from "../store";

export const COLUMNS: Array<{ stage: Stage; label: string }> = [
  { stage: "draft", label: "Draft" }, { stage: "design", label: "Design" }, { stage: "plan", label: "Plan" }, { stage: "build", label: "Build" },
  { stage: "review", label: "Review" }, { stage: "merge", label: "Merge" }, { stage: "verify", label: "Verify" }, { stage: "done", label: "Done" },
];

const VIEW_KEY = "loopstra-changes-view";
type View = "board" | "list";

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"; } catch { return "board"; }
}

export function Changes() {
  const all = changes.value;
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>(readView);
  if (!all) return <section class="view"><p class="muted">Connecting…</p></section>;
  const shown = query.trim() ? all.filter((c) => fuzzyScore(query, `${c.title} ${c.slug}`) !== null) : all;
  const pick = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* kept for this visit only */ }
  };
  const blocked = shown.filter((c) => c.stage === "blocked");
  const closed = shown.filter((c) => c.stage === "closed");
  return (
    <section class="view" style={{ maxWidth: "none" }}>
      <div class="view-head"><h1>Changes</h1><span class="muted">{all.length} in all</span></div>
      <div class="toolbar">
        <input type="search" placeholder="Filter by name" value={query} onInput={(e) => setQuery(e.currentTarget.value)} aria-label="Filter changes" />
        <span class="grow" />
        <button class={`btn${view === "board" ? " on" : ""}`} onClick={() => pick("board")}>Board</button>
        <button class={`btn${view === "list" ? " on" : ""}`} onClick={() => pick("list")}>List</button>
      </div>
      {view === "board" ? (
        <div class="board">
          {COLUMNS.map((col) => <Column key={col.stage} label={col.label} items={shown.filter((c) => c.stage === col.stage)} />)}
          {blocked.length > 0 && <Column label="Blocked" items={blocked} bad />}
        </div>
      ) : <ListView items={shown.filter((c) => c.stage !== "closed")} />}
      {closed.length > 0 && (
        <details class="folded">
          <summary>{closed.length} closed</summary>
          <ListView items={closed} />
        </details>
      )}
    </section>
  );
}

function Column({ label, items, bad }: { label: string; items: ChangeSummary[]; bad?: boolean }) {
  return (
    <div class={`column${bad ? " blocked" : ""}`}>
      <div class="col-head"><span>{label}</span><span>{items.length}</span></div>
      {items.map((c) => <Card key={c.slug} c={c} />)}
    </div>
  );
}

function Card({ c }: { c: ChangeSummary }) {
  return (
    <Link href={`/c/${c.slug}`} class={`ccard${c.running ? " running" : ""}`}>
      <span class="ccard-title">{c.running && <span class="pulse" aria-label="running" />}{c.title}</span>
      <span class="ccard-meta"><span class={`prio ${c.priority}`}>{c.priority}</span><span>{c.plain}</span></span>
      <span class="ccard-meta"><span>{c.inStatus ? `for ${c.inStatus}` : ""}</span><span>{usd(c.costUsd)}</span></span>
      {c.waiting && <span class="badge warn">{c.waiting}</span>}
    </Link>
  );
}

function ListView({ items }: { items: ChangeSummary[] }) {
  if (!items.length) return <p class="muted">No changes here.</p>;
  return (
    <table class="list">
      <thead><tr><th>Change</th><th>Priority</th><th>Where it is</th><th>For</th><th class="num">Cost</th><th>Note</th></tr></thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.slug}>
            <td><Link href={`/c/${c.slug}`}><b>{c.title}</b></Link></td>
            <td><span class={`prio ${c.priority}`}>{c.priority}</span></td>
            <td>{c.plain}</td>
            <td>{c.inStatus ?? ""}</td>
            <td class="num">{usd(c.costUsd)}</td>
            <td class="muted">{[c.waiting, c.note].filter(Boolean).join(" ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/views/Changes.tsx
git commit -m "feat(console): Changes: a board with a column per stage, or a list, with a filter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: A change's page

**Files:**
- Replace: `src/ui/views/Change.tsx`

- [ ] **Step 1: Write the screen**

```tsx
import { useEffect, useState } from "preact/hooks";
import type { ChangeDetail, DiffView, PhaseView, Stage } from "../../console/types";
import { clock, duration, usd } from "../format";
import { stripFrontmatter } from "../markdown";
import { Diff } from "../parts/Diff";
import { Link } from "../parts/Link";
import { Markdown } from "../parts/Markdown";
import { TABS, type Tab } from "../router";
import { changes, getJson, now, openDrawer, running } from "../store";
import { COLUMNS } from "./Changes";

const TAB_LABEL: Record<Tab, string> = { overview: "Overview", documents: "Documents", timeline: "Timeline", code: "Code", gates: "Gates" };

export function Change({ slug, tab }: { slug: string; tab: Tab }) {
  const summary = changes.value?.find((c) => c.slug === slug);
  const runningSeqs = running.value?.now.filter((p) => p.slug === slug).map((p) => p.seq).join(",") ?? "";
  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // Read again whenever the change's summary or its running steps change.
  const key = `${JSON.stringify(summary ?? null)}|${runningSeqs}`;
  useEffect(() => {
    let live = true;
    getJson<ChangeDetail>(`/api/changes/${slug}`).then(
      (d) => { if (live) { setDetail(d); setMissing(false); } },
      () => { if (live) setMissing(true); },
    );
    return () => { live = false; };
  }, [slug, key]);
  if (missing && detail?.slug !== slug) {
    return (
      <section class="view">
        <h1>No such change</h1>
        <p class="muted">There is no change called {slug}. <Link href="/changes">See every change</Link>.</p>
      </section>
    );
  }
  if (!detail || detail.slug !== slug) return <section class="view"><p class="muted">Loading…</p></section>;
  const d = detail;
  return (
    <section class="view">
      <div class="view-head">
        <h1>{d.title}</h1>
        <span class={`status ${d.status}`}>{d.plain}</span>
        <span class={`prio ${d.priority}`}>{d.priority}</span>
        {d.running && <span class="pulse" aria-label="running" />}
        <span class="grow" />
        <button class="btn" onClick={() => openDrawer(d.title)}>Ask the orchestrator</button>
      </div>
      <Stepper stage={d.stage} />
      <nav class="tabs" aria-label="Parts of this change">
        {TABS.map((t) => <Link key={t} href={t === "overview" ? `/c/${slug}` : `/c/${slug}/${t}`} class={`tab${t === tab ? " on" : ""}`}>{TAB_LABEL[t]}</Link>)}
      </nav>
      {tab === "overview" && <Overview d={d} />}
      {tab === "documents" && <Documents d={d} />}
      {tab === "timeline" && <Timeline d={d} />}
      {tab === "code" && <Code key={key} slug={slug} />}
      {tab === "gates" && <Gates d={d} />}
    </section>
  );
}

function Stepper({ stage }: { stage: Stage }) {
  if (stage === "blocked" || stage === "closed") {
    return <div class="stepper"><span class={`badge${stage === "blocked" ? " bad" : ""}`}>{stage === "blocked" ? "Blocked: it needs a person" : "Closed"}</span></div>;
  }
  const at = COLUMNS.findIndex((s) => s.stage === stage);
  return <div class="stepper">{COLUMNS.map((s, k) => <span key={s.stage} class={`step${k < at ? " done" : k === at ? " now" : ""}`}>{s.label}</span>)}</div>;
}

/** A document's text, read again when the change moves on. */
function useText(url: string | null, version: string | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setText(null);
    fetch(url).then((r) => (r.ok ? r.text() : "This document could not be read.")).then((t) => { if (live) setText(t); }, () => {});
    return () => { live = false; };
  }, [url, version]);
  return text;
}

function Overview({ d }: { d: ChangeDetail }) {
  const intent = useText(`/docs/${d.slug}/intent.md`, d.since);
  return (
    <div class="stack">
      <div class="facts">
        <span>In this status <b>{d.inStatus ?? "–"}</b></span>
        <span>Spent <b>{usd(d.costUsd)}</b></span>
        <span>Steps <b>{d.phases.length}</b></span>
        {d.dependsOn.length > 0 && <span>Depends on <b>{d.dependsOn.join(", ")}</b></span>}
      </div>
      {d.waiting && <span class="badge warn">{d.waiting}</span>}
      {d.note && <div class="panel"><h2>Note</h2><Markdown text={d.note} /></div>}
      <div class="panel">{intent === null ? <p class="muted">Loading the intent…</p> : <Markdown text={stripFrontmatter(intent)} />}</div>
    </div>
  );
}

function Documents({ d }: { d: ChangeDetail }) {
  const [name, setName] = useState(() => (d.documents.find((x) => x.name !== "intent.md") ?? d.documents[0])?.name ?? "");
  const doc = d.documents.find((x) => x.name === name) ?? null;
  const text = useText(doc?.url ?? null, d.since);
  if (!d.documents.length) return <p class="muted">No documents yet.</p>;
  return (
    <div>
      <div class="doc-tabs">{d.documents.map((x) => <button key={x.name} class={`btn${x.name === name ? " on" : ""}`} onClick={() => setName(x.name)}>{x.name}</button>)}</div>
      <div class="panel">{text === null ? <p class="muted">Loading…</p> : <Markdown text={name === "intent.md" ? stripFrontmatter(text) : text} />}</div>
    </div>
  );
}

function Timeline({ d }: { d: ChangeDetail }) {
  const t = now.value;
  if (!d.phases.length) return <p class="muted">No steps yet.</p>;
  const ends = d.phases.map((p) => (p.ended ? Date.parse(p.ended) : t));
  const start = Math.min(...d.phases.map((p) => Date.parse(p.started)));
  const span = Math.max(1, Math.max(...ends) - start);
  const took = (p: PhaseView) => duration(p.status === "running" ? t - Date.parse(p.started) : p.durationMs);
  return (
    <div class="stack">
      <div class="timeline">
        {d.phases.map((p, k) => {
          const left = ((Date.parse(p.started) - start) / span) * 100;
          const width = Math.min(100 - left, Math.max(0.4, ((ends[k]! - Date.parse(p.started)) / span) * 100));
          const row = (
            <>
              <span class="tl-name" title={p.name}>{p.name}</span>
              <span class="tl-track"><span class={`tl-bar ${p.status}`} style={{ left: `${left}%`, width: `${width}%` }} /></span>
              <span class="tl-meta">{took(p)} · {usd(p.costUsd)}</span>
            </>
          );
          return p.kind === "agent"
            ? <Link key={p.seq} href={`/s/${d.slug}/${p.seq}`} class="tl-row">{row}</Link>
            : <div key={p.seq} class="tl-row">{row}</div>;
        })}
      </div>
      <table class="list">
        <thead><tr><th>Step</th><th>Result</th><th>Started</th><th class="num">Took</th><th class="num">Cost</th><th>Files</th></tr></thead>
        <tbody>
          {d.phases.map((p) => (
            <tr key={p.seq}>
              <td>
                {p.kind === "agent" ? <Link href={`/s/${d.slug}/${p.seq}`}>{p.name}</Link> : p.name}
                {p.error && <div class="muted">{p.error}</div>}
                {p.denied.length > 0 && <div class="muted">Not allowed: {p.denied.join(", ")}</div>}
              </td>
              <td><span class={`status ${p.status}`}>{p.status}</span></td>
              <td>{clock(p.started, t)}</td>
              <td class="num">{took(p)}</td>
              <td class="num">{usd(p.costUsd)}</td>
              <td>{p.files.map((f) => <a key={f.name} href={f.url} target="_blank" rel="noopener noreferrer" class="chip">{f.name}</a>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Code({ slug }: { slug: string }) {
  const [diff, setDiff] = useState<DiffView | null>(null);
  useEffect(() => {
    let live = true;
    getJson<DiffView>(`/api/changes/${slug}/diff`).then(
      (v) => { if (live) setDiff(v); },
      () => { if (live) setDiff({ exists: false, stat: "", patch: "", cut: false }); },
    );
    return () => { live = false; };
  }, [slug]);
  if (!diff) return <p class="muted">Loading the diff…</p>;
  if (!diff.exists) return <p class="muted">This change has no branch: it has not been built yet, or it was merged and its branch removed.</p>;
  return (
    <div class="stack">
      <pre class="panel mono" style={{ margin: 0, overflowX: "auto" }}>{diff.stat.trim() || "No files changed."}</pre>
      {diff.cut && <span class="badge warn">This diff is long, so only its start is shown.</span>}
      <Diff text={diff.patch} />
    </div>
  );
}

function Gates({ d }: { d: ChangeDetail }) {
  const t = now.value;
  if (!d.gates.length) return <p class="muted">No gate has been checked yet.</p>;
  return (
    <table class="list">
      <thead><tr><th>Gate</th><th>Check</th><th>Result</th><th>When</th><th>Evidence</th></tr></thead>
      <tbody>
        {[...d.gates].reverse().map((g, k) => (
          <tr key={k}>
            <td>{g.gate}</td>
            <td>{g.check}</td>
            <td><span class={`status ${g.result}`}>{g.result}</span></td>
            <td>{clock(g.ts, t)}</td>
            <td><Markdown text={g.evidence} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/views/Change.tsx
git commit -m "feat(console): a change's page: overview, documents, timeline, code and gates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: Activity and Spend

**Files:**
- Replace: `src/ui/views/Activity.tsx`, `src/ui/views/Spend.tsx`

- [ ] **Step 1: Write `src/ui/views/Activity.tsx`**

```tsx
import { useEffect, useState } from "preact/hooks";
import type { ActivityItem } from "../../console/types";
import { clock } from "../format";
import { Link } from "../parts/Link";
import { activity, changes, getJson, now } from "../store";

/** The trace's own slugs, in words. */
const OWN: Record<string, string> = { _chat: "chat", _loop: "the loop", _signals: "main" };

export function Activity() {
  const [slug, setSlug] = useState("");
  const [technical, setTechnical] = useState(false);
  const [older, setOlder] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const load = async (before: number, reset: boolean) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ before: String(before) });
      if (slug) q.set("slug", slug);
      if (technical) q.set("technical", "1");
      const page = await getJson<{ items: ActivityItem[]; next: number | null }>(`/api/events?${q}`);
      setOlder((o) => (reset ? page.items : [...o, ...page.items]));
      setNext(page.next);
    } catch {
      setNext(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(0, true); }, [slug, technical]);
  // The live stream carries only events in plain words; the technical view loads again on Refresh.
  const newest = older[0]?.id ?? 0;
  const fresh = technical ? [] : activity.value.filter((a) => a.id > newest && (!slug || a.slug === slug)).reverse();
  const items = [...fresh, ...older];
  const t = now.value;
  return (
    <section class="view">
      <div class="view-head"><h1>Activity</h1></div>
      <div class="toolbar">
        <select value={slug} onChange={(e) => setSlug(e.currentTarget.value)} aria-label="Which change">
          <option value="">Everything</option>
          {(changes.value ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.title}</option>)}
          <option value="_chat">Chat</option>
          <option value="_loop">The loop</option>
        </select>
        <label><input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.currentTarget.checked)} /> Technical</label>
        {technical && <button class="btn" onClick={() => void load(0, true)}>Refresh</button>}
      </div>
      {!items.length && !loading ? <p class="muted">Nothing has happened yet.</p> : (
        <ul class="feed">
          {items.map((a) => (
            <li key={a.id}>
              <span class="t">{clock(a.ts, t)}</span>
              <span>{a.slug.startsWith("_") ? <span class="muted">{OWN[a.slug] ?? a.slug}</span> : <Link href={`/c/${a.slug}`}>{a.slug}</Link>}</span>
              <span class={technical ? "tech" : ""}>
                {technical ? a.technical : a.text}
                {a.seq !== null && <> · <Link href={`/s/${a.slug}/${a.seq}`} class="muted">step {a.seq}</Link></>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next !== null && <p><button class="btn" disabled={loading} onClick={() => void load(next, false)}>{loading ? "Loading…" : "Older"}</button></p>}
    </section>
  );
}
```

- [ ] **Step 2: Write `src/ui/views/Spend.tsx`**

```tsx
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SpendView } from "../../console/types";
import { usd } from "../format";
import { Link } from "../parts/Link";
import { getJson } from "../store";

export function Spend() {
  const [v, setV] = useState<SpendView | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => getJson<SpendView>("/api/spend").then((x) => { if (live) setV(x); }, () => {});
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!v) return <section class="view"><p class="muted">Loading…</p></section>;
  const topHour = Math.max(0.01, ...v.byHour.map((h) => h.costUsd));
  return (
    <section class="view">
      <div class="view-head"><h1>Spend</h1><span class="muted">On a subscription these are estimates. Chat is included.</span></div>
      <div class="tiles">
        <div class="tile"><span class="muted">Today</span><span class="v">{usd(v.totals.todayUsd)}</span></div>
        <div class="tile"><span class="muted">This week</span><span class="v">{usd(v.totals.weekUsd)}</span></div>
        <div class="tile"><span class="muted">All time</span><span class="v">{usd(v.totals.allUsd)}</span></div>
        <div class="tile"><span class="muted">Chat, all time</span><span class="v">{usd(v.chatUsd)}</span></div>
      </div>
      <h2>The last 48 hours</h2>
      <div class="hours" role="img" aria-label="Spend per hour over the last 48 hours">
        {v.byHour.map((h) => (
          <i key={h.hour} style={{ height: `${(h.costUsd / topHour) * 100}%` }}
            title={`${new Date(h.hour).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: ${usd(h.costUsd)}`} />
        ))}
      </div>
      <h2>By change</h2>
      <Bars rows={v.perChange.map((c) => ({ key: c.slug, label: <Link href={`/c/${c.slug}`}>{c.title}</Link>, value: c.costUsd }))} />
      <h2>By kind of step</h2>
      <Bars rows={v.perPhase.map((p) => ({ key: p.name, label: <span>{p.name} <span class="muted">×{p.count}</span></span>, value: p.costUsd }))} />
      {v.judges && <Judges j={v.judges} />}
    </section>
  );
}

function Bars({ rows }: { rows: Array<{ key: string; label: ComponentChildren; value: number }> }) {
  if (!rows.length) return <p class="muted">Nothing spent yet.</p>;
  const top = Math.max(0.01, ...rows.map((r) => r.value));
  return (
    <div class="bars">
      {rows.map((r) => (
        <div key={r.key} class="bar-row">
          <span>{r.label}</span>
          <span class="bar-track"><span class="bar-fill" style={{ width: `${(r.value / top) * 100}%`, display: "block" }} /></span>
          <span class="num">{usd(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Judges({ j }: { j: NonNullable<SpendView["judges"]> }) {
  return (
    <>
      <h2>Cheaper judges</h2>
      <p class="muted">How often {j.cheapModel}, asked the same question, agreed with {j.strongModel} (setting: {j.setting}). They have cost {usd(j.spentUsd)}.</p>
      <table class="list">
        <thead><tr><th>Judge</th><th class="num">Compared</th><th class="num">Agreed</th><th class="num">Passed what the strong judge rejected</th><th>Goes first</th></tr></thead>
        <tbody>
          {j.judges.map((r) => (
            <tr key={r.judge}>
              <td>{r.judge}</td>
              <td class="num">{r.compared}</td>
              <td class="num">{r.agreed}</td>
              <td class="num">{r.falsePasses}</td>
              <td>{r.goesFirst ?? r.why ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 3: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 4: Commit**

```bash
git add src/ui/views/Activity.tsx src/ui/views/Spend.tsx
git commit -m "feat(console): Activity in plain words or technical, and Spend by day, change, kind and hour" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: The orchestrator's drawer

**Files:**
- Replace: `src/ui/parts/Drawer.tsx`

- [ ] **Step 1: Write the drawer**

It talks to the existing `/api/chat` the way the old page did (see `src/chat/transports/dashboard.ts`): one thread per tab, posts with JSON, reads the thread and new announcements back.

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { drawer, meta } from "../store";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

interface ChatMessage { id: number; from: "person" | "loopstra"; text: string }
interface Line { key: string; kind: "person" | "loopstra" | "announce"; text: string }

/** One conversation per tab, kept across reloads. The server accepts only this plain shape. */
function threadId(): string {
  const fresh = () => `tab-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  try {
    let id = sessionStorage.getItem("loopstra-chat");
    if (!id) {
      id = fresh();
      sessionStorage.setItem("loopstra-chat", id);
    }
    return id;
  } catch {
    return fresh();
  }
}

export function Drawer() {
  const d = drawer.value;
  if (!d.open) return null;
  const close = () => { drawer.value = { ...d, open: false }; };
  return (
    <aside class="drawer" aria-label="The orchestrator">
      <header>
        <b>Orchestrator</b>
        <span class="muted about">{d.about ? `About ${d.about}` : "Ask how things are going, or talk through a new change."}</span>
        <button class="ghost" onClick={close} aria-label="Close"><Icon name="close" /></button>
      </header>
      {meta.value && !meta.value.chat ? <p class="pad muted">Chat is off in this console: it was started with --no-chat.</p> : <Chat about={d.about} />}
    </aside>
  );
}

function Chat({ about }: { about: string | null }) {
  const [thread] = useState(threadId);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const after = useRef(0);
  const announcementsAfter = useRef(-1);
  const toldAbout = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const r = await fetch(`/api/chat?thread=${thread}&after=${after.current}&announcementsAfter=${announcementsAfter.current}`);
      if (!r.ok) return;
      const j = await r.json() as { messages: ChatMessage[]; busy: boolean; announcements: Array<{ id: number; text: string }>; lastAnnouncementId: number };
      const more: Line[] = [
        ...j.messages.map((m) => ({ key: `m${m.id}`, kind: m.from, text: m.text })),
        ...j.announcements.map((a) => ({ key: `a${a.id}`, kind: "announce" as const, text: a.text })),
      ];
      if (j.messages.length) after.current = j.messages.at(-1)!.id;
      announcementsAfter.current = j.lastAnnouncementId;
      if (more.length) setLines((l) => [...l, ...more]);
      setBusy(j.busy);
    } catch { /* the next poll tries again */ }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [lines, busy]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    // The first message after the drawer was opened from somewhere says what it is about.
    const message = about && toldAbout.current !== about ? `About ${about}: ${body}` : body;
    toldAbout.current = about;
    setText("");
    setBusy(true);
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread, text: message }) });
    if (!r.ok) {
      const why = r.status === 409 ? "Still answering your last message." : "That message could not be sent.";
      setLines((l) => [...l, { key: `e${Date.now()}`, kind: "announce", text: why }]);
    }
    await refresh();
  };

  return (
    <>
      <div class="chat-log" ref={log} aria-live="polite">
        {!lines.length && <p class="muted">Try "what's blocked?", "what merged this week?", or describe something new you want built.</p>}
        {lines.map((l) => (l.kind === "loopstra"
          ? <div key={l.key} class="msg loopstra"><Markdown text={l.text} /></div>
          : <div key={l.key} class={`msg ${l.kind}`}>{l.text}</div>))}
        {busy && <div class="msg loopstra muted">Thinking…</div>}
      </div>
      <form class="chat-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea
          rows={2}
          value={text}
          placeholder="Message the orchestrator"
          aria-label="Message the orchestrator"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button class="btn primary" type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>
    </>
  );
}
```

- [ ] **Step 2: Typecheck and bundle**

Run: `bun run typecheck && bun build src/ui/index.html --outdir node_modules/.cache/console-check --minify`
Expected: no typecheck output; the bundle builds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/parts/Drawer.tsx
git commit -m "feat(console): the orchestrator in a drawer on every screen, told what it was opened from" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 24: The page's size budget

**Files:**
- Test: `tests/unit/console-page.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("the console's page", () => {
  test("bundles without errors, and its scripts stay under 80 KB gzipped", async () => {
    const r = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "..", "src", "ui", "index.html")], minify: true });
    expect(r.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
    expect(r.success).toBe(true);
    let gzipped = 0;
    for (const o of r.outputs) if (o.path.endsWith(".js")) gzipped += Bun.gzipSync(new Uint8Array(await o.arrayBuffer())).length;
    expect(gzipped).toBeGreaterThan(10_000);
    expect(gzipped).toBeLessThan(80 * 1024);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/unit/console-page.test.ts`
Expected: PASS. (About 30 KB is expected. If it fails on size, find what grew with `bun build src/ui/index.html --outdir <scratch> --minify` and look at the chunk.)

- [ ] **Step 3: Commit**

```bash
git add tests/unit/console-page.test.ts
git commit -m "test(console): the page bundles and its scripts stay under 80 KB gzipped" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 25: Docs

**Files:**
- Modify: `README.md`, `templates/skill/SKILL.md`, `templates/intent-README.md`, `docs/decisions.md`

- [ ] **Step 1: README**

1. Replace the UI's name, "dashboard", with "console" wherever it means the UI (not the `dashboard` chat transport in `chat.transports`, which keeps its name):

```bash
sed -i 's/the dashboard'"'"'s/the console'"'"'s/g; s/the dashboard/the console/g; s/a local dashboard/a local console/g' README.md
grep -n -i dashboard README.md
```

Expected: two lines are left, the `loopstra ui` line in Watch (line 134) and the paragraph that starts "The dashboard is one local page" (line 142). Fix those, and the `loopstra ui` line in Chat (line 151, which the `sed` turned into "the console has the same chat as a panel"), by hand:

- In Watch, the `loopstra ui` line becomes:

```
loopstra ui             # the console at http://127.0.0.1:4646 (--port <n>), with the orchestrator (see Chat)
```

- The paragraph "The dashboard is one local page, polling every couple of seconds. ..." is replaced by:

```markdown
The console is one local web app that updates live (one stream from the server, no polling, about 30 KB of script):

- **Live:** a card for every agent running now: its change, step and model, a running clock and an estimated cost (marked `~`; the real cost is recorded when the step ends), what it is doing ("Running bun test", "Editing src/csv.ts") and its recent activity. Under the cards, what is up next and why it waits, and the steps that just finished.
- **A session:** an agent's transcript as it happens: what it wrote, each tool call (open one to see its input and output), each edit as a diff, and how it ended, with its todo list, cost and files beside it.
- **Inbox:** everything that needs a person, the same list as `status`. <kbd>J</kbd> and <kbd>K</kbd> move through it, <kbd>O</kbd> opens a change.
- **Changes:** a board with a column per stage (or a list), and a page per change: its note and intent, its documents (rendered, read-only), a timeline of its steps with what each cost and any commands it was refused, its code (the branch's diff against main), and its gate results with their evidence.
- **Activity:** what happened, in plain words, or the trace's technical events.
- **Spend:** today, this week and all time, by change, by kind of step and by hour, and the cheaper judges' record.

The orchestrator is a drawer on every screen (Ctrl J; see Chat); opened from a change or an inbox item, it is told what it is about. Ctrl K searches changes, agents and commands; `?` lists the keys. The tab's title counts what needs you, and the palette can turn on browser notifications for when the tab is in the background. The console listens only on 127.0.0.1 and, apart from chat, changes nothing. `queue.md` in `intent/` is a generated view of the same queue; its "Needs a person" list matches.
```

- In Chat, the `loopstra ui` line becomes:

```
loopstra ui                 # the console has the same chat in a drawer (Ctrl J; --no-chat to leave it out)
```

- [ ] **Step 2: The shipped skill and the owners' README**

In `templates/skill/SKILL.md`, change "the dashboard's chat panel" to "the console's orchestrator (Ctrl J)", and "the same list as the dashboard's" to "the same list as the console's inbox". In `templates/intent-README.md`, change "in the terminal, the dashboard, Slack or Discord" to "in the terminal, the console, Slack or Discord".

Run: `bun test tests/unit/templates.test.ts tests/unit/templates-roundtrip.test.ts tests/unit/init.test.ts`
Expected: PASS. (If a test pins the old wording, update the test's expected text to the new wording; nothing else.)

- [ ] **Step 3: Decisions**

Append to `docs/decisions.md`:

```markdown
## The console, part 1 (2026-10-17)

Design: `docs/superpowers/specs/2026-10-17-console-design.md`. Parts 2 (controls) and 3 (steering) follow in their own plans.

- **Preact, bundled by Bun at start.** The page is TSX with Preact and `@preact/signals`; `Bun.serve` bundles `src/ui/index.html` as an HTML import when `loopstra ui` starts, so there is no build step and nothing generated is committed. About 30 KB of script, gzipped; a test keeps it under 80 KB. `marked` renders Markdown with raw HTML escaped and only http(s) and relative links.
- **One stream, sections replaced whole.** `/api/stream` sends a snapshot of five sections (`loop`, `inbox`, `changes`, `running`, `totals`), then only the sections whose JSON changed, and new events in plain words. One hub per server rebuilds the model at most four times a second when a cheap fingerprint changes (the newest event id, the heartbeat, the pause, the config, every intent's file, and a ten-second clock bucket for ages). No JSON patches: a section is small, and replacing it whole cannot drift. A ping every 15 s lets the page tell a quiet stream from a dead one; 20 s of silence shows "Reconnecting…".
- **Transcripts are normalised on the server.** `/api/sessions/<slug>/<seq>/stream` reads `raw.jsonl` from a byte offset (the SSE id), so a reconnect continues where it was; the page never parses Claude's format. The file is polled every 250 ms (watching a growing file is unreliable on Windows). Thinking, hooks, rate limits and progress events are not shown; the answer tool's call is shown as the result.
- **Live cost is an estimate.** The CLI reports a session's cost only at its end, so a running card shows the minutes so far times `USD_PER_MINUTE` ($0.20), marked `~`.
- **What an agent is doing.** `claude_event` summaries now keep each tool's target (`targets`, beside `items`) and the init event's model, so the Live card can say "Running bun test" without reading raw files.
- **Long transcripts.** Rows use `content-visibility: auto` and only the newest 1,500 are drawn until "Show earlier"; tool output is folded and cut at 200 lines. A virtual list was not needed.
- **Host checks.** Every data route answers only to 127.0.0.1, localhost or [::1] (it was only `/api/chat` before). The page and its chunks are served by Bun before the router and are the same static code for everyone.
- **Activity.** The live stream carries only events with plain words; the technical view pages through `/api/events?technical=1` and refreshes on request.
```

- [ ] **Step 4: Commit**

```bash
git add README.md templates/skill/SKILL.md templates/intent-README.md docs/decisions.md tests
git commit -m "docs(console): the console in the README, the shipped skill and the decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 26: Check it end to end, then finish the branch

**Files:** none committed. A demo script goes in the session's scratchpad.

- [ ] **Step 1: The whole suite and the typecheck**

Run: `bun run typecheck && bun run test`
Expected: no typecheck output; `... pass, 0 fail`.

- [ ] **Step 2: A demo folder with agents that keep working**

Write this script to the scratchpad as `console-demo.ts` (not in the repo). It fills a throwaway folder with changes in every stage, a heartbeat, and two sessions that add a tool call every 1.5 seconds, so the console can be looked at live without spending anything:

```ts
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHeartbeat } from "C:/Source/Repos/loopstra-console/src/heartbeat";
import { summarize } from "C:/Source/Repos/loopstra-console/src/phases";
import { Trace } from "C:/Source/Repos/loopstra-console/src/trace";

const root = process.argv[2]!;
mkdirSync(join(root, "loopstra"), { recursive: true });
writeFileSync(join(root, "loopstra", "config.yaml"), "version: 1\ncommands:\n  test: echo ok\n");
const changes: Array<[string, string, string, string?]> = [
  ["csv-export", "building", "Export reports as CSV"],
  ["dark-mode", "reviewing", "Dark mode"],
  ["auth-retry", "plan-approved", "Retry sign-in"],
  ["onboarding", "spec-review", "Onboarding tour"],
  ["old-thing", "blocked", "Old thing", "The tests failed three times. When that is sorted out, set status to plan-approved to try again."],
  ["an-idea", "draft", "An idea"],
  ["shipped", "done", "Something shipped"],
];
for (const [slug, status, title, note] of changes) {
  mkdirSync(join(root, "intent", slug), { recursive: true });
  writeFileSync(join(root, "intent", slug, "intent.md"),
    `---\nstatus: ${status}\n${note ? `note: ${note}\n` : ""}---\n# Intent: ${title}\n\n## Problem\nSomething is missing.\n\n## Proposed outcome\nIt is there.\n\n## Done when\n- It works.\n`);
}
const trace = Trace.open(root);
const sessions = [["csv-export", "build"], ["dark-mode", "review-1"]].map(([slug, name]) => {
  const seq = trace.phaseStart(slug!, name!, "agent");
  const dir = join(root, ".loopstra", "runs", slug!, "phases", `${seq}-${name}`);
  mkdirSync(dir, { recursive: true });
  const init = { type: "system", subtype: "init", cwd: root, model: "claude-sonnet-5-5" };
  appendFileSync(join(dir, "raw.jsonl"), `${JSON.stringify(init)}\n`);
  trace.event(slug!, "claude_event", summarize(init, root), seq);
  return { slug: slug!, seq, raw: join(dir, "raw.jsonl") };
});
const started = new Date().toISOString();
let n = 0;
setInterval(() => {
  writeHeartbeat(root, { pid: process.pid, startedAt: started, lastTickAt: started, lastBeatAt: new Date().toISOString(), current: { slug: "csv-export" }, working: ["csv-export", "dark-mode"], stopping: false, stopped: false });
  for (const s of sessions) {
    const id = `t${s.seq}-${n}`;
    const file = join(root, "src", "csv.ts");
    const tool = [
      { name: "Bash", input: { command: "bun test" } },
      { name: "Read", input: { file_path: file } },
      { name: "Edit", input: { file_path: file, old_string: `const rows = ${n};`, new_string: `const rows = ${n + 1};` } },
      { name: "TodoWrite", input: { todos: [{ content: "Write the exporter", status: "completed" }, { content: "Test it", status: n % 2 ? "in_progress" : "pending" }] } },
    ][n % 4]!;
    const said = { type: "assistant", message: { content: [{ type: "text", text: `Step ${n}: checking the export.` }, { type: "tool_use", id, ...tool }] } };
    const got = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: `ok ${n}\n`.repeat(3) }] } };
    appendFileSync(s.raw, `${JSON.stringify(said)}\n${JSON.stringify(got)}\n`);
    trace.event(s.slug, "claude_event", summarize(said, root), s.seq);
  }
  n++;
}, 1500);
console.log(`Demo running in ${root}. Ctrl-C to stop.`);
```

Run, in two terminals (`<scratchpad>` is this session's scratchpad folder; the demo folder must be new and empty):

```bash
bun "<scratchpad>/console-demo.ts" "<scratchpad>/demo"
cd "<scratchpad>/demo" && bun C:/Source/Repos/loopstra-console/src/cli.ts ui --port 4747 --no-chat
```

- [ ] **Step 3: Look at every screen in a browser**

Open `http://127.0.0.1:4747` (with the claude-in-chrome tools if available: load them in one ToolSearch call, open a new tab, take screenshots, read the console log with a pattern of `error`). Check, and fix anything that is off, each fix with its own commit:

- **Live:** two cards whose "now:" line, clock, `~` cost and strip move every 1.5 s; "Up next" lists auth-retry; "Just finished" is empty or lists finished steps.
- **Watch** on a card: the transcript grows; Read and Bash rows open to show input and output; the edit shows as a red and green diff; the todo list is pinned at the side; scrolling up shows "Jump to live", which goes back down.
- **Inbox:** old-thing (Blocked, red), an-idea and onboarding (Waiting for you, if the config has a person on the spec gate; otherwise only the draft). `J`, `K` and `O` work. The tab's title shows the count and the icon has a red dot.
- **Changes:** each change in its column; Blocked as its own column; done in Done; the filter and the list view work.
- **A change's page:** every tab renders. Code says there is no branch (the demo has none). Timeline bars link to sessions.
- **Activity:** events in plain words, and the technical switch with Refresh.
- **Spend:** tiles, hours, bars.
- **Ctrl K** finds "Open Dark mode" and "Watch Export reports as CSV: build"; **?** shows the keys; **Ctrl J** opens the drawer, which says chat is off (`--no-chat`).
- The theme button cycles system, dark and light; both themes are readable.
- Stopping the server for a few seconds shows "Reconnecting…", and starting it again recovers without a reload.
- The browser's console log has no errors.

Then stop both processes. Optionally run it once more without `--no-chat` in a set-up repository to check the drawer's chat against a real orchestrator turn; that uses the subscription, so ask the user first.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch. The pull request (if the user chooses one) goes against `main`, titled "The console, part 1: live agents, inbox, changes, sessions and the orchestrator", with a summary of the screens, the new endpoints, the decisions above, the test count, and the manual check. Parts 2 and 3 get their own plans: part 2 after `feat/simpler-core` is merged.

---

## Self-review against the spec

| Spec, part 1 | Where |
|---|---|
| Frame: top bar (pill, spend, palette, inbox count), rail, orchestrator drawer with context | Tasks 14, 15, 23 |
| Live: cards with model, clock, `~` cost, now-line, strip; up next with reasons; last five finished; empty state with next check | Tasks 7, 17 |
| Session: transcript with text, tool rows, inline diffs, todos, follow and "Jump to live", side panel | Tasks 6, 11, 16, 18 |
| Inbox, with j/k/o | Task 19 (approve and answer buttons come with parts 2 and 3) |
| Changes board with Blocked and Closed folded, search, list view | Task 20 |
| Change page tabs: overview, documents, timeline, code, gates | Tasks 8, 9, 21 |
| Activity in plain words, technical switch, paging | Tasks 5, 22 |
| Spend: totals, per change, per phase, by hour, judges | Tasks 8, 22 |
| Theme, notifications, tab title and favicon, keys, palette | Tasks 14, 15 |
| One live stream: snapshot, changed sections, events with ids, Last-Event-ID, keep-alive, stale bar | Tasks 10, 12, 13, 14 |
| Session stream from a byte offset, ending with the phase | Tasks 6, 11, 13 |
| Host check on every data route; Origin for writes (chat's, unchanged) | Task 13 |
| Markdown with raw HTML escaped and safe links | Task 12 |
| Speed budget (80 KB) | Task 24 |
| Old page, `/api/state` and its tests removed | Task 13 |
| README, decisions | Task 25 |
