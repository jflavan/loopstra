import { afterEach, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentFile } from "../../src/agent-files";
import { cloneSource, copyItem, listLibrary, newAgentFile, repoPath, scanFolder, type FileWrite, type LibraryItem } from "../../src/agent-library";
import { tempDir, write } from "../helpers";

const dirs: Array<{ cleanup: () => void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()!.cleanup(); });
function temp(): string { const t = tempDir("loopstra-lib-"); dirs.push(t); return t.path; }

const agentText = (name: string) => `---\nname: ${name}\ndescription: Does ${name}\n---\nYou are ${name}.\n`;

function world() {
  const t = temp();
  const repo = join(t, "repo");
  const home = join(t, "home");
  write(join(repo, ".claude/agents/lead.md"), agentText("lead"));
  write(join(repo, ".claude/skills/house/SKILL.md"), "---\nname: house\ndescription: House style\n---\nBody\n");
  write(join(home, ".claude/agents/mine.md"), agentText("mine"));
  write(join(home, ".claude/skills/tone/SKILL.md"), "---\ndescription: Tone\n---\nBody\n");
  write(join(home, ".claude/skills/tone/scripts/run.sh"), "echo hi\n");
  write(join(home, ".claude/skills/tone/references/a.md"), "ref\n");
  const plug = join(t, "plug");
  write(join(plug, "agents/cr.md"), agentText("cr"));
  write(join(plug, "skills/tdd/SKILL.md"), "---\ndescription: TDD\n---\nBody\n");
  write(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "sp@m": [{ installPath: plug }], "off@m": [{ installPath: join(t, "off") }] } }));
  write(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sp@m": true } }));
  return { t, repo, home };
}

test("listLibrary: repo, then personal, then enabled plugins", () => {
  const { repo, home } = world();
  expect(listLibrary(repo, home, "all").map((i) => `${i.from}:${i.kind}:${i.name}`)).toEqual([
    "repo:agent:lead", "repo:skill:house", "personal:agent:mine", "personal:skill:tone", "plugin:agent:sp:cr", "plugin:skill:sp:tdd",
  ]);
  expect(listLibrary(repo, home, "repo").map((i) => i.name)).toEqual(["lead", "house"]);
});

test("copyItem copies a skill folder whole, records its source, and refuses links and size", () => {
  const { t, repo, home } = world();
  const tone = listLibrary(repo, home, "all").find((i) => i.name === "tone")!;
  const w = copyItem(tone, { root: repo, source: "https://example.com/skills.git (tone)", today: "2026-10-27" }) as FileWrite[];
  expect(w.map((f) => f.path).sort()).toEqual([".claude/skills/tone/SKILL.md", ".claude/skills/tone/SOURCE.md", ".claude/skills/tone/references/a.md", ".claude/skills/tone/scripts/run.sh"]);
  expect(w.find((f) => f.path.endsWith("SOURCE.md"))!.content).toBe("Copied from https://example.com/skills.git (tone) on 2026-10-27.\n");
  writeFileSync(join(t, "outside.txt"), "x");
  symlinkSync(join(t, "outside.txt"), join(tone.path, "leak"));
  expect(copyItem(tone, { root: repo, today: "2026-10-27" })).toEqual({ refused: expect.stringContaining("leak") });
  const big = temp();
  for (let i = 0; i < 201; i++) write(join(big, `f${i}.md`), "x");
  write(join(big, "SKILL.md"), "x");
  const item: LibraryItem = { kind: "skill", name: "big", description: "", from: "source", path: big };
  expect(copyItem(item, { root: repo, today: "2026-10-27" })).toEqual({ refused: expect.stringContaining("at most 200 files") });
});

test("copyItem refuses a binary file, big folders and bad names", () => {
  const { repo } = world();
  const dir = temp();
  write(join(dir, "SKILL.md"), "x");
  writeFileSync(join(dir, "a.bin"), Buffer.from([1, 0, 2]));
  const item: LibraryItem = { kind: "skill", name: "bin", description: "", from: "source", path: dir };
  expect(copyItem(item, { root: repo, today: "2026-10-27" })).toEqual({ refused: expect.stringContaining("a.bin") });
  expect(copyItem({ ...item, name: "Bad Name" }, { root: repo, today: "2026-10-27" })).toHaveProperty("refused");
  const huge = temp();
  write(join(huge, "SKILL.md"), "x");
  writeFileSync(join(huge, "big.md"), "a".repeat(5 * 1024 * 1024 + 1));
  expect(copyItem({ ...item, path: huge }, { root: repo, today: "2026-10-27" })).toEqual({ refused: expect.stringContaining("5 MB") });
});

test("copyItem gives a plugin agent its plain name and a source key", () => {
  const { repo, home } = world();
  const cr = listLibrary(repo, home, "all").find((i) => i.name === "sp:cr")!;
  const w = copyItem(cr, { root: repo, today: "2026-10-27" }) as FileWrite[];
  expect(w[0]!.path).toBe(".claude/agents/cr.md");
  expect(parseAgentFile("cr", w[0]!.content!, "repo", "p")).toMatchObject({ dropped: [] });
  expect(w[0]!.content).toContain("source: ");
});

test("scanFolder finds skills and agents in a fetched source", () => {
  const dir = temp();
  write(join(dir, "skills/a/SKILL.md"), "---\ndescription: A\n---\n");
  write(join(dir, "nested/b/SKILL.md"), "---\nname: bee\ndescription: B\n---\n");
  write(join(dir, "agents/x.md"), agentText("x"));
  write(join(dir, ".git/agents/y.md"), agentText("y"));
  write(join(dir, "docs/agents.md"), "no");
  expect(scanFolder(dir).map((i) => `${i.kind}:${i.name}`).sort()).toEqual(["agent:x", "skill:a", "skill:bee"]);
});

test("cloneSource refuses option-like and unknown URLs, and clones a file:// repo shallowly", async () => {
  expect(await cloneSource("--upload-pack=x")).toEqual({ refused: expect.stringContaining("") });
  expect(await cloneSource("ftp://x")).toHaveProperty("refused");
  const src = temp();
  write(join(src, "agents/x.md"), agentText("x"));
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"]]) {
    Bun.spawnSync(["git", ...args], { cwd: src });
  }
  const r = await cloneSource(`file://${src}`);
  if ("refused" in r) throw new Error(r.refused);
  expect(existsSync(join(r.dir, "agents/x.md"))).toBe(true);
  r.cleanup();
  expect(existsSync(r.dir)).toBe(false);
  const local = await cloneSource(src);
  if ("refused" in local) throw new Error(local.refused);
  expect(local.dir).toBe(src);
  local.cleanup();
  expect(existsSync(src)).toBe(true);
  expect(await cloneSource("https://127.0.0.1:1/nope.git")).toHaveProperty("refused");
});

test("repoPath keeps writes inside .claude/agents and .claude/skills", () => {
  expect(repoPath(".claude/skills/a/SKILL.md")).toBe(".claude/skills/a/SKILL.md");
  expect(repoPath(".claude/agents/../settings.json")).toBeNull();
  expect(repoPath("/etc/passwd")).toBeNull();
  expect(repoPath(".claude\\agents\\x.md")).toBe(".claude/agents/x.md");
});

test("newAgentFile writes frontmatter that parses back", () => {
  const f = newAgentFile({ name: "lead", description: "Leads reviews: well", prompt: "You lead.", tools: ["Read", "Grep"], model: null });
  expect(f.path).toBe(".claude/agents/lead.md");
  expect(parseAgentFile("lead", f.content!, "repo", "p")).toMatchObject({ description: "Leads reviews: well", prompt: "You lead.", tools: ["Read", "Grep"], model: null, dropped: [] });
});
