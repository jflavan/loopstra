import { steerable } from "../console/steerable";
import type { AgentFilesOp, ChangeSummary, Offer, SourceItems } from "../console/types";
import { dismiss, toast } from "./store";

/*
 * The page's side of a request: send an action to /api/requests, follow the loop's answer, and undo
 * it (cancel it while the loop has not claimed it, or send the reverse once it has applied it).
 */

/**
 * What the page posts to /api/requests. A `priority` of null takes the priority line out (an undo to no
 * stated priority). `text`: an answer's words; `question`: when the question it answers was asked.
 */
interface ActionBody { kind: string; slug: string; expect?: string; to?: string; note?: string; priority?: string | null; reason?: string; text?: string; question?: string }

/** What the change was before an action, so an undo can put it back. `priority`: the priority line as written, or null when there was none. */
interface Before { note: string; priority: string | null }

/** A change's Before as the page shows it: its stated priority, not the one it reads as (normal when none is stated). */
export function beforeOf(c: ChangeSummary): Before {
  return { note: c.note, priority: c.statedPriority };
}

/**
 * The request for an offer on a change: the change, the status the person saw, and what the action needs.
 * An answer (its words in `note`) names no status, whatever the status; it names the question the person
 * saw, so the loop refuses it when another one waits by then.
 */
export function bodyFor(c: ChangeSummary, offer: Offer, input: { note?: string; priority?: string; reason?: string } = {}): ActionBody {
  if (offer.kind === "answer") {
    const b: ActionBody = { kind: "answer", slug: c.slug, text: input.note ?? "" };
    if (c.question?.at) b.question = c.question.at;
    return b;
  }
  const b: ActionBody = { kind: offer.kind, slug: c.slug, expect: c.status };
  if (offer.kind === "retry") b.to = offer.to;
  if (offer.kind === "send-back") b.note = input.note ?? "";
  if (offer.kind === "priority") b.priority = input.priority;
  if (offer.kind === "hold") b.reason = input.reason ?? "";
  return b;
}

/** The actions with an Undo (see decision 5 in the plan): close asks first, the others start work. */
export const UNDOABLE: ReadonlySet<string> = new Set(["approve", "send-back", "priority", "hold"]);

/** The request that takes back \`b\`, once the loop applied it and left the change at \`status\`; null when there is none. */
export function undoFor(b: ActionBody, before: Before, status: string | null): ActionBody | null {
  if (!status) return null;
  switch (b.kind) {
    case "approve": case "send-back": return { kind: "undo", slug: b.slug, expect: status, to: b.expect, note: before.note };
    // A change that had no priority line gets none again (null), not a "normal" written into its file.
    case "priority": return { kind: "priority", slug: b.slug, expect: status, priority: before.priority };
    case "hold": return { kind: "release", slug: b.slug, expect: status };
    default: return null;
  }
}

/** How long to wait before asking for a result again, by how many times it was asked; null: stop asking. */
export function nextPoll(asked: number): number | null {
  if (asked < 30) return 1000;
  if (asked < 144) return 5000;
  return null;
}

/** The loop's answer to a request. \`status\`: the change's status after it (null when there is no change). */
interface Done { state: "done"; ok: boolean; text: string; status: string | null }

/** Posts JSON to the console; gives the reply, or the plain words of why it failed. */
async function post(url: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (r.ok) return { ok: true, data };
    return { ok: false, error: typeof data.error === "string" ? data.error : `The console said no (${r.status}).` };
  } catch {
    return { ok: false, error: "The console could not be reached." };
  }
}

/** Takes a request back while the loop has not claimed it; true when it was (nothing changed). */
async function cancel(id: string): Promise<boolean> {
  try {
    return (await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: "DELETE" })).ok;
  } catch {
    return false;
  }
}

/**
 * Asks for a request's result until it is done (see nextPoll); gives back a stopper. A request the
 * console no longer knows (cancelled, or its result read already) ends quietly.
 */
function follow(id: string, onDone: (d: Done) => void): () => void {
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const ask = async () => {
    if (stopped) return;
    try {
      // The page sends no Referer (index.html), but this read asks for one to its own origin: a browser
      // too old to say the request is same-origin is let read the result by it (see ownSite).
      const r = await fetch(`/api/requests/${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, referrerPolicy: "same-origin" });
      if (r.status === 404) return;
      const s = await r.json() as { state: string } & Partial<Done>;
      if (s.state === "done") {
        if (!stopped) onDone({ state: "done", ok: !!s.ok, text: s.text ?? "", status: s.status ?? null });
        return;
      }
    } catch { /* asked again below */ }
    const wait = nextPoll(++asked);
    if (wait !== null && !stopped) timer = setTimeout(() => void ask(), wait);
  };
  timer = setTimeout(() => void ask(), nextPoll(0)!);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** The toast when an action could not be sent at all: plain words; the error itself goes to the browser's console. */
export function unsentText(label: string): string {
  return `${label}: it could not be sent. Try again.`;
}

/**
 * Sends an action and keeps the person told: a toast at once (with Undo for 10 s when the action has
 * one), then the loop's answer. Undo cancels the request if the loop has not claimed it yet;
 * otherwise it waits for the answer and sends the reverse (see undoFor). \`label\` names the action
 * in the toasts. Gives whether it was sent.
 */
export async function act(b: ActionBody, before: Before, label: string, opts: { undo?: boolean } = {}): Promise<boolean> {
  const sent = await post("/api/requests", b);
  if (!sent.ok) {
    toast(sent.error, "bad");
    return false;
  }
  const id = String(sent.data.id);
  // The loop's state as the server named it; anything else reads as unknown, which the toast treats as running.
  const loop = typeof sent.data.loop === "string" ? sent.data.loop : "";
  let done: Done | null = null;
  // Set by Undo: what to do with the answer instead of showing it.
  let afterUndo: ((d: Done) => void) | null = null;
  const undo = async () => {
    if (await cancel(id)) {
      afterUndo = () => {};
      toast("Cancelled; nothing changed.");
      return;
    }
    // `shown`: the answer was toasted already. A failure then needs no more words: nothing changed to take back.
    const reverse = (d: Done, shown: boolean) => {
      const back = d.ok ? undoFor(b, before, d.status) : null;
      if (back) void act(back, before, "Undo", { undo: false });
      else if (!shown) toast(d.text, d.ok ? "info" : "bad");
    };
    if (done) reverse(done, true);
    else afterUndo = (d) => reverse(d, false);
  };
  const withUndo = opts.undo !== false && UNDOABLE.has(b.kind);
  const said = loop === "stopped" || loop === "not-responding" ? `${label}: saved. It applies when the loop runs.` : `${label}: sent to the loop.`;
  const sentToast = toast(said, "info", withUndo ? { action: { label: "Undo", run: () => void undo() }, ms: 10_000 } : {});
  follow(id, (d) => {
    done = d;
    // An action that failed changed nothing, so its Undo goes (dismissing a toast already gone does nothing).
    if (!d.ok) dismiss(sentToast);
    if (afterUndo) { afterUndo(d); return; }
    toast(d.text, d.ok ? "info" : "bad");
  });
  return true;
}

/**
 * What a person may do to a session from its page: message (and redirect) a running work session, stop
 * any running one. Null once it has ended, or when it is not running. `note` says why a check cannot be messaged.
 */
export function steerOffer(phaseName: string, status: string, ended: boolean): { message: boolean; stop: boolean; note?: string } | null {
  if (ended || status !== "running") return null;
  return steerable(phaseName) ? { message: true, stop: true } : { message: false, stop: true, note: "Checks cannot be messaged. Approve or send back instead." };
}

/** Sends a message, a redirect or a stop to a running session; says what happened in a toast. Gives whether it was sent. */
export async function steer(slug: string, seq: number, kind: "message" | "redirect" | "stop", text = ""): Promise<boolean> {
  const r = await post(`/api/sessions/${encodeURIComponent(slug)}/${seq}/message`, { kind, text });
  if (!r.ok) { toast(r.error, "bad"); return false; }
  toast(kind === "stop" ? "Stopping the session. The change is held, so it does not start again." : kind === "redirect" ? "Sent: the session starts again your way." : "Sent: the session reads it at its next step.");
  return true;
}

/** Stops every running session of a change, which is held so it does not start again; says so in a toast. Gives whether it was sent. */
export async function stopChange(slug: string): Promise<boolean> {
  const r = await post(`/api/changes/${encodeURIComponent(slug)}/stop`, {});
  if (!r.ok) { toast(r.error, "bad"); return false; }
  toast(`Stopping ${slug}. It is held, so it does not start again until someone releases it.`);
  return true;
}

/** Pauses or resumes the loop, and says what that means. */
export async function setLoopHeld(held: boolean): Promise<void> {
  const r = await post("/api/loop", { action: held ? "pause" : "resume" });
  if (!r.ok) { toast(r.error, "bad"); return; }
  toast(held ? "The loop is paused: running steps finish, nothing new starts." : "The loop goes on.");
}

/**
 * A settings request: the dotted path, its new value (a word, a list of names for the agents lists, or
 * null to remove it; an empty list removes it too), and the config version the page read.
 */
interface SettingBody { kind: "settings"; path: string; value: string | string[] | null; version: string }

/** What sending a request that the loop answers later gives: the request (its id, and the loop's state, which says whether it waits for the loop to run) or why it was not sent, a stale page included. */
type Sent = { ok: true; id: string; loop: string } | { ok: false; error: string };

/** Posts a request the loop applies, and follows the loop's answer to `onDone`. */
async function sendFollowed(url: string, body: unknown, onDone: (d: { ok: boolean; text: string }) => void): Promise<Sent> {
  const sent = await post(url, body);
  if (!sent.ok) return sent;
  const id = String(sent.data.id);
  follow(id, (d) => onDone({ ok: d.ok, text: d.text }));
  return { ok: true, id, loop: typeof sent.data.loop === "string" ? sent.data.loop : "" };
}

/** Sends one setting change and follows the loop's answer to `onDone` (see sendFollowed). */
export function sendSetting(body: SettingBody, onDone: (d: { ok: boolean; text: string }) => void): Promise<Sent> {
  return sendFollowed("/api/requests", body, onDone);
}

/** Sends an operation on the repository's agents and skills and follows the loop's answer to `onDone`, as sendSetting does. */
export function sendAgentFiles(op: AgentFilesOp, onDone: (d: { ok: boolean; text: string }) => void): Promise<Sent> {
  return sendFollowed("/api/agents/files", op, onDone);
}

/** What a git repository or folder holds, as the server lists it, or why it could not (in words). */
export async function listSource(url: string): Promise<SourceItems> {
  try {
    // It clones, so the server takes it only from this page: a browser too old to say the request is
    // same-origin is let by a Referer to its own origin (see ownSite), which the page otherwise never sends.
    const r = await fetch(`/api/agents/source?url=${encodeURIComponent(url)}`, { headers: { accept: "application/json" }, referrerPolicy: "same-origin" });
    const data = await r.json().catch(() => ({})) as { items?: Extract<SourceItems, { items: unknown }>["items"]; error?: unknown };
    if (r.ok && Array.isArray(data.items)) return { items: data.items };
    return { error: typeof data.error === "string" ? data.error : `The console said no (${r.status}).` };
  } catch {
    return { error: "The console could not be reached." };
  }
}

/** Takes a setting change back while the loop has not claimed it; true when it was (nothing changed). */
export function cancelSetting(id: string): Promise<boolean> {
  return cancel(id);
}
