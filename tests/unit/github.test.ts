import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHub } from "../../src/github";
import { tempDir } from "../helpers";

const FAKE = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

describe("GitHub", () => {
  test("create, view, comment, checks, merge against the fake", async () => {
    const t = tempDir();
    const statePath = join(t.path, "gh.json");
    const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath } });
    expect(await gh.available()).toBe(true);
    expect(await gh.prForBranch("intent/x")).toBeNull();
    expect(await gh.lookupPr("intent/x")).toEqual({ pr: null });
    const created = await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: "body" });
    expect(created.number).toBe(1);
    let pr = await gh.prForBranch("intent/x");
    expect(pr).toMatchObject({ number: 1, state: "OPEN", approved: false, merged: false, mergeCommit: null });
    await gh.comment(1, "findings");
    expect(await gh.checks(1)).toBe("pending");
    const s = JSON.parse(await Bun.file(statePath).text());
    s.prs["intent/x"].checks = "pass"; s.prs["intent/x"].reviewDecision = "APPROVED";
    await Bun.write(statePath, JSON.stringify(s));
    expect(await gh.checks(1)).toBe("pass");
    pr = await gh.prForBranch("intent/x");
    expect(pr?.approved).toBe(true);
    await gh.merge(1, "squash");
    pr = await gh.prForBranch("intent/x");
    expect(pr?.merged).toBe(true);
    // The commit the merge made on main, as gh names it (the fake records one when it merges on a real remote).
    const m = JSON.parse(await Bun.file(statePath).text());
    m.prs["intent/x"].mergeCommit = "abc123";
    await Bun.write(statePath, JSON.stringify(m));
    expect((await gh.prForBranch("intent/x"))?.mergeCommit).toBe("abc123");
    t.cleanup();
  });

  test("bodies go to gh on standard input, so a long one never reaches the command line", async () => {
    const t = tempDir();
    try {
      const statePath = join(t.path, "gh.json");
      const log = join(t.path, "gh.log");
      const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath, LOOPSTRA_FAKE_GH_LOG: log } });
      const long = `${"A finding with some detail. ".repeat(1_500)}end`;
      await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: long });
      await gh.comment(1, `${long}!`);
      const s = JSON.parse(await Bun.file(statePath).text());
      expect(s.prs["intent/x"].body).toBe(long);
      expect(s.prs["intent/x"].comments).toEqual([`${long}!`]);
      const calls = (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l) as string[]);
      expect(calls.filter((c) => c[1] === "create" || c[1] === "comment").every((c) => c.includes("--body-file") && !c.some((a) => a.length > 1_000))).toBe(true);
    } finally { t.cleanup(); }
  });

  test("available is false when gh is missing", async () => {
    const t = tempDir();
    const gh = new GitHub(t.path, { executable: join(t.path, "missing.exe") });
    expect(await gh.available()).toBe(false);
    t.cleanup();
  });

  test("a gh that hangs is stopped at the timeout and behaves like a failed call", async () => {
    const t = tempDir();
    const gh = new GitHub(t.path, {
      executable: FAKE, timeoutMs: 200,
      env: { LOOPSTRA_FAKE_GH_STATE: join(t.path, "gh.json"), LOOPSTRA_FAKE_GH_HANG: "1" },
    });
    const started = Date.now();
    expect(await gh.prForBranch("intent/x")).toBeNull();
    expect(Date.now() - started).toBeLessThan(8_000);
    // A caller can tell "gh did not answer" from "there is no pull request", and waits.
    expect(await gh.lookupPr("intent/x")).toMatchObject({ error: expect.stringContaining("was stopped") });
    expect(await gh.checks(1)).toBe("unknown");
    expect(await gh.available()).toBe(false);
    await expect(gh.comment(1, "x")).rejects.toThrow();
    t.cleanup();
  }, 30_000);
});
