import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { BUILTIN_AGENTS, CONTINUES_BUILD, TEAM_WAYS, toolRuleProblem } from "./agents";
import { MODEL_REFS, STEP_KEYS, stepsOf, type ModelRef, type StepKey, type StageName, type StepGroup } from "./models";
import { errorText } from "./shell";

/** One thing wrong with a config: where (["claude", "timeout_minutes"]), and in words. */
interface ConfigProblem {
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
const modelRef = z.enum(MODEL_REFS);

type Steps = Partial<Record<string, ModelRef>>;

/** Each step of a group may name its own model; unset, the step's built-in default applies (see STEPS). */
const stepModels = (group: StepGroup) =>
  z.object(Object.fromEntries(stepsOf(group).filter((s) => s.key !== "orchestrator").map((s) => [s.key, modelRef.optional()]))).strict().prefault({}) as unknown as z.ZodPrefault<z.ZodType<Steps, Steps>>;

const stage = (name: StageName) => z.object({
  model: modelRef,
  steps: stepModels(name),
  skills: z.array(z.string()).default([]),
  before: z.array(z.string()).default([]),
  after: z.array(z.string()).default([]),
}).strict();

const ID_PROBLEM = "must be a user or channel id; put long numeric ids in quotes";
/** A platform id (user or channel). Long numeric ids (Discord's) lose digits as YAML numbers, so those must be quoted. */
const platformId = z.union([z.string(), z.number()], { error: ID_PROBLEM })
  .refine((v) => (typeof v === "string" ? v.length > 0 : Number.isSafeInteger(v)), ID_PROBLEM)
  .transform(String);
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
  /** The orchestrator's model; write-intent is chat.steps (default: stages.design.model). */
  model: modelRef.default("default"),
  steps: stepModels("chat"),
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

/** True when a value has more than spaces in it. */
const filled = (s: string) => s.trim() !== "";
const TEST_REQUIRED = "commands.test is required: the single command that runs your tests";
/**
 * An optional project command. Empty (`lint: ""`) is none, as every reader takes it and as configs
 * written before the blank-name rule have it. One of only spaces would be run as a command, so it is
 * a mistake and is refused.
 */
const command = z.preprocess((v) => (v === "" ? undefined : v), z.string().refine(filled, "must be a command, or the line removed").optional());
/** The CLI name of a model, like sonnet. Spaces around it are not part of it. */
const modelName = (fallback: string) => z.string().trim().min(1, "must be a model name").default(fallback);

/** How long the loop waits between ticks when the config does not say (or cannot be loaded). */
export const DEFAULT_POLL_SECONDS = 60;

/** An MCP allow rule: `mcp__<server>` or `mcp__<server>__<tool>`. */
export const MCP_RULE = /^mcp__[\w*-]+$/;
export const MCP_RULE_TEXT = "must be an MCP rule, like mcp__github or mcp__github__get_issue";
const mcpRule = z.string().regex(MCP_RULE, MCP_RULE_TEXT);
const nameList = z.array(z.string().trim().min(1, "must be a name")).default([]);

const stepAgents = z.object({
  /** The agent this step runs as. Unset: no agent. */
  agent: z.string().trim().min(1, "must be an agent name").optional(),
  subagents: nameList,
  teams: nameList,
  skills: nameList,
  /** Tool allow rules added to this step's own. */
  tools: z.array(z.string()).default([]),
  /**
   * MCP allow rules (`mcp__<server>` or `mcp__<server>__<tool>`). No commas or spaces: the list
   * reaches the CLI joined with commas.
   */
  mcp_tools: z.array(mcpRule).default([]),
}).strict();

/** One step's agent setup, or what `agents.all` gives every step. */
export type StepAgents = z.infer<typeof stepAgents>;

const agents = z.object({
  sources: z.enum(["all", "repo"], { error: "must be all or repo" }).default("all"),
  teams: z.record(z.string(), z.object({
    members: z.array(z.string().trim().min(1, "must be an agent name")).min(1, "a team needs at least one member"),
    way: z.enum(TEAM_WAYS).default("parallel"),
  }).strict()).default({}),
  all: stepAgents.prefault({}),
  steps: z.record(z.string(), stepAgents).default({}),
}).strict().superRefine((a, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  for (const name of Object.keys(a.teams)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) bad(["teams", name], "a team name is lowercase words joined by dashes");
  }
  const tools = (path: string[], set: StepAgents, where: StepKey | "all") => {
    set.tools.forEach((rule, i) => {
      const problem = toolRuleProblem(rule, where);
      if (problem) bad([...path, "tools", i], problem);
    });
    set.teams.forEach((t, i) => {
      if (!Object.hasOwn(a.teams, t)) bad([...path, "teams", i], `there is no team ${t} under agents.teams`);
    });
    // A built-in's fixed tool list has no StructuredOutput, so a step running as one could not report.
    if (set.agent !== undefined && BUILTIN_AGENTS.has(set.agent)) {
      bad([...path, "agent"], `${set.agent} is a built-in agent; a step runs as an agent defined in .claude/agents/ (built-ins can be subagents)`);
    }
  };
  tools(["all"], a.all, "all");
  for (const [step, set] of Object.entries(a.steps)) {
    if (!(STEP_KEYS as readonly string[]).includes(step)) {
      bad(["steps"], `unknown step ${step}; the steps are ${STEP_KEYS.join(", ")}`);
      continue;
    }
    const key = step as StepKey;
    if (set.agent !== undefined && CONTINUES_BUILD.has(key)) {
      bad(["steps", step, "agent"], `${step} continues the build session and runs as the build's agent; set the agent on build`);
    }
    tools(["steps", step], set, key);
  }
});

export const ConfigSchema = z.object({
  version: z.literal(1, { error: "must be 1" }),
  main_branch: z.string().trim().min(1, "must be a branch name, like main").default("main"),
  poll_seconds: z.number().int().positive().default(DEFAULT_POLL_SECONDS),
  // Empty prefault is deliberate: a missing `commands` block should still report `commands.test`, not `commands`.
  commands: z.object({
    test: z.string({ error: TEST_REQUIRED }).refine(filled, TEST_REQUIRED),
    lint: command,
    build: command,
    run: command,
    install: command,
  }).strict().prefault({} as { test: string }),
  claude: z.object({
    models: z.object({
      default: modelName("sonnet"),
      cheap: modelName("haiku"),
      strong: modelName("opus"),
      max: modelName("fable"),
    }).strict().prefault({}),
    timeout_minutes: z.number().positive().default(30),
    /** What one session may spend. Unset: no limit (timeout_minutes still ends a session). */
    max_budget_usd: z.number().positive().optional(),
    /** What the loop's sessions (every change's, not chat's) may spend together since local midnight. Unset: no limit. */
    max_budget_usd_per_day: z.number().positive().optional(),
    // Git that only reads: the runtime makes every commit, branch, and merge itself.
    allowed_tools: z.array(z.string()).default(["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"]),
  }).strict().prefault({}),
  agents: agents.prefault({}),
  // There is no intent gate to set: a person always accepts a change by setting its status to accepted.
  gates: z.object({
    spec: z.object({ human: statusGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
    plan: z.object({ human: statusGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
    merge: z.object({ human: humanGate.default("none"), method: z.enum(["squash", "merge"]).default("squash") }).strict().prefault({}),
    // A pull request cannot confirm a result after the merge either.
    done: z.object({ human: statusGate.default("none"), agent: z.boolean().default(true) }).strict().prefault({}),
  }).strict().prefault({}),
  stages: z.object({
    design: stage("design").extend({ model: modelRef.default("strong") }).prefault({}),
    plan: stage("plan").extend({ model: modelRef.default("strong") }).prefault({}),
    build: stage("build").extend({ model: modelRef.default("default"), max_fix_loops: z.number().int().min(1).default(3) }).prefault({}),
    review: stage("review").extend({ model: modelRef.default("strong"), max_rounds: z.number().int().min(1).default(2) }).prefault({}),
    verify: stage("verify").extend({ model: modelRef.default("default") }).prefault({}),
  }).strict().prefault({}),
  // Work that runs at the same time to save waiting. Only cheap_judges: first changes who decides: once earned, a cheaper judge's pass stands.
  speed: z.object({
    /** Test, lint, and build commands start together; off because some projects' commands share an output folder. */
    parallel_checks: z.boolean().default(false),
    /** The first review runs alongside the verifier, and lessons alongside the done-check. */
    overlap_judges: z.boolean().default(true),
    /** The first plan is written while the spec's check runs; kept only if the spec passes, used only if the code it read is unchanged. */
    plan_ahead: z.boolean().default(true),
    /** A cheaper judge (claude.models.default) for the spec check, plan challenge and review. off: none. shadow: it judges alongside the strong judge and is only recorded. first: it decides a pass alone once its record has earned it. */
    cheap_judges: z.enum(["off", "shadow", "first"], { error: "must be off, shadow or first" }).default("off"),
    /** Design and plan steps (which run none of the project's commands) also run, one at a time, beside the changes running a step. */
    think_ahead: z.boolean().default(true),
    /** How many changes may each run a step at the same time. 1 = one at a time (as before). */
    max_parallel_changes: z.number().int("must be a whole number").min(1, "must be 1 or more").max(4, "must be 4 or less").default(1),
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
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (e) {
    throw new ConfigError(`loopstra/config.yaml cannot be read: ${errorText(e)}`);
  }
  return parseConfig(text);
}

/** The config in config.yaml's text. Throws a ConfigError when it is not YAML or not a valid config. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (e) {
    throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${errorText(e)}`);
  }
  return validateConfig(raw);
}

/** The configured poll_seconds, or the default when the config cannot be loaded. */
export function loopPollSeconds(root: string): Promise<number> {
  return loadConfig(root).then((c) => c.poll_seconds, () => DEFAULT_POLL_SECONDS);
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
      // A message that already names its path ("commands.test is required: ...") is not prefixed again.
      return { path, unknownKey: false, text: i.message.startsWith(`${where} `) ? i.message : `${where}: ${i.message}` };
    });
    throw new ConfigError(`loopstra/config.yaml has problems:\n- ${problems.map((p) => p.text).join("\n- ")}`, problems);
  }
  return result.data;
}

export type { ModelRef };

/** Resolve a model alias to the CLI model name. */
export function modelFor(cfg: Pick<Config, "claude">, ref: ModelRef): string {
  return cfg.claude.models[ref];
}
