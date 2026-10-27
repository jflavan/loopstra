import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { fromMain, mainProjectAt, mergeSettings } from "../../src/main-project";
import { tempGitRepo, write } from "../helpers";

test("mergeSettings joins lists and maps, so both files' hooks, rules and env apply", () => {
  const base = { env: { A: "1" }, permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Bash" }] }, model: "sonnet" };
  const extra = { env: { B: "2" }, permissions: { allow: ["Grep"] }, hooks: { PreToolUse: [{ matcher: "Edit" }], Stop: [] }, model: "opus" };
  expect(mergeSettings(base, extra)).toEqual({
    env: { A: "1", B: "2" }, permissions: { allow: ["Read", "Grep"] },
    hooks: { PreToolUse: [{ matcher: "Bash" }, { matcher: "Edit" }], Stop: [] }, model: "opus",
  });
  expect(base.permissions.allow).toEqual(["Read"]);
});

test("mainProjectAt writes main's project setup from the commit, and nothing else", async () => {
  const repo = await tempGitRepo();
  try {
    const git = new Git(repo.path);
    expect(await mainProjectAt(git, repo.path, await git.headSha())).toBeNull();
    write(join(repo.path, "docs", "CLAUDE.md"), "below the top");
    await git.commitAll("a CLAUDE.md below the top");
    expect(await mainProjectAt(git, repo.path, await git.headSha())).toBeNull();
    write(join(repo.path, "CLAUDE.md"), "top");
    write(join(repo.path, ".claude", "rules", "a.md"), "rule");
    write(join(repo.path, ".claude", "settings.json"), "{ not json");
    write(join(repo.path, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    write(join(repo.path, ".claude", "skills", "s", "SKILL.md"), "s");
    write(join(repo.path, ".claude", "skills", "s", "run.sh"), "#!/bin/sh\n");
    chmodSync(join(repo.path, ".claude", "skills", "s", "run.sh"), 0o755);
    await git.commitAll("main's setup");
    const sha = await git.headSha();
    // A checkout changed since (the step's snapshot, say) is not read.
    write(join(repo.path, "CLAUDE.md"), "rewritten");
    const made = await mainProjectAt(git, repo.path, sha);
    expect(made).not.toBeNull();
    const { project } = made!;
    try {
      expect(project.settings).toEqual({});
      expect(project.mcpServers).toEqual({ a: { command: "x" } });
      expect(readFileSync(join(project.memory, "CLAUDE.md"), "utf8")).toBe("top");
      expect(readFileSync(join(project.memory, ".claude", "rules", "a.md"), "utf8")).toBe("rule");
      expect(existsSync(join(project.memory, ".claude", "settings.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(project.plugin!, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "project" });
      expect(readFileSync(join(project.plugin!, "skills", "s", "SKILL.md"), "utf8")).toBe("s");
      if (process.platform !== "win32") expect(statSync(join(project.plugin!, "skills", "s", "run.sh")).mode & 0o100).toBe(0o100);
    } finally { made!.remove(); }
    expect(existsSync(project.memory)).toBe(false);
  } finally { repo.cleanup(); }
});

test("fromMain without main's setup: only the user's settings, or none with sources: repo", () => {
  expect(fromMain(null, "all", "{}")).toEqual({ run: { settingSources: "user", settings: "{}" }, deny: [], env: {} });
  expect(fromMain(null, "repo", "{}").run.settingSources).toBe("");
});
