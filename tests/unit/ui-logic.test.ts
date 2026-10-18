import { describe, expect, jest, test } from "bun:test";
import type { ActivityItem, ChangeSummary, Sections, StreamMessage } from "../../src/console/types";
import { parseDiff } from "../../src/ui/diff";
import { ago, costSoFar, duration, pillText, shortModel, stepWord, usd } from "../../src/ui/format";
import { keyLabel, keyMatcher, keyName, typingIn } from "../../src/ui/keys";
import { renderMarkdown, stripFrontmatter } from "../../src/ui/markdown";
import { clampAt, filterCommands, fuzzyScore } from "../../src/ui/palette";
import { parseRoute, routePath, type Route } from "../../src/ui/router";
import { ACTIVITY_MAX, applyMessage, connect, connection, getJson, HttpError, STALE_MS, toasts, type State } from "../../src/ui/store";
import { addItems, EMPTY } from "../../src/ui/transcript";
import { needsAPerson } from "../../src/ui/alerts";
import { nextTheme } from "../../src/ui/theme";
import { barEnd, codeKey, detailKey } from "../../src/ui/change-key";
import { aboutPrefix, addLines } from "../../src/ui/chat";
import { act, beforeOf, bodyFor, nextPoll, steer, steerOffer, stopChange, UNDOABLE, undoFor, unsentText } from "../../src/ui/requests";

describe("formatting", () => {
  test("money, durations, running costs, models and the loop pill", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.814)).toBe("$0.81");
    expect(usd(0.81, true)).toBe("~$0.81");
    expect(usd(1234.4)).toBe("$1,234");
    expect(duration(45_000)).toBe("45s");
    expect(duration(372_000)).toBe("6m 12s");
    expect(duration(7_380_000)).toBe("2h 3m");
    expect(duration(100 * 3_600_000)).toBe("4d 4h");
    expect(costSoFar(new Date(0).toISOString(), 5 * 60_000, 0.2)).toBeCloseTo(1);
    expect(ago(new Date(0).toISOString(), 3 * 60_000)).toBe("3m");
    // A missing or unreadable time shows a dash, not "NaNd".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(duration(bad)).toBe("–");
    expect(ago("not a time", Date.now())).toBe("–");
    expect(ago(new Date(0).toISOString(), Number.NaN)).toBe("–");
    expect(shortModel("claude-sonnet-5-5")).toBe("sonnet 5.5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(shortModel("opus")).toBe("opus");
    expect(stepWord("success")).toBe("passed");
    expect(stepWord("fail")).toBe("failed");
    expect(stepWord("running")).toBe("running");
    expect(stepWord("asked")).toBe("asked a question");
    expect(pillText({ state: "running", text: "Running — working on a and b, last check 3s ago", working: [{ slug: "a" }, { slug: "b" }] })).toBe("Running · 2 agents");
    expect(pillText({ state: "running", text: "Running — last check 3s ago", working: [] })).toBe("Running");
    expect(pillText({ state: "running", text: "Stopping — last check 3s ago", working: [{ slug: "a" }] })).toBe("Stopping");
    expect(pillText({ state: "not-responding", text: "Not responding (last check 14 min ago)", working: [] })).toBe("Not responding");
  });

  test("a loop a person paused says so in the top bar, even while its last steps finish", () => {
    const heldLoop = { state: "paused" as const, text: "Paused by John: running steps finish, nothing new starts.", held: { by: "John", at: "2026-10-17T10:00:00Z" }, working: [{ slug: "a", phase: "build" }] };
    expect(pillText(heldLoop)).toBe("Paused by John");
  });
});

describe("routes", () => {
  test("paths become screens and back", () => {
    expect(parseRoute("/")).toEqual({ name: "live" });
    expect(parseRoute("/inbox")).toEqual({ name: "inbox" });
    expect(parseRoute("/c/csv-export")).toEqual({ name: "change", slug: "csv-export", tab: "overview" });
    expect(parseRoute("/c/csv-export/code")).toEqual({ name: "change", slug: "csv-export", tab: "code" });
    expect(parseRoute("/s/csv-export/12")).toEqual({ name: "session", slug: "csv-export", seq: 12 });
    expect(parseRoute("/s/_chat/3")).toEqual({ name: "session", slug: "_chat", seq: 3 });
    for (const bad of ["/c/Bad", "/c/one/nope", "/s/one/x", "/nope", "/c/one/code/more", "/c/%E0%A4%A"]) expect(parseRoute(bad)).toEqual({ name: "missing", path: bad });
    const all: Route[] = [
      { name: "live" }, { name: "inbox" }, { name: "changes" }, { name: "activity" }, { name: "spend" },
      { name: "change", slug: "a", tab: "overview" }, { name: "change", slug: "a", tab: "gates" }, { name: "session", slug: "a", seq: 4 },
    ];
    for (const r of all) expect(parseRoute(routePath(r))).toEqual(r);
  });
});

describe("keys", () => {
  test("sequences must be finished in time; a wrong second key starts over with that key", () => {
    const press = keyMatcher([{ keys: "g l", action: "live" }, { keys: "g i", action: "inbox" }, { keys: "mod+k", action: "palette" }, { keys: "?", action: "help" }]);
    expect(press("g", 0)).toBeNull();
    expect(press("l", 100)).toBe("live");
    expect(press("g", 200)).toBeNull();
    expect(press("i", 2000)).toBeNull();
    expect(press("mod+k", 2100)).toBe("palette");
    expect(press("g", 3000)).toBeNull();
    expect(press("?", 3100)).toBe("help");
  });

  test("key names, and typing in a field is not a shortcut", () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(keyName(key("K", { ctrlKey: true }))).toBe("mod+k");
    expect(keyName(key("j", { metaKey: true }))).toBe("mod+j");
    expect(keyName(key("Escape"))).toBe("escape");
    expect(keyName(key("J"))).toBe("j");
    expect(keyName(key("x", { altKey: true }))).toBeNull();
    // A modifier pressed on its own is the start of a combination, not a key of its own.
    for (const mod of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "OS", "NumLock", "ScrollLock", "Fn", "Hyper", "Super", "Symbol", "FnLock", "SymbolLock"]) {
      expect({ mod, name: keyName(key(mod)) }).toEqual({ mod, name: null });
      expect({ mod, name: keyName(key(mod, { ctrlKey: true })) }).toEqual({ mod, name: null });
    }
    expect(typingIn({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(typingIn({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(typingIn({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});

describe("the command palette's matching", () => {
  test("letters in order, runs and word starts first, ties kept in order", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("cx", "csv-export")).not.toBeNull();
    expect(fuzzyScore("xz", "csv-export")).toBeNull();
    expect(fuzzyScore("csv", "Open csv-export")!).toBeGreaterThan(fuzzyScore("csv", "Choose some values")!);
    const items = [{ title: "Go to Inbox" }, { title: "Open csv-export" }, { title: "Open dark-mode" }];
    expect(filterCommands(items, "")).toEqual(items);
    expect(filterCommands(items, "dark").map((i) => i.title)).toEqual(["Open dark-mode"]);
    expect(filterCommands(items, "op").map((i) => i.title)).toEqual(["Open csv-export", "Open dark-mode"]);
  });
});

describe("diffs", () => {
  test("git's diffs and an edit's diff become rows; a deleted line that looks like a header stays a line", () => {
    const git = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n--- sql comment\n\\ No newline at end of file\n";
    expect(parseDiff(git)).toEqual([
      { kind: "file", text: "src/a.ts" }, { kind: "hunk", text: "@@ -1,2 +1,2 @@" }, { kind: "ctx", text: "keep" },
      { kind: "del", text: "old" }, { kind: "add", text: "new" }, { kind: "del", text: "-- sql comment" }, { kind: "meta", text: "\\ No newline at end of file" },
    ]);
    expect(parseDiff("--- src/csv.ts\n+++ src/csv.ts\n@@ edit @@\n-a\n+c")).toEqual([
      { kind: "file", text: "src/csv.ts" }, { kind: "hunk", text: "@@ edit @@" }, { kind: "del", text: "a" }, { kind: "add", text: "c" },
    ]);
  });

  test("a rename, a new or deleted file, and a mode change say so, even with no lines changed", () => {
    const git = [
      "diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts",
      "diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755",
      "diff --git a/added.ts b/added.ts", "new file mode 100644", "index 0000000..ce01362", "--- /dev/null", "+++ b/added.ts", "@@ -0,0 +1 @@", "+x",
      "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "index ce01362..0000000", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
    ].join("\n");
    expect(parseDiff(git)).toEqual([
      { kind: "file", text: "new.ts" }, { kind: "meta", text: "rename from old.ts" }, { kind: "meta", text: "rename to new.ts" },
      { kind: "file", text: "run.sh" }, { kind: "meta", text: "old mode 100644" }, { kind: "meta", text: "new mode 100755" },
      { kind: "file", text: "added.ts" }, { kind: "meta", text: "new file mode 100644" }, { kind: "hunk", text: "@@ -0,0 +1 @@" }, { kind: "add", text: "x" },
      { kind: "file", text: "gone.ts" }, { kind: "meta", text: "deleted file mode 100644" }, { kind: "hunk", text: "@@ -1 +0,0 @@" }, { kind: "del", text: "x" },
    ]);
  });
});

describe("markdown", () => {
  test("raw HTML is shown as text, only safe links are links, and frontmatter is left out", () => {
    const html = renderMarkdown("# Hi <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[ok](https://x.y) [bad](javascript:alert(1)) ![pic](http://e/x.png)\n\n| a | b |\n|---|---|\n| 1 | <b>2</b> |\n");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://x.y" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).toContain("&lt;b&gt;2&lt;/b&gt;");
    expect(html).toContain("<table>");
    expect(stripFrontmatter("---\nstatus: draft\n---\n# Intent: x\n")).toBe("# Intent: x\n");
    expect(stripFrontmatter("# No frontmatter\n")).toBe("# No frontmatter\n");
  });

  test("a link whose address hides a scheme behind tabs, control characters, spaces or a line break is shown as its text", () => {
    for (const text of [
      "[a](<java\tscript:alert(1)>)",
      "[a](<\x01javascript:alert(1)>)",
      "[a](< javascript:alert(1)>)",
      "[a]\n\n[a]: <java\tscript:alert(1)>",
      "[a](<java\nscript:alert(1)>)",
      "[a](<javascript:alert(1)\x7f>)",
    ]) {
      const html = renderMarkdown(text);
      expect({ text, href: html.includes("href") }).toEqual({ text, href: false });
      expect(html).toContain("a");
    }
    expect(renderMarkdown("[a](<java\tscript:alert(1)>)")).toBe("<p>a</p>\n");
    expect(renderMarkdown("[docs](<./notes.md>)")).toContain('<a href="./notes.md"');
  });
});

describe("a transcript on the page", () => {
  test("results attach to their calls, the todo list is the newest one, and the old state is left alone", () => {
    const s = addItems(EMPTY, [
      { kind: "text", text: "a" },
      { kind: "tool", id: "t1", tool: "Bash", target: "x", input: {} },
      { kind: "todos", items: [{ text: "x", state: "pending" }] },
    ]);
    const s2 = addItems(s, [{ kind: "tool-result", id: "t1", ok: true, output: "done" }, { kind: "todos", items: [] }]);
    expect(s2.items.map((i) => i.kind)).toEqual(["text", "tool"]);
    expect(s2.results.t1).toEqual({ ok: true, output: "done" });
    expect(s2.todos).toEqual([]);
    expect(s.results).toEqual({});
  });

  test("a call or edit that is already shown is not added again, as after a reconnect", () => {
    const tool = { kind: "tool", id: "t1", tool: "Bash", target: "x", input: {} } as const;
    const edit = { kind: "edit", id: "e1", tool: "Edit", path: "a.ts", diff: "" } as const;
    const s = addItems(EMPTY, [tool, edit, { kind: "text", text: "a" }]);
    const again = addItems(s, [tool, edit, { kind: "text", text: "a" }, { kind: "tool", id: "t2", tool: "Read", target: "y", input: {} }]);
    // Text has no id, so it cannot be told from a new line; only calls and edits are checked.
    expect(again.items.map((i) => ("id" in i ? i.id : i.kind))).toEqual(["t1", "e1", "text", "text", "t2"]);
  });
});

describe("the page's state", () => {
  const sections: Sections = {
    loop: { state: "stopped", text: "Stopped", working: [], nextCheck: null, held: null },
    inbox: [], changes: [], running: { now: [], recent: [] }, totals: { todayUsd: 0, weekUsd: 0, allUsd: 0 }, requests: [],
  };

  test("a snapshot sets everything; a section replaces only itself; events are kept once, up to a limit", () => {
    let s: State = { meta: null, sections: {}, activity: [], gaps: 0 };
    s = applyMessage(s, { type: "snapshot", meta: { chat: true, usdPerMinute: 0.2, pollSeconds: 60 }, sections });
    expect(s.meta?.chat).toBe(true);
    const changes = s.sections.changes;
    s = applyMessage(s, { type: "section", name: "inbox", value: [{ kind: "blocked", label: "Blocked", slug: "a", title: "A", what: "w" }] });
    expect(s.sections.inbox).toHaveLength(1);
    expect(s.sections.changes).toBe(changes); // untouched sections keep their identity, so their screens do not redraw
    const item = (id: number): ActivityItem => ({ id, slug: "a", seq: null, ts: "t", type: "phase_start", text: "Started build.", technical: "x" });
    s = applyMessage(s, { type: "event", item: item(5) });
    s = applyMessage(s, { type: "event", item: item(5) });
    expect(s.activity.map((a) => a.id)).toEqual([5]);
    for (let i = 6; i < ACTIVITY_MAX + 20; i++) s = applyMessage(s, { type: "event", item: item(i) });
    expect(s.activity).toHaveLength(ACTIVITY_MAX);
    expect(s.activity.at(-1)?.id).toBe(ACTIVITY_MAX + 19);
  });

  test("a gap is counted and leaves the sections and the activity as they were", () => {
    let s: State = { meta: null, sections: {}, activity: [], gaps: 0 };
    s = applyMessage(s, { type: "snapshot", meta: { chat: false, usdPerMinute: 0.2, pollSeconds: 60 }, sections });
    const before = s;
    s = applyMessage(s, { type: "gap" });
    expect(s.gaps).toBe(1);
    expect(s.sections).toBe(before.sections);
    expect(s.activity).toBe(before.activity);
    s = applyMessage(s, { type: "gap" });
    expect(s.gaps).toBe(2);
    expect(applyMessage(s, { type: "snapshot", meta: before.meta!, sections }).gaps).toBe(2); // a snapshot does not forget the holes
  });

  test("a message of a kind the page does not know leaves the state as it was", () => {
    const s: State = { meta: null, sections: {}, activity: [], gaps: 0 };
    expect(applyMessage(s, { type: "from-a-newer-server" } as unknown as StreamMessage)).toBe(s);
  });
});


describe("the page's live stream", () => {
  /** Stands in for the browser's EventSource: records what was opened and lets a test speak for the server. */
  class FakeSource {
    static readonly CLOSED = 2;
    static opened: FakeSource[] = [];
    readyState = 1;
    closed = false;
    onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly listeners = new Map<string, () => void>();
    constructor(readonly url: string) { FakeSource.opened.push(this); }
    addEventListener(type: string, fn: () => void) { this.listeners.set(type, fn); }
    close() { this.closed = true; this.readyState = FakeSource.CLOSED; }
    ping() { this.listeners.get("ping")?.(); }
  }

  test("a silent stream is closed and opened again, and a new stream names the newest event the page saw", () => {
    const real = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    FakeSource.opened = [];
    jest.useFakeTimers();
    const stop = connect();
    try {
      const first = FakeSource.opened[0]!;
      expect(first.url).toBe("/api/stream");
      first.onmessage!({ data: JSON.stringify({ type: "gap" }), lastEventId: "7" });
      expect(connection.value).toBe("live");
      jest.advanceTimersByTime(STALE_MS / 2);
      first.ping(); // pings keep it alive
      jest.advanceTimersByTime(STALE_MS - 1000);
      expect(first.closed).toBe(false);
      jest.advanceTimersByTime(2000);
      expect(connection.value).toBe("stale");
      expect(first.closed).toBe(true);
      jest.advanceTimersByTime(1000);
      expect(FakeSource.opened).toHaveLength(2);
      const second = FakeSource.opened[1]!;
      expect(second.url).toBe("/api/stream?after=7");

      // The browser gives up on its own reconnecting: the page opens a new stream, still from event 7.
      second.readyState = FakeSource.CLOSED;
      second.onerror!();
      jest.advanceTimersByTime(8000);
      expect(FakeSource.opened).toHaveLength(3);
      expect(FakeSource.opened[2]!.url).toBe("/api/stream?after=7");
      FakeSource.opened[2]!.onmessage!({ data: JSON.stringify({ type: "gap" }), lastEventId: "9" });
      expect(connection.value).toBe("live");
    } finally {
      stop();
      jest.useRealTimers();
      (globalThis as { EventSource?: unknown }).EventSource = real;
    }
    expect(FakeSource.opened.at(-1)!.closed).toBe(true);
  });
});

describe("labels for keys", () => {
  test("Ctrl becomes the Command sign on Apple platforms, and words are capitalised", () => {
    expect(keyLabel("mod+k", false)).toBe("Ctrl K");
    expect(keyLabel("mod+k", true)).toBe("⌘K");
    expect(keyLabel("g l", true)).toBe("G L");
    expect(keyLabel("escape", false)).toBe("Esc");
    expect(keyLabel("?", false)).toBe("?");
  });
});

describe("the theme button", () => {
  test("from the system's own theme it goes to the opposite first, then the system's own, then back to system", () => {
    expect(nextTheme("system", true)).toBe("light");
    expect(nextTheme("light", true)).toBe("dark");
    expect(nextTheme("dark", true)).toBe("system");
    expect(nextTheme("system", false)).toBe("dark");
    expect(nextTheme("dark", false)).toBe("light");
    expect(nextTheme("light", false)).toBe("system");
  });
});

describe("the highlighted row of a list", () => {
  test("stays inside the list, and is 0 when the list is empty", () => {
    expect(clampAt(0, 0)).toBe(0);
    expect(clampAt(-1, 5)).toBe(0);
    expect(clampAt(3, 5)).toBe(3);
    expect(clampAt(7, 5)).toBe(4);
    expect(clampAt(2, 0)).toBe(0);
  });
});

describe("what is worth a notification", () => {
  test("only things a person must act on", () => {
    const item = (kind: string) => ({ kind }) as Parameters<typeof needsAPerson>[0];
    expect(needsAPerson(item("blocked"))).toBe(true);
    expect(needsAPerson(item("waiting"))).toBe(true);
    for (const k of ["paused", "health", "sync", "config", "unreadable"]) expect(needsAPerson(item(k))).toBe(false);
  });
});

describe("when a change page reads its detail again", () => {
  const summary: ChangeSummary = { slug: "a", title: "A", status: "building", plain: "Being built", priority: "normal", stage: "build", since: "2026-01-01T00:00:00Z", inStatus: "12s", costUsd: 1.5, waiting: null, note: "", running: true, held: null, statedPriority: null, offers: [], question: null };
  test("the age in words, which the server rebuilds every few seconds, does not count", () => {
    expect(detailKey({ ...summary, inStatus: "3 min" }, "2")).toBe(detailKey(summary, "2"));
    expect(detailKey(null, "")).toBe(detailKey(null, ""));
  });
  test("a status, cost, note, waiting reason, priority or running step does", () => {
    const base = detailKey(summary, "2");
    for (const changed of [{ status: "review" }, { since: "2026-01-02T00:00:00Z" }, { costUsd: 2 }, { running: false }, { waiting: "b" }, { note: "n" }, { priority: "high" }]) {
      expect(detailKey({ ...summary, ...changed }, "2")).not.toBe(base);
    }
    expect(detailKey(summary, "2,3")).not.toBe(base);
  });
  test("a hold or a release does, so the page shows the change held or not at once", () => {
    const held = detailKey({ ...summary, held: "waiting for legal (John, the dashboard)" }, "2");
    expect(held).not.toBe(detailKey(summary, "2"));
    expect(detailKey({ ...summary, held: null }, "2")).not.toBe(held);
  });
  test("the diff reloads only when the status or a running step changes", () => {
    expect(codeKey({ ...summary, costUsd: 9, note: "x" }, "2")).toBe(codeKey(summary, "2"));
    expect(codeKey({ ...summary, status: "review" }, "2")).not.toBe(codeKey(summary, "2"));
    expect(codeKey(summary, "3")).not.toBe(codeKey(summary, "2"));
  });
});

describe("the chat drawer's lines", () => {
  test("a line already shown is not added again", () => {
    const a = { key: "m1", kind: "person" as const, text: "hi" };
    const b = { key: "m2", kind: "loopstra" as const, text: "hello" };
    expect(addLines([a], [a, b])).toEqual([a, b]);
    const same = [a, b];
    expect(addLines(same, [b])).toBe(same);
    expect(addLines([a], [b, b])).toEqual([a, b]);
  });
  test("a message says which change it is about, by slug when there is one", () => {
    expect(aboutPrefix({ slug: "csv-export", title: "CSV export" })).toBe("About csv-export (CSV export): ");
    expect(aboutPrefix({ title: "Step 3" })).toBe("About Step 3: ");
    expect(aboutPrefix(null)).toBe("");
  });
});

describe("where a timeline bar ends", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  test("a finished step ends when it ended, a running one now, a step with no end time by its duration", () => {
    expect(barEnd({ started: "2026-01-01T00:00:00Z", ended: "2026-01-01T00:00:10Z", status: "success", durationMs: 99 }, t0 + 60_000)).toBe(t0 + 10_000);
    expect(barEnd({ started: "2026-01-01T00:00:00Z", ended: null, status: "running", durationMs: 0 }, t0 + 60_000)).toBe(t0 + 60_000);
    expect(barEnd({ started: "2026-01-01T00:00:00Z", ended: null, status: "fail", durationMs: 5_000 }, t0 + 60_000)).toBe(t0 + 5_000);
  });
});

describe("reading JSON", () => {
  test("a reply that is not a success throws an error that carries its status, so a missing change is told from a failing server", async () => {
    const real = globalThis.fetch;
    try {
      for (const status of [404, 500]) {
        globalThis.fetch = (async () => new Response("no", { status })) as unknown as typeof fetch;
        const e = await getJson("/api/changes/one").catch((x: unknown) => x);
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(status);
      }
      globalThis.fetch = (async () => Response.json({ ok: 1 })) as unknown as typeof fetch;
      expect(await getJson<{ ok: number }>("/x")).toEqual({ ok: 1 });
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("requests from the page", () => {
  const change = { slug: "a", status: "plan-review", note: "Read plan.md.", priority: "normal" } as unknown as ChangeSummary;

  test("the body names the change, the status the person saw, and what the action needs", () => {
    expect(bodyFor(change, { kind: "approve", label: "Approve the plan", to: "plan-approved" })).toEqual({ kind: "approve", slug: "a", expect: "plan-review" });
    expect(bodyFor(change, { kind: "send-back", label: "Send back", to: "spec-approved" }, { note: "Split it." })).toEqual({ kind: "send-back", slug: "a", expect: "plan-review", note: "Split it." });
    expect(bodyFor({ ...change, status: "blocked" }, { kind: "retry", label: "Retry from accepted", to: "accepted" })).toEqual({ kind: "retry", slug: "a", expect: "blocked", to: "accepted" });
    expect(bodyFor(change, { kind: "priority", label: "Priority" }, { priority: "high" })).toEqual({ kind: "priority", slug: "a", expect: "plan-review", priority: "high" });
    expect(bodyFor(change, { kind: "hold", label: "Hold" }, { reason: "legal" })).toEqual({ kind: "hold", slug: "a", expect: "plan-review", reason: "legal" });
    // An answer goes to the question open now, whatever the status: it names none.
    expect(bodyFor(change, { kind: "answer", label: "Answer" }, { note: "No." })).toEqual({ kind: "answer", slug: "a", text: "No." });
  });

  test("an answer has no Undo: the session carries on with it", () => {
    expect(UNDOABLE.has("answer")).toBe(false);
  });

  test("stopping a change posts to its stop route and says it is held; a refusal says why", async () => {
    const real = globalThis.fetch;
    const posted: Array<[string, unknown]> = [];
    let refuse = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push([url, JSON.parse(String(init?.body))]);
      return refuse ? Response.json({ error: "Nothing of a is running." }, { status: 409 }) : Response.json({ stopped: 1 }, { status: 202 });
    }) as unknown as typeof fetch;
    toasts.value = [];
    try {
      expect(await stopChange("a")).toBe(true);
      refuse = true;
      expect(await stopChange("a")).toBe(false);
      expect(posted).toEqual([["/api/changes/a/stop", {}], ["/api/changes/a/stop", {}]]);
      expect(toasts.value.map((t) => [t.text, t.kind])).toEqual([
        ["Stopping a. It is held, so it does not start again until someone releases it.", "info"],
        ["Nothing of a is running.", "bad"],
      ]);
    } finally {
      globalThis.fetch = real;
      toasts.value = [];
    }
  });

  test("what an undo puts back is the stated priority: none when the change only reads as normal", () => {
    expect(beforeOf({ ...change, statedPriority: null })).toEqual({ note: "Read plan.md.", priority: null });
    expect(beforeOf({ ...change, priority: "high", statedPriority: "high" })).toEqual({ note: "Read plan.md.", priority: "high" });
  });

  test("undo puts back what the action changed, from where it left the change", () => {
    const before = { note: "Read plan.md.", priority: "normal" };
    expect(undoFor({ kind: "approve", slug: "a", expect: "plan-review" }, before, "plan-approved")).toEqual({ kind: "undo", slug: "a", expect: "plan-approved", to: "plan-review", note: "Read plan.md." });
    expect(undoFor({ kind: "send-back", slug: "a", expect: "plan-review", note: "x" }, before, "spec-approved")).toEqual({ kind: "undo", slug: "a", expect: "spec-approved", to: "plan-review", note: "Read plan.md." });
    expect(undoFor({ kind: "priority", slug: "a", expect: "building", priority: "high" }, before, "building")).toEqual({ kind: "priority", slug: "a", expect: "building", priority: "normal" });
    expect(undoFor({ kind: "hold", slug: "a", expect: "building", reason: "" }, before, "building")).toEqual({ kind: "release", slug: "a", expect: "building" });
    expect(undoFor({ kind: "close", slug: "a", expect: "building" }, before, "closed")).toBeNull();
    expect(undoFor({ kind: "approve", slug: "a", expect: "plan-review" }, before, null)).toBeNull();
    // A change with no priority line gets none again, not "normal" written into its file.
    expect(undoFor({ kind: "priority", slug: "a", expect: "building", priority: "high" }, { ...before, priority: null }, "building")).toEqual({ kind: "priority", slug: "a", expect: "building", priority: null });
  });

  test("an action that failed loses its Undo, and an Undo pressed after the failure says nothing more", async () => {
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      asked.push(`${method} ${url}`);
      if (method === "POST") return Response.json({ id: "r1", loop: "running" }, { status: 202 });
      // Claimed by the loop already: it cannot be cancelled.
      if (method === "DELETE") return Response.json({ error: "claimed" }, { status: 409 });
      return Response.json({ state: "done", ok: false, text: "a moved on to building; nothing changed.", status: "building" });
    }) as unknown as typeof fetch;
    // Real timers: the first ask for the result is a second after the send.
    const settle = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10); };
    toasts.value = [];
    try {
      expect(await act({ kind: "approve", slug: "a", expect: "plan-review" }, { note: "", priority: null }, "Approve the plan, a")).toBe(true);
      const sent = toasts.value.find((t) => t.action)!;
      expect(sent.text).toBe("Approve the plan, a: sent to the loop.");
      await settle(() => toasts.value.some((t) => t.kind === "bad"));
      expect(toasts.value.map((t) => [t.text, t.kind, !!t.action])).toEqual([["a moved on to building; nothing changed.", "bad", false]]);
      // A press that got in before the toast went: the failure is not shown again, and nothing is sent.
      sent.action!.run();
      await settle(() => asked.some((a) => a.startsWith("DELETE")));
      await Bun.sleep(20);
      expect(toasts.value).toHaveLength(1);
      expect(asked.filter((a) => a.startsWith("POST"))).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
      toasts.value = [];
    }
  });

  test("results are asked for every second for half a minute, then every 5 s, for about ten minutes", () => {
    expect(nextPoll(0)).toBe(1000);
    expect(nextPoll(29)).toBe(1000);
    expect(nextPoll(30)).toBe(5000);
    expect(nextPoll(143)).toBe(5000);
    expect(nextPoll(144)).toBeNull();
  });

  test("a running work session may be messaged and stopped; a running check only stopped; an ended one neither", () => {
    expect(steerOffer("build", "running", false)).toEqual({ message: true, stop: true });
    expect(steerOffer("fix-2", "running", false)).toEqual({ message: true, stop: true });
    expect(steerOffer("review-1", "running", false)).toEqual({ message: false, stop: true, note: "Checks cannot be messaged. Approve or send back instead." });
    expect(steerOffer("build", "running", true)).toBeNull();
    expect(steerOffer("build", "success", false)).toBeNull();
  });

  test("steering a session posts to its message route and says what happens in a toast; a refusal says why", async () => {
    const real = globalThis.fetch;
    const posted: Array<[string, unknown]> = [];
    let refuse = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push([url, JSON.parse(String(init?.body))]);
      return refuse ? Response.json({ error: "That session is not running." }, { status: 409 }) : Response.json({ id: "m1" }, { status: 202 });
    }) as unknown as typeof fetch;
    toasts.value = [];
    try {
      expect(await steer("a", 7, "message", "Cover negatives.")).toBe(true);
      expect(await steer("a", 7, "stop")).toBe(true);
      refuse = true;
      expect(await steer("a", 7, "redirect", "Do it the other way.")).toBe(false);
      expect(posted).toEqual([
        ["/api/sessions/a/7/message", { kind: "message", text: "Cover negatives." }],
        ["/api/sessions/a/7/message", { kind: "stop", text: "" }],
        ["/api/sessions/a/7/message", { kind: "redirect", text: "Do it the other way." }],
      ]);
      expect(toasts.value.map((t) => [t.text, t.kind])).toEqual([
        ["Sent: the session reads it at its next step.", "info"],
        ["Stopping the session. The change is held, so it does not start again.", "info"],
        ["That session is not running.", "bad"],
      ]);
    } finally {
      globalThis.fetch = real;
      toasts.value = [];
    }
  });

  test("an action that could not be sent says so plainly, without the error itself", () => {
    expect(unsentText("Approve the plan, a")).toBe("Approve the plan, a: it could not be sent. Try again.");
  });
});
