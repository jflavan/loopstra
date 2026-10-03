import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { configPath, loadConfig } from "../src/config";
import { ConfigDocument } from "../src/setup/document";
import { DefaultsPrompt, StreamPrompt } from "../src/setup/prompt";
import type { Check, Section } from "../src/setup/types";
import { tempDir } from "./helpers";

/** A StreamPrompt that reads these answers, one per line, and records what it showed. */
export function scripted(...answers: string[]): { prompt: StreamPrompt; shown: () => string } {
  let shown = "";
  const output = new Writable({ write(chunk, _encoding, done) { shown += String(chunk); done(); } });
  const prompt = new StreamPrompt(Readable.from(answers.map((a) => `${a}\n`)), output);
  return { prompt, shown: () => shown };
}

/** A folder with only loopstra/config.yaml (no git), for sections that only edit. */
export function configRepo(yaml: string): { root: string; cleanup: () => void; text: () => string } {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  writeFileSync(configPath(t.path), yaml);
  return { root: t.path, cleanup: t.cleanup, text: () => readFileSync(configPath(t.path), "utf8") };
}

/** Runs one section's questions with these answers (or --defaults), saves, and returns the file and what was shown. */
export async function askSection(section: Section, root: string, answers: string[] | "defaults", env: Record<string, string | undefined> = {}): Promise<{ text: string; shown: string }> {
  const doc = ConfigDocument.load(root);
  const lines: string[] = [];
  const s = answers === "defaults" ? null : scripted(...answers);
  const ask = s ? s.prompt : new DefaultsPrompt((l) => lines.push(l));
  try { await section.ask({ root, doc, ask, env }); } finally { ask.close(); }
  doc.save();
  return { text: readFileSync(configPath(root), "utf8"), shown: s ? s.shown() : lines.join("\n") };
}

/** One section's checks against the config on disk. */
export async function checkSection(section: Section, root: string, env: Record<string, string | undefined> = {}): Promise<Check[]> {
  return section.check({ root, doc: ConfigDocument.load(root), ask: new DefaultsPrompt(() => {}), env }, await loadConfig(root));
}
