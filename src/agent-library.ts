import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { parse, stringify } from "yaml";
import { enabledPlugins } from "./agent-files";

/** A skill or an agent that can be put in the repository's `.claude/`. */
export interface LibraryItem {
  kind: "agent" | "skill";
  /** `plugin:name` for a plugin's item. */
  name: string;
  description: string;
  from: "repo" | "personal" | "plugin" | "source";
  /** The agent file, or the skill folder. */
  path: string;
}

/** A file to write under the repo root (`path` relative, `/`-separated); null content removes it. */
export interface FileWrite { path: string; content: string | null }

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 120_000;
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** The frontmatter keys of a markdown file, and the rest of it. */
function split(text: string): { front: Record<string, unknown>; body: string | null } {
  const m = FRONTMATTER.exec(text.replace(/^﻿/, ""));
  if (!m) return { front: {}, body: null };
  try {
    const v: unknown = parse(m[1] ?? "");
    if (v && typeof v === "object" && !Array.isArray(v)) return { front: v as Record<string, unknown>, body: m[2] ?? "" };
  } catch { /* unreadable frontmatter counts as none */ }
  return { front: {}, body: m[2] ?? "" };
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function entries(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** The text of a name or description key, trimmed, else "". */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function agentItem(file: string, from: LibraryItem["from"], prefix: string, nameFromFront: boolean): LibraryItem | null {
  const text = readText(file);
  if (text === null) return null;
  const { front } = split(text);
  const plain = (nameFromFront && str(front.name)) || basename(file).replace(/\.md$/, "");
  return { kind: "agent", name: prefix + plain, description: str(front.description), from, path: file };
}

function skillItem(dir: string, from: LibraryItem["from"], prefix: string, nameFromFront: boolean): LibraryItem | null {
  const text = readText(join(dir, "SKILL.md"));
  if (text === null) return null;
  const { front } = split(text);
  return { kind: "skill", name: prefix + ((nameFromFront && str(front.name)) || basename(dir)), description: str(front.description), from, path: dir };
}

/** The agents and skills under `<base>/agents` and `<base>/skills`, sorted by kind then name. */
function itemsUnder(base: string, from: LibraryItem["from"], prefix: string): LibraryItem[] {
  const agents = entries(join(base, "agents")).filter((f) => f.endsWith(".md")).map((f) => agentItem(join(base, "agents", f), from, prefix, false));
  const skills = entries(join(base, "skills")).map((d) => skillItem(join(base, "skills", d), from, prefix, false));
  const sorted = (list: Array<LibraryItem | null>) => list.filter((i): i is LibraryItem => i !== null).sort((a, b) => a.name.localeCompare(b.name));
  return [...sorted(agents), ...sorted(skills)];
}

/** What can be used: the repository's, then (with `all`) this machine's, then the enabled plugins'. */
export function listLibrary(root: string, home: string, sources: "all" | "repo"): LibraryItem[] {
  const out = itemsUnder(join(root, ".claude"), "repo", "");
  if (sources !== "all") return out;
  out.push(...itemsUnder(join(home, ".claude"), "personal", ""));
  for (const { plugin, installPath } of enabledPlugins(home)) out.push(...itemsUnder(installPath, "plugin", `${plugin}:`));
  return out;
}

/** Every skill and agent in a folder (a fetched source). Hidden folders other than `.claude`, and `node_modules`, are skipped; links are not followed. */
export function scanFolder(dir: string): LibraryItem[] {
  const out: LibraryItem[] = [];
  const walk = (d: string) => {
    const skill = skillItem(d, "source", "", true);
    if (skill) { out.push(skill); return; }
    for (const name of entries(d)) {
      const path = join(d, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (st.isDirectory()) {
        if ((name.startsWith(".") && name !== ".claude") || name === "node_modules") continue;
        walk(path);
      } else if (st.isFile() && name.endsWith(".md") && basename(d) === "agents") {
        const agent = agentItem(path, "source", "", true);
        if (agent) out.push(agent);
      }
    }
  };
  walk(dir);
  return out;
}

/** True when a file's first 8000 bytes hold a NUL. */
function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8000);
    return buf.subarray(0, readSync(fd, buf, 0, 8000, 0)).includes(0);
  } finally { closeSync(fd); }
}

/** Every file of a skill folder as writes under `dest/`, or why it cannot be copied. */
function folderWrites(dir: string, dest: string): FileWrite[] | { refused: string } {
  const out: FileWrite[] = [];
  let bytes = 0;
  const walk = (d: string, rel: string): string | null => {
    for (const name of entries(d)) {
      const path = join(d, name);
      const shown = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return `${shown} is a link, and links are not copied.`;
      if (st.isDirectory()) {
        const bad = walk(path, shown);
        if (bad) return bad;
        continue;
      }
      if (!st.isFile()) return `${shown} is not a plain file.`;
      if (out.length >= MAX_FILES) return `A skill is copied with at most ${MAX_FILES} files.`;
      bytes += st.size;
      if (bytes > MAX_BYTES) return "A skill is copied with at most 5 MB of files.";
      if (looksBinary(path)) return `${shown} is a binary file, and binary files are not copied yet.`;
      out.push({ path: `${dest}/${shown}`, content: readFileSync(path, "utf8") });
    }
    return null;
  };
  const bad = walk(dir, "");
  return bad ? { refused: bad } : out;
}

/** The writes that copy an item into the repository, or why not. An agent is one file; a skill is its whole folder plus SOURCE.md. */
export function copyItem(item: LibraryItem, o: { root: string; source?: string; today: string }): FileWrite[] | { refused: string } {
  const plain = item.name.slice(item.name.indexOf(":") + 1);
  if (!NAME.test(plain)) return { refused: `\`${plain}\` is not a name Loopstra copies: use lowercase letters, digits and dashes.` };
  const source = o.source ?? item.path;
  if (item.kind === "agent") {
    const text = readText(item.path);
    if (text === null) return { refused: `${item.path} cannot be read.` };
    const { front, body } = split(text);
    return [{ path: `.claude/agents/${plain}.md`, content: `---\n${stringify({ ...front, source })}---\n${body ?? text}` }];
  }
  const files = folderWrites(item.path, `.claude/skills/${plain}`);
  if ("refused" in files) return files;
  const sourceNote = `.claude/skills/${plain}/SOURCE.md`;
  return [...files.filter((f) => f.path !== sourceNote), { path: sourceNote, content: `Copied from ${source} on ${o.today}.\n` }];
}

/**
 * Fetches a source: a git URL is cloned shallowly into a new temporary folder (removed by `cleanup`),
 * a local folder is used as it is. Nothing in it runs.
 */
export async function cloneSource(url: string): Promise<{ dir: string; cleanup: () => void } | { refused: string }> {
  if (url.startsWith("-")) return { refused: "A source cannot start with a dash." };
  if (!/^(https:\/\/|ssh:\/\/|git@|file:\/\/)/.test(url)) {
    if (isDir(url)) return { dir: url, cleanup: () => {} };
    return { refused: `\`${url}\` is neither a folder nor a URL starting with https://, ssh://, git@ or file://.` };
  }
  const dir = mkdtempSync(join(tmpdir(), "loopstra-source-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const proc = Bun.spawn(["git", "clone", "--depth", "1", "--quiet", "--", url, dir], {
      stdout: "ignore", stderr: "pipe", stdin: "ignore", timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      cleanup();
      return { refused: `git could not fetch ${url}${proc.signalCode ? " in time" : ""}: ${err.trim() || `exit ${code}`}` };
    }
  } catch (e) {
    cleanup();
    return { refused: `git could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { dir, cleanup };
}

/** A new agent as a file: frontmatter via yaml (so a description with a colon stays valid), the prompt as the body. */
export function newAgentFile(o: { name: string; description: string; prompt: string; tools: string[]; model: string | null }): FileWrite {
  const front: Record<string, string> = { name: o.name, description: o.description };
  if (o.tools.length) front.tools = o.tools.join(", ");
  if (o.model) front.model = o.model;
  return { path: `.claude/agents/${o.name}.md`, content: `---\n${stringify(front)}---\n${o.prompt}\n` };
}

/** The normalized repo-relative path when it lies inside `.claude/agents/` or `.claude/skills/`, else null. */
export function repoPath(p: string): string | null {
  const n = posix.normalize(p.replaceAll("\\", "/"));
  return /^\.claude\/(agents|skills)\/[^/]/.test(n) && !n.split("/").includes("..") ? n : null;
}
