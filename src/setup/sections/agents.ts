import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkAgentSetup, userHome } from "../../agent-files";
import { cloneSource, copyItem, listLibrary, newAgentFile, scanFolder, shownUrl, type FileWrite, type LibraryItem } from "../../agent-library";
import { BUILTIN_AGENTS, CHAT_STEPS, CONTINUES_BUILD, TEAM_WAYS, toolRuleProblem, type TeamWay } from "../../agents";
import { MCP_RULE, MCP_RULE_TEXT, type Config, type StepAgents } from "../../config";
import { STEP_KEYS, STEPS, type StepKey } from "../../models";
import { localDate } from "../../signals";
import { andList } from "../../text";
import type { ConfigDocument } from "../document";
import type { Section, SetupContext } from "../types";
import { modelName } from "./models";

type Kind = LibraryItem["kind"];
type Path = readonly string[];

/** The keys of a step's settings, in the order they are asked. */
const KEYS = ["agent", "subagents", "teams", "skills", "tools", "mcp_tools"] as const;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const TEAM_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const MACHINE = "from this machine";
const SOURCE = "from a git repository or folder";
const NEW_AGENT = "a new agent";

/** What one run of the section knows: the sources picked, what they hold, and what this run added. */
interface Run {
  ctx: SetupContext;
  library: LibraryItem[];
  added: Record<Kind, string[]>;
}

const once = (names: readonly string[]) => [...new Set(names)];
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
/** A comma-separated answer as a list. */
const list = (answer: string) => answer.split(",").map((s) => s.trim()).filter(Boolean);
/** Text from a file, safe to print: no control characters (a copied description is data). */
const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
/** The name an item gets in the repo: a plugin's `plugin:name` becomes `name`. */
const plainName = (name: string) => name.slice(name.indexOf(":") + 1);
const itemLine = (i: LibraryItem) => `  ${i.kind} ${printable(i.name)} (${i.from})${i.description ? `: ${printable(i.description)}` : ""}`;

/** The names of that kind the steps can use in this run: what the sources hold, then what was added. */
function names(run: Run, kind: Kind): string[] {
  return once([...run.library.filter((i) => i.kind === kind).map((i) => i.name), ...run.added[kind]]);
}

/** The first rule's problem, or null. */
function firstProblem(rules: string[], problem: (rule: string) => string | null): string | null {
  for (const rule of rules) {
    const p = problem(rule);
    if (p) return `${p}.`;
  }
  return null;
}

/** Removes an empty map at each path, so no `{}` is left in the file. */
function tidy(doc: ConfigDocument, paths: Path[]): void {
  for (const p of paths) {
    const v = doc.get(p);
    if (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) doc.clear(p);
  }
}

/**
 * The repo-relative files of an agent or skill folder that will be there once the pending writes
 * are made: on disk (links are not followed), then the pending writes and removals.
 */
function existingFiles(ctx: SetupContext, target: string): string[] {
  const found = new Set<string>();
  const walk = (rel: string) => {
    let st;
    try { st = lstatSync(join(ctx.root, rel)); } catch { return; }
    if (st.isFile()) { found.add(rel); return; }
    if (!st.isDirectory()) return;
    let names: string[];
    try { names = readdirSync(join(ctx.root, rel)); } catch { return; }
    for (const name of names) walk(`${rel}/${name}`);
  };
  walk(target);
  for (const f of ctx.files) {
    if (f.path !== target && !f.path.startsWith(`${target}/`)) continue;
    if (f.content === null) found.delete(f.path);
    else found.add(f.path);
  }
  return [...found].sort();
}

/**
 * Shows the files an addition writes, asks before replacing what the repo has, and adds them to the
 * pending writes. A replaced skill's other files are removed, so the folder is replaced whole.
 */
async function stage(run: Run, kind: Kind, name: string, writes: FileWrite[] | { refused: string }): Promise<boolean> {
  const { ask, files } = run.ctx;
  if ("refused" in writes) { ask.say(`  ${writes.refused}`); return false; }
  ask.say(`Files to write when the config saves:\n${writes.map((w) => `  ${w.path}`).join("\n")}`);
  const old = existingFiles(run.ctx, kind === "agent" ? `.claude/agents/${name}.md` : `.claude/skills/${name}`);
  const removed = old.filter((p) => !writes.some((w) => w.path === p));
  if (old.length) {
    if (removed.length) ask.say(`Replacing it removes:\n${removed.map((p) => `  ${p}`).join("\n")}`);
    if (!(await ask.yesNo(`Replace the existing ${kind} ${name}?`, false))) return false;
  }
  files.push(...removed.map((path) => ({ path, content: null })), ...writes);
  run.added[kind].push(name);
  return true;
}

async function fromMachine(run: Run, kind: Kind): Promise<string[]> {
  const { ask, root } = run.ctx;
  const items = listLibrary(root, userHome(), "all").filter((i) => i.kind === kind && i.from !== "repo");
  if (!items.length) { ask.say(`There are no ${kind}s on this machine outside the repository.`); return []; }
  for (const i of items) ask.say(itemLine(i));
  const name = await ask.pick(`Which ${kind} to copy`, ["none", ...once(items.map((i) => i.name))], "none");
  const item = items.find((i) => i.name === name);
  if (!item) return [];
  return (await stage(run, kind, plainName(item.name), copyItem(item, { root, today: localDate() }))) ? [plainName(item.name)] : [];
}

async function fromSource(run: Run, kind: Kind): Promise<string[]> {
  const { ask, root } = run.ctx;
  const url = await ask.text("A git repository (https://, ssh://, git@ or file://) or a folder; - to go back", { optional: true });
  if (!url) return [];
  const fetched = await cloneSource(url);
  if ("refused" in fetched) { ask.say(`  ${fetched.refused}`); return []; }
  try {
    const items = scanFolder(fetched.dir, fetched.name).filter((i) => i.kind === kind);
    if (!items.length) { ask.say(`There are no ${kind}s in ${shownUrl(url)}.`); return []; }
    for (const i of items) ask.say(itemLine(i));
    const picked = await ask.pickMany(`Which ${kind}s to copy`, once(items.map((i) => i.name)), []);
    const out: string[] = [];
    for (const name of picked) {
      const item = items.find((i) => i.name === name)!;
      const inside = relative(fetched.dir, item.path).split(sep).join("/");
      const source = inside ? `${url} (${inside})` : url;
      if (await stage(run, kind, plainName(name), copyItem(item, { root, source, today: localDate() }))) out.push(plainName(name));
    }
    return out;
  } finally {
    fetched.cleanup();
  }
}

async function newAgent(run: Run): Promise<string[]> {
  const { ask } = run.ctx;
  const repo = run.library.filter((i) => i.kind === "agent" && i.from === "repo").map((i) => i.name);
  const taken = new Set([...repo, ...run.added.agent, ...BUILTIN_AGENTS]);
  const name = await ask.text("Name of the new agent (lowercase letters, digits and dashes)", {
    check: (n) => (!NAME.test(n) ? "A name is lowercase letters, digits and dashes, like lead-reviewer." : taken.has(n) ? `There is already an agent called ${n}.` : null),
  });
  const description = await ask.text(`What ${name} is for, in one line (a session reads it to choose a subagent)`);
  const prompt = await ask.text(`The role of ${name}, in one line (the start of its prompt, like "You review code for security problems.")`);
  const tools = list(await ask.text(`Tools ${name} may use, comma-separated (- for the session's)`, { optional: true }));
  const model = await ask.text(`Model for ${name} (- for the step's)`, { optional: true, check: modelName });
  return (await stage(run, "agent", name, [newAgentFile({ name, description, prompt, tools, model: model || null })])) ? [name] : [];
}

/** Adds agents or skills to the repo (pending until the config saves); returns the names added. */
async function addItems(run: Run, kind: Kind): Promise<string[]> {
  const ways = kind === "agent" ? [MACHINE, SOURCE, NEW_AGENT] : [MACHINE, SOURCE];
  const way = await run.ctx.ask.pick(`Where to add ${kind === "agent" ? "an agent" : "a skill"} from`, ways, MACHINE);
  if (way === NEW_AGENT) return newAgent(run);
  return way === MACHINE ? fromMachine(run, kind) : fromSource(run, kind);
}

/** The agent a step runs as: none, or one the sources hold (built-ins cannot be, they have no structured output). */
async function askAgent(run: Run, question: string, current: string | undefined): Promise<string | undefined> {
  let suggestion = current && !BUILTIN_AGENTS.has(current) ? current : "none";
  for (;;) {
    const usable = names(run, "agent").filter((n) => !BUILTIN_AGENTS.has(n));
    const choices = once(["none", "add one", ...usable, ...(suggestion === "none" ? [] : [suggestion])]);
    const answer = await run.ctx.ask.pick(question, choices, suggestion);
    if (answer === "none") return undefined;
    if (answer !== "add one") return answer;
    suggestion = (await addItems(run, "agent"))[0] ?? suggestion;
  }
}

/** Agents picked from the sources, the built-ins and what is set now, after an offer to add one. */
async function pickAgents(run: Run, question: string, current: string[], atLeastOne: boolean): Promise<string[]> {
  const { ask } = run.ctx;
  const added = (await ask.yesNo("Add an agent first?", false)) ? await addItems(run, "agent") : [];
  const choices = once([...names(run, "agent"), ...BUILTIN_AGENTS, ...current]);
  for (;;) {
    const picked = await ask.pickMany(question, choices, once([...current, ...added]));
    if (picked.length || !atLeastOne || !ask.interactive) return picked;
    ask.say("  A team needs at least one member.");
  }
}

/** Writes a step's settings: what is set, then what was emptied, so a map left empty goes whole. */
function writeStep(doc: ConfigDocument, path: Path, next: Partial<Record<(typeof KEYS)[number], string | string[]>>): void {
  const has = (v: string | string[] | undefined) => (Array.isArray(v) ? v.length > 0 : v !== undefined);
  for (const k of KEYS) {
    const v = next[k];
    if (has(v)) doc.set([...path, k], v, { flow: Array.isArray(v) });
  }
  for (const k of KEYS) if (!has(next[k])) doc.clear([...path, k]);
  tidy(doc, [path, ["agents", "steps"], ["agents", "all"], ["agents"]]);
}

/** One step's settings (or all steps' with null). */
async function askStep(run: Run, step: StepKey | null): Promise<void> {
  const { ask, doc } = run.ctx;
  const path = step ? ["agents", "steps", step] : ["agents", "all"];
  const label = step ?? "all steps";
  const who = step ? `the ${step} step` : "every step";
  const own = record(doc.get(path));
  if (!step) ask.say("What all steps get reaches every step but chat's two, before each step's own. Tools set here reach read-only steps too, so they may not change files.");
  else if (CHAT_STEPS.has(step)) ask.say(`${step} is a chat turn: it takes nothing from all steps, and anyone allowed to chat can steer the tools and MCP tools you give it.`);

  const next: Partial<Record<(typeof KEYS)[number], string | string[]>> = {};
  if (step && CONTINUES_BUILD.has(step)) ask.say(`${step} continues the build's session, so it runs as the build's agent.`);
  else next.agent = await askAgent(run, `Agent ${who} runs as`, typeof own.agent === "string" ? own.agent : undefined);
  next.subagents = await pickAgents(run, `Subagents ${who} can hand work to`, strings(own.subagents), false);
  const teams = Object.keys(record(doc.get(["agents", "teams"])));
  // A team that is not under agents.teams is dropped (the config refuses it).
  if (teams.length) next.teams = await ask.pickMany(`Teams for ${label}`, teams, strings(own.teams).filter((t) => teams.includes(t)));
  const skills = strings(own.skills);
  const added = (await ask.yesNo("Add a skill first?", false)) ? await addItems(run, "skill") : [];
  next.skills = await ask.pickMany(`Skills for ${label}`, once([...names(run, "skill"), ...skills]), once([...skills, ...added]));
  const tools = await ask.text(`Tools for ${label}, besides the session's own (comma-separated; - for none)`, {
    suggestion: strings(own.tools).join(", ") || undefined, optional: true,
    check: (a) => firstProblem(list(a), (rule) => toolRuleProblem(rule, step ?? "all")),
  });
  next.tools = list(tools);
  const mcp = await ask.text(`MCP tools for ${label}, like mcp__github__get_issue (comma-separated; - for none)`, {
    suggestion: strings(own.mcp_tools).join(", ") || undefined, optional: true,
    check: (a) => firstProblem(list(a), (rule) => (MCP_RULE.test(rule) ? null : `${rule} ${MCP_RULE_TEXT}`)),
  });
  next.mcp_tools = list(mcp);
  writeStep(doc, path, next);
}

/** The steps (and all steps) that use a team. */
function teamUsers(doc: ConfigDocument, team: string): string[] {
  const uses = (v: unknown) => strings(record(v).teams).includes(team);
  return [
    ...(uses(doc.get(["agents", "all"])) ? ["all steps"] : []),
    ...Object.entries(record(doc.get(["agents", "steps"]))).filter(([, v]) => uses(v)).map(([step]) => step),
  ];
}

async function askTeam(run: Run, name: string, team: Record<string, unknown>): Promise<void> {
  const { ask, doc } = run.ctx;
  const members = await pickAgents(run, `Members of the team ${name}`, strings(team.members), true);
  const current = TEAM_WAYS.find((w) => w === team.way) ?? "parallel";
  const way: TeamWay = await ask.pick(`How the team ${name} works`, TEAM_WAYS, current);
  doc.set(["agents", "teams", name, "members"], members, { flow: true });
  doc.put(["agents", "teams", name, "way"], way, "parallel");
}

async function askTeams(run: Run): Promise<void> {
  const { ask, doc } = run.ctx;
  ask.say("A team is a named group of subagents. parallel: every member gets the same task, and the session weighs their answers. pick: the session hands each piece of work to the member that fits it.");
  for (;;) {
    const teams = record(doc.get(["agents", "teams"]));
    const choice = await ask.pick("Which team to set up", ["done", "new team", ...Object.keys(teams)], "done");
    if (choice === "done") return;
    if (choice === "new team") {
      const name = await ask.text("Name of the new team (lowercase words joined by dashes)", {
        check: (n) => (!TEAM_NAME.test(n) ? "A team name is lowercase words joined by dashes, like reviewers." : n === "done" ? "A team cannot be called done." : n in teams ? `There is already a team ${n}.` : null),
      });
      await askTeam(run, name, {});
      continue;
    }
    if ((await ask.pick(`Change or delete the team ${choice}`, ["change", "delete"], "change")) === "change") {
      await askTeam(run, choice, record(teams[choice]));
      continue;
    }
    const users = teamUsers(doc, choice);
    if (users.length) ask.say(`The team ${choice} is used by ${andList(users)}: take it off ${users.length > 1 ? "them" : users[0]!} first.`);
    else doc.clear(["agents", "teams", choice]);
  }
}

/** True when the config sets anything under agents. */
function agentsSet(cfg: Config): boolean {
  const any = (s: StepAgents) => s.agent !== undefined || [s.subagents, s.teams, s.skills, s.tools, s.mcp_tools].some((l) => l.length > 0);
  const a = cfg.agents;
  return a.sources !== "all" || Object.keys(a.teams).length > 0 || any(a.all) || Object.values(a.steps).some(any);
}

export const agents: Section = {
  name: "agents",
  title: "Agents",
  covers: ["agents"],

  async ask(ctx) {
    if (!ctx.only && !(await ctx.ask.yesNo("Set up agents for the loop's steps now?", false))) return;
    ctx.ask.say([
      "Each step of the loop is a Claude Code session. It can run as an agent (a role, from .claude/agents/), hand work to subagents or to a team of them, and load skills (from .claude/skills/).",
      "What you pick here reaches the loop's sessions for that step. Fix, reconcile and revise continue the build's session, so they run as the build's agent.",
      "Chat's two steps (orchestrator, write-intent) are steered by the members of the chat channel.",
    ].join(" "));
    ctx.ask.say("all: the setup of whoever runs `loopstra start` (their skills, agents, plugins and MCP servers) plus the repo's.");
    ctx.ask.say("repo: only what the repository declares (its .claude/, .mcp.json and CLAUDE.md), the same on every machine.");
    const current = ctx.doc.get(["agents", "sources"]) === "repo" ? "repo" : "all";
    const sources = await ctx.ask.pick("Where sessions get skills, agents, plugins and MCP servers", ["all", "repo"] as const, current);
    ctx.doc.put(["agents", "sources"], sources, "all");

    const run: Run = { ctx, library: listLibrary(ctx.root, userHome(), sources), added: { agent: [], skill: [] } };
    if (run.library.length) ctx.ask.say(`What the steps can use:\n${run.library.map(itemLine).join("\n")}`);
    else ctx.ask.say("No agents or skills found yet.");
    ctx.ask.say(`The steps:\n${STEPS.map((s) => `  ${s.key}: ${s.what}`).join("\n")}`);
    for (;;) {
      const choice = await ctx.ask.pick("Which step to set up", ["done", "all steps", "teams", ...STEP_KEYS], "done");
      if (choice === "done") return;
      if (choice === "teams") await askTeams(run);
      else await askStep(run, choice === "all steps" ? null : choice);
    }
  },

  async check(ctx, cfg) {
    if (!agentsSet(cfg)) return [];
    const problems = await checkAgentSetup(cfg, { repo: ctx.root, home: userHome(), sources: cfg.agents.sources });
    if (!problems.length) return [{ level: "ok", text: "Every agent the steps name is in place." }];
    return problems.map((p) => ({ level: p.level, text: p.text }));
  },
};
