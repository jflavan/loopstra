import { describe, expect, test } from "bun:test";
import { printResult, report, upgradeCommand, type UpgradeIo } from "../../src/commands/upgrade";
import type { RepoResult } from "../../src/upgrade/repo";

/** An io that records what it is asked to do. */
function io(installed: string, latest: string | null, o: { install?: boolean; stamp?: string } = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const pieces: UpgradeIo = {
    say: (l) => said.push(l),
    installed,
    stamp: o.stamp ?? installed,
    latest: async () => latest,
    notes: async (from, to) => `## ${to}\n- feat: since ${from}`,
    install: async (v) => { calls.push(`install ${v}`); return o.install ?? true; },
    handOff: async (v, ok) => { calls.push(`handoff ${v} ${ok}`); return 0; },
    repoStep: async (check) => { calls.push(check ? "check" : "repo"); return 0; },
  };
  return { pieces, calls, said };
}

describe("upgradeCommand", () => {
  test("a development checkout skips the install and runs the repository step", async () => {
    const t = io("0.0.0-dev", "0.5.0");
    expect(await upgradeCommand("/r", [], t.pieces)).toBe(0);
    expect(t.calls).toEqual(["repo"]);
    expect(t.said.join("\n")).toContain("git pull");
  });

  test("a newer release is installed and the new version runs the repository step", async () => {
    const t = io("0.4.0", "0.5.0");
    await upgradeCommand("/r", [], t.pieces);
    expect(t.calls).toEqual(["install 0.5.0", "handoff 0.5.0 true"]);
  });

  test("a failed install still hands off, saying it failed", async () => {
    const t = io("0.4.0", "0.5.0", { install: false });
    await upgradeCommand("/r", [], t.pieces);
    expect(t.calls).toEqual(["install 0.5.0", "handoff 0.5.0 false"]);
  });

  test("up to date, or the registry unreachable: the repository step runs with this version", async () => {
    for (const latest of ["0.4.0", null]) {
      const t = io("0.4.0", latest);
      await upgradeCommand("/r", [], t.pieces);
      expect(t.calls).toEqual(["repo"]);
    }
    const offline = io("0.4.0", null);
    await upgradeCommand("/r", [], offline.pieces);
    expect(offline.said.join("\n")).toContain("could not be reached");
  });

  test("--repo never installs", async () => {
    const t = io("0.4.0", "0.5.0");
    await upgradeCommand("/r", ["--repo"], t.pieces);
    expect(t.calls).toEqual(["repo"]);
  });

  test("--check never installs; it names both versions and the release notes between them", async () => {
    const t = io("0.4.0", "0.5.0");
    await upgradeCommand("/r", ["--check"], t.pieces);
    expect(t.calls).toEqual(["check"]);
    const said = t.said.join("\n");
    expect(said).toContain("Installed: Loopstra 0.4.0. Latest: 0.5.0.");
    expect(said).toContain("## 0.5.0\n- feat: since 0.4.0");

    const current = io("0.5.0", "0.5.0");
    await upgradeCommand("/r", ["--check"], current.pieces);
    expect(current.said[0]).toBe("Installed: Loopstra 0.5.0, the latest.");

    const dev = io("0.0.0-dev", "0.5.0");
    await upgradeCommand("/r", ["--check"], dev.pieces);
    expect(dev.said[0]).toContain("development checkout");
  });

  test("--check, with the repository on a release newer than this one: the newer release would be installed first, so nothing is refused", async () => {
    const t = io("0.4.0", "0.6.0", { stamp: "0.5.0" });
    expect(await upgradeCommand("/r", ["--check"], t.pieces)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.said.at(-1)).toBe("This repository is on Loopstra 0.5.0: loopstra upgrade would install 0.6.0 first, then bring this repository up to it.");

    // The newest release is still older than the stamp: the repository step says why.
    const behind = io("0.4.0", "0.4.5", { stamp: "0.5.0" });
    await upgradeCommand("/r", ["--check"], behind.pieces);
    expect(behind.calls).toEqual(["check"]);
  });
});

describe("report", () => {
  const result = (o: Partial<RepoResult> = {}): RepoResult => ({
    ok: true, from: "0.8.0", to: "0.9.0", files: [], removed: [], changed: [], notes: [], warnings: [], main: "trunk", written: false, committed: false, ...o,
  });

  test("says what changed, file by file, and what was committed", () => {
    const r = result({
      files: [
        { path: "REVIEW.md", outcome: "replaced", entry: { base: "x" } },
        { path: "intent/README.md", outcome: "unchanged", entry: { base: "x" } },
        { path: "loopstra/prompts/review.md", outcome: "conflict", entry: { base: "x" } },
        { path: "intent/README.md", outcome: "deleted", entry: { base: "x", deleted: true } },
      ],
      removed: [".claude/hooks/loopstra-protect-tests.ts"],
      changed: ["loopstra/config.yaml"],
      notes: ["loopstra/prompts/plan.md is merged from the version shipped in abc1234."],
      committed: true,
    });
    expect(report(r, false)).toEqual([
      "Upgraded this repository to Loopstra 0.9.0 (from 0.8.0).",
      "  REVIEW.md: updated",
      "  loopstra/prompts/review.md: has conflict markers; resolve them and commit it",
      "  intent/README.md: recorded as removed on purpose; upgrades leave it out",
      "  .claude/hooks/loopstra-protect-tests.ts: removed",
      "  loopstra/config.yaml: updated",
      "  loopstra/prompts/plan.md is merged from the version shipped in abc1234.",
      "Committed on trunk; loopstra start shares it with the remote, or push it yourself.",
    ]);
  });

  test("--check says what would happen, and what would stop a real upgrade", () => {
    const r = result({
      from: null,
      files: [{ path: "REVIEW.md", outcome: "merged", entry: { base: "x" } }],
      removed: ["loopstra/prompts/build.md"],
      warnings: ["The loop is running. Stop it (Ctrl-C in its terminal), run loopstra upgrade, then start it again."],
    });
    expect(report(r, true)).toEqual([
      "This repository would be upgraded to Loopstra 0.9.0 (it has no stamp yet).",
      "  REVIEW.md: would be merged with your edits",
      "  loopstra/prompts/build.md: would be removed",
      "  Note: The loop is running. Stop it (Ctrl-C in its terminal), run loopstra upgrade, then start it again.",
    ]);
  });

  test("nothing to do", () => {
    expect(report(result({ from: "0.9.0" }), false)).toEqual(["This repository is on Loopstra 0.9.0.", "  Nothing changed."]);
    expect(report(result({ from: "0.9.0" }), true)).toEqual(["This repository is on Loopstra 0.9.0.", "  Nothing would change."]);
  });

  test("printResult: a refusal goes to warn as it is; files written but not committed are reported first", () => {
    const say: string[] = [];
    const warn: string[] = [];
    expect(printResult(result({ ok: false, refusal: "The checkout is on other, not main." }), false, (l) => say.push(l), (l) => warn.push(l))).toBe(1);
    expect({ say, warn }).toEqual({ say: [], warn: ["The checkout is on other, not main."] });
    say.length = 0; warn.length = 0;
    const failed = result({ ok: false, written: true, refusal: "The files were brought up to date but could not be committed (git said: no). Commit them by hand.", files: [{ path: "REVIEW.md", outcome: "replaced", entry: { base: "x" } }] });
    expect(printResult(failed, false, (l) => say.push(l), (l) => warn.push(l))).toBe(1);
    expect(say).toEqual(["Upgraded this repository to Loopstra 0.9.0 (from 0.8.0).", "  REVIEW.md: updated"]);
    expect(warn).toEqual([failed.refusal!]);
    say.length = 0; warn.length = 0;
    expect(printResult(result(), true, (l) => say.push(l), (l) => warn.push(l))).toBe(0);
    expect(warn).toEqual([]);
  });
});
