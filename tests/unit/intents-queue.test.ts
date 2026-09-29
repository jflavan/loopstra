import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkConsistency, isRunnable, orderQueue, plainStatus, readIntent, renderQueue, scanIntents, writeIntent,
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
    const intents = await scanIntents(t.path);
    expect(intents.map((i) => i.slug).sort()).toEqual(["a-thing", "b-thing"]);
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
    const ordered = orderQueue(await scanIntents(t.path)).map((i) => i.slug);
    expect(ordered).toEqual([
      "m-building", "k-approved", "z-accepted-urgent", "a-accepted-normal-old", "b-accepted-normal-old", "done-one",
    ]);
    t.cleanup();
  });

  test("merge-approved is a known status with plain wording and needs the spec and plan", async () => {
    const t = tempDir();
    await mk(t.path, "approved", "status: merge-approved", { "spec.md": "s" });
    const [i] = await scanIntents(t.path);
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
    for (const i of await scanIntents(t.path)) expect(checkConsistency(i)).toBeNull();
    t.cleanup();
  });

  test("consistency requires artifacts implied by status", async () => {
    const t = tempDir();
    await mk(t.path, "no-spec", "status: spec-review");
    const [i] = await scanIntents(t.path);
    expect(checkConsistency(i!)).toMatch(/spec\.md/);
    await mk(t.path, "has-spec", "status: spec-review", { "spec.md": "# Spec" });
    const ok = (await scanIntents(t.path)).find((x) => x.slug === "has-spec")!;
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
    const [i] = await scanIntents(t.path);
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
    const md = renderQueue(orderQueue(await scanIntents(t.path)));
    expect(md).toContain("| active |");
    expect(md).toContain("Need an answer about adjusters.");
    expect(md).toContain("finished");
    expect(md.startsWith("# Queue")).toBe(true);
    t.cleanup();
  });

  test("renderQueue collapses a multi-line note into a single table row", async () => {
    const t = tempDir();
    await mk(t.path, "stuck", "status: blocked\nnote: |\n  Need an answer about adjusters.\n  Waiting since Monday.");
    const md = renderQueue(orderQueue(await scanIntents(t.path)));
    const row = md.split("\n").find((l) => l.startsWith("| stuck |"));
    expect(row).toBeDefined();
    expect(row).toContain("Need an answer about adjusters. Waiting since Monday.");
    expect(row?.split("\n").length ?? 0).toBe(1);
    t.cleanup();
  });
});
