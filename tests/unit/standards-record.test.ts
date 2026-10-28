import { describe, expect, test } from "bun:test";
import { addedApprovals, approvedRecord, exceptionNote, exceptionsToApprove, parseRecord, renderRecord, revokedRecord, scopeOf, STANDARDS_RECORD, withApprovals } from "../../src/standards-record";

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

describe("exceptions to approve", () => {
  const PLAN = "# Plan\n\n## Standards\n- SEC-1: kept\n- ARCH-1: exception: billing keeps reading the legacy orders table until it is migrated (ADR-12)\n- ARCH-2: does not apply: no reads\n";
  const approvedAt = (reason: string) => parseRecord(`## Exceptions approved\n- ARCH-1 at the spec: ${reason} (J., from the console, 2026-10-28)\n`);

  test("an exception bullet waits unless the record approved the same rule with the same reason, at either gate", () => {
    expect(exceptionsToApprove(PLAN, "plan", parseRecord(null))).toEqual([{ label: "ARCH-1", kind: "exception", text: "billing keeps reading the legacy orders table until it is migrated (ADR-12)" }]);
    expect(exceptionsToApprove(PLAN, "plan", approvedAt("billing keeps reading the legacy orders table until it is migrated (ADR-12)"))).toEqual([]);
    // Reworded: a new exception.
    expect(exceptionsToApprove(PLAN, "plan", approvedAt("billing keeps reading the legacy orders table"))).toHaveLength(1);
    expect(exceptionsToApprove("# Plan\n\nNo section.\n", "plan", parseRecord(null))).toEqual([]);
  });

  test("the note names the rule, its standard and the reason, and says what to set", () => {
    const one = exceptionsToApprove(PLAN, "plan", parseRecord(null));
    expect(exceptionNote("plan", one, new Map([["ARCH-1", "Service architecture"]]))).toBe(
      "The plan asks for an exception to ARCH-1 (Service architecture): billing keeps reading the legacy orders table until it is migrated (ADR-12). Read plan.md. To allow it, set status to plan-approved; to have the plan written again without it, send it back with a note.",
    );
    const two = [...one, { label: "SEC-1", kind: "exception" as const, text: "the debug log stays until the audit." }];
    expect(exceptionNote("spec", two, new Map([["ARCH-1", "Service architecture"], ["SEC-1", "Security"]]))).toBe(
      "The spec asks for exceptions to ARCH-1 (Service architecture): billing keeps reading the legacy orders table until it is migrated (ADR-12); and to SEC-1 (Security): the debug log stays until the audit. Read spec.md. To allow them, set status to spec-approved; to have the spec written again without them, send it back with a note.",
    );
  });

  test("approvals are added to the record once, with who, where, the gate and the date", () => {
    const bullets = exceptionsToApprove(PLAN, "plan", parseRecord(null));
    const r = withApprovals(parseRecord(null), "plan", bullets, { by: "John", via: "the console" }, "2026-10-28");
    expect(r.exceptions).toEqual([{ label: "ARCH-1", gate: "plan", reason: "billing keeps reading the legacy orders table until it is migrated (ADR-12)", by: "John", via: "the console", date: "2026-10-28" }]);
    expect(withApprovals(r, "plan", bullets, { by: "M.", via: "intent.md" }, "2026-10-29").exceptions).toHaveLength(1);
    const text = renderRecord("billing", r)!;
    expect(text).toBe("# Standards decisions for billing\n\n## Exceptions approved\n- ARCH-1 at the plan: billing keeps reading the legacy orders table until it is migrated (ADR-12) (John, from the console, 2026-10-28)\n");
    // A reason ending in parentheses reads back whole.
    expect(parseRecord(text).exceptions[0]?.reason).toBe("billing keeps reading the legacy orders table until it is migrated (ADR-12)");
  });

  test("the record's file with approvals: rendered whole, or added at the end so a person's unreadable lines are kept", () => {
    const bullets = exceptionsToApprove(PLAN, "plan", parseRecord(null));
    const who = { by: "John", via: "Slack" };
    const line = "- ARCH-1 at the plan: billing keeps reading the legacy orders table until it is migrated (ADR-12) (John, from Slack, 2026-10-28)";
    expect(approvedRecord("b", null, "plan", bullets, who, "2026-10-28")).toBe(`# Standards decisions for b\n\n## Exceptions approved\n${line}\n`);
    const added = "# Standards decisions for b\n\n## Added\n- payments: why (J., from the console, 2026-10-27)\n";
    expect(approvedRecord("b", added, "plan", bullets, who, "2026-10-28")).toBe(`${added}\n## Exceptions approved\n${line}\n`);
    const broken = "# Standards decisions for b\n\n## Added\n- payments without a note\n";
    expect(approvedRecord("b", broken, "plan", bullets, who, "2026-10-28")).toBe(`${broken}\n## Exceptions approved\n${line}\n`);
    const brokenUnder = "# Standards decisions for b\n\n## Exceptions approved\n- ARCH-9 somewhere\n";
    expect(approvedRecord("b", brokenUnder, "plan", bullets, who, "2026-10-28")).toBe(`${brokenUnder}${line}\n`);
  });

  test("who and where are written without parentheses, so they read back", () => {
    const bullets = exceptionsToApprove(PLAN, "plan", parseRecord(null));
    const text = approvedRecord("b", null, "plan", bullets, { by: "Ann Lee (she/her)", via: "Slack (eu)" }, "2026-10-28");
    expect(text).toContain("(Ann Lee [she/her], from Slack [eu], 2026-10-28)");
    const back = parseRecord(text);
    expect(back.problems).toEqual([]);
    expect(back.exceptions[0]).toMatchObject({ by: "Ann Lee [she/her]", via: "Slack [eu]", reason: "billing keeps reading the legacy orders table until it is migrated (ADR-12)" });
  });

  test("prose, a ### heading or a wrapped line is a problem, so approving keeps the person's text", () => {
    const text = "# Standards decisions for b\n\nWe agreed this in the review.\n\n## Added\n- payments: why (J., from the console, 2026-10-27)\n  wrapped onto a second line\n### Notes\n";
    expect(parseRecord(text).problems).toHaveLength(3);
    expect(parseRecord(text).problems[0]).toContain("We agreed this in the review.");
    const bullets = exceptionsToApprove(PLAN, "plan", parseRecord(null));
    const out = approvedRecord("b", text, "plan", bullets, { by: "J.", via: "the console" }, "2026-10-28");
    expect(out.startsWith(text)).toBe(true);
    expect(parseRecord(out).exceptions).toHaveLength(1);
    // A record a person left as rendered, with a byte-order mark, still reads.
    expect(parseRecord(`\uFEFF${EXAMPLE}`).problems).toEqual([]);
  });

  test("an approval taken back removes exactly the entries it added", () => {
    const base = parseRecord("## Exceptions approved\n- ARCH-1 at the spec: billing keeps reading the legacy orders table until it is migrated (ADR-12) (M., from a status edit, 2026-10-27)\n");
    const two = [...exceptionsToApprove(PLAN, "plan", parseRecord(null)), { label: "SEC-1", kind: "exception" as const, text: "the debug log stays" }];
    const before = renderRecord("b", base)!;
    const after = approvedRecord("b", before, "plan", two, { by: "J.", via: "the console" }, "2026-10-28");
    const added = addedApprovals(base, parseRecord(after));
    expect(added.map((e) => `${e.label}@${e.gate}`)).toEqual(["SEC-1@plan"]);
    expect(revokedRecord("b", after, added)).toBe(before);
    // Nothing left: no file.
    const only = approvedRecord("b", null, "plan", two, { by: "J.", via: "the console" }, "2026-10-28");
    expect(revokedRecord("b", only, addedApprovals(parseRecord(null), parseRecord(only)))).toBeNull();
    // A record with a line that does not read keeps it; only the taken line goes.
    const broken = `${after}Some prose.\n`;
    expect(revokedRecord("b", broken, added)).toBe(`${before}Some prose.\n`);
  });
});
