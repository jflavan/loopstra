import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, tempDir, tempGitRepo } from "../helpers";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Runs a command with an environment, without blocking this process (the fake registry answers from it). */
async function exec(cmd: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/**
 * Packs the checkout as version `v` (in a copy, so package.json is untouched) with a shipped.json;
 * returns the tarball. The copy holds what package.json's `files` names, so the test ships what npm would.
 */
async function pack(dir: string, v: string): Promise<string> {
  const copy = join(dir, `pkg-${v}`);
  const files = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }).files;
  for (const p of ["package.json", ...files]) if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  pkg.version = v;
  writeFileSync(join(copy, "package.json"), JSON.stringify(pkg, null, 2));
  // shipped.json comes from the checkout's history, as in the release workflow.
  expect((await run([process.execPath, join(ROOT, "scripts", "shipped.ts"), join(copy, "shipped.json")], ROOT)).code).toBe(0);
  const out = join(dir, `out-${v}`);
  mkdirSync(out);
  const r = await run([process.execPath, "pm", "pack", "--destination", out], copy);
  expect(r.code).toBe(0);
  const tgz = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  expect(tgz).toHaveLength(1);
  return join(out, tgz[0]!);
}

/** The stamp's version in the repository. */
const stampOf = (repo: string): string => JSON.parse(readFileSync(join(repo, "loopstra", "stamp.json"), "utf8")).loopstra;

describe("upgrade end to end", () => {
  test("the packed package upgrades a repository set up the old way in one commit, then upgrades itself", async () => {
    const work = tempDir("loopstra-e2e-");
    const repo = await tempGitRepo();
    try {
      // Installed into a global folder of its own, never the real one.
      const tgz = await pack(work.path, "0.9.0");
      const bunHome = join(work.path, "bun");
      const env: Record<string, string | undefined> = { ...process.env, BUN_INSTALL: bunHome };
      // Nothing inherited may point the install, or Loopstra, anywhere else.
      for (const k of Object.keys(env)) if (k.startsWith("LOOPSTRA_") || k === "BUN_INSTALL_BIN" || k === "BUN_INSTALL_GLOBAL_DIR") delete env[k];
      const add = await exec([process.execPath, "add", "-g", tgz], work.path, env);
      expect({ code: add.code, err: add.code ? add.err : "" }).toEqual({ code: 0, err: "" });
      const bin = join(bunHome, "bin", process.platform === "win32" ? "loopstra.exe" : "loopstra");
      expect(existsSync(bin)).toBe(true);

      // The old layout: every prompt copied, the hook and its settings entry. The copies are the
      // committed prompts, the ones shipped.json knows, even while the working tree has edits.
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      const prompts = (await run(["git", "ls-tree", "--name-only", "HEAD", "templates/prompts/"], ROOT)).out.split("\n").map((l) => l.trim()).filter(Boolean);
      expect(prompts.length).toBeGreaterThan(0);
      for (const path of prompts) {
        const shown = await run(["git", "show", `HEAD:${path}`], ROOT);
        expect(shown.code).toBe(0);
        writeFileSync(join(repo.path, "loopstra", "prompts", basename(path)), shown.out);
      }
      // The fixed files the old init wrote too, as committed: a repository without one is taken to have removed it on purpose (see adoptLegacy).
      for (const [template, path] of [["templates/skill/SKILL.md", ".claude/skills/loopstra/SKILL.md"], ["templates/intent-README.md", "intent/README.md"], ["templates/REVIEW.md", "REVIEW.md"]] as const) {
        const shown = await run(["git", "show", `HEAD:${template}`], ROOT);
        expect(shown.code).toBe(0);
        mkdirSync(dirname(join(repo.path, path)), { recursive: true });
        writeFileSync(join(repo.path, path), shown.out);
      }
      const config = readFileSync(join(ROOT, "templates", "config.yaml"), "utf8").replace("__MAIN_BRANCH__", "main").replace("__COMMANDS__", '  test: "bun test"');
      writeFileSync(join(repo.path, "loopstra", "config.yaml"), config);
      mkdirSync(join(repo.path, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(repo.path, ".claude", "hooks", "loopstra-protect-tests.ts"), "// old hook\n");
      writeFileSync(join(repo.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/loopstra-protect-tests.ts"' }] }] } }));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "old layout"], repo.path);

      const up = await exec([bin, "upgrade", "--repo"], repo.path, env);
      expect({ code: up.code, err: up.err }).toEqual({ code: 0, err: "" });
      expect(existsSync(join(repo.path, "loopstra", "prompts"))).toBe(false);
      expect(existsSync(join(repo.path, ".claude", "hooks", "loopstra-protect-tests.ts"))).toBe(false);
      expect(existsSync(join(repo.path, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(repo.path, "REVIEW.md"))).toBe(true);
      expect(stampOf(repo.path)).toBe("0.9.0");
      expect((await run(["git", "log", "-1", "--format=%s"], repo.path)).out.trim()).toBe("loopstra: upgrade to 0.9.0");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");

      // The packed version reports itself, and the tool step installs a newer one from a fake registry
      // and hands the repository step to it.
      expect((await exec([bin, "--version"], repo.path, env)).out.trim()).toBe("0.9.0");
      const newer = await pack(work.path, "0.9.1");
      const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/loopstra/latest" ? Response.json({ version: "0.9.1" }) : Response.json([])) });
      try {
        const url = `http://localhost:${server.port}`;
        const env2 = { ...env, LOOPSTRA_REGISTRY_URL: url, LOOPSTRA_GITHUB_API: url, LOOPSTRA_INSTALL_COMMAND: JSON.stringify([process.execPath, "add", "-g", newer]) };
        const up2 = await exec([bin, "upgrade"], repo.path, env2);
        expect({ code: up2.code, err: up2.code ? `${up2.out}\n${up2.err}` : "" }).toEqual({ code: 0, err: "" });
        expect(up2.out).toContain("Installing Loopstra 0.9.1 (you have 0.9.0).");
        // Only the newly installed 0.9.1 stamps 0.9.1: the hand-off ran the new version.
        expect(stampOf(repo.path)).toBe("0.9.1");
        expect((await run(["git", "log", "-1", "--format=%s"], repo.path)).out.trim()).toBe("loopstra: upgrade to 0.9.1 (from 0.9.0)");
        expect((await exec([bin, "--version"], repo.path, env)).out.trim()).toBe("0.9.1");
      } finally {
        await server.stop(true);
      }

      // The installed package serves the console: Bun bundles its page from src/ui, with the JSX
      // settings in the package's tsconfig.json (without them the page comes back empty).
      const installed = join(bunHome, "install", "global", "node_modules", "loopstra", "src", "cli.ts");
      const ui = Bun.spawn({ cmd: [process.execPath, installed, "ui", "--port", "0", "--no-chat"], cwd: repo.path, env, stdout: "pipe", stderr: "pipe" });
      try {
        const reader = ui.stdout.getReader();
        let said = "";
        let address: string | undefined;
        while (!address) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`loopstra ui ended: ${said}${await new Response(ui.stderr).text()}`);
          said += new TextDecoder().decode(value);
          address = /http:\/\/127\.0\.0\.1:\d+/.exec(said)?.[0];
        }
        const page = await (await fetch(`${address}/`)).text();
        const script = /<script[^>]*src="([^"]+)"/.exec(page)?.[1];
        expect(script).toBeDefined();
        const bundle = await fetch(`${address}${script}`);
        expect(bundle.status).toBe(200);
        expect((await bundle.text()).length).toBeGreaterThan(10_000);
      } finally {
        ui.kill();
        await ui.exited;
      }
    } finally {
      repo.cleanup();
      work.cleanup();
    }
  }, 300_000);
});
