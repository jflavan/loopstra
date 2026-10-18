import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkConsistency, dependencyNote, isRunnable, orderQueue, parseIntentFile, plainStatus, readIntent, renderQueue, scanRepo, waitingOn, writeIntent,
  type Intent,
} from "../../src/intents";
import { sameFileHolds } from "../../src/scheduler";
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

  test("a loose Markdown file in intent/ is listed for a person, with how to fix it", async () => {
    const t = tempDir();
    await mk(t.path, "add-numbers", "status: accepted");
    await Bun.write(join(t.path, "intent", "intent.md"), "---\nstatus: accepted\n---\n# Intent: first\n");
    await Bun.write(join(t.path, "intent", "Readme.md"), "guide");
    await Bun.write(join(t.path, "intent", "queue.md"), "queue");
    await Bun.write(join(t.path, "intent", ".gitkeep"), "");
    await Bun.write(join(t.path, "intent", "notes.txt"), "not markdown");
    const scan = await scanRepo(t.path);
    expect(scan.intents.map((i) => i.slug)).toEqual(["add-numbers"]);
    expect(scan.unreadable).toEqual([{
      slug: "intent.md",
      problem: "Move this into a folder named after the change, for example intent/add-numbers/intent.md.",
      detail: "intent/intent.md is not inside a change folder",
    }]);
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

  test("a change with an open question needs a person, and its note starts with the question", async () => {
    const t = tempDir();
    await mk(t.path, "asks", "status: designing\nquestion: open\nnote: Spec in progress.");
    await mk(t.path, "lost", "status: planning\nquestion: open", { "spec.md": "s" });
    await mk(t.path, "busy", "status: designing");
    const md = renderQueue(orderQueue((await scanRepo(t.path)).intents), [], undefined, undefined, new Map([["asks", "Archived too?"]]));
    const section = (name: string) => md.slice(md.indexOf(`## ${name}`)).split("\n## ")[0]!;
    const needs = section("Needs a person");
    expect(needs).toContain("| asks | normal | designing | Has a question: Archived too? Spec in progress. |");
    // Without question.json's text, the note sends a person to conversation.md.
    expect(needs).toContain("| lost | normal | planning | Has a question. Read conversation.md. |");
    expect(section("In progress, in order")).toContain("| busy |");
    expect(needs).not.toContain("| busy |");
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
    await mk(t.path, "commas", "status: accepted\ndepends_on: one, two");
    await mk(t.path, "numbers", "status: accepted\ndepends_on: [42, one]");
    await mk(t.path, "number", "status: accepted\ndepends_on: 7");
    const scan = await scanRepo(t.path);
    expect(scan.unreadable).toEqual([]);
    const by = Object.fromEntries(scan.intents.map((i) => [i.slug, i.file.frontmatter.depends_on]));
    expect(by).toEqual({
      list: ["one", "two"], "block-list": ["one", "two"], single: ["one"], blank: undefined, none: undefined,
      commas: ["one", "two"], numbers: ["42", "one"], number: ["7"],
    });
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
    expect(note("self")).toBe("Waits for itself. Remove self from depends_on.");
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
  test("a change that merged and then blocked or closed at verify no longer holds the ones after it; a change already merged waits for nothing", async () => {
    const t = tempDir();
    const both = { "spec.md": "s", "plan.md": "p" };
    await mk(t.path, "verify-blocked", "status: blocked\nresume_from: merged\nnote: Not done yet.", both);
    await mk(t.path, "verify-closed", "status: closed\nresume_from: merged", both);
    await mk(t.path, "build-blocked", "status: blocked\nresume_from: plan-approved", both);
    await mk(t.path, "after-verify", "status: accepted\ndepends_on: [verify-blocked, verify-closed]");
    await mk(t.path, "after-build", "status: accepted\ndepends_on: [build-blocked]");
    await mk(t.path, "already-merged", "status: merged\ndepends_on: [build-blocked]", both);
    const intents = (await scanRepo(t.path)).intents;
    const by = (slug: string) => intents.find((i) => i.slug === slug)!;
    expect(waitingOn(by("after-verify"), intents)).toEqual([]);
    expect(waitingOn(by("after-build"), intents)).toEqual(["build-blocked"]);
    expect(waitingOn(by("already-merged"), intents)).toEqual([]);
    expect(dependencyNote(by("already-merged"), intents)).toBeNull();
    t.cleanup();
  });
});

describe("same files: a change waits instead of building into a conflict (at every number of changes at a time)", () => {
  /** A plan listing these files, or with no Files that change section (null). */
  const plan = (files: string[] | null) => `# Plan\n\n${files ? `## Files that change\n${files.map((f) => `- ${f}`).join("\n")}\n\n` : ""}## Order of work\n1. x\n`;
  const planned = (files: string[] | null) => ({ "spec.md": "# Spec\n", "plan.md": plan(files) });
  const holdsIn = async (root: string) => sameFileHolds(orderQueue((await scanRepo(root)).intents));
  const rowOf = (md: string, slug: string) => md.split("\n").find((l) => l.startsWith(`| ${slug} |`)) ?? "";

  test("a plan-approved change that lists a file a building change lists waits for it, and the queue says why", async () => {
    const t = tempDir();
    await mk(t.path, "add-numbers", "status: building", planned(["src/math.ts", "src/add.ts (new)"]));
    await mk(t.path, "say-goodbye", "status: plan-approved", planned(["src/greet.ts", "src/math.ts"]));
    await mk(t.path, "elsewhere", "status: plan-approved", planned(["src/other.ts"]));
    const holds = await holdsIn(t.path);
    expect([...holds]).toEqual([["say-goodbye", "add-numbers"]]);
    const md = renderQueue(orderQueue((await scanRepo(t.path)).intents), [], undefined, holds);
    expect(rowOf(md, "say-goodbye")).toContain("Waits for add-numbers to be merged first, because both change the same files.");
    expect(rowOf(md, "elsewhere")).not.toContain("Waits for");
    t.cleanup();
  });

  test("a building change also holds the files its build's reconciled plan added", async () => {
    const t = tempDir();
    await mk(t.path, "add-numbers", "status: building", planned(["src/math.ts"]));
    await mk(t.path, "say-goodbye", "status: plan-approved", planned(["src/greet.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([]);
    // The drift reconcile added src/greet.ts; that plan is kept in the run folder, not in plan.md.
    mkdirSync(join(t.path, ".loopstra", "runs", "add-numbers"), { recursive: true });
    await Bun.write(join(t.path, ".loopstra", "runs", "add-numbers", "plan.reconciled.md"), plan(["src/math.ts", "src/greet.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([["say-goodbye", "add-numbers"]]);
    t.cleanup();
  });

  test("of two plan-approved changes listing one file, the earlier in the queue holds the later", async () => {
    const t = tempDir();
    await mk(t.path, "later", "status: plan-approved\npriority: low", planned(["src/math.ts"]));
    await mk(t.path, "earlier", "status: plan-approved\npriority: high", planned(["./src/math.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([["later", "earlier"]]);
    t.cleanup();
  });

  test("a blocked, closed or merged change, or one waiting on its own depends_on, holds nobody", async () => {
    const t = tempDir();
    await mk(t.path, "stuck", "status: blocked\nresume_from: building\nnote: n", planned(["src/math.ts"]));
    await mk(t.path, "gone", "status: closed", planned(["src/math.ts"]));
    await mk(t.path, "landed", "status: merged", planned(["src/math.ts"]));
    await mk(t.path, "first-of-all", "status: accepted");
    await mk(t.path, "waits-first", "status: plan-approved\npriority: urgent\ndepends_on: [first-of-all]", planned(["src/math.ts"]));
    await mk(t.path, "free", "status: plan-approved", planned(["src/math.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([]);
    t.cleanup();
  });

  test("a held plan-approved change never runs, so it holds no later one; a held building change still holds", async () => {
    const t = tempDir();
    await mk(t.path, "held-first", "status: plan-approved\npriority: high\nopened: 2026-09-01\nhold: waiting for legal", planned(["src/a.ts"]));
    await mk(t.path, "second", "status: plan-approved\npriority: normal\nopened: 2026-09-02", planned(["src/a.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([]);
    await mk(t.path, "held-builder", "status: building\nhold: waiting for legal", planned(["src/a.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([["held-first", "held-builder"], ["second", "held-builder"]]);
    t.cleanup();
  });

  test("a plan with no file list never waits and holds nobody", async () => {
    const t = tempDir();
    await mk(t.path, "unlisted-builder", "status: building", planned(null));
    await mk(t.path, "unlisted", "status: plan-approved\npriority: high", planned(null));
    await mk(t.path, "listed", "status: plan-approved", planned(["src/math.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([]);
    t.cleanup();
  });

  test("a change waiting to merge holds the files too, as its pull request is still open", async () => {
    const t = tempDir();
    await mk(t.path, "add-numbers", "status: merge-review", planned(["src/math.ts"]));
    await mk(t.path, "say-goodbye", "status: plan-approved", planned(["src/math.ts"]));
    expect([...(await holdsIn(t.path))]).toEqual([["say-goodbye", "add-numbers"]]);
    t.cleanup();
  });
});

function held(slug: string, status: string, hold: string): Intent {
  return { slug, dir: "", artifacts: new Set(["intent.md", "spec.md", "plan.md"]), file: parseIntentFile(`---\nstatus: ${status}\nhold: ${JSON.stringify(hold)}\n---\n# Intent: ${slug}\n`) };
}

test("a held change is under Needs a person, and its note says it is held and why", () => {
  const q = renderQueue([held("a", "building", "waiting for legal (John, the dashboard)")]);
  const needs = q.slice(q.indexOf("## Needs a person"), q.indexOf("## Finished"));
  expect(needs).toContain("| a | normal | building and testing | Held: waiting for legal (John, the dashboard). |");
});
