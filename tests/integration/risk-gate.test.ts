import { afterEach, describe, expect, test } from "bun:test";
import { tick } from "../../src/scheduler";
import { PR_CHECKS_NOTE } from "../../src/stages/shared";
import { resetStop } from "../../src/stop";
import { withEnv } from "../helpers";
import { inTrace, intentOf, onRemoteMain, remoteSetup, SLUG } from "./remote-helpers";

afterEach(() => resetStop());

/** The build adds src/add.ts and tests/add.test.ts. */
const risky = (paths: string, human = "") => `gates:\n  merge:\n    risky:\n      paths: [${paths}]\n${human ? `      human: ${human}\n` : ""}`;

describe("risky changes with a GitHub remote", () => {
  test("nobody on the merge gate, a risky change: its pull request waits for an approval though its checks pass, then merges", async () => {
    const s = await remoteSetup(risky('"src/**", "package.json"'));
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, merge checks, pull request
      const waiting = await intentOf(s.repo);
      expect(waiting).toMatchObject({ status: "merge-review", merge_gate: "pr" });
      expect(waiting.note).toBe("This change touches files set to need a person before merging: src/add.ts. Approve the pull request on GitHub, or set status to merge-approved. To stop this change, set it to closed.");
      expect(inTrace(s.repo, (t) => t.lastGate(SLUG, "merge", "risk"))).toMatchObject({ result: "waiting", evidence: "touches src/add.ts" });

      // Its checks pass, but nobody approved: it does not merge, look after look.
      await s.setPr({ checks: "pass" });
      await tick(s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect((await s.pr()).merged).toBe(false);
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(false);

      await s.setPr({ reviewDecision: "APPROVED" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect((await s.pr()).merged).toBe(true);
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
      expect(inTrace(s.repo, (t) => t.lastGate(SLUG, "merge", "pr-approved"))?.evidence).toBe("approved on GitHub");
    });
    s.cleanup();
  }, 180_000);

  test("a risky change decided on the status line waits for merge-approved, whatever GitHub says", async () => {
    const s = await remoteSetup(risky('"src/**"', "status"));
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      const waiting = await intentOf(s.repo);
      expect(waiting).toMatchObject({ status: "merge-review", merge_gate: "status" });
      expect(waiting.note).toBe("This change touches files set to need a person before merging: src/add.ts. Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.");
      await s.setPr({ checks: "pass", reviewDecision: "APPROVED" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect((await s.pr()).merged).toBe(false);
    });
    s.cleanup();
  }, 180_000);

  test("nobody on the merge gate, nothing risky touched: no merge_gate, a passing risk row, and it merges once its checks pass", async () => {
    const s = await remoteSetup(risky('".github/**"'));
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      const waiting = await intentOf(s.repo);
      expect(waiting).toMatchObject({ status: "merge-review", note: PR_CHECKS_NOTE });
      expect(waiting.merge_gate).toBeUndefined();
      expect(inTrace(s.repo, (t) => t.lastGate(SLUG, "merge", "risk"))).toMatchObject({ result: "pass", evidence: "nothing risky" });
      await s.setPr({ checks: "pass" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
    });
    s.cleanup();
  }, 180_000);
});
