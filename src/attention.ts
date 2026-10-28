import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loopDayNote, loopDaySpent } from "./budget";
import type { Config } from "./config";
import { ghProblem, GITHUB_SIGNAL, GITHUB_SILENT_MS } from "./github";
import { activePause, agoText, readLoopHold } from "./heartbeat";
import { changeGates, dependencyWait, hasQuestion, heldNote, humanGates, orderQueue, REVIEW_GATE, scanRepo, waitsForPerson, WATCHING_PR, type HumanGates, type Scan, type Status } from "./intents";
import { Git } from "./git";
import { readQuestion, type Asked } from "./questions";
import { SYNC_SIGNAL } from "./remote";
import { exceptionsToApprove, parseRecord, STANDARDS_RECORD } from "./standards-record";
import { branchStandards, hasStandardFiles, standardsStopText } from "./standards";
import { errorText } from "./shell";
import { StopRequested } from "./stop";
import { andList } from "./text";
import { humanNote, prWait } from "./stages/shared";
import type { Trace } from "./trace";

/** One thing a person should do or know. The same list in `loopstra status` and the dashboard. */
export interface AttentionItem {
  kind: "paused" | "health" | "sync" | "config" | "standards" | "blocked" | "held" | "question" | "unreadable" | "waiting";
  /** The kind in plain words, e.g. "Blocked" or "Waiting for you". */
  label: string;
  /** The change it is about; null for the repository as a whole. */
  slug: string | null;
  title: string;
  /** What a person should do or know, in plain words. */
  what: string;
  /** What stays the same while the item lasts, when `what` does not (main's says when it was checked). */
  key?: string;
}

const ATTENTION_LABEL: Record<AttentionItem["kind"], string> = {
  paused: "Paused", health: "Main branch", sync: "GitHub", config: "Settings", standards: "Standards",
  blocked: "Blocked", held: "Held", question: "Has a question", unreadable: "Cannot read intent.md", waiting: "Waiting for you",
};

/**
 * What the tests on main say, in plain words: the newest check, and whether main is red. `state` is
 * the same words without the time.
 */
function healthView(trace: Trace, now: Date): { result: string; ts: string; text: string; state: "pass" | "new" | "red" | "error" } | null {
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
  const state = newest.result === "pass" ? "pass" : red && !everPassed ? "new" : red ? "red" : "error";
  return { result: red ? "fail" : newest.result, ts: newest.ts, text, state };
}

/** What an open question asks, in plain words, and where to answer it. Parts with no value are left out. */
function questionWhat(q: Asked | null): string {
  const answer = "Answer it in the console, or tell the orchestrator.";
  if (!q) return `Read conversation.md for the question. ${answer}`;
  const end = (s: string) => s.replace(/[.\s]+$/, "");
  const parts = [`${q.phase} asks: ${q.text.trim()}`];
  if (q.why.trim()) parts.push(`Why: ${end(q.why.trim())}.`);
  if (q.options.length) parts.push(`Options: ${q.options.join(" · ")}.`);
  return `${parts.join(" ")} ${answer}`;
}

/** For each gate a person may sit on: the document they read and the status that approves it. */
const GATE_DOC: Record<keyof HumanGates, { artifact: string; approved: Status }> = {
  spec: { artifact: "spec.md", approved: "spec-approved" },
  plan: { artifact: "plan.md", approved: "plan-approved" },
  merge: { artifact: "review.md", approved: "merge-approved" },
  done: { artifact: "outcome.md", approved: "done" },
};

/**
 * Standards that cannot be read, live from main's commit (never from the trace, so a fix clears it at
 * once), then the unreadable lines of an open change's standards.md. One read of main per call.
 * True when main has standards (files in the folder, read or not).
 */
async function addStandards(root: string, cfg: Config, intents: Scan["intents"], add: (kind: AttentionItem["kind"], slug: string | null, title: string, what: string) => void): Promise<boolean> {
  let on;
  try {
    on = await branchStandards(new Git(root), cfg.main_branch);
  } catch (e) {
    // git failed (a broken repository, a timeout): one item says so, and the rest of the list stands.
    if (e instanceof StopRequested) throw e;
    add("standards", null, "Standards", `The standards on ${cfg.main_branch} could not be read: ${(errorText(e).split("\n")[0] ?? "").replace(/[.\s]+$/, "")}.`);
    return false;
  }
  if (!on) return false;
  const { read } = on;
  const stop = standardsStopText(read.problems);
  if (stop) add("standards", null, "Standards", stop);
  const known = new Set(read.standards.map((s) => s.name));
  for (const i of intents) {
    const s = i.file.frontmatter.status;
    if (s === "done" || s === "closed") continue;
    const file = join(i.dir, STANDARDS_RECORD);
    if (!existsSync(file)) continue;
    for (const problem of parseRecord(readFileSync(file, "utf8"), known).problems) add("standards", i.slug, i.file.title || i.slug, problem);
  }
  return hasStandardFiles(read);
}

/**
 * Everything that needs a person, most pressing first: a pause, a red main, main out of step with
 * GitHub, a config problem, blocked changes, held changes, unreadable intents, then changes waiting for a person
 * (drafts, and reviews with a person on the gate). `config` is the loaded config, or the problem
 * that stopped it loading (which the loop also traces). `scan` is the intent folder already read, for
 * a caller that has one (the console reads it once per rebuild); otherwise it is read here.
 */
export async function attention(root: string, config: Config | { problem: string }, trace: Trace, now: Date = new Date(), scan?: Scan): Promise<AttentionItem[]> {
  const cfg = "problem" in config ? null : config;
  scan ??= await scanRepo(root);
  const intents = orderQueue(scan.intents);
  const items: AttentionItem[] = [];
  const add = (kind: AttentionItem["kind"], slug: string | null, title: string, what: string, key?: string, label = ATTENTION_LABEL[kind]) => items.push({ kind, label, slug, title, what, ...(key ? { key } : {}) });

  // A person paused the loop: nothing new starts until they resume it. Titled apart from an outage's
  // pause, so the two are two items; worded for a loop that is stopped as much as one running.
  const loopHold = readLoopHold(root);
  if (loopHold) add("paused", null, `Paused by ${loopHold.by}`, "Nothing new starts until it is resumed. Resume it in the console, or delete .loopstra/hold.json.");

  const pause = activePause(root, now);
  if (pause) add("paused", null, "Loopstra is paused", pause.reason);
  // Only a spent day: one merely held by running phases clears by itself and needs no person.
  if (cfg && loopDaySpent(cfg, trace, now)) add("paused", null, "Loopstra is paused", loopDayNote(cfg, true));
  const health = healthView(trace, now);
  if (health && health.result !== "pass") add("health", null, "Main branch", health.text, `main_health:${health.state}`);
  // Main and GitHub out of step (waiting on a person's own commits, or failing): the newest outcome only.
  const sync = trace.lastSignal(SYNC_SIGNAL);
  if (sync && (sync.result === "fail" || sync.result === "waiting")) add("sync", null, "Main and GitHub", sync.output);
  // GitHub not answering about pull requests (gh signed out, a token it no longer takes): a passing
  // hiccup needs nobody, so only once it has lasted. The words stay the same while it lasts. Only
  // while a change watches its pull request: with none, nothing asks GitHub and the last look's
  // failure is no news (the loop stopped after it, or the change moved on).
  const since = trace.failingSince(GITHUB_SIGNAL);
  if (since && now.getTime() - Date.parse(since) >= GITHUB_SILENT_MS && intents.some((i) => WATCHING_PR.has(i.file.frontmatter.status))) {
    add("sync", null, "Not answering", `GitHub hasn't answered for 15 minutes: ${ghProblem(trace.lastSignal(GITHUB_SIGNAL)!.output)}`);
  }
  if ("problem" in config) add("config", null, "Loopstra settings", config.problem);

  const standards = cfg ? await addStandards(root, cfg, intents, add) : false;

  for (const i of intents) {
    if (i.file.frontmatter.status === "blocked") {
      add("blocked", i.slug, i.file.title || i.slug, i.file.frontmatter.note || "Stopped and needs a person. Read intent.md, then set the status line to continue.");
    }
  }
  for (const i of intents) {
    const s = i.file.frontmatter.status;
    if (!heldNote(i) || s === "done" || s === "closed") continue;
    add("held", i.slug, i.file.title || i.slug, `${heldNote(i)} The loop starts no step for it until it is released, in the console or by removing the hold line from intent.md.`);
  }
  for (const i of intents) {
    const s = i.file.frontmatter.status;
    if (!hasQuestion(i) || s === "done" || s === "closed") continue;
    add("question", i.slug, i.file.title || i.slug, questionWhat(readQuestion(root, i.slug)?.open ?? null));
  }
  for (const u of scan.unreadable) add("unreadable", u.slug, u.slug, u.problem);
  const human = humanGates(cfg);
  for (const i of intents) {
    const fm = i.file.frontmatter;
    // A depends_on only a person can untangle (a name that matches no change, a closed one, a loop).
    const wait = dependencyWait(i, intents);
    if (wait?.needsPerson) {
      add("waiting", i.slug, i.file.title || i.slug, wait.note);
      continue;
    }
    const title = i.file.title || i.slug;
    // Its pull request waits (see prWait): for an engineer, whoever is on the gate; or for nothing a
    // person does on this change (GitHub merged it or is merging it, or main here must catch up, which
    // the sync item asks for), so the gate's note no longer applies.
    const pr = prWait(root, i);
    if (pr.needsPerson) {
      add("waiting", i.slug, title, pr.wait);
      continue;
    }
    if (fm.status === "blocked" || !waitsForPerson(i, human) || pr.wait) continue;
    if (fm.status === "draft") {
      add("waiting", i.slug, title, fm.note || "A draft. When it says what you want, change the status line to accepted. To drop it, set it to closed.");
      continue;
    }
    const gate = REVIEW_GATE[fm.status]!;
    // A spec or plan asking for exceptions says which rules in its label.
    const asks = standards && (gate === "spec" || gate === "plan") ? exceptionsWaiting(i.dir, gate) : [];
    const label = asks.length ? `${ATTENTION_LABEL.waiting}: ${asks.length > 1 ? "exceptions" : "exception"} to ${andList(asks)}` : undefined;
    add("waiting", i.slug, title, fm.note || humanNote(GATE_DOC[gate].artifact, GATE_DOC[gate].approved, changeGates(human, fm)[gate]), undefined, label);
  }
  return items;
}

/** The rules whose exceptions a change's spec or plan asks a person to allow (see exceptionsToApprove), read from its folder. */
function exceptionsWaiting(dir: string, gate: "spec" | "plan"): string[] {
  const read = (name: string): string | null => {
    try { return readFileSync(join(dir, name), "utf8"); } catch { return null; }
  };
  return exceptionsToApprove(read(`${gate}.md`) ?? "", parseRecord(read(STANDARDS_RECORD))).map((b) => b.label);
}
