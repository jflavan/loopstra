import type { ChangeSummary, Offer } from "../console/types";
import { toast } from "./store";

/*
 * The page's side of a request: send an action to /api/requests, follow the loop's answer, and undo
 * it (cancel it while the loop has not claimed it, or send the reverse once it has applied it).
 */

/** What the page posts to /api/requests. */
export interface ActionBody { kind: string; slug: string; expect?: string; to?: string; note?: string; priority?: string; reason?: string }

/** What the change was before an action, so an undo can put it back. */
export interface Before { note: string; priority: string }

/** The request for an offer on a change: the change, the status the person saw, and what the action needs. */
export function bodyFor(c: ChangeSummary, offer: Offer, input: { note?: string; priority?: string; reason?: string } = {}): ActionBody {
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
export interface Done { state: "done"; ok: boolean; text: string; status: string | null }

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
export async function cancel(id: string): Promise<boolean> {
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
export function follow(id: string, onDone: (d: Done) => void): () => void {
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const ask = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`/api/requests/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
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
  const loop = String(sent.data.loop ?? "");
  let done: Done | null = null;
  // Set by Undo: what to do with the answer instead of showing it.
  let afterUndo: ((d: Done) => void) | null = null;
  const undo = async () => {
    if (await cancel(id)) {
      afterUndo = () => {};
      toast("Cancelled; nothing changed.");
      return;
    }
    const reverse = (d: Done) => {
      const back = d.ok ? undoFor(b, before, d.status) : null;
      if (back) void act(back, before, "Undo", { undo: false });
      else toast(d.text, d.ok ? "info" : "bad");
    };
    if (done) reverse(done);
    else afterUndo = reverse;
  };
  const withUndo = opts.undo !== false && UNDOABLE.has(b.kind);
  const said = loop === "stopped" || loop === "not-responding" ? `${label}: saved. It applies when the loop runs.` : `${label}: sent to the loop.`;
  toast(said, "info", withUndo ? { action: { label: "Undo", run: () => void undo() }, ms: 10_000 } : {});
  follow(id, (d) => {
    done = d;
    if (afterUndo) { afterUndo(d); return; }
    toast(d.text, d.ok ? "info" : "bad");
  });
  return true;
}

/** Pauses or resumes the loop, and says what that means. */
export async function setLoopHeld(held: boolean): Promise<void> {
  const r = await post("/api/loop", { action: held ? "pause" : "resume" });
  if (!r.ok) { toast(r.error, "bad"); return; }
  toast(held ? "The loop is paused: running steps finish, nothing new starts." : "The loop goes on.");
}
