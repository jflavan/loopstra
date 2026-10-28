import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../../src/console/hub";
import { serveConsole } from "../../src/console/server";
import type { ChangeDetail, DraftChecked, ExceptionRow, ScopeRow, StandardsView, TriedCheck } from "../../src/console/types";
import { Git } from "../../src/git";
import { pendingRequests } from "../../src/requests";
import { fileVersion } from "../../src/settings";
import { chatRepo, INTENT } from "../chat-helpers";
import { until } from "../console-helpers";
import { tempDir, write } from "../helpers";

const SECURITY = (check: string) => `---\napplies_to: ["src/**"]\nneeds_person: true\ncheck: ${JSON.stringify(check)}\n---\n# Security\n\n## Rules\n- SEC-1: Validate input.\n- SEC-2: No secrets in code.\n`;
const STYLE = "# Style\n\n## Rules\n- STY-1: Keep functions short.\n";

/** A console on a repository whose main holds two standards, a source file, and three changes (one with a plan, one done). */
async function withStandards(fn: (base: string, root: string, sentinel: string) => Promise<void>, o: { standards?: boolean } = {}) {
  const sentinelDir = tempDir("loopstra-sentinel-");
  const sentinel = join(sentinelDir.path, "ran");
  const r = await chatRepo({ intents: { alpha: INTENT("building", "Alpha"), beta: INTENT("planning", "Beta"), gamma: INTENT("done", "Gamma") } });
  if (o.standards !== false) {
    write(join(r.root, "loopstra/standards/security.md"), SECURITY(`echo ran > ${JSON.stringify(sentinel + ".own")}`));
    write(join(r.root, "loopstra/standards/style.md"), STYLE);
    write(join(r.root, "loopstra/standards/notes.txt"), "not a standard");
  }
  write(join(r.root, "src/pay.ts"), "export {};\n");
  write(join(r.root, "src/my file.ts"), "export {};\n");
  write(join(r.root, "docs/a.md"), "# a\n");
  write(join(r.root, "intent/alpha/plan.md"), "# Plan\n\n## Files that change\n- `src/pay.ts`: pay\n");
  await new Git(r.root).commitAll("standards");
  const hub = new Hub(r.root);
  const server = serveConsole(r.root, 0, { hub });
  try {
    await fn(`http://127.0.0.1:${server.port}`, r.root, sentinel);
  } finally {
    await server.stop(true);
    await until(() => hub.latest() === null);
    await hub.whenStopped();
    sentinelDir.cleanup();
    r.cleanup();
  }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });

describe("the standards routes", () => {
  test("GET /api/standards lists each standard with its scope, matches, rules, open changes and version", async () => {
    await withStandards(async (base, root) => {
      const view = await (await fetch(`${base}/api/standards`)).json() as StandardsView;
      expect(view.problems).toEqual([]);
      expect(view.ignored).toEqual(["loopstra/standards/notes.txt"]);
      expect(view.uncommitted).toEqual([]);
      expect(view.standards.map((s) => s.name)).toEqual(["security", "style"]);
      const [sec, style] = view.standards;
      expect(sec).toMatchObject({ path: "loopstra/standards/security.md", title: "Security", scope: "Files matching src/**", matches: 2, needsPerson: true, rules: [{ label: "SEC-1", text: "Validate input." }, { label: "SEC-2", text: "No secrets in code." }] });
      expect(sec!.check).toContain("echo ran");
      // alpha's plan names src/pay.ts; beta has no plan, so only the standards for every change count; gamma is done.
      expect(sec!.inProgress).toEqual(["alpha"]);
      expect(style).toMatchObject({ scope: "Every change", matches: null, needsPerson: false, check: null, inProgress: ["alpha", "beta"] });
      expect(sec!.version).toBe(fileVersion(sec!.text));
      expect(sec!.text).toBe(await Bun.file(join(root, sec!.path)).text());

      write(join(root, "loopstra/standards/style.md"), `${STYLE}\n`);
      expect((await (await fetch(`${base}/api/standards`)).json() as StandardsView).uncommitted).toEqual(["loopstra/standards/style.md"]);
    });
  });

  test("a merge gate's marker decides what applies to an open change", async () => {
    await withStandards(async (base, root) => {
      mkdirSync(join(root, ".loopstra/runs/beta"), { recursive: true });
      write(join(root, ".loopstra/runs/beta/standards.applied"), JSON.stringify({ commit: "x", applying: [{ name: "security", why: "files", files: ["src/pay.ts"] }] }));
      const view = await (await fetch(`${base}/api/standards`)).json() as StandardsView;
      expect(view.standards.find((s) => s.name === "security")!.inProgress).toEqual(["alpha", "beta"]);
      expect(view.standards.find((s) => s.name === "style")!.inProgress).toEqual(["alpha"]);
    });
  });

  test("a repository without standards has an empty view", async () => {
    await withStandards(async (base) => {
      expect(await (await fetch(`${base}/api/standards`)).json()).toEqual({ standards: [], problems: [], ignored: [], uncommitted: [] });
    }, { standards: false });
  });

  test("a wrong Host is refused on every route, and a POST from a foreign Origin too", async () => {
    await withStandards(async (base) => {
      for (const path of ["/api/standards", "/api/standards/exceptions"]) expect((await fetch(base + path, { headers: { host: "evil.test" } })).status).toBe(403);
      for (const path of ["/api/standards/check", "/api/standards/try", "/api/standards/scope"]) {
        expect((await post(base, path, {}, { host: "evil.test" })).status).toBe(403);
        expect((await post(base, path, {}, { origin: "http://evil.example" })).status).toBe(403);
        expect((await fetch(base + path)).status).toBe(405);
      }
    });
  });

  test("check returns problems, matches with samples, and the draft both as Markdown and as a form", async () => {
    await withStandards(async (base) => {
      const text = "---\napplies_to: [\"src/**\", \"docs/*.md\", \"nothing/**\"]\n---\n# Perf\n\n## Rules\n- PERF-1: Measure first.\n";
      const r = await (await post(base, "/api/standards/check", { name: "perf", text })).json() as DraftChecked;
      expect(r.problems).toEqual([]);
      expect(r.text).toBe(text);
      expect(r.matches).toEqual([
        { pattern: "src/**", count: 2, sample: ["src/my file.ts", "src/pay.ts"] },
        { pattern: "docs/*.md", count: 1, sample: ["docs/a.md"] },
        { pattern: "nothing/**", count: 0, sample: [] },
      ]);
      expect(r.form).toMatchObject({ name: "perf", title: "Perf", patterns: ["src/**", "docs/*.md", "nothing/**"], rules: [{ label: "PERF-1", text: "Measure first." }] });

      // The form goes to Markdown through the server, and reads back the same.
      const viaForm = await (await post(base, "/api/standards/check", { name: "perf", form: r.form })).json() as DraftChecked;
      expect(viaForm.problems).toEqual([]);
      expect(viaForm.form).toEqual(r.form);
      expect(viaForm.text).toContain("# Perf");
      const again = await (await post(base, "/api/standards/check", { name: "perf", text: viaForm.text })).json() as DraftChecked;
      expect(again.form).toEqual(r.form);
    });
  });

  test("check refuses a draft whose label another file already uses, but not the file it replaces", async () => {
    await withStandards(async (base) => {
      const clash = "# Perf\n\n## Rules\n- SEC-1: Mine now.\n";
      const r = await (await post(base, "/api/standards/check", { name: "perf", text: clash })).json() as DraftChecked;
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatchObject({ path: "loopstra/standards/perf.md", text: expect.stringContaining("SEC-1") as string });
      expect(r.form).toBeNull();
      // Replacing security with its own labels is not a clash with itself.
      const own = await (await post(base, "/api/standards/check", { name: "security", text: SECURITY("true") })).json() as DraftChecked;
      expect(own.problems).toEqual([]);
      // An unreadable draft is a problem in words, and no form comes back for text.
      const bad = await (await post(base, "/api/standards/check", { name: "perf", text: "no title\n" })).json() as DraftChecked;
      expect(bad.problems.length).toBeGreaterThan(0);
      expect(bad.form).toBeNull();
    });
  });

  test("check refuses a bad name, a missing body and a form of the wrong shape", async () => {
    await withStandards(async (base) => {
      expect((await post(base, "/api/standards/check", { name: "Bad Name", text: STYLE })).status).toBe(400);
      expect((await post(base, "/api/standards/check", { name: "ok" })).status).toBe(400);
      expect((await post(base, "/api/standards/check", { name: "ok", form: { name: "ok" } })).status).toBe(400);
    });
  });

  test("try runs only the named standard's check, never a command it was sent, and leaves the repository as it was", async () => {
    await withStandards(async (base, root, sentinel) => {
      const before = (await new Git(root).run(["status", "--porcelain", "--ignored=no"])).out;
      const r = await (await post(base, "/api/standards/try", { name: "security", command: `touch ${JSON.stringify(sentinel + ".sent")}`, check: "touch nope" })).json() as TriedCheck;
      expect(r.ok).toBe(true);
      expect(existsSync(`${sentinel}.own`)).toBe(true);
      expect(existsSync(`${sentinel}.sent`)).toBe(false);
      expect((await new Git(root).run(["status", "--porcelain", "--ignored=no"])).out).toBe(before);

      // A draft's own check runs, not the saved one's and not one beside it.
      const draft = SECURITY(`echo draft > ${JSON.stringify(sentinel + ".draft")}`);
      const d = await (await post(base, "/api/standards/try", { name: "security", text: draft, command: `touch ${JSON.stringify(sentinel + ".sent")}` })).json() as TriedCheck;
      expect(d.ok).toBe(true);
      expect(existsSync(`${sentinel}.draft`)).toBe(true);
      expect(existsSync(`${sentinel}.sent`)).toBe(false);
    });
  });

  test("try refuses a standard that is not there, a draft with no check and a draft that does not read", async () => {
    await withStandards(async (base) => {
      expect((await post(base, "/api/standards/try", { name: "ghost" })).status).toBe(404);
      expect((await post(base, "/api/standards/try", { name: "style" })).status).toBe(400);
      expect((await post(base, "/api/standards/try", { name: "perf", text: "# Perf\n\n## Rules\n- PERF-1: x.\n" })).status).toBe(400);
      const bad = await post(base, "/api/standards/try", { name: "perf", text: "no title\n" });
      expect(bad.status).toBe(409);
    });
  });

  test("try reports a failing check with its last lines and the warning for main", async () => {
    await withStandards(async (base) => {
      const text = SECURITY("echo broken; exit 3");
      const r = await (await post(base, "/api/standards/try", { name: "security", text })).json() as TriedCheck;
      expect(r).toMatchObject({ ok: false, code: 3, timedOut: false, lastLines: "broken" });
      expect(r.failsOnMain).toContain("fails on main already");
    });
  });

  test("exceptions reads every change's record, newest first", async () => {
    await withStandards(async (base, root) => {
      write(join(root, "intent/alpha/standards.md"), "# Standards decisions for alpha\n\n## Added\n- style: wanted here (J., from the console, 2026-10-20)\n\n## Exceptions approved\n- SEC-1 at the spec: legacy code (J., from the console, 2026-10-22)\n");
      write(join(root, "intent/beta/standards.md"), "# Standards decisions for beta\n\n## Removed\n- security: docs only (A., from intent.md, 2026-10-25)\n\n## Exceptions approved\n- STY-1 at the plan: generated (A., from the console, 2026-10-26)\n");
      write(join(root, "intent/gamma/standards.md"), "# Standards decisions for gamma\n\n## Exceptions approved\n- SEC-2 at the spec: vendored (J., from the console, 2026-10-24)\n");
      const r = await (await fetch(`${base}/api/standards/exceptions`)).json() as { exceptions: ExceptionRow[]; scope: ScopeRow[] };
      expect(r.exceptions.map((e) => [e.slug, e.label, e.gate, e.date])).toEqual([["beta", "STY-1", "plan", "2026-10-26"], ["gamma", "SEC-2", "spec", "2026-10-24"], ["alpha", "SEC-1", "spec", "2026-10-22"]]);
      expect(r.exceptions[0]).toEqual({ label: "STY-1", title: "Style", standard: "style", change: "Beta", slug: "beta", reason: "generated", by: "A.", via: "the console", date: "2026-10-26", gate: "plan" });
      expect(r.scope).toEqual([
        { name: "security", title: "Security", change: "Beta", slug: "beta", action: "removed", note: "docs only", by: "A.", via: "intent.md", date: "2026-10-25" },
        { name: "style", title: "Style", change: "Alpha", slug: "alpha", action: "added", note: "wanted here", by: "J.", via: "the console", date: "2026-10-20" },
      ]);
    });
  });

  test("an exception or scope row of a standard no longer on main shows the label alone", async () => {
    await withStandards(async (base, root) => {
      write(join(root, "intent/alpha/standards.md"), "# x\n\n## Added\n- gone: was wanted (J., from the console, 2026-10-20)\n\n## Exceptions approved\n- OLD-1 at the spec: legacy (J., from the console, 2026-10-22)\n");
      const r = await (await fetch(`${base}/api/standards/exceptions`)).json() as { exceptions: ExceptionRow[]; scope: ScopeRow[] };
      expect(r.exceptions[0]).toMatchObject({ label: "OLD-1", title: "", standard: "", change: "Alpha", slug: "alpha" });
      expect(r.scope[0]).toMatchObject({ name: "gone", title: "", change: "Alpha" });
    });
  });

  test("the view's problems include open changes' unreadable standards.md and a check whose program is not installed", async () => {
    await withStandards(async (base, root) => {
      write(join(root, "intent/alpha/standards.md"), "# x\n\n## Added\n- ghost: gone (J., from the console, 2026-10-20)\nstray prose\n");
      write(join(root, "intent/gamma/standards.md"), "stray prose in a done change\n");
      write(join(root, "loopstra/standards/tools.md"), "---\ncheck: no-such-program-xyz --all\n---\n# Tools\n\n## Rules\n- TOOL-1: Run it.\n");
      await new Git(root).commitAll("tools");
      const view = await (await fetch(`${base}/api/standards`)).json() as StandardsView;
      expect(view.problems.some((p) => p.startsWith("alpha: ") && p.includes("ghost"))).toBe(true);
      expect(view.problems.some((p) => p.startsWith("alpha: ") && p.includes("stray prose"))).toBe(true);
      expect(view.problems.some((p) => p.startsWith("gamma"))).toBe(false);
      expect(view.problems).toContain("The check of Tools runs no-such-program-xyz, which is not installed on this machine, so the check cannot run here.");
      expect(view.problems.some((p) => p.includes("Security"))).toBe(false);
    });
  });

  test("try takes a form as check does", async () => {
    await withStandards(async (base, _root, sentinel) => {
      const form = { name: "perf", title: "Perf", patterns: [], needsPerson: false, check: `echo f > ${sentinel}.form`, rules: [{ label: "PERF-1", text: "Measure." }], context: "" };
      const r = await (await post(base, "/api/standards/try", { name: "perf", form })).json() as TriedCheck;
      expect(r.ok).toBe(true);
      expect(existsSync(`${sentinel}.form`)).toBe(true);
    });
  });

  test("scope submits a standards-scope request for an open change and refuses what the loop would", async () => {
    await withStandards(async (base, root) => {
      const ok = await post(base, "/api/standards/scope", { slug: "beta", action: "add", name: "security" });
      expect(ok.status).toBe(202);
      const sent = await ok.json() as { id: string };
      const q = pendingRequests(root).find((x) => x.id === sent.id);
      expect(q).toMatchObject({ kind: "standards-scope", slug: "beta", expect: "planning", action: "add", name: "security", note: "" });

      expect((await post(base, "/api/standards/scope", { slug: "beta", action: "remove", name: "security" })).status).toBe(400);
      expect((await post(base, "/api/standards/scope", { slug: "beta", action: "remove", name: "security", note: "docs only" })).status).toBe(202);
      expect((await post(base, "/api/standards/scope", { slug: "gamma", action: "add", name: "security" })).status).toBe(409);
      expect((await post(base, "/api/standards/scope", { slug: "nobody", action: "add", name: "security" })).status).toBe(404);
      expect((await post(base, "/api/standards/scope", { slug: "beta", action: "add", name: "ghost" })).status).toBe(404);
      expect((await post(base, "/api/standards/scope", { slug: "beta", action: "toggle", name: "security" })).status).toBe(400);
    });
  });
});

describe("a change's standards panel", () => {
  test("carries what applies, each rule's spec and plan answers, findings, results and the record", async () => {
    await withStandards(async (base, root) => {
      write(join(root, "intent/alpha/spec.md"), "# Spec\n\n## Standards\n- SEC-1: validated at the edge.\n- SEC-2: Exception: a vendored key in a test.\n- STY-1: Does not apply: no code.\n");
      write(join(root, "intent/alpha/plan.md"), "# Plan\n\n## Files that change\n- `src/pay.ts`: pay\n\n## Standards\n- SEC-1: zod at the route.\n- SEC-2: Exception: a vendored key in a test.\n");
      write(join(root, "intent/alpha/review.md"), "Fine.\n\n## Findings against the standards\n- important · SEC-1 · src/pay.ts:42: input not checked\n- minor · STY-1 · src/pay.ts:0: long function\n");
      write(join(root, "intent/alpha/outcome.md"), "## Standards\n- SEC-1 (Security): met: zod\n- SEC-2 (Security): exception, approved by J. at the spec: vendored\n");
      write(join(root, "intent/alpha/standards.md"), "# Standards decisions for alpha\n\n## Added\n- ghost: gone later (J., from the console, 2026-10-20)\n");
      const { Trace } = await import("../../src/trace");
      const trace = Trace.open(root);
      trace.gate("alpha", "merge", "check:security", "pass", "ok");
      trace.close();
      const d = await (await fetch(`${base}/api/changes/alpha`)).json() as ChangeDetail;
      const s = d.standards!;
      expect(s.applying.map((a) => [a.name, a.title])).toEqual([["security", "Security"], ["style", "Style"]]);
      const sec = s.applying[0]!;
      expect(sec.why).toContain("src/pay.ts");
      expect(s.applying[1]!.why).toBe("It applies to every change.");
      expect(sec.check).toBe("pass: ok");
      expect(sec.rules[0]).toEqual({ label: "SEC-1", text: "Validate input.", spec: "validated at the edge.", plan: "zod at the route.", findings: ["important · src/pay.ts:42: input not checked"], result: "met" });
      expect(sec.rules[1]).toMatchObject({ label: "SEC-2", spec: "Exception: a vendored key in a test.", findings: [], result: "exception" });
      expect(s.applying[1]!.rules[0]).toMatchObject({ label: "STY-1", spec: "Does not apply: no code.", findings: ["minor · src/pay.ts:0: long function"] });
      // Both exceptions wait: nothing approved yet; the same one at the plan is listed once.
      expect(s.waiting).toEqual([{ label: "SEC-2", kind: "exception", text: "a vendored key in a test." }]);
      // A standard named in the record that main does not have is a problem, not a crash.
      expect(s.record.added).toEqual([]);
      expect(s.record.problems.join(" ")).toContain("ghost");
    });
  });

  test("why comes from the merge gate's marker files, and from who added a standard", async () => {
    await withStandards(async (base, root) => {
      mkdirSync(join(root, ".loopstra/runs/beta"), { recursive: true });
      write(join(root, ".loopstra/runs/beta/standards.applied"), JSON.stringify({ commit: "x", applying: [{ name: "security", why: "files", files: ["src/my file.ts"] }, { name: "style", why: "every", files: [] }] }));
      write(join(root, "intent/beta/standards.md"), "# x\n\n## Added\n- style: also (Ann, from the console, 2026-10-20)\n");
      const d = await (await fetch(`${base}/api/changes/beta`)).json() as ChangeDetail;
      expect(d.standards!.applying[0]!.why).toBe("The change touches src/my file.ts.");
      mkdirSync(join(root, ".loopstra/runs/alpha"), { recursive: true });
      write(join(root, ".loopstra/runs/alpha/standards.applied"), JSON.stringify({ commit: "x", applying: [{ name: "style", why: "every", files: [] }] }));
      write(join(root, "intent/alpha/standards.md"), "# x\n\n## Added\n- security: also (Ann, from the console, 2026-10-20)\n");
      const a = await (await fetch(`${base}/api/changes/alpha`)).json() as ChangeDetail;
      expect(a.standards!.applying.map((x) => [x.name, x.why])).toEqual([["style", "It applies to every change."], ["security", "Added by Ann."]]);
    });
  });

  test("is absent when the repository has no standards", async () => {
    await withStandards(async (base) => {
      const d = await (await fetch(`${base}/api/changes/alpha`)).json() as ChangeDetail;
      expect(d).not.toHaveProperty("standards");
    }, { standards: false });
  });
});
