import { parseDocument, type Document } from "yaml";
import { ConfigError } from "../config";

/** One step: edits a config document of version `from` into version `from + 1`, keeping its comments. */
export interface Migration {
  from: number;
  run: (doc: Document) => void;
}

/**
 * Every config migration, in order. Empty until a release renames or removes a setting (a new key
 * with a default needs none: the schema fills it in). Add one per version step and bump the
 * `version` literal in src/config.ts's schema and templates/config.yaml with it.
 */
export const MIGRATIONS: readonly Migration[] = [];

/** The config version this Loopstra reads. */
export const CONFIG_VERSION = 1 + MIGRATIONS.length;

/**
 * Applies every migration from the file's version on, then checks the result with `validate` (which
 * throws a ConfigError naming the setting). Throws without returning anything when a step or the
 * check fails, so nothing half-migrated is ever written.
 */
export function migrateConfig(text: string, migrations: readonly Migration[] = MIGRATIONS, validate: (text: string) => void): { text: string; from: number; to: number } {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  const from = Number(doc.get("version") ?? 1);
  let version = from;
  for (const m of migrations.filter((m) => m.from >= from).sort((a, b) => a.from - b.from)) {
    if (m.from !== version) continue;
    try { m.run(doc); } catch (e) { throw new ConfigError(`config migration from version ${m.from} failed: ${(e as Error).message}`); }
    version = m.from + 1;
    doc.set("version", version);
  }
  const out = version === from ? text : doc.toString();
  validate(out);
  return { text: out, from, to: version };
}
