import type { ModelRef } from "../../config";
import { MODEL_REFS, STAGE_NAMES, stepsOf, type StepGroup, type StepInfo } from "../../models";
import { DEFAULTS } from "../defaults";
import type { Section } from "../types";
import type { ConfigDocument } from "../document";
import type { Prompt } from "../prompt";

const NAMES = DEFAULTS.claude.models;

/** The word that removes a step's own setting (`default` is already the name of a model). */
const AUTO = "auto";

/** The longest model name taken; a real one is far shorter. */
const MAX_NAME = 200;

/**
 * Why a model name cannot be taken, or null: it is one word, like sonnet or claude-opus-5-5. It is
 * passed to `claude --model`, so it never starts with - (it would read as a flag), holds no control
 * character, and is at most MAX_NAME characters.
 */
export function modelName(s: string): string | null {
  if (/\s/.test(s)) return "A model name has no spaces, like sonnet or claude-opus-5-5.";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return "A model name has only printable characters, like sonnet or claude-opus-5-5.";
  if (s.startsWith("-")) return "A model name does not start with -, like sonnet or claude-opus-5-5.";
  return s.length > MAX_NAME ? `A model name is at most ${MAX_NAME} characters long.` : null;
}

const isRef = (v: unknown): v is ModelRef => typeof v === "string" && (MODEL_REFS as readonly string[]).includes(v);

/** What a step runs on when it has no setting of its own, in words. */
const byDefaultText = (s: StepInfo) => ("ref" in s.byDefault ? s.byDefault.ref : `follows ${s.byDefault.follows}`);

/** The group's model (a stage's, or chat's), then, if asked, each of its steps. The orchestrator is chat's model itself, so it is not asked twice. */
async function askGroup(ask: Prompt, doc: ConfigDocument, group: StepGroup): Promise<void> {
  const base: readonly string[] = group === "chat" ? ["chat"] : ["stages", group];
  const label = group === "chat" ? "chat's orchestrator" : `the ${group} stage`;
  const fallback = group === "chat" ? DEFAULTS.chat.model : DEFAULTS.stages[group].model;
  const current = doc.get([...base, "model"]);
  doc.put([...base, "model"], await ask.pick(`Model for ${label}`, MODEL_REFS, isRef(current) ? current : fallback), fallback);

  const steps = stepsOf(group).filter((s) => s.key !== "orchestrator");
  if (!(await ask.yesNo(`Choose models for ${group}'s steps one by one?`, false))) return;
  for (const step of steps) {
    const own = doc.get([...base, "steps", step.key]);
    const choice = await ask.pick(`Model for ${step.key} (${step.what}; ${AUTO} = ${byDefaultText(step)})`, [AUTO, ...MODEL_REFS], isRef(own) ? own : AUTO);
    if (choice === AUTO) doc.unset([...base, "steps", step.key]);
    else doc.put([...base, "steps", step.key], choice, undefined);
  }
}

export const models: Section = {
  name: "models",
  title: "Models",
  covers: ["claude.models", "stages.*.model", "stages.*.steps", "chat.model", "chat.steps"],

  async ask(ctx) {
    ctx.ask.say("Four model names Claude Code accepts for --model (an alias like sonnet, or a full model id). An alias (haiku, sonnet, opus, fable) follows Claude Code to the newest model of its family; a full name like claude-opus-5-5 pins one. Each stage, and chat, uses one of the four; the cheap one also does small jobs, like reading a new change and noting lessons.");
    for (const ref of MODEL_REFS) {
      const current = ctx.doc.get(["claude", "models", ref]);
      const name = await ctx.ask.text(`The "${ref}" model`, { suggestion: typeof current === "string" && current ? current : NAMES[ref], check: modelName });
      ctx.doc.put(["claude", "models", ref], name, NAMES[ref]);
    }
    for (const stage of STAGE_NAMES) await askGroup(ctx.ask, ctx.doc, stage);
    await askGroup(ctx.ask, ctx.doc, "chat");
  },

  async check() {
    return [];
  },
};
