import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { doneWords, isOpen, personReviews, resultText, retryOptions, targetOf, undoAllowed } from "./actions";
import type { Config } from "./config";
import { commitRecord, dropSentBack, MainCheckoutMoved, statusPatch, writeSentBack } from "./context";
import { effectivePriority, humanGates, parseIntentFile, readIntent, SLUG, writeIntent, type Frontmatter, type Intent, type Status } from "./intents";
import { applyingRequests, claimRequest, drainOld, finishRequest, pruneResults, saveApplying, waitingIds, type Outcome, type Request } from "./requests";
import { errorText } from "./shell";
import { StopRequested } from "./stop";
import type { Trace } from "./trace";
import { CHAT_SLUG } from "./chat/agents";
import { oneLine } from "./chat/threads";

type StatusRequest = Extract<Request, { kind: "approve" | "send-back" | "retry" | "close" | "undo" }>;
type FieldRequest = Extract<Request, { kind: "priority" | "hold" | "release" }>;

/** One pass at a time per process: the tick's and the applier's never overlap (see applyRequests). */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Applies every waiting request on the main checkout, as the loop: claims each (see claimRequest),
 * then applies the claimed ones oldest first through commitRecord. A request that hits an unexpected
 * problem (a commit refused, the checkout off main) is traced and stays claimed for the next pass; one
 * that cannot be done gets a plain result saying why. Passes run one after another, never side by side.
 * Gives how many were finished.
 */
export function applyRequests(root: string, cfg: Config, trace: Trace): Promise<number> {
  const next = chain.then(() => applyPass(root, cfg, trace), () => applyPass(root, cfg, trace));
  chain = next.catch(() => {});
  return next;
}

async function applyPass(root: string, cfg: Config, trace: Trace): Promise<number> {
  drainOld(root);
  pruneResults(root);
  for (const id of waitingIds(root)) claimRequest(root, id);
  let applied = 0;
  for (const req of applyingRequests(root)) {
    try {
      finishRequest(root, req, await applyOne(root, cfg, trace, req));
      applied++;
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      // Traced once while it stays the same: a checkout off main would otherwise add a line every 2 s.
      trace.eventOnChange("_loop", "error", `"where":"request","id":"${req.id}"`, { where: "request", id: req.id, kind: req.kind, error: e instanceof MainCheckoutMoved ? e.message : errorText(e) }, "error");
    }
  }
  return applied;
}

function applyOne(root: string, cfg: Config, trace: Trace, req: Request): Promise<Outcome> {
  switch (req.kind) {
    case "accept": return applyAccept(root, cfg.main_branch, trace, req);
    case "new": return applyNew(root, cfg.main_branch, trace, req);
    case "priority": case "hold": case "release": return applyField(root, cfg, trace, req);
    default: return applyStatus(root, cfg, trace, req);
  }
}

/** Who and where, for a commit subject or a note: "John from the dashboard". */
function byWhom(req: Request): string {
  return `${oneLine(req.byName, 80)} from ${oneLine(req.via, 40)}`;
}

/** Records on the claimed request that the loop wrote this slug's intent.md, before committing it. */
function markWritten(root: string, req: Request, slug: string): void {
  req.written = [...new Set([...(req.written ?? []), slug])];
  saveApplying(root, req);
}

async function applyAccept(root: string, main: string, trace: Trace, req: Extract<Request, { kind: "accept" }>): Promise<Outcome> {
  const path = join(root, "intent", req.slug, "intent.md");
  if (!SLUG.test(req.slug) || !existsSync(path)) {
    trace.event(CHAT_SLUG, "chat-request", { id: req.id, kind: "accept", slug: req.slug, by: req.byName, result: "missing" });
    return { ok: false, status: null, text: `I could not start ${req.slug}: it is not in the main code. If it came from a pull request, that needs to be merged first.` };
  }
  let refused = null as Status | null;
  await commitRecord(root, main, req.slug, `accepted by ${byWhom(req)}`, async () => {
    const intent = await readIntent(root, req.slug);
    const was = intent.file.frontmatter.status;
    // Written by an earlier try of this request whose commit failed: commit it now.
    const ours = was === "accepted" && (req.written ?? []).includes(req.slug);
    if (!ours && !(await writeIntent(intent, { status: "accepted", note: "" }, { expectStatus: "draft" }))) {
      refused = was;
      return false;
    }
    markWritten(root, req, req.slug);
  });
  if (refused !== null) {
    trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, result: "not-draft", status: refused });
    return { ok: false, status: refused, text: `I did not start ${req.slug}: it is ${refused} now, not a draft, so someone already changed it.` };
  }
  trace.statusChange(req.slug, "draft", "accepted", `accepted by ${byWhom(req)}`);
  trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, byId: req.by, transport: req.transport, result: "accepted" });
  return { ok: true, status: "accepted", text: `Started ${req.slug}. I will say here when it needs anyone, and when it is done.` };
}

async function applyNew(root: string, main: string, trace: Trace, req: Extract<Request, { kind: "new" }>): Promise<Outcome> {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const i of req.intents) {
    if (!SLUG.test(i.slug)) { skipped.push(`${i.slug} (not a valid change name)`); continue; }
    const dir = join(root, "intent", i.slug);
    const path = join(dir, "intent.md");
    // Written by an earlier try of this request whose commit failed: that is ours, not someone else's.
    const ours = (req.written ?? []).includes(i.slug);
    if (existsSync(path) && !ours) {
      let status = "unreadable";
      try { status = parseIntentFile(await Bun.file(path).text()).frontmatter.status; } catch { /* keep unreadable */ }
      if (!i.update || status !== "draft") { skipped.push(`${i.slug} (it already exists and is ${status})`); continue; }
    }
    await commitRecord(root, main, i.slug, `${i.update ? "update" : "open"} intent from chat`, async () => {
      mkdirSync(dir, { recursive: true });
      await Bun.write(path, i.text);
      markWritten(root, req, i.slug);
    });
    trace.event(i.slug, "chat-request", { id: req.id, kind: "new", by: req.byName, update: i.update });
    added.push(i.slug);
  }
  const parts: string[] = [];
  if (added.length) parts.push(`Added to the queue as drafts: ${added.join(", ")}. Read them in intent/, then set status to accepted, or ask me to start one.`);
  if (skipped.length) parts.push(`Not written, because something changed meanwhile: ${skipped.join("; ")}.`);
  return { ok: added.length > 0, status: null, text: parts.join(" ") || "Nothing was written." };
}

/** The change a request is about, or the plain reason it cannot be read. */
async function current(root: string, slug: string): Promise<{ intent: Intent } | { problem: string }> {
  if (!SLUG.test(slug) || !existsSync(join(root, "intent", slug, "intent.md"))) return { problem: `There is no change called ${slug} in the main code.` };
  try {
    return { intent: await readIntent(root, slug) };
  } catch {
    return { problem: `${slug}'s intent.md cannot be read, so nothing changed. Fix it, then try again.` };
  }
}

function traced(trace: Trace, req: StatusRequest | FieldRequest, result: string, more: Record<string, unknown> = {}): void {
  trace.event(req.slug, "request", { id: req.id, kind: req.kind, by: req.byName, byId: req.by, via: req.via, transport: req.transport, result, ...more });
}

/** Why a status request is not something the change can do from `expect`, or null when it is. */
function notAllowed(req: StatusRequest, fm: Frontmatter, cfg: Config, trace: Trace): string | null {
  const human = humanGates(cfg);
  switch (req.kind) {
    case "approve": case "send-back":
      if (!targetOf(req)) return `${req.slug} cannot be ${req.kind === "approve" ? "approved" : "sent back"} while it is ${req.expect}.`;
      return personReviews(req.expect, human) ? null : `${req.slug} cannot be ${req.kind === "approve" ? "approved" : "sent back"} now: nobody reviews that step, so the loop goes on by itself.`;
    case "retry": {
      const options = retryOptions(trace, req.slug, fm.note);
      if (options.includes(req.to)) return null;
      return options.length ? `${req.slug} cannot be retried from ${req.to}; its note names ${options.join(" or ")}.` : `${req.slug} cannot be retried from ${req.to}; its note names no status to retry from.`;
    }
    case "close": return isOpen(req.expect) ? null : `${req.slug} is ${req.expect} already.`;
    case "undo": return undoAllowed(req.expect, req.to) ? null : `${req.slug} cannot go back from ${req.expect} to ${req.to}.`;
  }
}

/** The note a status request leaves on the change. */
function noteFor(req: StatusRequest): string {
  switch (req.kind) {
    case "send-back": return `Sent back by ${byWhom(req)}: ${req.note.trim()}`;
    case "close": return `Closed by ${byWhom(req)}.`;
    case "undo": return req.note;
    default: return "";
  }
}

/**
 * Approve, send back, retry, close and undo: only when the status is still the one the person saw
 * (`expect`), and only when the action is allowed from it. Committed as "<what> by <who> from <where>".
 */
async function applyStatus(root: string, cfg: Config, trace: Trace, req: StatusRequest): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const was = found.intent.file.frontmatter.status;
  const to = targetOf(req);
  // Written by an earlier try of this request whose commit failed: commit it now.
  const ours = (req.written ?? []).includes(req.slug) && was === to;
  if (!ours && was !== req.expect) { traced(trace, req, "moved-on", { status: was }); return { ok: false, status: was, text: `${req.slug} moved on to ${was}; nothing changed.` }; }
  const problem = ours ? null : notAllowed(req, found.intent.file.frontmatter, cfg, trace);
  if (problem || !to) { traced(trace, req, "refused", { status: was }); return { ok: false, status: was, text: problem ?? `${req.slug} cannot do that now.` }; }
  const note = noteFor(req);
  let refused = null as Status | null;
  await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async () => {
    if (ours) return;
    const fresh = await readIntent(root, req.slug);
    if (!(await writeIntent(fresh, statusPatch(req.expect, to, note), { expectStatus: req.expect }))) {
      refused = fresh.file.frontmatter.status;
      return false;
    }
    req.written = [...new Set([...(req.written ?? []), req.slug])];
    saveApplying(root, req);
  });
  if (refused !== null) { traced(trace, req, "moved-on", { status: refused }); return { ok: false, status: refused, text: `${req.slug} moved on to ${refused}; nothing changed.` }; }
  trace.upsertIntent(req.slug, to, effectivePriority(found.intent.file.frontmatter));
  trace.statusChange(req.slug, req.expect, to, note, { by: req.byName, via: req.via });
  traced(trace, req, "applied", { from: req.expect, to, what: doneWords(req) });
  if (req.kind === "send-back") writeSentBack(root, req.slug, req.note.trim());
  if (req.kind === "undo") dropSentBack(root, req.slug);
  return { ok: true, status: to, text: resultText(req, req.slug, to) };
}

/** The hold line for a hold request: the reason, then who and where. */
function holdLine(req: Extract<Request, { kind: "hold" }>): string {
  const reason = oneLine(req.reason, 300).replace(/[.\s]+$/, "") || "held";
  return `${reason} (${oneLine(req.byName, 80)}, ${oneLine(req.via, 40)})`;
}

/**
 * Priority, hold and release: on any open change, whatever its status now (a running change moves
 * on every few minutes; a hold must still land). Committed like the status requests.
 */
async function applyField(root: string, cfg: Config, trace: Trace, req: FieldRequest): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const fm = found.intent.file.frontmatter;
  if (!isOpen(fm.status)) { traced(trace, req, "refused", { status: fm.status }); return { ok: false, status: fm.status, text: `${req.slug} is ${fm.status}; nothing changed.` }; }
  if (req.kind === "hold" && fm.hold.trim()) return { ok: false, status: fm.status, text: `${req.slug} is held already; nothing changed.` };
  if (req.kind === "release" && !fm.hold.trim()) return { ok: false, status: fm.status, text: `${req.slug} is not held; nothing changed.` };
  const patch: Partial<Frontmatter> = req.kind === "priority" ? { priority: req.priority } : req.kind === "hold" ? { hold: holdLine(req) } : {};
  const remove: Array<keyof Frontmatter> = req.kind === "release" ? ["hold"] : [];
  await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async () => {
    await writeIntent(await readIntent(root, req.slug), patch, { remove });
  });
  if (req.kind === "priority") trace.upsertIntent(req.slug, fm.status, req.priority);
  traced(trace, req, "applied", { status: fm.status, what: doneWords(req) });
  return { ok: true, status: fm.status, text: resultText(req, req.slug, fm.status) };
}
