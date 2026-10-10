import type { Config } from "../../config";
import { DEFAULTS } from "../defaults";
import type { ConfigDocument } from "../document";
import { amountText, DEFAULT_RATE_PER_MINUTE, parseAmount } from "../prompt";
import type { Check, Section } from "../types";

interface Limit {
  path: string[];
  question: string;
  /** A hint in words ("45m", "none"), from claude.timeout_minutes. */
  suggest: (timeoutMinutes: number) => string;
  /** What the old template wrote here, if it wrote anything. */
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

/** "$4.50". */
const usd = (n: number) => `$${n.toFixed(2)}`;

/** "$0.20 a minute". */
const rateText = (rate: number) => `${usd(rate)} a minute`;

/**
 * Whether the limits there are the old template's, not choices anyone made: every one present has
 * the value that template wrote, and there is no loop day limit (which it never wrote).
 */
function oldTemplate(doc: ConfigDocument): boolean {
  const present = LIMITS.filter((l) => doc.get(l.path) !== undefined);
  return present.length > 0 && present.every((l) => l.oldDefault !== undefined && doc.get(l.path) === l.oldDefault);
}

export const budgets: Section = {
  name: "budgets",
  title: "Budgets",
  covers: ["claude.max_budget_usd", "claude.max_budget_usd_per_day", "chat.max_budget_usd_per_day", "chat.max_budget_usd_per_session"],

  async ask(ctx) {
    // Decided once, before any answer changes the limits.
    const old = oldTemplate(ctx.doc);
    /**
     * The limit someone chose, or undefined: unset, the old template's value, or one that would not
     * load (0, a word, or under a parent that is not a map), which Enter must not keep.
     */
    const chosen = (l: Limit) => { const v = ctx.doc.get(l.path); return typeof v === "number" && v > 0 && !old ? v : undefined; };
    ctx.ask.say("Spending limits stop a session (or the loop, or chat, for the rest of the day) at an amount. Unset means no limit; claude.timeout_minutes still ends a session.");
    for (const l of LIMITS) {
      const v = ctx.doc.get(l.path);
      const shown = typeof v === "number" ? `${usd(v)}${old ? " (the old default; the default is now no limit)" : ""}` : "no limit";
      ctx.ask.say(`  ${l.path.join(".")}: ${shown}`);
    }
    const keep = LIMITS.some((l) => chosen(l) !== undefined);
    if (!(await ctx.ask.yesNo("Do you want spending limits?", keep))) {
      for (const l of LIMITS) ctx.doc.clear(l.path);
      return;
    }
    const typing = ctx.ask.interactive ? "; press Enter to keep it or type another rate" : "";
    const rate = dollars(await ctx.ask.text(`Minutes are turned into dollars at ${rateText(DEFAULT_RATE_PER_MINUTE)} (about ${usd(DEFAULT_RATE_PER_MINUTE * 10)} per 10 minutes)${typing}`, {
      suggestion: String(DEFAULT_RATE_PER_MINUTE),
      check: (s) => (dollars(s) > 0 ? null : "Answer a number of dollars, like 0.2."),
    }));
    ctx.ratePerMinute = rate;
    const timeout = Number(ctx.doc.get(["claude", "timeout_minutes"]) ?? DEFAULTS.claude.timeout_minutes);
    for (const l of LIMITS) {
      const hint = l.suggest(timeout);
      const amount = parseAmount(hint, rate);
      // Enter keeps what is there (no limit when unset), so --defaults never adds a limit; the suggestion is a hint.
      const current = chosen(l) ?? "none";
      const question = `${l.question} Suggested: ${typeof amount === "number" ? `${hint} (${usd(amount)})` : "none"}. Enter keeps: ${amountText(current, rate)}.`;
      const a = await ctx.ask.amount(question, { suggestion: current, ratePerMinute: rate });
      if (a === "none") ctx.doc.clear(l.path);
      else ctx.doc.set(l.path, a);
    }
  },

  async check(ctx, cfg) {
    const warnings = limitProblems(cfg, ctx.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE).map((text): Check => ({ level: "warn", text }));
    if (warnings.length) return warnings;
    const set = [cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session, cfg.chat.max_budget_usd_per_day].filter((v) => v !== undefined).length;
    return [{ level: "ok", text: set ? `Budgets: ${set} limit${set > 1 ? "s" : ""} set.` : "Budgets: no limits." }];
  },
};

/** Limits that do not fit the timeout or each other, in words. */
function limitProblems(cfg: Config, rate: number): string[] {
  const problems: string[] = [];
  const { max_budget_usd: session, max_budget_usd_per_day: day, timeout_minutes: minutes } = cfg.claude;
  const { max_budget_usd_per_session: chatSession, max_budget_usd_per_day: chatDay } = cfg.chat;
  const timeoutUsd = minutes * rate;
  if (session !== undefined && session < timeoutUsd) {
    problems.push(`claude.max_budget_usd (${usd(session)}) runs out before claude.timeout_minutes (${minutes} min, about ${usd(timeoutUsd)} at ${rateText(rate)}): a long step stops on the budget first. Raise or remove it with loopstra setup budgets.`);
  }
  if (session !== undefined && day !== undefined && session > day) {
    problems.push(`claude.max_budget_usd (${usd(session)}) is above claude.max_budget_usd_per_day (${usd(day)}): the day's limit stops a session first.`);
  }
  if (chatSession !== undefined && chatDay !== undefined && chatSession > chatDay) {
    problems.push(`chat.max_budget_usd_per_session (${usd(chatSession)}) is above chat.max_budget_usd_per_day (${usd(chatDay)}): the day's limit stops a conversation first.`);
  }
  if (chatDay !== undefined && chatSession === undefined) {
    problems.push(`chat.max_budget_usd_per_day (${usd(chatDay)}) is set without chat.max_budget_usd_per_session: one conversation holds the rest of the day while it answers; set chat.max_budget_usd_per_session so others can run at the same time.`);
  }
  return problems;
}
