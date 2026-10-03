import type { Config } from "../config";
import type { ConfigDocument } from "./document";
import type { Prompt } from "./prompt";

export interface SetupContext {
  root: string;
  /** The config being edited; nothing is written until every section has asked its questions. */
  doc: ConfigDocument;
  ask: Prompt;
  /** Where token variables are read: process.env (tests pass their own). */
  env: Record<string, string | undefined>;
}

/** One line of a check's report. A failed check never undoes a save. */
export interface Check {
  level: "ok" | "warn" | "fail";
  text: string;
}

/** A part of setup. Sections do not depend on each other. */
export interface Section {
  name: string;
  title: string;
  /** Asks its questions and edits ctx.doc, writing only what changed. */
  ask(ctx: SetupContext): Promise<void>;
  /** Read-only checks against the saved config. */
  check(ctx: SetupContext, cfg: Config): Promise<Check[]>;
}
