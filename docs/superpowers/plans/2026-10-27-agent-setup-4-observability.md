# Agent Setup, Part 4: Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The console's session page shows what a step ran as (agent, subagents, teams, skills, tools, MCP tools, sources, subagent models) and shows each subagent's work nested under the call that started it.

**Architecture:** Part 1 already writes an `agent_setup` trace event on the phase row (`ctx.trace.event(slug, "agent_setup", {...}, seq)`) and passes `--forward-subagent-text` when a step has subagents or teams. This part reads that event into the phase view the session page already gets, and teaches the transcript parser (`src/console/transcript.ts` `toItems`) the `parent_tool_use_id` field so subagent items carry their parent call's id; the page nests them.

**Tech Stack:** Bun, TypeScript, Preact; tests in `tests/unit/console-*.test.ts` and `tests/unit/ui-logic.test.ts`.

**Spec:** `docs/superpowers/specs/2026-10-26-agent-setup-design.md`, section "Observability".

## Global Constraints

- A session with no `agent_setup` event (every session today, and every session with an empty setup) renders exactly as before.
- Stream facts (checked on Claude Code 2.1.311 with `--forward-subagent-text`): a subagent is started by a `tool_use` named `Agent` (older CLIs: `Task`) whose input has `subagent_type`, `description`, `prompt`; every event of the subagent carries `parent_tool_use_id: <that tool_use id>`; its first event is a `user` event whose content is a text block holding the prompt — this is NOT a person's message and must never render as one; the subagent's own `tool_use`/`tool_result`/`text` events follow, each with the parent id; the parent's `tool_result` for the `Agent` call has no parent id.
- Untrusted text (prompts, outputs) renders as text, as the transcript already does.

## Review Focus

1. A subagent's prompt (`user` event with `parent_tool_use_id`) never shows as a message from a person, in the live stream and when a transcript is read back from `raw.jsonl`.
2. Two subagents running at the same time (a `parallel` team) interleave their events: each item still lands under its own parent call.
3. A transcript resumed from a frame id in the middle of a subagent's events still nests the later items (the parent id travels with each item, not with reader state).
4. An old `raw.jsonl` without `parent_tool_use_id` renders exactly as before.

---

### Task 1: Agent setup in the phase view and the session facts

**Files:** the module that builds the session page's phase detail (`PhaseView`, find it from `src/ui/views/Session.tsx` `detail` and `card?.model`: `src/console/detail.ts` or `src/console/model.ts`), `src/console/types.ts`, `src/ui/views/Session.tsx` (`Facts`); tests in the matching console test file and `tests/unit/ui-logic.test.ts` if a pure helper is added.

**Interfaces:**
- `PhaseView` (or the card the page reads `model` from) gains `agentSetup: { agent: string | null; subagents: string[]; teams: string[]; skills: string[]; tools: string[]; mcpTools: string[]; sources: "all" | "repo"; models: Record<string, string> } | null`, read from the phase row's `agent_setup` event (latest one for that seq; null when none).
- `Facts` shows, only when `agentSetup` is not null: `Agent` (name, or "none"), `Subagents` (names, each with its model from `models` when known, e.g. "sec (haiku)"), `Teams`, `Skills`, `Tools` and `MCP tools` (only when non-empty), `Sources` (only when `repo`: "repo only").

- [ ] **Step 1: failing tests** — the phase view of a seq with an `agent_setup` event carries it (the event's payload keys are `agent, subagents, teams, skills, tools, mcp_tools, sources, models`); one without carries null; the page's Facts helper (if pure) gives the lines above, and nothing for null.
- [ ] **Step 2-4:** implement → pass → `bun run check`.
- [ ] **Step 5: Commit** `feat(console): a session's facts show what it ran as`.

---

### Task 2: Subagent work nested under its call

**Files:** `src/console/transcript.ts` (`toItems`, `replayed`), `src/console/types.ts` (`TranscriptItem`), `src/ui/transcript.ts` and the transcript view in `src/ui/views/Session.tsx` (and the Agents tiles if they render items); tests in the transcript test file (find with `grep -l toItems tests/unit`) and `tests/unit/ui-logic.test.ts`.

**Interfaces:**
- Every `TranscriptItem` variant may carry `parent?: string` (the `parent_tool_use_id`); `toItems` sets it from the event.
- A `user` event with a `parent_tool_use_id` whose content is text becomes `{ kind: "delegated", parent, text }` (the subagent's prompt), never a `message`.
- `toolTarget` for `Agent`/`Task` shows `subagent_type: description` (src/tools.ts; it already names Task "Handing off").
- `src/ui/transcript.ts` exports a pure `nest(items: TranscriptItem[]): Array<TranscriptItem & { children?: TranscriptItem[] }>` that places every item with `parent` under the `tool` item whose `id` equals it (items whose parent is not in the list stay top-level, marked so the page can say "(from a subagent)").
- The view renders a subagent call as a collapsible block: its summary line ("Handing off to sec: Security review of a.txt"), then the prompt (collapsed), the subagent's text and tool calls indented, and the call's result.

- [ ] **Step 1: failing tests** — with a fixture made from the stream facts in Global Constraints (one `Agent` call, its prompt event, one `Read` call and result, a text, the parent's result): `toItems` gives `parent` on the subagent's items and `delegated` for the prompt; `nest` puts them under the call; two interleaved subagents nest under their own calls; a resumed slice starting mid-subagent still nests; an old fixture without parent ids gives the same items as before.
- [ ] **Step 2-4:** implement → pass → `bun run check`; one browser screenshot of a seeded session with a subagent call (the Part 3 scripts in the scratchpad `agents-ui/` show how to seed and shoot) saved as `session-subagent.png` there.
- [ ] **Step 5: Commit** `feat(console): subagent work nested under the call that started it`.

---

### Task 3: Docs

- `README.md` (the console's session page paragraph): what a session shows of its agent setup and subagents.
- `docs/decisions.md`: the stream facts above (checked on 2.1.311), `delegated` items, nesting by parent id.
- [ ] Edit; `bun run check`; commit `docs: agent setup on the session page`.
