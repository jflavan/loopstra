import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRequests } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { Hub } from "../../src/console/hub";
import { serveConsole } from "../../src/console/server";
import type { AgentsView } from "../../src/console/types";
import { Git } from "../../src/git";
import { pendingRequests, type Request } from "../../src/requests";
import { configVersion, fileVersion } from "../../src/settings";
import { Trace } from "../../src/trace";
import { chatRepo } from "../chat-helpers";
import { until } from "../console-helpers";
import { lastCommit, setEnv, tempDir, write } from "../helpers";

const agentText = (name: string) => `---\nname: ${name}\ndescription: Does ${name}\n---\nYou are ${name}.\n`;
const LEAD = ".claude/agents/lead.md";
/** The loop's and the console's words for a file that is not the version the page read. */
const STALE = "The settings changed since the page read them";

const CONFIG = `stages:
  review:
    skills: [house]
agents:
  teams:
    reviewers: { members: [lead, Explore], way: pick }
  all:
    skills: [tone]
  steps:
    build:
      agent: lead
    review:
      agent: lead
      teams: [reviewers]
    plan:
      subagents: [ghost]
`;

/**
 * A console on a git repository whose config sets agents up, with a committed agent `lead` (used),
 * `spare` (unused) and skill `house`, and a home folder holding a personal agent `mine` and skill
 * `tone` (with two more files). Stopped, its hub let go and HOME put back before it is removed.
 */
async function withAgentsConsole(fn: (base: string, root: string, home: string) => Promise<void>) {
  const r = await chatRepo({ config: CONFIG });
  const home = tempDir("loopstra-home-");
  const restore = setEnv({ HOME: home.path, USERPROFILE: home.path });
  write(join(r.root, LEAD), agentText("lead"));
  write(join(r.root, ".claude/agents/spare.md"), agentText("spare"));
  write(join(r.root, ".claude/skills/house/SKILL.md"), "---\nname: house\ndescription: House style\n---\nBody\n");
  await new Git(r.root).commitAll("agents");
  write(join(home.path, ".claude/agents/mine.md"), agentText("mine"));
  write(join(home.path, ".claude/skills/tone/SKILL.md"), "---\ndescription: Tone\n---\nBody\n");
  write(join(home.path, ".claude/skills/tone/scripts/run.sh"), "echo hi\n");
  write(join(home.path, ".claude/skills/tone/references/a.md"), "ref\n");
  const hub = new Hub(r.root);
  const server = serveConsole(r.root, 0, { hub });
  try {
    await fn(`http://127.0.0.1:${server.port}`, r.root, home.path);
  } finally {
    await server.stop(true);
    await until(() => hub.latest() === null);
    await hub.whenStopped();
    restore();
    home.cleanup();
    r.cleanup();
  }
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/agents/files`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });

/** How the page itself reads: a current browser says the request is from the same origin. */
const PAGE = { headers: { "sec-fetch-site": "same-origin" } };

type FilesRequest = Extract<Request, { kind: "agent-files" }>;
const filesRequests = (root: string) => pendingRequests(root).filter((q): q is FilesRequest => q.kind === "agent-files");

async function applyAll(root: string): Promise<void> {
  const trace = Trace.open(root, () => {});
  try { await applyRequests(root, await loadConfig(root), trace); } finally { trace.close(); }
}

/** The temporary folders a clone left in `dir`. */
const clones = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("loopstra-source-"));

/** A git repository in a new folder holding an agent `x` and a skill `y`. */
async function sourceRepo(): Promise<{ path: string; cleanup: () => void }> {
  const src = tempDir("loopstra-src-");
  write(join(src.path, "agents/x.md"), agentText("x"));
  write(join(src.path, "skills/y/SKILL.md"), "---\nname: y\ndescription: Why\n---\nBody\n");
  write(join(src.path, "skills/y/notes.md"), "notes\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "c"]]) {
    const p = Bun.spawnSync(["git", ...args], { cwd: src.path });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  }
  return src;
}

describe("the agents view", () => {
  test("GET /api/agents shows each step's own, inherited and stage values, the library and problems", async () => {
    await withAgentsConsole(async (base, root) => {
      const view = await (await fetch(`${base}/api/agents`)).json() as AgentsView;
      expect(view.version).toBe(configVersion(readFileSync(join(root, "loopstra/config.yaml"), "utf8")));
      expect(view.problem).toBeNull();
      expect(view.sources).toBe("all");
      expect(view.builtins).toContain("Explore");
      expect(view.ways).toEqual(["parallel", "pick"]);

      expect(view.steps[0]).toEqual({ key: "all", what: expect.any(String) as string, readOnly: true, chat: false, continuesBuild: false, own: { skills: ["tone"] }, fromAll: {}, fromStage: [] });
      const row = (key: string) => view.steps.find((s) => s.key === key)!;
      expect(view.steps.slice(1).map((s) => s.key)).toEqual(["intake", "design", "spec-check", "plan", "plan-challenge", "acceptance", "build", "reconcile", "fix", "review", "revise", "resolve", "verify", "done-check", "lessons", "orchestrator", "write-intent"]);
      expect(row("review")).toMatchObject({ readOnly: true, chat: false, continuesBuild: false, own: { agent: "lead", teams: ["reviewers"] }, fromAll: { skills: ["tone"] }, fromStage: ["house"] });
      expect(row("fix")).toMatchObject({ readOnly: false, continuesBuild: true, own: {}, fromAll: { skills: ["tone"] }, fromStage: [] });
      // Chat steps take nothing from all steps.
      expect(row("orchestrator")).toMatchObject({ chat: true, own: {}, fromAll: {}, fromStage: [] });

      expect(view.teams).toEqual([{ name: "reviewers", members: ["lead", "Explore"], way: "pick", usedBy: ["agents.steps.review"] }]);

      const item = (kind: string, name: string) => view.library.find((i) => i.kind === kind && i.name === name);
      const leadText = readFileSync(join(root, LEAD), "utf8");
      expect(item("agent", "lead")).toEqual({ kind: "agent", name: "lead", description: "Does lead", from: "repo", usedBy: ["agents.steps.build", "agents.steps.review", "team reviewers"], base: fileVersion(leadText), editable: true, text: leadText });
      expect(item("agent", "spare")).toMatchObject({ from: "repo", usedBy: [], editable: true });
      expect(item("skill", "house")).toMatchObject({ from: "repo", usedBy: ["stages.review"], editable: false, base: fileVersion("---\nname: house\ndescription: House style\n---\nBody\n") });
      expect(item("skill", "house")).not.toHaveProperty("text");
      expect(item("skill", "tone")).toMatchObject({ from: "personal", description: "Tone", usedBy: ["agents.all"], editable: false });
      expect(item("agent", "mine")).toMatchObject({ from: "personal", usedBy: [], editable: false });

      expect(view.problems).toContainEqual({ level: "fail", step: "plan", name: "ghost", text: expect.stringContaining("`ghost`") as string });
      // tone comes to every step from all steps: it is told once, under all.
      expect(view.problems.filter((x) => x.name === "tone")).toEqual([{ level: "warn", step: "all", name: "tone", text: "`tone` (all steps) is only on this machine, so a loop running elsewhere will not have it." }]);

      // A repo agent whose name the edit operation would not take is shown, but not offered for editing.
      write(join(root, ".claude/agents/Odd_Name.md"), agentText("odd"));
      const odd = (await (await fetch(`${base}/api/agents`)).json() as AgentsView).library.find((i) => i.name === "Odd_Name");
      expect(odd).toMatchObject({ from: "repo", editable: false });
      expect(odd).not.toHaveProperty("text");

      // A config that does not load says why, in words, and shows nothing to edit.
      writeFileSync(join(root, "loopstra/config.yaml"), "version: 1\ncommands:\n  test: echo ok\nagents:\n  sources: nowhere\n");
      const broken = await (await fetch(`${base}/api/agents`)).json() as AgentsView;
      expect(broken.problem).toContain("agents.sources");
      expect(broken.version).toBe(configVersion(readFileSync(join(root, "loopstra/config.yaml"), "utf8")));
      expect(broken.steps).toEqual([]);
      expect(broken.library).toEqual([]);
    });
  }, 30_000);
});

describe("agent file operations", () => {
  test("POST /api/agents/files copy submits an agent-files request with the skill's files and absent bases", async () => {
    await withAgentsConsole(async (base, root) => {
      const r = await post(base, { op: "copy", kind: "skill", name: "tone", from: "personal" });
      expect(r.status).toBe(202);
      const answer = await r.json() as { id: string; loop: string };
      expect(answer.loop).toBeString();
      const [q] = filesRequests(root);
      expect(q!.id).toBe(answer.id);
      expect(q!.what).toBe("add skill tone (4 files)");
      expect(q!.writes.map((w) => w.path).sort()).toEqual([".claude/skills/tone/SKILL.md", ".claude/skills/tone/SOURCE.md", ".claude/skills/tone/references/a.md", ".claude/skills/tone/scripts/run.sh"]);
      expect(q!.base).toEqual(Object.fromEntries(q!.writes.map((w) => [w.path, "absent"])));
      expect(q!.via).toBe("the dashboard");

      // The loop commits it; a second copy is refused while the skill is there, unless it replaces it.
      await applyAll(root);
      expect(await lastCommit(root)).toContain("loopstra(_settings): add skill tone (4 files) by");
      expect(readFileSync(join(root, ".claude/skills/tone/scripts/run.sh"), "utf8")).toBe("echo hi\n");
      const again = await post(base, { op: "copy", kind: "skill", name: "tone", from: "personal" });
      expect(again.status).toBe(409);
      expect((await again.json() as { error: string }).error).toContain("There is already a skill called tone in the repo");
      expect(filesRequests(root)).toEqual([]);
      // A replacement names the version of SKILL.md the page read, and is refused when it is stale.
      const replace = { op: "copy", kind: "skill", name: "tone", from: "personal", replace: true };
      expect((await post(base, replace)).status).toBe(400);
      const stale = await post(base, { ...replace, base: fileVersion("an older SKILL.md") });
      expect(stale.status).toBe(409);
      expect((await stale.json() as { error: string }).error).toContain(STALE);
      expect(filesRequests(root)).toEqual([]);
      const view = await (await fetch(`${base}/api/agents`)).json() as AgentsView;
      const read = view.library.find((i) => i.from === "repo" && i.name === "tone")!.base;
      const replaced = await post(base, { ...replace, base: read });
      expect(replaced.status).toBe(202);
      const [r2] = filesRequests(root);
      expect(r2!.what).toBe("replace skill tone (4 files)");
      expect(r2!.base[".claude/skills/tone/SKILL.md"]).toBe(read);
      expect(r2!.base[".claude/skills/tone/scripts/run.sh"]).toBe(fileVersion("echo hi\n"));

      // Something that is not on this machine, or a copy copyItem refuses.
      expect((await post(base, { op: "copy", kind: "agent", name: "nobody", from: "personal" })).status).toBe(404);
      write(join(process.env.HOME!, ".claude/agents/Bad_Name.md"), agentText("bad"));
      const bad = await post(base, { op: "copy", kind: "agent", name: "Bad_Name", from: "personal" });
      expect(bad.status).toBe(409);
      expect((await bad.json() as { error: string }).error).toContain("is not a name Loopstra copies");
    });
  }, 30_000);

  test("POST /api/agents/files remove is refused while a step uses the agent", async () => {
    await withAgentsConsole(async (base, root) => {
      const used = await post(base, { op: "remove", kind: "agent", name: "lead", base: fileVersion(agentText("lead")) });
      expect(used.status).toBe(409);
      const { error } = await used.json() as { error: string };
      expect(error).toContain("agents.steps.review");
      expect(error).toContain("team reviewers");
      const skill = await post(base, { op: "remove", kind: "skill", name: "house", base: "absent" });
      expect(skill.status).toBe(409);
      expect((await skill.json() as { error: string }).error).toContain("stages.review");
      expect(filesRequests(root)).toEqual([]);

      // A remove names the version the page read: without one it is not well formed, and a stale one is refused.
      const remove = { op: "remove", kind: "agent", name: "spare" };
      expect((await post(base, remove)).status).toBe(400);
      const stale = await post(base, { ...remove, base: fileVersion("an older spare") });
      expect(stale.status).toBe(409);
      expect((await stale.json() as { error: string }).error).toContain(STALE);
      expect(filesRequests(root)).toEqual([]);
      const spare = await post(base, { ...remove, base: fileVersion(agentText("spare")) });
      expect(spare.status).toBe(202);
      const [q] = filesRequests(root);
      expect(q).toMatchObject({ what: "remove .claude/agents/spare.md", writes: [{ path: ".claude/agents/spare.md", content: null }], base: { ".claude/agents/spare.md": fileVersion(agentText("spare")) } });
      expect((await post(base, { op: "remove", kind: "agent", name: "nobody", base: "absent" })).status).toBe(404);
    });
  }, 30_000);

  test("new and edit: names are checked, an edit names the version it read, and stale or uncommitted files are refused", async () => {
    await withAgentsConsole(async (base, root) => {
      const form = { op: "new", name: "critic", description: "Finds faults: all of them", prompt: "You find faults.", tools: ["Read", "Grep"], model: null };
      for (const name of ["Critic", "-x", "Explore", "a/b"]) {
        const r = await post(base, { ...form, name });
        expect({ name, status: r.status }).toEqual({ name, status: 400 });
      }
      expect(await (await post(base, { ...form, name: "Critic" })).json()).toEqual({ error: "An agent name is lowercase letters, digits and dashes (at most 64), like lead-reviewer." });
      // A new agent never replaces one: a clash says to pick another name or edit it, replace or not.
      const clash = await post(base, { ...form, name: "lead" });
      expect(clash.status).toBe(409);
      expect(await clash.json()).toEqual({ error: "There is already an agent called lead in the repo. Pick another name, or edit the existing agent." });
      const lead0 = (await (await fetch(`${base}/api/agents`)).json() as AgentsView).library.find((i) => i.name === "lead")!;
      expect((await post(base, { ...form, name: "lead", replace: true, base: lead0.base })).status).toBe(409);
      expect((await post(base, { ...form, model: "two words" })).status).toBe(400);
      expect((await post(base, { ...form, tools: ["Read, Grep"] })).status).toBe(400);
      expect(filesRequests(root)).toEqual([]);
      expect((await post(base, form)).status).toBe(202);
      const [made] = filesRequests(root);
      expect(made).toMatchObject({ what: "add .claude/agents/critic.md", base: { ".claude/agents/critic.md": "absent" } });
      expect(made!.writes[0]!.content).toContain("description: \"Finds faults: all of them\"");
      expect(made!.writes[0]!.content).toContain("tools: Read, Grep");

      const view = await (await fetch(`${base}/api/agents`)).json() as AgentsView;
      const lead = view.library.find((i) => i.name === "lead")!;
      const edit = { op: "edit", name: "lead", text: `${lead.text!}More.\n`, base: lead.base };
      expect((await post(base, { ...edit, base: fileVersion("something else") })).status).toBe(409);
      expect((await post(base, { ...edit, name: "nobody" })).status).toBe(404);
      expect((await post(base, edit)).status).toBe(202);
      expect(filesRequests(root).find((q) => q.what === `edit ${LEAD}`)).toMatchObject({ writes: [{ path: LEAD, content: edit.text }], base: { [LEAD]: lead.base } });

      // A file with uncommitted changes is refused at once, as the loop would refuse it.
      writeFileSync(join(root, LEAD), `${lead.text!}Mine.\n`);
      const dirty = await post(base, { ...edit, base: fileVersion(`${lead.text!}Mine.\n`) });
      expect(dirty.status).toBe(409);
      expect((await dirty.json() as { error: string }).error).toContain("not committed");
      // So is a target behind a link.
      const outside = tempDir("loopstra-outside-");
      try {
        mkdirSync(join(outside.path, "linked"), { recursive: true });
        symlinkSync(join(outside.path, "linked"), join(root, ".claude/skills/linked"));
        const r = await post(base, { op: "remove", kind: "skill", name: "linked", base: "absent" });
        expect(r.status).toBe(409);
        expect((await r.json() as { error: string }).error).toContain("link");
      } finally {
        outside.cleanup();
      }
    });
  }, 30_000);

  test("GET /api/agents/source lists what a file:// repository holds and leaves no temp folder", async () => {
    const src = await sourceRepo();
    const tmp = tempDir("loopstra-tmp-");
    const restore = setEnv({ TMPDIR: tmp.path, TMP: tmp.path, TEMP: tmp.path });
    try {
      await withAgentsConsole(async (base, root) => {
        const url = `file://${src.path}`;
        const listed = await fetch(`${base}/api/agents/source?url=${encodeURIComponent(url)}`, PAGE);
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({ items: [{ kind: "agent", name: "x", description: "Does x" }, { kind: "skill", name: "y", description: "Why" }] });
        expect(clones(tmp.path)).toEqual([]);

        // Another site's link or image cannot start a clone.
        expect((await fetch(`${base}/api/agents/source?url=${encodeURIComponent(url)}`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
        const bad = await fetch(`${base}/api/agents/source?url=${encodeURIComponent("ftp://x")}`, PAGE);
        expect(bad.status).toBe(409);
        expect(await bad.json()).toEqual({ error: expect.stringContaining("neither a folder nor a URL") as string });
        expect((await fetch(`${base}/api/agents/source`, PAGE)).status).toBe(400);

        // Fetching the picked items clones again, copies them with their source, and removes the clone.
        const r = await post(base, { op: "fetch", url, names: ["y"], kind: "skill" });
        expect(r.status).toBe(202);
        const [q] = filesRequests(root);
        expect(q!.what).toBe("add skill y (3 files)");
        expect(q!.writes.find((w) => w.path === ".claude/skills/y/SOURCE.md")!.content).toContain(`Copied from ${url} (skills/y)`);
        expect(clones(tmp.path)).toEqual([]);
        expect((await post(base, { op: "fetch", url, names: ["zzz"], kind: "skill" })).status).toBe(404);
        // A replacing fetch names the version it read of each item; a stale one is refused.
        expect((await post(base, { op: "fetch", url, names: ["y"], kind: "skill", replace: true })).status).toBe(400);
        const stale = await post(base, { op: "fetch", url, names: ["y"], kind: "skill", replace: true, base: { y: fileVersion("a SKILL.md the repo never had") } });
        expect(stale.status).toBe(409);
        expect((await stale.json() as { error: string }).error).toContain(STALE);
        expect(clones(tmp.path)).toEqual([]);
      });
    } finally {
      restore();
      tmp.cleanup();
      src.cleanup();
    }
  }, 30_000);

  test("a write without the page's Origin is refused (403)", async () => {
    await withAgentsConsole(async (base, root) => {
      const op = { op: "remove", kind: "agent", name: "spare", base: fileVersion(agentText("spare")) };
      expect((await post(base, op, { origin: "http://evil.example" })).status).toBe(403);
      expect((await post(base, op, { origin: "" })).status).toBe(403);
      expect((await fetch(`${base}/api/agents/files`, { method: "POST", headers: { origin: base, "content-type": "text/plain" }, body: JSON.stringify(op) })).status).toBe(415);
      expect((await fetch(`${base}/api/agents/files`)).status).toBe(405);
      expect((await post(base, { op: "launch" })).status).toBe(400);
      expect(filesRequests(root)).toEqual([]);
      expect(existsSync(join(root, ".claude/agents/spare.md"))).toBe(true);
    });
  }, 30_000);
});
