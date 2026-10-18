import { describe, expect, test } from "bun:test";
import { askText, doneWords, offers, questionChangedText, requestLabel, resultText, retryTargets, sameQuestion, targetOf, undoAllowed, undoMatches } from "../../src/actions";
import { humanGates, parseIntentFile, type Frontmatter } from "../../src/intents";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

const fm = (status: string, more = ""): Frontmatter => parseIntentFile(`---\nstatus: ${status}\n${more}---\n# Intent: x\n`).frontmatter;
const everyone = { spec: "status", plan: "status", merge: "status", done: "status" } as const;
const nobody = humanGates(null);
const kinds = (o: Array<{ kind: string }>) => o.map((x) => x.kind);

describe("what a change offers", () => {
  test("a review with a person on its gate offers approve and send back; with nobody, neither", () => {
    expect(kinds(offers(fm("plan-review"), everyone, []))).toEqual(["approve", "send-back", "hold", "priority", "close"]);
    expect(offers(fm("plan-review"), everyone, [])[0]).toEqual({ kind: "approve", label: "Approve the plan", to: "plan-approved" });
    expect(kinds(offers(fm("plan-review"), nobody, []))).toEqual(["hold", "priority", "close"]);
    expect(offers(fm("verifying"), everyone, [])[0]).toEqual({ kind: "approve", label: "Confirm it is done", to: "done" });
    expect(kinds(offers(fm("verifying"), everyone, []))).not.toContain("send-back");
  });

  test("a draft offers start; a blocked change offers one retry per target; finished changes offer nothing", () => {
    expect(kinds(offers(fm("draft"), everyone, []))).toEqual(["accept", "priority", "close"]);
    expect(offers(fm("blocked"), everyone, ["plan-approved", "accepted"]).filter((o) => o.kind === "retry")).toEqual([
      { kind: "retry", label: "Retry from plan-approved", to: "plan-approved" },
      { kind: "retry", label: "Retry from accepted", to: "accepted" },
    ]);
    expect(offers(fm("done"), everyone, [])).toEqual([]);
    expect(offers(fm("closed"), everyone, [])).toEqual([]);
  });

  test("a held change offers release instead of hold, even a draft or a blocked one held by hand", () => {
    expect(kinds(offers(fm("building", "hold: x\n"), everyone, []))).toEqual(["release", "priority", "close"]);
    expect(kinds(offers(fm("draft", "hold: x\n"), everyone, []))).toContain("release");
    expect(offers(fm("closed"), everyone, []).length).toBe(0);
    expect(offers(fm("building"), everyone, []).find((o) => o.kind === "close")).toEqual({ kind: "close", label: "Close", to: "closed", confirm: true });
  });
});

describe("a waiting question", () => {
  test("a change with an open question offers answer first; one without, none", () => {
    expect(offers(fm("designing", "question: open\n"), everyone, [])[0]).toEqual({ kind: "answer", label: "Answer" });
    expect(kinds(offers(fm("designing", "question: open\n"), everyone, []))).toEqual(["answer", "hold", "priority", "close"]);
    expect(kinds(offers(fm("designing"), everyone, []))).not.toContain("answer");
    expect(kinds(offers(fm("closed", "question: open\n"), everyone, []))).not.toContain("answer");
  });
});

describe("retry targets", () => {
  test("the block's own status first, then each status a sentence about the status names; never draft, blocked, done or closed", () => {
    expect(retryTargets("The spec did not pass its automatic check. Set status to spec-approved to accept the spec as it is, or to accepted to write it again.", null)).toEqual(["spec-approved", "accepted"]);
    expect(retryTargets("The build broke. When that is sorted out, set status to plan-approved to try again.", "plan-approved")).toEqual(["plan-approved"]);
    expect(retryTargets("Set status back to an earlier approved state, or to closed.", null)).toEqual([]);
    expect(retryTargets("It waits to be merged into building soon.", null)).toEqual([]);
    expect(retryTargets("", "merge-approved")).toEqual(["merge-approved"]);
  });
});

describe("where an action leads, and undo", () => {
  test("targets", () => {
    expect(targetOf({ kind: "approve", expect: "spec-review" })).toBe("spec-approved");
    expect(targetOf({ kind: "send-back", expect: "merge-review" })).toBe("plan-approved");
    expect(targetOf({ kind: "retry", expect: "blocked", to: "accepted" })).toBe("accepted");
    expect(targetOf({ kind: "close", expect: "building" })).toBe("closed");
    expect(targetOf({ kind: "undo", expect: "plan-approved", to: "plan-review" })).toBe("plan-review");
    expect(targetOf({ kind: "accept", expect: "draft" })).toBe("accepted");
    expect(targetOf({ kind: "approve", expect: "building" })).toBeNull();
  });

  test("undo only goes back from what approve or send back set, to the review it came from", () => {
    expect(undoAllowed("plan-approved", "plan-review")).toBe(true);
    expect(undoAllowed("accepted", "spec-review")).toBe(true);
    expect(undoAllowed("done", "verifying")).toBe(true);
    expect(undoAllowed("plan-approved", "merge-review")).toBe(true);
    expect(undoAllowed("building", "plan-review")).toBe(false);
    expect(undoAllowed("closed", "building")).toBe(false);
  });

  test("an undo matches only the step that really happened last", () => {
    const dir = tempDir();
    const trace = Trace.open(dir.path, () => {});
    try {
      // Nothing happened yet: nothing to undo.
      expect(undoMatches(trace, "a", "plan-approved", "plan-review")).toBe(false);
      trace.statusChange("a", "plan-review", "plan-approved", "");
      expect(undoMatches(trace, "a", "plan-approved", "plan-review")).toBe(true);
      // A pair undoAllowed accepts, but not what happened: it would jump the change forward.
      expect(undoMatches(trace, "a", "plan-approved", "merge-review")).toBe(false);
      expect(undoMatches(trace, "b", "plan-approved", "plan-review")).toBe(false);
      // A later step happened since: the approve is no longer the last step.
      trace.statusChange("a", "plan-approved", "building", "");
      expect(undoMatches(trace, "a", "plan-approved", "plan-review")).toBe(false);
    } finally {
      trace.close();
      dir.cleanup();
    }
  });
});

describe("words", () => {
  test("commit words, labels, questions and results", () => {
    expect(doneWords({ kind: "approve", expect: "plan-review" })).toBe("plan approved");
    expect(doneWords({ kind: "send-back", expect: "merge-review" })).toBe("build sent back");
    expect(doneWords({ kind: "priority", expect: "building", priority: "high" })).toBe("priority set to high");
    expect(doneWords({ kind: "undo", expect: "plan-approved", to: "plan-review" })).toBe("undone, back to plan-review");
    expect(requestLabel({ kind: "approve", expect: "spec-review" })).toBe("Approve the spec");
    expect(requestLabel({ kind: "hold", expect: "building" })).toBe("Hold");
    expect(askText({ kind: "approve", expect: "plan-review" }, "csv-export")).toBe("Approve the plan of csv-export?");
    expect(askText({ kind: "close", expect: "building" }, "csv-export")).toBe("Close csv-export? It stops for good.");
    // The model's own words, quoted on their own lines: the person says yes to exactly what goes on.
    expect(askText({ kind: "send-back", expect: "plan-review", note: " Split step 3. " }, "csv-export")).toBe("Send csv-export back, so its plan is done again, with this note?\n\nSplit step 3.");
    expect(askText({ kind: "hold", expect: "building", reason: "Waiting on legal." }, "csv-export")).toBe("Hold csv-export, so the loop starts no step for it, with this reason?\n\nWaiting on legal.");
    expect(askText({ kind: "hold", expect: "building", reason: "" }, "csv-export")).toBe("Hold csv-export, so the loop starts no step for it?");
    expect(resultText({ kind: "approve", expect: "plan-review" }, "csv-export", "plan-approved")).toBe("Plan approved: csv-export is now plan approved, waiting to build.");
    expect(resultText({ kind: "hold", expect: "building" }, "csv-export", "building")).toBe("csv-export is held: the loop starts no step for it until it is released.");
    expect(doneWords({ kind: "answer", expect: "designing" })).toBe("question answered");
    expect(requestLabel({ kind: "answer", expect: "designing" })).toBe("Answer");
    expect(askText({ kind: "answer", expect: "designing", note: " Leave them out. " }, "csv-export")).toBe("Send this answer to csv-export's waiting question?\n\nLeave them out.");
    expect(askText({ kind: "answer", expect: "designing", note: "Leave them out.", asked: " Archived\n too? " }, "csv-export")).toBe("Send this answer to csv-export's question \"Archived too?\"?\n\nLeave them out.");
    // An answer names the question it answers; an older one, naming none, goes to whichever waits.
    expect(sameQuestion("2026-10-17T12:00:00.000Z", "2026-10-17T12:00:00.000Z")).toBe(true);
    expect(sameQuestion("2026-10-17T12:00:00.000Z", "2026-10-17T13:00:00.000Z")).toBe(false);
    expect(sameQuestion("2026-10-17T12:00:00.000Z", undefined)).toBe(false);
    expect(sameQuestion(undefined, "2026-10-17T13:00:00.000Z")).toBe(true);
    expect(questionChangedText("csv-export")).toBe("csv-export's question changed since; nothing changed. Read the new one.");
    expect(resultText({ kind: "answer", expect: "designing" }, "csv-export", "designing")).toBe("csv-export has its answer; the loop goes on with it.");
  });
});
