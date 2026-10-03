import { amountText, DEFAULT_RATE_PER_MINUTE, parseAmount } from "../prompt";
import type { Section, SetupContext } from "../types";

interface Limit {
  path: string[];
  question: string;
  /** A hint in words ("45m", "none"), from claude.timeout_minutes. */
  suggest: (timeoutMinutes: number) => string;
  /** What the old template wrote: not a choice anyone made. */
  oldDefault?: number;
}

const LIMITS: Limit[] = [
  { path: ["claude", "max_budget_usd"], question: "What may one loop session spend?", suggest: (t) => `${Math.round(t * 1.5)}m`, oldDefault: 5 },
  { path: ["claude", "max_budget_usd_per_day"], question: "What may the loop spend in a day, all changes together?", suggest: () => "none" },
  { path: ["chat", "max_budget_usd_per_session"], question: "What may one chat turn or write-up spend?", suggest: () => "20m", oldDefault: 2 },
  { path: ["chat", "max_budget_usd_per_day"], question: "What may chat spend in a day, everyone together?", suggest: () => "3h", oldDefault: 5 },
];

/** A rate typed as 0.3 or $0.3 (not a positive number when the answer is not one). */
const dollars = (s: string) => Number(s.trim().replace(/^\$/, ""));

/** "$0.20 a minute". */
const rateText = (rate: number) => `$${rate.toFixed(2)} a minute`;

/** The limit someone chose, or undefined (unset, or the old template's value). */
function chosen(ctx: SetupContext, l: Limit): number | undefined {
  const v = ctx.doc.get(l.path);
  return typeof v === "number" && v !== l.oldDefault ? v : undefined;
}

export const budgets: Section = {
  name: "budgets",
  title: "Budgets",

  async ask(ctx) {
    ctx.ask.say("Spending limits stop a session (or the loop, or chat, for the rest of the day) at an amount. Unset means no limit; claude.timeout_minutes still ends a session.");
    for (const l of LIMITS) {
      const v = ctx.doc.get(l.path);
      const shown = typeof v === "number" ? `$${v}${v === l.oldDefault ? " (the old default; the default is now no limit)" : ""}` : "no limit";
      ctx.ask.say(`  ${l.path.join(".")}: ${shown}`);
    }
    const keep = LIMITS.some((l) => chosen(ctx, l) !== undefined);
    if (!(await ctx.ask.yesNo("Do you want spending limits?", keep))) {
      for (const l of LIMITS) ctx.doc.clear(l.path);
      return;
    }
    const rate = dollars(await ctx.ask.text(`Minutes are turned into dollars at ${rateText(DEFAULT_RATE_PER_MINUTE)} (about $${DEFAULT_RATE_PER_MINUTE * 10} per 10 minutes); press Enter to keep it or type another rate`, {
      suggestion: String(DEFAULT_RATE_PER_MINUTE),
      check: (s) => (dollars(s) > 0 ? null : "Answer a number of dollars, like 0.2."),
    }));
    const timeout = Number(ctx.doc.get(["claude", "timeout_minutes"]) ?? 30);
    for (const l of LIMITS) {
      const hint = l.suggest(timeout);
      const usd = parseAmount(hint, rate);
      // Enter keeps what is there (no limit when unset), so --defaults never adds a limit; the suggestion is a hint.
      const current = chosen(ctx, l) ?? "none";
      const question = `${l.question} Suggested: ${typeof usd === "number" ? `${hint} ($${usd.toFixed(2)})` : "none"}. Enter keeps: ${amountText(current, rate)}.`;
      const a = await ctx.ask.amount(question, { suggestion: current, ratePerMinute: rate });
      if (a === "none") ctx.doc.clear(l.path);
      else ctx.doc.set(l.path, a);
    }
  },

  async check(_ctx, cfg) {
    const session = cfg.claude.max_budget_usd;
    const minutes = cfg.claude.timeout_minutes;
    const timeoutUsd = minutes * DEFAULT_RATE_PER_MINUTE;
    if (session !== undefined && session < timeoutUsd) {
      return [{ level: "warn", text: `claude.max_budget_usd ($${session}) runs out before claude.timeout_minutes (${minutes} min, about $${timeoutUsd.toFixed(2)} at ${rateText(DEFAULT_RATE_PER_MINUTE)}): a long step stops on the budget first. Raise or remove it with loopstra setup budgets.` }];
    }
    const set = [cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session, cfg.chat.max_budget_usd_per_day].filter((v) => v !== undefined).length;
    return [{ level: "ok", text: set ? `Budgets: ${set} limit${set > 1 ? "s" : ""} set.` : "Budgets: no limits." }];
  },
};
