#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Pr = { number: number; state: "OPEN" | "MERGED" | "CLOSED"; reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED"; checks: "pass" | "fail" | "pending"; merged: boolean; title?: string; body?: string; comments: string[] };
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
  console.log(JSON.stringify({ number: pr.number, state: pr.state, reviewDecision: pr.reviewDecision, mergedAt: pr.merged ? "2026-01-01T00:00:00Z" : null, url: `https://example.test/pr/${pr.number}` }));
} else if (cmd === "create") {
  const branch = flag("--head")!;
  const pr: Pr = { number: state.next++, state: "OPEN", reviewDecision: "", checks: "pending", merged: false, title: flag("--title"), body: await body(), comments: [] };
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
  const rows = pr.checks === "pending" ? [{ name: "ci", state: "PENDING" }] : [{ name: "ci", state: pr.checks === "pass" ? "SUCCESS" : "FAILURE" }];
  console.log(JSON.stringify(rows));
  process.exit(pr.checks === "pass" ? 0 : pr.checks === "fail" ? 1 : 8);
} else if (cmd === "merge") {
  const number = Number(args[2]);
  const [branch, pr] = Object.entries(state.prs).find(([, p]) => p.number === number)!;
  // Test knob: with a bare repository as the remote, merge on it for real, the way GitHub would.
  const remote = process.env.LOOPSTRA_FAKE_GH_REMOTE;
  if (remote) {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-merge-"));
    const git = (...a: string[]) => {
      const r = Bun.spawnSync({ cmd: ["git", "-c", "user.name=GitHub", "-c", "user.email=github@example.test", ...a], cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) { console.error(`fake gh: git ${a.join(" ")} failed: ${r.stderr.toString()}`); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
    };
    git("clone", "-q", remote, ".");
    if (args.includes("--squash")) { git("merge", "--squash", `origin/${branch}`); git("commit", "-q", "-m", pr.title ?? branch); }
    else git("merge", "--no-ff", "-m", pr.title ?? branch, `origin/${branch}`);
    git("push", "-q", "origin", "HEAD");
    if (args.includes("--delete-branch")) git("push", "-q", "origin", "--delete", branch);
    rmSync(dir, { recursive: true, force: true });
  }
  pr.state = "MERGED"; pr.merged = true;
  await save();
} else {
  console.error(`fake gh: unsupported ${args.join(" ")}`); process.exit(1);
}
