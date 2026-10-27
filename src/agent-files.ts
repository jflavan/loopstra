import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { BUILTIN_AGENTS, CONTINUES_BUILD, inlineName, type AgentSetup } from "./agents";
import type { RunPhaseInput } from "./claude";
import type { Config } from "./config";
import type { Git } from "./git";
import { STAGE_NAMES, STEP_KEYS, type StageName, type StepKey } from "./models";

/** An agent definition read from a Claude Code agent file. */
export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools: string[] | null;
  model: string | null;
  skills: string[] | null;
  /** Frontmatter keys Loopstra does not carry over, in file order. */
  dropped: string[];
  from: "repo" | "personal" | "plugin";
  path: string;
}

/**
 * Where to look: `repo` is a checkout of main (the step's snapshot, or the root). With `commit`, the
 * repository's agent files are read from that commit instead of `repo`'s files, so a session that may
 * write `repo` cannot change what a later session of the step runs as; its skills are still `repo`'s.
 */
export interface Where { repo: string; home: string; sources: "all" | "repo"; commit?: { git: Git; sha: string } }

const KEPT = new Set(["name", "description", "tools", "model", "skills", "color", "source"]);
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** A comma-separated string or a list as a list of names; null when absent or empty. */
function names(v: unknown): string[] | null {
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  const out = list.filter((x): x is string | number => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : null;
}

/** Parses an agent file: frontmatter via yaml (CRLF fine, a byte order mark fine, none is fine), the body as the prompt. */
export function parseAgentFile(name: string, file: string, from: AgentDefinition["from"], path: string): AgentDefinition {
  const text = file.replace(/^\uFEFF/, "");
  const m = FRONTMATTER.exec(text);
  let front: Record<string, unknown> = {};
  if (m) {
    try {
      const v: unknown = parse(m[1] ?? "");
      if (v && typeof v === "object" && !Array.isArray(v)) front = v as Record<string, unknown>;
    } catch { /* unreadable frontmatter counts as none */ }
  }
  const body = m ? (m[2] ?? "") : text;
  return {
    name,
    description: typeof front.description === "string" ? front.description.trim() : "",
    prompt: body.trim(),
    tools: names(front.tools),
    model: typeof front.model === "string" && front.model.trim() ? front.model.trim() : null,
    skills: names(front.skills),
    dropped: Object.keys(front).filter((k) => !KEPT.has(k)),
    from,
    path,
  };
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The installed and enabled plugins: the short name (before the `@`) and the install folder of each. */
export function enabledPlugins(home: string): Array<{ plugin: string; installPath: string }> {
  const installed = readJson(join(home, ".claude/plugins/installed_plugins.json"))?.plugins;
  const enabled = readJson(join(home, ".claude/settings.json"))?.enabledPlugins;
  if (!installed || typeof installed !== "object" || !enabled || typeof enabled !== "object") return [];
  const out: Array<{ plugin: string; installPath: string }> = [];
  for (const [key, entries] of Object.entries(installed)) {
    if (!key.includes("@") || (enabled as Record<string, unknown>)[key] !== true || !Array.isArray(entries)) continue;
    const path = (entries[0] as { installPath?: unknown } | undefined)?.installPath;
    if (typeof path === "string") out.push({ plugin: key.slice(0, key.indexOf("@")), installPath: path });
  }
  return out;
}

/** The install folder of an installed and enabled plugin, by its short name (before the `@`). */
function pluginRoot(plugin: string, home: string): string | null {
  return enabledPlugins(home).find((p) => p.plugin === plugin)?.installPath ?? null;
}

/** A place a definition may live: its file, and for the repository's, its path in the repository (with `/`). */
type Candidate = { from: AgentDefinition["from"]; path: string; inRepo?: string };

/** The places a definition may live, in lookup order, for a file under `<base>/<dir>/…`. */
function candidates(name: string, where: Where, file: (n: string) => string, dir: string): Candidate[] {
  const colon = name.indexOf(":");
  const local = colon < 0 ? name : null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return [];
  const out: Candidate[] = [];
  if (local !== null) out.push({ from: "repo", path: join(where.repo, ".claude", dir, file(local)), inRepo: `.claude/${dir}/${file(local)}` });
  if (where.sources !== "all") return out;
  if (local !== null) out.push({ from: "personal", path: join(where.home, ".claude", dir, file(local)) });
  else {
    const root = pluginRoot(name.slice(0, colon), where.home);
    if (root) out.push({ from: "plugin", path: join(root, dir, file(name.slice(colon + 1))) });
  }
  return out;
}

/**
 * The agent definition for a name (`agent` or `plugin:agent`), or null when none is found. Built-in
 * agents are the caller's to skip. A repository's file is read from `where.commit` when there is one
 * (its path is then `<commit>:<path>`), else from `where.repo`.
 */
export async function findAgent(name: string, where: Where): Promise<AgentDefinition | null> {
  for (const c of candidates(name, where, (n) => `${n}.md`, "agents")) {
    const commit = c.inRepo !== undefined && where.commit ? { ...where.commit, object: `${where.commit.sha}:${c.inRepo}` } : null;
    const path = commit?.object ?? c.path;
    const text = commit ? await committedText(commit.git, commit.object) : readText(path);
    if (text !== null) return parseAgentFile(name, text, c.from, path);
  }
  return null;
}

/** A file of a commit (`<commit>:<path>`), or null when the commit has no such file. */
async function committedText(git: Git, object: string): Promise<string | null> {
  const r = await git.run(["cat-file", "blob", object], { allowFail: true });
  return r.code === 0 ? r.out : null;
}

/** Where a skill (`skill` or `plugin:skill`) lives, or null when it is not found. */
export async function findSkill(name: string, where: Where): Promise<AgentDefinition["from"] | null> {
  for (const c of candidates(name, where, (n) => `${n}/SKILL.md`, "skills")) {
    if (readText(c.path) !== null) return c.from;
  }
  return null;
}

/**
 * Something wrong, or doubtful, about a name a config uses, under where the config sets it: a step,
 * all steps (`agents.all`), or a stage's skills (`stage <name>`).
 */
export interface SetupProblem { level: "fail" | "warn"; step: StepKey | "all" | `stage ${StageName}`; name: string; text: string }

/**
 * Every agent a setup names, each once with the first part it plays: the agent `who` runs as, a
 * subagent, a team's member. Built-in agents included. `who` is a step, or how all steps are named.
 */
function setupRoles(setup: { agent: string | null; subagents: readonly string[]; teams: readonly { name: string; members: readonly string[] }[] }, who: string): { name: string; role: string }[] {
  const roles: { name: string; role: string }[] = [
    ...(setup.agent ? [{ name: setup.agent, role: `the agent ${who} runs as` }] : []),
    ...setup.subagents.map((name) => ({ name, role: `a subagent of ${who}` })),
    ...setup.teams.flatMap((t) => t.members.map((name) => ({ name, role: `in the team ${t.name} of ${who}` }))),
  ];
  const seen = new Set<string>();
  return roles.filter(({ name }) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Where a named agent was looked for, in words: "on main", and "or on this machine" with `sources: all`. */
function placesText(mainBranch: string, where: Where): string {
  return `on ${mainBranch}${where.sources === "all" ? " or on this machine" : ""}`;
}

/** What follows a plugin's name (`plugin:name`) that is not found, when plugins are looked in: it may be installed but not enabled. */
function pluginHint(name: string, where: Where): string {
  return name.includes(":") && where.sources === "all" ? "; if it comes from a plugin, enable the plugin in Claude Code" : "";
}

/** What a person is told about a named agent that is not found. */
function missingAgentText(name: string, role: string, mainBranch: string, where: Where): string {
  return `\`${name}\`, ${role}, is not in .claude/agents/ ${placesText(mainBranch, where)}${pluginHint(name, where)}. Add it with \`loopstra setup agents\`, or commit it.`;
}

/**
 * Every agent, subagent, team member and skill the steps would use, checked against `where`, each
 * where the config sets it, so one name is told once however many steps get it: what all steps get
 * (`agents.all`) under "all", a stage's skills under "stage <name>" (those all steps do not already
 * get), and what a step sets itself under that step. One problem per name per place: missing, else
 * only on this machine, else keys Loopstra leaves out. The steps that continue the build's session
 * run as build's agent, so their own is not checked.
 */
export async function checkAgentSetup(cfg: Config, where: Where): Promise<SetupProblem[]> {
  const problems: SetupProblem[] = [];
  const said = (step: SetupProblem["step"]) => (step === "all" ? "all steps" : step);
  const checkAgent = async (name: string, role: string, step: SetupProblem["step"]) => {
    if (BUILTIN_AGENTS.has(name)) return;
    const def = await findAgent(name, where);
    if (!def) {
      problems.push({ level: "fail", step, name, text: missingAgentText(name, role, cfg.main_branch, where) });
    } else if (def.from !== "repo") {
      problems.push({ level: "warn", step, name, text: `\`${name}\` (${said(step)}) is only on this machine, so a loop running elsewhere will not have it.` });
    } else if (def.dropped.length) {
      problems.push({ level: "warn", step, name, text: `${def.path}: Loopstra leaves out ${def.dropped.join(", ")} when it runs this agent.` });
    }
  };
  const checkSkill = async (name: string, step: SetupProblem["step"]) => {
    const from = await findSkill(name, where);
    if (from === null) {
      problems.push({ level: "warn", step, name, text: `The skill \`${name}\` (${said(step)}) is not in .claude/skills/${where.sources === "all" ? " or on this machine" : ""}${pluginHint(name, where) || "; it may be built in to Claude Code"}. If a session does not load it, the step stops and says so.` });
    } else if (from !== "repo") {
      problems.push({ level: "warn", step, name, text: `\`${name}\` (${said(step)}) is only on this machine, so a loop running elsewhere will not have it.` });
    }
  };
  const a = cfg.agents;
  const teams = (names: readonly string[]) => [...new Set(names)].flatMap((name) => (a.teams[name] ? [{ name, members: a.teams[name].members }] : []));
  // What every loop step gets.
  const all = { agent: a.all.agent ?? null, subagents: a.all.subagents, teams: teams(a.all.teams) };
  for (const { name, role } of setupRoles(all, "every step")) await checkAgent(name, `${role} (agents.all)`, "all");
  for (const name of new Set(a.all.skills)) await checkSkill(name, "all");
  // What every step of a stage gets.
  for (const stage of STAGE_NAMES) {
    for (const name of new Set(cfg.stages[stage].skills)) if (!a.all.skills.includes(name)) await checkSkill(name, `stage ${stage}`);
  }
  // What each step sets itself.
  for (const step of STEP_KEYS) {
    const own = a.steps[step];
    if (!own) continue;
    const agent = CONTINUES_BUILD.has(step) ? null : own.agent ?? null;
    for (const { name, role } of setupRoles({ agent, subagents: own.subagents, teams: teams(own.teams) }, step)) await checkAgent(name, role, step);
    for (const name of new Set(own.skills)) await checkSkill(name, step);
  }
  return problems;
}

/**
 * The definitions of the agents a step's setup names, read from `where`: the agent it runs as (null
 * when none, or a built-in), then its subagents and team members, each once and built-ins left out.
 * `missing`: what a person is told about the first one not found, in checkAgentSetup's words.
 */
async function setupAgents(setup: AgentSetup, step: string, where: Where, mainBranch: string): Promise<{ main: AgentDefinition | null; others: AgentDefinition[] } | { missing: string }> {
  let main: AgentDefinition | null = null;
  const others: AgentDefinition[] = [];
  for (const { name, role } of setupRoles(setup, step)) {
    if (BUILTIN_AGENTS.has(name)) continue;
    const def = await findAgent(name, where);
    if (!def) return { missing: missingAgentText(name, role, mainBranch, where) };
    if (name === setup.agent) main = def;
    else others.push(def);
  }
  return { main, others };
}

/**
 * What a session's init event says it did not load of a setup, or null when it loaded everything (or
 * the event does not list it). Agents are listed by their inline names, built-ins by their own; a
 * skill counts under its name or as `<x>:<name>`. A built-in agent the step runs as is not passed, so
 * not expected.
 */
function initProblem(setup: AgentSetup, init: { agents?: string[]; skills?: string[] }): string | null {
  const missing: string[] = [];
  if (init.agents) {
    const names = [...new Set([
      ...(setup.agent && !BUILTIN_AGENTS.has(setup.agent) ? [setup.agent] : []),
      ...setup.subagents, ...setup.teams.flatMap((t) => t.members),
    ])];
    for (const name of names) {
      if (!init.agents.includes(BUILTIN_AGENTS.has(name) ? name : inlineName(name))) missing.push(`the agent \`${name}\``);
    }
  }
  if (init.skills) {
    const listed = init.skills;
    for (const name of setup.skills) {
      if (!listed.some((k) => k === name || k.endsWith(`:${name}`))) missing.push(`the skill \`${name}\``);
    }
  }
  return missing.length ? `The session did not load ${missing.join(", ")}. Add it with \`loopstra setup agents\`, then retry.` : null;
}

/** The user's home folder, read as each session starts (a test may change HOME or USERPROFILE meanwhile). */
export function userHome(): string {
  return (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();
}

/**
 * The sign-in settings of `<home>/.claude/settings.json` (`apiKeyHelper`, `env`), when it has them.
 * A `sources: repo` session loads only project settings, so Loopstra passes these through its own
 * `--settings`: a machine that signs in with them can still start sessions.
 */
function userSettingsPassthrough(home: string): { apiKeyHelper?: string; env?: Record<string, string> } {
  const settings = readJson(join(home, ".claude", "settings.json"));
  const out: { apiKeyHelper?: string; env?: Record<string, string> } = {};
  if (typeof settings?.apiKeyHelper === "string") out.apiKeyHelper = settings.apiKeyHelper;
  const env = settings?.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    out.env = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
  return out;
}

/**
 * An absolute path as Claude Code's permission rules write one: `//` and the path with forward
 * slashes. Claude Code matches Windows paths in POSIX form, a drive as a folder (`C:\x` is `/c/x`).
 */
export function pathRule(path: string): string {
  const posix = path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  return `//${posix.replace(/^\/+/, "")}`;
}

/** One entry of the `--agents` JSON. */
export interface InlineAgent { description: string; prompt: string; tools?: string[]; model?: string; skills?: string[] }

/** The `--agents` JSON: the main agent, then the others, keyed by their Loopstra names. */
export function inlineAgents(main: AgentDefinition | null, others: AgentDefinition[]): Record<string, InlineAgent> {
  const out: Record<string, InlineAgent> = {};
  const entry = (d: AgentDefinition, isMain: boolean): InlineAgent => {
    const e: InlineAgent = { description: d.description, prompt: d.prompt };
    if (d.tools) e.tools = isMain && !d.tools.includes("StructuredOutput") ? [...d.tools, "StructuredOutput"] : d.tools;
    if (d.model && !isMain) e.model = d.model;
    if (d.skills) e.skills = d.skills;
    return e;
  };
  if (main) out[inlineName(main.name)] = entry(main, true);
  for (const d of others) out[inlineName(d.name)] = entry(d, false);
  return out;
}

/**
 * What a step's agent setup sets on its session's run: never what the loop or chat own (the allow and
 * deny lists, the permission mode, the folder, the environment), so theirs always stand.
 */
export type SetupRunOptions = Partial<Pick<RunPhaseInput, "agents" | "agent" | "settingSources" | "settings" | "addDirs" | "forwardSubagentText" | "checkInit">>;

/** Deny rules that keep a session from editing anything under `dir` (an added dir it may only read). */
function noEditsUnder(dir: string): string[] {
  const under = `${pathRule(dir)}/**`;
  return ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(${under})`);
}

/**
 * The run options a step's agent setup adds to its session, for loop steps and chat steps alike:
 * - every agent it names is read from `whereOf()` and passed inline under its Loopstra name (see
 *   inlineAgents); the session runs as its agent with `--agent`. `whereOf` is asked only when the setup
 *   names an agent or a skill.
 * - `sources: repo` loads project settings only, so `baseSettings` and the user's sign-in settings
 *   ride along in `--settings`.
 * - a session outside `where.repo` (`cwd` differs) that uses skills also loads that folder's (`--add-dir`).
 *   `--add-dir` would also let it edit there, so `deny` has the rules that stop it: the caller adds them
 *   to its own deny list.
 * - subagents' text reaches the trace; the init event must list every agent and skill (see initProblem).
 * `models`: the model each inline agent sets, for the trace. `missing`: see setupAgents.
 */
export async function setupSession(
  setup: AgentSetup, step: string, mainBranch: string, cwd: string, baseSettings: Record<string, unknown>, whereOf: () => Promise<Where>,
): Promise<{ run: SetupRunOptions; deny: string[]; models: Record<string, string> } | { missing: string }> {
  const run: SetupRunOptions = { checkInit: (init) => initProblem(setup, init) };
  let deny: string[] = [];
  let models: Record<string, string> = {};
  if (setup.agent !== null || setup.subagents.length > 0 || setup.teams.length > 0 || setup.skills.length > 0) {
    const where = await whereOf();
    const found = await setupAgents(setup, step, where, mainBranch);
    if ("missing" in found) return found;
    const agents = inlineAgents(found.main, found.others);
    if (Object.keys(agents).length) run.agents = agents;
    if (found.main) run.agent = inlineName(found.main.name);
    models = Object.fromEntries(Object.entries(agents).flatMap(([name, a]) => (a.model ? [[name, a.model]] : [])));
    if (setup.skills.length && cwd !== where.repo) {
      run.addDirs = [where.repo];
      deny = noEditsUnder(where.repo);
    }
  }
  if (setup.sources === "repo") {
    run.settingSources = "project";
    run.settings = JSON.stringify({ ...baseSettings, ...userSettingsPassthrough(userHome()) });
  }
  if (setup.subagents.length || setup.teams.length) run.forwardSubagentText = true;
  return { run, deny, models };
}
