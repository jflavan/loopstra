import { describe, expect, jest, test } from "bun:test";
import type { ActivityItem, AgentMessage, AgentsView, AgentStepRow, ChangeSummary, RunningPhase, Sections, StreamMessage } from "../../src/console/types";
import { diffCounts, parseDiff } from "../../src/ui/diff";
import { ago, clock, costSoFar, duration, pillText, shortModel, stepWord, usd } from "../../src/ui/format";
import { composing, decide, enterPressed, escapePressed, focusOr, keyLabel, keyMatcher, keyName, listKey, sendsMessage, sendsOnEnter, typingIn } from "../../src/ui/keys";
import { renderMarkdown, stripFrontmatter } from "../../src/ui/markdown";
import { clampAt, filterCommands, fuzzyScore, stepAt } from "../../src/ui/palette";
import { changesAddress, parseRoute, routePath, type Route } from "../../src/ui/router";
import { ACTIVITY_MAX, applyMessage, connect, connection, getJson, HttpError, STALE_MS, toasts, type State } from "../../src/ui/store";
import { addFrames, addItems, EMPTY, lastCost, type Frame } from "../../src/ui/transcript";
import { apply, FADE_MS, parseTarget, prune, slots, type Tile } from "../../src/ui/agents";
import { needsAPerson } from "../../src/ui/alerts";
import { parseIntentFile } from "../../src/intents";
import { nextTheme } from "../../src/ui/theme";
import { RECENT_DONE_MS, splitFinished, UP_NEXT, upNext } from "../../src/ui/board";
import { barEnd, barGeometry, codeKey, detailKey } from "../../src/ui/change-key";
import { aboutOf, aboutPrefix, addLines } from "../../src/ui/chat";
import { act, beforeOf, bodyFor, nextPoll, steer, steerOffer, stopChange, UNDOABLE, undoFor, unsentText } from "../../src/ui/requests";
import { lastRanText, pendingText, pickerChoices } from "../../src/ui/settings";
import { choicesFor, effective, fromNote, listText, parseList, withChosen } from "../../src/ui/agent-settings";
import { follow, streamGone } from "../../src/ui/stream";
import { feedAfter, liveRows, mergeFeed, type FeedState } from "../../src/ui/feed";
import { sessionFacts } from "../../src/ui/session-facts";
import { givesFocusBack, returnTarget } from "../../src/ui/parts/focus";

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
    expect(usd(Number.NaN)).toBe("–");
    expect(usd(Number.POSITIVE_INFINITY, true)).toBe("–");
    expect(clock("not a time", Date.now())).toBe("–");
    expect(clock(new Date().toISOString(), Date.now())).toMatch(/\d/);
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
    expect(parseRoute("/agents")).toEqual({ name: "agents" });
    expect(parseRoute("/c/csv-export")).toEqual({ name: "change", slug: "csv-export", tab: "overview" });
    expect(parseRoute("/c/csv-export/code")).toEqual({ name: "change", slug: "csv-export", tab: "code" });
    expect(parseRoute("/s/csv-export/12")).toEqual({ name: "session", slug: "csv-export", seq: 12 });
    expect(parseRoute("/s/_chat/3")).toEqual({ name: "session", slug: "_chat", seq: 3 });
    for (const bad of ["/c/Bad", "/c/one/nope", "/s/one/x", "/nope", "/c/one/code/more", "/c/%E0%A4%A"]) expect(parseRoute(bad)).toEqual({ name: "missing", path: bad });
    const all: Route[] = [
      { name: "live" }, { name: "inbox" }, { name: "changes" }, { name: "activity" }, { name: "agents" }, { name: "spend" }, { name: "settings" },
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
    // Some keydowns carry no key at all (Chrome's autofill): they are no key of the page's.
    expect(keyName({ ...key("x"), key: undefined as unknown as string })).toBeNull();
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

  test("Ctrl or Cmd with Enter sends a message, but not while an input method is picking a character", () => {
    const enter = (mods: Partial<{ ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode: number }> = {}) =>
      ({ key: "Enter", ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, ...mods });
    expect(sendsMessage(enter({ ctrlKey: true }))).toBe(true);
    expect(sendsMessage(enter({ metaKey: true }))).toBe(true);
    expect(sendsMessage(enter())).toBe(false);
    expect(sendsMessage({ ...enter({ ctrlKey: true }), key: "a" })).toBe(false);
    expect(sendsMessage(enter({ ctrlKey: true, isComposing: true }))).toBe(false);
    // Some browsers report a key an input method takes as keyCode 229 without isComposing.
    expect(sendsMessage(enter({ ctrlKey: true, keyCode: 229 }))).toBe(false);
  });

  test("in a box where Enter alone sends, Shift with Enter is a line break, and an input method's Enter is its own", () => {
    const enter = (mods: Partial<{ shiftKey: boolean; isComposing: boolean; keyCode: number }> = {}) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...mods });
    expect(sendsOnEnter(enter())).toBe(true);
    expect(sendsOnEnter(enter({ shiftKey: true }))).toBe(false);
    expect(sendsOnEnter({ ...enter(), key: "a" })).toBe(false);
    expect(sendsOnEnter(enter({ isComposing: true }))).toBe(false);
    expect(sendsOnEnter(enter({ keyCode: 229 }))).toBe(false);
  });

  test("in a one-line box Enter sends with or without Shift, since there is no line to break, but not an input method's", () => {
    const enter = (mods: Partial<{ shiftKey: boolean; isComposing: boolean; keyCode: number }> = {}) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...mods });
    const oneLine = { oneLine: true };
    expect(sendsOnEnter(enter(), oneLine)).toBe(true);
    expect(sendsOnEnter(enter({ shiftKey: true }), oneLine)).toBe(true);
    expect(sendsOnEnter({ ...enter(), key: "a" }, oneLine)).toBe(false);
    expect(sendsOnEnter(enter({ isComposing: true }), oneLine)).toBe(false);
    expect(sendsOnEnter(enter({ shiftKey: true, keyCode: 229 }), oneLine)).toBe(false);
  });

  test("Enter that picks the palette's row is any Enter but an input method's", () => {
    const enter = (mods: Partial<{ isComposing: boolean; keyCode: number }> = {}) => ({ key: "Enter", isComposing: false, keyCode: 13, ...mods });
    expect(enterPressed(enter())).toBe(true);
    expect(enterPressed({ ...enter(), key: "a" })).toBe(false);
    expect(enterPressed(enter({ isComposing: true }))).toBe(false);
    expect(enterPressed(enter({ keyCode: 229 }))).toBe(false);
  });

  test("an input method picking a character keeps every key: Escape, the arrows and the shortcuts do nothing of the page's then", () => {
    const press = (key: string, mods: Partial<{ isComposing: boolean; keyCode: number }> = {}) => ({ key, isComposing: false, keyCode: 0, ...mods });
    expect(composing(press("a"))).toBe(false);
    expect(composing(press("a", { isComposing: true }))).toBe(true);
    // Safari's keydown that ends a composition says isComposing false, but keyCode 229.
    expect(composing(press("Escape", { keyCode: 229 }))).toBe(true);
    expect(escapePressed(press("Escape"))).toBe(true);
    expect(escapePressed(press("a"))).toBe(false);
    expect(escapePressed(press("Escape", { isComposing: true }))).toBe(false);
    expect(escapePressed(press("Escape", { keyCode: 229 }))).toBe(false);
    expect(listKey(press("ArrowDown"))).toBe("next");
    expect(listKey(press("ArrowUp"))).toBe("prev");
    expect(listKey(press("Enter"))).toBe("pick");
    expect(listKey(press("a"))).toBeNull();
    for (const k of ["ArrowDown", "ArrowUp", "Enter"]) {
      expect({ k, what: listKey(press(k, { isComposing: true })) }).toEqual({ k, what: null });
      expect({ k, what: listKey(press(k, { keyCode: 229 })) }).toEqual({ k, what: null });
    }
  });

  test("after a form closes the focus goes to its button, or to the box when the button is gone or disabled (a stopped session)", () => {
    const focused: string[] = [];
    const el = (name: string, disabled = false) => ({ disabled, focus: () => { focused.push(name); } });
    focusOr(el("stop"), el("box"));
    focusOr(el("stop", true), el("box"));
    focusOr(null, el("box"));
    focusOr(undefined, null);
    expect(focused).toEqual(["stop", "box", "box"]);
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
  test("an edit's added and removed lines, as counts", () => {
    expect(diffCounts("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n")).toEqual({ added: 2, removed: 1 });
    expect(diffCounts("")).toEqual({ added: 0, removed: 0 });
  });

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

describe("where the focus goes when a panel closes", () => {
  const body = { name: "body" };
  const inside = { name: "the drawer's box" };
  const elsewhere = { name: "a box on the page" };
  const drawer = { contains: (n: unknown) => n === inside };

  test("a modal dialog always gives the focus back to what had it", () => {
    for (const active of [inside, elsewhere, body, null]) expect(givesFocusBack(active, body)).toBe(true);
  });

  test("the drawer gives it back only when the focus is in the drawer or nowhere, not when the person went on to something else", () => {
    expect(givesFocusBack(inside, body, drawer)).toBe(true);
    expect(givesFocusBack(body, body, drawer)).toBe(true);
    expect(givesFocusBack(null, body, drawer)).toBe(true);
    expect(givesFocusBack(elsewhere, body, drawer)).toBe(false);
    // The drawer's box already gone: only a focus that is nowhere is taken back.
    expect(givesFocusBack(elsewhere, body, null)).toBe(false);
    expect(givesFocusBack(body, body, null)).toBe(true);
  });

  test("a panel opened by a closing dialog gives the focus back to what that dialog would have", () => {
    const button = { name: "the button the palette was opened from" };
    const paletteBox = { name: "the palette's box, about to go" };
    // Nothing handed over: what has the focus as the panel opens.
    expect(returnTarget(null, elsewhere)).toBe(elsewhere);
    // The palette's Ask opens the drawer: not the palette's own box, but what had the focus before the palette.
    expect(returnTarget(button, paletteBox)).toBe(button);
    expect(returnTarget(button, body)).toBe(button);
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

  test("the page leaves out the frontmatter block the parser reads, and only that", () => {
    const inputs = [
      "---\n---\n# Intent: x\n",
      "---\r\nstatus: draft\r\n---\r\n# Intent: x\r\n",
      "\uFEFF---\nstatus: draft\n---\n# Intent: x\n",
      "---\nstatus: draft\nnote: |\n  a\n  ---\n  b\n---\n# Intent: x\n",
      "---\nstatus: draft\n---   \n# Intent: x\n",
      "---\nstatus: draft\n---",
      "---\nstatus: draft\n----\n# Intent: x\n",
      "--- \nstatus: draft\n---\n# Intent: x\n",
      "# No frontmatter\n\n---\n\nA rule.\n",
    ];
    for (const text of inputs) {
      let body: string | null = null;
      try { body = parseIntentFile(text).body; } catch { /* a fence the parser refuses: the page shows the text whole */ }
      expect(stripFrontmatter(text)).toBe(body ?? text.replace(/^\uFEFF/, ""));
    }
    // An empty block is frontmatter, not two rules; a closing line of four dashes closes nothing.
    expect(stripFrontmatter("---\n---\n# Intent: x\n")).toBe("# Intent: x\n");
    expect(stripFrontmatter("---\nstatus: draft\n----\n# Intent: x\n")).toBe("---\nstatus: draft\n----\n# Intent: x\n");
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

  test("an address that starts with two slashes reads as relative but leaves for another host, so it is shown as its text", () => {
    const html = renderMarkdown("[a](//evil.example/x) [b](/docs/x)");
    expect(html).not.toContain('href="//');
    expect(html).toContain('<a href="/docs/x"');
    // The first link is its text alone, and the page's own address stays a link.
    expect(html).toBe('<p>a <a href="/docs/x" target="_blank" rel="noopener noreferrer">b</a></p>\n');
  });

  test("an address with a backslash is shown as its text: browsers read it as a slash, so /\\host and \\\\host leave for another host", () => {
    for (const text of [
      "[a](/\\evil.example/x)",
      "[a](\\\\evil.example/x)",
      "[a](<\\\\evil.example>)",
      // Markdown's escaped slashes are plain slashes by the time the address is checked.
      "[a](\\/\\/evil.example)",
      "[a](docs\\x.md)",
      "[a]\n\n[a]: /\\evil.example",
    ]) {
      const html = renderMarkdown(text);
      expect({ text, html, href: html.includes("href") }).toEqual({ text, html, href: false });
    }
    expect(renderMarkdown("[a](/docs/x)")).toContain('<a href="/docs/x"');
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
    expect(s2.results.get("t1")).toEqual({ ok: true, output: "done" });
    expect(s2.todos).toEqual([]);
    expect(s.results.size).toBe(0);
  });

  test("a call whose id is a name every object has (constructor, toString) has no result until one comes", () => {
    const s = addItems(EMPTY, [{ kind: "tool", id: "constructor", tool: "Bash", target: "x", input: {} }]);
    expect(s.results.get("constructor")).toBeUndefined();
    expect(s.results.get("toString")).toBeUndefined();
    const s2 = addItems(s, [{ kind: "tool-result", id: "constructor", ok: false, output: "no" }]);
    expect(s2.results.get("constructor")).toEqual({ ok: false, output: "no" });
  });

  test("a row whose frame id is not one is drawn as it comes, and moves nothing: \"12x\" is not row 12", () => {
    const text = (t: string, id: string): Frame => ({ item: { kind: "text", text: t }, id });
    let s = addFrames(EMPTY, [text("a", "100")]);
    s = addFrames(s, [text("odd", "12x"), text("odd2", "50.1x"), text("none", "")]);
    expect(s.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual(["a", "odd", "odd2", "none"]);
    expect(s.line).toEqual({ end: 100, drawn: [] });
  });

  test("a call or edit that is already shown is not added again, as after a reconnect", () => {
    const tool = { kind: "tool", id: "t1", tool: "Bash", target: "x", input: {} } as const;
    const edit = { kind: "edit", id: "e1", tool: "Edit", path: "a.ts", diff: "" } as const;
    const s = addItems(EMPTY, [tool, edit, { kind: "text", text: "a" }]);
    const again = addItems(s, [tool, edit, { kind: "text", text: "a" }, { kind: "tool", id: "t2", tool: "Read", target: "y", input: {} }]);
    // Text has no id, so it cannot be told from a new line; only calls and edits are checked.
    expect(again.items.map((i) => ("id" in i ? i.id : i.kind))).toEqual(["t1", "e1", "text", "text", "t2"]);
  });

  // The server gives every row a frame id of its own: a row that is not its line's last gets the
  // line's start and its index in the line ("100.1"), the last gets the line's end ("200"); see TranscriptReader.read.
  const text = (t: string, id: string): Frame => ({ item: { kind: "text", text: t }, id });
  const tool = (t: string, id: string): Frame => ({ item: { kind: "tool", id: t, tool: "Bash", target: "x", input: {} }, id });
  const texts = (s: ReturnType<typeof addFrames>) => s.items.map((i) => ("id" in i ? i.id : i.kind === "text" ? i.text : i.kind));

  test("a line re-sent after a reconnect draws once: the stream continues from the line it was in and sends that line again", () => {
    // Line 1 is bytes 0 to 100 (two rows), line 2 is 100 to 200 (three rows). The page saw line 1 and the first two rows of line 2.
    let s = addFrames(EMPTY, [text("a", "0.0"), tool("t1", "100"), text("b", "100.0"), text("b2", "100.1")]);
    expect(texts(s)).toEqual(["a", "t1", "b", "b2"]);
    // The stream came back from byte 100 (the newest id the page saw, "100.1") and sent line 2 from its start.
    s = addFrames(s, [text("b", "100.0"), text("b2", "100.1"), text("c", "200")]);
    expect(texts(s)).toEqual(["a", "t1", "b", "b2", "c"]);
    // The next line's rows start where line 2 ended, and are new.
    s = addFrames(s, [text("d", "200.0"), text("e", "300")]);
    expect(texts(s)).toEqual(["a", "t1", "b", "b2", "c", "d", "e"]);
    expect(s.line).toEqual({ end: 300, drawn: [] });
  });

  test("a reconnect in a line that follows a line with no rows draws nothing twice", () => {
    // Line 1 is bytes 0 to 100 (one row), line 2 is 100 to 150 and has no rows, line 3 is 150 to 300 (two rows).
    let s = addFrames(EMPTY, [text("a", "100"), text("b", "150.0")]);
    expect(texts(s)).toEqual(["a", "b"]);
    // The stream came back from byte 150, the start of line 3, and sent it again.
    s = addFrames(s, [text("b", "150.0"), text("c", "300")]);
    expect(texts(s)).toEqual(["a", "b", "c"]);
  });

  test("identical rows are all drawn: two in one line, and the same words in two lines", () => {
    let s = addFrames(EMPTY, [text("ok", "0.0"), text("ok", "0.1"), text("ok", "100")]);
    expect(texts(s)).toEqual(["ok", "ok", "ok"]);
    s = addFrames(s, [text("ok", "200")]);
    expect(texts(s)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  test("a line's rows arriving in two batches are all drawn; a line drawn whole and sent again is passed over", () => {
    let s = addFrames(EMPTY, [text("ok", "100")]);
    // The second line's rows come in two batches: the second batch continues the line, it does not re-send it.
    s = addFrames(s, [text("x", "100.0")]);
    s = addFrames(s, [text("y", "100.1"), text("z", "200")]);
    expect(texts(s)).toEqual(["ok", "x", "y", "z"]);
    // Rows of a line drawn whole (a server that resumes earlier) are passed over, calls and edits included.
    expect(texts(addFrames(s, [text("old", "50.0"), tool("t9", "100"), text("x", "100.0"), text("z", "200")]))).toEqual(["ok", "x", "y", "z"]);
    // The old state is left alone.
    expect(texts(s)).toEqual(["ok", "x", "y", "z"]);
  });
});

describe("going to an address", () => {
  test("the same path, query and part after # adds nothing to the history; any of them different does", () => {
    const here = { pathname: "/agents", search: "", hash: "#csv:3" };
    expect(changesAddress(here, "/agents#csv:3")).toBe(false);
    expect(changesAddress(here, "/agents#csv:3:message")).toBe(true);
    expect(changesAddress(here, "/agents")).toBe(true);
    expect(changesAddress({ pathname: "/c/x", search: "?tab=y", hash: "" }, "/c/x?tab=y")).toBe(false);
    expect(changesAddress({ pathname: "/c/x", search: "?tab=y", hash: "" }, "/c/x")).toBe(true);
  });
});

describe("the activity feed read again after a gap", () => {
  const item = (id: number, slug = "a", text: string | null = "x"): ActivityItem => ({ id, slug, seq: null, ts: "t", type: "phase_start", text, technical: "tech" });
  const ids = (items: ActivityItem[]) => items.map((a) => a.id);
  const all = { slug: "", technical: false };

  test("the newest page is merged into what is shown by id, newest first, so older pages read before are kept", () => {
    const older = [item(30), item(20), item(10)];
    const { items, joined } = mergeFeed(older, [], [item(50), item(40), item(30)], all);
    expect(joined).toBe(true);
    expect(ids(items)).toEqual([50, 40, 30, 20, 10]);
    expect(ids(older)).toEqual([30, 20, 10]);
  });

  test("a page that does not reach what is shown stands alone, since what lies between could not be read", () => {
    expect(mergeFeed([item(30), item(20)], [], [item(90), item(80)], all)).toEqual({ items: [item(90), item(80)], joined: false });
    expect(mergeFeed([], [], [item(5)], all)).toEqual({ items: [item(5)], joined: false });
  });

  test("only the history read joins: a page that reaches only the live rows stands alone, since they can straddle the gap", () => {
    // Read: 20 and 10. From the stream since: 40 and 30. The page read again after a gap: 50 and 40.
    // The stream missed events somewhere, so 40 and 30 are not known to follow 20 with nothing between.
    expect(mergeFeed([item(20), item(10)], [item(40), item(30)], [item(50), item(40)], all)).toEqual({ items: [item(50), item(40)], joined: false });
    // A page that reaches the history joins, and keeps the live rows and what is below.
    const { items, joined } = mergeFeed([item(20), item(10)], [item(40), item(30)], [item(50), item(40), item(30), item(20)], all);
    expect(joined).toBe(true);
    expect(ids(items)).toEqual([50, 40, 30, 20, 10]);
    // A page that reaches neither stands alone; the live rows below it are left to Older.
    expect(mergeFeed([item(20), item(10)], [item(40), item(30)], [item(90), item(80)], all)).toEqual({ items: [item(90), item(80)], joined: false });
    // With nothing read yet there is no cursor to keep, so the page stands alone with its own.
    expect(mergeFeed([], [item(40), item(30)], [item(50), item(40)], all)).toEqual({ items: [item(50), item(40)], joined: false });
  });

  test("the live rows shown are the stream's rows above the list that fit the filter, newest first, and none in the technical view", () => {
    const stream = [item(5), item(10), item(30, "b"), item(40), item(50, "a", null)];
    expect(ids(liveRows(stream, [item(20), item(10)], all))).toEqual([40, 30]);
    expect(ids(liveRows(stream, [item(20)], { slug: "a", technical: false }))).toEqual([40]);
    expect(ids(liveRows(stream, [], all))).toEqual([40, 30, 10, 5]);
    expect(liveRows(stream, [item(20)], { slug: "", technical: true })).toEqual([]);
  });

  test("only rows that fit the filter go in: one change's, and rows in plain words unless the view is technical", () => {
    const page = [item(3, "b"), item(2, "a", null), item(1, "a")];
    expect(ids(mergeFeed([], [], page, { slug: "a", technical: false }).items)).toEqual([1]);
    expect(ids(mergeFeed([], [], page, { slug: "a", technical: true }).items)).toEqual([2, 1]);
    expect(ids(mergeFeed([], [], page, { slug: "", technical: true }).items)).toEqual([3, 2, 1]);
  });

  const shown: FeedState = { items: [item(30), item(20)], next: 20, failed: null };
  const older = { before: 20, how: "more" } as const;
  const gap = { before: 0, how: "merge" } as const;

  test("an Older read that failed is offered again after a gap reload joins the list, and Try again repeats it", () => {
    const failed = feedAfter(shown, older, null, all, []);
    expect(failed).toEqual({ items: [item(30), item(20)], next: 20, failed: older });
    const merged = feedAfter(failed, gap, { items: [item(40), item(30)], next: 30 }, all, []);
    expect(ids(merged.items)).toEqual([40, 30, 20]);
    // Neither Older nor Try again would be left without this: the failed read is still the Older one, from the same cursor.
    expect(merged.next).toBe(20);
    expect(merged.failed).toEqual(older);
    const again = feedAfter(merged, merged.failed!, { items: [item(10)], next: null }, all, []);
    expect(again).toEqual({ items: [item(40), item(30), item(20), item(10)], next: null, failed: null });
  });

  test("a gap reload that does not join stands alone with its own cursor; one that failed is cleared when one joins", () => {
    const failed = feedAfter(shown, older, null, all, []);
    expect(feedAfter(failed, gap, { items: [item(90), item(80)], next: 80 }, all, [])).toEqual({ items: [item(90), item(80)], next: 80, failed: null });
    const gapFailed = feedAfter(shown, gap, null, all, []);
    expect(gapFailed.failed).toEqual(gap);
    expect(feedAfter(gapFailed, gap, { items: [item(40), item(30)], next: 30 }, all, [])).toEqual({ items: [item(40), item(30), item(20)], next: 20, failed: null });
  });

  test("a gap reload that reaches only the live rows stands alone with its own cursor, so Older reads what lies between", () => {
    const merged = feedAfter(shown, gap, { items: [item(60), item(50)], next: 50 }, all, [item(50), item(40)]);
    expect(merged).toEqual({ items: [item(60), item(50)], next: 50, failed: null });
  });

  test("live rows on both sides of a gap: a page that reaches only the later ones hides nothing for good", () => {
    // Read: 20 and 10. The stream sent 30, then missed more than the hub holds (it said gap), then sent 805 and 810.
    const read: FeedState = { items: [item(20), item(10)], next: 10, failed: null };
    const page = Array.from({ length: 200 }, (_, k) => item(810 - k)); // 810 down to 611
    const merged = feedAfter(read, gap, { items: page, next: 611 }, all, [item(810), item(805), item(30)]);
    expect(merged.items).toEqual(page);
    // Older goes on from below the page, so 610 down to 31 are read in turn and then 30, 20 and 10.
    expect(merged.next).toBe(611);
  });

  test("a new page replaces the list, and an Older page adds below it", () => {
    expect(feedAfter(shown, { before: 0, how: "reset" }, { items: [item(5)], next: 5 }, all, [])).toEqual({ items: [item(5)], next: 5, failed: null });
    expect(feedAfter(shown, older, { items: [item(10)], next: null }, all, [])).toEqual({ items: [item(30), item(20), item(10)], next: null, failed: null });
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

  /** Runs `fn` with the fake EventSource and fake timers in place, and puts both back after. */
  const faked = (fn: () => void) => {
    const real = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    FakeSource.opened = [];
    jest.useFakeTimers();
    try { fn(); } finally {
      jest.useRealTimers();
      (globalThis as { EventSource?: unknown }).EventSource = real;
    }
  };

  test("a stream the browser closed before it said anything can be ended for good, as a session that does not exist", () => {
    faked(() => {
      const down: string[] = [];
      let got = false;
      const stop = follow((from) => (from > 0 ? `/s?from=${from}` : "/s"), {
        message() { got = true; },
        down(why) { down.push(why); return got ? undefined : "stop"; },
      });
      const first = FakeSource.opened[0]!;
      expect(first.url).toBe("/s");
      first.readyState = FakeSource.CLOSED;
      first.onerror!();
      jest.advanceTimersByTime(30_000);
      expect(down).toEqual(["closed"]);
      expect(FakeSource.opened).toHaveLength(1);
      expect(first.closed).toBe(true);
      stop();
    });
  });

  test("a stream closed after it spoke is opened again from the newest id; the browser's own reconnecting is only reported", () => {
    faked(() => {
      const down: string[] = [];
      let lives = 0;
      const stop = follow((from) => (from > 0 ? `/s?from=${from}` : "/s"), { message() {}, live() { lives++; }, down(why) { down.push(why); } });
      const first = FakeSource.opened[0]!;
      first.onmessage!({ data: "{}", lastEventId: "120" });
      first.onmessage!({ data: "{}", lastEventId: "" }); // a frame without an id keeps the newest
      expect(lives).toBe(2);
      first.onerror!(); // still connecting: the browser retries by itself
      expect(down).toEqual(["retrying"]);
      expect(FakeSource.opened).toHaveLength(1);
      first.readyState = FakeSource.CLOSED;
      first.onerror!();
      expect(down).toEqual(["retrying", "closed"]);
      jest.advanceTimersByTime(1000);
      expect(FakeSource.opened).toHaveLength(2);
      expect(FakeSource.opened[1]!.url).toBe("/s?from=120");
      stop();
      // Closed for good: nothing opens later, whatever the timers do.
      jest.advanceTimersByTime(60_000);
      expect(FakeSource.opened).toHaveLength(2);
      expect(FakeSource.opened[1]!.closed).toBe(true);
    });
  });

  test("a frame's id reaches the handler as it came; a new stream resumes at the number before its dot", () => {
    faked(() => {
      const ids: string[] = [];
      const stop = follow((from) => (from > 0 ? `/s?from=${from}` : "/s"), { message(_data, id) { ids.push(id); } });
      const first = FakeSource.opened[0]!;
      first.onmessage!({ data: "{}", lastEventId: "100" });
      first.onmessage!({ data: "{}", lastEventId: "150.1" });
      first.onmessage!({ data: "{}", lastEventId: "" });
      expect(ids).toEqual(["100", "150.1", ""]);
      first.readyState = FakeSource.CLOSED;
      first.onerror!();
      jest.advanceTimersByTime(1000);
      expect(FakeSource.opened[1]!.url).toBe("/s?from=150");
      stop();
    });
  });

  test("an id that is not a frame id moves nothing: a new stream resumes from the newest real one, as the server would", () => {
    faked(() => {
      const stop = follow((from) => (from > 0 ? `/s?from=${from}` : "/s"), { message() {} });
      const first = FakeSource.opened[0]!;
      first.onmessage!({ data: "{}", lastEventId: "100" });
      first.onmessage!({ data: "{}", lastEventId: "900x" });
      first.onmessage!({ data: "{}", lastEventId: "900.x" });
      first.readyState = FakeSource.CLOSED;
      first.onerror!();
      jest.advanceTimersByTime(1000);
      expect(FakeSource.opened[1]!.url).toBe("/s?from=100");
      stop();
    });
  });

  test("a stream closed before it said anything is gone only on a 404: a server error, a refusal or no answer is tried again", () => {
    expect(streamGone(404)).toBe(true);
    for (const status of [200, 403, 500, 503, null]) expect({ status, gone: streamGone(status) }).toEqual({ status, gone: false });
  });

  test("ending the stream from a message (the server said end) closes it and opens no other", () => {
    faked(() => {
      const stop = follow(() => "/s", { message(data) { if (data === "end") stop(); } });
      const first = FakeSource.opened[0]!;
      first.onmessage!({ data: "end", lastEventId: "" });
      expect(first.closed).toBe(true);
      jest.advanceTimersByTime(60_000);
      expect(FakeSource.opened).toHaveLength(1);
    });
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

describe("which changes the board folds away", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const change = (slug: string, stage: ChangeSummary["stage"], since: string | null) => ({ slug, stage, since }) as ChangeSummary;
  test("done changes finished within the week stay on the board; older ones fold with the closed ones", () => {
    const fresh = change("fresh", "done", new Date(now - RECENT_DONE_MS + 60_000).toISOString());
    const old = change("old", "done", new Date(now - RECENT_DONE_MS - 60_000).toISOString());
    const closed = change("closed", "closed", new Date(now).toISOString());
    const building = change("building", "build", new Date(0).toISOString());
    const { open, earlier, closed: shut } = splitFinished([fresh, old, closed, building], now);
    expect(open.map((c) => c.slug)).toEqual(["fresh", "building"]);
    expect(earlier.map((c) => c.slug)).toEqual(["old"]);
    expect(shut.map((c) => c.slug)).toEqual(["closed"]);
  });
  test("a done change with no known or readable finish time stays on the board", () => {
    const { open, earlier } = splitFinished([change("a", "done", null), change("b", "done", "not a time")], now);
    expect(open.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(earlier).toEqual([]);
  });
});

describe("when a change page reads its detail again", () => {
  const summary: ChangeSummary = { slug: "a", title: "A", status: "building", plain: "Being built", priority: "normal", stage: "build", since: "2026-01-01T00:00:00Z", inStatus: "12s", costUsd: 1.5, waiting: null, note: "", shownNote: "", running: true, held: null, statedPriority: null, offers: [], question: null };
  test("the age in words, which the server rebuilds every few seconds, does not count", () => {
    expect(detailKey({ ...summary, inStatus: "3 min" }, "2")).toBe(detailKey(summary, "2"));
    expect(detailKey(null, "")).toBe(detailKey(null, ""));
  });
  test("a status, cost, note, waiting reason, priority or running step does", () => {
    const base = detailKey(summary, "2");
    for (const changed of [{ status: "review" }, { since: "2026-01-02T00:00:00Z" }, { costUsd: 2 }, { running: false }, { waiting: "b" }, { note: "n" }, { shownNote: "n" }, { priority: "high" }]) {
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
  test("the orchestrator is told which change, and which session, the drawer was opened from", () => {
    expect(aboutOf({ slug: "csv-export", title: "CSV export", seq: 3 })).toEqual({ slug: "csv-export", seq: 3 });
    expect(aboutOf({ slug: "csv-export", title: "CSV export" })).toEqual({ slug: "csv-export" });
    expect(aboutOf({ title: "Step 3" })).toBeNull();
    expect(aboutOf(null)).toBeNull();
  });
});

describe("where a timeline bar ends", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  test("a finished step ends when it ended, a running one now, a step with no end time by its duration", () => {
    expect(barEnd({ started: "2026-01-01T00:00:00Z", ended: "2026-01-01T00:00:10Z", status: "success", durationMs: 99 }, t0 + 60_000)).toBe(t0 + 10_000);
    expect(barEnd({ started: "2026-01-01T00:00:00Z", ended: null, status: "running", durationMs: 0 }, t0 + 60_000)).toBe(t0 + 60_000);
    expect(barEnd({ started: "2026-01-01T00:00:00Z", ended: null, status: "fail", durationMs: 5_000 }, t0 + 60_000)).toBe(t0 + 5_000);
  });

  test("bars sit as percentages of the timeline; a step whose times cannot be read gets a sliver and does not set the scale", () => {
    const iso = (s: number) => new Date(t0 + s * 1000).toISOString();
    const bars = barGeometry([
      { started: iso(0), ended: iso(50), status: "success", durationMs: 50_000 },
      { started: "not a time", ended: null, status: "fail", durationMs: 5 },
      { started: iso(50), ended: null, status: "running", durationMs: 0 },
    ], t0 + 100_000);
    expect(bars[0]).toEqual({ left: 0, width: 50 });
    expect(bars[1]).toEqual({ left: 0, width: 0.4 });
    expect(bars[2]).toEqual({ left: 50, width: 50 });
    for (const b of bars) {
      expect(Number.isFinite(b.left)).toBe(true);
      expect(Number.isFinite(b.width)).toBe(true);
    }
    // A step over in a moment still shows; one whose end cannot be read is a sliver too.
    expect(barGeometry([{ started: iso(0), ended: iso(0), status: "success", durationMs: 0 }], t0)[0]!.width).toBe(0.4);
    expect(barGeometry([{ started: iso(0), ended: "?", status: "success", durationMs: 1 }], t0)[0]).toEqual({ left: 0, width: 0.4 });
    expect(barGeometry([], t0)).toEqual([]);
  });
});

describe("a session's facts", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const started = "2026-01-01T00:00:00Z";
  test("while it runs: the clock runs and the cost is an estimate at the rate, or nothing without one", () => {
    const f = sessionFacts({ started, ended: null, status: "running", finished: null, rate: 0.2, now: t0 + 5 * 60_000 });
    expect(f).toEqual({ elapsedMs: 5 * 60_000, cost: 1, estimate: true, status: "running" });
    expect(sessionFacts({ started, ended: null, status: "running", finished: null, rate: undefined, now: t0 + 1000 }).cost).toBeNull();
  });
  test("once over: the clock stops when it ended, the cost is what was recorded, and the trace's status stands in for a stream that only said running", () => {
    const f = sessionFacts({ started, ended: "2026-01-01T00:01:00Z", status: "success", finished: { costUsd: 0.5 }, rate: 0.2, now: t0 + 9 * 60_000 });
    expect(f).toEqual({ elapsedMs: 60_000, cost: 0.5, estimate: false, status: "success" });
    const late = sessionFacts({ started, ended: null, status: "running", finished: { status: "fail", ended: "2026-01-01T00:02:00Z", costUsd: 0.7 }, rate: 0.2, now: t0 + 9 * 60_000 });
    expect(late).toEqual({ elapsedMs: 120_000, cost: 0.7, estimate: false, status: "fail" });
    // Over with nothing recorded: the clock stops at the time given (when the page heard it end), and there is no cost to say.
    expect(sessionFacts({ started, ended: null, status: "running", finished: {}, rate: 0.2, now: t0 + 30_000 })).toEqual({ elapsedMs: 30_000, cost: null, estimate: false, status: "running" });
    // A status the stream settled is not an estimate even before the trace has the row.
    expect(sessionFacts({ started, ended: null, status: "success", finished: null, rate: 0.2, now: t0 + 30_000 }).estimate).toBe(false);
  });
});

describe("which keys count", () => {
  const press = keyMatcher([{ keys: "mod+k", action: "palette" }, { keys: "g l", action: "live" }, { keys: "escape", action: "escape" }]);
  const at = (over: Partial<{ typing: boolean; overlay: boolean; screenKey: boolean }> = {}) => ({ typing: false, overlay: false, screenKey: false, ...over });
  const run = (name: string | null, where = at()) => decide(name, (n) => press(n, 0), where);

  test("on the page, shortcuts and the screen's own keys both count", () => {
    expect(run("mod+k")).toEqual({ kind: "action", action: "palette" });
    expect(run("g")).toEqual({ kind: "nothing" });
    expect(run("l")).toEqual({ kind: "action", action: "live" });
    expect(run("j", at({ screenKey: true }))).toEqual({ kind: "screen" });
    expect(run("j")).toEqual({ kind: "nothing" });
    expect(run(null, at({ screenKey: true }))).toEqual({ kind: "nothing" });
  });

  test("while typing, letters are typing: only Ctrl or Cmd shortcuts and Escape count, and the screen's keys never", () => {
    expect(run("j", at({ typing: true, screenKey: true }))).toEqual({ kind: "nothing" });
    expect(run("g", at({ typing: true }))).toEqual({ kind: "nothing" });
    expect(run("mod+k", at({ typing: true }))).toEqual({ kind: "action", action: "palette" });
    expect(run("escape", at({ typing: true }))).toEqual({ kind: "action", action: "escape" });
  });

  test("with an overlay in front, the screen's keys do not count, but the page's shortcuts (Escape closes it) do", () => {
    expect(run("j", at({ overlay: true, screenKey: true }))).toEqual({ kind: "nothing" });
    expect(run("escape", at({ overlay: true }))).toEqual({ kind: "action", action: "escape" });
    expect(run("mod+k", at({ overlay: true }))).toEqual({ kind: "action", action: "palette" });
  });
});

describe("the inbox's selection", () => {
  test("j and k step through the list and stop at its ends; a row left beyond a list that shrank is brought back in first", () => {
    expect(stepAt(0, 1, 5)).toBe(1);
    expect(stepAt(4, 1, 5)).toBe(4);
    expect(stepAt(0, -1, 5)).toBe(0);
    expect(stepAt(3, -1, 5)).toBe(2);
    expect(stepAt(7, 1, 5)).toBe(4);
    expect(stepAt(7, -1, 5)).toBe(3);
    expect(stepAt(2, 1, 0)).toBe(0);
    expect(stepAt(0, -1, 0)).toBe(0);
  });
});

describe("what is up next on the Live screen", () => {
  const change = (slug: string, status: string) => ({ slug, status }) as ChangeSummary;
  test("changes waiting their turn, without the ones being worked on, at most six, in the list's order", () => {
    const list = [change("busy", "building"), change("a", "accepted"), change("done", "done"), change("b", "plan-approved"), change("draft", "draft"), change("blocked", "blocked")];
    expect(upNext(list, ["busy"]).map((c) => c.slug)).toEqual(["a", "b"]);
    expect(upNext(list, []).map((c) => c.slug)).toEqual(["busy", "a", "b"]);
    const many = Array.from({ length: 10 }, (_, k) => change(`c${k}`, "building"));
    expect(upNext(many, [])).toHaveLength(UP_NEXT);
    expect(upNext(many, ["c0"]).map((c) => c.slug)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(upNext(many, [], 2)).toHaveLength(2);
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
    // An answer names no status, whatever the status; it names the question the person saw.
    expect(bodyFor(change, { kind: "answer", label: "Answer" }, { note: "No." })).toStrictEqual({ kind: "answer", slug: "a", text: "No." });
    const asking = { ...change, question: { text: "Archived too?", why: "", options: [], phase: "design", at: "2026-10-17T12:00:00.000Z" } };
    expect(bodyFor(asking, { kind: "answer", label: "Answer" }, { note: "No." })).toStrictEqual({ kind: "answer", slug: "a", text: "No.", question: "2026-10-17T12:00:00.000Z" });
  });

  test("an answer has no Undo: the session carries on with it", () => {
    expect(UNDOABLE.has("answer")).toBe(false);
  });

  test("stopping a change posts to its stop route and says it is held; a refusal says why", async () => {
    const real = globalThis.fetch;
    const posted: Array<[string, unknown]> = [];
    let refuse = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push([url, JSON.parse(init?.body as string)]);
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
      posted.push([url, JSON.parse(init?.body as string)]);
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

describe("the agents screen's tiles", () => {
  const agent = (slug: string, seq: number): RunningPhase => ({ slug, title: `T ${slug}`, seq, name: "build", model: null, started: "2026-10-18T10:00:00.000Z", now: "", strip: [], steerable: true });
  const open = (slug: string, seq: number): AgentMessage => ({ type: "open", agent: agent(slug, seq) });
  const text = (key: string, t: string): AgentMessage => ({ type: "item", key, item: { kind: "text", text: t } });
  const keys = (tiles: Tile[]) => tiles.map((x) => x.key);

  test("open adds a tile at the end; rows go to their tile; open again starts the tile over in its place", () => {
    let tiles = apply([], [open("a", 1), text("a:1", "x"), open("b", 2), text("b:2", "y"), text("a:1", "z")], 0);
    expect(keys(tiles)).toEqual(["a:1", "b:2"]);
    expect(tiles[0]!.shown.items).toEqual([{ kind: "text", text: "x" }, { kind: "text", text: "z" }]);
    expect(tiles[1]!.shown.items).toEqual([{ kind: "text", text: "y" }]);
    tiles = apply(tiles, [open("a", 1), text("a:1", "again")], 5);
    expect(keys(tiles)).toEqual(["a:1", "b:2"]);
    expect(tiles[0]!.shown.items).toEqual([{ kind: "text", text: "again" }]);
    // Rows for a session the page never saw opened are dropped, and nothing else changes.
    expect(apply(tiles, [text("c:9", "?")], 6)).toBe(tiles);
  });

  test("a phase message is kept; end marks the tile ended; it stays FADE_MS, then goes", () => {
    const tiles = apply([], [open("a", 1), text("a:1", "last"), { type: "phase", key: "a:1", name: "build", status: "success", started: "s", ended: "e" }, { type: "end", key: "a:1" }], 1000);
    expect(tiles[0]!.phase).toEqual({ type: "phase", name: "build", status: "success", started: "s", ended: "e" });
    expect(tiles[0]!.shown.items).toEqual([{ kind: "text", text: "last" }]);
    expect(tiles[0]!.endedAt).toBe(1000);
    expect(prune(tiles, 1000 + FADE_MS - 1)).toBe(tiles);
    expect(prune(tiles, 1000 + FADE_MS)).toEqual([]);
  });

  test("sync ends the running tiles it does not name", () => {
    const tiles = apply([], [open("a", 1), open("b", 2), { type: "sync", keys: ["b:2"] }], 7);
    expect(tiles.map((x) => [x.key, x.endedAt])).toEqual([["a:1", 7], ["b:2", null]]);
  });

  test("slots: questions first, then tiles as they came, then the orchestrator; a change with a question shows no finished tile", () => {
    const tiles = apply([], [open("a", 1), open("b", 2), { type: "end", key: "a:1" }], 0);
    const changes = [{ slug: "b", question: null }, { slug: "a", question: { text: "?", why: "", options: [], phase: "build", at: "t" } }] as unknown as ChangeSummary[];
    const names = (s: ReturnType<typeof slots>) => s.map((x) => (x.kind === "agent" ? x.tile.key : x.kind === "question" ? `q:${x.change.slug}` : "chat"));
    expect(names(slots(tiles, changes, true))).toEqual(["q:a", "b:2", "chat"]);
    expect(names(slots(tiles, null, false))).toEqual(["a:1", "b:2"]);
  });

  test("a link's target: a session, and whether to put the cursor in its box", () => {
    expect(parseTarget("#one:3")).toEqual({ key: "one:3", message: false });
    expect(parseTarget("#one:3:message")).toEqual({ key: "one:3", message: true });
    for (const bad of ["", "#", "#one", "#One:3", "#one:x", "#one:3:other"]) expect(parseTarget(bad)).toBeNull();
  });

  test("the cost a transcript's last result names", () => {
    expect(lastCost(EMPTY)).toBeNull();
    expect(lastCost(addItems(EMPTY, [{ kind: "result", ok: true, summary: "", costUsd: 0.5 }, { kind: "text", text: "after" }]))).toBe(0.5);
  });
});

describe("the Settings page", () => {
  test("a step can be put back to its default, offered as setup's auto with the default shown; a group or a named model cannot", () => {
    expect(pickerChoices({ path: "stages.verify.steps.lessons", byDefault: "cheap" }).map((c) => c.label)).toEqual(["auto (cheap)", "cheap", "default", "strong", "max"]);
    expect(pickerChoices({ path: "stages.build.steps.revise", byDefault: "follows build: default" }).map((c) => c.label)).toEqual(["auto (follows build: default)", "cheap", "default", "strong", "max"]);
    expect(pickerChoices({ path: "stages.verify.steps.lessons", byDefault: "cheap" })[0]!.value).toBeNull();
    expect(pickerChoices({ path: "stages.verify.model" }).map((c) => c.label)).toEqual(["cheap", "default", "strong", "max"]);
    expect(pickerChoices({ path: null }).map((c) => c.value)).toEqual(["cheap", "default", "strong", "max"]);
  });
  test("last ran on names what the session was asked for, not what the name holds now", () => {
    const at = Date.parse("2026-10-23T12:00:00.000Z");
    const ts = "2026-10-23T10:00:00.000Z";
    expect(lastRanText(null, at)).toBe("not used yet");
    expect(lastRanText({ asked: "opus", ran: "claude-opus-5-5", result: "ok", ts }, at)).toBe("opus → claude-opus-5-5, 2h ago");
    expect(lastRanText({ asked: "opus", ran: null, result: "ok", ts }, at)).toBe("opus → opus, 2h ago");
    expect(lastRanText({ asked: "opuss", ran: null, result: "bad-model", ts }, at)).toBe("failed: opuss is not a model");
  });
  test("a pending change says whether it waits for the loop", () => {
    expect(pendingText("stopped")).toBe("Saved when the loop next runs.");
    expect(pendingText("not-responding")).toBe("Saved when the loop next runs.");
    expect(pendingText("running")).toBe("Saving…");
  });
});

describe("the Agents section of the Settings page", () => {
  const row = (r: Partial<AgentStepRow> & Pick<AgentStepRow, "key">): AgentStepRow =>
    ({ what: "", readOnly: false, chat: false, continuesBuild: false, own: {}, fromAll: {}, fromStage: [], ...r });
  const item = (kind: "agent" | "skill", name: string, from: "repo" | "personal" | "plugin") =>
    ({ kind, name, description: "", from, usedBy: [], base: "absent", editable: false });
  const view = (over: Partial<AgentsView> = {}): AgentsView => ({
    version: "v1", problem: null, sources: "all",
    steps: [row({ key: "all" }), row({ key: "build" }), row({ key: "fix", continuesBuild: true }), row({ key: "review", readOnly: true })],
    teams: [{ name: "reviewers", members: ["lead"], way: "parallel", usedBy: [] }],
    library: [item("agent", "lead", "repo"), item("agent", "helper", "personal"), item("agent", "tools:auditor", "plugin"), item("skill", "tone", "repo"), item("skill", "style", "personal"), item("agent", "lead", "personal")],
    problems: [], builtins: ["general-purpose", "Explore"], ways: ["parallel", "pick"],
    ...over,
  });

  test("effective agent setup: own, then all steps, then stage skills; fix shows the build's agent", () => {
    const build = row({ key: "build", own: { agent: "lead", skills: ["tone"] }, fromAll: { agent: "base", skills: ["style"] }, fromStage: ["tdd"] });
    expect(effective(build, "agent")).toEqual({ value: "lead", from: "own" });
    // A list adds up the way a session gets it: all steps, the stage's skills, then its own, each once.
    expect(effective(build, "skills")).toEqual({ value: ["style", "tdd", "tone"], from: "own" });
    const plan = row({ key: "plan", fromAll: { agent: "base", skills: ["style"], tools: ["Read"] }, fromStage: ["tdd", "style"] });
    expect(effective(plan, "agent")).toEqual({ value: "base", from: "all" });
    expect(effective(plan, "skills")).toEqual({ value: ["style", "tdd"], from: "all" });
    expect(effective(plan, "tools")).toEqual({ value: ["Read"], from: "all" });
    // Stage skills reach only the skills.
    const verify = row({ key: "verify", fromStage: ["checks"] });
    expect(effective(verify, "skills")).toEqual({ value: ["checks"], from: "stage" });
    expect(effective(verify, "subagents")).toEqual({ value: [], from: null });
    expect(effective(verify, "agent")).toEqual({ value: null, from: null });
    // Fix, reconcile and revise run as the build's agent, whatever all steps names.
    const fix = row({ key: "fix", continuesBuild: true, fromAll: { agent: "base" } });
    expect(effective(fix, "agent", build)).toEqual({ value: "lead", from: "build" });
    expect(effective(fix, "agent", row({ key: "build", fromAll: { agent: "base" } }))).toEqual({ value: "base", from: "build" });
    expect(effective(fix, "agent")).toEqual({ value: null, from: "build" });
  });

  test("the muted note says where a value comes from", () => {
    expect(fromNote({ value: "base", from: "all" }, row({ key: "plan" }), "agent")).toBe("from all steps");
    expect(fromNote({ value: "lead", from: "build" }, row({ key: "fix" }), "agent")).toBe("as build");
    expect(fromNote({ value: null, from: "build" }, row({ key: "fix" }), "agent")).toBe("as build");
    expect(fromNote({ value: ["checks"], from: "stage" }, row({ key: "verify" }), "skills")).toBe("stage skill");
    expect(fromNote({ value: ["style", "tdd"], from: "all" }, row({ key: "plan", fromAll: { skills: ["style"] }, fromStage: ["tdd"] }), "skills")).toBe("from all steps and stage skills");
    // Its own, with more added from elsewhere.
    expect(fromNote({ value: ["style", "tone"], from: "own" }, row({ key: "build", own: { skills: ["tone"] }, fromAll: { skills: ["style"] } }), "skills")).toBe("with all steps");
    expect(fromNote({ value: ["tone"], from: "own" }, row({ key: "build", own: { skills: ["tone"] } }), "skills")).toBe("");
    expect(fromNote({ value: null, from: null }, row({ key: "build" }), "agent")).toBe("");
  });

  test("parseList splits, trims, dedupes and keeps order", () => {
    expect(parseList(" a, b,,a , c ")).toEqual(["a", "b", "c"]);
    expect(parseList("")).toEqual([]);
    expect(parseList(" , ")).toEqual([]);
    expect(parseList("Bash(bun test)")).toEqual(["Bash(bun test)"]);
  });

  test("listText joins a list, or says none", () => {
    expect(listText(["a", "b"])).toBe("a, b");
    expect(listText([])).toBe("none");
  });

  test("choicesFor leaves built-ins out of a step's own agent", () => {
    const v = view();
    expect(choicesFor(v, "agent", "build")).toEqual(["lead", "helper", "tools:auditor"]);
    expect(choicesFor(v, "subagents", "build")).toEqual(["lead", "helper", "tools:auditor", "general-purpose", "Explore"]);
    expect(choicesFor(v, "teams", "review")).toEqual(["reviewers"]);
    expect(choicesFor(v, "skills", "all")).toEqual(["tone", "style"]);
    // A step that runs as the build's agent has none of its own to pick.
    expect(choicesFor(v, "agent", "fix")).toEqual([]);
    // Tools are typed, not picked.
    expect(choicesFor(v, "tools", "build")).toEqual([]);
    expect(choicesFor(v, "mcp_tools", "build")).toEqual([]);
  });

  test("with sources: repo, a step is offered only the repo's agents and skills", () => {
    const v = view({ sources: "repo" });
    expect(choicesFor(v, "agent", "build")).toEqual(["lead"]);
    expect(choicesFor(v, "subagents", "build")).toEqual(["lead", "general-purpose", "Explore"]);
    expect(choicesFor(v, "skills", "build")).toEqual(["tone"]);
  });

  test("a picker keeps the names already chosen, even ones it does not offer, so they can be taken off", () => {
    expect(withChosen(["a", "b"], ["b", "gone"])).toEqual(["a", "b", "gone"]);
    expect(withChosen(["a"], [])).toEqual(["a"]);
  });
});
