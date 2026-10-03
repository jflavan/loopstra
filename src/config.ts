import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { errorText } from "./shell";

/** One thing wrong with a config: where (["claude", "timeout_minutes"]), and in words. */
export interface ConfigProblem {
  path: string[];
  text: string;
  /** A key the schema does not know, at `path`: only removing it fixes it. */
  unknownKey: boolean;
}

export class ConfigError extends Error {
  /** What is wrong, one by one, when the config was read but does not fit the schema. */
  constructor(message: string, readonly problems: ConfigProblem[] = []) {
    super(message);
  }
}

const humanGate = z.enum(["status", "pr", "none"]);
/** A person on the status line, or nobody: spec, plan, and done have no pull request to approve. */
const statusGate = z.enum(["status", "none"], { error: "must be status or none; a pull request cannot be used for this gate" });
const modelRef = z.enum(["default", "cheap", "strong"]);

const stage = z.object({
  model: modelRef,
  skills: z.array(z.string()).default([]),
  before: z.array(z.string()).default([]),
  after: z.array(z.string()).default([]),
}).strict();

/** A platform id (user or channel). Long numeric ids (Discord's) lose digits as YAML numbers, so those must be quoted. */
const platformId = z.union([z.string().min(1), z.number().refine(Number.isSafeInteger, "is too long to be read as a number: put it in quotes")]).transform(String);
/** Platform user ids. Empty `allow`: anyone in the channel may chat. Empty `acceptors`: nobody may accept from there. */
const ids = z.array(platformId).default([]);
/** The name of an environment variable, like LOOPSTRA_SLACK_BOT_TOKEN. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envName = (fallback: string) => z.string().regex(ENV_NAME, "must be the name of an environment variable").default(fallback);
const channelId = platformId;

const slackTransport = z.object({
  /** The app-level token (xapp-...) for Socket Mode. */
  token_env: envName("LOOPSTRA_SLACK_APP_TOKEN"),
  /** The bot token (xoxb-...) for posting. */
  bot_token_env: envName("LOOPSTRA_SLACK_BOT_TOKEN"),
  channel: channelId,
  allow: ids,
  acceptors: ids,
  announce_to: channelId.optional(),
}).strict();

const discordTransport = z.object({
  token_env: envName("LOOPSTRA_DISCORD_TOKEN"),
  channel: channelId,
  allow: ids,
  acceptors: ids,
  announce_to: channelId.optional(),
}).strict();

const chat = z.object({
  /** The orchestrator's model; the writer uses stages.design.model. */
  model: modelRef.default("default"),
  /** What chat turns and writer runs may spend in a day, together. Unset: no limit. */
  max_budget_usd_per_day: z.number().positive().optional(),
  /** What one chat turn or writer run may hold of that, so others can run at the same time. Unset: no limit. */
  max_budget_usd_per_session: z.number().positive().optional(),
  transports: z.object({
    slack: slackTransport.optional(),
    discord: discordTransport.optional(),
  }).strict().prefault({}),
}).strict();

export type SlackTransportConfig = z.infer<typeof slackTransport>;
export type DiscordTransportConfig = z.infer<typeof discordTransport>;

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
    /** What one session may spend. Unset: no limit (timeout_minutes still ends a session). */
    max_budget_usd: z.number().positive().optional(),
    /** What the loop's sessions (every change's, not chat's) may spend together since local midnight. Unset: no limit. */
    max_budget_usd_per_day: z.number().positive().optional(),
    // Git that only reads: the runtime makes every commit, branch, and merge itself.
    allowed_tools: z.array(z.string()).default(["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"]),
  }).strict().prefault({}),
  // There is no intent gate to set: a person always accepts a change by setting its status to accepted.
  gates: z.object({
    spec: z.object({ human: statusGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
    plan: z.object({ human: statusGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
    merge: z.object({ human: humanGate.default("none"), method: z.enum(["squash", "merge"]).default("squash") }).strict().prefault({}),
    // A pull request cannot confirm a result after the merge either.
    done: z.object({ human: statusGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
  }).strict().prefault({}),
  stages: z.object({
    design: stage.extend({ model: modelRef.default("strong") }).prefault({}),
    plan: stage.extend({ model: modelRef.default("strong") }).prefault({}),
    build: stage.extend({ model: modelRef.default("default"), max_fix_loops: z.number().int().min(1).default(3) }).prefault({}),
    review: stage.extend({ model: modelRef.default("strong"), max_rounds: z.number().int().min(1).default(2) }).prefault({}),
    verify: stage.extend({ model: modelRef.default("default") }).prefault({}),
  }).strict().prefault({}),
  signals: z.object({
    main_health: z.object({ every_minutes: z.number().positive().default(30) }).strict().prefault({}),
  }).strict().prefault({}),
  chat: chat.prefault({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/** What every command but init says in a folder without loopstra/config.yaml. */
export const NOT_SET_UP = "This folder is not set up for Loopstra. Run loopstra init first.";

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
    throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${errorText(e)}`);
  }
  return validateConfig(raw);
}

/** Checks a parsed config against the schema. Throws a ConfigError listing every problem in plain words. */
export function validateConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems: ConfigProblem[] = result.error.issues.map((i) => {
      const path = i.path.map(String);
      const where = path.length ? path.join(".") : "(top level)";
      if (i.code === "unrecognized_keys" && where === "gates" && i.keys.includes("intent")) {
        return { path, unknownKey: true, text: "gates.intent: remove this line; a person always accepts a change by setting its status to accepted." };
      }
      if (i.code === "unrecognized_keys") return { path, unknownKey: true, text: `${where}: unknown key(s) ${i.keys.join(", ")}` };
      return { path, unknownKey: false, text: `${where}: ${i.message}` };
    });
    throw new ConfigError(`loopstra/config.yaml has problems:\n- ${problems.map((p) => p.text).join("\n- ")}`, problems);
  }
  return result.data;
}

/** Resolve a stage's model alias to the CLI model name. */
export type ModelRef = z.infer<typeof modelRef>;

export function modelFor(cfg: Config, ref: ModelRef): string {
  return cfg.claude.models[ref];
}
