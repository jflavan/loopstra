import { loopDayNote, loopDaySpent } from "./budget";
import type { Config } from "./config";
import { activePause, agoText } from "./heartbeat";
import { dependencyWait, orderQueue, REVIEW_GATE, scanRepo, waitsForPerson, type HumanGates, type Status } from "./intents";
import { SYNC_SIGNAL } from "./remote";
import { humanNote } from "./stages/shared";
import type { Trace } from "./trace";

/** One thing a person should do or know. The same list in `loopstra status` and the dashboard. */
export interface AttentionItem {
  kind: "paused" | "health" | "sync" | "config" | "blocked" | "unreadable" | "waiting";
  /** The kind in plain words, e.g. "Blocked" or "Waiting for you". */
  label: string;
  /** The change it is about; null for the repository as a whole. */
  slug: string | null;
  title: string;
  /** What a person should do or know, in plain words. */
  what: string;
}

export const ATTENTION_LABEL: Record<AttentionItem["kind"], string> = {
  paused: "Paused", health: "Main branch", sync: "GitHub", config: "Settings",
  blocked: "Blocked", unreadable: "Cannot read intent.md", waiting: "Waiting for you",
};

/** What the tests on main say, in plain words: the newest check, and whether main is red. */
export function healthView(trace: Trace, now: Date): { result: string; ts: string; text: string } | null {
  const newest = trace.lastSignal("main_health");
  if (!newest) return null;
  const red = trace.lastSignal("main_health", { excludeErrors: true })?.result === "fail";
  const when = `${agoText(now.getTime() - Date.parse(newest.ts))} ago`;
  // Before main has ever passed (a new repo with no code yet), red is no breakage: no fix intent opens.
  const everPassed = trace.lastSignal("main_health", { result: "pass" }) !== null;
  const text = newest.result === "pass" ? `The tests on main pass (checked ${when}).`
    : red && !everPassed ? `The tests on main have not passed yet (checked ${when}). On a new repository that is expected until the first change merges.`
    : red ? `The tests on main are failing (checked ${when}).`
    : `The last check of main could not run (${when}). An engineer can find the details in the trace.`;
  return { result: red ? "fail" : newest.result, ts: newest.ts, text };
}

/** For each gate a person may sit on: the document they read and the status that approves it. */
const GATE_DOC: Record<keyof HumanGates, { artifact: string; approved: Status }> = {
  spec: { artifact: "spec.md", approved: "spec-approved" },
  plan: { artifact: "plan.md", approved: "plan-approved" },
  merge: { artifact: "review.md", approved: "merge-approved" },
  done: { artifact: "outcome.md", approved: "done" },
};

/**
 * Everything that needs a person, most pressing first: a pause, a red main, main out of step with
 * GitHub, a config problem, blocked changes, unreadable intents, then changes waiting for a person
 * (drafts, and reviews with a person on the gate). `config` is the loaded config, or the problem
 * that stopped it loading (which the loop also traces).
 */
export async function attention(root: string, config: Config | { problem: string }, trace: Trace, now: Date = new Date()): Promise<AttentionItem[]> {
  const cfg = "problem" in config ? null : config;
  const scan = await scanRepo(root);
  const intents = orderQueue(scan.intents);
  const items: AttentionItem[] = [];
  const add = (kind: AttentionItem["kind"], slug: string | null, title: string, what: string) => items.push({ kind, label: ATTENTION_LABEL[kind], slug, title, what });

  const pause = activePause(root, now);
  if (pause) add("paused", null, "Loopstra is paused", pause.reason);
  // Only a spent day: one merely held by running phases clears by itself and needs no person.
  if (cfg && loopDaySpent(cfg, trace, now)) add("paused", null, "Loopstra is paused", loopDayNote(cfg, trace, now));
  const health = healthView(trace, now);
  if (health && health.result !== "pass") add("health", null, "Main branch", health.text);
  // Main and GitHub out of step (waiting on a person's own commits, or failing): the newest outcome only.
  const sync = trace.lastSignal(SYNC_SIGNAL);
  if (sync && (sync.result === "fail" || sync.result === "waiting")) add("sync", null, "Main and GitHub", sync.output);
  if ("problem" in config) add("config", null, "Loopstra settings", config.problem);

  for (const i of intents) {
    if (i.file.frontmatter.status === "blocked") {
      add("blocked", i.slug, i.file.title || i.slug, i.file.frontmatter.note || "Stopped and needs a person. Read intent.md, then set the status line to continue.");
    }
  }
  for (const u of scan.unreadable) add("unreadable", u.slug, u.slug, u.problem);
  const human: HumanGates = cfg
    ? { spec: cfg.gates.spec.human, plan: cfg.gates.plan.human, merge: cfg.gates.merge.human, done: cfg.gates.done.human }
    : { spec: "none", plan: "none", merge: "none", done: "none" };
  for (const i of intents) {
    const fm = i.file.frontmatter;
    // A depends_on only a person can untangle (a name that matches no change, a closed one, a loop).
    const wait = dependencyWait(i, intents);
    if (wait?.needsPerson) {
      add("waiting", i.slug, i.file.title || i.slug, wait.note);
      continue;
    }
    if (fm.status === "blocked" || !waitsForPerson(i, human)) continue;
    const title = i.file.title || i.slug;
    if (fm.status === "draft") {
      add("waiting", i.slug, title, fm.note || "A draft. When it says what you want, change the status line to accepted. To drop it, set it to closed.");
      continue;
    }
    const gate = REVIEW_GATE[fm.status]!;
    add("waiting", i.slug, title, fm.note || humanNote(GATE_DOC[gate].artifact, GATE_DOC[gate].approved, human[gate]));
  }
  return items;
}
