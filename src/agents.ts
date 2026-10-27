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

/** The reason a `tools` rule is refused, or null. A read-only step also refuses file changes and a bare Bash. */
export function toolProblem(rule: string, readOnly: boolean): string | null {
  const git = /^Bash\(git(?:\s+([^\s)]*))?[^)]*\)$/.exec(rule);
  if (git) {
    const sub = git[1];
    if (sub === undefined || sub === "" || sub === "*") return "only Loopstra commits, branches, merges and pushes; git is not allowed";
    if (HISTORY_GIT.has(sub)) return `only Loopstra commits, branches, merges and pushes; git ${sub} is not allowed`;
  }
  if (!readOnly) return null;
  const edit = /^(Edit|Write|NotebookEdit)(\(.*\))?$/.exec(rule);
  if (edit) return `${edit[1] ?? rule} would let it change files`;
  if (/^Bash(\(\*?\))?$/.test(rule)) return "a bare Bash rule would let it run anything";
  return null;
}
