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
      const person = await ctx.ask.yesNo(`Should a person approve ${what} before work goes on? (yes: they set its status in intent/<change>/intent.md; no: it goes on by itself)`, ctx.doc.get(["gates", gate, "human"]) === "status");
      ctx.doc.put(["gates", gate, "human"], person ? "status" : "none", "none");
      const agent = await ctx.ask.yesNo(`Does an independent agent review ${what}?`, ctx.doc.get(["gates", gate, "agent"]) !== false);
      ctx.doc.put(["gates", gate, "agent"], agent, true);
    }
  },

  async check() {
    return [];
  },
};
