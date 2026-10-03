import type { ModelRef } from "../../config";
import { DEFAULTS } from "../defaults";
import type { Section } from "../types";

const REFS = ["default", "cheap", "strong"] as const satisfies readonly ModelRef[];
type Ref = (typeof REFS)[number];
const NAMES = DEFAULTS.claude.models;
const STAGES = Object.entries(DEFAULTS.stages).map(([stage, s]) => [stage, s.model] as const);

/** A model name is one word, like sonnet or claude-opus-5-5. */
const modelName = (s: string) => (/\s/.test(s) ? "A model name has no spaces, like sonnet or claude-opus-5-5." : null);

const isRef = (v: unknown): v is Ref => typeof v === "string" && (REFS as readonly string[]).includes(v);

export const models: Section = {
  name: "models",
  title: "Models",

  async ask(ctx) {
    ctx.ask.say("Three model names Claude Code accepts for --model (an alias like sonnet, or a full model id). Each stage, and chat, uses one of the three; the cheap one also does small jobs, like reading a new change and noting lessons.");
    for (const ref of REFS) {
      const current = ctx.doc.get(["claude", "models", ref]);
      const name = await ctx.ask.text(`The "${ref}" model`, { suggestion: typeof current === "string" && current ? current : NAMES[ref], check: modelName });
      ctx.doc.put(["claude", "models", ref], name, NAMES[ref]);
    }
    for (const [stage, fallback] of STAGES) {
      const current = ctx.doc.get(["stages", stage, "model"]);
      ctx.doc.put(["stages", stage, "model"], await ctx.ask.pick(`Model for the ${stage} stage`, REFS, isRef(current) ? current : fallback), fallback);
    }
    const current = ctx.doc.get(["chat", "model"]);
    ctx.doc.put(["chat", "model"], await ctx.ask.pick("Model for chat's orchestrator", REFS, isRef(current) ? current : DEFAULTS.chat.model), DEFAULTS.chat.model);
  },

  async check() {
    return [];
  },
};
