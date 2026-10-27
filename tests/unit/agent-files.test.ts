import { expect, test } from "bun:test";
import { join } from "node:path";
import { findAgent, findSkill, inlineAgents, parseAgentFile } from "../../src/agent-files";
import { tempDir, write } from "../helpers";

test("an agent file parses with CRLF, a tools string, and unknown keys dropped", () => {
  const d = parseAgentFile("lead", "---\r\nname: lead\r\ndescription: Leads\r\ntools: Read, Grep\r\nmodel: opus\r\npermissionMode: bypassPermissions\r\nhooks: {}\r\n---\r\nYou lead.\r\n", "repo", "/r/.claude/agents/lead.md");
  expect(d).toMatchObject({ description: "Leads", prompt: "You lead.", tools: ["Read", "Grep"], model: "opus", dropped: ["permissionMode", "hooks"] });
  expect(parseAgentFile("x", "Just a prompt.\n", "repo", "p")).toMatchObject({ description: "", prompt: "Just a prompt.", tools: null, model: null, dropped: [] });
});

test("findAgent looks in the repo, then the user's folder, then installed and enabled plugins", async () => {
  const t = tempDir(); const repo = join(t.path, "repo"); const home = join(t.path, "home");
  write(join(repo, ".claude/agents/lead.md"), "---\ndescription: repo lead\n---\nR");
  write(join(home, ".claude/agents/lead.md"), "---\ndescription: home lead\n---\nH");
  write(join(home, ".claude/agents/mine.md"), "---\ndescription: mine\n---\nM");
  const plug = join(home, "plugins-cache/sp");
  write(join(plug, "agents/code-reviewer.md"), "---\ndescription: cr\n---\nC");
  write(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sp@market": [{ scope: "user", installPath: plug }] } }));
  write(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sp@market": true } }));
  const all = { repo, home, sources: "all" as const };
  expect((await findAgent("lead", all))?.description).toBe("repo lead");
  expect((await findAgent("mine", all))?.from).toBe("personal");
  expect((await findAgent("sp:code-reviewer", all))?.from).toBe("plugin");
  expect(await findAgent("mine", { ...all, sources: "repo" })).toBeNull();
  write(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sp@market": false } }));
  expect(await findAgent("sp:code-reviewer", all)).toBeNull();
  t.cleanup();
});

test("findSkill looks in the same places, and a missing or broken file is not a throw", async () => {
  const t = tempDir(); const repo = join(t.path, "repo"); const home = join(t.path, "home");
  write(join(repo, ".claude/skills/a/SKILL.md"), "A");
  write(join(home, ".claude/skills/b/SKILL.md"), "B");
  const plug = join(home, "cache/sp");
  write(join(plug, "skills/tdd/SKILL.md"), "T");
  write(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "sp@market": [{ installPath: plug }] } }));
  write(join(home, ".claude/settings.json"), "{ not json");
  const all = { repo, home, sources: "all" as const };
  expect(await findSkill("a", all)).toBe("repo");
  expect(await findSkill("b", all)).toBe("personal");
  expect(await findSkill("sp:tdd", all)).toBeNull();
  write(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sp@market": true } }));
  expect(await findSkill("sp:tdd", all)).toBe("plugin");
  expect(await findSkill("b", { ...all, sources: "repo" })).toBeNull();
  expect(await findSkill("nope", all)).toBeNull();
  t.cleanup();
});

test("inline agents: loopstra names, StructuredOutput for the main agent, its model left to the step", () => {
  const lead = parseAgentFile("lead", "---\ndescription: L\ntools: [Read]\nmodel: opus\n---\nP", "repo", "p");
  const sec = parseAgentFile("sec", "---\ndescription: S\nmodel: haiku\n---\nQ", "repo", "p");
  expect(inlineAgents(lead, [sec])).toEqual({
    "loopstra-lead": { description: "L", prompt: "P", tools: ["Read", "StructuredOutput"] },
    "loopstra-sec": { description: "S", prompt: "Q", model: "haiku" },
  });
});
