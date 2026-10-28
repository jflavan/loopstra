import { describe, expect, test } from "bun:test";
import { parseRecord, renderRecord, scopeOf, STANDARDS_RECORD } from "../../src/standards-record";

const EXAMPLE = `# Standards decisions for billing-refunds

## Added
- payments: card data passes through the shared lib the patterns miss (J., from the console, 2026-10-28)

## Removed
- architecture: prototype behind a flag, see ADR-14 (M., from the console, 2026-10-28)

## Exceptions approved
- ARCH-1 at the plan: billing keeps reading the legacy orders table until it is migrated (J., from the console, 2026-10-28)
`;

describe("standards record", () => {
  test("the file is called standards.md", () => expect(STANDARDS_RECORD).toBe("standards.md"));

  test("the spec's example parses and renders back unchanged", () => {
    const r = parseRecord(EXAMPLE, new Set(["payments", "architecture"]));
    expect(r.problems).toEqual([]);
    expect(r.added).toEqual([{ name: "payments", note: "card data passes through the shared lib the patterns miss", by: "J.", via: "the console", date: "2026-10-28" }]);
    expect(r.removed[0]?.name).toBe("architecture");
    expect(r.exceptions).toEqual([{ label: "ARCH-1", gate: "plan", reason: "billing keeps reading the legacy orders table until it is migrated", by: "J.", via: "the console", date: "2026-10-28" }]);
    expect(renderRecord("billing-refunds", r)).toBe(EXAMPLE);
    expect(scopeOf(r)).toEqual({ added: ["payments"], removed: ["architecture"] });
  });

  test("CRLF reads the same", () => {
    expect(parseRecord(EXAMPLE.replace(/\n/g, "\r\n")).problems).toEqual([]);
  });

  test("a standard not in known is a problem and is not applied", () => {
    const r = parseRecord(EXAMPLE, new Set(["architecture"]));
    expect(r.problems).toEqual(["standards.md names payments, which is not a standard on main."]);
    expect(r.added).toEqual([]);
    expect(r.removed).toHaveLength(1);
  });

  test("malformed bullets are problems", () => {
    const r = parseRecord("# t\n\n## Added\n- payments no note\n- Bad Name: x (J., from the console, 2026-10-28)\n\n## Exceptions approved\n- ARCH-1: no gate (J., from the console, 2026-10-28)\n\n## Mystery\n- a: b\n");
    expect(r.problems).toHaveLength(4);
    expect(r.problems[0]).toContain("- payments no note");
    expect(r.added).toEqual([]);
  });

  test("a note may hold parentheses", () => {
    const r = parseRecord("## Added\n- payments: see the lib (v2) now (J., from chat, 2026-01-02)\n");
    expect(r.added[0]).toMatchObject({ note: "see the lib (v2) now", by: "J.", via: "chat" });
  });

  test("no file, or no entries, renders null", () => {
    expect(parseRecord(null)).toEqual({ added: [], removed: [], exceptions: [], problems: [] });
    expect(renderRecord("x", parseRecord(null))).toBeNull();
  });

  test("empty sections are left out", () => {
    const out = renderRecord("x", parseRecord("## Removed\n- a: why (M., from a status edit, 2026-10-28)\n"));
    expect(out).toBe("# Standards decisions for x\n\n## Removed\n- a: why (M., from a status edit, 2026-10-28)\n");
  });
});
