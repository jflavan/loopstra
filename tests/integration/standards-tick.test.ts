import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { preflight, tick } from "../../src/scheduler";
import { resetStop } from "../../src/stop";
import { setupRepo } from "../helpers";

afterEach(() => resetStop());

const SLUG = "add-numbers";
const BAD = "# Naming\n\nWhy.\n";
const GOOD = "# Naming\n\nWhy.\n\n## Rules\n- NAME-1: Names are plain words.\n";
const SENTENCE = "loopstra/standards/bad.md cannot be read: ";

async function commitStandard(root: string, text: string): Promise<void> {
  mkdirSync(join(root, "loopstra", "standards"), { recursive: true });
  await Bun.write(join(root, "loopstra", "standards", "bad.md"), text);
  await new Git(root).commitAll("standards");
}

describe("standards that cannot be read stop the loop", () => {
  test("one tick with an unreadable standard on main starts no step", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await commitStandard(repo.path, BAD);
      const r = await tick(repo.path);
      expect(r.picked).toBeNull();
      expect(r.paused).toContain(SENTENCE);
      expect(r.paused).toEndWith(" Fix it on main and commit; until then no change moves on.");
      const ev = trace.lastEvent("_loop", "error", '"where":"standards"');
      expect(ev).not.toBeNull();
      expect(JSON.parse(ev!.payload).problems[0]).toContain(SENTENCE);
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("accepted");

      // The fix lands on main (by hand here; an agent-files request does it in a later task).
      await commitStandard(repo.path, GOOD);
      const next = await tick(repo.path);
      expect(next.picked).toBe(SLUG);
    } finally {
      trace.close();
      repo.cleanup();
    }
  }, 60_000);

  test("start refuses with the same sentence", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await commitStandard(repo.path, BAD);
      const refusal = await preflight(repo.path, { ...process.env, PATH: process.env.PATH });
      expect(refusal).toContain(SENTENCE);
      expect(refusal).toEndWith(" Fix it on main and commit; until then no change moves on.");
    } finally {
      trace.close();
      repo.cleanup();
    }
  });
});
