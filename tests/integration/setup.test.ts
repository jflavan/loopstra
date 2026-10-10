import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../../src/config";
import { NEEDS_TERMINAL } from "../../src/setup";
import { ConfigDocument } from "../../src/setup/document";
import { FAKE_CLAUDE, run, tempDir, tempGitRepo } from "../helpers";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

/** The CLI with no terminal: stdin is not a TTY. */
async function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn({ cmd: [process.execPath, CLI, ...args], cwd, env: { ...process.env, LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

/** A repo with a test script, set up by `loopstra init` and committed. */
async function initRepo() {
  const repo = await tempGitRepo();
  await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  const r = await cli(["init"], repo.path);
  expect(r.code).toBe(0);
  // Without a terminal, init names setup in its next steps and asks nothing.
  expect(r.out).toContain("loopstra setup");
  expect(r.out).not.toContain("Walk through the settings now?");
  await run(["git", "add", "-A"], repo.path);
  await run(["git", "commit", "-q", "-m", "loopstra"], repo.path);
  return repo;
}

describe("loopstra setup from the command line", () => {
  test("init, then setup --defaults: no changes, comments kept, no budgets", async () => {
    const repo = await initRepo();
    try {
      const before = readFileSync(configPath(repo.path), "utf8");
      const r = await cli(["setup", "--defaults"], repo.path);
      expect(r.code).toBe(0);
      expect(r.out).toContain("No changes.");
      expect(r.out).toContain("Checks:");
      expect(readFileSync(configPath(repo.path), "utf8")).toBe(before);
      expect(before).toContain("#");
      const cfg = await loadConfig(repo.path);
      expect([cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session]).toEqual([undefined, undefined, undefined, undefined]);
    } finally { repo.cleanup(); }
  });

  test("setup without a terminal or flags refuses and writes nothing", async () => {
    const repo = await initRepo();
    try {
      const before = readFileSync(configPath(repo.path), "utf8");
      const r = await cli(["setup"], repo.path);
      expect(r.code).toBe(1);
      expect(r.out).toContain(NEEDS_TERMINAL);
      expect(readFileSync(configPath(repo.path), "utf8")).toBe(before);
    } finally { repo.cleanup(); }
  });

  test("--check reports a failing test command, a signed-out gh and unset Slack tokens, and exits 1", async () => {
    const repo = await initRepo();
    const remote = tempDir("loopstra-remote-");
    try {
      await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
      await run(["git", "remote", "add", "origin", remote.path], repo.path);
      const doc = ConfigDocument.load(repo.path);
      doc.set(["commands", "test"], "exit 3");
      doc.set(["chat", "transports", "slack", "channel"], "C1");
      doc.save();
      await run(["git", "commit", "-q", "-am", "config"], repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      const r = await cli(["setup", "--check"], repo.path, {
        LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "1", LOOPSTRA_SLACK_APP_TOKEN: "", LOOPSTRA_SLACK_BOT_TOKEN: "",
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("loopstra/config.yaml loads.");
      expect(r.out).toContain("commands.test fails on main (exit 3)");
      expect(r.out).toContain("gh is not signed in");
      expect(r.out).toContain("Slack: LOOPSTRA_SLACK_APP_TOKEN and LOOPSTRA_SLACK_BOT_TOKEN are not set.");
      expect(readFileSync(configPath(repo.path), "utf8")).toBe(before);
    } finally { repo.cleanup(); remote.cleanup(); }
  });

  test("one section by name", async () => {
    const repo = await initRepo();
    try {
      const r = await cli(["setup", "budgets", "--defaults"], repo.path);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Budgets");
      expect(r.out).not.toContain("Commands");
    } finally { repo.cleanup(); }
  });
});
