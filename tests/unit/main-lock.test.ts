import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { MainCheckoutMoved, setStatus, StepContext, writeArtifact } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { syncMain } from "../../src/remote";
import { Trace } from "../../src/trace";
import { run, tempDir, tempGitRepo } from "../helpers";

/**
 * The main lock: changes running side by side write their records on main at the same time, and
 * main stays correct. The sync test fails without the setStatus and syncMain sections: the sync finds
 * a status written but not yet committed and waits, or a status write finds main half rebased.
 */

const INTENT = (status: string) => `---\nstatus: ${status}\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`;

/** A repo with `n` accepted changes c0..c(n-1), and a tracked queue.md left with an unsaved edit. */
async function repoWith(n: number) {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  for (let i = 0; i < n; i++) {
    mkdirSync(join(repo.path, "intent", `c${i}`), { recursive: true });
    await Bun.write(join(repo.path, "intent", `c${i}`, "intent.md"), INTENT("accepted"));
  }
  await Bun.write(join(repo.path, "intent", "queue.md"), "# Queue\n");
  await new Git(repo.path).commitAll("changes");
  await Bun.write(join(repo.path, "intent", "queue.md"), "# Queue\n\nnewer\n");
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const ctx = async (i: number) => new StepContext(repo.path, cfg, trace, await readIntent(repo.path, `c${i}`));
  return { root: repo.path, cfg, trace, ctx, cleanup: () => { trace.close(); repo.cleanup(); } };
}

/** The files each commit since `base` changed, oldest first. */
async function commitsSince(root: string, base: string): Promise<Array<{ subject: string; files: string[] }>> {
  const log = await run(["git", "log", "--reverse", "--format=%x00%s", "--name-only", `${base}..main`], root);
  return log.out.split("\0").slice(1).map((chunk) => {
    const [subject, ...rest] = chunk.split(/\r?\n/);
    return { subject: subject!, files: rest.map((l) => l.trim()).filter(Boolean) };
  });
}

/** `git status --porcelain` lines, apart from the generated queue. */
async function unsaved(root: string): Promise<string[]> {
  return (await run(["git", "status", "--porcelain"], root)).out.split(/\r?\n/).filter((l) => l.trim() && !l.endsWith("intent/queue.md"));
}

describe("main-lock sections", () => {
  test("20 changes write a status and an artifact at once: every commit lands, holding only its own records", async () => {
    const s = await repoWith(20);
    try {
      const base = (await run(["git", "rev-parse", "HEAD"], s.root)).out.trim();
      const ctxs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.ctx(i)));
      const settled = await Promise.allSettled(ctxs.map(async (ctx) => {
        await setStatus(ctx, "designing");
        await writeArtifact(ctx, "spec.md", `# Spec for ${ctx.slug}\n`);
      }));
      const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String(r.reason));
      expect(failed).toEqual([]);

      expect(await unsaved(s.root)).toEqual([]);
      const commits = await commitsSince(s.root, base);
      expect(commits).toHaveLength(40);
      for (const c of commits) {
        const slug = /^loopstra\((c\d+)\)/.exec(c.subject)?.[1];
        expect(slug).toBeDefined();
        expect(c.files.filter((f) => !f.startsWith(`intent/${slug}/`) && f !== "intent/queue.md")).toEqual([]);
      }
      for (let i = 0; i < 20; i++) {
        expect((await readIntent(s.root, `c${i}`)).file.frontmatter.status).toBe("designing");
        expect((await run(["git", "cat-file", "-e", `main:intent/c${i}/spec.md`], s.root)).code).toBe(0);
      }
    } finally {
      s.cleanup();
    }
  }, 120_000);

  test("a sync that brings in GitHub's main never meets another change's status write half way", async () => {
    const s = await repoWith(20);
    const remote = tempDir("loopstra-remote-");
    const other = tempDir("loopstra-other-");
    // The queue's unsaved copy is the sync's to put back; leave it out of this test.
    await run(["git", "checkout", "--", "intent/queue.md"], s.root);
    await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
    await run(["git", "remote", "add", "origin", remote.path], s.root);
    await run(["git", "push", "-q", "-u", "origin", "main"], s.root);
    await run(["git", "clone", "-q", remote.path, "."], other.path);
    await run(["git", "config", "user.email", "person@example.com"], other.path);
    await run(["git", "config", "user.name", "Person"], other.path);
    try {
      for (let i = 0; i < 20; i++) {
        // The other clone takes in what Loopstra shared, so its push lands.
        expect((await run(["git", "pull", "-q", "--rebase", "origin", "main"], other.path)).code).toBe(0);
        await Bun.write(join(other.path, `theirs-${i}.md`), `${i}\n`);
        await run(["git", "add", "-A"], other.path);
        await run(["git", "commit", "-q", "-m", `elsewhere ${i}`], other.path);
        expect((await run(["git", "push", "-q", "origin", "main"], other.path)).code).toBe(0);

        const ctx = await s.ctx(i);
        const [synced, wrote] = await Promise.allSettled([syncMain(s.root, s.cfg, s.trace), setStatus(ctx, "designing")]);
        expect(wrote.status === "rejected" ? wrote.reason : null).not.toBeInstanceOf(MainCheckoutMoved);
        expect(wrote.status).toBe("fulfilled");
        expect(synced.status === "fulfilled" ? synced.value : String((synced as PromiseRejectedResult).reason)).toBe("pass");
        // Both commits are on main, and no rebase is left in progress.
        expect((await run(["git", "cat-file", "-e", `main:theirs-${i}.md`], s.root)).code).toBe(0);
        expect((await run(["git", "log", "-1", "--format=%s", "main", "--", `intent/c${i}`], s.root)).out).toContain(`loopstra(c${i})`);
        expect(await new Git(s.root).rebasing()).toBe(false);
        expect(await new Git(s.root).currentBranch()).toBe("main");
      }
      expect(await unsaved(s.root)).toEqual([]);
    } finally {
      remote.cleanup();
      other.cleanup();
      s.cleanup();
    }
  }, 180_000);
});
