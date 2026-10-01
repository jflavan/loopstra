import { userInfo } from "node:os";
import { AnnouncementLog } from "../announcer";
import type { OnMessage, Transport } from "../service";
import { ThreadStore } from "../threads";

/** A browser tab's thread id: made by the page, so only a plain shape is accepted. */
const THREAD = /^[a-z0-9-]{8,64}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
/** The longest message the panel takes. */
const MAX_TEXT = 20_000;

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
    this.user = user ?? safeUser();
  }

  async start(onMessage: OnMessage): Promise<void> { this.onMessage = onMessage; }
  /** The orchestrator has already put the message in the thread's log, which the page reads. */
  async send(): Promise<void> {}
  async stop(): Promise<void> { this.onMessage = null; }

  /**
   * Handles `/api/chat`. POST needs JSON from the dashboard's own page (the Origin must be this
   * server), so another web page open in the browser cannot post into the chat.
   */
  async handle(req: Request, url: URL): Promise<Response> {
    // Only on a local host name: a page on another name that resolves here gets nothing.
    if (!LOCAL_HOSTS.has(url.hostname)) return new Response("Forbidden", { status: 403 });
    if (req.method === "GET" || req.method === "HEAD") {
      const thread = url.searchParams.get("thread") ?? "";
      if (!THREAD.test(thread)) return Response.json({ error: "thread" }, { status: 400 });
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const t = this.store.get(this.name, thread);
      // -1: the page just opened; it gets only where the announcements are, and shows new ones from there.
      const annAfter = Number(url.searchParams.get("announcementsAfter") ?? -1);
      const announcements = annAfter < 0 ? [] : this.log.since(annAfter);
      return Response.json({
        messages: t.messages.filter((m) => m.id > after),
        busy: this.busy.has(thread),
        waitingForYes: t.pending !== null,
        announcements,
        lastAnnouncementId: announcements.at(-1)?.id ?? (annAfter < 0 ? this.log.lastId() : annAfter),
      });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    // The page's own origin only.
    if (req.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new Response("Expected JSON", { status: 415 });
    let body: { thread?: unknown; text?: unknown };
    try { body = await req.json() as typeof body; } catch { return Response.json({ error: "json" }, { status: 400 }); }
    const thread = typeof body.thread === "string" ? body.thread : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!THREAD.test(thread) || !text || text.length > MAX_TEXT) return Response.json({ error: "message" }, { status: 400 });
    if (!this.onMessage) return Response.json({ error: "chat is not running" }, { status: 503 });
    if (this.busy.has(thread)) return Response.json({ error: "busy" }, { status: 409 });
    this.busy.add(thread);
    const handle = this.onMessage;
    void handle({ thread, authorId: this.user, authorName: this.user, text, canAccept: true, acceptors: "you" })
      .catch(() => { /* the orchestrator logs its own failures into the thread */ })
      .finally(() => this.busy.delete(thread));
    return Response.json({ accepted: true }, { status: 202 });
  }
}

function safeUser(): string {
  try { return userInfo().username || "you"; } catch { return "you"; }
}
