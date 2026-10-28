import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { detectCommands, init, uncommittedSetup } from "../../src/init";
import { templatePath } from "../../src/package";
import { readStamp, textSha, writeStamp } from "../../src/stamp";
import { run, tempDir, tempGitRepo } from "../helpers";

describe("init", () => {
  test("stamps a bun repo with detected commands, the managed files and their stamp", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test", lint: "eslint .", build: "tsc", start: "bun run src/main.ts" } }));
      mkdirSync(join(t.path, ".claude"), { recursive: true });
      await Bun.write(join(t.path, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
      await Bun.write(join(t.path, "CLAUDE.md"), "# Project\n\nNotes.\n");
      const report = await init(t.path);
      expect(report.written).toContain("loopstra/config.yaml");
      const cfg = await loadConfig(t.path);
      expect(cfg.commands.test).toBe("bun test");
      expect(cfg.commands.install).toBe("bun install");
      expect(cfg.commands.lint).toBe("bun run lint");
      expect(cfg.commands.build).toBe("bun run build");
      expect(cfg.commands.run).toBe("bun run start");
      expect(cfg.gates.spec).toEqual({ human: "none", agent: true });
      // The template names risky files only in a comment: nothing is risky until a person says so.
      expect(cfg.gates.merge).toEqual({ human: "none", method: "squash", risky: { paths: [], human: "pr" } });
      for (const f of ["intent/README.md", "intent/queue.md", "REVIEW.md", ".claude/skills/loopstra/SKILL.md", "loopstra/stamp.json"]) {
        expect(existsSync(join(t.path, f))).toBe(true);
      }
      // Prompts and the test hook come from the installed package.
      expect(existsSync(join(t.path, "loopstra", "prompts"))).toBe(false);
      expect(existsSync(join(t.path, ".claude", "hooks"))).toBe(false);
      const shipped = (...p: string[]) => ({ base: textSha(readFileSync(templatePath(...p), "utf8")) });
      const stamp = readStamp(t.path)!;
      expect(stamp.loopstra).toMatch(/^0\.0\.0-dev/);
      expect(stamp.files).toEqual({
        ".claude/skills/loopstra/SKILL.md": shipped("skill", "SKILL.md"),
        "intent/README.md": shipped("intent-README.md"),
        "REVIEW.md": shipped("REVIEW.md"),
      });
      // The runtime runs its judges as fresh sessions itself; no subagent files.
      expect(existsSync(join(t.path, ".claude", "agents"))).toBe(false);
      // The workspaces only see what is committed on main.
      expect(report.next[1]).toBe("Commit the files init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore) on main. The loop works in its own checkouts, which only see what is committed.");
      // The repository's own settings are not touched.
      const settings = JSON.parse(await Bun.file(join(t.path, ".claude", "settings.json")).text());
      expect(settings.permissions.allow).toEqual(["Bash(git *)"]);
      expect(settings.hooks.PreToolUse.length).toBe(1);
      const claude = await Bun.file(join(t.path, "CLAUDE.md")).text();
      expect(claude).toContain("## Commands");
      expect(claude).toContain("bun test");
      expect(await Bun.file(join(t.path, ".gitignore")).text()).toContain(".loopstra/");
    } finally { t.cleanup(); }
  });

  test("is idempotent and keeps any file a person has edited", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      await init(t.path);
      await Bun.write(join(t.path, "loopstra", "prompts", "build.md"), "custom");
      await Bun.write(join(t.path, "loopstra", "config.yaml"), "version: 1\ncommands:\n  test: make check\n");
      const claudeBefore = await Bun.file(join(t.path, "CLAUDE.md")).text();
      const gitignoreBefore = await Bun.file(join(t.path, ".gitignore")).text();
      const second = await init(t.path);
      expect(second.written).toEqual([]);
      expect(second.kept).toContain("loopstra/config.yaml");
      expect(await Bun.file(join(t.path, "loopstra", "prompts", "build.md")).text()).toBe("custom");
      expect((await loadConfig(t.path)).commands.test).toBe("make check");
      expect(await Bun.file(join(t.path, "CLAUDE.md")).text()).toBe(claudeBefore);
      expect(await Bun.file(join(t.path, ".gitignore")).text()).toBe(gitignoreBefore);
    } finally { t.cleanup(); }
  });

  test("a kept managed file gets the base of today's shipped text", async () => {
    const repo = await tempGitRepo();
    try {
      writeFileSync(join(repo.path, "REVIEW.md"), "our own review rules\n");
      await init(repo.path);
      const stamp = readStamp(repo.path)!;
      // Not a shipped text: recorded against today's shipped text, so later upgrades merge nothing into it.
      expect(stamp.files["REVIEW.md"]).toEqual({ base: textSha(readFileSync(templatePath("REVIEW.md"), "utf8")) });
      expect(readFileSync(join(repo.path, "REVIEW.md"), "utf8")).toBe("our own review rules\n");
    } finally { repo.cleanup(); }
  });

  test("an existing stamp is kept", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      writeStamp(repo.path, { loopstra: "0.3.0", files: {} });
      const r = await init(repo.path);
      expect(readStamp(repo.path)).toEqual({ loopstra: "0.3.0", files: {} });
      expect(r.kept).toContain("loopstra/stamp.json");
    } finally { repo.cleanup(); }
  });

  test("a repository set up by an older Loopstra gets no stamp, and is pointed to upgrade", async () => {
    const older = "This repository was set up by an older Loopstra: run `loopstra upgrade` to bring it up to date.";
    for (const leftover of ["loopstra/config.yaml", "loopstra/prompts/review.md", ".claude/hooks/loopstra-protect-tests.ts"]) {
      const repo = await tempGitRepo();
      try {
        mkdirSync(join(repo.path, leftover, ".."), { recursive: true });
        writeFileSync(join(repo.path, leftover), leftover.endsWith(".yaml") ? "version: 1\ncommands:\n  test: bun test\n" : "old\n");
        const r = await init(repo.path);
        expect(existsSync(join(repo.path, "loopstra", "stamp.json"))).toBe(false);
        expect(r.written).not.toContain("loopstra/stamp.json");
        expect(r.next[0]).toBe(older);
      } finally { repo.cleanup(); }
    }
    // A fresh repository is not pointed there.
    const fresh = await tempGitRepo();
    try {
      expect((await init(fresh.path)).next).not.toContain(older);
    } finally { fresh.cleanup(); }
  });

  test("uncommittedSetup asks for the config, the stamp and overrides only", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      expect(await uncommittedSetup(repo.path, "main")).toEqual(["loopstra/config.yaml", "loopstra/stamp.json"]);
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "mine");
      expect(await uncommittedSetup(repo.path, "main")).toContain("loopstra/prompts/");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "set up"], repo.path);
      expect(await uncommittedSetup(repo.path, "main")).toEqual([]);
    } finally { repo.cleanup(); }
  });

  test("with no detectable test command, leaves a placeholder that loadConfig rejects", async () => {
    const t = await tempGitRepo();
    try {
      const report = await init(t.path);
      expect(report.warnings.join(" ")).toMatch(/commands\.test/);
      await expect(loadConfig(t.path)).rejects.toThrow(/commands\.test/);
    } finally { t.cleanup(); }
  });

  test("main_branch is the branch the repository is on", async () => {
    const t = await tempGitRepo();
    try {
      await run(["git", "branch", "-m", "master"], t.path);
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      const report = await init(t.path);
      expect(await Bun.file(join(t.path, "loopstra", "config.yaml")).text()).toContain("\nmain_branch: master\n");
      expect((await loadConfig(t.path)).main_branch).toBe("master");
      expect(report.next[1]).toContain(" on master.");
    } finally { t.cleanup(); }
  });

  test("the next steps point to loopstra setup", async () => {
    const repo = await tempGitRepo();
    try {
      const report = await init(repo.path);
      // Setup first, then commit what it saved with the rest, then start.
      expect(report.next[0]).toBe("Walk through the settings with `loopstra setup` (budgets, commands, gates, GitHub, chat, models, agents), or edit loopstra/config.yaml.");
      expect(report.next.join(" ")).not.toContain("gates.*.human");
    } finally { repo.cleanup(); }
  });

  test("a repository with no commits yet gets its unborn branch", async () => {
    const t = tempDir();
    try {
      await run(["git", "init", "-q", "-b", "trunk"], t.path);
      await init(t.path);
      expect(await Bun.file(join(t.path, "loopstra", "config.yaml")).text()).toContain("\nmain_branch: trunk\n");
    } finally { t.cleanup(); }
  });

  test("file names are matched exactly: makefile is detected, claude.md is left alone with a warning", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "makefile"), "test:\n\techo ok\n");
      await Bun.write(join(t.path, "claude.md"), "# Mine\n");
      const report = await init(t.path);
      expect((await loadConfig(t.path)).commands.test).toBe("make test");
      expect(report.kept).toContain("claude.md");
      expect(report.warnings.join(" ")).toContain("There is a claude.md but no CLAUDE.md.");
      expect(readdirSync(t.path)).not.toContain("CLAUDE.md");
      expect(await Bun.file(join(t.path, "claude.md")).text()).toBe("# Mine\n");
    } finally { t.cleanup(); }
  });

  test("a package manager's lock file picks its commands; a uv project runs pytest through uv", async () => {
    const scripts = { test: "vitest", lint: "eslint .", build: "tsc", start: "node ." };
    const detected = async (files: Record<string, string>) => {
      const t = tempDir();
      try {
        for (const [name, text] of Object.entries(files)) await Bun.write(join(t.path, name), text);
        return await detectCommands(t.path);
      } finally { t.cleanup(); }
    };
    const pkg = JSON.stringify({ name: "x", scripts });
    expect(await detected({ "package.json": pkg, "pnpm-lock.yaml": "" })).toEqual({ install: "pnpm install", test: "pnpm test", lint: "pnpm run lint", build: "pnpm run build", run: "pnpm run start" });
    expect(await detected({ "package.json": pkg, "yarn.lock": "" })).toEqual({ install: "yarn install", test: "yarn test", lint: "yarn run lint", build: "yarn run build", run: "yarn run start" });
    expect(await detected({ "package.json": pkg })).toEqual({ install: "npm install", test: "npm test", lint: "npm run lint", build: "npm run build", run: "npm run start" });
    expect(await detected({ "pyproject.toml": "", "uv.lock": "" })).toEqual({ install: "uv sync", test: "uv run pytest" });
    expect(await detected({ "pyproject.toml": "" })).toEqual({ test: "pytest", install: undefined });
  });

  test("a committed prompt whose name is not ASCII counts as committed", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      await init(t.path);
      await Bun.write(join(t.path, "loopstra", "prompts", "révision.md"), "Review it.\n");
      expect(await uncommittedSetup(t.path, "main")).toContain("loopstra/prompts/");
      await run(["git", "add", "-A"], t.path);
      await run(["git", "commit", "-q", "-m", "init"], t.path);
      // git quotes such a name ("loopstra/prompts/r\303\251vision.md") unless asked for NUL-separated names.
      expect(await uncommittedSetup(t.path, "main")).toEqual([]);
    } finally { t.cleanup(); }
  });

  test("only prompt files count: a .DS_Store, an editor's swap file or a subfolder in loopstra/prompts is not uncommitted setup", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      await init(t.path);
      await Bun.write(join(t.path, "loopstra", "prompts", "old", "a.md"), "An old prompt.\n");
      await run(["git", "add", "-A"], t.path);
      await run(["git", "commit", "-q", "-m", "init"], t.path);
      await Bun.write(join(t.path, "loopstra", "prompts", ".DS_Store"), "x");
      await Bun.write(join(t.path, "loopstra", "prompts", ".build.md.swp"), "x");
      expect(await uncommittedSetup(t.path, "main")).toEqual([]);
      await Bun.write(join(t.path, "loopstra", "prompts", "extra.md"), "More.\n");
      expect(await uncommittedSetup(t.path, "main")).toEqual(["loopstra/prompts/"]);
    } finally { t.cleanup(); }
  });

  test("in a folder below the repository's top, refuses, names the top and writes nothing", async () => {
    const t = await tempGitRepo();
    try {
      const sub = join(t.path, "packages", "app");
      mkdirSync(sub, { recursive: true });
      await Bun.write(join(sub, "package.json"), JSON.stringify({ name: "app", scripts: { test: "bun test" } }));
      const top = (await run(["git", "rev-parse", "--show-toplevel"], t.path)).out.trim();
      const report = await init(sub);
      expect(report).toMatchObject({ stopped: true, written: [], kept: [], next: [] });
      expect(report.warnings).toEqual([`This folder is inside the git repository at ${top}. Loopstra works on a whole repository: run loopstra init in ${top}, and set its commands to run in this folder (for example cd packages/app && bun test).`]);
      expect(existsSync(join(sub, "loopstra"))).toBe(false);
    } finally { t.cleanup(); }
  });

  test("a folder below the top whose name has a space is quoted in the command it suggests", async () => {
    const t = await tempGitRepo();
    try {
      const sub = join(t.path, "packages", "my app");
      mkdirSync(sub, { recursive: true });
      await Bun.write(join(sub, "package.json"), JSON.stringify({ name: "app", scripts: { test: "bun test" } }));
      const report = await init(sub);
      expect(report.warnings[0]).toEndWith(`(for example cd "packages/my app" && bun test).`);
    } finally { t.cleanup(); }
  });

  test("in a folder that is not a git repository, warns and writes nothing", async () => {
    const t = tempDir();
    try {
      const report = await init(t.path);
      expect(report).toMatchObject({ stopped: true, written: [], kept: [], next: [], warnings: ["This folder is not a git repository; run git init first."] });
      expect(existsSync(join(t.path, "loopstra"))).toBe(false);
      expect(existsSync(join(t.path, ".loopstra"))).toBe(false);
    } finally { t.cleanup(); }
  });
});
