import type { Config, StepAgents } from "./config";
import { STEP_KEYS, type StepKey } from "./models";

/** A team's name: lowercase words joined by dashes. */
export const TEAM_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Each name once, in first-seen order. */
export const once = (names: readonly string[]): string[] => [...new Set(names)];

/** How a team's members work: all at once and merged, or each tries and the best is kept. */
export const TEAM_WAYS = ["parallel", "pick"] as const;
export type TeamWay = (typeof TEAM_WAYS)[number];

/** Steps that change files: the rest are read-only. */
const WRITING_STEPS: readonly StepKey[] = ["acceptance", "build", "reconcile", "fix", "revise"];

/** Every step except those that change files. */
export const READ_ONLY_STEPS: ReadonlySet<StepKey> = new Set(STEP_KEYS.filter((k) => !WRITING_STEPS.includes(k)));

/** Steps that continue the build's session, so they run as the build's agent. */
export const CONTINUES_BUILD: ReadonlySet<StepKey> = new Set(["fix", "reconcile", "revise"]);

/** Steps that are chat turns rather than steps of a change. */
export const CHAT_STEPS: ReadonlySet<StepKey> = new Set(["orchestrator", "write-intent"]);

const HISTORY_GIT = new Set(["commit", "push", "merge", "rebase", "reset", "checkout", "switch", "branch", "tag", "stash"]);

/** Git options that take their value as the next word when written without `=`. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Words that run the command after them (`env git push`), skipped with their options to find the command. */
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "nice", "sudo"]);

/** Whether a rule's word, with `*` matching anything as Claude Code's rules do, matches `word`. */
function globMatches(pattern: string, word: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(word);
}

/** A Bash rule's words, without the legacy `:*` ending; null when the rule is not a Bash rule with a command. */
function bashWords(rule: string): string[] | null {
  const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (!m) return null;
  const words = (m[1] ?? "").trim().replace(/:\*$/, "").split(/\s+/).filter(Boolean);
  return words.length ? words : null;
}

/**
 * The history-changing git subcommand a `Bash(...)` rule could allow: "" when it could allow any of
 * them (a bare git rule, only options, or a wildcard in the subcommand's place that matches one), the
 * first one it matches otherwise, and null when it allows none. Wrappers (`env`, `command`, ...) and
 * `VAR=value` words before the command are skipped, and a wildcard in the command's place counts as
 * git when it could match `git` (`g*`); one that matches anything is a bare Bash rule, judged elsewhere.
 */
function historyGit(rule: string): string | null {
  const words = bashWords(rule);
  if (!words) return null;
  let i = 0;
  for (;;) {
    const w = words[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (WRAPPERS.has(w)) { i++; while ((words[i] ?? "").startsWith("-")) i++; continue; }
    break;
  }
  const cmd = words[i] ?? "";
  if (!globMatches(cmd, "git") || /^\**$/.test(cmd)) return null;
  i++;
  while (i < words.length && (words[i] ?? "").startsWith("-")) {
    i += GIT_VALUE_OPTIONS.has(words[i] ?? "") ? 2 : 1;
  }
  const sub = words[i];
  if (sub === undefined) return "";
  if (!sub.includes("*")) return HISTORY_GIT.has(sub) ? sub : null;
  const hit = [...HISTORY_GIT].filter((g) => globMatches(sub, g));
  return hit.length === HISTORY_GIT.size ? "" : (hit[0] ?? null);
}

/** Whether a rule allows any command: `Bash`, or a Bash rule made only of wildcards (`Bash(*)`, `Bash(:*)`, `Bash(**)`). */
function bareBash(rule: string): boolean {
  if (rule === "Bash") return true;
  const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  return m !== null && /^[\s*]*(:\*)?\s*$/.test(m[1] ?? "");
}

/** What starts every refusal that holds on every step: git that changes history, or a Bash rule that allows it. */
const ONLY_LOOPSTRA = "only Loopstra commits, branches, merges and pushes";

/**
 * The reason a `tools` rule is refused, or null. No step may hold git that changes history, or a
 * bare Bash rule (it would allow that git too); a read-only step also refuses file changes.
 */
export function toolProblem(rule: string, readOnly: boolean): string | null {
  const sub = historyGit(rule);
  if (sub === "") return `${ONLY_LOOPSTRA}; git is not allowed`;
  if (sub !== null) return `${ONLY_LOOPSTRA}; git ${sub} is not allowed`;
  if (bareBash(rule)) return `${ONLY_LOOPSTRA}; a bare Bash rule would let it run any git, so name the commands, like Bash(make *)`;
  if (!readOnly) return null;
  const edit = /^(Edit|MultiEdit|Write|NotebookEdit)(\(.*\))?$/.exec(rule);
  if (edit) return `${edit[1] ?? rule} would let it change files`;
  return null;
}

/**
 * Why a `tools` rule is refused where it is set (a step, or "all" for agents.all), in the words
 * config validation uses, or null. A git rule is refused the same way everywhere; the rest depend on
 * the step being read-only (agents.all reaches read-only steps too).
 */
export function toolRuleProblem(rule: string, where: StepKey | "all"): string | null {
  const problem = toolProblem(rule, where === "all" || READ_ONLY_STEPS.has(where));
  if (!problem || problem.startsWith(ONLY_LOOPSTRA)) return problem;
  const [who, it] = where === "all" ? ["these reach read-only steps too", "them"] : [`${where} is read-only`, "it"];
  return `${who}; ${problem.replace(" would let it ", ` would let ${it} `)}`;
}

/** The agents Claude Code ships with: they keep their own names in a prompt. */
export const BUILTIN_AGENTS: ReadonlySet<string> = new Set(["general-purpose", "Explore", "Plan", "claude", "statusline-setup"]);

export interface Team {
  name: string;
  members: string[];
  way: TeamWay;
}

/** Everything one step's session is set up with. */
export interface AgentSetup {
  sources: "all" | "repo";
  agent: string | null;
  subagents: string[];
  teams: Team[];
  skills: string[];
  tools: string[];
  mcpTools: string[];
}


/**
 * A step's setup: `all`, then the stage's skills, then the step's own, each name once. Chat steps get
 * nothing from `all`. Fix, reconcile and revise run as the build step's agent.
 */
export function resolveSetup(agents: Config["agents"], step: StepKey, stageSkills: readonly string[]): AgentSetup {
  const chat = CHAT_STEPS.has(step);
  const empty: StepAgents = { subagents: [], teams: [], skills: [], tools: [], mcp_tools: [] };
  const all = chat ? empty : agents.all;
  const own = agents.steps[step] ?? empty;
  const agent = CONTINUES_BUILD.has(step)
    ? (agents.steps["build"]?.agent ?? all.agent ?? null)
    : (own.agent ?? all.agent ?? null);
  return {
    sources: agents.sources,
    agent,
    subagents: once([...all.subagents, ...own.subagents]),
    teams: once([...all.teams, ...own.teams]).flatMap((name) => {
      const t = agents.teams[name];
      return t ? [{ name, members: [...t.members], way: t.way }] : [];
    }),
    skills: once([...all.skills, ...stageSkills, ...own.skills]),
    tools: once([...all.tools, ...own.tools]),
    mcpTools: once([...all.mcp_tools, ...own.mcp_tools]),
  };
}

/** True when the setup changes nothing about how a session runs. */
export function isEmptySetup(s: AgentSetup): boolean {
  return s.sources === "all" && s.agent === null && !s.subagents.length && !s.teams.length && !s.skills.length && !s.tools.length && !s.mcpTools.length;
}

/** The name an agent file written for Loopstra is given inline: `loopstra-` and the name, colons as dashes. */
export function inlineName(name: string): string {
  return `loopstra-${name.replaceAll(":", "-")}`;
}

/** The text put before the prompt template: skills, subagents and teams. "" when there are none. */
export function setupLines(s: AgentSetup, describe: (name: string) => string | null): string {
  const name = (n: string) => (BUILTIN_AGENTS.has(n) ? n : inlineName(n));
  const quoted = (n: string) => `\`${name(n)}\``;
  const parts: string[] = [];
  if (s.skills.length) parts.push(`Use these skills: ${s.skills.map((k) => `\`${k}\``).join(", ")}.`);
  if (s.subagents.length) {
    const list = s.subagents.map((n) => {
      const d = describe(n);
      return d ? `${quoted(n)} (${d})` : quoted(n);
    });
    parts.push(`You can hand work to these subagents: ${list.join(", ")}.`);
  }
  for (const t of s.teams) {
    const members = t.members.map(quoted).join(", ");
    const how = t.way === "parallel"
      ? "Give every member the same task at the same time, then weigh their answers."
      : "Give each piece of work to the member that fits it best.";
    parts.push(`Team \`${t.name}\`: ${members}. ${how}`);
  }
  if (!parts.length) return "";
  if (s.subagents.length || s.teams.length) parts.push("You still return your own structured output; subagents help, they do not replace it.");
  return parts.join("\n\n") + "\n\n";
}
