// Property-based tests (fuzzing) for the parsers that read text a person or an agent wrote: each
// runs on many generated inputs, and fast-check shrinks a failure to its smallest case.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { nextVersion } from "../../scripts/release";
import { parsePlanFiles } from "../../src/checks";
import { parseArgs } from "../../src/commands/args";
import { parseIntentFile, PRIORITIES, serializeIntentFile, STATUSES } from "../../src/intents";
import { parseStandard, RULE_LABEL } from "../../src/standards";
import { diffCounts, parseDiff } from "../../src/ui/diff";
import { parseRoute, routePath, TABS, type Route } from "../../src/ui/router";

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
/** A line of any text: every code point but line breaks. */
const line = fc.string({ unit: "binary" }).map((s) => s.replace(/[\r\n]/g, ""));

describe("intent.md", () => {
  test("what serializeIntentFile writes, parseIntentFile reads back as it was", () => {
    const frontmatter = fc.record({
      status: fc.constantFrom(...STATUSES),
      priority: fc.option(fc.constantFrom(...PRIORITIES), { nil: undefined }),
      author: fc.string({ unit: "binary" }),
      opened: fc.string({ unit: "binary" }),
      note: fc.string({ unit: "binary" }),
      depends_on: fc.option(fc.uniqueArray(slug, { minLength: 1, maxLength: 3 }), { nil: undefined }),
      resume_from: fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
      hold: fc.string({ unit: "binary" }),
      question: fc.constantFrom("", "open"),
    });
    // The writer drops one blank line after the fence, so a body never starts with one.
    const body = fc.array(line, { maxLength: 8 }).map((lines) => lines.join("\n").replace(/^\n+/, ""));
    fc.assert(fc.property(frontmatter, body, (fm, text) => {
      const read = parseIntentFile(serializeIntentFile({ frontmatter: fm, title: "", body: text, sections: {} }));
      expect(read.frontmatter).toEqual(fm);
      expect(read.body).toBe(text);
    }));
  });
});

describe("a plan's Files that change", () => {
  test("any text: no throw, null only without the heading, and every path in one spelling", () => {
    fc.assert(fc.property(fc.array(fc.oneof(line, fc.constantFrom("## Files that change", "## Next", "- `a\\b.ts`", "- ./x.ts (new)")), { maxLength: 12 }), (lines) => {
      const files = parsePlanFiles(lines.join("\n"));
      expect(files === null).toBe(!lines.some((l) => /^##\s+files that change\b/i.test(l)));
      for (const f of files ?? []) {
        expect(f.path).not.toBe("");
        expect(f.path).not.toContain("\\");
        expect(f.path.startsWith("./")).toBe(false);
      }
    }));
  });

  test("the bullets of a written plan are read back, (new) marks included", () => {
    const path = fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,8}(\.[a-z]{1,4})?$/), { minLength: 1, maxLength: 4 }).map((p) => p.join("/"));
    const entry = fc.record({ path, new: fc.boolean(), says: fc.option(fc.stringMatching(/^[a-z ]{1,20}$/), { nil: undefined }) });
    fc.assert(fc.property(fc.array(entry, { maxLength: 6 }), (entries) => {
      const bullets = entries.map((e) => `- \`${e.path}\`${e.new ? " (new)" : ""}${e.says ? `: ${e.says}` : ""}`);
      const plan = ["# Plan", "", "## Files that change", ...bullets, "", "## Steps", "- `not/a/file.ts`"].join("\n");
      expect(parsePlanFiles(plan)).toEqual(entries.map((e) => ({ path: e.path, new: e.new })));
    }));
  });
});

describe("a diff", () => {
  test("any text: no throw", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (text) => {
      expect(Array.isArray(parseDiff(text))).toBe(true);
    }));
  });

  test("a file's hunks are counted line by line", () => {
    // A removed line whose text starts with "-- " followed by an added one starting with "++ " reads
    // as a file header (parseDiff's documented rule), so the generated lines do not start with + or -.
    const text = line.map((s) => s.replace(/^[+-]+/, ""));
    const change = fc.tuple(fc.constantFrom("+", "-", " "), text);
    fc.assert(fc.property(slug, fc.array(change, { minLength: 1, maxLength: 20 }), (name, changes) => {
      const diff = [`diff --git a/${name} b/${name}`, "index 1111111..2222222 100644", `--- a/${name}`, `+++ b/${name}`, "@@ -1 +1 @@", ...changes.map(([k, t]) => k + t)].join("\n");
      expect(diffCounts(diff)).toEqual({ added: changes.filter(([k]) => k === "+").length, removed: changes.filter(([k]) => k === "-").length });
      expect(parseDiff(diff)[0]).toEqual({ kind: "file", text: name });
    }));
  });
});

describe("a command's words", () => {
  const spec = { usage: "Usage: test", flags: ["--once", "--json", "--force"], port: true, names: 2 };

  test("words that fit are sorted back out, in any order", () => {
    const groups = fc.record({
      flags: fc.subarray(spec.flags),
      port: fc.option(fc.tuple(fc.integer({ min: 0, max: 65535 }), fc.boolean()), { nil: undefined }),
      names: fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,10}$/), { maxLength: 2 }),
    }).chain((g) => {
      const words: string[][] = [...g.flags.map((f) => [f]), ...g.names.map((n) => [n])];
      if (g.port) words.push(g.port[1] ? ["--port", String(g.port[0])] : [`--port=${g.port[0]}`]);
      return fc.shuffledSubarray(words, { minLength: words.length }).map((order) => ({ g, order }));
    });
    fc.assert(fc.property(groups, ({ g, order }) => {
      const args = parseArgs(order.flat(), spec);
      expect(args).not.toBeNull();
      expect([...args!.flags].sort()).toEqual([...g.flags].sort());
      expect(args!.port).toBe(g.port ? g.port[0] : null);
      expect(args!.names).toEqual(order.filter((w) => w.length === 1 && !w[0]!.startsWith("-")).map((w) => w[0]!));
    }));
  });

  test("any words: no throw, and nothing outside the spec is let through", () => {
    const word = fc.oneof(fc.string(), fc.constantFrom(...spec.flags, "--port", "--port=", "--port=70000", "-p", "--onec"));
    fc.assert(fc.property(fc.array(word, { maxLength: 8 }), (words) => {
      const args = parseArgs(words, spec);
      if (!args) return;
      for (const f of args.flags) expect(spec.flags).toContain(f);
      expect(args.names.length).toBeLessThanOrEqual(spec.names);
      if (args.port !== null) expect(Number.isInteger(args.port) && args.port >= 0 && args.port <= 65535).toBe(true);
    }));
  });
});

describe("the next release's version", () => {
  test("always the next patch or the next minor, as the commits or the bump say", () => {
    const commit = fc.record({ subject: fc.oneof(fc.string(), fc.constantFrom("fix: x", "feat(ui)!: y", "chore: z")), body: fc.oneof(fc.string(), fc.constant("BREAKING CHANGE: w")) });
    const part = fc.nat({ max: 999 });
    fc.assert(fc.property(part, part, part, fc.array(commit, { maxLength: 5 }), fc.option(fc.constantFrom("patch" as const, "minor" as const), { nil: undefined }), (major, minor, patch, commits, bump) => {
      const next = nextVersion(`${major}.${minor}.${patch}`, commits, bump);
      const patchUp = `${major}.${minor}.${patch + 1}`;
      const minorUp = `${major}.${minor + 1}.0`;
      expect([patchUp, minorUp]).toContain(next);
      if (bump) expect(next).toBe(bump === "patch" ? patchUp : minorUp);
    }));
  });
});

describe("the console's addresses", () => {
  const route: fc.Arbitrary<Route> = fc.oneof(
    fc.constantFrom<Route>({ name: "live" }, { name: "inbox" }, { name: "changes" }, { name: "activity" }, { name: "agents" }, { name: "spend" }),
    fc.record({ name: fc.constant("change" as const), slug, tab: fc.constantFrom(...TABS) }),
    fc.record({ name: fc.constant("session" as const), slug: fc.oneof(slug, slug.map((s) => `_${s}`)), seq: fc.nat() }),
  );

  test("a page's address leads back to that page", () => {
    fc.assert(fc.property(route, (r) => {
      expect(parseRoute(routePath(r))).toEqual(r);
    }));
  });

  test("any address: no throw, and the page it names has that address", () => {
    const part = fc.oneof(fc.string(), fc.constantFrom("c", "s", "inbox", "agents", "code", "%", "%E0%A4%A", "_x", "12"));
    fc.assert(fc.property(fc.array(part, { maxLength: 4 }), (parts) => {
      const r = parseRoute(`/${parts.join("/")}`);
      expect(parseRoute(routePath(r))).toEqual(r);
    }));
  });
});

describe("standard files", () => {
  test("rules rendered as a list parse back to the same labels and texts", () => {
    const label = fc.stringMatching(/^[A-Z]([A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/);
    const text = fc.stringMatching(/^[A-Za-z0-9]([A-Za-z0-9 ,.;()-]{0,40}[A-Za-z0-9.])?$/);
    fc.assert(fc.property(
      fc.uniqueArray(fc.record({ label, text }), { minLength: 1, maxLength: 6, selector: (r) => r.label }),
      (rules) => {
        expect(rules.every((r) => RULE_LABEL.test(r.label))).toBe(true);
        const file = `# Title\n\nContext.\n\n## Rules\n${rules.map((r) => `- ${r.label}: ${r.text}`).join("\n")}\n`;
        const parsed = parseStandard("x", file);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.standard.rules.map(({ label, text }) => ({ label, text }))).toEqual(rules);
      },
    ));
  });
});
