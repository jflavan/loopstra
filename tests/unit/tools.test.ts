import { describe, expect, test } from "bun:test";
import { summarize } from "../../src/phases";
import { nowText, relativePath, toolTarget } from "../../src/tools";

describe("tool calls in a few words", () => {
  test("a tool call's target: the command's first line, the file, the pattern", () => {
    expect(toolTarget("Bash", { command: "bun test\nmore" })).toBe("bun test");
    expect(toolTarget("Bash", { command: "\n  bun test\n" })).toBe("bun test");
    expect(toolTarget("Edit", { file_path: "C:\\repo\\wt\\src\\a.ts" }, "C:\\repo\\wt")).toBe("src/a.ts");
    expect(toolTarget("Read", { file_path: "/home/x/wt/README.md" }, "/home/x/wt/")).toBe("README.md");
    expect(toolTarget("Read", { file_path: "/elsewhere/a.md" }, "/home/x/wt")).toBe("/elsewhere/a.md");
    expect(toolTarget("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolTarget("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(toolTarget("Mystery", { x: 1 })).toBe("");
    expect(toolTarget("Bash", null)).toBe("");
    expect(toolTarget("Bash", { command: "x".repeat(200) })).toHaveLength(120);
    expect(relativePath("", "/wt")).toBe("");
  });

  test("what a session is doing, in words", () => {
    expect(nowText("Bash", "bun test")).toBe("Running bun test");
    expect(nowText("Edit", "src/a.ts")).toBe("Editing src/a.ts");
    expect(nowText("TodoWrite", "")).toBe("Updating its todo list");
    expect(nowText("Frobnicate", "")).toBe("Using Frobnicate");
  });

  test("the trace's session summary keeps each tool's target and the session's model", () => {
    expect(summarize({ type: "assistant", message: { content: [
      { type: "text", text: "Looking" },
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
      { type: "thinking" },
    ] } }, "/wt")).toEqual({ type: "assistant", items: ["text:Looking", "tool:Bash", "thinking"], targets: ["", "bun test", ""] });
    expect(summarize({ type: "system", subtype: "init", model: "claude-sonnet-5-5", cwd: "/wt" })).toEqual({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
    expect(summarize({ type: "result", subtype: "success", total_cost_usd: 0.2 })).toEqual({ type: "result", subtype: "success", cost: 0.2 });
  });
});
