import { describe, expect, test } from "bun:test";
import { StreamCollector } from "../../src/claude";

const FIXTURE = await Bun.file(new URL("../fake-claude/fixtures/read-then-structured.jsonl", import.meta.url)).text();

describe("StreamCollector", () => {
  test("collects session id, structured output, cost, and tool uses from a real stream", () => {
    const c = new StreamCollector();
    for (const line of FIXTURE.split("\n")) c.push(line);
    const r = c.finish();
    expect(r.sessionId).toBe("bdfbd999-ad20-46cd-81ad-ab27ff4eee26");
    expect(r.subtype).toBe("success");
    expect(r.structuredOutput).toMatchObject({ status: "fail", priority: "normal" });
    expect(r.costUsd).toBeCloseTo(0.0717593, 5);
    expect(r.toolUses.map((t) => t.name)).toEqual(["Read", "StructuredOutput"]);
    expect(r.events.length).toBe(18);
  });

  test("ignores blank and non-json lines without throwing", () => {
    const c = new StreamCollector();
    c.push("");
    c.push("not json");
    c.push('{"type":"system","subtype":"init","session_id":"s1"}');
    const r = c.finish();
    expect(r.sessionId).toBe("s1");
    expect(r.subtype).toBe("missing_result");
    expect(r.structuredOutput).toBeUndefined();
  });
});
