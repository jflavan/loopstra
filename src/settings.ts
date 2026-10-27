import { createHash } from "node:crypto";
import { ConfigError, TEAM_NAME } from "./config";
import { MODEL_REFS, STAGE_NAMES, STEP_KEYS, stepsOf, type StepGroup } from "./models";
import { ConfigDocument } from "./setup/document";
import { modelName } from "./setup/sections/models";

/**
 * The settings the console's Settings page may change (see the `settings` request in src/apply.ts):
 * the model settings and the `agents` block, each written into loopstra/config.yaml through ConfigDocument, so its
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

/** What a setting is set to: a word, a list of words (the agents lists), or null (removed). */
export type SettingValue = string | string[] | null;

/** A value as the trace, a commit subject and a toast say it: a list as `[a, b]`; null, and an empty list (which removes), as the given word. */
export function settingText(value: SettingValue, none: string): string {
  return value === null || (Array.isArray(value) && !value.length) ? none : typeof value === "string" ? value : `[${value.join(", ")}]`;
}

/** The fields of an agent setup (agents.all, agents.steps.<step>) and which hold lists. */
const LIST_FIELDS = ["subagents", "teams", "skills", "tools", "mcp_tools"];
const STEP_FIELDS = ["agent", ...LIST_FIELDS];
const TEAM_FIELDS = ["members", "way"];

/** The steps a group's `steps` map holds: the orchestrator is chat.model itself, not a step of chat's. */
const stepKeys = (group: StepGroup): string[] => stepsOf(group).filter((s) => s.key !== "orchestrator").map((s) => s.key);

/**
 * The path of a writable setting, from its dotted name: `claude.models.<named model>`,
 * `stages.<stage>.model`, `stages.<stage>.steps.<a step of that stage>`, `chat.model` or
 * `chat.steps.write-intent`; or in `agents`: `sources`, `all.<field>`, `steps.<step>[.<field>]` and
 * `teams.<name>[.members|.way]`. Null for anything else.
 */
export function settingPath(dotted: string): string[] | null {
  const p = dotted.split(".");
  const [a, b, c, d] = p;
  if (a === "agents") return agentsPath(p) ? p : null;
  const ok = (p.length === 3 && a === "claude" && b === "models" && (MODEL_REFS as readonly string[]).includes(c!))
    || (a === "stages" && (STAGE_NAMES as readonly string[]).includes(b!) && ((p.length === 3 && c === "model") || (p.length === 4 && c === "steps" && stepKeys(b as StepGroup).includes(d!))))
    || (a === "chat" && ((p.length === 2 && b === "model") || (p.length === 3 && b === "steps" && stepKeys("chat").includes(c!))));
  return ok ? p : null;
}

function agentsPath(p: string[]): boolean {
  const [, b, c, d] = p;
  if (b === "sources") return p.length === 2;
  if (b === "all") return p.length === 3 && STEP_FIELDS.includes(c!);
  if (b === "steps") return (STEP_KEYS as readonly string[]).includes(c!) && (p.length === 3 || (p.length === 4 && STEP_FIELDS.includes(d!)));
  if (b === "teams") return TEAM_NAME.test(c ?? "") && (p.length === 3 || (p.length === 4 && TEAM_FIELDS.includes(d!)));
  return false;
}

/** Why an agents setting cannot take the value, or null. Any may be removed (null). */
function agentsProblem(path: string[], value: SettingValue): string | null {
  if (value === null) return null;
  const name = path.join(".");
  const field = path[path.length - 1]!;
  if ((path[1] === "steps" || path[1] === "teams") && path.length === 3) return `${name} can only be removed.`;
  if (LIST_FIELDS.includes(field) || field === "members") return Array.isArray(value) ? null : `${name} takes a list of names.`;
  return typeof value === "string" ? null : `${name} takes one name.`;
}

/**
 * Why a writable setting cannot take the value, or null when it can. A named model holds any one word
 * (an alias or a full name); a stage, chat or a step holds one of the named models. Only a step may
 * be unset (null): it then runs on its built-in default.
 */
export function settingProblem(path: string[], value: SettingValue): string | null {
  if (path[0] === "agents") return agentsProblem(path, value);
  if (Array.isArray(value)) return `${path.join(".")} takes one word.`;
  if (value === null) return path.includes("steps") ? null : "Only a step's own setting can be removed.";
  if (path[0] === "claude") return modelName(value);
  return (MODEL_REFS as readonly string[]).includes(value) ? null : `A stage, chat or a step runs on one of ${MODEL_REFS.join(", ")}.`;
}

/**
 * The config's text with the setting changed (unset for null), checked the way loading checks it.
 * A problem (the text is not YAML, or the config would not load) is given in words instead.
 */
export function applySetting(file: string, text: string, path: string[], value: SettingValue): { ok: true; text: string } | { ok: false; problem: string } {
  try {
    const doc = ConfigDocument.fromText(file, text);
    // An empty list removes the key, as null does: no `skills: []` is left in the file.
    if (value === null || (path[0] === "agents" && Array.isArray(value) && !value.length)) doc.unset(path);
    else doc.set(path, value, { flow: Array.isArray(value) });
    if (path[0] === "agents") pruneEmpty(doc, path);
    doc.validate();
    return { ok: true, text: doc.text() };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, problem: e.message };
    throw e;
  }
}

/** Removes each map left empty on the way up from the setting (agents.steps.review, agents.steps, agents), so no `{}` stays. */
function pruneEmpty(doc: ConfigDocument, path: string[]): void {
  for (let n = path.length - 1; n >= 1; n--) {
    const v = doc.get(path.slice(0, n));
    if (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) doc.clear(path.slice(0, n));
  }
}
