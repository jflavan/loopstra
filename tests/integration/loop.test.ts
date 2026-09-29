import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { OFF_MAIN_NOTE } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { FAKE_CLAUDE as FAKE, TEMPLATES, tempGitRepo } from "../helpers";


describe("the loop", () => {
  test("drives one intent from accepted to done across ticks, one step per tick, with no remote", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: bun test\n");
    await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
    await Bun.write(join(repo.path, ".gitignore"), ".loopstra/\n");
    mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), "---\nstatus: accepted\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n");
    mkdirSync(join(repo.path, "intent", "later"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "later", "intent.md"), "---\nstatus: draft\n---\n# Intent: later\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await new Git(repo.path).commitAll("setup");
    process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;

    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await tick(repo.path);
      const status = (await readIntent(repo.path, "add-numbers")).file.frontmatter.status;
      seen.push(`${r.picked ?? "-"}:${status}`);
      if (status === "done") break;
    }
    expect(seen).toEqual([
      "add-numbers:spec-approved",
      "add-numbers:plan-approved",
      "add-numbers:reviewing",
      "add-numbers:merged",
      "add-numbers:done",
    ]);
    expect(existsSync(join(repo.path, "src", "add.ts"))).toBe(true);
    expect(existsSync(join(repo.path, "intent", "add-numbers", "outcome.md"))).toBe(true);
    expect(await Bun.file(join(repo.path, "intent", "queue.md")).text()).toContain("add-numbers");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    const idle = await tick(repo.path);
    expect(idle.picked).toBeNull();
    repo.cleanup();
  }, 120_000);

  test("with the main checkout on another branch, a tick pauses in plain words and commits nothing", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
    mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), "---\nstatus: accepted\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n");
    const git = new Git(repo.path);
    await git.commitAll("setup");
    await git.run(["checkout", "-q", "-b", "someone-elses-work"]);
    const head = await git.headSha();
    process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;
    const r = await tick(repo.path);
    expect(r.picked).toBeNull();
    expect(r.paused).toBe(OFF_MAIN_NOTE);
    expect(await git.headSha()).toBe(head);
    expect(await git.isDirty()).toBe(false);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("accepted");
    repo.cleanup();
  });

  test("a bad config does not crash a tick", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\nbogus: true\n");
    const r = await tick(repo.path);
    expect(r.picked).toBeNull();
    expect(r.error).toMatch(/bogus/);
    repo.cleanup();
  });
});
