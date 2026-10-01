import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import { bookkeeping, Git } from "../git";
import { parseIntentFile, readIntent, SLUG, writeIntent } from "../intents";
import { errorText } from "../shell";
import { StopRequested } from "../stop";
import type { Trace } from "../trace";
import { CHAT_SLUG } from "./agents";
import { chatDir, oneLine, readJson, writeJson } from "./threads";

/**
 * Chat never writes the main checkout: only the loop does, so two processes never commit on main at
 * once. Chat leaves a request in `.loopstra/chat/requests/`; the loop applies it at the start of its
 * next tick and leaves a plain-words result in `.loopstra/chat/results/` for chat to pass on.
 */
/**
 * `written`: the slugs whose intent.md the loop already wrote for this request. A request whose
 * commit failed is tried again next tick, and must not then read its own write as someone else's.
 */
interface RequestBase { id: string; by: string; byName: string; transport: string; thread: string; at: string; written?: string[] }
export type ChatRequest =
  | RequestBase & { kind: "accept"; slug: string }
  | RequestBase & { kind: "new"; title: string; intents: Array<{ slug: string; text: string; update: boolean }> };

export interface ChatResult { id: string; transport: string; thread: string; text: string; at: string }

type NewRequest = Omit<Extract<ChatRequest, { kind: "new" }>, "id" | "at">;
type AcceptRequest = Omit<Extract<ChatRequest, { kind: "accept" }>, "id" | "at">;

function requestsDir(root: string): string { return join(chatDir(root), "requests"); }
function resultsDir(root: string): string { return join(chatDir(root), "results"); }

let counter = 0;
/** Sorts in the order requests were made. */
function newId(): string {
  return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(4, "0")}`;
}

export function submitRequest(root: string, req: NewRequest | AcceptRequest): ChatRequest {
  const full = { ...req, id: newId(), at: new Date().toISOString() } as ChatRequest;
  mkdirSync(requestsDir(root), { recursive: true });
  writeJson(join(requestsDir(root), `${full.id}.json`), full);
  return full;
}

/** Requests the loop has not applied yet, oldest first. */
export function pendingRequests(root: string): ChatRequest[] {
  const dir = requestsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
    .map((n) => readJson<ChatRequest>(join(dir, n))).filter((r): r is ChatRequest => !!r && typeof r.id === "string");
}

/**
 * Results the loop left for the given transports, oldest first; each is removed as it is taken, so
 * it is passed on once. Results for transports another process serves are left for that process.
 */
export function takeResults(root: string, transports: ReadonlySet<string>): ChatResult[] {
  const dir = resultsDir(root);
  if (!existsSync(dir)) return [];
  const out: ChatResult[] = [];
  for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const r = readJson<ChatResult>(join(dir, n));
    if (r && !transports.has(r.transport)) continue;
    rmSync(join(dir, n), { force: true });
    if (r) out.push(r);
  }
  return out;
}

/** Records on the request that the loop wrote this slug's intent.md, before committing it. */
function markWritten(root: string, req: ChatRequest, slug: string): void {
  req.written = [...new Set([...(req.written ?? []), slug])];
  writeJson(join(requestsDir(root), `${req.id}.json`), req);
}

function finish(root: string, req: ChatRequest, text: string): void {
  mkdirSync(resultsDir(root), { recursive: true });
  writeJson(join(resultsDir(root), `${req.id}.json`), { id: req.id, transport: req.transport, thread: req.thread, text, at: new Date().toISOString() } satisfies ChatResult);
  rmSync(join(requestsDir(root), `${req.id}.json`), { force: true });
}

/**
 * Applies every waiting chat request on the main checkout, as the loop. Called by the tick after
 * main is synced and only when the checkout is on main. A request that hits an unexpected problem
 * is traced and left for the next tick; one that cannot be done gets a plain result saying why.
 */
export async function applyChatRequests(root: string, cfg: Config, trace: Trace): Promise<number> {
  let applied = 0;
  for (const req of pendingRequests(root)) {
    try {
      const text = req.kind === "accept" ? await applyAccept(root, trace, req) : await applyNew(root, trace, req);
      finish(root, req, text);
      applied++;
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      trace.event(CHAT_SLUG, "error", { where: "chat-request", id: req.id, kind: req.kind, error: errorText(e) });
    }
  }
  return applied;
}

async function applyAccept(root: string, trace: Trace, req: Extract<ChatRequest, { kind: "accept" }>): Promise<string> {
  const path = join(root, "intent", req.slug, "intent.md");
  if (!SLUG.test(req.slug) || !existsSync(path)) {
    trace.event(CHAT_SLUG, "chat-request", { id: req.id, kind: "accept", slug: req.slug, by: req.byName, result: "missing" });
    return `I could not start ${req.slug}: it is not in the main code. If it came from a pull request, that needs to be merged first.`;
  }
  const intent = await readIntent(root, req.slug);
  const was = intent.file.frontmatter.status;
  // Written by an earlier try of this request whose commit failed: commit it now.
  const ours = was === "accepted" && (req.written ?? []).includes(req.slug);
  if (!ours && !(await writeIntent(intent, { status: "accepted", note: "" }, { expectStatus: "draft" }))) {
    trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, result: "not-draft", status: was });
    return `I did not start ${req.slug}: it is ${was} now, not a draft, so someone already changed it.`;
  }
  markWritten(root, req, req.slug);
  await new Git(root).commitPaths([`intent/${req.slug}`], bookkeeping(`loopstra(${req.slug}): accepted by ${oneLine(req.byName, 80)} from chat`));
  trace.statusChange(req.slug, "draft", "accepted", `accepted by ${req.byName} from chat`);
  trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, byId: req.by, transport: req.transport, result: "accepted" });
  return `Started ${req.slug}. I will say here when it needs anyone, and when it is done.`;
}

async function applyNew(root: string, trace: Trace, req: Extract<ChatRequest, { kind: "new" }>): Promise<string> {
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
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, i.text);
    markWritten(root, req, i.slug);
    await new Git(root).commitPaths([`intent/${i.slug}`], bookkeeping(`loopstra(${i.slug}): ${i.update ? "update" : "open"} intent from chat`));
    trace.event(i.slug, "chat-request", { id: req.id, kind: "new", by: req.byName, update: i.update });
    added.push(i.slug);
  }
  const parts: string[] = [];
  if (added.length) parts.push(`Added to the queue as drafts: ${added.join(", ")}. Read them in intent/, then set status to accepted, or ask me to start one.`);
  if (skipped.length) parts.push(`Not written, because something changed meanwhile: ${skipped.join("; ")}.`);
  return parts.join(" ") || "Nothing was written.";
}
