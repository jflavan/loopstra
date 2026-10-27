import type { Config, StepAgents } from "./config";
import { STEP_KEYS, type StepKey } from "./models";

/** How a team's members work: all at once and merged, or each tries and the best is kept. */
export const TEAM_WAYS = ["parallel", "pick"] as const;
export type TeamWay = (typeof TEAM_WAYS)[number];

/** Steps that change files: the rest are read-only. */
const WRITING_STEPS: readonly StepKey[] = ["build", "reconcile", "fix", "revise"];

/** Every step except those that change files. */
export const READ_ONLY_STEPS: ReadonlySet<StepKey> = new Set(STEP_KEYS.filter((k) => !WRITING_STEPS.includes(k)));

/** Steps that continue the build's session, so they run as the build's agent. */
export const CONTINUES_BUILD: ReadonlySet<StepKey> = new Set(["fix", "reconcile", "revise"]);

/** Steps that are chat turns rather than steps of a change. */
export const CHAT_STEPS: ReadonlySet<StepKey> = new Set(["orchestrator", "write-intent"]);

const HISTORY_GIT = new Set(["commit", "push", "merge", "rebase", "reset", "checkout", "switch", "branch", "tag", "stash"]);

/** Git options that take their value as the next word when written without `=`. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * The git subcommand a `Bash(git ...)` rule covers, "" when it covers any (a bare git rule, or only
 * options), and null when the rule is not about git. Global options before the subcommand are skipped.
 */
function gitSubcommand(rule: string): string | null {
  const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (!m) return null;
  const words = (m[1] ?? "").trim().replace(/:\*$/, "").split(/\s+/);
  if (!/^git\*?$/.test(words[0] ?? "")) return null;
  if (words[0] === "git*") return "";
  let i = 1;
  while (i < words.length && (words[i] ?? "").startsWith("-")) {
    i += GIT_VALUE_OPTIONS.has(words[i] ?? "") ? 2 : 1;
  }
  return (words[i] ?? "").replace(/(:\*|\*)$/, "");
}

/** The reason a `tools` rule is refused, or null. A read-only step also refuses file changes and a bare Bash. */
export function toolProblem(rule: string, readOnly: boolean): string | null {
  const sub = gitSubcommand(rule);
  if (sub === "") return "only Loopstra commits, branches, merges and pushes; git is not allowed";
  if (sub !== null && HISTORY_GIT.has(sub)) return `only Loopstra commits, branches, merges and pushes; git ${sub} is not allowed`;
  if (!readOnly) return null;
  const edit = /^(Edit|Write|NotebookEdit)(\(.*\))?$/.exec(rule);
  if (edit) return `${edit[1] ?? rule} would let it change files`;
  if (/^Bash(\(\*?\))?$/.test(rule)) return "a bare Bash rule would let it run anything";
  return null;
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

const once = (names: readonly string[]) => [...new Set(names)];

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
