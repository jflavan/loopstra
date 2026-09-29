# Loopstra Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runtime's foundation: package skeleton, envelope schemas, prompt rendering, config loading, intent files and queue, the trace store, the Claude CLI adapter with a fake `claude` for tests, and the `loopstra status` command.

**Architecture:** A Bun + TypeScript package with one module per responsibility under `src/`. Nothing in this plan runs a stage; it builds the pieces stages will use. Every module is pure or wraps one external thing (filesystem, SQLite, the `claude` process) behind one function or class, so later plans compose them. Spec: `docs/superpowers/specs/2026-09-28-loopstra-design.md`.

**Tech Stack:** Bun 1.4 (runtime, test runner, `bun:sqlite`, `Bun.spawn`), TypeScript, `zod` v4 (schemas and JSON Schema generation), `yaml` (config and frontmatter).

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitattributes`, `.gitignore` | Package, `loopstra` bin, LF line endings |
| `src/envelopes.ts` | Zod schemas for every phase envelope; JSON Schema export |
| `src/prompts.ts` | `{{variable}}` rendering of prompt templates |
| `src/config.ts` | Config schema, defaults, `loadConfig`, plain-language errors |
| `src/intents.ts` | Frontmatter parse/serialize, statuses, scan, consistency, runnable, queue order, `queue.md` rendering |
| `src/trace.ts` | `Trace` class: JSONL + SQLite event store and status queries |
| `src/claude.ts` | `runPhase`: spawn `claude -p`, stream-json parsing, timeout, result |
| `src/cli.ts` | `loopstra` entrypoint: `status`, `start --once` placeholder |
| `tests/fake-claude/claude.ts` | Fake `claude` executable replaying fixtures |
| `tests/fake-claude/fixtures/*.jsonl` | Real captured stream-json output |
| `tests/unit/*.test.ts` | One test file per module |
| `tests/helpers.ts` | Temp dir and temp repo helpers |

---

### Task 1: Package skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitattributes`, `.gitignore`, `src/cli.ts`, `tests/helpers.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "loopstra",
  "version": "0.1.0",
  "description": "Unattended, Claude Code based SDLC loop. Code owns the loop; agents own bounded phases.",
  "type": "module",
  "bin": { "loopstra": "./src/cli.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "yaml": "^2.6.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun-types"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `.gitattributes` and `.gitignore`**

`.gitattributes`:
```
* text=auto eol=lf
```

`.gitignore`:
```
node_modules/
.loopstra/
```

- [ ] **Step 4: Create `src/cli.ts` placeholder**

```ts
#!/usr/bin/env bun
const [command = "help"] = Bun.argv.slice(2);

const HELP = `loopstra <command>

  init      stamp Loopstra into this repo
  start     run the loop (--once for a single tick)
  status    show intents, phases, and blocks
  tail      stream events
  ui        local dashboard
`;

if (command === "help" || command === "--help" || command === "-h") {
  console.log(HELP);
} else {
  console.error(`Unknown or not yet implemented command: ${command}`);
  console.log(HELP);
  process.exit(1);
}
```

- [ ] **Step 5: Create `tests/helpers.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "loopstra-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export async function tempGitRepo(): Promise<{ path: string; cleanup: () => void }> {
  const t = tempDir("loopstra-repo-");
  await run(["git", "init", "-q", "-b", "main"], t.path);
  await run(["git", "config", "user.email", "loopstra-test@example.com"], t.path);
  await run(["git", "config", "user.name", "Loopstra Test"], t.path);
  await Bun.write(join(t.path, "README.md"), "# test repo\n");
  await run(["git", "add", "-A"], t.path);
  await run(["git", "commit", "-q", "-m", "init"], t.path);
  return t;
}
```

- [ ] **Step 6: Install and verify**

Run: `bun install && bun run typecheck && bun src/cli.ts help`
Expected: install succeeds, typecheck prints nothing, help text prints.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock tsconfig.json .gitattributes .gitignore src/cli.ts tests/helpers.ts
git commit -m "chore: package skeleton with cli placeholder and test helpers"
```

---

### Task 2: Envelope schemas

**Files:**
- Create: `src/envelopes.ts`
- Test: `tests/unit/envelopes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Envelopes, jsonSchemaFor, type PhaseName } from "../../src/envelopes";

describe("envelopes", () => {
  test("every phase has a schema with the base fields", () => {
    const names: PhaseName[] = [
      "intake", "design", "spec-check", "plan", "plan-challenge", "build", "fix",
      "reconcile", "verify", "review", "revise", "done-check", "lessons",
    ];
    for (const name of names) {
      const schema = Envelopes[name];
      const parsed = schema.safeParse({ status: "success", summary: "ok", notes_for_next_phase: "" });
      // base-only input should fail for phases with required extras, but base fields must exist
      const shape = jsonSchemaFor(name);
      expect(shape.properties).toHaveProperty("status");
      expect(shape.properties).toHaveProperty("summary");
      expect(shape.properties).toHaveProperty("notes_for_next_phase");
      expect(typeof parsed.success).toBe("boolean");
    }
  });

  test("intake accepts a priority and question", () => {
    const r = Envelopes.intake.parse({
      status: "success", summary: "fine", notes_for_next_phase: "",
      priority: "high", missing_sections: [], question: "",
    });
    expect(r.priority).toBe("high");
  });

  test("review requires severity on findings", () => {
    const r = Envelopes.review.safeParse({
      status: "success", summary: "", notes_for_next_phase: "", approved: false,
      review_markdown: "# Review", findings: [{ file: "a.ts", line: 1, finding: "bug" }],
    });
    expect(r.success).toBe(false);
  });

  test("json schema has no additional properties and lists required fields", () => {
    const s = jsonSchemaFor("build");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(expect.arrayContaining(["status", "summary", "changed_files", "commit_message"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/envelopes.test.ts`
Expected: FAIL, cannot find module `../../src/envelopes`.

- [ ] **Step 3: Write `src/envelopes.ts`**

```ts
import { z } from "zod";

const base = z.object({
  status: z.enum(["success", "fail"]),
  summary: z.string(),
  notes_for_next_phase: z.string(),
});

const finding = z.object({
  severity: z.enum(["important", "nit"]),
  file: z.string(),
  line: z.number().int().nonnegative(),
  finding: z.string(),
});

const requirement = z.object({
  requirement: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});

const codeChange = base.extend({
  changed_files: z.array(z.string()),
  commit_message: z.string(),
});

export const Envelopes = {
  intake: base.extend({
    priority: z.enum(["low", "normal", "high", "urgent"]),
    missing_sections: z.array(z.string()),
    question: z.string(),
  }),
  design: base.extend({
    spec_markdown: z.string(),
    concerns: z.array(z.string()),
  }),
  "spec-check": base.extend({
    approved: z.boolean(),
    findings: z.array(requirement),
  }),
  plan: base.extend({
    plan_markdown: z.string(),
    files: z.array(z.object({ path: z.string(), new: z.boolean() })),
  }),
  "plan-challenge": base.extend({
    approved: z.boolean(),
    concerns: z.array(z.object({ concern: z.string(), blocking: z.boolean() })),
  }),
  build: codeChange,
  fix: codeChange,
  reconcile: base.extend({ plan_markdown: z.string() }),
  verify: base.extend({
    passed: z.boolean(),
    observations: z.array(z.string()),
  }),
  review: base.extend({
    approved: z.boolean(),
    findings: z.array(finding),
    review_markdown: z.string(),
  }),
  revise: codeChange,
  "done-check": base.extend({
    met: z.boolean(),
    evidence: z.array(z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() })),
    outcome_markdown: z.string(),
  }),
  lessons: base.extend({
    lessons: z.array(z.string()),
    claude_md_additions: z.string(),
  }),
} as const;

export type PhaseName = keyof typeof Envelopes;
export type Envelope<N extends PhaseName> = z.infer<(typeof Envelopes)[N]>;

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
  [key: string]: unknown;
}

/** JSON Schema for `--json-schema`, generated from the one Zod definition. */
export function jsonSchemaFor(name: PhaseName): JsonSchemaObject {
  const schema = z.toJSONSchema(Envelopes[name], { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    ...(schema as object),
    type: "object",
    properties: (schema.properties ?? {}) as Record<string, unknown>,
    required: (schema.required ?? []) as string[],
    additionalProperties: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/envelopes.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/envelopes.ts tests/unit/envelopes.test.ts
git commit -m "feat: envelope schemas for every phase with json schema export"
```

---

### Task 3: Prompt rendering

**Files:**
- Create: `src/prompts.ts`
- Test: `tests/unit/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { renderPrompt } from "../../src/prompts";

describe("renderPrompt", () => {
  test("replaces known variables", () => {
    expect(renderPrompt("Slug: {{slug}}\n{{intent}}", { slug: "a-b", intent: "# I" })).toBe("Slug: a-b\n# I");
  });
  test("renders missing variables as (none)", () => {
    expect(renderPrompt("{{spec}}|{{plan}}", { spec: "S" })).toBe("S|(none)");
  });
  test("renders empty strings as (none)", () => {
    expect(renderPrompt("{{failure_output}}", { failure_output: "" })).toBe("(none)");
  });
  test("does not touch unknown braces", () => {
    expect(renderPrompt("{{ not a var }} {x}", {})).toBe("{{ not a var }} {x}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prompts.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/prompts.ts`**

```ts
export type PromptVars = Partial<Record<
  "slug" | "intent" | "spec" | "plan" | "review" | "previous" | "failure_output" | "skills" | "done_when" | "observations" | "concerns" | "findings",
  string
>>;

const VARIABLE = /\{\{([a-z_]+)\}\}/g;

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(VARIABLE, (_match, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value === undefined || value === "" ? "(none)" : value;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/prompts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts tests/unit/prompts.test.ts
git commit -m "feat: prompt template rendering"
```

---

### Task 4: Config loading

**Files:**
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configPath, loadConfig } from "../../src/config";
import { tempDir } from "../helpers";

function writeConfig(root: string, text: string) {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  Bun.write(configPath(root), text);
}

describe("loadConfig", () => {
  test("fills defaults around a minimal config", async () => {
    const t = tempDir();
    await Bun.write(configPath(t.path), "");
    writeConfig(t.path, "version: 1\ncommands:\n  test: bun test\n");
    const cfg = await loadConfig(t.path);
    expect(cfg.main_branch).toBe("main");
    expect(cfg.poll_seconds).toBe(60);
    expect(cfg.gates.intent.human).toBe("status");
    expect(cfg.gates.spec.agent).toBe(true);
    expect(cfg.stages.build.max_fix_loops).toBe(3);
    expect(cfg.claude.models.cheap).toBe("haiku");
    expect(cfg.signals.main_health.every_minutes).toBe(30);
    t.cleanup();
  });

  test("rejects unknown keys with a plain message", async () => {
    const t = tempDir();
    writeConfig(t.path, "version: 1\ncommands:\n  test: x\nbogus: 1\n");
    await expect(loadConfig(t.path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(t.path)).rejects.toThrow(/bogus/);
    t.cleanup();
  });

  test("requires commands.test", async () => {
    const t = tempDir();
    writeConfig(t.path, "version: 1\n");
    await expect(loadConfig(t.path)).rejects.toThrow(/commands\.test/);
    t.cleanup();
  });

  test("reports a missing file plainly", async () => {
    const t = tempDir();
    await expect(loadConfig(t.path)).rejects.toThrow(/loopstra\/config\.yaml/);
    t.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export class ConfigError extends Error {}

const humanGate = z.enum(["status", "pr", "none"]);
const modelRef = z.enum(["default", "cheap", "strong"]);

const stage = z.object({
  model: modelRef,
  skills: z.array(z.string()).default([]),
  before: z.array(z.string()).default([]),
  after: z.array(z.string()).default([]),
}).strict();

export const ConfigSchema = z.object({
  version: z.literal(1),
  main_branch: z.string().default("main"),
  poll_seconds: z.number().int().positive().default(60),
  commands: z.object({
    test: z.string().min(1, "commands.test is required: the single command that runs your tests"),
    lint: z.string().optional(),
    build: z.string().optional(),
    run: z.string().optional(),
  }).strict(),
  claude: z.object({
    models: z.object({
      default: z.string().default("sonnet"),
      cheap: z.string().default("haiku"),
      strong: z.string().default("opus"),
    }).strict().default({}),
    timeout_minutes: z.number().positive().default(30),
    max_budget_usd: z.number().positive().default(5),
    allowed_tools: z.array(z.string()).default(["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun *)", "Bash(git *)"]),
  }).strict().default({}),
  gates: z.object({
    intent: z.object({ human: humanGate.default("status") }).strict().default({}),
    spec: z.object({ human: humanGate.default("none"), agent: z.boolean().default(true) }).strict().default({}),
    plan: z.object({ human: humanGate.default("none"), agent: z.boolean().default(true) }).strict().default({}),
    merge: z.object({ human: humanGate.default("none"), method: z.enum(["squash", "merge"]).default("squash") }).strict().default({}),
    done: z.object({ human: humanGate.default("none"), agent: z.boolean().default(true) }).strict().default({}),
  }).strict().default({}),
  stages: z.object({
    design: stage.extend({ model: modelRef.default("strong") }).default({}),
    plan: stage.extend({ model: modelRef.default("strong") }).default({}),
    build: stage.extend({ model: modelRef.default("default"), max_fix_loops: z.number().int().min(1).default(3) }).default({}),
    review: stage.extend({ model: modelRef.default("strong"), max_rounds: z.number().int().min(1).default(2) }).default({}),
    verify: stage.extend({ model: modelRef.default("cheap") }).default({}),
  }).strict().default({}),
  signals: z.object({
    main_health: z.object({ every_minutes: z.number().positive().default(30) }).strict().default({}),
  }).strict().default({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export function configPath(root: string): string {
  return join(root, "loopstra", "config.yaml");
}

export async function loadConfig(root: string): Promise<Config> {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new ConfigError(`No config found at loopstra/config.yaml. Run \`loopstra init\` first.`);
  }
  let raw: unknown;
  try {
    raw = parse(await Bun.file(path).text()) ?? {};
  } catch (e) {
    throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const where = i.path.length ? i.path.join(".") : "(top level)";
      if (i.code === "unrecognized_keys") return `${where}: unknown key(s) ${i.keys.join(", ")}`;
      return `${where}: ${i.message}`;
    });
    throw new ConfigError(`loopstra/config.yaml has problems:\n- ${lines.join("\n- ")}`);
  }
  return result.data;
}

/** Resolve a stage's model alias to the CLI model name. */
export function modelFor(cfg: Config, ref: z.infer<typeof modelRef>): string {
  return cfg.claude.models[ref];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/config.test.ts`
Expected: PASS, 4 tests. If zod reports the unrecognized-keys issue code differently, print `result.error.issues` once and match the actual code; the message must still name the bad key.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: config schema, defaults, and plain-language load errors"
```

---

### Task 5: Intent frontmatter

**Files:**
- Create: `src/intents.ts`
- Test: `tests/unit/intents-frontmatter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { parseIntentFile, serializeIntentFile, STATUSES, type IntentFile } from "../../src/intents";

const SAMPLE = `---
status: draft
priority: normal
author: J. Ortiz
opened: 2026-09-28
note: ""
---
# Intent: claims status self-service

## Problem
People call.

## Proposed outcome
They stop calling.

## Done when
- Status is visible.
`;

describe("intent frontmatter", () => {
  test("parses frontmatter and body", () => {
    const f = parseIntentFile(SAMPLE);
    expect(f.frontmatter.status).toBe("draft");
    expect(f.frontmatter.priority).toBe("normal");
    expect(f.frontmatter.opened).toBe("2026-09-28");
    expect(f.title).toBe("claims status self-service");
    expect(f.sections["Problem"]).toBe("People call.");
    expect(f.sections["Done when"]).toBe("- Status is visible.");
  });

  test("round-trips through serialize", () => {
    const f = parseIntentFile(SAMPLE);
    f.frontmatter.status = "accepted";
    f.frontmatter.note = "Read spec.md";
    const text = serializeIntentFile(f);
    const again = parseIntentFile(text);
    expect(again.frontmatter.status).toBe("accepted");
    expect(again.frontmatter.note).toBe("Read spec.md");
    expect(again.body).toBe(f.body);
  });

  test("defaults missing frontmatter fields", () => {
    const f = parseIntentFile("# Intent: x\n\n## Problem\np\n");
    expect(f.frontmatter.status).toBe("draft");
    expect(f.frontmatter.priority).toBe("normal");
    expect(f.frontmatter.note).toBe("");
  });

  test("rejects an unknown status", () => {
    expect(() => parseIntentFile("---\nstatus: flying\n---\n# Intent: x\n")).toThrow(/status/);
    expect(STATUSES).toContain("merge-review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/intents-frontmatter.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the frontmatter part of `src/intents.ts`**

```ts
import { parse, stringify } from "yaml";
import { z } from "zod";

export const STATUSES = [
  "draft", "accepted",
  "designing", "spec-review", "spec-approved",
  "planning", "plan-review", "plan-approved",
  "building", "reviewing", "merge-review", "merged",
  "verifying", "done",
  "blocked", "closed",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const Frontmatter = z.object({
  status: z.enum(STATUSES).default("draft"),
  priority: z.enum(PRIORITIES).default("normal"),
  author: z.string().default(""),
  opened: z.string().default(""),
  note: z.string().default(""),
  /** The last approved status, so a person can retry from it. Runtime-managed. */
  resume_from: z.enum(STATUSES).optional(),
}).strict();
export type Frontmatter = z.infer<typeof Frontmatter>;

export interface IntentFile {
  frontmatter: Frontmatter;
  title: string;
  body: string;
  sections: Record<string, string>;
}

export const REQUIRED_SECTIONS = ["Problem", "Proposed outcome", "Done when"] as const;

export function parseIntentFile(text: string): IntentFile {
  let fmText = "";
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    fmText = m[1] ?? "";
    body = text.slice(m[0].length);
  }
  const raw = fmText.trim() ? parse(fmText) : {};
  const fm = Frontmatter.safeParse(raw ?? {});
  if (!fm.success) {
    const issue = fm.error.issues[0];
    throw new Error(`intent.md frontmatter problem at ${issue?.path.join(".") || "top"}: ${issue?.message}`);
  }
  const titleMatch = /^#\s*(?:Intent:\s*)?(.+)$/m.exec(body);
  const title = titleMatch?.[1]?.trim() ?? "";
  return { frontmatter: fm.data, title, body, sections: parseSections(body) };
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current !== null) sections[current] = buf.join("\n").trim(); };
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { flush(); current = h[1] ?? ""; buf = []; }
    else if (current !== null) buf.push(line);
  }
  flush();
  return sections;
}

export function serializeIntentFile(file: IntentFile): string {
  const fm = stringify(file.frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${file.body.replace(/^\r?\n/, "")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/intents-frontmatter.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/intents.ts tests/unit/intents-frontmatter.test.ts
git commit -m "feat: intent frontmatter parse and serialize with status and priority enums"
```

---

### Task 6: Intent scan, consistency, runnable, queue

**Files:**
- Modify: `src/intents.ts` (append)
- Test: `tests/unit/intents-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkConsistency, isRunnable, orderQueue, readIntent, renderQueue, scanIntents, writeIntent,
  type Intent,
} from "../../src/intents";
import { tempDir } from "../helpers";

function mk(root: string, slug: string, fm: string, extra: Record<string, string> = {}) {
  const dir = join(root, "intent", slug);
  mkdirSync(dir, { recursive: true });
  Bun.write(join(dir, "intent.md"), `---\n${fm}\n---\n# Intent: ${slug}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`);
  for (const [name, text] of Object.entries(extra)) Bun.write(join(dir, name), text);
}

describe("scan and queue", () => {
  test("scans intent folders and skips files and README", async () => {
    const t = tempDir();
    mk(t.path, "b-thing", "status: accepted\npriority: high\nopened: 2026-09-02");
    mk(t.path, "a-thing", "status: accepted\npriority: high\nopened: 2026-09-01");
    await Bun.write(join(t.path, "intent", "README.md"), "guide");
    await Bun.write(join(t.path, "intent", "queue.md"), "queue");
    const intents = await scanIntents(t.path);
    expect(intents.map((i) => i.slug).sort()).toEqual(["a-thing", "b-thing"]);
    t.cleanup();
  });

  test("orders in-flight, then approved, then accepted; then priority; then opened; then slug", async () => {
    const t = tempDir();
    mk(t.path, "z-accepted-urgent", "status: accepted\npriority: urgent\nopened: 2026-09-01");
    mk(t.path, "m-building", "status: building\npriority: low\nopened: 2026-09-05", { "spec.md": "s", "plan.md": "p" });
    mk(t.path, "k-approved", "status: spec-approved\npriority: normal\nopened: 2026-09-03", { "spec.md": "s" });
    mk(t.path, "a-accepted-normal-old", "status: accepted\npriority: normal\nopened: 2026-08-01");
    mk(t.path, "b-accepted-normal-old", "status: accepted\npriority: normal\nopened: 2026-08-01");
    mk(t.path, "done-one", "status: done\npriority: urgent\nopened: 2026-01-01", { "spec.md": "s", "plan.md": "p", "outcome.md": "o" });
    const ordered = orderQueue(await scanIntents(t.path)).map((i) => i.slug);
    expect(ordered).toEqual([
      "m-building", "k-approved", "z-accepted-urgent", "a-accepted-normal-old", "b-accepted-normal-old", "done-one",
    ]);
    t.cleanup();
  });

  test("consistency requires artifacts implied by status", async () => {
    const t = tempDir();
    mk(t.path, "no-spec", "status: spec-review");
    const [i] = await scanIntents(t.path);
    expect(checkConsistency(i!)).toMatch(/spec\.md/);
    mk(t.path, "has-spec", "status: spec-review", { "spec.md": "# Spec" });
    const ok = (await scanIntents(t.path)).find((x) => x.slug === "has-spec")!;
    expect(checkConsistency(ok)).toBeNull();
    t.cleanup();
  });

  test("runnable excludes draft, blocked, terminal, and human-waiting review states", () => {
    const base = { slug: "x", dir: "", file: { frontmatter: { status: "accepted", priority: "normal", author: "", opened: "", note: "" }, title: "x", body: "", sections: {} }, artifacts: new Set<string>() } as unknown as Intent;
    const with_ = (status: string) => ({ ...base, file: { ...base.file, frontmatter: { ...base.file.frontmatter, status } } }) as Intent;
    expect(isRunnable(with_("accepted"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(true);
    expect(isRunnable(with_("draft"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("blocked"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("done"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("spec-review"), { spec: "status", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("spec-review"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(true);
    expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "pr", done: "none" })).toBe(false);
  });

  test("writeIntent updates status and note and readIntent sees it", async () => {
    const t = tempDir();
    mk(t.path, "w", "status: accepted");
    const [i] = await scanIntents(t.path);
    await writeIntent(i!, { status: "blocked", note: "Tests failed three times." });
    const again = await readIntent(t.path, "w");
    expect(again.file.frontmatter.status).toBe("blocked");
    expect(again.file.frontmatter.note).toBe("Tests failed three times.");
    t.cleanup();
  });

  test("renderQueue lists active, blocked, and finished intents in plain language", async () => {
    const t = tempDir();
    mk(t.path, "active", "status: building\npriority: high", { "spec.md": "s", "plan.md": "p" });
    mk(t.path, "stuck", "status: blocked\nnote: Need an answer about adjusters.");
    mk(t.path, "finished", "status: done", { "spec.md": "s", "plan.md": "p", "outcome.md": "o" });
    const md = renderQueue(orderQueue(await scanIntents(t.path)));
    expect(md).toContain("| active |");
    expect(md).toContain("Need an answer about adjusters.");
    expect(md).toContain("finished");
    expect(md.startsWith("# Queue")).toBe(true);
    t.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/intents-queue.test.ts`
Expected: FAIL, missing exports.

- [ ] **Step 3: Append to `src/intents.ts`**

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Intent {
  slug: string;
  dir: string;
  file: IntentFile;
  /** Artifact file names present in the folder, e.g. "spec.md". */
  artifacts: Set<string>;
}

export const ARTIFACTS = ["intent.md", "spec.md", "plan.md", "review.md", "outcome.md"] as const;

export function intentRoot(root: string): string {
  return join(root, "intent");
}

export async function readIntent(root: string, slug: string): Promise<Intent> {
  const dir = join(intentRoot(root), slug);
  const text = await Bun.file(join(dir, "intent.md")).text();
  const artifacts = new Set(ARTIFACTS.filter((a) => existsSync(join(dir, a))));
  return { slug, dir, file: parseIntentFile(text), artifacts };
}

export async function scanIntents(root: string): Promise<Intent[]> {
  const base = intentRoot(root);
  if (!existsSync(base)) return [];
  const out: Intent[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, "intent.md"))) continue;
    out.push(await readIntent(root, name));
  }
  return out;
}

export async function writeIntent(intent: Intent, patch: Partial<Frontmatter>): Promise<void> {
  Object.assign(intent.file.frontmatter, patch);
  await Bun.write(join(intent.dir, "intent.md"), serializeIntentFile(intent.file));
}

/** Artifacts a status implies. */
const IMPLIES: Partial<Record<Status, readonly string[]>> = {
  "spec-review": ["spec.md"], "spec-approved": ["spec.md"],
  planning: ["spec.md"], "plan-review": ["spec.md", "plan.md"], "plan-approved": ["spec.md", "plan.md"],
  building: ["spec.md", "plan.md"], reviewing: ["spec.md", "plan.md"],
  "merge-review": ["spec.md", "plan.md"], merged: ["spec.md", "plan.md"],
  verifying: ["spec.md", "plan.md"], done: ["spec.md", "plan.md", "outcome.md"],
};

/** Returns a plain-language problem, or null when the folder matches the status. */
export function checkConsistency(intent: Intent): string | null {
  const status = intent.file.frontmatter.status;
  for (const name of IMPLIES[status] ?? []) {
    if (!intent.artifacts.has(name)) {
      return `Status is "${status}" but ${name} is missing. Set status back to an earlier approved state, or to closed.`;
    }
  }
  if (status !== "draft") {
    const missing = REQUIRED_SECTIONS.filter((s) => !intent.file.sections[s]?.trim());
    if (missing.length) return `intent.md is missing the section(s): ${missing.join(", ")}. Add them, then set status to accepted.`;
  }
  return null;
}

export type HumanGates = { spec: "status" | "pr" | "none"; plan: "status" | "pr" | "none"; merge: "status" | "pr" | "none"; done: "status" | "pr" | "none" };

const REVIEW_GATE: Partial<Record<Status, keyof HumanGates>> = {
  "spec-review": "spec", "plan-review": "plan", "merge-review": "merge", verifying: "done",
};

/**
 * Runnable: the runtime has something to do for this intent right now.
 * A review status whose gate is human is not runnable; the scan picks up the
 * person's status change. (PR-gated merge waits are polled by the merge stage
 * itself, so "merge-review" with pr is also not runnable here.)
 */
export function isRunnable(intent: Intent, human: HumanGates): boolean {
  const s = intent.file.frontmatter.status;
  if (s === "draft" || s === "blocked" || s === "done" || s === "closed") return false;
  const gate = REVIEW_GATE[s];
  if (gate && human[gate] !== "none") return false;
  return true;
}

const STATUS_CLASS: Record<Status, number> = {
  designing: 0, planning: 0, building: 0, reviewing: 0, verifying: 0,
  "spec-review": 0, "plan-review": 0, "merge-review": 0,
  "spec-approved": 1, "plan-approved": 1, merged: 1,
  accepted: 2,
  draft: 3, blocked: 3,
  done: 4, closed: 4,
};

export function orderQueue(intents: Intent[]): Intent[] {
  return [...intents].sort((a, b) => {
    const fa = a.file.frontmatter, fb = b.file.frontmatter;
    const c = STATUS_CLASS[fa.status] - STATUS_CLASS[fb.status];
    if (c !== 0) return c;
    const p = PRIORITIES.indexOf(fa.priority) - PRIORITIES.indexOf(fb.priority);
    if (p !== 0) return p;
    const o = (fa.opened || "9999").localeCompare(fb.opened || "9999");
    if (o !== 0) return o;
    return a.slug.localeCompare(b.slug);
  });
}

const PLAIN: Record<Status, string> = {
  draft: "being written", accepted: "waiting to be designed",
  designing: "designing", "spec-review": "spec ready for review", "spec-approved": "spec approved, waiting to plan",
  planning: "planning", "plan-review": "plan ready for review", "plan-approved": "plan approved, waiting to build",
  building: "building and testing", reviewing: "in review", "merge-review": "ready to merge", merged: "merged",
  verifying: "checking the result", done: "done", blocked: "needs a person", closed: "closed",
};

export function plainStatus(status: Status): string {
  return PLAIN[status];
}

export function renderQueue(ordered: Intent[]): string {
  const active = ordered.filter((i) => !["done", "closed", "blocked", "draft"].includes(i.file.frontmatter.status));
  const blocked = ordered.filter((i) => i.file.frontmatter.status === "blocked");
  const drafts = ordered.filter((i) => i.file.frontmatter.status === "draft");
  const finished = ordered.filter((i) => ["done", "closed"].includes(i.file.frontmatter.status));
  const row = (i: Intent) => `| ${i.slug} | ${i.file.frontmatter.priority} | ${plainStatus(i.file.frontmatter.status)} | ${i.file.frontmatter.note.replace(/\|/g, "/")} |`;
  const table = (rows: Intent[]) => rows.length
    ? ["| Change | Priority | Where it is | Note |", "|---|---|---|---|", ...rows.map(row)].join("\n")
    : "_Nothing here._";
  return [
    "# Queue",
    "",
    "This file is generated by Loopstra on every pass. Do not edit it. To change priority or status, edit the change's own intent.md.",
    "",
    "## In progress, in order",
    "",
    table(active),
    "",
    "## Needs a person",
    "",
    table(blocked),
    "",
    "## Drafts",
    "",
    table(drafts),
    "",
    "## Finished",
    "",
    table(finished),
    "",
  ].join("\n");
}
```

Note: move the `node:fs` and `node:path` imports to the top of the file with the existing imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/intents-queue.test.ts tests/unit/intents-frontmatter.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/intents.ts tests/unit/intents-queue.test.ts
git commit -m "feat: intent scan, consistency check, runnable rule, queue order and rendering"
```

---

### Task 7: Trace store

**Files:**
- Create: `src/trace.ts`
- Test: `tests/unit/trace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("Trace", () => {
  test("writes events to jsonl and sqlite, and reports intent summaries", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    trace.upsertIntent("a-b", "building", "high");
    const seq = trace.phaseStart("a-b", "build", "agent");
    trace.event("a-b", "claude_event", { type: "assistant" }, seq);
    trace.phaseEnd("a-b", seq, { status: "success", costUsd: 0.12, sessionId: "sid-1" });
    trace.gate("a-b", "merge", "tests", "pass", "exit 0");
    trace.signal("main_health", "pass", "all green");

    const rows = trace.events("a-b");
    expect(rows.map((r) => r.type)).toEqual(["phase_start", "claude_event", "phase_end", "gate_check"]);
    const jsonl = readFileSync(join(t.path, ".loopstra", "runs", "a-b", "events.jsonl"), "utf8").trim().split("\n");
    expect(jsonl.length).toBe(4);
    expect(JSON.parse(jsonl[0]!).type).toBe("phase_start");

    const summary = trace.intentSummary("a-b");
    expect(summary?.status).toBe("building");
    expect(summary?.costUsd).toBeCloseTo(0.12);
    expect(summary?.lastPhase).toBe("build");
    expect(summary?.lastPhaseStatus).toBe("success");
    expect(existsSync(join(t.path, ".loopstra", "trace.db"))).toBe(true);
    trace.close();
    t.cleanup();
  });

  test("phase sequence increments per intent and survives reopen", () => {
    const t = tempDir();
    let trace = Trace.open(t.path);
    expect(trace.phaseStart("x", "design", "agent")).toBe(1);
    expect(trace.phaseStart("x", "spec-check", "agent")).toBe(2);
    trace.close();
    trace = Trace.open(t.path);
    expect(trace.phaseStart("x", "plan", "agent")).toBe(3);
    trace.close();
    t.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/trace.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/trace.ts`**

```ts
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "tick" | "phase_start" | "claude_event" | "command" | "gate_check"
  | "status_change" | "phase_end" | "error" | "signal";

export interface EventRow {
  id: number; slug: string; phase_seq: number | null; type: EventType; ts: string; payload: string;
}

export interface IntentSummary {
  slug: string; status: string; priority: string; updated: string;
  costUsd: number; lastPhase: string | null; lastPhaseStatus: string | null; lastActivity: string | null;
}

export interface PhaseRow {
  slug: string; seq: number; name: string; kind: string; status: string;
  started: string; ended: string | null; cost_usd: number; session_id: string | null; error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (slug TEXT PRIMARY KEY, status TEXT NOT NULL, priority TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phases (slug TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, cost_usd REAL NOT NULL DEFAULT 0, session_id TEXT, error TEXT,
  PRIMARY KEY (slug, seq));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, phase_seq INTEGER,
  type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_slug ON events (slug, id);
CREATE TABLE IF NOT EXISTS gates (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, gate TEXT NOT NULL,
  "check" TEXT NOT NULL, result TEXT NOT NULL, evidence TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ts TEXT NOT NULL,
  result TEXT NOT NULL, output TEXT NOT NULL);
`;

const now = () => new Date().toISOString();

export class Trace {
  private constructor(private readonly root: string, private readonly db: Database) {}

  static open(root: string): Trace {
    const dir = join(root, ".loopstra");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "trace.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    return new Trace(root, db);
  }

  close(): void { this.db.close(); }

  event(slug: string, type: EventType, payload: unknown, phaseSeq: number | null = null): void {
    const ts = now();
    const json = JSON.stringify(payload ?? {});
    this.db.run("INSERT INTO events (slug, phase_seq, type, ts, payload) VALUES (?, ?, ?, ?, ?)", [slug, phaseSeq, type, ts, json]);
    const dir = join(this.root, ".loopstra", "runs", slug);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ ts, slug, phase_seq: phaseSeq, type, payload: payload ?? {} }) + "\n");
  }

  upsertIntent(slug: string, status: string, priority: string): void {
    this.db.run(
      "INSERT INTO intents (slug, status, priority, updated) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET status = excluded.status, priority = excluded.priority, updated = excluded.updated",
      [slug, status, priority, now()],
    );
  }

  statusChange(slug: string, from: string, to: string, note = ""): void {
    this.event(slug, "status_change", { from, to, note });
  }

  phaseStart(slug: string, name: string, kind: "agent" | "code" | "human"): number {
    const row = this.db.query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM phases WHERE slug = ?").get(slug);
    const seq = (row?.m ?? 0) + 1;
    this.db.run("INSERT INTO phases (slug, seq, name, kind, status, started) VALUES (?, ?, ?, ?, 'running', ?)", [slug, seq, name, kind, now()]);
    this.event(slug, "phase_start", { name, kind }, seq);
    return seq;
  }

  phaseEnd(slug: string, seq: number, r: { status: "success" | "fail"; costUsd?: number; sessionId?: string; error?: string }): void {
    this.db.run("UPDATE phases SET status = ?, ended = ?, cost_usd = ?, session_id = COALESCE(?, session_id), error = ? WHERE slug = ? AND seq = ?",
      [r.status, now(), r.costUsd ?? 0, r.sessionId ?? null, r.error ?? null, slug, seq]);
    this.event(slug, "phase_end", { status: r.status, cost_usd: r.costUsd ?? 0, error: r.error ?? null }, seq);
  }

  gate(slug: string, gate: string, check: string, result: "pass" | "fail" | "waiting", evidence: string): void {
    this.db.run('INSERT INTO gates (slug, gate, "check", result, evidence, ts) VALUES (?, ?, ?, ?, ?, ?)', [slug, gate, check, result, evidence, now()]);
    this.event(slug, "gate_check", { gate, check, result, evidence });
  }

  signal(name: string, result: "pass" | "fail" | "error", output: string): void {
    this.db.run("INSERT INTO signals (name, ts, result, output) VALUES (?, ?, ?, ?)", [name, now(), result, output]);
    this.event("_signals", "signal", { name, result, output });
  }

  events(slug: string, afterId = 0, limit = 500): EventRow[] {
    return this.db.query<EventRow, [string, number, number]>("SELECT * FROM events WHERE slug = ? AND id > ? ORDER BY id LIMIT ?").all(slug, afterId, limit);
  }

  recentEvents(afterId = 0, limit = 200): EventRow[] {
    return this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?").all(afterId, limit).reverse();
  }

  phases(slug: string): PhaseRow[] {
    return this.db.query<PhaseRow, [string]>("SELECT * FROM phases WHERE slug = ? ORDER BY seq").all(slug);
  }

  gates(slug: string): Array<{ gate: string; check: string; result: string; evidence: string; ts: string }> {
    return this.db.query<{ gate: string; check: string; result: string; evidence: string; ts: string }, [string]>(
      'SELECT gate, "check", result, evidence, ts FROM gates WHERE slug = ? ORDER BY id').all(slug);
  }

  signals(limit = 50): Array<{ name: string; ts: string; result: string; output: string }> {
    return this.db.query<{ name: string; ts: string; result: string; output: string }, [number]>(
      "SELECT name, ts, result, output FROM signals ORDER BY id DESC LIMIT ?").all(limit);
  }

  intentSummary(slug: string): IntentSummary | null {
    const i = this.db.query<{ slug: string; status: string; priority: string; updated: string }, [string]>("SELECT * FROM intents WHERE slug = ?").get(slug);
    if (!i) return null;
    const cost = this.db.query<{ c: number | null }, [string]>("SELECT SUM(cost_usd) AS c FROM phases WHERE slug = ?").get(slug)?.c ?? 0;
    const last = this.db.query<PhaseRow, [string]>("SELECT * FROM phases WHERE slug = ? ORDER BY seq DESC LIMIT 1").get(slug);
    const act = this.db.query<{ ts: string }, [string]>("SELECT ts FROM events WHERE slug = ? ORDER BY id DESC LIMIT 1").get(slug);
    return {
      slug: i.slug, status: i.status, priority: i.priority, updated: i.updated,
      costUsd: cost, lastPhase: last?.name ?? null, lastPhaseStatus: last?.status ?? null, lastActivity: act?.ts ?? null,
    };
  }

  allIntents(): IntentSummary[] {
    const rows = this.db.query<{ slug: string }, []>("SELECT slug FROM intents ORDER BY updated DESC").all();
    return rows.map((r) => this.intentSummary(r.slug)!).filter(Boolean);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/trace.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/trace.ts tests/unit/trace.test.ts
git commit -m "feat: trace store writing jsonl and sqlite with intent summaries"
```

---

### Task 8: Stream-json parsing

**Files:**
- Create: `src/claude.ts` (parsing half)
- Test: `tests/unit/claude-parse.test.ts`
- Uses: `tests/fake-claude/fixtures/read-then-structured.jsonl` (already captured from a real run)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { StreamCollector } from "../../src/claude";

const FIXTURE = await Bun.file(new URL("../fake-claude/fixtures/read-then-structured.jsonl", import.meta.url)).text();

describe("StreamCollector", () => {
  test("collects session id, structured output, cost, and tool uses from a real stream", () => {
    const c = new StreamCollector();
    for (const line of FIXTURE.split("\n")) c.push(line);
    const r = c.finish();
    expect(r.sessionId).toBe("bdfbd999-ad20-46cd-81ad-ab27ff4eee26");
    expect(r.subtype).toBe("success");
    expect(r.structuredOutput).toMatchObject({ status: "fail", priority: "normal" });
    expect(r.costUsd).toBeCloseTo(0.0717593, 5);
    expect(r.toolUses.map((t) => t.name)).toEqual(["Read", "StructuredOutput"]);
    expect(r.events.length).toBe(18);
  });

  test("ignores blank and non-json lines without throwing", () => {
    const c = new StreamCollector();
    c.push("");
    c.push("not json");
    c.push('{"type":"system","subtype":"init","session_id":"s1"}');
    const r = c.finish();
    expect(r.sessionId).toBe("s1");
    expect(r.subtype).toBe("missing_result");
    expect(r.structuredOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/claude-parse.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the parsing half of `src/claude.ts`**

```ts
export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface ToolUse { name: string; input: unknown }

export interface Collected {
  sessionId: string | null;
  subtype: string;
  structuredOutput: unknown;
  costUsd: number;
  usage: unknown;
  toolUses: ToolUse[];
  resultText: string;
  events: StreamEvent[];
  isError: boolean;
}

/** Accumulates `--output-format stream-json` lines into one result. */
export class StreamCollector {
  private sessionId: string | null = null;
  private result: StreamEvent | null = null;
  private toolUses: ToolUse[] = [];
  readonly events: StreamEvent[] = [];

  push(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let e: StreamEvent;
    try { e = JSON.parse(trimmed) as StreamEvent; } catch { return null; }
    this.events.push(e);
    if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
    if (e.type === "assistant") {
      const content = (e as { message?: { content?: Array<{ type: string; name?: string; input?: unknown }> } }).message?.content ?? [];
      for (const c of content) if (c.type === "tool_use" && c.name) this.toolUses.push({ name: c.name, input: c.input });
    }
    if (e.type === "result") this.result = e;
    return e;
  }

  finish(): Collected {
    const r = this.result as (StreamEvent & {
      structured_output?: unknown; total_cost_usd?: number; usage?: unknown; result?: string; is_error?: boolean;
    }) | null;
    return {
      sessionId: this.sessionId ?? r?.session_id ?? null,
      subtype: r?.subtype ?? "missing_result",
      structuredOutput: r?.structured_output,
      costUsd: r?.total_cost_usd ?? 0,
      usage: r?.usage,
      toolUses: this.toolUses,
      resultText: r?.result ?? "",
      events: this.events,
      isError: r?.is_error ?? r === null,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/claude-parse.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/claude.ts tests/unit/claude-parse.test.ts tests/fake-claude/fixtures/read-then-structured.jsonl
git commit -m "feat: stream-json collector with real fixture"
```

---

### Task 9: Fake claude and runPhase

**Files:**
- Create: `tests/fake-claude/claude.ts`, `tests/fake-claude/fixtures/simple-success.jsonl`, `tests/fake-claude/fixtures/hang.jsonl`
- Modify: `src/claude.ts` (append `runPhase`)
- Test: `tests/unit/claude-run.test.ts`

The fake reads env `LOOPSTRA_FAKE_FIXTURE` (path to a JSONL file) or, if the prompt on stdin contains `FIXTURE:<name>`, uses `tests/fake-claude/fixtures/<name>.jsonl`. It echoes the args it received into a file at `LOOPSTRA_FAKE_ARGS` when set, so tests can assert the CLI flags. If the fixture name is `hang` it sleeps forever, to test timeouts.

- [ ] **Step 1: Write the fake**

`tests/fake-claude/claude.ts`:
```ts
#!/usr/bin/env bun
// Fake `claude` executable: replays a stream-json fixture. Never calls the network.
import { join, dirname } from "node:path";

const args = Bun.argv.slice(2);
const prompt = await Bun.stdin.text();

if (process.env.LOOPSTRA_FAKE_ARGS) {
  await Bun.write(process.env.LOOPSTRA_FAKE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { LOOPSTRA_PHASE: process.env.LOOPSTRA_PHASE ?? null } }));
}

const named = /FIXTURE:([a-z0-9-]+)/.exec(prompt)?.[1];
const fixture = process.env.LOOPSTRA_FAKE_FIXTURE ?? join(dirname(Bun.main), "fixtures", `${named ?? "simple-success"}.jsonl`);

if (fixture.endsWith("hang.jsonl")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "hang-session" }));
  await new Promise(() => {});
}

const text = await Bun.file(fixture).text();
for (const line of text.split("\n")) {
  if (line.trim()) console.log(line);
}
process.exit(0);
```

`tests/fake-claude/fixtures/simple-success.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-session-1","cwd":"/","tools":[],"model":"fake"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"StructuredOutput","input":{"status":"success","summary":"did the thing","notes_for_next_phase":"","priority":"normal","missing_sections":[],"question":""}}]},"session_id":"fake-session-1"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-session-1","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20},"structured_output":{"status":"success","summary":"did the thing","notes_for_next_phase":"","priority":"normal","missing_sections":[],"question":""},"result":"ok"}
```

`tests/fake-claude/fixtures/hang.jsonl`: an empty file (the fake checks the name).

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runPhase, FAKE_CLAUDE_ENV } from "../../src/claude";
import { tempDir } from "../helpers";

const FAKE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("runPhase", () => {
  test("spawns claude with the expected flags, pipes the prompt, and returns structured output", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    const r = await runPhase({
      cwd: t.path,
      prompt: "Do the thing. FIXTURE:simple-success",
      schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      model: "haiku",
      permissionMode: "default",
      allowedTools: ["Read", "Grep"],
      timeoutMs: 10_000,
      maxBudgetUsd: 1,
      env: { LOOPSTRA_FAKE_ARGS: argsFile, LOOPSTRA_PHASE: "fix" },
      executable: FAKE,
    });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("fake-session-1");
    expect(r.structuredOutput).toMatchObject({ status: "success", priority: "normal" });
    expect(r.costUsd).toBeCloseTo(0.01);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.prompt).toContain("Do the thing.");
    expect(recorded.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--json-schema", "--model", "haiku", "--permission-mode", "default", "--allowedTools", "Read,Grep", "--max-budget-usd", "1"]));
    expect(recorded.args).not.toContain("--resume");
    expect(recorded.env.LOOPSTRA_PHASE).toBe("fix");
    t.cleanup();
  });

  test("passes --resume when a session id is given", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "acceptEdits",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, resume: "old-session", env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.args).toEqual(expect.arrayContaining(["--resume", "old-session"]));
    t.cleanup();
  });

  test("kills a hung process at the timeout and reports failure", async () => {
    const t = tempDir();
    const started = Date.now();
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:hang", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 1_500, maxBudgetUsd: 1, executable: FAKE });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timed out/);
    expect(r.sessionId).toBe("hang-session");
    expect(Date.now() - started).toBeLessThan(10_000);
    t.cleanup();
  });

  test("reports a missing executable plainly", async () => {
    const t = tempDir();
    const r = await runPhase({ cwd: t.path, prompt: "x", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 1_000, maxBudgetUsd: 1, executable: join(t.path, "nope.exe") });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not start/i);
    t.cleanup();
  });

  test("FAKE_CLAUDE_ENV names the override variable", () => {
    expect(FAKE_CLAUDE_ENV).toBe("LOOPSTRA_CLAUDE_EXECUTABLE");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/claude-run.test.ts`
Expected: FAIL, `runPhase` is not exported.

- [ ] **Step 4: Append `runPhase` to `src/claude.ts`**

```ts
export const FAKE_CLAUDE_ENV = "LOOPSTRA_CLAUDE_EXECUTABLE";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "dontAsk" | "auto";

export interface RunPhaseInput {
  cwd: string;
  prompt: string;
  schema: object;
  model: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  timeoutMs: number;
  maxBudgetUsd: number;
  resume?: string;
  env?: Record<string, string>;
  /** Override the executable (tests). Defaults to $LOOPSTRA_CLAUDE_EXECUTABLE or `claude` on PATH. */
  executable?: string;
  onEvent?: (e: StreamEvent) => void;
}

export interface RunPhaseResult extends Collected {
  ok: boolean;
  reason: string;
  exitCode: number | null;
  durationMs: number;
  stderr: string;
}

export function resolveClaude(override?: string): string | null {
  if (override) return override;
  const fromEnv = process.env[FAKE_CLAUDE_ENV];
  if (fromEnv) return fromEnv;
  return Bun.which("claude");
}

export async function runPhase(input: RunPhaseInput): Promise<RunPhaseResult> {
  const started = Date.now();
  const collector = new StreamCollector();
  const fail = (reason: string, exitCode: number | null = null, stderr = ""): RunPhaseResult => ({
    ...collector.finish(), ok: false, reason, exitCode, durationMs: Date.now() - started, stderr,
  });

  const exe = resolveClaude(input.executable);
  if (!exe) return fail("could not start claude: not found on PATH. Install Claude Code or set LOOPSTRA_CLAUDE_EXECUTABLE.");

  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--model", input.model,
    "--permission-mode", input.permissionMode,
    "--max-budget-usd", String(input.maxBudgetUsd),
  ];
  if (input.allowedTools.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.resume) args.push("--resume", input.resume);

  // A .ts fake must be run through bun; the real CLI is a native executable.
  const cmd = exe.endsWith(".ts") ? [process.execPath, exe, ...args] : [exe, ...args];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd, cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...(input.env ?? {}) },
    });
  } catch (e) {
    return fail(`could not start claude: ${(e as Error).message}`);
  }

  proc.stdin.write(input.prompt);
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, input.timeoutMs);

  const stderrPromise = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const e = collector.push(line);
      if (e && input.onEvent) input.onEvent(e);
    }
  }
  if (buffer.trim()) { const e = collector.push(buffer); if (e && input.onEvent) input.onEvent(e); }

  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stderr = await stderrPromise;
  const collected = collector.finish();
  const durationMs = Date.now() - started;

  if (timedOut) return { ...collected, ok: false, reason: `claude timed out after ${Math.round(input.timeoutMs / 1000)}s`, exitCode, durationMs, stderr };
  if (collected.subtype === "missing_result") {
    return { ...collected, ok: false, reason: `claude exited ${exitCode} without a result: ${stderr.trim().split("\n").pop() ?? ""}`.trim(), exitCode, durationMs, stderr };
  }
  if (collected.subtype !== "success" || collected.isError) {
    return { ...collected, ok: false, reason: `claude ended with ${collected.subtype}`, exitCode, durationMs, stderr };
  }
  if (collected.structuredOutput === undefined) {
    return { ...collected, ok: false, reason: "claude finished without structured output", exitCode, durationMs, stderr };
  }
  return { ...collected, ok: true, reason: "", exitCode, durationMs, stderr };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/claude-run.test.ts`
Expected: PASS, 5 tests. The timeout test takes about 1.5 seconds. If `proc.kill()` does not end the loop on Windows, use `proc.kill("SIGKILL")` and confirm the `for await` exits once stdout closes.

- [ ] **Step 6: Commit**

```bash
git add src/claude.ts tests/fake-claude tests/unit/claude-run.test.ts
git commit -m "feat: claude cli adapter with fake executable, timeout, and resume"
```

---

### Task 10: `loopstra status`

**Files:**
- Modify: `src/cli.ts`
- Create: `src/commands/status.ts`
- Test: `tests/unit/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderStatus } from "../../src/commands/status";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("renderStatus", () => {
  test("shows each intent with plain status, phase, cost, and note", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "one"), { recursive: true });
    await Bun.write(join(t.path, "intent", "one", "intent.md"), "---\nstatus: blocked\npriority: high\nnote: Tests failed three times.\n---\n# Intent: one\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    const trace = Trace.open(t.path);
    trace.upsertIntent("one", "blocked", "high");
    const seq = trace.phaseStart("one", "fix", "agent");
    trace.phaseEnd("one", seq, { status: "fail", costUsd: 0.5, error: "tests red" });
    trace.close();
    const text = await renderStatus(t.path);
    expect(text).toContain("one");
    expect(text).toContain("needs a person");
    expect(text).toContain("fix");
    expect(text).toContain("$0.50");
    expect(text).toContain("Tests failed three times.");
    t.cleanup();
  });

  test("says so when there are no intents", async () => {
    const t = tempDir();
    expect(await renderStatus(t.path)).toMatch(/No intents yet/);
    t.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/status.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/commands/status.ts`**

```ts
import { orderQueue, plainStatus, scanIntents } from "../intents";
import { Trace } from "../trace";

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

export async function renderStatus(root: string): Promise<string> {
  const intents = orderQueue(await scanIntents(root));
  if (!intents.length) return "No intents yet. Create intent/<slug>/intent.md, or ask the loopstra skill to draft one.\n";
  const trace = Trace.open(root);
  try {
    const rows = intents.map((i) => {
      const s = trace.intentSummary(i.slug);
      const phase = s?.lastPhase ? `${s.lastPhase} (${s.lastPhaseStatus})` : "-";
      const cost = `$${(s?.costUsd ?? 0).toFixed(2)}`;
      return [i.slug, i.file.frontmatter.priority, plainStatus(i.file.frontmatter.status), phase, cost, i.file.frontmatter.note];
    });
    const headers = ["Change", "Priority", "Where it is", "Last phase", "Cost", "Note"];
    const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
    const line = (r: string[]) => r.map((v, c) => pad(v, widths[c]!)).join("  ");
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + "\n";
  } finally {
    trace.close();
  }
}
```

- [ ] **Step 4: Wire `src/cli.ts`**

Replace the placeholder with:
```ts
#!/usr/bin/env bun
import { renderStatus } from "./commands/status";

const [command = "help", ...rest] = Bun.argv.slice(2);
const root = process.cwd();

const HELP = `loopstra <command>

  init      stamp Loopstra into this repo
  start     run the loop (--once for a single tick)
  status    show intents, phases, and blocks
  tail      stream events
  ui        local dashboard
`;

async function main(): Promise<number> {
  switch (command) {
    case "help": case "--help": case "-h":
      console.log(HELP); return 0;
    case "status":
      process.stdout.write(await renderStatus(root)); return 0;
    default:
      console.error(`Unknown or not yet implemented command: ${command}`);
      console.log(HELP); return 1;
  }
}

process.exit(await main());
```

`rest` is unused for now; keep it for `start --once` in Plan 2.

- [ ] **Step 5: Run all tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/commands/status.ts tests/unit/status.test.ts
git commit -m "feat: loopstra status command"
```

---

## Self-review

- **Spec coverage for this plan's scope:** §2 layout (intents, `.loopstra/`), §3 intent file, §4 states and consistency, §5 queue order and `queue.md`, §6 config, §7 envelopes and prompt variables, §9 adapter, §11 trace and `status`. Stages, gates, git, GitHub, signals, init, skill, `tail`, `ui` are Plans 2 and 3.
- **Type consistency:** `Trace.phaseStart` returns `number`; `runPhase` returns `RunPhaseResult` with `ok`, `reason`, `sessionId`, `structuredOutput`, `costUsd`; `isRunnable(intent, HumanGates)`; `writeIntent(intent, patch)`; `renderQueue(orderQueue(...))`. These names are reused verbatim in Plan 2.
- **Placeholders:** none.
