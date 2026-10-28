import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { attention } from "../../src/attention";
import { renderStatus } from "../../src/commands/status";
import { configPath, loadConfig } from "../../src/config";
import { recordGitHub } from "../../src/github";
import { holdLoop, pauseAfterUnavailable } from "../../src/heartbeat";
import { runDir } from "../../src/paths";
import { SYNC_TEXT } from "../../src/remote";
import { MERGED_NOT_HERE } from "../../src/stages/merge";
import { PR_APPROVE_NOTE, PR_MERGED_ELSEWHERE, PR_WAIT } from "../../src/stages/shared";
import { Trace } from "../../src/trace";
import { Git } from "../../src/git";
import { tempDir, tempGitRepo } from "../helpers";

const BODY = "\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n";

async function intent(root: string, slug: string, fm: string): Promise<void> {
  mkdirSync(join(root, "intent", slug), { recursive: true });
  await Bun.write(join(root, "intent", slug, "intent.md"), `---\n${fm}\n---\n# Intent: ${slug}\n${BODY}`);
}

async function config(root: string): Promise<void> {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  await Bun.write(configPath(root), "version: 1\ncommands:\n  test: echo ok\n");
}

describe("renderStatus", () => {
  test("shows each intent with plain status, phase, cost, and note", async () => {
    const t = tempDir();
    await intent(t.path, "one", "status: blocked\npriority: high\nnote: Tests failed three times.");
    const trace = Trace.open(t.path);
    trace.upsertIntent("one", "blocked", "high");
    const seq = trace.phaseStart("one", "fix", "agent");
    trace.phaseEnd("one", seq, { status: "fail", costUsd: 0.5, error: "tests red" });
    trace.close();
    const text = await renderStatus(t.path);
    expect(text).toContain("one");
    expect(text).toContain("needs a person");
    expect(text).toContain("fix");
    expect(text).toContain("$0.50");
    expect(text).toContain("Tests failed three times.");
    t.cleanup();
  });

  test("lists an unreadable intent with what to fix", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "broken"), { recursive: true });
    await Bun.write(join(t.path, "intent", "broken", "intent.md"), "---\nstatus: nearly-done\n---\n# Intent: broken\n");
    const text = await renderStatus(t.path);
    expect(text).toContain("broken");
    expect(text).toContain("needs a person");
    expect(text).toContain("The status line at the top of intent.md");
    t.cleanup();
  });

  test("says so when there are no intents", async () => {
    const t = tempDir();
    expect(await renderStatus(t.path)).toMatch(/No intents yet/);
    t.cleanup();
  });

  test("a Needs attention block sits under the loop line, the same list as the dashboard's", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "busy", "status: building");
      expect((await renderStatus(t.path, 100)).split("\n").slice(0, 3)).toEqual(["Loop: Stopped", "", "Nothing needs you right now."]);
      await intent(t.path, "stuck", "status: blocked\nnote: The tests failed three times.");
      await intent(t.path, "idea", "status: draft");
      const text = await renderStatus(t.path, 100);
      const block = text.slice(0, text.indexOf("\n\nChange"));
      expect(block).toBe([
        "Loop: Stopped",
        "",
        "Needs attention:",
        "- Blocked (stuck): The tests failed three times.",
        "- Waiting for you (idea): A draft. When it says what you want, change the status line to accepted.",
        "  To drop it, set it to closed.",
      ].join("\n"));
    } finally {
      t.cleanup();
    }
  });

  test("a change waiting for another says why in its note; a wait only a person can end needs attention", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "first", "status: accepted");
      await intent(t.path, "second", "status: accepted\ndepends_on: first");
      await intent(t.path, "third", "status: accepted\ndepends_on: [frist]");
      await intent(t.path, "gone", "status: closed");
      await intent(t.path, "fourth", "status: accepted\ndepends_on: gone");
      const text = await renderStatus(t.path, 200);
      expect(text).toContain("Waits for first to be merged (now: waiting to be designed).");
      const block = text.slice(0, text.indexOf("\n\nChange"));
      expect(block).not.toContain("(second)");
      expect(block).toContain("- Waiting for you (third): Waits for frist, which Loopstra cannot find or read in intent/. Fix the name in depends_on, or remove it.");
      expect(block).toContain("- Waiting for you (fourth): Waits for gone, which was closed. Remove it from depends_on to go ahead.");
    } finally {
      t.cleanup();
    }
  });

  test("a risky change waiting in merge-review needs a person though nobody is on the config's merge gate; its own note, else the gate's, says what to do", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "risky", "status: merge-review\nmerge_gate: pr\nnote: \"This change touches files set to need a person before merging: package.json.\"");
      await intent(t.path, "bare", "status: merge-review\nmerge_gate: status");
      await intent(t.path, "plain", "status: merge-review\nnote: Waiting for the automatic checks on GitHub.");
      const text = await renderStatus(t.path, 1000);
      expect(text).toContain("- Waiting for you (risky): This change touches files set to need a person before merging: package.json.");
      expect(text).toContain("- Waiting for you (bare): Read review.md. When you are happy with it, change the status line to merge-approved.");
      expect(text).not.toContain("Waiting for you (plain)");
    } finally {
      t.cleanup();
    }
  });

  test("a change whose pull request waits says why in place of the merge gate's note; one only an engineer can end needs attention whoever is on the gate", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "loopstra"), { recursive: true });
      await Bun.write(configPath(t.path), "version: 1\ncommands:\n  test: echo ok\ngates:\n  merge:\n    human: pr\n");
      const behind = `${MERGED_NOT_HERE} ${SYNC_TEXT.unsaved}`;
      const wait = async (slug: string, text: string) => {
        mkdirSync(runDir(t.path, slug), { recursive: true });
        await Bun.write(join(runDir(t.path, slug), PR_WAIT), text);
      };
      await intent(t.path, "merged", `status: merge-review\nnote: ${PR_APPROVE_NOTE}`);
      await wait("merged", behind);
      await intent(t.path, "elsewhere", "status: merge-review\nnote: Main has my migration in progress.");
      await wait("elsewhere", PR_MERGED_ELSEWHERE);
      await intent(t.path, "open", `status: merge-review\nnote: ${PR_APPROVE_NOTE}`);
      // A risky change's note is the merge gate's too: the pull request's wait stands in for it.
      const risky = "This change touches files set to need a person before merging: package.json. Approve the pull request on GitHub, or set status to merge-approved. To stop this change, set it to closed.";
      await intent(t.path, "risky", `status: merge-review\nmerge_gate: pr\nnote: "${risky}"`);
      await wait("risky", behind);
      // Left by an earlier build's pull request: no longer shown once the change moved on.
      await intent(t.path, "rebuilt", "status: building");
      await wait("rebuilt", behind);
      const text = await renderStatus(t.path, 1000);
      const [block = "", table = ""] = text.split("\n\nChange");
      const row = (slug: string) => table.split("\n").find((l) => l.startsWith(slug)) ?? "";
      // Its pull request merged: nothing for the person on it, and the gate's note is out of date.
      expect(row("merged")).toContain(behind);
      expect(row("merged")).not.toContain(PR_APPROVE_NOTE);
      expect(block).not.toContain("(merged)");
      // A person's own note stays beside the wait.
      expect(row("elsewhere")).toContain(`${PR_MERGED_ELSEWHERE} Main has my migration in progress.`);
      expect(block).toContain(`- Waiting for you (elsewhere): ${PR_MERGED_ELSEWHERE}`);
      expect(block).toContain(`- Waiting for you (open): ${PR_APPROVE_NOTE}`);
      expect(row("rebuilt")).not.toContain(behind);
      expect(row("risky")).toContain(behind);
      expect(row("risky")).not.toContain("package.json");
    } finally {
      t.cleanup();
    }
  });

  test("never pads the last column, and wraps long notes to the width", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "quiet", "status: building");
      const long = "The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change.";
      await intent(t.path, "stuck", `status: blocked\nnote: "${long}"`);
      const text = await renderStatus(t.path, 100);
      const lines = text.trimEnd().split("\n");
      for (const l of lines) {
        expect(l).toBe(l.trimEnd());
        expect(l.length).toBeLessThanOrEqual(100);
      }
      // The note continues on the next lines, under its own column.
      const noteAt = lines.find((l) => l.startsWith("Change"))!.indexOf("Note");
      const at = lines.findIndex((l) => l.startsWith("stuck"));
      expect(lines[at]!.slice(noteAt)).toStartWith("The reviewer");
      expect(lines[at + 1]!.slice(0, noteAt).trim()).toBe("");
      expect(lines.slice(at).map((l) => l.slice(noteAt)).join(" ")).toContain("An engineer needs to look at the change.");
    } finally {
      t.cleanup();
    }
  });
});

describe("attention", () => {
  test("a change with an open question is in the list as Has a question, with what was asked", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "a", "status: designing\nquestion: open");
      await intent(t.path, "b", "status: planning\nquestion: open");
      await intent(t.path, "c", "status: building\nquestion: open");
      await intent(t.path, "d", "status: closed\nquestion: open");
      const state = (open: Record<string, unknown>) => JSON.stringify({ status: "designing", count: 1, open: { traceName: "x", seq: 1, sessionId: null, at: "2026-10-17T12:00:00.000Z", ...open } });
      mkdirSync(join(t.path, ".loopstra", "runs", "a"), { recursive: true });
      await Bun.write(join(t.path, ".loopstra", "runs", "a", "question.json"), state({ phase: "design", text: "Archived too?", why: "The list hides them.", options: ["yes", "no"] }));
      mkdirSync(join(t.path, ".loopstra", "runs", "b"), { recursive: true });
      await Bun.write(join(t.path, ".loopstra", "runs", "b", "question.json"), state({ phase: "plan", text: "One table or two?", why: "", options: [] }));
      const trace = Trace.open(t.path, () => {});
      try {
        const items = await attention(t.path, await loadConfig(t.path), trace, new Date());
        expect(items.filter((i) => i.kind === "question")).toEqual([
          { kind: "question", label: "Has a question", slug: "a", title: "a", what: "design asks: Archived too? Why: The list hides them. Options: yes · no. Answer it in the console, or tell the orchestrator." },
          { kind: "question", label: "Has a question", slug: "b", title: "b", what: "plan asks: One table or two? Answer it in the console, or tell the orchestrator." },
          { kind: "question", label: "Has a question", slug: "c", title: "c", what: "Read conversation.md for the question. Answer it in the console, or tell the orchestrator." },
        ]);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("a held change is in the list as Held, with why; a person's pause of the loop is there too", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "a", "status: building\nhold: waiting for legal (John, the dashboard)");
      await intent(t.path, "d", "status: done\nhold: left over");
      holdLoop(t.path, "John");
      // An outage's pause as well: two items, never one key.
      pauseAfterUnavailable(t.path);
      const trace = Trace.open(t.path, () => {});
      try {
        const items = await attention(t.path, await loadConfig(t.path), trace, new Date());
        expect(items.filter((i) => i.kind === "held")).toEqual([{
          kind: "held", label: "Held", slug: "a", title: "a",
          what: "Held: waiting for legal (John, the dashboard). The loop starts no step for it until it is released, in the console or by removing the hold line from intent.md.",
        }]);
        expect(items[0]).toEqual({
          kind: "paused", label: "Paused", slug: null, title: "Paused by John",
          what: "Nothing new starts until it is resumed. Resume it in the console, or delete .loopstra/hold.json.",
        });
        const paused = items.filter((i) => i.kind === "paused");
        expect(paused.map((i) => i.title)).toEqual(["Paused by John", "Loopstra is paused"]);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("GitHub not answering is in the list only while a change watches its pull request", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "a", "status: merged");
      const trace = Trace.open(t.path, () => {});
      try {
        recordGitHub(trace, "HTTP 401: Bad credentials");
        const github = async () => (await attention(t.path, await loadConfig(t.path), trace, new Date(Date.now() + 20 * 60_000))).filter((i) => i.label === "GitHub");
        // The last look failed, then the change left merge-review: nothing asks GitHub any more.
        expect(await github()).toEqual([]);
        await intent(t.path, "a", "status: merge-review");
        expect((await github()).length).toBe(1);
        // gh's words without the request id that changes every call, and a title that does not repeat the label.
        recordGitHub(trace, "GraphQL: Something went wrong. Please include `C8F2:3A9B:1D2E3F:4A5B6C:6713F0A2` when reporting this issue.");
        expect(await github()).toEqual([{
          kind: "sync", label: "GitHub", slug: null, title: "Not answering",
          what: "GitHub hasn't answered for 15 minutes: GraphQL: Something went wrong. Please include `…` when reporting this issue.",
        }]);
        await intent(t.path, "a", "status: merge-approved");
        expect((await github()).length).toBe(1);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("attention and standards", () => {
  const SENTENCE = "loopstra/standards/soc2.md cannot be read: ";
  const STOP = " Fix it on main and commit; until then no change moves on.";
  const commit = async (root: string, text: string) => {
    mkdirSync(join(root, "loopstra", "standards"), { recursive: true });
    await Bun.write(join(root, "loopstra", "standards", "soc2.md"), text);
    await new Git(root).commitAll("standards");
  };

  test("attention lists unreadable standards", async () => {
    const t = await tempGitRepo();
    try {
      await config(t.path);
      await commit(t.path, "# SOC 2\n\nWhy.\n");
      const trace = Trace.open(t.path, () => {});
      try {
        const items = (await attention(t.path, await loadConfig(t.path), trace, new Date())).filter((i) => i.kind === "standards");
        expect(items).toHaveLength(1);
        expect(items[0]!.what.startsWith(SENTENCE)).toBe(true);
        expect(items[0]!.what.endsWith(STOP)).toBe(true);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("attention clears once main is fixed", async () => {
    const t = await tempGitRepo();
    try {
      await config(t.path);
      await commit(t.path, "# SOC 2\n\nWhy.\n");
      const trace = Trace.open(t.path, () => {});
      try {
        const cfg = await loadConfig(t.path);
        expect((await attention(t.path, cfg, trace)).some((i) => i.kind === "standards")).toBe(true);
        await commit(t.path, "# SOC 2\n\nWhy.\n\n## Rules\n- SEC-1: Secrets stay out of the repo.\n");
        expect((await attention(t.path, cfg, trace)).some((i) => i.kind === "standards")).toBe(false);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("a change's unreadable standards.md is listed, naming the change", async () => {
    const t = await tempGitRepo();
    try {
      await config(t.path);
      await commit(t.path, "# SOC 2\n\nWhy.\n\n## Rules\n- SEC-1: Secrets stay out of the repo.\n");
      await intent(t.path, "a", "status: building");
      await Bun.write(join(t.path, "intent", "a", "standards.md"), "# Standards\n\n## Added\n- nope: x (J, from console, 2026-10-28)\n");
      const trace = Trace.open(t.path, () => {});
      try {
        const items = (await attention(t.path, await loadConfig(t.path), trace)).filter((i) => i.kind === "standards");
        expect(items).toHaveLength(1);
        expect(items[0]!.slug).toBe("a");
        expect(items[0]!.what).toContain("nope, which is not a standard on main");
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("a change waiting on an exception is labelled with the rule", async () => {
    const t = await tempGitRepo();
    try {
      await config(t.path);
      await commit(t.path, "# SOC 2\n\n## Rules\n- SEC-1: Secrets stay out of the repo.\n- ARCH-1: Billing goes through the gateway.\n");
      await intent(t.path, "a", "status: plan-review\nplan_gate: status\nnote: The plan asks for an exception.");
      await Bun.write(join(t.path, "intent", "a", "plan.md"), "# Plan\n\n## Standards\n- SEC-1: kept\n- ARCH-1: exception: billing reads the orders table\n");
      await intent(t.path, "b", "status: plan-review\nplan_gate: status");
      await Bun.write(join(t.path, "intent", "b", "plan.md"), "# Plan\n\n## Standards\n- ARCH-1: exception: billing reads the orders table\n");
      await Bun.write(join(t.path, "intent", "b", "standards.md"), "# Standards decisions for b\n\n## Exceptions approved\n- ARCH-1 at the spec: billing reads the orders table (J., from the console, 2026-10-28)\n");
      const trace = Trace.open(t.path, () => {});
      try {
        const items = (await attention(t.path, await loadConfig(t.path), trace)).filter((i) => i.kind === "waiting");
        expect(items.map((i) => [i.slug, i.label, i.what])).toEqual([
          ["a", "Waiting for you: exception to ARCH-1", "The plan asks for an exception."],
          ["b", "Waiting for you", "Read plan.md. When you are happy with it, change the status line to plan-approved. To stop this change, set it to closed."],
        ]);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("with no standards on main, a wait is not labelled with an exception", async () => {
    const t = await tempGitRepo();
    try {
      await config(t.path);
      await intent(t.path, "a", "status: plan-review\nplan_gate: status\nnote: Read plan.md.");
      await Bun.write(join(t.path, "intent", "a", "plan.md"), "# Plan\n\n## Standards\n- ARCH-1: exception: billing reads the orders table\n");
      await new Git(t.path).commitAll("a");
      const trace = Trace.open(t.path, () => {});
      try {
        const items = (await attention(t.path, await loadConfig(t.path), trace)).filter((i) => i.kind === "waiting");
        expect(items.map((i) => i.label)).toEqual(["Waiting for you"]);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });

  test("a standard named in a change's record and then deleted from main is listed, not dropped", async () => {
    const t = await tempGitRepo();
    try {
      await config(t.path);
      await commit(t.path, "# SOC 2\n\n## Rules\n- SEC-1: Secrets stay out of the repo.\n");
      await Bun.write(join(t.path, "loopstra", "standards", "payments.md"), "# Payments\n\n## Rules\n- PAY-1: Card data goes through the vault.\n");
      await intent(t.path, "a", "status: building");
      await Bun.write(join(t.path, "intent", "a", "standards.md"), "# Standards decisions for a\n\n## Added\n- payments: card data passes through (J., from the console, 2026-10-28)\n");
      await new Git(t.path).commitAll("payments");
      const trace = Trace.open(t.path, () => {});
      try {
        const listed = async () => (await attention(t.path, await loadConfig(t.path), trace)).filter((i) => i.kind === "standards").map((i) => i.what);
        expect(await listed()).toEqual([]);
        await new Git(t.path).run(["rm", "-q", "loopstra/standards/payments.md"]);
        await new Git(t.path).commitAll("drop payments");
        expect(await listed()).toEqual(["standards.md names payments, which is not a standard on main."]);
      } finally {
        trace.close();
      }
    } finally {
      t.cleanup();
    }
  });
});
