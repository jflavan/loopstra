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
  // Empty prefault is deliberate: a missing `commands` block should still report `commands.test`, not `commands`.
  commands: z.object({
    test: z
      .string({ error: "commands.test is required: the single command that runs your tests" })
      .min(1, "commands.test is required: the single command that runs your tests"),
    lint: z.string().optional(),
    build: z.string().optional(),
    run: z.string().optional(),
    install: z.string().optional(),
  }).strict().prefault({} as { test: string }),
  claude: z.object({
    models: z.object({
      default: z.string().default("sonnet"),
      cheap: z.string().default("haiku"),
      strong: z.string().default("opus"),
    }).strict().prefault({}),
    timeout_minutes: z.number().positive().default(30),
    max_budget_usd: z.number().positive().default(5),
    allowed_tools: z.array(z.string()).default(["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun *)", "Bash(git *)"]),
  }).strict().prefault({}),
  gates: z.object({
    intent: z.object({ human: humanGate.default("status") }).strict().prefault({}),
    spec: z.object({ human: humanGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
    plan: z.object({ human: humanGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
    merge: z.object({ human: humanGate.default("none"), method: z.enum(["squash", "merge"]).default("squash") }).strict().prefault({}),
    done: z.object({ human: humanGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
  }).strict().prefault({}),
  stages: z.object({
    design: stage.extend({ model: modelRef.default("strong") }).prefault({}),
    plan: stage.extend({ model: modelRef.default("strong") }).prefault({}),
    build: stage.extend({ model: modelRef.default("default"), max_fix_loops: z.number().int().min(1).default(3) }).prefault({}),
    review: stage.extend({ model: modelRef.default("strong"), max_rounds: z.number().int().min(1).default(2) }).prefault({}),
    verify: stage.extend({ model: modelRef.default("cheap") }).prefault({}),
  }).strict().prefault({}),
  signals: z.object({
    main_health: z.object({ every_minutes: z.number().positive().default(30) }).strict().prefault({}),
  }).strict().prefault({}),
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
