import { DEFAULTS } from "../defaults";
import type { Section } from "../types";

const STATUS = "they set its status in intent/<change>/intent.md";

const GATES = [
  { gate: "spec", what: "the spec (what will be built)", person: `Should a person approve the spec (what will be built) before work goes on? (yes: ${STATUS}; no: it goes on by itself)` },
  { gate: "plan", what: "the plan (how it will be built)", person: `Should a person approve the plan (how it will be built) before work goes on? (yes: ${STATUS}; no: it goes on by itself)` },
  { gate: "done", what: "the result after merging", person: `Should a person confirm the result after merging? (yes: ${STATUS}; no: it is done by itself)` },
] as const;

export const gates: Section = {
  name: "gates",
  title: "Gates",
  covers: ["gates"],

  async ask(ctx) {
    ctx.ask.say("A person always accepts a change (draft to accepted). After that, each step can wait for a person or go on by itself. The merge gate is under github.");
    for (const { gate, what, person } of GATES) {
      const fallback = DEFAULTS.gates[gate];
      const human = ctx.doc.get(["gates", gate, "human"]) ?? fallback.human;
      const wait = await ctx.ask.yesNo(person, human === "status");
      ctx.doc.put(["gates", gate, "human"], wait ? "status" : "none", fallback.human);
      const agent = await ctx.ask.yesNo(`Does an independent agent review ${what}?`, (ctx.doc.get(["gates", gate, "agent"]) ?? fallback.agent) !== false);
      ctx.doc.put(["gates", gate, "agent"], agent, fallback.agent);
    }
  },

  async check() {
    return [];
  },
};
