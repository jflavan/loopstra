import { existsSync } from "node:fs";
import { ConfigError, configPath, modelFor, parseConfig, type Config } from "../config";
import { groupModel, MODEL_REFS, ownStepModel, STAGE_NAMES, stepModel, stepsOf, type StepGroup } from "../models";
import { configVersion } from "../settings";
import type { Trace } from "../trace";
import type { SettingsView } from "./types";

const GROUPS: readonly StepGroup[] = [...STAGE_NAMES, "chat"];

/** Where a group's model, or one of its steps, is set (see settingPath). */
const groupPath = (g: StepGroup) => (g === "chat" ? "chat.model" : `stages.${g}.model`);
const stepPath = (g: StepGroup, key: string) => (g === "chat" ? `chat.steps.${key}` : `stages.${g}.steps.${key}`);

/**
 * loopstra/config.yaml for a settings view, read once so its version and its values come from the
 * same text; or why it cannot be used, in words (with the version when the file could be read).
 */
export async function readConfig(root: string): Promise<{ cfg: Config; version: string } | { version: string | null; problem: string }> {
  const path = configPath(root);
  if (!existsSync(path)) return { version: null, problem: "There is no loopstra/config.yaml. Run `loopstra init` first." };
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return { version: null, problem: "loopstra/config.yaml cannot be read." }; }
  const version = configVersion(text);
  try {
    return { cfg: parseConfig(text), version };
  } catch (e) {
    if (e instanceof ConfigError) return { version, problem: e.message };
    throw e;
  }
}

/**
 * What the Settings page shows. The file is read once, so its version and the values come from the
 * same text. A file that cannot be read or does not load gives a problem in words and no pickers.
 */
export async function settingsView(root: string, trace: Trace): Promise<SettingsView> {
  const loaded = await readConfig(root);
  if ("problem" in loaded) return { version: loaded.version, problem: loaded.problem, models: [], groups: [] };
  const { cfg, version } = loaded;
  const runs = trace.lastModelRuns();
  return {
    version,
    problem: null,
    models: MODEL_REFS.map((ref) => {
      const run = runs[ref];
      return { ref, name: modelFor(cfg, ref), last: run ? { asked: run.asked, ran: run.ran, result: run.result, ts: run.ts } : null };
    }),
    groups: GROUPS.map((group) => ({
      group,
      model: groupModel(cfg, group),
      path: groupPath(group),
      steps: stepsOf(group).map((s) => ({
        key: s.key,
        what: s.what,
        path: s.key === "orchestrator" ? null : stepPath(group, s.key),
        own: ownStepModel(cfg, s.key),
        effective: stepModel(cfg, s.key),
        byDefault: "ref" in s.byDefault ? s.byDefault.ref : `follows ${s.byDefault.follows}: ${groupModel(cfg, s.byDefault.follows)}`,
      })),
    })),
  };
}
