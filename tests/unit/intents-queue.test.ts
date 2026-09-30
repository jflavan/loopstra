import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkConsistency, dependencyNote, isRunnable, orderQueue, plainStatus, readIntent, renderQueue, scanRepo, waitingOn, writeIntent,
  type Intent,
} from "../../src/intents";
import { tempDir } from "../helpers";

async function mk(root: string, slug: string, fm: string, extra: Record<string, string> = {}) {
  const dir = join(root, "intent", slug);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "intent.md"), `---\n${fm}\n---\n# Intent: ${slug}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`);
  for (const [name, text] of Object.entries(extra)) await Bun.write(join(dir, name), text);
}

describe("scan and queue", () => {
  test("scans intent folders and skips files and README", async () => {
    const t = tempDir();
    await mk(t.path, "b-thing", "status: accepted\npriority: high\nopened: 2026-09-02");
    await mk(t.path, "a-thing", "status: accepted\npriority: high\nopened: 2026-09-01");
    await Bun.write(join(t.path, "intent", "README.md"), "guide");
    await Bun.write(join(t.path, "intent", "queue.md"), "queue");
    const intents = (await scanRepo(t.path)).intents;
    expect(intents.map((i) => i.slug).sort()).toEqual(["a-thing", "b-thing"]);
    t.cleanup();
  });

  test("a folder name that is not lowercase words joined by dashes is listed for a person, with how to fix it", async () => {
    const t = tempDir();
    await mk(t.path, "add-numbers", "status: accepted");
    await mk(t.path, "Add_Numbers", "status: accepted");
    await mk(t.path, "add numbers", "status: accepted");
    const scan = await scanRepo(t.path);
    expect(scan.intents.map((i) => i.slug)).toEqual(["add-numbers"]);
    expect(scan.unreadable.map((u) => u.slug).sort()).toEqual(["Add_Numbers", "add numbers"]);
    for (const u of scan.unreadable) expect(u.problem).toBe("Rename the folder to lowercase words joined by dashes, like add-numbers.");
    t.cleanup();
  });

  test("a line in intent.md that Loopstra does not know is named, with how to fix it", async () => {
    const t = tempDir();
    await mk(t.path, "one", "status: accepted\ncolour: blue");
    const [u] = (await scanRepo(t.path)).unreadable;
    expect(u?.problem).toBe("intent.md has a line Loopstra does not recognise: 'colour'. Remove it or fix the spelling.");
    t.cleanup();
  });

  test("orders in-flight, then approved, then accepted; then priority; then opened; then slug", async () => {
    const t = tempDir();
    await mk(t.path, "z-accepted-urgent", "status: accepted\npriority: urgent\nopened: 2026-09-01");
    await mk(t.path, "m-building", "status: building\npriority: low\nopened: 2026-09-05", { "spec.md": "s", "plan.md": "p" });
    await mk(t.path, "k-approved", "status: spec-approved\npriority: normal\nopened: 2026-09-03", { "spec.md": "s" });
    await mk(t.path, "a-accepted-normal-old", "status: accepted\npriority: normal\nopened: 2026-08-01");
    await mk(t.path, "b-accepted-normal-old", "status: accepted\npriority: normal\nopened: 2026-08-01");
    await mk(t.path, "done-one", "status: done\npriority: urgent\nopened: 2026-01-01", { "spec.md": "s", "plan.md": "p", "outcome.md": "o" });
    const ordered = orderQueue((await scanRepo(t.path)).intents).map((i) => i.slug);
    expect(ordered).toEqual([
      "m-building", "k-approved", "z-accepted-urgent", "a-accepted-normal-old", "b-accepted-normal-old", "done-one",
    ]);
    t.cleanup();
  });

  test("merge-approved is a known status with plain wording and needs the spec and plan", async () => {
    const t = tempDir();
    await mk(t.path, "approved", "status: merge-approved", { "spec.md": "s" });
    const [i] = (await scanRepo(t.path)).intents;
    expect(checkConsistency(i!)).toMatch(/plan\.md/);
    expect(plainStatus("merge-approved")).toBe("approved, waiting to merge");
    expect(plainStatus("merge-review")).toBe("ready to merge, waiting for a person");
    t.cleanup();
  });

  test("consistency skips drafts and finished changes", async () => {
    const t = tempDir();
    await mk(t.path, "finished-long-ago", "status: done");
    await mk(t.path, "dismissed", "status: closed");
    await Bun.write(join(t.path, "intent", "half-written", "intent.md"), "---\nstatus: draft\n---\n# Intent: half\n");
    for (const i of (await scanRepo(t.path)).intents) expect(checkConsistency(i)).toBeNull();
    t.cleanup();
  });

  test("consistency requires artifacts implied by status", async () => {
    const t = tempDir();
    await mk(t.path, "no-spec", "status: spec-review");
    const [i] = (await scanRepo(t.path)).intents;
    expect(checkConsistency(i!)).toMatch(/spec\.md/);
    await mk(t.path, "has-spec", "status: spec-review", { "spec.md": "# Spec" });
    const ok = ((await scanRepo(t.path)).intents).find((x) => x.slug === "has-spec")!;
    expect(checkConsistency(ok)).toBeNull();
    t.cleanup();
  });

  test("runnable excludes draft, blocked, terminal, and human-waiting review states", () => {
    const base = { slug: "x", dir: "", file: { frontmatter: { status: "accepted", priority: "normal", author: "", opened: "", note: "" }, title: "x", body: "", sections: {} }, artifacts: new Set<string>() } as unknown as Intent;
    const with_ = (status: string) => ({ ...base, file: { ...base.file, frontmatter: { ...base.file.frontmatter, status } } }) as Intent;
    expect(isRunnable(with_("accepted"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(true);
    expect(isRunnable(with_("draft"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("blocked"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("done"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("spec-review"), { spec: "status", plan: "none", merge: "none", done: "none" })).toBe(false);
    expect(isRunnable(with_("spec-review"), { spec: "none", plan: "none", merge: "none", done: "none" })).toBe(true);
    expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "pr", done: "none" })).toBe(false);
    expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "status", done: "none" })).toBe(false);
    // With a remote, the merge step always watches the pull request (merged or closed on GitHub counts in every mode).
    expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "pr", done: "none" }, true)).toBe(true);
    expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "none", done: "none" }, true)).toBe(true);
    expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "status", done: "none" }, true)).toBe(true);
    expect(isRunnable(with_("merge-approved"), { spec: "none", plan: "none", merge: "status", done: "none" })).toBe(true);
    expect(isRunnable(with_("verifying"), { spec: "none", plan: "none", merge: "none", done: "status" })).toBe(false);
    expect(isRunnable(with_("merged"), { spec: "none", plan: "none", merge: "none", done: "status" })).toBe(true);
  });

  test("writeIntent updates status and note and readIntent sees it", async () => {
    const t = tempDir();
    await mk(t.path, "w", "status: accepted");
    const [i] = (await scanRepo(t.path)).intents;
    await writeIntent(i!, { status: "blocked", note: "Tests failed three times." });
    const again = await readIntent(t.path, "w");
    expect(again.file.frontmatter.status).toBe("blocked");
    expect(again.file.frontmatter.note).toBe("Tests failed three times.");
    t.cleanup();
  });

  test("renderQueue lists active, blocked, and finished intents in plain language", async () => {
    const t = tempDir();
    await mk(t.path, "active", "status: building\npriority: high", { "spec.md": "s", "plan.md": "p" });
    await mk(t.path, "stuck", "status: blocked\nnote: Need an answer about adjusters.");
    await mk(t.path, "finished", "status: done", { "spec.md": "s", "plan.md": "p", "outcome.md": "o" });
    const md = renderQueue(orderQueue((await scanRepo(t.path)).intents));
    expect(md).toContain("| active |");
    expect(md).toContain("Need an answer about adjusters.");
    expect(md).toContain("finished");
    expect(md.startsWith("# Queue")).toBe(true);
    t.cleanup();
  });

  test("renderQueue lists everything waiting for a person under Needs a person: blocked, drafts, and reviews with a person on the gate", async () => {
    const t = tempDir();
    await mk(t.path, "stuck", "status: blocked\nnote: The tests failed.");
    await mk(t.path, "idea", "status: draft");
    await mk(t.path, "spec-ready", "status: spec-review", { "spec.md": "s" });
    await mk(t.path, "plan-ready", "status: plan-review", { "spec.md": "s", "plan.md": "p" });
    await mk(t.path, "busy", "status: building", { "spec.md": "s", "plan.md": "p" });
    const md = renderQueue(orderQueue((await scanRepo(t.path)).intents), [], { spec: "status", plan: "none", merge: "none", done: "none" });
    const section = (name: string) => md.slice(md.indexOf(`## ${name}`)).split("\n## ")[0]!;
    const needs = section("Needs a person");
    for (const slug of ["stuck", "idea", "spec-ready"]) expect(needs).toContain(`| ${slug} |`);
    const active = section("In progress, in order");
    for (const slug of ["plan-ready", "busy"]) expect(active).toContain(`| ${slug} |`);
    expect(active).not.toContain("| spec-ready |");
    expect(md).not.toContain("## Drafts");
    t.cleanup();
  });

  test("a request missing required sections is told which, in plain words", async () => {
    const t = tempDir();
    const write = async (slug: string, body: string) => {
      mkdirSync(join(t.path, "intent", slug), { recursive: true });
      await Bun.write(join(t.path, "intent", slug, "intent.md"), `---\nstatus: accepted\n---\n# Intent: ${slug}\n${body}`);
    };
    await write("two", "\n## Problem\np\n");
    await write("one", "\n## Problem\np\n\n## Proposed outcome\no\n");
    await write("none", "");
    const by = Object.fromEntries((await scanRepo(t.path)).intents.map((i) => [i.slug, checkConsistency(i)]));
    expect(by.two).toBe("This request is missing a Proposed outcome and a Done when section. Add them to intent.md, then set status to accepted.");
    expect(by.one).toBe("This request is missing a Done when section. Add it to intent.md, then set status to accepted.");
    expect(by.none).toBe("This request is missing a Problem, a Proposed outcome and a Done when section. Add them to intent.md, then set status to accepted.");
    t.cleanup();
  });

  test("renderQueue collapses a multi-line note into a single table row", async () => {
    const t = tempDir();
    await mk(t.path, "stuck", "status: blocked\nnote: |\n  Need an answer about adjusters.\n  Waiting since Monday.");
    const md = renderQueue(orderQueue((await scanRepo(t.path)).intents));
    const row = md.split("\n").find((l) => l.startsWith("| stuck |"));
    expect(row).toBeDefined();
    expect(row).toContain("Need an answer about adjusters. Waiting since Monday.");
    expect(row?.split("\n").length ?? 0).toBe(1);
    t.cleanup();
  });
  test("depends_on takes a list, a single name, or nothing", async () => {
    const t = tempDir();
    await mk(t.path, "list", "status: accepted\ndepends_on: [one, two]");
    await mk(t.path, "block-list", "status: accepted\ndepends_on:\n  - one\n  - two");
    await mk(t.path, "single", "status: accepted\ndepends_on: one");
    await mk(t.path, "blank", "status: accepted\ndepends_on:");
    await mk(t.path, "none", "status: accepted");
    const by = Object.fromEntries((await scanRepo(t.path)).intents.map((i) => [i.slug, i.file.frontmatter.depends_on]));
    expect(by).toEqual({ list: ["one", "two"], "block-list": ["one", "two"], single: ["one"], blank: undefined, none: undefined });
    t.cleanup();
  });

  test("a change waits until every change it depends on is merged; a blocked one keeps it waiting, with why", async () => {
    const t = tempDir();
    const both = { "spec.md": "s", "plan.md": "p" };
    await mk(t.path, "05-public-web", "status: blocked\nnote: The tests failed.");
    await mk(t.path, "04-api", "status: merged", both);
    await mk(t.path, "03-data", "status: done", { ...both, "outcome.md": "o" });
    await mk(t.path, "06-admin", "status: accepted\ndepends_on: [03-data, 04-api, 05-public-web]");
    await mk(t.path, "07-launch", "status: accepted\ndepends_on: [06-admin]");
    await mk(t.path, "08-extra", "status: accepted\ndepends_on: [03-data, 04-api]");
    const intents = (await scanRepo(t.path)).intents;
    const by = (slug: string) => intents.find((i) => i.slug === slug)!;
    expect(waitingOn(by("06-admin"), intents)).toEqual(["05-public-web"]);
    expect(waitingOn(by("07-launch"), intents)).toEqual(["06-admin"]);
    expect(waitingOn(by("08-extra"), intents)).toEqual([]);
    expect(dependencyNote(by("06-admin"), intents)).toBe("Waits for 05-public-web to be merged (now: needs a person).");
    expect(dependencyNote(by("07-launch"), intents)).toBe("Waits for 06-admin to be merged (now: waiting to be designed).");
    expect(dependencyNote(by("08-extra"), intents)).toBeNull();
    // Only a change that would otherwise go on waits: a draft or a finished change has nothing to hold up.
    await mk(t.path, "09-draft", "status: draft\ndepends_on: [05-public-web]");
    const again = (await scanRepo(t.path)).intents;
    expect(dependencyNote(again.find((i) => i.slug === "09-draft")!, again)).toBeNull();
    t.cleanup();
  });

  test("a dependency that is missing, closed, or waits back on the change says what a person can do", async () => {
    const t = tempDir();
    await mk(t.path, "gone", "status: closed");
    await mk(t.path, "on-typo", "status: accepted\ndepends_on: [publc-web]");
    await mk(t.path, "on-closed", "status: accepted\ndepends_on: [gone]");
    await mk(t.path, "a", "status: accepted\ndepends_on: [b]");
    await mk(t.path, "b", "status: accepted\ndepends_on: [a]");
    await mk(t.path, "self", "status: accepted\ndepends_on: [self]");
    const intents = (await scanRepo(t.path)).intents;
    const note = (slug: string) => dependencyNote(intents.find((i) => i.slug === slug)!, intents);
    expect(note("on-typo")).toBe("Waits for publc-web, which Loopstra cannot find or read in intent/. Fix the name in depends_on, or remove it.");
    expect(note("on-closed")).toBe("Waits for gone, which was closed. Remove it from depends_on to go ahead.");
    expect(note("a")).toBe("Waits for b, which waits for this change too. Remove one of them from depends_on.");
    expect(note("self")).toBe("Waits for self, which waits for this change too. Remove one of them from depends_on.");
    t.cleanup();
  });

  test("renderQueue shows why a change waits for another", async () => {
    const t = tempDir();
    await mk(t.path, "first", "status: blocked\nnote: The tests failed.");
    await mk(t.path, "second", "status: accepted\ndepends_on: [first]");
    const md = renderQueue(orderQueue((await scanRepo(t.path)).intents));
    const row = md.split("\n").find((l) => l.startsWith("| second |"));
    expect(row).toContain("Waits for first to be merged (now: needs a person).");
    t.cleanup();
  });
});
