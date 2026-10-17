import { describe, expect, test } from "bun:test";
import type { ActivityItem, Sections } from "../../src/console/types";
import { parseDiff } from "../../src/ui/diff";
import { costSoFar, duration, pillText, shortModel, usd } from "../../src/ui/format";
import { keyMatcher, keyName, typingIn } from "../../src/ui/keys";
import { renderMarkdown, stripFrontmatter } from "../../src/ui/markdown";
import { filterCommands, fuzzyScore } from "../../src/ui/palette";
import { parseRoute, routePath, type Route } from "../../src/ui/router";
import { ACTIVITY_MAX, applyMessage, type State } from "../../src/ui/store";
import { addItems, EMPTY } from "../../src/ui/transcript";

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
    expect(shortModel("claude-sonnet-5-5")).toBe("sonnet 5.5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(shortModel("opus")).toBe("opus");
    expect(pillText({ state: "running", text: "Running — working on a and b, last check 3s ago", working: [{ slug: "a" }, { slug: "b" }] })).toBe("Running · 2 agents");
    expect(pillText({ state: "running", text: "Running — last check 3s ago", working: [] })).toBe("Running");
    expect(pillText({ state: "running", text: "Stopping — last check 3s ago", working: [{ slug: "a" }] })).toBe("Stopping");
    expect(pillText({ state: "not-responding", text: "Not responding (last check 14 min ago)", working: [] })).toBe("Not responding");
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
});

describe("the page's state", () => {
  const sections: Sections = {
    loop: { state: "stopped", text: "Stopped", working: [], nextCheck: null },
    inbox: [], changes: [], running: { now: [], recent: [] }, totals: { todayUsd: 0, weekUsd: 0, allUsd: 0 },
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
});

