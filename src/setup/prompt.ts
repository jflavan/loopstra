import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Setup ended without saving: input ran out (Ctrl-D, or Ctrl-Z then Enter on Windows), or --defaults had no answer to give. */
export class SetupStopped extends Error {
  constructor(message = "Setup stopped; nothing was saved.") {
    super(message);
    this.name = "SetupStopped";
  }
}

/** A spending limit in US dollars, or no limit. */
export type Amount = number | "none";

/** What setup converts minutes at unless the person gives another rate: about $2 per 10 minutes. */
export const DEFAULT_RATE_PER_MINUTE = 0.2;

export interface TextOptions {
  /** What Enter takes. */
  suggestion?: string;
  /** May be left empty; "-" empties one that has a suggestion (on a question that needs an answer, it is asked again). */
  optional?: boolean;
  /** A problem with the answer, in words, or null when it is fine. */
  check?: (answer: string) => string | null;
}

/** How a section asks. `close` ends the input (a terminal prompt stops reading); closing again does nothing. */
export interface Prompt {
  say(line: string): void;
  text(question: string, o?: TextOptions): Promise<string>;
  yesNo(question: string, suggestion: boolean): Promise<boolean>;
  pick<T extends string>(question: string, choices: readonly T[], suggestion: T): Promise<T>;
  pickMany<T extends string>(question: string, choices: readonly T[], suggestion: readonly T[]): Promise<T[]>;
  amount(question: string, o: { suggestion: Amount; ratePerMinute: number }): Promise<Amount>;
  close(): void;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "30m", "2h", "$6", "6", "none": dollars (times at `ratePerMinute`) or "none"; null when it is none of those. */
export function parseAmount(answer: string, ratePerMinute: number): Amount | null {
  const a = answer.trim().toLowerCase();
  if (a === "none") return "none";
  const time = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(a);
  const usd = /^\$?(\d+(?:\.\d+)?)$/.exec(a);
  const dollars = time ? Number(time[1]) * (time[2]!.startsWith("h") ? 60 : 1) * ratePerMinute : usd ? Number(usd[1]) : NaN;
  const rounded = round2(dollars);
  return rounded > 0 ? rounded : null;
}

/** "$9.00 (about 45 min)", "$0.10 (under 1 min)", or "no limit". */
export function amountText(a: Amount, ratePerMinute: number): string {
  if (a === "none") return "no limit";
  const minutes = a / ratePerMinute;
  return `$${a.toFixed(2)} (${minutes < 1 ? "under 1 min" : `about ${Math.round(minutes)} min`})`;
}

/** Questions over a stream (a terminal): one line per answer. A bad answer is asked again. */
export class StreamPrompt implements Prompt {
  private readonly rl: Interface;
  private readonly lines: AsyncIterator<string>;

  constructor(input: Readable, private readonly output: Writable) {
    this.rl = createInterface({ input, terminal: false });
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  say(line: string): void {
    this.output.write(`${line}\n`);
  }

  private async answer(question: string, shown: string | undefined): Promise<string> {
    this.output.write(`${question}${shown ? ` [${shown}]` : ""}: `);
    const next = await this.lines.next();
    if (next.done) {
      this.output.write("\n");
      throw new SetupStopped();
    }
    return next.value.trim();
  }

  async text(question: string, o: TextOptions = {}): Promise<string> {
    for (;;) {
      const a = await this.answer(question, o.suggestion);
      if (a === "-") {
        if (o.optional) return "";
        this.say("  An answer is needed.");
        continue;
      }
      const value = a || o.suggestion || "";
      if (!value) {
        if (o.optional) return "";
        this.say("  An answer is needed.");
        continue;
      }
      const problem = o.check?.(value) ?? null;
      if (!problem) return value;
      this.say(`  ${problem}`);
    }
  }

  async yesNo(question: string, suggestion: boolean): Promise<boolean> {
    for (;;) {
      const a = (await this.answer(question, suggestion ? "Y/n" : "y/N")).toLowerCase();
      if (!a) return suggestion;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      this.say("  Answer y or n.");
    }
  }

  async pick<T extends string>(question: string, choices: readonly T[], suggestion: T): Promise<T> {
    for (;;) {
      const a = (await this.answer(`${question} (${choices.join(" / ")})`, suggestion)).toLowerCase();
      if (!a) return suggestion;
      const hit = choices.find((c) => c.toLowerCase() === a);
      if (hit) return hit;
      this.say(`  Answer one of: ${choices.join(", ")}.`);
    }
  }

  async pickMany<T extends string>(question: string, choices: readonly T[], suggestion: readonly T[]): Promise<T[]> {
    for (;;) {
      const a = (await this.answer(`${question} (any of ${choices.join(", ")}, separated by commas; - for none)`, suggestion.join(", ") || "-")).toLowerCase();
      if (!a) return [...suggestion];
      if (a === "-") return [];
      const parts = a.split(",").map((p) => p.trim()).filter(Boolean);
      const unknown = parts.filter((p) => !choices.some((c) => c.toLowerCase() === p));
      if (!unknown.length) return choices.filter((c) => parts.includes(c.toLowerCase()));
      this.say(`  Not a choice: ${unknown.join(", ")}.`);
    }
  }

  async amount(question: string, o: { suggestion: Amount; ratePerMinute: number }): Promise<Amount> {
    for (;;) {
      const a = await this.answer(`${question} (minutes like 30m, dollars like $6, or none)`, amountText(o.suggestion, o.ratePerMinute));
      if (!a) return o.suggestion;
      const v = parseAmount(a, o.ratePerMinute);
      if (v !== null) return v;
      this.say("  Answer a time (30m, 2h), an amount ($6), or none.");
    }
  }

  close(): void {
    this.rl.close();
  }
}

/** --defaults: every question takes its suggestion, and says what it took. */
export class DefaultsPrompt implements Prompt {
  constructor(private readonly out: (line: string) => void) {}

  say(line: string): void {
    this.out(line);
  }

  private took<T>(question: string, shown: string, value: T): T {
    this.out(`${question}: ${shown}`);
    return value;
  }

  async text(question: string, o: TextOptions = {}): Promise<string> {
    if (o.suggestion) return this.took(question, o.suggestion, o.suggestion);
    if (o.optional) return this.took(question, "(empty)", "");
    throw new SetupStopped(`--defaults has no answer for "${question}". Set it in loopstra/config.yaml, or run loopstra setup in a terminal. Nothing was saved.`);
  }

  async yesNo(question: string, suggestion: boolean): Promise<boolean> {
    return this.took(question, suggestion ? "yes" : "no", suggestion);
  }

  async pick<T extends string>(question: string, _choices: readonly T[], suggestion: T): Promise<T> {
    return this.took(question, suggestion, suggestion);
  }

  async pickMany<T extends string>(question: string, _choices: readonly T[], suggestion: readonly T[]): Promise<T[]> {
    return this.took(question, suggestion.join(", ") || "none", [...suggestion]);
  }

  async amount(question: string, o: { suggestion: Amount; ratePerMinute: number }): Promise<Amount> {
    return this.took(question, amountText(o.suggestion, o.ratePerMinute), o.suggestion);
  }

  close(): void {}
}
