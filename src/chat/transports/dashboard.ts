import { json, jsonWrite } from "../../console/routes";
import { SLUG } from "../../intents";
import type { About } from "../about";
import { AnnouncementLog } from "../announcer";
import type { OnMessage, Transport } from "../service";
import { localUser } from "./shared";
import { StateFileUnavailable } from "../statefile";
import { ThreadStore } from "../threads";

/** A browser tab's thread id: made by the page, so only a plain shape is accepted. */
const THREAD = /^[a-z0-9-]{8,64}$/;
/** The longest message the panel takes. */
const MAX_TEXT = 20_000;

/**
 * The change (and session) a post says the drawer was opened from: a slug that is a change name, and
 * a seq that is a positive whole number when there is one. Anything else is dropped, not refused: the
 * message itself still goes through.
 */
function aboutOf(v: unknown): About | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const { slug, seq } = v as { slug?: unknown; seq?: unknown };
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  if (seq === undefined) return { slug };
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? { slug, seq } : null;
}

/**
 * The chat panel in `loopstra ui`: one conversation per browser tab. The page posts a message to
 * `/api/chat` and reads the thread back with `GET /api/chat?thread=...&after=<message id>`, so a
 * long turn never holds a request open. The dashboard only listens on 127.0.0.1, so whoever uses it
 * is at the machine, like the terminal: they may start drafts.
 */
export class DashboardTransport implements Transport {
  readonly name = "dashboard";
  readonly via = "the dashboard";
  readonly announceFrom = "now" as const;
  private onMessage: OnMessage | null = null;
  private readonly busy = new Set<string>();
  private readonly store: ThreadStore;
  private readonly log: AnnouncementLog;
  private readonly user: string;

  constructor(root: string, user?: string) {
    this.store = new ThreadStore(root);
    this.log = new AnnouncementLog(root);
    this.user = user ?? localUser();
  }

  async start(onMessage: OnMessage): Promise<void> { this.onMessage = onMessage; }
  /** The orchestrator has already put the message in the thread's log, which the page reads. */
  async send(): Promise<void> {}
  async stop(): Promise<void> { this.onMessage = null; }

  /**
   * Handles `/api/chat`, once the console has checked the host name (see serveConsole). A post goes
   * through the checks every write of the console goes through (see jsonWrite), so another web page
   * open in the browser cannot post into the chat. Every answer is made by routes.ts, which says no
   * browser or anything between may keep it: each is a conversation's state at that moment. A thread
   * whose file cannot be used now (see readStateFile) is a 503, to a read and to a post (which then
   * passes nothing on), so the page's poll gets a plain answer and nothing is logged for each one.
   */
  async handle(req: Request, url: URL): Promise<Response> {
    try {
      return await this.answer(req, url);
    } catch (e) {
      if (!(e instanceof StateFileUnavailable)) throw e;
      return json({ error: "This conversation's file cannot be read right now." }, 503);
    }
  }

  private async answer(req: Request, url: URL): Promise<Response> {
    if (req.method === "GET" || req.method === "HEAD") {
      const thread = url.searchParams.get("thread") ?? "";
      if (!THREAD.test(thread)) return json({ error: "thread" }, 400);
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const t = this.store.get(this.name, thread);
      // -1: the page just opened; it gets only where the announcements are, and shows new ones from there.
      const annAfter = Number(url.searchParams.get("announcementsAfter") ?? -1);
      const announcements = annAfter < 0 ? [] : this.log.since(annAfter);
      return json({
        messages: t.messages.filter((m) => m.id > after),
        busy: this.busy.has(thread),
        waitingForYes: t.pending !== null,
        announcements,
        lastAnnouncementId: announcements.at(-1)?.id ?? (annAfter < 0 ? this.log.lastId() : annAfter),
      });
    }
    return jsonWrite(req, url, (body) => this.take(body));
  }

  /** A post that passed the console's checks: the message is taken, and answered while the page polls. */
  private take(body: Record<string, unknown>): Response {
    const thread = typeof body.thread === "string" ? body.thread : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!THREAD.test(thread) || !text || text.length > MAX_TEXT) return json({ error: "message" }, 400);
    if (!this.onMessage) return json({ error: "chat is not running" }, 503);
    if (this.busy.has(thread)) return json({ error: "busy" }, 409);
    // Read first: a thread whose file cannot be used now throws here (see handle), before the post is taken.
    this.store.get(this.name, thread);
    this.busy.add(thread);
    const handle = this.onMessage;
    const about = aboutOf(body.about);
    void handle({ thread, authorId: this.user, authorName: this.user, text, canAccept: true, acceptors: "you", ...(about ? { about } : {}) })
      .catch(() => { /* the orchestrator logs its own failures into the thread */ })
      .finally(() => this.busy.delete(thread));
    return json({ accepted: true }, 202);
  }
}
