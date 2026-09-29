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
    expect(pr).toMatchObject({ number: 1, state: "OPEN", approved: false, merged: false });
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
    t.cleanup();
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
