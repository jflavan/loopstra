import { useEffect, useRef, useState } from "preact/hooks";
import type { ActivityItem } from "../../console/types";
import { fitsFeed, mergeFeed } from "../feed";
import { clock } from "../format";
import { Link } from "../parts/Link";
import { activity, changes, gaps, getJson, now } from "../store";

/** The trace's own slugs, in words. */
const OWN: Record<string, string> = { _chat: "chat", _loop: "the loop", _signals: "main" };

export function Activity() {
  const [slug, setSlug] = useState("");
  const [technical, setTechnical] = useState(false);
  const [older, setOlder] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Only the newest request may fill the list, so a slow answer for an earlier filter does not replace it.
  const request = useRef(0);
  /**
   * Reads a page of history. `how`: "reset" shows the page alone (a new filter, Refresh), "more" adds it
   * below (Older), "merge" merges the newest page into what is shown (the stream said this page missed events).
   */
  const load = async (before: number, how: "reset" | "more" | "merge") => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const q = new URLSearchParams({ before: String(before) });
      if (slug) q.set("slug", slug);
      if (technical) q.set("technical", "1");
      const page = await getJson<{ items: ActivityItem[]; next: number | null }>(`/api/events?${q}`);
      if (mine !== request.current) return;
      if (how === "merge") {
        const merged = mergeFeed(older, page.items, { slug, technical });
        setOlder(merged.items);
        // Joined, the Older cursor still points below what is shown; not joined, the page stands alone with its own.
        if (!merged.joined) setNext(page.next);
      } else {
        setOlder((o) => (how === "reset" ? page.items : [...o, ...page.items]));
        setNext(page.next);
      }
      setFailed(false);
    } catch {
      if (mine !== request.current) return;
      setNext(null);
      setFailed(true);
    } finally {
      if (mine === request.current) setLoading(false);
    }
  };
  // The history is read again when the filter changes and when the live stream says this page missed events.
  const missed = gaps.value;
  // A new filter empties the list first, so the old filter's items do not pass for the new one's; a reload for missed events keeps what is shown.
  const shownFilter = useRef("");
  useEffect(() => {
    const filter = `${slug}|${technical}`;
    if (filter !== shownFilter.current) {
      shownFilter.current = filter;
      setOlder([]);
      setNext(0);
      void load(0, "reset");
    } else void load(0, "merge");
  }, [slug, technical, missed]);
  // The live stream carries only events in plain words; the technical view loads again on Refresh.
  const newest = older[0]?.id ?? 0;
  const fresh = technical ? [] : activity.value.filter((a) => a.id > newest && fitsFeed(a, { slug, technical })).reverse();
  const items = [...fresh, ...older];
  const t = now.value;
  return (
    <section class="view">
      <div class="view-head"><h1>Activity</h1></div>
      <div class="toolbar">
        <select value={slug} onChange={(e) => setSlug(e.currentTarget.value)} aria-label="Which change">
          <option value="">Everything</option>
          {(changes.value ?? []).map((c) => <option key={c.slug} value={c.slug}>{c.title}</option>)}
          <option value="_chat">Chat</option>
          <option value="_loop">The loop</option>
        </select>
        <label><input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.currentTarget.checked)} /> Technical</label>
        {technical && <button class="btn" onClick={() => void load(0, "reset")}>Refresh</button>}
      </div>
      {failed && <p class="muted">The history could not be read. <button class="link" type="button" onClick={() => void load(0, "reset")}>Try again</button></p>}
      {/* A page can come back empty with older ones still to read (a long run of events only an engineer would care about). */}
      {!items.length && !loading && !failed && next === null && <p class="muted">Nothing has happened yet.</p>}
      {items.length > 0 && (
        <ul class="feed">
          {items.map((a) => (
            <li key={a.id}>
              <span class="t">{clock(a.ts, t)}</span>
              <span>{a.slug.startsWith("_") ? <span class="muted">{OWN[a.slug] ?? a.slug}</span> : <Link href={`/c/${a.slug}`}>{a.slug}</Link>}</span>
              <span class={technical ? "tech" : ""}>
                {technical ? a.technical : a.text}
                {a.seq !== null && <> · <Link href={`/s/${a.slug}/${a.seq}`} class="muted">step {a.seq}</Link></>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next !== null && <p><button class="btn" disabled={loading} onClick={() => void load(next, "more")}>{loading ? "Loading…" : "Older"}</button></p>}
    </section>
  );
}
