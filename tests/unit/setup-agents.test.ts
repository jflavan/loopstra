import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { agents } from "../../src/setup/sections/agents";
import { tempDir, withEnv, write } from "../helpers";
import { askSection, checkSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

const agentText = (name: string) => `---\nname: ${name}\ndescription: Does ${name}\n---\nYou are ${name}.\n`;

const dirs: Array<{ cleanup: () => void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()!.cleanup(); });

/** A repo with only the config (and these files), and an empty home folder. */
function world(yaml = BASE, files: Record<string, string> = {}, homeFiles: Record<string, string> = {}) {
  const r = configRepo(yaml);
  const home = tempDir("loopstra-home-");
  dirs.push(r, home);
  for (const [path, text] of Object.entries(files)) write(join(r.root, path), text);
  for (const [path, text] of Object.entries(homeFiles)) write(join(home.path, path), text);
  return { ...r, home: home.path };
}

/** askSection with HOME (and USERPROFILE) set to `home`. */
function asked(w: { root: string; home: string }, answers: string[] | "defaults", only = true) {
  return withEnv({ HOME: w.home, USERPROFILE: w.home }, () => askSection(agents, w.root, answers, {}, { only }));
}

describe("the agents section", () => {
  test("in a full setup the section asks first and changes nothing on no", async () => {
    const w = world();
    const no = await asked(w, ["n"], false);
    expect(no.text).toBe(BASE);
    expect(no.shown).toContain("Set up agents for the loop's steps now?");
    expect(no.shown).not.toContain("Which step to set up");
    expect((await asked(w, "defaults", false)).text).toBe(BASE);
    // Alone under --defaults, it asks its questions and still changes nothing.
    const alone = await asked(w, "defaults", true);
    expect(alone.text).toBe(BASE);
    expect(alone.shown).not.toContain("Set up agents for the loop's steps now?");
    expect(alone.shown).toContain("No agents or skills found yet.");
  });

  test("a step's agent, subagents and skills are written; none removes them; an emptied step is removed", async () => {
    const w = world(BASE, { ".claude/agents/lead.md": agentText("lead"), ".claude/skills/house/SKILL.md": "---\ndescription: House style\n---\nBody\n" });
    // sources; step; agent; add an agent first?; subagents; (no teams); add a skill first?; skills; tools; MCP tools; done.
    const first = await asked(w, ["", "review", "lead", "n", "Explore", "n", "house", "-", "-", "done"]);
    expect(first.shown).toContain("agent lead (repo): Does lead");
    expect(first.shown).toContain("skill house (repo): House style");
    expect(parse(first.text).agents).toEqual({ steps: { review: { agent: "lead", subagents: ["Explore"], skills: ["house"] } } });
    // The same answers again change nothing.
    expect((await asked(w, ["", "review", "", "n", "", "n", "", "", "", "done"])).text).toBe(first.text);
    const second = await asked(w, ["", "review", "none", "n", "-", "n", "-", "-", "-", "done"]);
    expect(second.text).toBe(BASE);
  });

  test("sources repo is written; all is the default and is not", async () => {
    const w = world();
    const { text, shown } = await asked(w, ["repo", "done"]);
    expect(shown).toContain("repo: only what the repository declares");
    expect(parse(text).agents).toEqual({ sources: "repo" });
  });

  test("tools are refused in words on a read-only step, and MCP tools must be MCP rules", async () => {
    const w = world();
    const { text, shown } = await asked(w, ["", "review", "", "n", "", "n", "", "Edit", "Read, Grep", "github", "mcp__github", "done"]);
    expect(shown).toContain("review is read-only; Edit would let it change files.");
    expect(shown).toContain("github must be an MCP rule, like mcp__github or mcp__github__get_issue.");
    expect(parse(text).agents).toEqual({ steps: { review: { tools: ["Read", "Grep"], mcp_tools: ["mcp__github"] } } });
  });

  test("for all steps, tools reach read-only steps too; git that changes history is refused everywhere", async () => {
    const w = world();
    const { text, shown } = await asked(w, ["", "all steps", "", "n", "", "n", "", "Write", "Bash(git push *)", "WebFetch", "-", "done"]);
    expect(shown).toContain("these reach read-only steps too; Write would let them change files.");
    expect(shown).toContain("only Loopstra commits, branches, merges and pushes; git push is not allowed.");
    expect(parse(text).agents).toEqual({ all: { tools: ["WebFetch"] } });
  });

  test("fix runs as the build's agent, and a chat step says who can steer its tools", async () => {
    const w = world();
    // fix: no agent question. orchestrator: the agent question, then the rest.
    const { text, shown } = await asked(w, ["", "fix", "n", "", "n", "", "WebFetch", "-", "orchestrator", "", "n", "", "n", "", "-", "-", "done"]);
    expect(shown).toContain("fix continues the build's session, so it runs as the build's agent.");
    expect(shown).not.toContain("Agent the fix step runs as");
    expect(shown).toContain("Agent the orchestrator step runs as");
    expect(shown).toContain("anyone allowed to chat can steer the tools and MCP tools you give it");
    expect(parse(text).agents).toEqual({ steps: { fix: { tools: ["WebFetch"] } } });
  });

  test("adding a skill from this machine copies it into the repo after the config saves", async () => {
    const w = world(BASE, {}, { ".claude/skills/tone/SKILL.md": "---\ndescription: Tone\n---\nBody\n" });
    const { text, shown, files } = await asked(w, ["", "build", "", "n", "", "y", "from this machine", "tone", "tone", "-", "-", "done"]);
    expect(shown).toContain("skill tone (personal): Tone");
    expect(shown).toContain(".claude/skills/tone/SKILL.md");
    expect(shown).toContain(".claude/skills/tone/SOURCE.md");
    expect(files).toEqual([".claude/skills/tone/SKILL.md", ".claude/skills/tone/SOURCE.md"]);
    expect(readFileSync(join(w.root, ".claude/skills/tone/SOURCE.md"), "utf8")).toMatch(/^Copied from .*tone on \d{4}-\d{2}-\d{2}\.\n$/);
    expect(parse(text).agents).toEqual({ steps: { build: { skills: ["tone"] } } });
  });

  test("a new agent from the short form is written and becomes the step's agent", async () => {
    const w = world();
    const { text, shown, files } = await asked(w, [
      "", "build", "add one", "a new agent", "Bad Name", "general-purpose", "builder", "Builds things: carefully", "You build things well.", "Read, Edit", "-",
      "builder", "n", "", "n", "", "-", "-", "done",
    ]);
    expect(shown).toContain("A name is lowercase letters, digits and dashes, like lead-reviewer.");
    expect(shown).toContain("There is already an agent called general-purpose.");
    expect(files).toEqual([".claude/agents/builder.md"]);
    const file = readFileSync(join(w.root, ".claude/agents/builder.md"), "utf8");
    expect(parse(file.split("---\n")[1]!)).toEqual({ name: "builder", description: "Builds things: carefully", tools: "Read, Edit" });
    expect(file).toEndWith("---\nYou build things well.\n");
    expect(parse(text).agents).toEqual({ steps: { build: { agent: "builder" } } });
  });

  test("- at the new agent's name goes back without adding anything", async () => {
    const w = world();
    const { text, files } = await asked(w, ["", "build", "add one", "a new agent", "-", "none", "n", "", "n", "", "-", "-", "done"]);
    expect(files).toEqual([]);
    expect(text).toBe(BASE);
  });

  test("names and refusals from a fetched source reach the terminal without control characters", async () => {
    if (process.platform === "win32") return;
    const src = tempDir("loopstra-src-");
    dirs.push(src);
    write(join(src.path, "skills/good/SKILL.md"), "---\ndescription: Good\n---\nBody\n");
    write(join(src.path, "skills/evil/SKILL.md"), "---\nname: \"ev\\e[2Jil\"\ndescription: Evil\n---\nBody\n");
    write(join(src.path, "skills/good/a\u001b[2Jb.md"), "x");
    const w = world();
    const { text, shown, files } = await asked(w, ["", "build", "", "n", "", "y", "from a git repository or folder", src.path, "good", "", "-", "-", "done"]);
    expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(shown).toContain("Skipped 1 skill whose name is not lowercase letters, digits and dashes.");
    expect(shown).toContain("a [2Jb.md has a backslash or control character in its name.");
    expect(shown).toContain("Which skills to copy (any of good, separated");
    expect(files).toEqual([]);
    expect(text).toBe(BASE);
  });

  test("a team can be called constructor", async () => {
    const w = world(BASE, { ".claude/agents/sec.md": agentText("sec") });
    const { text } = await asked(w, ["", "teams", "new team", "constructor", "n", "sec", "", "done", "done"]);
    expect(parse(text).agents).toEqual({ teams: { constructor: { members: ["sec"] } } });
  });

  test("a skill from a folder replaces the repo's own when confirmed, removing its old files, and records where it came from", async () => {
    const src = tempDir("loopstra-src-");
    dirs.push(src);
    write(join(src.path, "skills/house/SKILL.md"), "---\nname: house\ndescription: New house style\n---\nNew\n");
    const w = world(BASE, { ".claude/skills/house/SKILL.md": "---\ndescription: Old\n---\nOld\n", ".claude/skills/house/old.md": "old\n" });
    // A refused replace adds nothing; then the same again, confirmed.
    const answers = ["", "build", "", "n", "", "y", "from a git repository or folder", src.path, "house", "n", "", "-", "-", "build", "", "n", "", "y", "from a git repository or folder", src.path, "house", "y", "house", "-", "-", "done"];
    const { text, shown, files } = await asked(w, answers);
    expect(shown).toContain("skill house (source): New house style");
    expect(shown).toContain("Replace the existing skill house?");
    expect(shown).toContain(".claude/skills/house/old.md");
    expect(files.sort()).toEqual([".claude/skills/house/SKILL.md", ".claude/skills/house/SOURCE.md", ".claude/skills/house/old.md"]);
    expect(existsSync(join(w.root, ".claude/skills/house/old.md"))).toBe(false);
    expect(readFileSync(join(w.root, ".claude/skills/house/SKILL.md"), "utf8")).toContain("New");
    expect(readFileSync(join(w.root, ".claude/skills/house/SOURCE.md"), "utf8")).toStartWith(`Copied from ${src.path} (skills/house) on `);
    expect(parse(text).agents).toEqual({ steps: { build: { skills: ["house"] } } });
  });

  test("a team is made and used, and cannot be deleted while used", async () => {
    const w = world(BASE, { ".claude/agents/sec.md": agentText("sec"), ".claude/agents/perf.md": agentText("perf") });
    const made = await asked(w, [
      "", "teams", "new team", "Bad", "reviewers", "n", "-", "sec, perf", "pick", "done",
      "review", "", "n", "", "reviewers", "n", "", "-", "-",
      "teams", "reviewers", "delete", "done", "done",
    ]);
    expect(made.shown).toContain("A team name is lowercase words joined by dashes, like reviewers.");
    expect(made.shown).toContain("A team needs at least one member.");
    expect(made.shown).toContain("The team reviewers is used by review: take it off review first.");
    expect(parse(made.text).agents).toEqual({
      teams: { reviewers: { members: ["perf", "sec"], way: "pick" } },
      steps: { review: { teams: ["reviewers"] } },
    });
    // Taken off the step, it can be deleted, and nothing is left.
    const gone = await asked(w, ["", "review", "", "n", "", "-", "n", "", "-", "-", "teams", "reviewers", "delete", "done", "done"]);
    expect(gone.text).toBe(BASE);
  });

  test("check: missing agents fail, machine-only names warn, nothing set is silent", async () => {
    const yaml = `${BASE}agents:\n  steps:\n    review:\n      agent: lead\n      subagents: [ghost, mine]\n`;
    const w = world(yaml, { ".claude/agents/lead.md": agentText("lead") }, { ".claude/agents/mine.md": agentText("mine") });
    const checks = await withEnv({ HOME: w.home, USERPROFILE: w.home }, () => checkSection(agents, w.root));
    expect(checks).toEqual([
      { level: "fail", text: expect.stringContaining("`ghost`, a subagent of review, is not in .claude/agents/") },
      { level: "warn", text: expect.stringContaining("`mine` (review) is only on this machine") },
    ]);

    const fine = world(`${BASE}agents:\n  steps:\n    review:\n      agent: lead\n      subagents: [Explore]\n`, { ".claude/agents/lead.md": agentText("lead") });
    expect(await withEnv({ HOME: fine.home, USERPROFILE: fine.home }, () => checkSection(agents, fine.root))).toEqual([{ level: "ok", text: "Every agent the steps name is in place." }]);

    const none = world();
    expect(await withEnv({ HOME: none.home, USERPROFILE: none.home }, () => checkSection(agents, none.root))).toEqual([]);

    // What all steps get is told once, not once per step.
    const shared = world(`${BASE}agents:\n  all:\n    subagents: [ghost]\n`);
    expect(await withEnv({ HOME: shared.home, USERPROFILE: shared.home }, () => checkSection(agents, shared.root))).toEqual([
      { level: "fail", text: expect.stringContaining("`ghost`, a subagent of every step (agents.all), is not in .claude/agents/") },
    ]);
  });
});
