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

describe("the models a session ran on", () => {
  test("the init event's model first, then the result's modelUsage keys, without duplicates", () => {
    const c = new StreamCollector();
    c.push('{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5-5"}');
    c.push('{"type":"result","subtype":"success","session_id":"s1","modelUsage":{"claude-opus-5-5":{"costUSD":1},"claude-haiku-5-5":{"costUSD":0.1}}}');
    expect(c.finish().models).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  test("a value that is not a string is left out", () => {
    const c = new StreamCollector();
    c.push('{"type":"system","subtype":"init","session_id":"s1","model":7}');
    c.push('{"type":"result","subtype":"success","session_id":"s1","modelUsage":[1,2]}');
    expect(c.finish().models).toEqual([]);
  });
});

describe("StreamCollector with lines that are JSON but not events", () => {
  test("ignores null, numbers, strings, arrays and objects without a type", () => {
    const c = new StreamCollector();
    for (const line of ["null", "123", '"text"', "[1,2]", "true", '{"session_id":"s9"}', '{"type":7}']) expect(c.push(line)).toBeNull();
    c.push('{"type":"system","subtype":"init","session_id":"s1"}');
    c.push('{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":0.5,"structured_output":{"ok":1}}');
    const r = c.finish();
    expect(r.events.length).toBe(2);
    expect(r.sessionId).toBe("s1");
    expect(r.subtype).toBe("success");
    expect(r.costUsd).toBe(0.5);
  });
});
