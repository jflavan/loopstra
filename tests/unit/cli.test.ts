import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "../../src/scheduler";
import { writeStamp } from "../../src/stamp";
import { FAKE_CLAUDE, run, tempDir, tempGitRepo } from "../helpers";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const NOT_SET_UP = "This folder is not set up for Loopstra. Run loopstra init first.";

describe("the command line outside a set-up repo", () => {
  test("status, tail, ui, judges, upgrade, and customize say the folder is not set up, and create nothing", async () => {
    const t = tempDir();
    try {
      for (const cmd of ["status", "tail", "ui", "judges", "upgrade", "customize"]) {
        const r = await run([process.execPath, CLI, cmd], t.path);
        expect({ cmd, code: r.code, said: (r.out + r.err).trim() }).toEqual({ cmd, code: 1, said: NOT_SET_UP });
      }
      expect(readdirSync(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("help lists judges", async () => {
    const t = tempDir();
    try {
      expect((await run([process.execPath, CLI, "help"], t.path)).out).toContain("\n  judges    how often the cheaper judges agreed with the strong ones\n");
    } finally {
      t.cleanup();
    }
  });

  test("--version prints the package version, anywhere", async () => {
    const t = tempDir();
    try {
      for (const flag of ["--version", "-v", "version"]) {
        const r = await run([process.execPath, CLI, flag], t.path);
        expect({ flag, code: r.code, out: r.out }).toEqual({ flag, code: 0, out: "0.0.0-dev\n" });
      }
      expect(readdirSync(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("help lists upgrade, customize and --version", async () => {
    const out = (await run([process.execPath, CLI, "help"], process.cwd())).out;
    expect(out).toContain("\n  upgrade   ");
    expect(out).toContain("\n  customize [prompt]  ");
    expect(out).toContain("\n  --version ");
  });

  test("start refuses the same way, in its preflight", async () => {
    const repo = await tempGitRepo();
    try {
      const env = { ...process.env, LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE };
      expect(await preflight(repo.path, env)).toBe(NOT_SET_UP);
      expect(existsSync(join(repo.path, ".loopstra"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("start, chat and ui refuse a repository set up by an older Loopstra (no stamp) until it is upgraded", async () => {
    const repo = await tempGitRepo();
    try {
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "config.yaml"), "version: 1\ncommands:\n  test: echo ok\n");
      writeFileSync(join(repo.path, "loopstra", "prompts", "orchestrator.md"), "an old copy\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "an older setup"], repo.path);
      const older = "This repository was set up by an older Loopstra. Run loopstra upgrade first, then";
      const env = { ...process.env, LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE };
      expect(await preflight(repo.path, env)).toBe(`${older} run loopstra start again.`);
      for (const cmd of ["chat", "ui"]) {
        const r = await run([process.execPath, CLI, cmd], repo.path);
        expect({ cmd, code: r.code, said: r.err.trim() }).toEqual({ cmd, code: 1, said: `${older} run loopstra ${cmd} again.` });
      }
      // With a stamp, preflight goes on.
      writeStamp(repo.path, { loopstra: "0.0.0-dev", files: {} });
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "upgraded"], repo.path);
      expect(await preflight(repo.path, env)).toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  test("setup --help prints the usage and the sections, and exits 0", async () => {
    const t = tempDir();
    try {
      for (const flag of ["--help", "-h"]) {
        const r = await run([process.execPath, CLI, "setup", flag], t.path);
        expect({ flag, code: r.code }).toEqual({ flag, code: 0 });
        expect(r.out).toStartWith("Usage: loopstra setup [section] [--defaults | --check]\n\nSections:\n  budgets   Budgets\n");
        expect(r.out).toContain("  models    Models\n");
      }
      expect(readdirSync(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("init in a folder that is not a git repository warns and stops", async () => {
    const t = tempDir();
    try {
      const r = await run([process.execPath, CLI, "init"], t.path);
      expect(r.code).toBe(1);
      expect((r.out + r.err).trim()).toBe("warning: This folder is not a git repository; run git init first.");
      expect(readdirSync(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe("the update notice", () => {
  test("status in a repository set up before the stamp says to upgrade, even from a development checkout; with a stamp it says nothing", async () => {
    const repo = await tempGitRepo();
    try {
      const { init } = await import("../../src/init");
      await init(repo.path);
      const quiet = await run([process.execPath, CLI, "status"], repo.path);
      expect(quiet.code).toBe(0);
      expect(quiet.out).not.toContain("loopstra upgrade");
      rmSync(join(repo.path, "loopstra", "stamp.json"));
      const r = await run([process.execPath, CLI, "status"], repo.path);
      expect(r.code).toBe(0);
      expect(r.out.trimEnd().split("\n").at(-1)).toBe("This repository was set up by an older Loopstra: run loopstra upgrade.");
    } finally {
      repo.cleanup();
    }
  });
});
