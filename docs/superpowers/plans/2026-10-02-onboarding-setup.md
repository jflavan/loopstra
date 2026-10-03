# Onboarding (`loopstra setup`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every budget optional and unlimited by default, add an optional daily cap for the loop, and add `loopstra setup`, a re-runnable, comment-preserving walkthrough of every setting with read-only checks.

**Architecture:** Budgets: unset values mean `Infinity` inside the runtime (`limitOf`), and `runPhase` only passes `--max-budget-usd` for a finite cap. The loop's daily cap reuses the trace's budget hold (`phaseStartWithin`) over a pool of every slug except `_chat`, and pauses the loop (`LoopBudgetReached`) instead of blocking a change. Setup is plain TypeScript: a YAML `Document` wrapper (`ConfigDocument`) that edits in place, a stream prompt (`StreamPrompt`) and a no-questions prompt (`DefaultsPrompt`), and six independent sections that each `ask` and `check`.

**Tech Stack:** Bun, TypeScript, zod, `yaml` (v2 Document API), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-02-onboarding-setup-design.md`

**Conventions for every task:**
- Run one test file with `bun test <file> --timeout 30000`; the whole suite with `bun run test`; types with `bun run typecheck`.
- Match the surrounding style: short doc comments in plain words, no new abstractions beyond the plan.
- Commit messages: conventional (`feat(setup): ...`, `fix(budget): ...`), ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/fsutil.ts` | new | `writeFileAtomic`: the one temp-then-rename writer |
| `src/budget.ts` | new | Budget constants and helpers: `CHAT_SLUG`, `MIN_SESSION_USD`, `startOfToday`, `limitOf`, the loop's daily cap |
| `src/trace.ts` | modify | `BudgetPool`, `costIn`; `phaseStartWithin` takes a pool and copes with no limit |
| `src/config.ts` | modify | Budgets optional; new `claude.max_budget_usd_per_day`; `validateConfig` |
| `src/claude.ts` | modify | `maxBudgetUsd` optional; no flag for no cap |
| `src/stop.ts` | modify | `LoopBudgetReached` |
| `src/phases.ts` | modify | `startPhase` holds the loop's day; notes name the setting |
| `src/git.ts`, `src/scheduler.ts`, `src/attention.ts` | modify | Pass `LoopBudgetReached` through; pause the tick; show it |
| `src/chat/agents.ts`, `src/chat/orchestrator.ts`, `src/chat/writer.ts`, `src/chat/threads.ts`, `src/heartbeat.ts` | modify | No-limit chat; shared helpers |
| `src/setup/document.ts` | new | `ConfigDocument`: get/set/put/clear/validate/save, keeping comments |
| `src/setup/prompt.ts` | new | `Prompt`, `StreamPrompt`, `DefaultsPrompt`, `parseAmount`, `SetupStopped` |
| `src/setup/types.ts` | new | `SetupContext`, `Section`, `Check` |
| `src/setup/index.ts` | new | `setup()`: runs sections, saves once, runs checks |
| `src/setup/sections/*.ts` | new | `budgets`, `commands`, `gates`, `github`, `chat`, `models`, and `index.ts` (`SECTIONS`) |
| `src/cli.ts`, `src/init.ts` | modify | `loopstra setup`; init offers it |
| `templates/config.yaml`, `templates/skill/SKILL.md`, `README.md`, `docs/decisions.md` | modify | Docs |
| `tests/setup-helpers.ts` | new | `scripted`, `configRepo`, `askSection`, `checkSection` |
| `tests/unit/*.test.ts`, `tests/integration/setup.test.ts` | new/modify | Tests per task |

---

### Task 1: One atomic file writer

**Files:**
- Create: `src/fsutil.ts`
- Modify: `src/chat/threads.ts:63-69`, `src/heartbeat.ts:45-62`
- Test: `tests/unit/fsutil.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/fsutil.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/fsutil";
import { tempDir } from "../helpers";

describe("writeFileAtomic", () => {
  test("writes the whole file, makes its folder, and leaves no temp file", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "a", "b", "c.json");
      writeFileAtomic(path, "one");
      writeFileAtomic(path, "two");
      expect(readFileSync(path, "utf8")).toBe("two");
      expect(readdirSync(join(t.path, "a", "b"))).toEqual(["c.json"]);
    } finally { t.cleanup(); }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/fsutil.test.ts --timeout 30000`
Expected: FAIL, cannot find module `../../src/fsutil`.

- [ ] **Step 3: Write `src/fsutil.ts`**

```ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a file whole: a temp file beside it, then a rename over it, so a reader never sees half of
 * it. Makes its folder. Windows refuses the rename while a reader has the file open; a plain write
 * is used then.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, text);
    rmSync(tmp, { force: true });
  }
}
```

- [ ] **Step 4: Use it in the two existing copies**

In `src/chat/threads.ts`, replace the body of `writeJson`:

```ts
/** Writes a JSON file whole (temp file, then rename), so a reader never sees half of it. Makes its folder. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}
```

and add `import { writeFileAtomic } from "../fsutil";`. Remove any of `mkdirSync`, `renameSync`, `writeFileSync`, `dirname` from that file's imports that are no longer used (check with `bun run typecheck` and a search of the file).

In `src/heartbeat.ts`, replace `writeHeartbeat`:

```ts
/** Writes the heartbeat whole (temp file, then rename), so a reader never sees half of it. Never throws. */
export function writeHeartbeat(root: string, hb: Heartbeat): void {
  try {
    writeFileAtomic(heartbeatPath(root), JSON.stringify(hb, null, 2));
  } catch {
    /* The heartbeat is for display only; it must never stop the loop. */
  }
}
```

and add `import { writeFileAtomic } from "./fsutil";`. Remove `renameSync` from its imports if nothing else uses it (keep `mkdirSync`, `writeFileSync`, `rmSync`, `readFileSync` if still used, e.g. by `pauseAfterUnavailable`).

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/fsutil.test.ts tests/unit/heartbeat.test.ts tests/unit/chat-orchestrator.test.ts --timeout 30000` and `bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/fsutil.ts src/chat/threads.ts src/heartbeat.ts tests/unit/fsutil.test.ts
git commit -m "refactor: one atomic file writer for heartbeat and chat state"
```

---

### Task 2: Budget helpers and budget pools in the trace

**Files:**
- Create: `src/budget.ts`
- Modify: `src/trace.ts` (`costSince`, `phaseStartWithin`, around lines 155-170 and 243-253), `src/chat/agents.ts:1-13` and `:57` and `:140-149`
- Test: `tests/unit/budget.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/budget.test.ts
import { describe, expect, test } from "bun:test";
import { CHAT_SLUG, limitOf, loopSpentToday } from "../../src/budget";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

function withTrace(fn: (trace: Trace, since: string) => void): void {
  const t = tempDir();
  const trace = Trace.open(t.path);
  try { fn(trace, new Date(Date.now() - 60_000).toISOString()); } finally { trace.close(); t.cleanup(); }
}

function spent(trace: Trace, slug: string, usd: number): void {
  const seq = trace.phaseStart(slug, "x", "agent");
  trace.phaseEnd(slug, seq, { status: "success", costUsd: usd });
}

describe("budget pools", () => {
  test("a pool is one slug's phases, or every slug's but one", () => {
    withTrace((trace, since) => {
      spent(trace, "a", 1);
      spent(trace, "b", 2);
      spent(trace, CHAT_SLUG, 4);
      expect(trace.costIn({ slug: "a" }, since)).toBe(1);
      expect(trace.costIn({ except: CHAT_SLUG }, since)).toBe(3);
      expect(trace.costSince("b", since)).toBe(2);
      expect(loopSpentToday(trace)).toBe(3);
    });
  });

  test("with no limit and no cap, a phase starts holding nothing", () => {
    withTrace((trace, since) => {
      const held = trace.phaseStartWithin("a", "x", "agent", { since, limitUsd: Infinity, capUsd: Infinity, floorUsd: 0.01 })!;
      expect(held.heldUsd).toBe(Infinity);
      expect(trace.phases("a")[0]!.cost_usd).toBe(0);
    });
  });

  test("the loop's pool counts every change's holds and spending, not chat's", () => {
    withTrace((trace, since) => {
      const day = { since, limitUsd: 3, capUsd: 2, floorUsd: 0.01, pool: { except: CHAT_SLUG } };
      expect(trace.phaseStartWithin("a", "x", "agent", day)!.heldUsd).toBe(2);
      trace.phaseStart(CHAT_SLUG, "orchestrator", "agent", 10);
      expect(trace.phaseStartWithin("b", "x", "agent", day)!.heldUsd).toBe(1);
      expect(trace.phaseStartWithin("c", "x", "agent", day)).toBeNull();
    });
  });

  test("a budget that is not set is no limit", () => {
    expect(limitOf(undefined)).toBe(Infinity);
    expect(limitOf(4)).toBe(4);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/budget.test.ts --timeout 30000`
Expected: FAIL, cannot find module `../../src/budget`.

- [ ] **Step 3: Write `src/budget.ts`**

```ts
import type { Trace } from "./trace";

/** The trace slug every chat turn and writer run is recorded under. */
export const CHAT_SLUG = "_chat";

/** The least a session may hold of a daily budget; with less left, it does not start. */
export const MIN_SESSION_USD = 0.01;

/** Local midnight today, as an ISO time: where every daily budget starts. */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** A budget that is not set is no limit. */
export function limitOf(usd: number | undefined): number {
  return usd ?? Infinity;
}

/** What the loop's sessions (every change's, not chat's) spent since local midnight, in sessions that have ended. */
export function loopSpentToday(trace: Trace, now = new Date()): number {
  return trace.costIn({ except: CHAT_SLUG }, startOfToday(now), { endedOnly: true });
}
```

(`loopDayUsedUp` and `loopDayNote` come in Task 5, once the config has `claude.max_budget_usd_per_day`.)

- [ ] **Step 4: Pools in `src/trace.ts`**

Above the `Trace` class, add:

```ts
/** Whose phases a budget counts: one slug's, or every slug's but one (the loop's day leaves chat out). */
export type BudgetPool = { slug: string } | { except: string };
```

Replace `costSince` with `costSince` plus `costIn`:

```ts
  /**
   * What a slug's phases that started at or after `since` (an ISO time) cost. Running phases count at
   * what they hold, unless `endedOnly`.
   */
  costSince(slug: string, since: string, opts: { endedOnly?: boolean } = {}): number {
    return this.costIn({ slug }, since, opts);
  }

  /** costSince over a pool of slugs. */
  costIn(pool: BudgetPool, since: string, opts: { endedOnly?: boolean } = {}): number {
    const who = "slug" in pool ? "slug = ?" : "slug != ?";
    const running = opts.endedOnly ? " AND status != 'running'" : "";
    return this.db.query<{ c: number | null }, [string, string]>(`SELECT SUM(cost_usd) AS c FROM phases WHERE ${who} AND started >= ?${running}`)
      .get("slug" in pool ? pool.slug : pool.except, since)?.c ?? 0;
  }
```

Replace `phaseStartWithin` (keep its existing doc comment, adding the two sentences shown):

```ts
  /**
   * (existing comment...) `pool` is whose spending counts against the limit (the slug's own by
   * default). With no limit and no cap (both Infinity) nothing is held: the row starts at 0.
   */
  phaseStartWithin(slug: string, name: string, kind: "agent" | "code" | "human", budget: { since: string; limitUsd: number; capUsd: number; floorUsd: number; pool?: BudgetPool }): { seq: number; heldUsd: number } | null {
    const reserve = this.db.transaction(() => {
      const spent = this.costIn(budget.pool ?? { slug }, budget.since);
      const left = budget.limitUsd - spent;
      if (left < budget.floorUsd) return null;
      const heldUsd = Math.min(budget.capUsd, left);
      return { seq: this.phaseStart(slug, name, kind, Number.isFinite(heldUsd) ? heldUsd : 0), heldUsd };
    });
    return reserve.immediate();
  }
```

- [ ] **Step 5: Chat uses the shared helpers**

In `src/chat/agents.ts`: delete the local `CHAT_SLUG` constant, the local `MIN_SESSION_USD` constant (with its comment), and the local `startOfToday` function (with its comment). Add near the top:

```ts
import { CHAT_SLUG, MIN_SESSION_USD, startOfToday } from "../budget";

export { CHAT_SLUG, MIN_SESSION_USD, startOfToday };
```

Keep `chatSpentToday` as it is (it still uses `trace.costSince`).

- [ ] **Step 6: Run the tests**

Run: `bun test tests/unit/budget.test.ts tests/unit/chat-orchestrator.test.ts tests/unit/trace.test.ts --timeout 30000` and `bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/budget.ts src/trace.ts src/chat/agents.ts tests/unit/budget.test.ts
git commit -m "feat(budget): budget pools in the trace and shared budget helpers"
```

---

### Task 3: A session with no cap gets no `--max-budget-usd`

**Files:**
- Modify: `src/claude.ts:132` (`RunPhaseInput.maxBudgetUsd`) and `:196-203` (args)
- Test: `tests/unit/claude-run.test.ts`

- [ ] **Step 1: Write the failing test** (add inside the existing top-level `describe` of `tests/unit/claude-run.test.ts`, next to "passes --resume when a session id is given"; it uses the same `FAKE`, `tempDir`, `join` and `runPhase` imports the file already has)

```ts
  test("passes no --max-budget-usd when there is no cap", async () => {
    const t = tempDir();
    try {
      for (const maxBudgetUsd of [undefined, Infinity]) {
        const argsFile = join(t.path, `args-${String(maxBudgetUsd)}.json`);
        await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "default",
          allowedTools: [], timeoutMs: 10_000, maxBudgetUsd, env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
        expect((await Bun.file(argsFile).json()).args).not.toContain("--max-budget-usd");
      }
    } finally { t.cleanup(); }
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/claude-run.test.ts --timeout 30000`
Expected: FAIL (typecheck error on `maxBudgetUsd: undefined`, or the args contain `--max-budget-usd`).

- [ ] **Step 3: Make the cap optional**

In `RunPhaseInput`:

```ts
  /** The session's spending cap. Absent or Infinity: no --max-budget-usd, and the timeout is the only stop. */
  maxBudgetUsd?: number;
```

In `runPhase`, remove `"--max-budget-usd", String(input.maxBudgetUsd),` from the `args` array literal and add after it:

```ts
  if (input.maxBudgetUsd !== undefined && Number.isFinite(input.maxBudgetUsd)) args.push("--max-budget-usd", String(input.maxBudgetUsd));
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/claude-run.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS (the existing test still sees `--max-budget-usd 1`).

- [ ] **Step 5: Commit**

```bash
git add src/claude.ts tests/unit/claude-run.test.ts
git commit -m "feat(claude): a session without a cap runs without --max-budget-usd"
```

---

### Task 4: Budgets are optional in the config, unlimited by default

**Files:**
- Modify: `src/config.ts` (claude and chat schemas; `loadConfig`), `templates/config.yaml:19` and `:49-51`, `src/phases.ts:194`, `src/chat/agents.ts` (`runChatAgent`), `src/chat/orchestrator.ts` (`budgetLeft`, `budgetUsedUp`, `turn`, `doHandoff`), `src/chat/writer.ts:128`
- Test: `tests/unit/budget-config.test.ts` (new), `tests/unit/chat-config.test.ts:22-25`, `tests/unit/chat-orchestrator.test.ts` (the test at about line 323), `tests/unit/phases.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/budget-config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configPath, loadConfig, validateConfig } from "../../src/config";
import { init } from "../../src/init";
import { tempDir, tempGitRepo } from "../helpers";

async function configWith(text: string) {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(t.path), `version: 1\ncommands:\n  test: bun test\n${text}`);
  try { return await loadConfig(t.path); } finally { t.cleanup(); }
}

describe("budgets", () => {
  test("are optional: unset means no limit", async () => {
    const cfg = await configWith("");
    expect(cfg.claude.max_budget_usd).toBeUndefined();
    expect(cfg.claude.max_budget_usd_per_day).toBeUndefined();
    expect(cfg.chat.max_budget_usd_per_session).toBeUndefined();
    expect(cfg.chat.max_budget_usd_per_day).toBeUndefined();
  });

  test("take positive amounts, including the loop's new daily cap", async () => {
    const cfg = await configWith("claude:\n  max_budget_usd: 9\n  max_budget_usd_per_day: 50\nchat:\n  max_budget_usd_per_session: 4\n  max_budget_usd_per_day: 36\n");
    expect([cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session, cfg.chat.max_budget_usd_per_day]).toEqual([9, 50, 4, 36]);
    expect(() => validateConfig({ version: 1, commands: { test: "x" }, claude: { max_budget_usd: 0 } })).toThrow(ConfigError);
  });

  test("init writes them only as comments", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      const text = readFileSync(configPath(repo.path), "utf8");
      expect(text).not.toMatch(/^\s*max_budget_usd/m);
      expect(text).toContain("# max_budget_usd_per_day:");
      const cfg = await loadConfig(repo.path).catch(() => null);
      // A repo with no detected test command has no valid config yet; when it has one, budgets are unset.
      if (cfg) expect(cfg.claude.max_budget_usd).toBeUndefined();
    } finally { repo.cleanup(); }
  });
});
```

Add to `tests/unit/phases.test.ts` (inside the `describe` that holds "a budget failure is not retried"):

```ts
  test("with no claude.max_budget_usd, a session gets no --max-budget-usd", async () => {
    const { repo, ctx, trace } = await setup();
    const argsFile = join(repo.path, ".loopstra", "args.json");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
    expect((await Bun.file(argsFile).json()).args).not.toContain("--max-budget-usd");
    trace.close(); repo.cleanup();
  });
```

In `tests/unit/chat-orchestrator.test.ts`, replace the test "with the default settings, a session holds chat.max_budget_usd_per_session, not the whole day" with these two:

```ts
  test("a session holds at most chat.max_budget_usd_per_session of the day", async () => {
    const r = await chatRepo({ config: "chat:\n  max_budget_usd_per_day: 5\n  max_budget_usd_per_session: 2\n" });
    try {
      // Another conversation's session is running with what a session may hold.
      const t = Trace.open(r.root);
      try { t.phaseStart(CHAT_SLUG, "orchestrator", "agent", 2); } finally { t.close(); }
      await r.answer("orchestrator", 1, turn("answered"));
      const out = sink();
      await new Orchestrator(r.root).handle(message("hi"), out.send);
      expect(out.sent).toEqual(["answered"]);
      const args = r.prompts()[0]!.args;
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
    } finally { r.cleanup(); }
  });

  test("with no budgets set, a session has no cap and nothing is held", async () => {
    const r = await chatRepo();
    try {
      await r.answer("orchestrator", 1, turn("answered"));
      const out = sink();
      await new Orchestrator(r.root).handle(message("hi"), out.send);
      expect(out.sent).toEqual(["answered"]);
      expect(r.prompts()[0]!.args).not.toContain("--max-budget-usd");
      const t = Trace.open(r.root);
      try { expect(t.phases(CHAT_SLUG).map((p) => p.status)).toEqual(["success"]); } finally { t.close(); }
    } finally { r.cleanup(); }
  });
```

In `tests/unit/chat-config.test.ts`, the first test becomes:

```ts
  test("are optional, with no budgets and no bots", async () => {
    const cfg = await configWith("");
    expect(cfg.chat).toEqual({ model: "default", transports: {} });
  });
```

In `tests/unit/phases.test.ts`, the budget note expectation becomes:

```ts
      expect(r.note).toBe("This step hit its spending limit (claude.max_budget_usd). An engineer can raise or remove it with `loopstra setup budgets`.");
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/budget-config.test.ts tests/unit/chat-config.test.ts tests/unit/phases.test.ts tests/unit/chat-orchestrator.test.ts --timeout 30000`
Expected: FAIL (`validateConfig` not exported; defaults still 5 and 2; template still sets `max_budget_usd: 5`; old note text).

- [ ] **Step 3: The schema and `validateConfig` in `src/config.ts`**

In the `claude` object, replace `max_budget_usd: z.number().positive().default(5),` with:

```ts
    /** What one session may spend. Unset: no limit (timeout_minutes still ends a session). */
    max_budget_usd: z.number().positive().optional(),
    /** What the loop's sessions (every change's, not chat's) may spend together since local midnight. Unset: no limit. */
    max_budget_usd_per_day: z.number().positive().optional(),
```

In the `chat` object, replace the two budget lines (and their comments) with:

```ts
  /** What chat turns and writer runs may spend in a day, together. Unset: no limit. */
  max_budget_usd_per_day: z.number().positive().optional(),
  /** What one chat turn or writer run may hold of that, so others can run at the same time. Unset: no limit. */
  max_budget_usd_per_session: z.number().positive().optional(),
```

Split `loadConfig`: move everything from `const result = ConfigSchema.safeParse(raw);` to `return result.data;` into a new exported function and call it:

```ts
/** Checks a parsed config against the schema. Throws a ConfigError listing every problem in plain words. */
export function validateConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const where = i.path.length ? i.path.join(".") : "(top level)";
      if (i.code === "unrecognized_keys" && where === "gates" && i.keys.includes("intent")) {
        return "gates.intent: remove this line; a person always accepts a change by setting its status to accepted.";
      }
      if (i.code === "unrecognized_keys") return `${where}: unknown key(s) ${i.keys.join(", ")}`;
      return `${where}: ${i.message}`;
    });
    throw new ConfigError(`loopstra/config.yaml has problems:\n- ${lines.join("\n- ")}`);
  }
  return result.data;
}
```

and the end of `loadConfig` becomes `return validateConfig(raw);`.

- [ ] **Step 4: The template**

In `templates/config.yaml`, replace the line `  max_budget_usd: 5` with:

```yaml
  # Spending limits, in US dollars. Unset means no limit; timeout_minutes still ends a session.
  # `loopstra setup budgets` sets them in minutes or dollars.
  # max_budget_usd: 9            # what one session may spend
  # max_budget_usd_per_day: 50   # what the loop's sessions may spend together in a day
```

and replace the two chat budget lines with:

```yaml
  # max_budget_usd_per_day: 36     # chat turns and writer runs together in a day; unset means no limit
  # max_budget_usd_per_session: 4  # what one turn or writer run may spend; unset means no limit
```

- [ ] **Step 5: The runtime treats unset as no limit**

`src/phases.ts`: import `limitOf` from `./budget`, and in `attempt` change `maxBudgetUsd: ctx.cfg.claude.max_budget_usd,` to `maxBudgetUsd: limitOf(ctx.cfg.claude.max_budget_usd),` (Task 5 replaces this line again). Change the budget case of `ownerNote`:

```ts
    case "budget": return "This step hit its spending limit (claude.max_budget_usd). An engineer can raise or remove it with `loopstra setup budgets`.";
```

`src/chat/agents.ts`, in `runChatAgent`, import `limitOf` from `../budget` and replace the reservation and the `why` line:

```ts
  const day = limitOf(o.cfg.chat.max_budget_usd_per_day);
  const held = o.trace.phaseStartWithin(CHAT_SLUG, o.name, "agent", {
    since: startOfToday(), limitUsd: day,
    capUsd: Math.min(o.capUsd, limitOf(o.cfg.claude.max_budget_usd), limitOf(o.cfg.chat.max_budget_usd_per_session)), floorUsd: MIN_SESSION_USD,
  });
  if (!held) {
    const why = day - chatSpentToday(o.trace) < MIN_SESSION_USD ? "today" : "held";
```

(the rest of that `if` stays). `maxBudgetUsd: held.heldUsd` stays: Infinity means no flag (Task 3). Update the `capUsd` doc comment on `ChatAgentInput` to: `/** The most this one session may spend (Infinity: no cap of its own); it also never holds more than is left of the day's chat budget. */`

`src/chat/orchestrator.ts` (import `limitOf` from `../budget`):

```ts
  private budgetLeft(cfg: Config, trace: Trace): number {
    return limitOf(cfg.chat.max_budget_usd_per_day) - chatSpentToday(trace);
  }

  private budgetUsedUp(cfg: Config, why: "today" | "held" = "today"): string {
    if (why === "held") return "Other conversations are using what is left of today's chat budget right now. Please try again in a few minutes.";
    return `I have used today's chat budget ($${(cfg.chat.max_budget_usd_per_day ?? 0).toFixed(2)}), so I cannot answer until tomorrow. An engineer can raise or remove the limit with \`loopstra setup budgets\`.`;
  }
```

In `turn`: `const capUsd = limitOf(cfg.claude.max_budget_usd);`. In `doHandoff`: `maxBudgetUsd: limitOf(cfg.claude.max_budget_usd),` and the precheck message becomes `I have used today's chat budget, so I cannot write this up until tomorrow. Say yes again then, or an engineer can raise or remove the limit with \`loopstra setup budgets\`.`

`src/chat/writer.ts`, the "today" problem text becomes `"Today's chat budget is used up; say yes again tomorrow, or an engineer can raise or remove the limit with `loopstra setup budgets`."` (as a template string with escaped backticks).

Search for other uses of the changed sentences in tests and update them to the new wording: `grep -rn "raise chat.max_budget_usd_per_day\|may need to raise the limit" tests src`.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/unit/budget-config.test.ts tests/unit/chat-config.test.ts tests/unit/phases.test.ts tests/unit/chat-orchestrator.test.ts tests/unit/chat-writer.test.ts tests/unit/templates.test.ts tests/unit/init.test.ts --timeout 30000` then `bun run typecheck` then `bun run test`
Expected: all pass. If `templates.test.ts` asserts on the old budget lines, update it to the new comment lines.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/phases.ts src/chat templates/config.yaml tests/unit
git commit -m "feat(budget): budgets are optional and unlimited by default"
```

---

### Task 5: The loop's daily cap

**Files:**
- Modify: `src/budget.ts` (the loop's day), `src/stop.ts` (new class), `src/phases.ts` (`attempt`), `src/git.ts:60`, `src/scheduler.ts` (tick: before picking, and the catch; `runStepGuarded`), `src/attention.ts` (after the pause item)
- Test: `tests/unit/loop-budget.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/loop-budget.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { attention } from "../../src/attention";
import { CHAT_SLUG, loopDayNote } from "../../src/budget";
import { loadConfig } from "../../src/config";
import { readIntent } from "../../src/intents";
import { agentPhase } from "../../src/phases";
import { tick } from "../../src/scheduler";
import { LoopBudgetReached } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { setupRepo } from "../helpers";

function spent(trace: Trace, slug: string, usd: number): void {
  const seq = trace.phaseStart(slug, "build", "agent");
  trace.phaseEnd(slug, seq, { status: "success", costUsd: usd });
}

const INTAKE = { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} } as const;

describe("the loop's daily budget", () => {
  test("a phase past it does not start; chat's spending does not count", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      spent(trace, CHAT_SLUG, 5);
      expect((await agentPhase(ctx, INTAKE)).ok).toBe(true);
      spent(trace, "other", 1);
      await expect(agentPhase(ctx, INTAKE)).rejects.toBeInstanceOf(LoopBudgetReached);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a session holds what is left of the day as its cap", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 3\n" });
    try {
      const argsFile = join(repo.path, ".loopstra", "args.json");
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      spent(trace, "other", 1);
      await agentPhase(ctx, { ...INTAKE, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
      const args: string[] = (await Bun.file(argsFile).json()).args;
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("the tick waits without picking a change, and the attention list says why", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      spent(trace, "other", 1);
      const cfg = await loadConfig(repo.path);
      const out = await tick(repo.path);
      expect(out.paused).toBe(loopDayNote(cfg));
      expect(out.picked).toBeNull();
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("accepted");
      const items = await attention(repo.path, cfg, trace);
      expect(items.find((i) => i.kind === "paused")?.what).toBe(loopDayNote(cfg));
    } finally { trace.close(); repo.cleanup(); }
  });

  test("tomorrow it starts again", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      // Yesterday's spending: a phase that started before local midnight.
      const seq = trace.phaseStart("other", "build", "agent");
      trace.phaseEnd("other", seq, { status: "success", costUsd: 1 });
      const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
      (trace as unknown as { db: { run: (sql: string, args: unknown[]) => void } }).db.run("UPDATE phases SET started = ? WHERE slug = 'other'", [yesterday]);
      expect((await agentPhase(ctx, INTAKE)).ok).toBe(true);
    } finally { trace.close(); repo.cleanup(); }
  });
});
```

(If `tick` is not exported from `src/scheduler.ts`, check what the integration tests import: `grep -n "tick" tests/integration/chat.test.ts`, and use that. If `trace.db` is not a field called `db`, read `src/trace.ts` for its name; the test only needs to move one row's `started` back a day and a half.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/loop-budget.test.ts --timeout 30000`
Expected: FAIL, `LoopBudgetReached` is not exported.

- [ ] **Step 3: The loop's day in `src/budget.ts`**

Add `import type { Config } from "./config";` and, after `loopSpentToday`:

```ts
/** claude.max_budget_usd_per_day is set and less than a session's floor of it is left. */
export function loopDayUsedUp(cfg: Config, trace: Trace, now = new Date()): boolean {
  const day = cfg.claude.max_budget_usd_per_day;
  return day !== undefined && day - loopSpentToday(trace, now) < MIN_SESSION_USD;
}

/** Why the loop is waiting, for the owner: the attention list, `status`, the tick's pause. */
export function loopDayNote(cfg: Config): string {
  const day = cfg.claude.max_budget_usd_per_day ?? 0;
  return `The loop has used today's budget (claude.max_budget_usd_per_day, $${day.toFixed(2)}). It resumes after midnight, or an engineer can change it with \`loopstra setup budgets\`.`;
}
```

- [ ] **Step 3b: `LoopBudgetReached` in `src/stop.ts`** (after `AssistantUnavailable`)

```ts
/**
 * The loop's daily budget (claude.max_budget_usd_per_day) is used up. Like an unavailable assistant,
 * it is not the change's fault: the step ends, the change keeps its status, and the loop waits until
 * local midnight (or a raised limit).
 */
export class LoopBudgetReached extends Error {
  constructor() {
    super("the loop's daily budget is used up");
    this.name = "LoopBudgetReached";
  }
}
```

- [ ] **Step 4: A loop phase holds its share of the day (`src/phases.ts`)**

Import `CHAT_SLUG, limitOf, MIN_SESSION_USD, startOfToday` from `./budget` and `LoopBudgetReached` from `./stop` (with the existing `./stop` imports). Add above `attempt`:

```ts
/**
 * Starts a loop phase's row. With claude.max_budget_usd_per_day set, the phase holds what it may
 * spend of what is left of the loop's day (every change together, not chat), and does not start when
 * too little is left. `capUsd` is the session's cap (Infinity: none).
 */
function startPhase(ctx: StepContext, traceName: string): { seq: number; capUsd: number } {
  const c = ctx.cfg.claude;
  if (c.max_budget_usd_per_day === undefined) return { seq: ctx.trace.phaseStart(ctx.slug, traceName, "agent"), capUsd: limitOf(c.max_budget_usd) };
  const held = ctx.trace.phaseStartWithin(ctx.slug, traceName, "agent", {
    since: startOfToday(), limitUsd: c.max_budget_usd_per_day, capUsd: limitOf(c.max_budget_usd), floorUsd: MIN_SESSION_USD, pool: { except: CHAT_SLUG },
  });
  if (!held) throw new LoopBudgetReached();
  return { seq: held.seq, capUsd: held.heldUsd };
}
```

In `attempt`, replace `const seq = ctx.trace.phaseStart(ctx.slug, traceName, "agent");` with `const { seq, capUsd } = startPhase(ctx, traceName);`, and `maxBudgetUsd: limitOf(ctx.cfg.claude.max_budget_usd),` with `maxBudgetUsd: capUsd,`.

In `agentPhase`, the retry: `LoopBudgetReached` is thrown, not returned, so it already skips the retry. Nothing to change.

- [ ] **Step 5: Pass it through like an unavailable assistant**

`src/git.ts:60`: add `|| e instanceof LoopBudgetReached` to the rethrow condition, and import it from `./stop`.

`src/scheduler.ts`: import `LoopBudgetReached` from `./stop` and `loopDayNote, loopDayUsedUp` from `./budget`. In `runStepGuarded`, the first line of the catch becomes:

```ts
    if (e instanceof StopRequested || e instanceof AssistantUnavailable || e instanceof LoopBudgetReached) throw e;
```

In `tick`, right after the `activePause` block (`if (pause) { ... return out; }`), add:

```ts
    // The loop's day is spent (claude.max_budget_usd_per_day): nothing starts until midnight.
    if (loopDayUsedUp(cfg, trace)) {
      out.paused = loopDayNote(cfg);
      return out;
    }
```

In the tick's `catch`, after the `AssistantUnavailable` line, add:

```ts
    if (e instanceof LoopBudgetReached) {
      // Reached partway through a step: it keeps its status and resumes when there is budget again.
      trace.event(out.picked ?? "_loop", "pause", { reason: loopDayNote(cfg) });
      out.paused = loopDayNote(cfg);
      return out;
    }
```

(`cfg` is declared before the `try`, since the `finally` uses it. If it is not, move this check to where `cfg` is in scope.)

`src/attention.ts`: import `loopDayNote, loopDayUsedUp` from `./budget`, and after `if (pause) add("paused", ...)` add:

```ts
  if (cfg && loopDayUsedUp(cfg, trace, now)) add("paused", null, "Loopstra is paused", loopDayNote(cfg));
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/unit/loop-budget.test.ts tests/unit/phases.test.ts tests/integration/scheduler.test.ts --timeout 30000`, `bun run typecheck`, then `bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/budget.ts src/stop.ts src/phases.ts src/git.ts src/scheduler.ts src/attention.ts tests/unit/loop-budget.test.ts
git commit -m "feat(budget): an optional daily cap for the loop pauses it until midnight"
```

---

### Task 6: `ConfigDocument`: edit `config.yaml` in place

**Files:**
- Create: `src/setup/document.ts`
- Test: `tests/unit/setup-document.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-document.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigError, configPath } from "../../src/config";
import { ConfigDocument } from "../../src/setup/document";
import { tempDir } from "../helpers";

const TEXT = `# Top comment
version: 1
commands:
  test: bun test # the tests
claude:
  timeout_minutes: 30
  max_budget_usd: 5
gates:
  spec: { human: none, agent: true }
`;

function load(text = TEXT) {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  writeFileSync(configPath(t.path), text);
  return { t, doc: ConfigDocument.load(t.path), file: () => readFileSync(configPath(t.path), "utf8") };
}

describe("ConfigDocument", () => {
  test("reads values and collections, and undefined for what is not there", () => {
    const { t, doc } = load();
    try {
      expect(doc.get(["claude", "timeout_minutes"])).toBe(30);
      expect(doc.get(["gates", "spec"])).toEqual({ human: "none", agent: true });
      expect(doc.get(["chat", "model"])).toBeUndefined();
    } finally { t.cleanup(); }
  });

  test("set keeps comments and key order, and a scalar keeps the comment on its line", () => {
    const { t, doc } = load();
    try {
      doc.set(["commands", "test"], "npm test");
      doc.set(["gates", "spec", "human"], "status");
      const text = doc.text();
      expect(text).toStartWith("# Top comment\n");
      expect(text).toMatch(/test: npm test\s+# the tests/);
      expect(text.indexOf("version")).toBeLessThan(text.indexOf("commands"));
      expect(parse(text).gates.spec).toEqual({ human: "status", agent: true });
    } finally { t.cleanup(); }
  });

  test("set makes the maps it needs, and an id that looks like a number stays a string", () => {
    const { t, doc } = load();
    try {
      doc.set(["chat", "transports", "discord", "channel"], "123456789012345678");
      expect(parse(doc.text()).chat.transports.discord.channel).toBe("123456789012345678");
    } finally { t.cleanup(); }
  });

  test("put adds a key only when it differs from the default, but updates one that is there", () => {
    const { t, doc } = load();
    try {
      doc.put(["gates", "plan", "human"], "none", "none");
      expect(doc.get(["gates", "plan"])).toBeUndefined();
      doc.put(["gates", "spec", "agent"], true, true);
      expect(doc.get(["gates", "spec", "agent"])).toBe(true);
      doc.put(["gates", "spec", "agent"], false, true);
      expect(doc.get(["gates", "spec", "agent"])).toBe(false);
    } finally { t.cleanup(); }
  });

  test("clear removes a key and ignores one that is not there", () => {
    const { t, doc } = load();
    try {
      doc.clear(["claude", "max_budget_usd"]);
      doc.clear(["nothing", "here"]);
      expect(doc.get(["claude", "max_budget_usd"])).toBeUndefined();
      expect(doc.get(["claude", "timeout_minutes"])).toBe(30);
    } finally { t.cleanup(); }
  });

  test("save writes only when something changed", () => {
    const { t, doc, file } = load();
    try {
      expect(doc.save()).toBe(false);
      expect(file()).toBe(TEXT);
      doc.set(["claude", "timeout_minutes"], 45);
      expect(doc.save()).toBe(true);
      expect(ConfigDocument.load(t.path).get(["claude", "timeout_minutes"])).toBe(45);
    } finally { t.cleanup(); }
  });

  test("save refuses a config that would not load, and writes nothing", () => {
    const { t, doc, file } = load();
    try {
      doc.set(["claude", "timeout_minutes"], -1);
      expect(() => doc.save()).toThrow(ConfigError);
      expect(file()).toBe(TEXT);
    } finally { t.cleanup(); }
  });

  test("a file that is not YAML is refused when loaded", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "loopstra"), { recursive: true });
      writeFileSync(configPath(t.path), "version: [1\n");
      expect(() => ConfigDocument.load(t.path)).toThrow(ConfigError);
    } finally { t.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-document.test.ts --timeout 30000`
Expected: FAIL, cannot find module `../../src/setup/document`.

- [ ] **Step 3: Write `src/setup/document.ts`**

```ts
import { readFileSync } from "node:fs";
import { isCollection, isScalar, parseDocument, type Document } from "yaml";
import { ConfigError, configPath, validateConfig, type Config } from "../config";
import { writeFileAtomic } from "../fsutil";

/** Where a value is in the config, like ["claude", "max_budget_usd"]. */
export type Path = readonly (string | number)[];

/**
 * loopstra/config.yaml as a YAML document: edits keep its comments and key order. Nothing is written
 * until save(), and save() refuses a config that would not load.
 */
export class ConfigDocument {
  private dirty = false;

  private constructor(private readonly path: string, private readonly doc: Document) {}

  static load(root: string): ConfigDocument {
    const path = configPath(root);
    const doc = parseDocument(readFileSync(path, "utf8"));
    if (doc.errors.length) throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
    return new ConfigDocument(path, doc);
  }

  /** The value at `path` as plain data (maps and lists too), or undefined. */
  get(path: Path): unknown {
    const v = this.doc.getIn(path);
    return isCollection(v) ? v.toJSON() : v;
  }

  set(path: Path, value: unknown): void {
    if (JSON.stringify(this.get(path)) === JSON.stringify(value)) return;
    const node = this.doc.getIn(path, true);
    // A scalar is changed in place, so a comment on its line stays with it.
    if (isScalar(node) && (value === null || typeof value !== "object")) node.value = value;
    else this.doc.setIn(path, this.doc.createNode(value));
    this.dirty = true;
  }

  /**
   * Sets a value, except that a key that is not in the file is only added when the value differs
   * from its default: the file says what someone chose, and later default changes still reach it.
   */
  put(path: Path, value: unknown, fallback: unknown): void {
    if (this.get(path) === undefined && JSON.stringify(value) === JSON.stringify(fallback)) return;
    this.set(path, value);
  }

  clear(path: Path): void {
    if (!this.doc.hasIn(path)) return;
    this.doc.deleteIn(path);
    this.dirty = true;
  }

  /** The config these edits make, checked the way loading checks it. Throws ConfigError. */
  validate(): Config {
    return validateConfig(this.doc.toJS() ?? {});
  }

  /** Writes the file when anything changed (true), after validating. Throws ConfigError, writing nothing. */
  save(): boolean {
    this.validate();
    if (!this.dirty) return false;
    writeFileAtomic(this.path, this.text());
    return true;
  }

  text(): string {
    return String(this.doc);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/setup-document.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS. If "a scalar keeps the comment on its line" fails because the `yaml` library moves the comment, look at the output of `doc.text()`; the comment must still be on the `test:` line (spacing may differ).

- [ ] **Step 5: Commit**

```bash
git add src/setup/document.ts tests/unit/setup-document.test.ts
git commit -m "feat(setup): edit config.yaml in place, keeping its comments"
```

---

### Task 7: Prompts: a terminal one and a no-questions one

**Files:**
- Create: `src/setup/prompt.ts`, `tests/setup-helpers.ts`
- Test: `tests/unit/setup-prompt.test.ts`

- [ ] **Step 1: The test helper `tests/setup-helpers.ts`** (later tasks add to it)

```ts
import { Readable, Writable } from "node:stream";
import { StreamPrompt } from "../src/setup/prompt";

/** A StreamPrompt that reads these answers, one per line, and records what it showed. */
export function scripted(...answers: string[]): { prompt: StreamPrompt; shown: () => string } {
  let shown = "";
  const output = new Writable({ write(chunk, _encoding, done) { shown += String(chunk); done(); } });
  const prompt = new StreamPrompt(Readable.from(answers.map((a) => `${a}\n`)), output);
  return { prompt, shown: () => shown };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/unit/setup-prompt.test.ts
import { describe, expect, test } from "bun:test";
import { amountText, DefaultsPrompt, parseAmount, SetupStopped } from "../../src/setup/prompt";
import { scripted } from "../setup-helpers";

describe("amounts", () => {
  test("times at the rate, dollars as given, or none", () => {
    expect(parseAmount("30m", 0.2)).toBe(6);
    expect(parseAmount("45 min", 0.2)).toBe(9);
    expect(parseAmount("2h", 0.2)).toBe(24);
    expect(parseAmount("$6", 0.2)).toBe(6);
    expect(parseAmount("6.5", 0.2)).toBe(6.5);
    expect(parseAmount("None", 0.2)).toBe("none");
    for (const bad of ["", "0", "0m", "-3", "six", "$", "3 days"]) expect(parseAmount(bad, 0.2)).toBeNull();
  });

  test("are shown in dollars and minutes", () => {
    expect(amountText(9, 0.2)).toBe("$9.00 (about 45 min)");
    expect(amountText("none", 0.2)).toBe("no limit");
  });
});

describe("a prompt over streams", () => {
  test("Enter takes the suggestion; an answer replaces it", async () => {
    const { prompt, shown } = scripted("", "npm test");
    expect(await prompt.text("Test command", { suggestion: "bun test" })).toBe("bun test");
    expect(await prompt.text("Test command", { suggestion: "bun test" })).toBe("npm test");
    expect(shown()).toContain("Test command [bun test]: ");
  });

  test("an optional answer can be emptied with -", async () => {
    const { prompt } = scripted("-", "");
    expect(await prompt.text("Lint", { suggestion: "bun run lint", optional: true })).toBe("");
    expect(await prompt.text("Build", { optional: true })).toBe("");
  });

  test("a bad answer is asked again, saying why", async () => {
    const { prompt, shown } = scripted("maybe", "y", "sometimes", "status", "soon", "1h", "bad name", "GOOD_NAME", "", "x");
    expect(await prompt.yesNo("Limits?", false)).toBe(true);
    expect(await prompt.pick("Gate", ["none", "status"] as const, "none")).toBe("status");
    expect(await prompt.amount("Session", { suggestion: "none", ratePerMinute: 0.2 })).toBe(12);
    expect(await prompt.text("Var", { check: (s) => (/^[A-Z_]+$/.test(s) ? null : "Use an environment variable name.") })).toBe("GOOD_NAME");
    expect(await prompt.text("Required")).toBe("x");
    expect(shown()).toContain("Answer y or n.");
    expect(shown()).toContain("Answer one of: none, status.");
    expect(shown()).toContain("Answer a time (30m, 2h), an amount ($6), or none.");
    expect(shown()).toContain("Use an environment variable name.");
    expect(shown()).toContain("An answer is needed.");
  });

  test("several choices: by name, separated by commas; - for none; Enter for the suggestion", async () => {
    const { prompt, shown } = scripted("Slack, terminal", "-", "", "teams");
    const places = ["terminal", "dashboard", "slack", "discord"] as const;
    expect(await prompt.pickMany("Where", places, ["terminal"])).toEqual(["terminal", "slack"]);
    expect(await prompt.pickMany("Where", places, ["terminal"])).toEqual([]);
    expect(await prompt.pickMany("Where", places, ["terminal"])).toEqual(["terminal"]);
    await expect(prompt.pickMany("Where", places, [])).rejects.toBeInstanceOf(SetupStopped);
    expect(shown()).toContain("Not a choice: teams.");
  });

  test("running out of input stops setup", async () => {
    const { prompt } = scripted();
    await expect(prompt.text("Anything")).rejects.toBeInstanceOf(SetupStopped);
  });
});

describe("--defaults", () => {
  test("every question takes its suggestion, without reading anything, and says what it took", async () => {
    const lines: string[] = [];
    const p = new DefaultsPrompt((l) => lines.push(l));
    expect(await p.yesNo("Limits?", false)).toBe(false);
    expect(await p.amount("Session", { suggestion: 9, ratePerMinute: 0.2 })).toBe(9);
    expect(await p.text("Lint", { optional: true })).toBe("");
    expect(await p.pick("Gate", ["none", "status"] as const, "none")).toBe("none");
    expect(await p.pickMany("Where", ["terminal", "dashboard"] as const, ["terminal"])).toEqual(["terminal"]);
    expect(lines).toEqual(["Limits?: no", "Session: $9.00 (about 45 min)", "Lint: (empty)", "Gate: none", "Where: terminal"]);
  });

  test("a question with nothing to suggest stops setup, naming it", async () => {
    const p = new DefaultsPrompt(() => {});
    await expect(p.text("Test command (commands.test)")).rejects.toThrow('--defaults has no answer for "Test command (commands.test)"');
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `bun test tests/unit/setup-prompt.test.ts --timeout 30000`
Expected: FAIL, cannot find module `../../src/setup/prompt`.

- [ ] **Step 4: Write `src/setup/prompt.ts`**

```ts
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Setup ended without saving: input ran out (Ctrl-D), or --defaults had no answer to give. */
export class SetupStopped extends Error {
  constructor(message = "Setup stopped; nothing was saved.") {
    super(message);
    this.name = "SetupStopped";
  }
}

/** A spending limit in US dollars, or no limit. */
export type Amount = number | "none";

/** What setup converts minutes at unless the person gives another rate: about $2 per 10 minutes. */
export const DEFAULT_RATE_PER_MINUTE = 0.2;

export interface TextOptions {
  /** What Enter takes. */
  suggestion?: string;
  /** May be left empty; "-" empties one that has a suggestion. */
  optional?: boolean;
  /** A problem with the answer, in words, or null when it is fine. */
  check?: (answer: string) => string | null;
}

/** How a section asks. `close` ends the input (a terminal prompt stops reading). */
export interface Prompt {
  say(line: string): void;
  text(question: string, o?: TextOptions): Promise<string>;
  yesNo(question: string, suggestion: boolean): Promise<boolean>;
  pick<T extends string>(question: string, choices: readonly T[], suggestion: T): Promise<T>;
  pickMany<T extends string>(question: string, choices: readonly T[], suggestion: readonly T[]): Promise<T[]>;
  amount(question: string, o: { suggestion: Amount; ratePerMinute: number }): Promise<Amount>;
  close(): void;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "30m", "2h", "$6", "6", "none": dollars (times at `ratePerMinute`) or "none"; null when it is none of those. */
export function parseAmount(answer: string, ratePerMinute: number): Amount | null {
  const a = answer.trim().toLowerCase();
  if (a === "none") return "none";
  const time = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(a);
  const usd = /^\$?(\d+(?:\.\d+)?)$/.exec(a);
  const dollars = time ? Number(time[1]) * (time[2]!.startsWith("h") ? 60 : 1) * ratePerMinute : usd ? Number(usd[1]) : NaN;
  const rounded = round2(dollars);
  return rounded > 0 ? rounded : null;
}

/** "$9.00 (about 45 min)", or "no limit". */
export function amountText(a: Amount, ratePerMinute: number): string {
  return a === "none" ? "no limit" : `$${a.toFixed(2)} (about ${Math.round(a / ratePerMinute)} min)`;
}

/** Questions over a stream (a terminal): one line per answer. A bad answer is asked again. */
export class StreamPrompt implements Prompt {
  private readonly rl: Interface;
  private readonly lines: AsyncIterator<string>;

  constructor(input: Readable, private readonly output: Writable) {
    this.rl = createInterface({ input, terminal: false });
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  say(line: string): void {
    this.output.write(`${line}\n`);
  }

  private async answer(question: string, shown: string | undefined): Promise<string> {
    this.output.write(`${question}${shown ? ` [${shown}]` : ""}: `);
    const next = await this.lines.next();
    if (next.done) {
      this.output.write("\n");
      throw new SetupStopped();
    }
    return next.value.trim();
  }

  async text(question: string, o: TextOptions = {}): Promise<string> {
    for (;;) {
      const a = await this.answer(question, o.suggestion);
      if (a === "-" && o.optional) return "";
      const value = a || o.suggestion || "";
      if (!value) {
        if (o.optional) return "";
        this.say("  An answer is needed.");
        continue;
      }
      const problem = o.check?.(value) ?? null;
      if (!problem) return value;
      this.say(`  ${problem}`);
    }
  }

  async yesNo(question: string, suggestion: boolean): Promise<boolean> {
    for (;;) {
      const a = (await this.answer(question, suggestion ? "Y/n" : "y/N")).toLowerCase();
      if (!a) return suggestion;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      this.say("  Answer y or n.");
    }
  }

  async pick<T extends string>(question: string, choices: readonly T[], suggestion: T): Promise<T> {
    for (;;) {
      const a = (await this.answer(`${question} (${choices.join(" / ")})`, suggestion)).toLowerCase();
      if (!a) return suggestion;
      const hit = choices.find((c) => c.toLowerCase() === a);
      if (hit) return hit;
      this.say(`  Answer one of: ${choices.join(", ")}.`);
    }
  }

  async pickMany<T extends string>(question: string, choices: readonly T[], suggestion: readonly T[]): Promise<T[]> {
    for (;;) {
      const a = (await this.answer(`${question} (any of ${choices.join(", ")}, separated by commas; - for none)`, suggestion.join(", ") || "-")).toLowerCase();
      if (!a) return [...suggestion];
      if (a === "-") return [];
      const parts = a.split(",").map((p) => p.trim()).filter(Boolean);
      const unknown = parts.filter((p) => !choices.some((c) => c.toLowerCase() === p));
      if (!unknown.length) return choices.filter((c) => parts.includes(c.toLowerCase()));
      this.say(`  Not a choice: ${unknown.join(", ")}.`);
    }
  }

  async amount(question: string, o: { suggestion: Amount; ratePerMinute: number }): Promise<Amount> {
    for (;;) {
      const a = await this.answer(`${question} (minutes like 30m, dollars like $6, or none)`, amountText(o.suggestion, o.ratePerMinute));
      if (!a) return o.suggestion;
      const v = parseAmount(a, o.ratePerMinute);
      if (v !== null) return v;
      this.say("  Answer a time (30m, 2h), an amount ($6), or none.");
    }
  }

  close(): void {
    this.rl.close();
  }
}

/** --defaults: every question takes its suggestion, and says what it took. */
export class DefaultsPrompt implements Prompt {
  constructor(private readonly out: (line: string) => void) {}

  say(line: string): void {
    this.out(line);
  }

  private took<T>(question: string, shown: string, value: T): T {
    this.out(`${question}: ${shown}`);
    return value;
  }

  async text(question: string, o: TextOptions = {}): Promise<string> {
    if (o.suggestion) return this.took(question, o.suggestion, o.suggestion);
    if (o.optional) return this.took(question, "(empty)", "");
    throw new SetupStopped(`--defaults has no answer for "${question}". Set it in loopstra/config.yaml, or run loopstra setup in a terminal. Nothing was saved.`);
  }

  async yesNo(question: string, suggestion: boolean): Promise<boolean> {
    return this.took(question, suggestion ? "yes" : "no", suggestion);
  }

  async pick<T extends string>(question: string, _choices: readonly T[], suggestion: T): Promise<T> {
    return this.took(question, suggestion, suggestion);
  }

  async pickMany<T extends string>(question: string, _choices: readonly T[], suggestion: readonly T[]): Promise<T[]> {
    return this.took(question, suggestion.join(", ") || "none", [...suggestion]);
  }

  async amount(question: string, o: { suggestion: Amount; ratePerMinute: number }): Promise<Amount> {
    return this.took(question, amountText(o.suggestion, o.ratePerMinute), o.suggestion);
  }

  close(): void {}
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-prompt.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setup/prompt.ts tests/setup-helpers.ts tests/unit/setup-prompt.test.ts
git commit -m "feat(setup): terminal and --defaults prompts, with amounts in minutes or dollars"
```

---

### Task 8: `loopstra setup`: the runner and the command

**Files:**
- Create: `src/setup/types.ts`, `src/setup/sections/index.ts`, `src/setup/index.ts`
- Modify: `src/cli.ts` (HELP and a `setup` case), `tests/setup-helpers.ts`
- Test: `tests/unit/setup.test.ts`

- [ ] **Step 1: `src/setup/types.ts`**

```ts
import type { Config } from "../config";
import type { ConfigDocument } from "./document";
import type { Prompt } from "./prompt";

export interface SetupContext {
  root: string;
  /** The config being edited; nothing is written until every section has asked its questions. */
  doc: ConfigDocument;
  ask: Prompt;
  /** Where token variables are read: process.env (tests pass their own). */
  env: Record<string, string | undefined>;
}

/** One line of a check's report. A failed check never undoes a save. */
export interface Check {
  level: "ok" | "warn" | "fail";
  text: string;
}

/** A part of setup. Sections do not depend on each other. */
export interface Section {
  name: string;
  title: string;
  /** Asks its questions and edits ctx.doc, writing only what changed. */
  ask(ctx: SetupContext): Promise<void>;
  /** Read-only checks against the saved config. */
  check(ctx: SetupContext, cfg: Config): Promise<Check[]>;
}
```

- [ ] **Step 2: `src/setup/sections/index.ts`** (each section task adds its import and entry, in this order: budgets, commands, gates, github, chat, models)

```ts
import type { Section } from "../types";

/** In the order `loopstra setup` asks them. */
export const SECTIONS: Section[] = [];
```

- [ ] **Step 3: Extend `tests/setup-helpers.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../src/config";
import { ConfigDocument } from "../src/setup/document";
import { DefaultsPrompt } from "../src/setup/prompt";
import type { Check, Section } from "../src/setup/types";
import { tempDir } from "./helpers";

/** A folder with only loopstra/config.yaml (no git), for sections that only edit. */
export function configRepo(yaml: string): { root: string; cleanup: () => void; text: () => string } {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  writeFileSync(configPath(t.path), yaml);
  return { root: t.path, cleanup: t.cleanup, text: () => readFileSync(configPath(t.path), "utf8") };
}

/** Runs one section's questions with these answers (or --defaults), saves, and returns the file and what was shown. */
export async function askSection(section: Section, root: string, answers: string[] | "defaults", env: Record<string, string | undefined> = {}): Promise<{ text: string; shown: string }> {
  const doc = ConfigDocument.load(root);
  const lines: string[] = [];
  const s = answers === "defaults" ? null : scripted(...answers);
  const ask = s ? s.prompt : new DefaultsPrompt((l) => lines.push(l));
  try { await section.ask({ root, doc, ask, env }); } finally { ask.close(); }
  doc.save();
  return { text: readFileSync(configPath(root), "utf8"), shown: s ? s.shown() : lines.join("\n") };
}

/** One section's checks against the config on disk. */
export async function checkSection(section: Section, root: string, env: Record<string, string | undefined> = {}): Promise<Check[]> {
  return section.check({ root, doc: ConfigDocument.load(root), ask: new DefaultsPrompt(() => {}), env }, await loadConfig(root));
}
```

(merge these imports with the existing ones at the top of the file).

- [ ] **Step 4: Write the failing tests**

```ts
// tests/unit/setup.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { configPath, NOT_SET_UP } from "../../src/config";
import { NEEDS_TERMINAL, setup } from "../../src/setup";
import { tempDir } from "../helpers";
import { configRepo } from "../setup-helpers";

function io(...answers: string[]) {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  return { input: Readable.from(answers.map((a) => `${a}\n`)), output, text: () => text };
}

const CONFIG = "version: 1\ncommands:\n  test: echo ok\n";

describe("loopstra setup", () => {
  test("outside a set-up folder, it says so", async () => {
    const t = tempDir();
    try {
      const o = io();
      expect(await setup(t.path, { output: o.output, defaults: true })).toBe(1);
      expect(o.text()).toContain(NOT_SET_UP);
    } finally { t.cleanup(); }
  });

  test("without a terminal and without --defaults or --check, it refuses and writes nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, interactive: false })).toBe(1);
      expect(o.text()).toContain(NEEDS_TERMINAL);
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("an unknown section is named, with the ones there are", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, section: "nope", defaults: true })).toBe(1);
      expect(o.text()).toContain("There is no setup section called nope.");
    } finally { r.cleanup(); }
  });

  test("--check with a config that does not load reports why and fails", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\nclaude:\n  timeout_minutes: -1\n");
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, check: true })).toBe(1);
      expect(o.text()).toContain("claude.timeout_minutes");
    } finally { r.cleanup(); }
  });

  test("input that runs out saves nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const code = await setup(r.root, { input: o.input, output: o.output, interactive: true });
      // With no sections yet this saves nothing either way; with sections, the first question ends it.
      expect([0, 1]).toContain(code);
      expect(readFileSync(configPath(r.root), "utf8")).toBe(CONFIG);
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `bun test tests/unit/setup.test.ts --timeout 30000`
Expected: FAIL, cannot find module `../../src/setup`.

- [ ] **Step 6: Write `src/setup/index.ts`**

```ts
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { configPath, loadConfig, NOT_SET_UP, type Config } from "../config";
import { errorText } from "../shell";
import { ConfigDocument } from "./document";
import { DefaultsPrompt, SetupStopped, StreamPrompt, type Prompt } from "./prompt";
import { SECTIONS } from "./sections";
import type { Check, Section, SetupContext } from "./types";

export const NEEDS_TERMINAL = "loopstra setup asks questions: run it in a terminal, or use --defaults (take every suggestion) or --check (only check).";

export interface SetupOptions {
  /** One section by name; all of them when absent. */
  section?: string;
  defaults?: boolean;
  check?: boolean;
  input?: Readable;
  output?: Writable;
  /** Whether a person is at the input; process.stdin.isTTY when absent. */
  interactive?: boolean;
  env?: Record<string, string | undefined>;
}

/**
 * `loopstra setup`: each section asks its questions, the config is checked and saved once (with its
 * comments), then the checks run. Quitting, or a config that would not load, saves nothing. Returns
 * the exit code: 0 once saved (a failed check is listed, not an error), 1 when nothing could be saved;
 * with --check, 1 when any check fails.
 */
export async function setup(root: string, o: SetupOptions = {}): Promise<number> {
  const output = o.output ?? process.stdout;
  const out = (line: string) => { output.write(`${line}\n`); };
  if (!existsSync(configPath(root))) { out(NOT_SET_UP); return 1; }
  const sections = o.section ? SECTIONS.filter((s) => s.name === o.section) : SECTIONS;
  if (o.section && !sections.length) {
    out(`There is no setup section called ${o.section}. Sections: ${SECTIONS.map((s) => s.name).join(", ")}.`);
    return 1;
  }
  const env = o.env ?? process.env;
  if (o.check) return checkOnly(root, sections, env, out);
  if (!o.defaults && !(o.interactive ?? process.stdin.isTTY)) { out(NEEDS_TERMINAL); return 1; }

  let doc: ConfigDocument;
  try { doc = ConfigDocument.load(root); } catch (e) { out(errorText(e)); return 1; }
  const ask: Prompt = o.defaults ? new DefaultsPrompt(out) : new StreamPrompt(o.input ?? process.stdin, output);
  const ctx: SetupContext = { root, doc, ask, env };
  try {
    for (const s of sections) {
      out(`\n${s.title}`);
      await s.ask(ctx);
    }
  } catch (e) {
    if (e instanceof SetupStopped) { out(e.message); return 1; }
    throw e;
  } finally {
    ask.close();
  }

  let cfg: Config;
  try {
    cfg = doc.validate();
    out(doc.save() ? "\nSaved loopstra/config.yaml. Commit it on the main branch so every checkout uses it." : "\nNo changes.");
  } catch (e) {
    out(`\nNot saved: ${errorText(e)}`);
    return 1;
  }
  report(await runChecks(sections, ctx, cfg), out);
  return 0;
}

async function checkOnly(root: string, sections: Section[], env: SetupContext["env"], out: (line: string) => void): Promise<number> {
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch (e) { out(errorText(e)); return 1; }
  const checks = await runChecks(sections, { root, doc: ConfigDocument.load(root), ask: new DefaultsPrompt(() => {}), env }, cfg);
  report(checks, out);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

async function runChecks(sections: Section[], ctx: SetupContext, cfg: Config): Promise<Check[]> {
  const all: Check[] = [];
  for (const s of sections) {
    try { all.push(...(await s.check(ctx, cfg))); }
    catch (e) { all.push({ level: "fail", text: `${s.title}: the check could not run: ${errorText(e)}` }); }
  }
  return all;
}

const MARK: Record<Check["level"], string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function report(checks: Check[], out: (line: string) => void): void {
  if (!checks.length) return;
  out("\nChecks:");
  for (const c of checks) out(`  ${MARK[c.level]}  ${c.text}`);
  const toFix = checks.filter((c) => c.level !== "ok").length;
  if (toFix) out(`\nTo fix: ${toFix} item${toFix > 1 ? "s" : ""} above. Run loopstra setup <section> again once fixed, or loopstra setup --check.`);
}
```

- [ ] **Step 7: The command in `src/cli.ts`**

In `HELP`, after the `init` line:

```
  setup     walk through the settings (setup <section> for one: budgets, commands,
            gates, github, chat, models; --defaults takes every suggestion;
            --check only checks)
```

In `main`, after the `init` case:

```ts
    case "setup": {
      if (!setUp()) return 1;
      const { setup } = await import("./setup");
      return setup(root, { section: rest.find((a) => !a.startsWith("--")), defaults: rest.includes("--defaults"), check: rest.includes("--check") });
    }
```

- [ ] **Step 8: Run the tests**

Run: `bun test tests/unit/setup.test.ts tests/unit/cli.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/setup src/cli.ts tests/setup-helpers.ts tests/unit/setup.test.ts
git commit -m "feat(setup): loopstra setup runs sections, saves once, then checks"
```

---

### Task 9: The budgets section

**Files:**
- Create: `src/setup/sections/budgets.ts`
- Modify: `src/setup/sections/index.ts`
- Test: `tests/unit/setup-budgets.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-budgets.test.ts
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { budgets } from "../../src/setup/sections/budgets";
import { askSection, checkSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

describe("the budgets section", () => {
  test("no: every limit is removed, old defaults included", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 5\n  max_budget_usd_per_session: 2\n`);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["n"]);
      expect(text).not.toContain("max_budget_usd");
      expect(shown).toContain("claude.max_budget_usd: $5 (the old default; the default is now no limit)");
    } finally { r.cleanup(); }
  });

  test("--defaults removes the old template's values and keeps a limit someone chose", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 20\n`);
    try {
      const yaml = parse((await askSection(budgets, r.root, "defaults")).text);
      expect(yaml.claude?.max_budget_usd).toBeUndefined();
      expect(yaml.chat.max_budget_usd_per_day).toBe(20);
    } finally { r.cleanup(); }
  });

  test("--defaults on a config with no limits adds none", async () => {
    const r = configRepo(BASE);
    try {
      expect((await askSection(budgets, r.root, "defaults")).text).toBe(BASE);
    } finally { r.cleanup(); }
  });

  test("yes: each limit in minutes or dollars, at the rate given", async () => {
    const r = configRepo(BASE);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["y", "", "45m", "none", "$4", "3h"]);
      const yaml = parse(text);
      expect(yaml.claude).toEqual({ max_budget_usd: 9 });
      expect(yaml.chat).toEqual({ max_budget_usd_per_session: 4, max_budget_usd_per_day: 36 });
      // The suggestion for a loop session follows timeout_minutes (30 by default): 45 minutes.
      expect(shown).toContain("Suggested: 45m ($9.00)");
    } finally { r.cleanup(); }
  });

  test("a session limit shorter than the timeout is a warning", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\n`);
    try {
      const [c] = await checkSection(budgets, r.root);
      expect(c!.level).toBe("warn");
      expect(c!.text).toContain("runs out before claude.timeout_minutes");
    } finally { r.cleanup(); }
    const none = configRepo(BASE);
    try {
      expect(await checkSection(budgets, none.root)).toEqual([{ level: "ok", text: "Budgets: no limits." }]);
    } finally { none.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-budgets.test.ts --timeout 30000`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/setup/sections/budgets.ts`**

```ts
import { DEFAULT_RATE_PER_MINUTE, parseAmount } from "../prompt";
import type { Section, SetupContext } from "../types";

interface Limit {
  path: string[];
  question: string;
  /** A hint in words ("45m", "none"), from claude.timeout_minutes. */
  suggest: (timeoutMinutes: number) => string;
  /** What the old template wrote: not a choice anyone made. */
  oldDefault?: number;
}

const LIMITS: Limit[] = [
  { path: ["claude", "max_budget_usd"], question: "What may one loop session spend?", suggest: (t) => `${Math.round(t * 1.5)}m`, oldDefault: 5 },
  { path: ["claude", "max_budget_usd_per_day"], question: "What may the loop spend in a day, all changes together?", suggest: () => "none" },
  { path: ["chat", "max_budget_usd_per_session"], question: "What may one chat turn or write-up spend?", suggest: () => "20m", oldDefault: 2 },
  { path: ["chat", "max_budget_usd_per_day"], question: "What may chat spend in a day, everyone together?", suggest: () => "3h", oldDefault: 5 },
];

/** The limit someone chose, or undefined (unset, or the old template's value). */
function chosen(ctx: SetupContext, l: Limit): number | undefined {
  const v = ctx.doc.get(l.path);
  return typeof v === "number" && v !== l.oldDefault ? v : undefined;
}

export const budgets: Section = {
  name: "budgets",
  title: "Budgets",

  async ask(ctx) {
    ctx.ask.say("Spending limits stop a session (or the loop, or chat, for the rest of the day) at an amount. Unset means no limit; claude.timeout_minutes still ends a session.");
    for (const l of LIMITS) {
      const v = ctx.doc.get(l.path);
      const shown = typeof v === "number" ? `$${v}${v === l.oldDefault ? " (the old default; the default is now no limit)" : ""}` : "no limit";
      ctx.ask.say(`  ${l.path.join(".")}: ${shown}`);
    }
    const keep = LIMITS.some((l) => chosen(ctx, l) !== undefined);
    if (!(await ctx.ask.yesNo("Do you want spending limits?", keep))) {
      for (const l of LIMITS) ctx.doc.clear(l.path);
      return;
    }
    const rate = Number(await ctx.ask.text("Dollars per minute of Claude work, to turn minutes into dollars (about $2 per 10 minutes is typical)", {
      suggestion: String(DEFAULT_RATE_PER_MINUTE),
      check: (s) => (Number(s) > 0 ? null : "Answer a number of dollars, like 0.2."),
    }));
    const timeout = Number(ctx.doc.get(["claude", "timeout_minutes"]) ?? 30);
    for (const l of LIMITS) {
      const hint = l.suggest(timeout);
      const usd = parseAmount(hint, rate);
      const question = `${l.question} Suggested: ${typeof usd === "number" ? `${hint} ($${usd.toFixed(2)})` : "none"}.`;
      const a = await ctx.ask.amount(question, { suggestion: chosen(ctx, l) ?? "none", ratePerMinute: rate });
      if (a === "none") ctx.doc.clear(l.path);
      else ctx.doc.set(l.path, a);
    }
  },

  async check(_ctx, cfg) {
    const session = cfg.claude.max_budget_usd;
    const minutes = cfg.claude.timeout_minutes;
    const timeoutUsd = minutes * DEFAULT_RATE_PER_MINUTE;
    if (session !== undefined && session < timeoutUsd) {
      return [{ level: "warn", text: `claude.max_budget_usd ($${session}) runs out before claude.timeout_minutes (${minutes} min, about $${timeoutUsd.toFixed(2)}): a long step stops on the budget first. Raise or remove it with loopstra setup budgets.` }];
    }
    const set = [cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session, cfg.chat.max_budget_usd_per_day].filter((v) => v !== undefined).length;
    return [{ level: "ok", text: set ? `Budgets: ${set} limit${set > 1 ? "s" : ""} set.` : "Budgets: no limits." }];
  },
};
```

- [ ] **Step 4: Register it** in `src/setup/sections/index.ts`:

```ts
import type { Section } from "../types";
import { budgets } from "./budgets";

/** In the order `loopstra setup` asks them. */
export const SECTIONS: Section[] = [budgets];
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-budgets.test.ts tests/unit/setup.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS. (In "yes: each limit", the `yaml.claude` expectation assumes `BASE` has no `claude:` block; `set` creates it.)

- [ ] **Step 6: Commit**

```bash
git add src/setup/sections tests/unit/setup-budgets.test.ts
git commit -m "feat(setup): the budgets section, no limits unless chosen"
```

---

### Task 10: The commands section

**Files:**
- Create: `src/setup/sections/commands.ts`
- Modify: `src/setup/sections/index.ts`
- Test: `tests/unit/setup-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-commands.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { commands } from "../../src/setup/sections/commands";
import { setupRepo } from "../helpers";
import { askSection, checkSection, configRepo } from "../setup-helpers";

describe("the commands section", () => {
  test("suggests what is set, else what init detects; - leaves one out", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\n  lint: old-lint\n");
    try {
      await Bun.write(join(r.root, "package.json"), JSON.stringify({ scripts: { test: "bun test", lint: "eslint .", build: "tsc" } }));
      // Order: test, install, lint, build, run.
      const { text } = await askSection(commands, r.root, ["", "", "-", "", ""]);
      expect(parse(text).commands).toEqual({ test: "echo ok", install: "bun install", build: "bun run build" });
    } finally { r.cleanup(); }
  });

  test("checks claude is found and the test command passes on main, in a throwaway checkout", async () => {
    const { repo, trace } = await setupRepo("draft");
    trace.close();
    try {
      const checks = await checkSection(commands, repo.path);
      expect(checks.map((c) => c.level)).toEqual(["ok", "ok"]);
      expect(checks[1]!.text).toBe("commands.test passes on main.");
      expect(existsSync(join(repo.path, ".loopstra", "setup", "main"))).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a test command that fails on main is a warning with its exit code", async () => {
    const { repo, trace } = await setupRepo("draft", { commands: { test: "exit 3" } });
    trace.close();
    try {
      const [, test] = await checkSection(commands, repo.path);
      expect(test!.level).toBe("warn");
      expect(test!.text).toStartWith("commands.test fails on main (exit 3)");
    } finally { repo.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-commands.test.ts --timeout 30000`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/setup/sections/commands.ts`**

```ts
import { join } from "node:path";
import { resolveClaude } from "../../claude";
import type { Config } from "../../config";
import { Git, withDetachedWorktree } from "../../git";
import { detectCommands } from "../../init";
import { errorText, runCommand } from "../../shell";
import type { Check, Section } from "../types";

const NAMES = ["test", "install", "lint", "build", "run"] as const;

const ABOUT: Record<(typeof NAMES)[number], string> = {
  test: "The one command that runs the tests and exits non-zero when one fails",
  install: "Installs dependencies in a fresh checkout",
  lint: "Runs the linter",
  build: "Builds the project",
  run: "Runs the app",
};

export const commands: Section = {
  name: "commands",
  title: "Commands",

  async ask(ctx) {
    const detected = await detectCommands(ctx.root);
    ctx.ask.say("Build sessions may always run these. Type - to leave one out.");
    for (const n of NAMES) {
      const current = ctx.doc.get(["commands", n]);
      const suggestion = typeof current === "string" && current ? current : detected[n];
      const answer = await ctx.ask.text(`${ABOUT[n]} (commands.${n})`, { suggestion, optional: n !== "test" });
      if (answer) ctx.doc.set(["commands", n], answer);
      else ctx.doc.clear(["commands", n]);
    }
  },

  async check(ctx, cfg) {
    const claude = resolveClaude();
    return [
      claude ? { level: "ok", text: `claude is found (${claude}).` } : { level: "fail", text: "claude is not found on PATH: install Claude Code, or set LOOPSTRA_CLAUDE_EXECUTABLE." },
      await testOnMain(ctx.root, cfg),
    ];
  },
};

/** commands.test (after commands.install) once, in a throwaway checkout of main: the working tree is never touched. */
async function testOnMain(root: string, cfg: Config): Promise<Check> {
  const timeoutMs = cfg.claude.timeout_minutes * 60_000;
  const main = cfg.main_branch;
  try {
    const r = await withDetachedWorktree(new Git(root), join(root, ".loopstra", "setup", "main"), main, async (cwd) => {
      if (cfg.commands.install) {
        const i = await runCommand(cfg.commands.install, cwd, { timeoutMs });
        if (i.code !== 0) return { ...i, what: "commands.install" };
      }
      return { ...(await runCommand(cfg.commands.test, cwd, { timeoutMs })), what: "commands.test" };
    });
    if (r.code === 0) return { level: "ok", text: `commands.test passes on ${main}.` };
    const why = r.timedOut ? "timed out" : `exit ${r.code}`;
    return { level: "warn", text: `${r.what} fails on ${main} (${why})${r.lastLine ? `: ${r.lastLine}` : ""}. Main may be red today; the loop needs it to pass.` };
  } catch (e) {
    return { level: "warn", text: `commands.test could not run on ${main}: ${errorText(e)}` };
  }
}
```

- [ ] **Step 4: Register it**: `import { commands } from "./commands";` and `export const SECTIONS: Section[] = [budgets, commands];`

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-commands.test.ts tests/unit/setup.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS. (`setupRepo` sets `LOOPSTRA_CLAUDE_EXECUTABLE` to the fake claude, so `resolveClaude()` finds it.)

- [ ] **Step 6: Commit**

```bash
git add src/setup/sections tests/unit/setup-commands.test.ts
git commit -m "feat(setup): the commands section, checking the tests on main"
```

---

### Task 11: The gates section

**Files:**
- Create: `src/setup/sections/gates.ts`
- Modify: `src/setup/sections/index.ts`
- Test: `tests/unit/setup-gates.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-gates.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configPath, loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { gates } from "../../src/setup/sections/gates";
import { tempGitRepo } from "../helpers";
import { askSection, configRepo } from "../setup-helpers";

describe("the gates section", () => {
  test("sets a person and the agent reviewer on spec, plan and done, in the template's own lines", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/package.json`, JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      // spec: status, no agent; plan: as is; done: status, as is.
      await askSection(gates, repo.path, ["status", "n", "", "", "status", ""]);
      const cfg = await loadConfig(repo.path);
      expect(cfg.gates.spec).toEqual({ human: "status", agent: false });
      expect(cfg.gates.plan).toEqual({ human: "none", agent: true });
      expect(cfg.gates.done).toEqual({ human: "status", agent: true });
      expect(readFileSync(configPath(repo.path), "utf8")).toContain("# Gates between stages.");
    } finally { repo.cleanup(); }
  });

  test("on a config without gates, the defaults add nothing", async () => {
    const base = "version: 1\ncommands:\n  test: echo ok\n";
    const r = configRepo(base);
    try {
      expect((await askSection(gates, r.root, "defaults")).text).toBe(base);
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-gates.test.ts --timeout 30000`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/setup/sections/gates.ts`**

```ts
import type { Section } from "../types";

const GATES = [
  { gate: "spec", what: "the spec (what will be built)" },
  { gate: "plan", what: "the plan (how it will be built)" },
  { gate: "done", what: "the result after merging" },
] as const;

export const gates: Section = {
  name: "gates",
  title: "Gates",

  async ask(ctx) {
    ctx.ask.say("A person always accepts a change (draft to accepted). After that, a step can wait for a person (status: they set the status line) or go on by itself (none). The merge gate is under github.");
    for (const { gate, what } of GATES) {
      const human = await ctx.ask.pick(`Does a person approve ${what}?`, ["none", "status"] as const, ctx.doc.get(["gates", gate, "human"]) === "status" ? "status" : "none");
      ctx.doc.put(["gates", gate, "human"], human, "none");
      const agent = await ctx.ask.yesNo(`Does an independent agent review ${what}?`, ctx.doc.get(["gates", gate, "agent"]) !== false);
      ctx.doc.put(["gates", gate, "agent"], agent, true);
    }
  },

  async check() {
    return [];
  },
};
```

- [ ] **Step 4: Register it**: `[budgets, commands, gates]`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-gates.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setup/sections tests/unit/setup-gates.test.ts
git commit -m "feat(setup): the gates section"
```

---

### Task 12: The github section

**Files:**
- Create: `src/setup/sections/github.ts`
- Modify: `src/setup/sections/index.ts`
- Test: `tests/unit/setup-github.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-github.test.ts
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { github } from "../../src/setup/sections/github";
import { run, tempDir, tempGitRepo, withEnv } from "../helpers";
import { askSection, checkSection } from "../setup-helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));
const CONFIG = "version: 1\ncommands:\n  test: echo ok\n";

async function repoWithRemote() {
  const repo = await tempGitRepo();
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  await run(["git", "remote", "add", "origin", remote.path], repo.path);
  await Bun.write(`${repo.path}/loopstra/config.yaml`, CONFIG);
  return { path: repo.path, cleanup: () => { repo.cleanup(); remote.cleanup(); } };
}

describe("the github section", () => {
  test("sets how a change is merged and the method", async () => {
    const r = await repoWithRemote();
    try {
      const { text, shown } = await askSection(github, r.path, ["pr", "merge"]);
      expect(parse(text).gates.merge).toEqual({ human: "pr", method: "merge" });
      expect(shown).toContain("This repository pushes to origin:");
    } finally { r.cleanup(); }
  });

  test("with a remote: the remote answers and gh is signed in; signed out fails", async () => {
    const r = await repoWithRemote();
    try {
      await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "0" }, async () => {
        expect((await checkSection(github, r.path)).map((c) => c.level)).toEqual(["ok", "ok"]);
      });
      await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "1" }, async () => {
        const [, gh] = await checkSection(github, r.path);
        expect(gh).toEqual({ level: "fail", text: "gh is not signed in (or not installed): run gh auth login. With a remote, Loopstra merges through pull requests." });
      });
    } finally { r.cleanup(); }
  });

  test("without a remote: fine, unless merges are set to go through pull requests", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/loopstra/config.yaml`, CONFIG);
      expect(await checkSection(github, repo.path)).toEqual([{ level: "ok", text: "No git remote: changes merge locally." }]);
      await Bun.write(`${repo.path}/loopstra/config.yaml`, `${CONFIG}gates:\n  merge:\n    human: pr\n`);
      expect((await checkSection(github, repo.path))[0]!.level).toBe("fail");
    } finally { repo.cleanup(); }
  });
});
```

(`withEnv` is in `tests/helpers.ts`. The `GitHub` class reads `LOOPSTRA_GH_EXECUTABLE` when constructed, and the fake gh reads `LOOPSTRA_FAKE_GH_SIGNED_OUT` from the environment it inherits.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-github.test.ts --timeout 30000`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/setup/sections/github.ts`**

```ts
import { Git } from "../../git";
import { GitHub } from "../../github";
import type { Check, Section } from "../types";

export const github: Section = {
  name: "github",
  title: "GitHub and merging",

  async ask(ctx) {
    const remote = await new Git(ctx.root).remoteName();
    ctx.ask.say(remote
      ? `This repository pushes to ${remote}: each change goes up as a pull request, and its checks must pass before it merges.`
      : "This repository has no git remote, so changes merge locally after the same checks.");
    ctx.ask.say("  none: merge on its own; status: a person sets merge-approved first; pr: a person approves the pull request first.");
    const current = ctx.doc.get(["gates", "merge", "human"]);
    const human = await ctx.ask.pick("Who approves a merge?", ["none", "status", "pr"] as const, current === "pr" || current === "status" ? current : "none");
    if (human === "pr" && !remote) ctx.ask.say("  Pull requests need a git remote on GitHub: add one before starting the loop.");
    ctx.doc.put(["gates", "merge", "human"], human, "none");
    const method = await ctx.ask.pick("Merge method", ["squash", "merge"] as const, ctx.doc.get(["gates", "merge", "method"]) === "merge" ? "merge" : "squash");
    ctx.doc.put(["gates", "merge", "method"], method, "squash");
  },

  async check(ctx, cfg) {
    const git = new Git(ctx.root);
    const remote = await git.remoteName();
    if (!remote) {
      return [cfg.gates.merge.human === "pr"
        ? { level: "fail", text: "gates.merge.human is pr, but there is no git remote." }
        : { level: "ok", text: "No git remote: changes merge locally." }];
    }
    const checks: Check[] = [];
    const reach = await git.run(["ls-remote", "--heads", remote], true);
    const why = reach.err.trim().split(/\r?\n/).at(-1) ?? "";
    checks.push(reach.code === 0 ? { level: "ok", text: `git remote ${remote} answers.` } : { level: "fail", text: `git remote ${remote} could not be reached${why ? `: ${why}` : ""}.` });
    checks.push(await new GitHub(ctx.root).signedIn()
      ? { level: "ok", text: "gh is signed in." }
      : { level: "fail", text: "gh is not signed in (or not installed): run gh auth login. With a remote, Loopstra merges through pull requests." });
    return checks;
  },
};
```

- [ ] **Step 4: Register it**: `[budgets, commands, gates, github]`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-github.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setup/sections tests/unit/setup-github.test.ts
git commit -m "feat(setup): the github section, checking the remote and gh"
```

---

### Task 13: The chat section

**Files:**
- Create: `src/setup/sections/chat.ts`
- Modify: `src/setup/sections/index.ts`
- Test: `tests/unit/setup-chat.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-chat.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { DISCORD_API_ENV } from "../../src/chat/transports/discord";
import { SLACK_API_ENV } from "../../src/chat/transports/slack";
import { chat } from "../../src/setup/sections/chat";
import { askSection, checkSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

// A Slack and Discord that accept the token "good" only.
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      const url = new URL(req.url);
      if (url.pathname === "/slack/auth.test") return Response.json(auth === "Bearer good" ? { ok: true, user: "loopstra", team: "Acme" } : { ok: false, error: "invalid_auth" });
      if (url.pathname === "/discord/users/@me") return auth === "Bot good" ? Response.json({ username: "loopstra" }) : new Response("401: Unauthorized", { status: 401 });
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
const api = () => ({ [SLACK_API_ENV]: `http://127.0.0.1:${server.port}/slack`, [DISCORD_API_ENV]: `http://127.0.0.1:${server.port}/discord` });

describe("the chat section", () => {
  test("only the bots chosen are asked about; one not chosen is removed", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    discord:\n      channel: "111"\n`);
    try {
      // Places; Slack: app token var, bot token var, channel, allow, acceptors, announce_to.
      const { text, shown } = await askSection(chat, r.root, ["terminal, slack", "", "", "C123", "U1, U2", "-", "C999"]);
      expect(parse(text).chat.transports).toEqual({ slack: { channel: "C123", allow: ["U1", "U2"], announce_to: "C999" } });
      expect(shown).toContain("Terminal: run loopstra chat.");
    } finally { r.cleanup(); }
  });

  test("--defaults keeps the bots there are, as they are", async () => {
    const yaml = `${BASE}chat:\n  transports:\n    discord:\n      channel: "111"\n      acceptors: ["9"]\n`;
    const r = configRepo(yaml);
    try {
      expect(parse((await askSection(chat, r.root, "defaults")).text).chat.transports).toEqual({ discord: { channel: "111", acceptors: ["9"] } });
    } finally { r.cleanup(); }
  });

  test("a token variable must be a variable name", async () => {
    const r = configRepo(BASE);
    try {
      const { shown } = await askSection(chat, r.root, ["discord", "xoxb-oops", "MY_TOKEN", "222", "", "", ""]);
      expect(shown).toContain("Answer the name of an environment variable");
    } finally { r.cleanup(); }
  });

  test("checks: unset variables, a refused token, and a good one", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    slack:\n      channel: C1\n    discord:\n      channel: "1"\n`);
    try {
      const unset = await checkSection(chat, r.root, { ...api() });
      expect(unset).toEqual([
        { level: "fail", text: "Slack: LOOPSTRA_SLACK_APP_TOKEN and LOOPSTRA_SLACK_BOT_TOKEN are not set." },
        { level: "fail", text: "Discord: LOOPSTRA_DISCORD_TOKEN is not set." },
      ]);
      const bad = await checkSection(chat, r.root, { ...api(), LOOPSTRA_SLACK_APP_TOKEN: "x", LOOPSTRA_SLACK_BOT_TOKEN: "bad", LOOPSTRA_DISCORD_TOKEN: "bad" });
      expect(bad.map((c) => c.text)).toEqual(["Slack: the bot token was refused (invalid_auth).", "Discord: the bot token was refused (HTTP 401)."]);
      const good = await checkSection(chat, r.root, { ...api(), LOOPSTRA_SLACK_APP_TOKEN: "x", LOOPSTRA_SLACK_BOT_TOKEN: "good", LOOPSTRA_DISCORD_TOKEN: "good" });
      expect(good).toEqual([{ level: "ok", text: "Slack: signed in as loopstra in Acme." }, { level: "ok", text: "Discord: signed in as loopstra." }]);
    } finally { r.cleanup(); }
  });

  test("no bots: nothing to check", async () => {
    const r = configRepo(BASE);
    try {
      expect(await checkSection(chat, r.root)).toEqual([{ level: "ok", text: "Chat: the terminal and the dashboard only (no bots)." }]);
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-chat.test.ts --timeout 30000`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/setup/sections/chat.ts`**

```ts
import { DISCORD_API_ENV } from "../../chat/transports/discord";
import { SLACK_API_ENV } from "../../chat/transports/slack";
import { errorText } from "../../shell";
import type { Check, Section, SetupContext } from "../types";

const PLACES = ["terminal", "dashboard", "slack", "discord"] as const;
const BOTS = ["slack", "discord"] as const;
type Bot = (typeof BOTS)[number];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envName = (s: string) => (ENV_NAME.test(s) ? null : "Answer the name of an environment variable, like LOOPSTRA_SLACK_BOT_TOKEN, not the token itself.");

/** Each bot's token variables: [key, question, default]. */
const TOKENS: Record<Bot, [string, string, string][]> = {
  slack: [
    ["token_env", "Variable that holds the app-level token (xapp-...)", "LOOPSTRA_SLACK_APP_TOKEN"],
    ["bot_token_env", "Variable that holds the bot token (xoxb-...)", "LOOPSTRA_SLACK_BOT_TOKEN"],
  ],
  discord: [["token_env", "Variable that holds the bot token", "LOOPSTRA_DISCORD_TOKEN"]],
};

const LABEL: Record<Bot, string> = { slack: "Slack", discord: "Discord" };

async function askBot(ctx: SetupContext, bot: Bot): Promise<void> {
  const at = (k: string) => ["chat", "transports", bot, k];
  const str = (k: string) => { const v = ctx.doc.get(at(k)); return v === undefined || v === null ? undefined : String(v); };
  const ids = (k: string) => { const v = ctx.doc.get(at(k)); return Array.isArray(v) && v.length ? v.map(String).join(", ") : undefined; };
  ctx.ask.say(`${LABEL[bot]}: the config holds only the names of the environment variables with the tokens, never the tokens.`);
  for (const [k, question, fallback] of TOKENS[bot]) {
    ctx.doc.put(at(k), await ctx.ask.text(question, { suggestion: str(k) ?? fallback, check: envName }), fallback);
  }
  ctx.doc.set(at("channel"), await ctx.ask.text(`${LABEL[bot]} channel id where people talk to it`, { suggestion: str("channel") }));
  const lists: [string, string][] = [
    ["allow", "User ids who may chat, separated by commas (- for anyone in the channel)"],
    ["acceptors", "User ids who may also start drafts, separated by commas (- for nobody)"],
  ];
  for (const [k, question] of lists) {
    const list = (await ctx.ask.text(question, { suggestion: ids(k), optional: true })).split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) ctx.doc.set(at(k), list);
    else ctx.doc.clear(at(k));
  }
  const announce = await ctx.ask.text("Channel id for announcements (- for none)", { suggestion: str("announce_to"), optional: true });
  if (announce) ctx.doc.set(at("announce_to"), announce);
  else ctx.doc.clear(at("announce_to"));
}

export const chat: Section = {
  name: "chat",
  title: "Chat",

  async ask(ctx) {
    const configured = BOTS.filter((b) => ctx.doc.get(["chat", "transports", b]) !== undefined);
    const places = await ctx.ask.pickMany("Where will people talk to the orchestrator?", PLACES, ["terminal", "dashboard", ...configured]);
    if (places.includes("terminal")) ctx.ask.say("  Terminal: run loopstra chat.");
    if (places.includes("dashboard")) ctx.ask.say("  Dashboard: run loopstra ui and use its chat panel.");
    for (const bot of BOTS) {
      if (places.includes(bot)) await askBot(ctx, bot);
      else ctx.doc.clear(["chat", "transports", bot]);
    }
    if (places.some((p) => p === "slack" || p === "discord")) ctx.ask.say("  Start the bots with loopstra chat --no-terminal, where the token variables are set.");
  },

  async check(ctx, cfg) {
    const { slack, discord } = cfg.chat.transports;
    if (!slack && !discord) return [{ level: "ok", text: "Chat: the terminal and the dashboard only (no bots)." }];
    const checks: Check[] = [];
    if (slack) {
      const missing = [slack.token_env, slack.bot_token_env].filter((n) => !ctx.env[n]);
      checks.push(missing.length
        ? { level: "fail", text: `Slack: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.` }
        : await slackSignIn(ctx.env, ctx.env[slack.bot_token_env]!));
    }
    if (discord) {
      checks.push(ctx.env[discord.token_env]
        ? await discordSignIn(ctx.env, ctx.env[discord.token_env]!)
        : { level: "fail", text: `Discord: ${discord.token_env} is not set.` });
    }
    return checks;
  },
};

async function slackSignIn(env: SetupContext["env"], token: string): Promise<Check> {
  try {
    const res = await fetch(`${env[SLACK_API_ENV] ?? "https://slack.com/api"}/auth.test`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; user?: string; team?: string; error?: string };
    return j.ok
      ? { level: "ok", text: `Slack: signed in as ${j.user ?? "the bot"}${j.team ? ` in ${j.team}` : ""}.` }
      : { level: "fail", text: `Slack: the bot token was refused (${j.error ?? `HTTP ${res.status}`}).` };
  } catch (e) {
    return { level: "fail", text: `Slack could not be reached: ${errorText(e)}` };
  }
}

async function discordSignIn(env: SetupContext["env"], token: string): Promise<Check> {
  try {
    const res = await fetch(`${env[DISCORD_API_ENV] ?? "https://discord.com/api/v10"}/users/@me`, {
      headers: { authorization: `Bot ${token}`, "user-agent": "DiscordBot (loopstra, 1)" }, signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { level: "fail", text: `Discord: the bot token was refused (HTTP ${res.status}).` };
    const j = await res.json().catch(() => ({})) as { username?: string };
    return { level: "ok", text: `Discord: signed in as ${j.username ?? "the bot"}.` };
  } catch (e) {
    return { level: "fail", text: `Discord could not be reached: ${errorText(e)}` };
  }
}
```

- [ ] **Step 4: Register it**: `[budgets, commands, gates, github, chat]`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-chat.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS. In the first test the Slack token variables keep their defaults, so `put` adds no `token_env` keys; the chosen Slack has no `acceptors` ("-"); Discord, not chosen, is removed.

- [ ] **Step 6: Commit**

```bash
git add src/setup/sections tests/unit/setup-chat.test.ts
git commit -m "feat(setup): the chat section, for any mix of terminal, dashboard, Slack and Discord"
```

---

### Task 14: The models section

**Files:**
- Create: `src/setup/sections/models.ts`
- Modify: `src/setup/sections/index.ts`
- Test: `tests/unit/setup-models.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/setup-models.test.ts
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { models } from "../../src/setup/sections/models";
import { askSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

describe("the models section", () => {
  test("names the three models and picks one for each stage and chat", async () => {
    const r = configRepo(BASE);
    try {
      // default, cheap, strong; design, plan, build, review, verify; chat.
      const { text } = await askSection(models, r.root, ["", "", "claude-opus-5-5", "", "", "strong", "", "", "cheap"]);
      const yaml = parse(text);
      expect(yaml.claude).toEqual({ models: { strong: "claude-opus-5-5" } });
      expect(yaml.stages).toEqual({ build: { model: "strong" } });
      expect(yaml.chat).toEqual({ model: "cheap" });
    } finally { r.cleanup(); }
  });

  test("--defaults adds nothing", async () => {
    const r = configRepo(BASE);
    try {
      expect((await askSection(models, r.root, "defaults")).text).toBe(BASE);
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/setup-models.test.ts --timeout 30000`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/setup/sections/models.ts`**

```ts
import type { Section } from "../types";

const REFS = ["default", "cheap", "strong"] as const;
type Ref = (typeof REFS)[number];
const NAMES: Record<Ref, string> = { default: "sonnet", cheap: "haiku", strong: "opus" };
const STAGES: Record<string, Ref> = { design: "strong", plan: "strong", build: "default", review: "strong", verify: "default" };

const isRef = (v: unknown): v is Ref => typeof v === "string" && (REFS as readonly string[]).includes(v);

export const models: Section = {
  name: "models",
  title: "Models",

  async ask(ctx) {
    ctx.ask.say("Three model names Claude Code accepts for --model (an alias like sonnet, or a full model id). Each stage, and chat, uses one of the three.");
    for (const ref of REFS) {
      const current = ctx.doc.get(["claude", "models", ref]);
      const name = await ctx.ask.text(`The "${ref}" model`, { suggestion: typeof current === "string" && current ? current : NAMES[ref] });
      ctx.doc.put(["claude", "models", ref], name, NAMES[ref]);
    }
    for (const [stage, fallback] of Object.entries(STAGES)) {
      const current = ctx.doc.get(["stages", stage, "model"]);
      ctx.doc.put(["stages", stage, "model"], await ctx.ask.pick(`Model for the ${stage} stage`, REFS, isRef(current) ? current : fallback), fallback);
    }
    const current = ctx.doc.get(["chat", "model"]);
    ctx.doc.put(["chat", "model"], await ctx.ask.pick("Model for chat's orchestrator", REFS, isRef(current) ? current : "default"), "default");
  },

  async check() {
    return [];
  },
};
```

- [ ] **Step 4: Register it**: `[budgets, commands, gates, github, chat, models]`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/setup-models.test.ts tests/unit/setup.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setup/sections tests/unit/setup-models.test.ts
git commit -m "feat(setup): the models section"
```

---

### Task 15: `init` offers setup

**Files:**
- Modify: `src/init.ts` (`report.next`, about line 139), `src/cli.ts` (the `init` case)
- Test: `tests/unit/init.test.ts`

- [ ] **Step 1: Write the failing test** (inside the existing `describe` in `tests/unit/init.test.ts` that checks `report.next[0]`)

```ts
  test("the next steps point to loopstra setup", async () => {
    const repo = await tempGitRepo();
    try {
      const report = await init(repo.path);
      expect(report.next).toContain("Walk through the settings with `loopstra setup` (budgets, commands, gates, GitHub, chat, models), or edit loopstra/config.yaml.");
    } finally { repo.cleanup(); }
  });
```

(use the imports the file already has; add `tempGitRepo` from `../helpers` if it is not imported).

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/init.test.ts --timeout 30000`
Expected: FAIL.

- [ ] **Step 3: The next steps** in `src/init.ts`: replace the two items `"Open loopstra/config.yaml and confirm commands.test."` and `"Decide which gates get a person (gates.*.human)."` with one item:

```ts
    "Walk through the settings with `loopstra setup` (budgets, commands, gates, GitHub, chat, models), or edit loopstra/config.yaml.",
```

- [ ] **Step 4: The offer** in `src/cli.ts`, `init` case: after the line that prints `Next:` and before `return 0;`:

```ts
      // In a terminal, offer the walkthrough now; elsewhere the next steps name it.
      if (!process.stdin.isTTY) return 0;
      const { StreamPrompt } = await import("./setup/prompt");
      const ask = new StreamPrompt(process.stdin, process.stdout);
      let walk = false;
      try { walk = await ask.yesNo("\nWalk through the settings now?", true); } catch { /* input ended */ } finally { ask.close(); }
      if (!walk) return 0;
      const { setup } = await import("./setup");
      return setup(root, { interactive: true });
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/unit/init.test.ts tests/unit/cli.test.ts --timeout 30000` and `bun run typecheck`
Expected: PASS (tests run without a terminal, so the offer is skipped).

- [ ] **Step 6: Try it by hand** in a scratch repo, in a real terminal: `git init`, a `package.json` with a test script, then `bun <path-to-loopstra>/src/cli.ts init`. Answer `n` to the offer; run it again in another scratch repo and answer `y`, then Enter through every question. Expected: "No changes." or "Saved ...", then the checks. Note anything odd for the review in Task 18.

- [ ] **Step 7: Commit**

```bash
git add src/init.ts src/cli.ts tests/unit/init.test.ts
git commit -m "feat(init): offer loopstra setup after init"
```

---

### Task 16: End-to-end through the command line

**Files:**
- Test: `tests/integration/setup.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// tests/integration/setup.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../../src/config";
import { NEEDS_TERMINAL } from "../../src/setup";
import { ConfigDocument } from "../../src/setup/document";
import { FAKE_CLAUDE, run, tempDir, tempGitRepo } from "../helpers";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

async function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn({ cmd: [process.execPath, CLI, ...args], cwd, env: { ...process.env, LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

/** A repo with a test script, set up by `loopstra init` and committed. */
async function initRepo() {
  const repo = await tempGitRepo();
  await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  expect((await cli(["init"], repo.path)).code).toBe(0);
  await run(["git", "add", "-A"], repo.path);
  await run(["git", "commit", "-q", "-m", "loopstra"], repo.path);
  return repo;
}

describe("loopstra setup from the command line", () => {
  test("init, then setup --defaults: no changes, comments kept, no budgets", async () => {
    const repo = await initRepo();
    try {
      const before = readFileSync(configPath(repo.path), "utf8");
      const r = await cli(["setup", "--defaults"], repo.path);
      expect(r.code).toBe(0);
      expect(r.out).toContain("No changes.");
      expect(r.out).toContain("Checks:");
      expect(readFileSync(configPath(repo.path), "utf8")).toBe(before);
      const cfg = await loadConfig(repo.path);
      expect([cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session]).toEqual([undefined, undefined, undefined, undefined]);
    } finally { repo.cleanup(); }
  });

  test("setup without a terminal or flags refuses and writes nothing", async () => {
    const repo = await initRepo();
    try {
      const before = readFileSync(configPath(repo.path), "utf8");
      const r = await cli(["setup"], repo.path);
      expect(r.code).toBe(1);
      expect(r.out).toContain(NEEDS_TERMINAL);
      expect(readFileSync(configPath(repo.path), "utf8")).toBe(before);
    } finally { repo.cleanup(); }
  });

  test("--check reports a failing test command, a signed-out gh and unset Slack tokens, and exits 1", async () => {
    const repo = await initRepo();
    const remote = tempDir("loopstra-remote-");
    try {
      await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
      await run(["git", "remote", "add", "origin", remote.path], repo.path);
      const doc = ConfigDocument.load(repo.path);
      doc.set(["commands", "test"], "exit 3");
      doc.set(["chat", "transports", "slack", "channel"], "C1");
      doc.save();
      await run(["git", "commit", "-q", "-am", "config"], repo.path);
      const r = await cli(["setup", "--check"], repo.path, {
        LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "1", LOOPSTRA_SLACK_APP_TOKEN: "", LOOPSTRA_SLACK_BOT_TOKEN: "",
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("commands.test fails on main (exit 3)");
      expect(r.out).toContain("gh is not signed in");
      expect(r.out).toContain("Slack: LOOPSTRA_SLACK_APP_TOKEN and LOOPSTRA_SLACK_BOT_TOKEN are not set.");
    } finally { repo.cleanup(); remote.cleanup(); }
  });

  test("one section by name", async () => {
    const repo = await initRepo();
    try {
      const r = await cli(["setup", "budgets", "--defaults"], repo.path);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Budgets");
      expect(r.out).not.toContain("Commands");
    } finally { repo.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun test tests/integration/setup.test.ts --timeout 60000`
Expected: PASS. If "No changes." fails, print `r.out` and the diff of the config: a section is writing a value that was already its default (fix that section to use `put` or an equality check), or the template has a value the section rewrites differently (for example a quoted string). Fix the section, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/setup.test.ts
git commit -m "test(setup): init, setup --defaults and --check through the command line"
```

---

### Task 17: Documentation

**Files:**
- Modify: `README.md` ("Set up a repo", "Configuration", the chat paragraph on budgets, the Slack and Discord paragraph), `docs/decisions.md` (the chat **Budget.** bullet, plus a new Onboarding section), `templates/skill/SKILL.md` (Onboard, Chat, Status)

- [ ] **Step 1: README, "Set up a repo"**

Replace the numbered list after "Then:" (items 1-3) and the sentence after it with:

```markdown
1. Commit everything `init` wrote, on that branch. The loop works in its own checkouts, which only see what is committed, and `loopstra start` refuses until the config, prompts and hook are committed.
2. Run `loopstra setup` (in a terminal, `init` offers it). It walks through every setting, one section at a time (budgets, commands, gates, GitHub, chat, models), showing the current value and a suggestion; Enter keeps the suggestion. It saves `loopstra/config.yaml` once at the end, keeping its comments, and then checks what it can: that `commands.test` passes on main (in a throwaway checkout), that `claude` and `gh` are there and signed in, and that the Slack and Discord tokens work. Commit the config afterwards.

`loopstra setup <section>` runs one section, for example `loopstra setup budgets` after the loop pauses on a limit. `loopstra setup --defaults` takes every suggestion without asking (for scripts), and `loopstra setup --check` only runs the checks and exits 1 if any fails. Setup never calls Claude. You can also open Claude Code in the repo and ask the `loopstra` skill to help you decide; it explains the choices and tells you which `loopstra setup` section to run.
```

- [ ] **Step 2: README, "Configuration"**

Replace the `claude` bullet with:

```markdown
- `claude`: models (default, cheap, strong), timeout, optional spending limits (`max_budget_usd` per session, `max_budget_usd_per_day` for the loop's sessions together; unset means no limit, and `timeout_minutes` still ends a session), and `allowed_tools` for build sessions (the configured commands are always added; anything else a build needs, like `"Bash(make *)"`, goes here)
```

and add a bullet after `signals`:

```markdown
- `chat`: the orchestrator's model, optional spending limits (`max_budget_usd_per_day`, `max_budget_usd_per_session`), and the Slack and Discord bots under `transports`
```

Add after the bullet list:

```markdown
**Budgets.** No budget is set by default: on a subscription the dollar figures are only an estimate, and `timeout_minutes` already ends a stuck session. Set limits with `loopstra setup budgets`, in minutes (converted at about $0.20 a minute, which you can change) or dollars. A step that hits `claude.max_budget_usd` blocks with a note naming it. When the loop's sessions reach `claude.max_budget_usd_per_day`, the loop waits until local midnight: no change is blocked, the step resumes, and the dashboard and `loopstra status` say why.
```

- [ ] **Step 3: README, chat paragraph and bots paragraph**

Change "their cost counts in the dashboard's totals and is capped by `chat.max_budget_usd_per_day`, of which one session may hold at most `chat.max_budget_usd_per_session`, so several conversations can run at once." to "their cost counts in the dashboard's totals. Chat has no spending limit unless you set one (`loopstra setup budgets`): then `chat.max_budget_usd_per_day` caps the day, of which one session may hold at most `chat.max_budget_usd_per_session`, so several conversations can run at once."

Change "**Slack and Discord.** Set them up under `chat.transports` in `loopstra/config.yaml`;" to "**Slack and Discord.** Set them up with `loopstra setup chat` (it writes `chat.transports` in `loopstra/config.yaml` and checks the tokens), at any time and in any mix;".

- [ ] **Step 4: `docs/decisions.md`**

Replace the chat **Budget.** bullet with:

```markdown
- **Budget.** Chat turns and writer runs are phases of `_chat` in the trace, and their cost counts in the dashboard totals. Chat has no limit unless `chat.max_budget_usd_per_day` is set; then past it (since local midnight) chat answers without calling the assistant, and a running session holds at most `chat.max_budget_usd_per_session` of it, so one conversation cannot lock out the others. Only ended sessions count as spent.
```

Add a section at the end:

```markdown
## Onboarding (`loopstra setup`)

- **Budgets are opt-in.** Every budget is unset by default, which means no limit. On a subscription the dollars are an estimate, and the old defaults ($5 a session, about 25 minutes) stopped long builds before `timeout_minutes` did. Unset means `--max-budget-usd` is not passed at all.
- **The loop's daily cap pauses, never blocks.** `claude.max_budget_usd_per_day` holds each loop phase's share of the day through the same trace hold chat uses, over every slug but `_chat`. Reaching it ends the step like an unavailable assistant: the change keeps its status, and the loop waits for midnight.
- **Setup is code, not a conversation.** `loopstra setup` never calls Claude: the same answers always give the same config, it costs nothing, and it works before Claude is set up. The `loopstra` skill explains choices and points to the section to run; it does not edit the config.
- **Edits keep the file.** Setup edits `config.yaml` as a YAML document (comments and key order stay), saves once at the end after validating, and saves nothing when someone quits. A key the file does not have is added only when the answer differs from its default, so later default changes still reach the repository; keys the template wrote are updated in place.
- **Checks only read.** The test command runs in a throwaway checkout of main; `gh`, the remote and the chat tokens are asked, never changed. A failed check is reported, never undoes a save.
```

- [ ] **Step 5: `templates/skill/SKILL.md`**

In **Onboard**, replace steps 2 and 3 with:

```markdown
2. Have them run `loopstra setup` in a terminal (`init` offers it). It walks through budgets, commands, gates, GitHub, chat and models, saves `loopstra/config.yaml` keeping its comments, and checks what it can. One section at a time: `loopstra setup budgets` (or `commands`, `gates`, `github`, `chat`, `models`); `loopstra setup --check` only checks. Your part is to help them decide, in their context, and tell them which section to run; do not edit `config.yaml` yourself for anything setup asks.
   Build sessions may always run the configured commands; anything else they need (another tool, a script) goes in `claude.allowed_tools`, for example `"Bash(make *)"`. Refused commands show in the dashboard and `loopstra tail`.
3. A person always accepts an intent (draft to accepted). The other gates (spec, plan, merge, done) are unattended by default; setup's gates and github sections change that. Budgets are off by default (no limit); suggest limits only if they pay per use with an API key or want a ceiling.
```

In **Chat**, change "capped by `chat.max_budget_usd_per_day`" to "with no spending limit unless one is set with `loopstra setup budgets`", and change "To set up a bot, add it under `chat.transports` in `loopstra/config.yaml`." to "To set up a bot, run `loopstra setup chat` (any time; Slack, Discord or both); it writes `chat.transports` in `loopstra/config.yaml` and checks the tokens."

In **Status**, after the "Paused" paragraph, add:

```markdown
"Paused: the loop has used today's budget" means `claude.max_budget_usd_per_day` is reached. Nothing is blocked; the loop resumes after local midnight. To change it, `loopstra setup budgets`. A change blocked with "hit its spending limit (claude.max_budget_usd)" needs the limit raised or removed the same way, then its status set back as its note says.
```

- [ ] **Step 6: Check the docs against the code**

Run: `grep -rn "max_budget_usd" README.md docs/decisions.md templates/ src/ | grep -v "^src/setup"` and read each hit: no text may still say a budget has a default amount or that `init` writes `max_budget_usd: 5`. Run `bun test tests/unit/templates.test.ts tests/unit/init.test.ts --timeout 30000` (the skill and template are stamped by init).

- [ ] **Step 7: Commit**

```bash
git add README.md docs/decisions.md templates/skill/SKILL.md
git commit -m "docs: loopstra setup and opt-in budgets"
```

---

### Task 18: Verify everything

- [ ] **Step 1:** `bun run typecheck` — expected: clean.
- [ ] **Step 2:** `bun run test` — expected: every shard passes, 0 fail. Paste the summary line in the PR.
- [ ] **Step 3:** Read the spec section by section and tick each requirement against the code (commands and flags; the six sections' questions and checks; budgets default, daily cap, suggestions, old-default note, notes when hit; the build layout; the skill; tests; docs). List anything missing and add it before review.
- [ ] **Step 4:** Run `loopstra setup` by hand in a scratch repo in a real terminal through every section once, including adding and then removing a Slack bot, and `loopstra setup --check`. Confirm the saved file keeps its comments and reads well.
