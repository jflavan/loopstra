import { createHash } from "node:crypto";
import { ConfigError } from "./config";
import { MODEL_REFS, STAGE_NAMES, stepsOf, type StepGroup } from "./models";
import { ConfigDocument } from "./setup/document";
import { modelName } from "./setup/sections/models";

/**
 * The settings the console's Settings page may change (see the `settings` request in src/apply.ts):
 * only the model settings, each written into loopstra/config.yaml through ConfigDocument, so its
 * comments, key order and line endings stay.
 */

/** The file a settings request changes, relative to the repository. */
export const CONFIG_REL = "loopstra/config.yaml";
/** What a settings record is traced and committed under, in place of a change's name: `loopstra(_settings): …`. */
export const SETTINGS_SLUG = "_settings";

/** Why a settings request is refused when the file is not the one the page read (the console and the loop both check). */
export const STALE_SETTINGS = "The settings changed since the page read them (in a terminal, or another tab), so nothing changed. The page shows them as they are now.";

/**
 * The file's version, as the page and the applier compare it: the sha256 (hex) of its text, less one
 * leading byte order mark. The page reads the file as Bun.file(...).text(), which drops the mark, and
 * the applier as a record's draft reads it, which keeps it: both must give the same version.
 */
export function configVersion(text: string): string {
  return createHash("sha256").update(text.startsWith("\uFEFF") ? text.slice(1) : text).digest("hex");
}

/** The steps a group's `steps` map holds: the orchestrator is chat.model itself, not a step of chat's. */
const stepKeys = (group: StepGroup): string[] => stepsOf(group).filter((s) => s.key !== "orchestrator").map((s) => s.key);

/**
 * The path of a writable setting, from its dotted name: `claude.models.<named model>`,
 * `stages.<stage>.model`, `stages.<stage>.steps.<a step of that stage>`, `chat.model` or
 * `chat.steps.write-intent`. Null for anything else.
 */
export function settingPath(dotted: string): string[] | null {
  const p = dotted.split(".");
  const [a, b, c, d] = p;
  const ok = (p.length === 3 && a === "claude" && b === "models" && (MODEL_REFS as readonly string[]).includes(c!))
    || (a === "stages" && (STAGE_NAMES as readonly string[]).includes(b!) && ((p.length === 3 && c === "model") || (p.length === 4 && c === "steps" && stepKeys(b as StepGroup).includes(d!))))
    || (a === "chat" && ((p.length === 2 && b === "model") || (p.length === 3 && b === "steps" && stepKeys("chat").includes(c!))));
  return ok ? p : null;
}

/**
 * Why a writable setting cannot take the value, or null when it can. A named model holds any one word
 * (an alias or a full name); a stage, chat or a step holds one of the named models. Only a step may
 * be unset (null): it then runs on its built-in default.
 */
export function settingProblem(path: string[], value: string | null): string | null {
  if (value === null) return path.includes("steps") ? null : "Only a step's own setting can be removed.";
  if (path[0] === "claude") return modelName(value);
  return (MODEL_REFS as readonly string[]).includes(value) ? null : `A stage, chat or a step runs on one of ${MODEL_REFS.join(", ")}.`;
}

/**
 * The config's text with the setting changed (unset for null), checked the way loading checks it.
 * A problem (the text is not YAML, or the config would not load) is given in words instead.
 */
export function applySetting(file: string, text: string, path: string[], value: string | null): { ok: true; text: string } | { ok: false; problem: string } {
  try {
    const doc = ConfigDocument.fromText(file, text);
    if (value === null) doc.unset(path);
    else doc.set(path, value);
    doc.validate();
    return { ok: true, text: doc.text() };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, problem: e.message };
    throw e;
  }
}
