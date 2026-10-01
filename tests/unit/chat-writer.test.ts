import { describe, expect, test } from "bun:test";
import { draftProblems, renderDraft, writeIntents } from "../../src/chat/writer";
import { loadConfig } from "../../src/config";
import { parseIntentFile, type Status } from "../../src/intents";
import { Trace } from "../../src/trace";
import { chatRepo, draft, INTENT } from "../chat-helpers";

const who = { author: "Ana", via: "Slack" };

describe("renderDraft", () => {
  test("writes a draft the loop can read, with the runtime's frontmatter and the writer's sections", () => {
    const text = renderDraft(draft("csv-export", { priority: "high", depends_on: ["auth", "auth"], title: "Intent: Export CSV" }), { ...who, opened: "2026-10-01" });
    const f = parseIntentFile(text);
    expect(f.frontmatter).toMatchObject({ status: "draft", priority: "high", depends_on: ["auth"], author: "Ana", opened: "2026-10-01" });
    expect(f.frontmatter.note).toContain("Written from a chat with Ana (Slack)");
    expect(f.title).toBe("Export CSV");
    expect(f.sections["Done when"]).toBe("- A CSV downloads from the report page.");
    expect(f.sections.Constraints).toBe("");
  });

  test("quotes an author whose name YAML would misread", () => {
    expect(parseIntentFile(renderDraft(draft("a"), { author: "no: really # yes", via: "x" })).frontmatter.author).toBe("no: really # yes");
  });
});

describe("draftProblems", () => {
  const existing = new Map<string, Status | "unreadable">([["auth", "merged"], ["old-draft", "draft"], ["busy", "building"]]);
  const problems = (ds: ReturnType<typeof draft>[], updates: string[] = []) => draftProblems(ds, ds.map((d) => renderDraft(d, who)), existing, updates);

  test("a good batch has none; depends_on may name an existing change or one in the batch", () => {
    expect(problems([draft("one", { depends_on: ["auth"] }), draft("two", { depends_on: ["one"] })])).toEqual([]);
    expect(problems([draft("old-draft")], ["old-draft"])).toEqual([]);
  });

  test("each kind of problem is named in plain words", () => {
    expect(problems([])).toEqual(["No intents were returned."]);
    expect(problems([draft("Bad Slug")])[0]).toContain('"Bad Slug" is not a valid slug');
    expect(problems([draft("x".repeat(61))])[0]).toContain("at most 60 characters");
    expect(problems([draft("dup"), draft("dup")])).toEqual(['The slug "dup" is used twice.']);
    expect(problems([draft("auth")])).toEqual(['"auth" already exists (merged); choose another slug.']);
    expect(problems([draft("busy")], ["busy"])).toEqual(['"busy" is building, not a draft, so it cannot be changed this way.']);
    expect(problems([draft("a", { depends_on: ["a", "nope"] })])).toEqual(['"a" depends on itself.', '"a" depends on "nope", which is not an existing intent or one you returned.']);
    expect(problems([draft("a", { title: " " })])).toEqual(['"a" has no title.']);
    expect(problems([draft("a", { problem: "", done_when: " " })])).toEqual(['"a": This request is missing a Problem and a Done when section.']);
  });
});

describe("writeIntents", () => {
  test("problems go back to the writer once; a clean second answer is used", async () => {
    const r = await chatRepo({ intents: { auth: INTENT("merged") } });
    try {
      await r.answer("write-intent", 1, { status: "success", summary: "s", intents: [draft("auth")] });
      await r.answer("write-intent", 2, { status: "success", summary: "Adds CSV export.", intents: [draft("csv-export", { depends_on: ["auth"] })] });
      const cfg = await loadConfig(r.root);
      const trace = Trace.open(r.root);
      try {
        const w = await writeIntents({ root: r.root, cfg, trace, source: r.root, handoff: { title: "CSV", brief: "Export CSV.", updates: [] }, author: "Ana", via: "Slack", maxBudgetUsd: 1 });
        expect(w.ok).toBe(true);
        if (!w.ok) return;
        expect(w.intents.map((i) => [i.slug, i.update])).toEqual([["csv-export", false]]);
        expect(w.summary).toBe("Adds CSV export.");
        const [first, second] = r.prompts();
        expect(first!.prompt).toContain("<brief>\nExport CSV.\n</brief>");
        expect(first!.prompt).toContain("- auth: merged");
        expect(first!.prompt).toContain("## Problems with your last answer\n\n(none)");
        expect(second!.prompt).toContain('- "auth" already exists (merged); choose another slug.');
        // The writer runs on the design stage's model, read-only.
        expect(first!.args[first!.args.indexOf("--model") + 1]).toBe("opus");
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });

  test("two bad answers: nothing is written and the problem is said plainly", async () => {
    const r = await chatRepo();
    try {
      await r.answer("write-intent", 1, { status: "success", summary: "s", intents: [] });
      await r.answer("write-intent", 2, { status: "success", summary: "s", intents: [] });
      const trace = Trace.open(r.root);
      try {
        const w = await writeIntents({ root: r.root, cfg: await loadConfig(r.root), trace, source: r.root, handoff: { title: "t", brief: "b", updates: [] }, author: "Ana", via: "x", maxBudgetUsd: 1 });
        expect(w).toMatchObject({ ok: false, problem: "What the writer returned had problems twice: No intents were returned." });
        expect(r.prompts().length).toBe(2);
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });

  test("updates keep the draft's author and date, and only drafts may be updated", async () => {
    const r = await chatRepo({ intents: { "old-draft": "---\nstatus: draft\nauthor: Bo\nopened: 2026-01-02\n---\n# Intent: old\n\n## Problem\nP\n", busy: INTENT("building") } });
    try {
      await r.answer("write-intent", 1, { status: "success", summary: "s", intents: [draft("old-draft")] });
      const trace = Trace.open(r.root);
      const cfg = await loadConfig(r.root);
      try {
        const w = await writeIntents({ root: r.root, cfg, trace, source: r.root, handoff: { title: "t", brief: "b", updates: ["old-draft"] }, author: "Ana", via: "x", maxBudgetUsd: 1 });
        expect(w.ok).toBe(true);
        if (!w.ok) return;
        expect(w.intents[0]!.update).toBe(true);
        expect(parseIntentFile(w.intents[0]!.text).frontmatter).toMatchObject({ author: "Bo", opened: "2026-01-02" });
        expect(r.prompts()[0]!.prompt).toContain("### old-draft\n\n---\nstatus: draft");
        const refused = await writeIntents({ root: r.root, cfg, trace, source: r.root, handoff: { title: "t", brief: "b", updates: ["busy"] }, author: "Ana", via: "x", maxBudgetUsd: 1 });
        expect(refused).toMatchObject({ ok: false, problem: 'Only drafts can be changed this way, and "busy" is not a draft (or does not exist).' });
        expect(r.prompts().length).toBe(1);
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });

  test("a writer that says the brief is too thin is reported", async () => {
    const r = await chatRepo();
    try {
      await r.answer("write-intent", 1, { status: "fail", summary: "The brief does not say what done looks like.", intents: [] });
      const trace = Trace.open(r.root);
      try {
        const w = await writeIntents({ root: r.root, cfg: await loadConfig(r.root), trace, source: r.root, handoff: { title: "t", brief: "b", updates: [] }, author: "Ana", via: "x", maxBudgetUsd: 1 });
        expect(w).toMatchObject({ ok: false, problem: "The brief does not say what done looks like." });
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });
});
