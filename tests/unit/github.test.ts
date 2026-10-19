import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checksFromRows, ghProblem, GitHub, GITHUB_SIGNAL, recordGitHub } from "../../src/github";
import { Trace } from "../../src/trace";
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

  test("gh never gets a hook's repository variables, so it works on the checkout it is given", async () => {
    const t = tempDir();
    try {
      const envLog = join(t.path, "env.jsonl");
      const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: join(t.path, "gh.json"), LOOPSTRA_FAKE_GH_ENV_LOG: envLog, GIT_DIR: join(t.path, "other", ".git"), GIT_INDEX_FILE: join(t.path, "other", "index") } });
      expect(await gh.lookupPr("intent/x")).toEqual({ pr: null });
      const seen = (await Bun.file(envLog).text()).trim().split("\n").map((l) => JSON.parse(l) as unknown);
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) expect(s).toEqual({ GIT_DIR: null, GIT_INDEX_FILE: null });
    } finally { t.cleanup(); }
  });

  test("without a branch rule requiring reviews, an approval from someone with a say in the repository counts", async () => {
    const t = tempDir();
    try {
      const statePath = join(t.path, "gh.json");
      const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath } });
      await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: "body" });
      const approvedWith = async (reviewDecision: string, latestReviews: object[]) => {
        const s = JSON.parse(await Bun.file(statePath).text());
        Object.assign(s.prs["intent/x"], { reviewDecision, latestReviews });
        await Bun.write(statePath, JSON.stringify(s));
        return (await gh.prForBranch("intent/x"))?.approved;
      };
      const member = { author: { login: "ann" }, authorAssociation: "MEMBER", state: "APPROVED" };
      // GitHub's own decision is empty when no rule requires reviews (a rule requiring 0 approvals too).
      expect(await approvedWith("", [])).toBe(false);
      expect(await approvedWith("", [member])).toBe(true);
      expect(await approvedWith("", [{ ...member, authorAssociation: "OWNER" }])).toBe(true);
      expect(await approvedWith("", [{ ...member, authorAssociation: "COLLABORATOR" }])).toBe(true);
      // Anyone can approve on a public repository: a stranger's approval does not count.
      expect(await approvedWith("", [{ ...member, authorAssociation: "NONE" }])).toBe(false);
      expect(await approvedWith("", [{ ...member, authorAssociation: "CONTRIBUTOR" }])).toBe(false);
      // A request for changes from someone with a say holds it back; a stranger's does not, as with approvals.
      expect(await approvedWith("", [member, { author: { login: "bob" }, authorAssociation: "COLLABORATOR", state: "CHANGES_REQUESTED" }])).toBe(false);
      expect(await approvedWith("", [member, { author: { login: "bob" }, authorAssociation: "NONE", state: "CHANGES_REQUESTED" }])).toBe(true);
      expect(await approvedWith("", [member, { author: { login: "bob" }, state: "CHANGES_REQUESTED" }])).toBe(false);
      expect(await approvedWith("", [member, { author: { login: "cat" }, authorAssociation: "MEMBER", state: "COMMENTED" }])).toBe(true);
      // Without authorAssociation, any approval but the pull request's author's own counts.
      expect(await approvedWith("", [{ author: { login: "ann" }, state: "APPROVED" }])).toBe(true);
      expect(await approvedWith("", [{ author: { login: "loopstra-bot" }, state: "APPROVED" }])).toBe(false);
      // When GitHub decides, its decision stands.
      expect(await approvedWith("REVIEW_REQUIRED", [member])).toBe(false);
      expect(await approvedWith("APPROVED", [])).toBe(true);
    } finally { t.cleanup(); }
  });

  test("checks read the states gh prints, since gh pr checks --json exits 0 whatever they are", async () => {
    const t = tempDir();
    try {
      const statePath = join(t.path, "gh.json");
      const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath } });
      await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: "body" });
      const setChecks = async (checks: string) => {
        const s = JSON.parse(await Bun.file(statePath).text());
        s.prs["intent/x"].checks = checks;
        await Bun.write(statePath, JSON.stringify(s));
      };
      expect(await gh.checks(1)).toBe("pending");
      await setChecks("fail");
      expect(await gh.checks(1)).toBe("fail");
      await setChecks("none");
      expect(await gh.checks(1)).toBe("none");
      await setChecks("pass");
      expect(await gh.checks(1)).toBe("pass");
      expect((await gh.prForBranch("intent/x"))?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    } finally { t.cleanup(); }
  });

  test("any failed or cancelled check fails, then any running one is pending; gh's state is used without a bucket", () => {
    expect(checksFromRows([])).toBe("none");
    expect(checksFromRows([{ bucket: "pass" }, { bucket: "skipping" }])).toBe("pass");
    expect(checksFromRows([{ bucket: "pass" }, { bucket: "pending" }])).toBe("pending");
    expect(checksFromRows([{ bucket: "pending" }, { bucket: "fail" }])).toBe("fail");
    expect(checksFromRows([{ bucket: "cancel" }])).toBe("fail");
    for (const state of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) expect(checksFromRows([{ state: "SUCCESS" }, { state }])).toBe("fail");
    // gh buckets a workflow that could not start with the pending ones; it never will start.
    expect(checksFromRows([{ state: "STARTUP_FAILURE", bucket: "pending" }])).toBe("fail");
    for (const state of ["PENDING", "QUEUED", "IN_PROGRESS"]) expect(checksFromRows([{ state: "SUCCESS" }, { state }])).toBe("pending");
    expect(checksFromRows([{ state: "SUCCESS" }, { state: "SKIPPED" }, { state: "NEUTRAL" }])).toBe("pass");
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

  test("a draft pull request is read as one, and an answer that is not a pull request is an error, not a pull request", async () => {
    const t = tempDir();
    try {
      const statePath = join(t.path, "gh.json");
      const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath } });
      await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: "body" });
      expect((await gh.prForBranch("intent/x"))?.draft).toBe(false);
      const s = JSON.parse(await Bun.file(statePath).text());
      s.prs["intent/x"].isDraft = true;
      await Bun.write(statePath, JSON.stringify(s));
      expect((await gh.prForBranch("intent/x"))?.draft).toBe(true);
      // gh printing JSON that is not a pull request (a number without a state, say) is not taken for one.
      const fake = join(t.path, "odd-gh.ts");
      await Bun.write(fake, 'if (Bun.argv[3] === "view") console.log(JSON.stringify({ number: 1 }));\n');
      const odd = new GitHub(t.path, { executable: fake });
      expect(await odd.lookupPr("intent/x")).toEqual({ error: "gh pr view printed something that is not a pull request" });
    } finally { t.cleanup(); }
  });

  test("review data in a shape gh does not print is an error to wait on, not a throw that blocks the change", async () => {
    const t = tempDir();
    try {
      const pr = { number: 1, state: "OPEN", mergedAt: null, url: "https://example.test/pr/1", createdAt: "2026-10-19T00:00:00Z" };
      const shapes = [
        { latestReviews: { state: "APPROVED" } },
        { latestReviews: [null] },
        { latestReviews: ["APPROVED"] },
        { reviewDecision: 1 },
        { author: "someone" },
      ];
      for (const [i, extra] of shapes.entries()) {
        const fake = join(t.path, `odd-gh-${i}.ts`);
        await Bun.write(fake, `if (Bun.argv[3] === "view") console.log(${JSON.stringify(JSON.stringify({ ...pr, ...extra }))});\n`);
        expect(await new GitHub(t.path, { executable: fake }).lookupPr("intent/x")).toEqual({ error: "gh pr view printed reviews in a shape Loopstra does not read" });
      }
      // The shapes gh does print still read: no reviews at all, or null fields.
      const plain = join(t.path, "plain-gh.ts");
      await Bun.write(plain, `if (Bun.argv[3] === "view") console.log(${JSON.stringify(JSON.stringify({ ...pr, reviewDecision: null, latestReviews: [{ author: null, state: "APPROVED", authorAssociation: "OWNER" }], author: null }))});\n`);
      expect(await new GitHub(t.path, { executable: plain }).lookupPr("intent/x")).toMatchObject({ pr: { number: 1, approved: true } });
    } finally { t.cleanup(); }
  });

  test("createPr takes the number from the pull request's link when GitHub cannot be asked for it right after", async () => {
    const t = tempDir();
    try {
      const statePath = join(t.path, "gh.json");
      const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath, LOOPSTRA_FAKE_GH_VIEW_FAILS: "1" } });
      expect(await gh.lookupPr("intent/x")).toMatchObject({ error: expect.stringContaining("502") });
      expect(await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: "body" })).toEqual({ number: 1, url: "https://example.test/pr/1" });
      expect(await gh.createPr({ head: "intent/y", base: "main", title: "y: title", body: "body" })).toEqual({ number: 2, url: "https://example.test/pr/2" });
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
    const errors: string[] = [];
    expect(await gh.checks(1, (e) => errors.push(e))).toBe("unknown");
    expect(errors).toEqual([expect.stringContaining("was stopped")]);
    expect(await gh.available()).toBe(false);
    await expect(gh.comment(1, "x")).rejects.toThrow();
    t.cleanup();
  }, 30_000);

  test("gh's error reads the same from one look to the next: its first line, without the ids that change every call", () => {
    expect(ghProblem("HTTP 401: Bad credentials (https://api.github.com/graphql)")).toBe("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    expect(ghProblem("GraphQL: Something went wrong while executing your query. Please include `C8F2:3A9B:1D2E3F:4A5B6C:6713F0A2` when reporting this issue.\nmore"))
      .toBe("GraphQL: Something went wrong while executing your query. Please include `…` when reporting this issue.");
    expect(ghProblem("HTTP 502: Bad Gateway (request 4f9c2a17-03be-4d0e-9a21-5c7e8f0b1d22)")).toBe("HTTP 502: Bad Gateway (request …)");
    expect(ghProblem("HTTP 500: server error, trace 98213377 at 3f2a91cbe0")).toBe("HTTP 500: server error, trace … at …");
  });

  test("a look's failure is a new github row only when its words change, not its request id", () => {
    const t = tempDir();
    const trace = Trace.open(t.path, () => {});
    try {
      const rows = () => trace.signals(50).filter((s) => s.name === GITHUB_SIGNAL).map((s) => s.result);
      recordGitHub(trace, "GraphQL: Something went wrong. Please include `C8F2:3A9B:1D2E3F:4A5B6C:6713F0A2` when reporting this issue.");
      recordGitHub(trace, "GraphQL: Something went wrong. Please include `0D11:7E2C:9F3A4B:1C2D3E:6713F0B9` when reporting this issue.");
      expect(rows()).toEqual(["fail"]);
      recordGitHub(trace, "HTTP 401: Bad credentials");
      expect(rows()).toEqual(["fail", "fail"]);
      recordGitHub(trace, null);
      expect(rows()).toEqual(["pass", "fail", "fail"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
