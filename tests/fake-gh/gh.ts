#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Pr = { number: number; state: "OPEN" | "MERGED" | "CLOSED"; reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED"; checks: "pass" | "fail" | "pending" | "none"; merged: boolean; mergeCommit?: string; createdAt?: string; title?: string; body?: string; comments: string[] };
type State = { prs: Record<string, Pr>; next: number };

// Test knob: behave like a gh that never answers.
if (process.env.LOOPSTRA_FAKE_GH_HANG === "1") await new Promise(() => setInterval(() => {}, 1_000));

const args = Bun.argv.slice(2);
const statePath = process.env.LOOPSTRA_FAKE_GH_STATE!;
const state: State = existsSync(statePath) ? JSON.parse(await Bun.file(statePath).text()) : { prs: {}, next: 1 };
if (process.env.LOOPSTRA_FAKE_GH_LOG) appendFileSync(process.env.LOOPSTRA_FAKE_GH_LOG, JSON.stringify(args) + "\n");
const save = () => Bun.write(statePath, JSON.stringify(state, null, 2));
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// The body, as gh takes it: --body <text>, or --body-file - (standard input).
const body = async () => flag("--body") ?? (flag("--body-file") === "-" ? await Bun.stdin.text() : undefined);

const branchOf = (number: number) => Object.entries(state.prs).find(([, p]) => p.number === number)![0];

const [group, cmd] = args;
if (group === "--version") { console.log("gh version 2.93.0 (fake)"); process.exit(0); }
// Test knob: LOOPSTRA_FAKE_GH_SIGNED_OUT=1 behaves like a gh nobody has signed in to.
if (group === "auth" && cmd === "status") {
  if (process.env.LOOPSTRA_FAKE_GH_SIGNED_OUT === "1") { console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login"); process.exit(1); }
  console.log("github.com: Logged in (fake)"); process.exit(0);
}
if (group !== "pr") { console.error(`fake gh: unsupported ${args.join(" ")}`); process.exit(1); }

if (cmd === "view") {
  const branch = args[2]!;
  const pr = state.prs[branch];
  if (!pr) { console.error("no pull requests found"); process.exit(1); }
  console.log(JSON.stringify({ number: pr.number, state: pr.state, reviewDecision: pr.reviewDecision, mergedAt: pr.merged ? "2026-01-01T00:00:00Z" : null, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, createdAt: pr.createdAt ?? "2026-01-01T00:00:00Z", url: `https://example.test/pr/${pr.number}` }));
} else if (cmd === "create") {
  const branch = flag("--head")!;
  const pr: Pr = { number: state.next++, state: "OPEN", reviewDecision: "", checks: "pending", merged: false, createdAt: new Date().toISOString(), title: flag("--title"), body: await body(), comments: [] };
  state.prs[branch] = pr;
  await save();
  console.log(`https://example.test/pr/${pr.number}`);
} else if (cmd === "comment") {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((p) => p.number === number)!;
  pr.comments.push((await body()) ?? "");
  await save();
} else if (cmd === "checks") {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((p) => p.number === number)!;
  // Like gh: "no checks reported" is an error; with --json it prints the rows and exits 0 whatever
  // their states (the exit codes 1 = failed and 8 = pending only come without --json).
  if (pr.checks === "none") { console.error(`no checks reported on the '${branchOf(number)}' branch`); process.exit(1); }
  const [st, bucket] = pr.checks === "pass" ? ["SUCCESS", "pass"] : pr.checks === "fail" ? ["FAILURE", "fail"] : ["IN_PROGRESS", "pending"];
  const row: Record<string, string> = { name: "ci", state: st, bucket, workflow: "ci" };
  const fields = flag("--json");
  if (fields !== undefined) {
    console.log(JSON.stringify([Object.fromEntries(fields.split(",").map((f) => [f, row[f] ?? ""]))]));
    process.exit(0);
  }
  console.log(`ci\t${bucket}`);
  process.exit(pr.checks === "pass" ? 0 : pr.checks === "fail" ? 1 : 8);
} else if (cmd === "merge") {
  // Test knob: behave like a base branch with a merge queue (gh queues the pull request and exits 0).
  if (process.env.LOOPSTRA_FAKE_GH_QUEUE === "1") process.exit(0);
  const number = Number(args[2]);
  const [branch, pr] = Object.entries(state.prs).find(([, p]) => p.number === number)!;
  // Test knob: with a bare repository as the remote, merge on it for real, the way GitHub would.
  const remote = process.env.LOOPSTRA_FAKE_GH_REMOTE;
  if (remote) {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-merge-"));
    const git = (...a: string[]) => {
      const r = Bun.spawnSync({ cmd: ["git", "-c", "user.name=GitHub", "-c", "user.email=github@example.test", ...a], cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) { console.error(`fake gh: git ${a.join(" ")} failed: ${r.stderr.toString()}`); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
      return r.stdout.toString().trim();
    };
    git("clone", "-q", remote, ".");
    if (args.includes("--squash")) { git("merge", "--squash", `origin/${branch}`); git("commit", "-q", "-m", pr.title ?? branch); }
    else git("merge", "--no-ff", "-m", pr.title ?? branch, `origin/${branch}`);
    git("push", "-q", "origin", "HEAD");
    pr.mergeCommit = git("rev-parse", "HEAD");
    if (args.includes("--delete-branch")) git("push", "-q", "origin", "--delete", branch);
    rmSync(dir, { recursive: true, force: true });
  }
  pr.state = "MERGED"; pr.merged = true;
  await save();
} else {
  console.error(`fake gh: unsupported ${args.join(" ")}`); process.exit(1);
}
