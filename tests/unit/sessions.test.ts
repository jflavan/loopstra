import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { runChatAgent } from "../../src/chat/agents";
import { configPath, loadConfig } from "../../src/config";
import { andList } from "../../src/text";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE, tempGitRepo, withEnv } from "../helpers";

const FIXTURES = join(import.meta.dir, "..", "fake-claude", "fixtures");

describe("one session runner for the loop and chat", () => {
  test("chat's sessions record the commands they were refused, even when their report cannot be read", async () => {
    const repo = await tempGitRepo();
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
    const cfg = await loadConfig(repo.path);
    const trace = Trace.open(repo.path);
    try {
      await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, LOOPSTRA_FAKE_FIXTURE: join(FIXTURES, "denied.jsonl") }, async () => {
        const r = await runChatAgent({ root: repo.path, cfg, trace, name: "orchestrator", prompt: "hello", schema: z.object({ reply: z.string() }), model: "cheap", capUsd: 1 });
        expect(r).toMatchObject({ ok: false, reason: "invalid-envelope" });
        const row = trace.phases("_chat")[0]!;
        expect(row.status).toBe("fail");
        expect(row.error).toContain("not allowed: Bash(git tag v1)");
        expect(trace.deniedCommands("_chat").get(row.seq)).toEqual(["Bash(git tag v1)", "Write(/repo/notes.txt)"]);
      });
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("andList", () => {
  test("joins items as a plain list", () => {
    expect(andList([])).toBe("");
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});
