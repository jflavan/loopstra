import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_PROMPT_VARS, chatTemplate, renderChatPrompt } from "../../src/chat/agents";
import { configPath, loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { chatRepo, turn } from "../chat-helpers";
import { run, tempDir, tempGitRepo } from "../helpers";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PROMPTS = fileURLToPath(new URL("../../templates/prompts/", import.meta.url));

async function configWith(text: string) {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(t.path), `version: 1\ncommands:\n  test: bun test\n${text}`);
  try { return await loadConfig(t.path); } finally { t.cleanup(); }
}

describe("the chat settings", () => {
  test("are optional, with no budgets and no bots", async () => {
    const cfg = await configWith("");
    expect(cfg.chat).toEqual({ model: "default", transports: {} });
  });

  test("bots take ids as strings (numbers too), token variables by name, and defaults for them", async () => {
    const cfg = await configWith([
      "chat:",
      "  transports:",
      "    slack:",
      "      channel: C0123",
      "      allow: [U1, U2]",
      "      acceptors: [U1]",
      "      announce_to: C0123",
      "    discord:",
      "      channel: 1234567890",
      "      acceptors: [42]",
      "",
    ].join("\n"));
    expect(cfg.chat.transports.slack).toEqual({ token_env: "LOOPSTRA_SLACK_APP_TOKEN", bot_token_env: "LOOPSTRA_SLACK_BOT_TOKEN", channel: "C0123", allow: ["U1", "U2"], acceptors: ["U1"], announce_to: "C0123" });
    expect(cfg.chat.transports.discord).toEqual({ token_env: "LOOPSTRA_DISCORD_TOKEN", channel: "1234567890", allow: [], acceptors: ["42"] });
  });

  test("a token itself in the file, an unknown bot, or a missing channel is refused plainly", async () => {
    await expect(configWith("chat:\n  transports:\n    slack:\n      channel: C1\n      token_env: xapp-1-secret\n")).rejects.toThrow("chat.transports.slack.token_env: must be the name of an environment variable");
    await expect(configWith("chat:\n  transports:\n    teams:\n      channel: x\n")).rejects.toThrow("chat.transports: unknown key(s) teams");
    await expect(configWith("chat:\n  transports:\n    discord:\n      allow: []\n")).rejects.toThrow("chat.transports.discord.channel");
  });
});

describe("the chat prompts", () => {
  test("use only chat prompt variables, and every one is used", async () => {
    const texts = await Promise.all(["orchestrator", "write-intent"].map((n) => Bun.file(join(PROMPTS, `${n}.md`)).text()));
    for (const text of texts) for (const m of text.matchAll(/\{\{([a-z_]+)\}\}/g)) expect(CHAT_PROMPT_VARS as readonly string[]).toContain(m[1]!);
    for (const v of CHAT_PROMPT_VARS) expect({ v, used: texts.join("\n").includes(`{{${v}}}`) }).toEqual({ v, used: true });
    expect(renderChatPrompt("{{brief}} {{spec}} {{problems}}", { brief: "B" })).toBe("B {{spec}} (none)");
  });

  test("a repository's own copy wins; one set up before chat existed gets the shipped one", async () => {
    const t = tempDir();
    try {
      expect(await chatTemplate(t.path, "orchestrator")).toContain("You are the orchestrator of Loopstra");
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      await Bun.write(join(t.path, "loopstra", "prompts", "orchestrator.md"), "tuned");
      expect(await chatTemplate(t.path, "orchestrator")).toBe("tuned");
    } finally { t.cleanup(); }
  });

  test("init stamps them with the others", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      expect(readdirSync(join(repo.path, "loopstra", "prompts"))).toEqual(expect.arrayContaining(["orchestrator.md", "write-intent.md"]));
    } finally { repo.cleanup(); }
  });
});

describe("loopstra chat", () => {
  test("outside a set-up repo it says so; help lists it", async () => {
    const t = tempDir();
    try {
      const r = await run([process.execPath, CLI, "chat"], t.path);
      expect(r.code).toBe(1);
      expect(r.err.trim()).toBe("This folder is not set up for Loopstra. Run loopstra init first.");
      expect((await run([process.execPath, CLI, "help"], t.path)).out).toContain("chat      talk to the orchestrator");
    } finally { t.cleanup(); }
  });

  test("in the terminal: answers each line, and ends with the input", async () => {
    const r = await chatRepo();
    try {
      await r.answer("orchestrator", 1, turn("Nothing is running."));
      const proc = Bun.spawn({ cmd: [process.execPath, CLI, "chat"], cwd: r.root, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.write("what's going on?\n");
      proc.stdin.end();
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      expect(out).toContain("Loopstra chat.");
      expect(out).toContain("loopstra> Nothing is running.");
    } finally { r.cleanup(); }
  });

  test("with only bots asked for and none set up, it says there is nowhere to chat", async () => {
    const r = await chatRepo();
    try {
      // Spawned with this process's environment, so the fake claude set up by chatRepo reaches it.
      const proc = Bun.spawn({ cmd: [process.execPath, CLI, "chat", "--no-terminal"], cwd: r.root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(err).toContain("There is nowhere to chat");
    } finally { r.cleanup(); }
  });

  test("without Claude Code installed it says so, once the settings are fine", async () => {
    const r = await chatRepo();
    try {
      // No claude anywhere: no override, and an empty PATH (Windows spells the key Path).
      const env: Record<string, string | undefined> = { ...process.env, LOOPSTRA_CLAUDE_EXECUTABLE: "" };
      for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
      env.PATH = "";
      const proc = Bun.spawn({ cmd: [process.execPath, CLI, "chat"], cwd: r.root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.end();
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(err).toContain("Claude Code is not installed (claude is not on PATH).");
    } finally { r.cleanup(); }
  });

  test("a bot whose token is missing stops it with a plain message", async () => {
    const r = await chatRepo({ config: "chat:\n  transports:\n    discord:\n      token_env: LOOPSTRA_TEST_NO_SUCH_TOKEN\n      channel: \"1\"\n" });
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, CLI, "chat", "--no-terminal"], cwd: r.root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(err).toContain("Discord needs its bot token in the environment variable LOOPSTRA_TEST_NO_SUCH_TOKEN.");
    } finally { r.cleanup(); }
  });
});

describe("platform ids (review fix)", () => {
  test("a long numeric id must be quoted, since YAML would round it", async () => {
    await expect(configWith("chat:\n  transports:\n    discord:\n      channel: \"1\"\n      acceptors: [123456789012345678]\n")).rejects.toThrow("is too long to be read as a number: put it in quotes");
    expect((await configWith("chat:\n  transports:\n    discord:\n      channel: \"1\"\n      acceptors: [\"123456789012345678\"]\n")).chat.transports.discord!.acceptors).toEqual(["123456789012345678"]);
  });
});
