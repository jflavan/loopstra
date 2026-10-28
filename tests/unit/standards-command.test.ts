import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderStandardsList } from "../../src/commands/standards";
import { loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { baseAware, checkOnMain, runOnMain } from "../../src/standards-check";
import { run, tempDir, tempGitRepo, writeTestStamp } from "../helpers";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

function standard(o: { title?: string; front?: string; rules?: string } = {}): string {
  const front = o.front ? `---\n${o.front}\n---\n` : "";
  return `${front}# ${o.title ?? "Service architecture"}\n\nWhy.\n\n## Rules\n${o.rules ?? "- ARCH-1: Keep services apart.\n"}`;
}

/** A repository with a config and these standard files committed on main. */
async function repoWith(files: Record<string, string>, config = "") {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra", "standards"), { recursive: true });
  writeFileSync(join(repo.path, "loopstra", "config.yaml"), `version: 1\ncommands:\n  test: echo ok\n${config}`);
  writeTestStamp(repo.path);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo.path, path, ".."), { recursive: true });
    writeFileSync(join(repo.path, path), text);
  }
  await new Git(repo.path).commitAll("standards");
  return repo;
}

describe("loopstra standards", () => {
  test("lists title, file, scope with the count of files on main, needs person, check and labels", async () => {
    const repo = await repoWith({
      "loopstra/standards/architecture.md": standard({ front: 'applies_to: ["services/**", "api/**"]\ncheck: bunx depcruise services', rules: "- ARCH-1: One.\n- ARCH-2: Two.\n" }),
      "loopstra/standards/secrets.md": standard({ title: "Secrets", rules: "- SEC-1: None in code.\n" }),
      "services/a.ts": "", "services/b/c.ts": "", "api/x.ts": "", "other.ts": "",
    });
    try {
      const text = await renderStandardsList(repo.path, await loadConfig(repo.path));
      expect(text).toContain("Service architecture (loopstra/standards/architecture.md)");
      expect(text).toContain("Applies to: services/**, api/** (3 files on main match)");
      expect(text).toContain("Check: bunx depcruise services");
      expect(text).toContain("Rules: ARCH-1, ARCH-2");
      expect(text).toContain("Secrets (loopstra/standards/secrets.md)");
      expect(text).toContain("Applies to: every change");
      expect(text).toContain("Check: none");
      expect(text).toContain("Needs a person: no");
    } finally { repo.cleanup(); }
  });

  test("says a needs_person standard without applies_to makes every change wait, like gates.merge.human: pr", async () => {
    const repo = await repoWith({
      "loopstra/standards/pay.md": standard({ title: "Payments", front: "needs_person: true" }),
      "loopstra/standards/scoped.md": standard({ title: "Scoped", front: 'applies_to: ["billing/**"]\nneeds_person: true', rules: "- SC-1: x.\n" }),
    });
    try {
      const text = await renderStandardsList(repo.path, await loadConfig(repo.path));
      expect(text).toContain("every change waits for a person, like gates.merge.human: pr");
      expect(text.match(/like gates\.merge\.human: pr/g)).toHaveLength(1);
      expect(text).toContain("Needs a person: yes");
    } finally { repo.cleanup(); }
  });

  test("names problems, ignored files and uncommitted edits, and exits 0", async () => {
    const repo = await repoWith({
      "loopstra/standards/good.md": standard(),
      "loopstra/standards/broken.md": "no title here\n",
      "loopstra/standards/notes.txt": "x",
    });
    try {
      writeFileSync(join(repo.path, "loopstra", "standards", "good.md"), standard({ title: "Edited" }));
      const r = await run([process.execPath, CLI, "standards"], repo.path);
      expect(r.code).toBe(0);
      expect(r.out).toContain("loopstra/standards/broken.md cannot be read");
      expect(r.out).toContain("loopstra/standards/notes.txt");
      expect(r.out).toMatch(/ignored/i);
      expect(r.out).toContain("loopstra/standards/good.md");
      expect(r.out).toMatch(/uncommitted/i);
      expect(r.out).toContain("Service architecture"); // read from main, not the edited file
      expect(r.out).not.toContain("Edited (");
    } finally { repo.cleanup(); }
  });

  test("warns when the standards together are over 40 KB", async () => {
    const big = standard({ rules: "- BIG-1: x.\n" }) + "filler ".repeat(7000);
    const repo = await repoWith({ "loopstra/standards/big.md": big });
    try {
      expect(await renderStandardsList(repo.path, await loadConfig(repo.path))).toMatch(/over 40 KB/);
    } finally { repo.cleanup(); }
  });

  test("says so when there are none, and refuses in a folder that is not set up", async () => {
    const repo = await repoWith({});
    const bare = tempDir();
    try {
      expect(await renderStandardsList(repo.path, await loadConfig(repo.path))).toContain("no standards");
      const r = await run([process.execPath, CLI, "standards"], bare.path);
      expect({ code: r.code, said: (r.out + r.err).trim() }).toEqual({ code: 1, said: "This folder is not set up for Loopstra. Run loopstra init first." });
    } finally { repo.cleanup(); bare.cleanup(); }
  });
});

describe("checkOnMain", () => {
  test("runs the command on main with LOOPSTRA_BASE set to main's commit, install first", async () => {
    const repo = await repoWith({}, "  install: echo installed > installed.txt\n");
    try {
      const cfg = await loadConfig(repo.path);
      const sha = (await new Git(repo.path).run(["rev-parse", "main"])).out.trim();
      const ok = await checkOnMain(repo.path, cfg, `test -f installed.txt && test "$LOOPSTRA_BASE" = ${sha}`, "Secrets");
      expect(ok).toMatchObject({ ok: true, code: 0, timedOut: false, missingProgram: null, failsOnMain: null });
      const bad = await checkOnMain(repo.path, cfg, "echo nope; exit 3", "Secrets");
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe(3);
      expect(bad.lastLines).toContain("nope");
      expect(bad.failsOnMain).toBe("The check of Secrets fails on main already, so every change under it would fail it too. Use a form that looks only at what a change adds (with $LOOPSTRA_BASE), or fix main first.");
    } finally { repo.cleanup(); }
  });

  test("main is resolved once: the checkout and LOOPSTRA_BASE are the same commit", async () => {
    const repo = await repoWith({});
    const resolves = spyOn(Git.prototype, "commitOf");
    try {
      const r = await checkOnMain(repo.path, await loadConfig(repo.path), `test "$(git rev-parse HEAD)" = "$LOOPSTRA_BASE"`, "Secrets");
      expect(r.ok).toBe(true);
      expect(resolves.mock.calls.filter(([ref]) => ref === "main")).toHaveLength(1);
    } finally { resolves.mockRestore(); repo.cleanup(); }
  });

  test("runOnMain checks out the commit it is given", async () => {
    const repo = await repoWith({});
    try {
      const git = new Git(repo.path);
      const older = (await git.run(["rev-parse", "main"])).out.trim();
      writeFileSync(join(repo.path, "later.txt"), "x\n");
      await git.commitAll("later");
      const r = await runOnMain(repo.path, await loadConfig(repo.path), { name: "run-on-older", command: `test "$(git rev-parse HEAD)" = ${older}`, what: "check", commit: older });
      expect(r.code).toBe(0);
    } finally { repo.cleanup(); }
  });

  test("a missing program is reported as that, not as failing on main", async () => {
    const repo = await repoWith({});
    try {
      const r = await checkOnMain(repo.path, await loadConfig(repo.path), "no-such-scanner-xyz --go", "Secrets");
      expect(r.ok).toBe(false);
      expect(r.missingProgram).toBe("no-such-scanner-xyz");
      expect(r.failsOnMain).toBeNull();
    } finally { repo.cleanup(); }
  });

  test("an install that fails stops it: the check never runs", async () => {
    const repo = await repoWith({}, "  install: exit 4\n");
    try {
      const r = await checkOnMain(repo.path, await loadConfig(repo.path), "echo ran > ran.txt", "Secrets");
      expect(r).toMatchObject({ ok: false, code: 4, installFailed: true, failsOnMain: null });
    } finally { repo.cleanup(); }
  });
});

describe("baseAware", () => {
  test("suggests the base-aware form for gitleaks and semgrep, and nothing else", () => {
    expect(baseAware("gitleaks detect")).toBe('gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"');
    expect(baseAware("semgrep --config auto .")).toBe('semgrep scan --error --baseline-commit "$LOOPSTRA_BASE"');
    expect(baseAware("bunx depcruise services")).toBeNull();
    expect(baseAware('gitleaks git --log-opts="$LOOPSTRA_BASE..HEAD"')).toBeNull();
  });
});

