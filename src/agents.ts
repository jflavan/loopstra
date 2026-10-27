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
