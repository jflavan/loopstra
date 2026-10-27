import type { Config } from "./config";

/** The four named models a step can use; claude.models says which CLI model each one is. */
export const MODEL_REFS = ["cheap", "default", "strong", "max"] as const;
export type ModelRef = (typeof MODEL_REFS)[number];

export const STAGE_NAMES = ["design", "plan", "build", "review", "verify"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** Where a step's setting lives: in its stage's block, or in chat's. */
export type StepGroup = StageName | "chat";

export const STEP_KEYS = [
  "intake", "design", "spec-check", "plan", "plan-challenge", "build", "reconcile", "fix",
  "review", "revise", "verify", "done-check", "lessons", "orchestrator", "write-intent",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

/** A fixed named model, or the model of a stage or of chat. */
type StepDefault = { ref: ModelRef } | { follows: StepGroup };

export interface StepInfo {
  key: StepKey;
  group: StepGroup;
  /** Plain words, for setup and the console. */
  what: string;
  byDefault: StepDefault;
}

/** Every step, in the order setup and the console list them. Each default is the model the step ran on before steps were settable. */
export const STEPS: readonly StepInfo[] = [
  { key: "intake", group: "design", what: "reads a new intent before the spec", byDefault: { ref: "cheap" } },
  { key: "design", group: "design", what: "writes the spec", byDefault: { follows: "design" } },
  { key: "spec-check", group: "design", what: "judges the spec", byDefault: { ref: "strong" } },
  { key: "plan", group: "plan", what: "writes the plan (also the plan written ahead)", byDefault: { follows: "plan" } },
  { key: "plan-challenge", group: "plan", what: "judges the plan", byDefault: { ref: "strong" } },
  { key: "build", group: "build", what: "writes the code", byDefault: { follows: "build" } },
  { key: "reconcile", group: "build", what: "reconciles after the base moved", byDefault: { follows: "build" } },
  { key: "fix", group: "build", what: "fixes after failed checks, and after a failed verify", byDefault: { follows: "build" } },
  { key: "review", group: "review", what: "reviews the code (also the early review)", byDefault: { follows: "review" } },
  { key: "revise", group: "review", what: "changes the code after review findings", byDefault: { follows: "build" } },
  { key: "verify", group: "verify", what: "runs and reads the checks", byDefault: { follows: "verify" } },
  { key: "done-check", group: "verify", what: "judges whether the change did what it said", byDefault: { ref: "strong" } },
  { key: "lessons", group: "verify", what: "notes lessons from the change", byDefault: { ref: "cheap" } },
  { key: "orchestrator", group: "chat", what: "chat's orchestrator", byDefault: { follows: "chat" } },
  { key: "write-intent", group: "chat", what: "writes a new change up as an intent", byDefault: { follows: "design" } },
];

export function stepsOf(group: StepGroup): readonly StepInfo[] {
  return STEPS.filter((s) => s.group === group);
}

/** The parts of a config that say which model runs what, and the agent settings each step's session gets. */
export type ModelSettings = Pick<Config, "claude" | "stages" | "chat" | "agents">;

/** The model of a stage, or of chat's orchestrator. */
export function groupModel(cfg: ModelSettings, group: StepGroup): ModelRef {
  return group === "chat" ? cfg.chat.model : cfg.stages[group].model;
}

/** What a person set for this step, or null when they did not. The orchestrator is chat.model itself, so it is always set. */
export function ownStepModel(cfg: ModelSettings, step: StepKey): ModelRef | null {
  if (step === "orchestrator") return cfg.chat.model;
  const info = STEPS.find((s) => s.key === step)!;
  const steps: Partial<Record<string, ModelRef>> = info.group === "chat" ? cfg.chat.steps : cfg.stages[info.group].steps;
  return steps[step] ?? null;
}

/** The model a step runs on: its own setting, else its built-in default. */
export function stepModel(cfg: ModelSettings, step: StepKey): ModelRef {
  const own = ownStepModel(cfg, step);
  if (own) return own;
  const by = STEPS.find((s) => s.key === step)!.byDefault;
  return "ref" in by ? by.ref : groupModel(cfg, by.follows);
}

/**
 * `base` with every model setting (the names, each stage's model and steps, chat's model and steps)
 * and the agent settings (`agents`) taken from `fresh`.
 */
export function withModels(base: Config, fresh: ModelSettings): Config {
  const stages = { ...base.stages };
  for (const name of STAGE_NAMES) stages[name] = { ...base.stages[name], model: fresh.stages[name].model, steps: fresh.stages[name].steps } as never;
  return {
    ...base,
    claude: { ...base.claude, models: fresh.claude.models },
    stages,
    chat: { ...base.chat, model: fresh.chat.model, steps: fresh.chat.steps },
    agents: fresh.agents,
  };
}

/** What a person is told when Claude Code did not accept a step's model: which setting, and where to change it. */
export function badModelNote(ref: ModelRef, name: string, step: StepKey): string {
  return `\`${ref}\` is \`${name}\`, which Claude Code does not accept as a model (step ${step}). Change it in Settings or \`loopstra setup models\`, then retry.`;
}
