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
 * check fails, so nothing half-migrated is ever written. A file with no whole-number version, or with
 * a version newer than the migrations reach (written by a later Loopstra), is refused. A file with
 * Windows line endings keeps them (as ConfigDocument does): the YAML library writes `\n`.
 */
export function migrateConfig(text: string, migrations: readonly Migration[] = MIGRATIONS, validate: (text: string) => void): { text: string; from: number; to: number } {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  const from = doc.get("version");
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) throw new ConfigError("loopstra/config.yaml has no valid version");
  const latest = Math.max(1, ...migrations.map((m) => m.from + 1));
  if (from > latest) throw new ConfigError(`loopstra/config.yaml is version ${from}, newer than this Loopstra reads (${latest}); run loopstra upgrade`);
  let version = from;
  for (const m of migrations.filter((m) => m.from >= from).sort((a, b) => a.from - b.from)) {
    if (m.from !== version) continue;
    try { m.run(doc); } catch (e) { throw new ConfigError(`config migration from version ${m.from} failed: ${(e as Error).message}`); }
    version = m.from + 1;
    doc.set("version", version);
  }
  // Windows line endings only when most lines have them, so one stray CRLF does not convert the file.
  const crlf = (text.match(/\r\n/g)?.length ?? 0) * 2 > (text.match(/\n/g)?.length ?? 0);
  const out = version === from ? text : crlf ? doc.toString().replace(/\r?\n/g, "\r\n") : doc.toString();
  validate(out);
  return { text: out, from, to: version };
}
