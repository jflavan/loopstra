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
