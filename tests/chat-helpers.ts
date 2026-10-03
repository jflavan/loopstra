import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "../src/config";
import { Git } from "../src/git";
import type { IncomingMessage } from "../src/chat/orchestrator";
import { FAKE_CLAUDE, run, setEnv, tempDir, tempGitRepo } from "./helpers";

export const FAKE_GH = fileURLToPath(new URL("./fake-gh/gh.ts", import.meta.url));

/** A stream-json fixture: one session that returns `output` as its structured output. */
export function fixture(output: unknown, opts: { session?: string; cost?: number } = {}): string {
  const session = opts.session ?? "chat-session";
  return [
    { type: "system", subtype: "init", session_id: session, cwd: "/", tools: [], model: "fake" },
    { type: "result", subtype: "success", is_error: false, session_id: session, total_cost_usd: opts.cost ?? 0.01, usage: {}, structured_output: output, result: "ok" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export const turn = (reply: string, extra: { handoff?: unknown; accept?: unknown } = {}) => ({ reply, handoff: extra.handoff ?? null, accept: extra.accept ?? null });

export const draft = (slug: string, more: Record<string, unknown> = {}) => ({
  slug, title: `Do ${slug}`, priority: null, depends_on: [],
  problem: "People cannot export reports.", proposed_outcome: "They can download a CSV.", done_when: "- A CSV downloads from the report page.",
  affected_users_and_systems: "Report readers.", constraints: "", open_questions: "",
  ...more,
});

export const INTENT = (status: string, title = "existing") => `---\nstatus: ${status}\n---\n# Intent: ${title}\n\n## Problem\nP.\n\n## Proposed outcome\nO.\n\n## Done when\n- D.\n`;

/**
 * A repository set up for Loopstra (no remote unless `remote`), the fake claude and gh in the
 * environment, a fixture folder for sequenced chat answers, and a log of every prompt.
 */
export async function chatRepo(opts: { remote?: boolean; config?: string; intents?: Record<string, string> } = {}) {
  const repo = await tempGitRepo();
  const fixtures = tempDir("loopstra-fixtures-");
  const remote = opts.remote ? tempDir("loopstra-remote-") : null;
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: echo ok\n${opts.config ?? ""}`);
  for (const [slug, text] of Object.entries(opts.intents ?? {})) {
    mkdirSync(join(repo.path, "intent", slug), { recursive: true });
    await Bun.write(join(repo.path, "intent", slug, "intent.md"), text);
  }
  await new Git(repo.path).commitAll("setup");
  const env: Record<string, string> = {
    LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE,
    LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path,
    LOOPSTRA_FAKE_PROMPTS: join(fixtures.path, "prompts.jsonl"),
  };
  if (remote) {
    await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
    await run(["git", "remote", "add", "origin", remote.path], repo.path);
    await run(["git", "push", "-q", "-u", "origin", "main"], repo.path);
    Object.assign(env, {
      LOOPSTRA_GH_EXECUTABLE: FAKE_GH,
      LOOPSTRA_FAKE_GH_STATE: join(remote.path, "fake-gh.json"),
      LOOPSTRA_FAKE_GH_REMOTE: remote.path,
    });
  }
  const restore = setEnv(env);
  return {
    root: repo.path,
    remote: remote?.path ?? null,
    /** The n-th answer (1-based) of a chat phase. */
    answer: async (phase: "orchestrator" | "write-intent", n: number, output: unknown, o: { session?: string; cost?: number } = {}) => {
      await Bun.write(join(fixtures.path, `${phase}-${n}.jsonl`), fixture(output, o));
    },
    /** Every prompt the fake claude was given, in order. */
    prompts: (): Array<{ phase: string; args: string[]; prompt: string }> => {
      const p = join(fixtures.path, "prompts.jsonl");
      return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    ghState: async (): Promise<{ prs: Record<string, { number: number; state: string; title?: string; body?: string; merged: boolean }> }> => {
      const p = join(remote!.path, "fake-gh.json");
      return existsSync(p) ? Bun.file(p).json() : { prs: {} };
    },
    cleanup: () => { restore(); repo.cleanup(); fixtures.cleanup(); remote?.cleanup(); },
  };
}

/** A message from the terminal user, who may start drafts. */
export function message(text: string, more: Partial<IncomingMessage> = {}): IncomingMessage {
  return { transport: "terminal", via: "the terminal", thread: "local", authorId: "ana", authorName: "Ana", text, canAccept: true, acceptors: "you", ...more };
}

/** A send function that keeps what it was sent. */
export function sink(): { sent: string[]; send: (t: string) => Promise<void> } {
  const sent: string[] = [];
  return { sent, send: async (t) => { sent.push(t); } };
}
