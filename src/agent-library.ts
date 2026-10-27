import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { parse, stringify } from "yaml";
import { enabledPlugins } from "./agent-files";
import { errorText } from "./shell";
import { printable } from "./text";

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

/**
 * The frontmatter keys of a markdown file, and the rest of it. Frontmatter that is not YAML keys and
 * values counts as none, and `problem` says what it is instead.
 */
function split(text: string): { front: Record<string, unknown>; body: string | null; problem?: string } {
  const m = FRONTMATTER.exec(text.replace(/^﻿/, ""));
  if (!m) return { front: {}, body: null };
  const body = m[2] ?? "";
  let v: unknown;
  try { v = parse(m[1] ?? ""); } catch { return { front: {}, body, problem: "not YAML" }; }
  if (v === null || v === undefined) return { front: {}, body };
  if (typeof v === "object" && !Array.isArray(v)) return { front: v as Record<string, unknown>, body };
  return { front: {}, body, problem: "not YAML keys and values" };
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

function skillItem(dir: string, from: LibraryItem["from"], prefix: string, nameFromFront: boolean, fallback = basename(dir)): LibraryItem | null {
  const text = readText(join(dir, "SKILL.md"));
  if (text === null) return null;
  const { front } = split(text);
  return { kind: "skill", name: prefix + ((nameFromFront && str(front.name)) || fallback), description: str(front.description), from, path: dir };
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

/**
 * Every skill and agent in a folder (a fetched source). Hidden folders other than `.claude`, and
 * `node_modules`, are skipped; links are not followed. `rootName` names a skill at the folder's root
 * that has no name of its own (a fetched folder's own name is a temporary one). An item whose name
 * Loopstra would not copy (not lowercase letters, digits and dashes) is in `skipped`, not `items`:
 * its name came from the source, so it is not shown or offered.
 */
export function scanFolder(dir: string, rootName?: string): { items: LibraryItem[]; skipped: LibraryItem[] } {
  const out: LibraryItem[] = [];
  const walk = (d: string) => {
    const skill = skillItem(d, "source", "", true, d === dir ? rootName : undefined);
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
  return { items: out.filter((i) => NAME.test(i.name)), skipped: out.filter((i) => !NAME.test(i.name)) };
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
  const unreadable = (shown: string, e: unknown) => `${shown} cannot be read: ${errorText(e)}`;
  const walk = (d: string, rel: string): string | null => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch (e) { return unreadable(rel || d, e); }
    for (const name of names) {
      const path = join(d, name);
      const shown = rel ? `${rel}/${name}` : name;
      if (name === ".git") continue;
      if (/[\\\u0000-\u001f\u007f-\u009f]/.test(name)) return `${printable(shown)} has a backslash or control character in its name.`;
      let st;
      try { st = lstatSync(path); } catch (e) { return unreadable(shown, e); }
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
      try {
        if (looksBinary(path)) return `${shown} is a binary file, and binary files are not copied yet.`;
        out.push({ path: `${dest}/${shown}`, content: readFileSync(path, "utf8") });
      } catch (e) { return unreadable(shown, e); }
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
  const source = shownUrl(o.source ?? item.path);
  if (item.kind === "agent") {
    let text: string;
    try { text = readFileSync(item.path, "utf8"); } catch (e) { return { refused: `${item.path} cannot be read: ${errorText(e)}` }; }
    const { front, body, problem } = split(text);
    if (problem) return { refused: `${item.path}'s front matter is ${problem}.` };
    return [{ path: `.claude/agents/${plain}.md`, content: `---\n${stringify({ ...front, source })}---\n${body ?? text}` }];
  }
  const files = folderWrites(item.path, `.claude/skills/${plain}`);
  if ("refused" in files) return files;
  const sourceNote = `.claude/skills/${plain}/SOURCE.md`;
  const writes = [...files.filter((f) => f.path !== sourceNote), { path: sourceNote, content: `Copied from ${source} on ${o.today}.\n` }];
  const stray = writes.find((w) => !repoPath(w.path)?.startsWith(`.claude/skills/${plain}/`));
  return stray ? { refused: `${stray.path} would land outside .claude/skills/${plain}/.` } : writes;
}

/** A URL without the user name and password in it, safe to show and to record. */
export function shownUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** A name for what a source holds when it has none: the last part of its path, as a skill name. */
function sourceName(url: string): string {
  const last = shownUrl(url).replace(/[/\\:]+$/, "").split(/[/\\:]/).pop() ?? "";
  return last.replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

/**
 * The environment a clone runs in, so that it never prompts: GIT_TERMINAL_PROMPT=0, and ssh in batch
 * mode (`-o BatchMode=yes` added to the user's own GIT_SSH_COMMAND). When the user names another ssh
 * through GIT_SSH or core.sshCommand (`sshCommand`, "" when unset), GIT_SSH_COMMAND stays unset so
 * theirs runs (it may not take `-o`).
 */
export function cloneEnv(env: Record<string, string | undefined>, sshCommand: string): Record<string, string | undefined> {
  const { GIT_SSH_COMMAND: own, ...rest } = env;
  const out: Record<string, string | undefined> = { ...rest, GIT_TERMINAL_PROMPT: "0" };
  if (own) out.GIT_SSH_COMMAND = `${own} -o BatchMode=yes`;
  else if (!env.GIT_SSH && !sshCommand.trim()) out.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return out;
}

/** git's core.sshCommand as git in the current folder sees it, or "" (unset, or git could not say). */
function configuredSshCommand(): string {
  try {
    const r = Bun.spawnSync(["git", "config", "--get", "core.sshCommand"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch { return ""; }
}

/** Removes a folder, leaving it when it cannot be (a handle still open): a leftover temporary folder is not worth failing over. */
function removeQuietly(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left in the temporary folder */ }
}

/**
 * Fetches a source: a git URL is cloned shallowly into a new temporary folder (removed by `cleanup`),
 * a local folder is used as it is. Nothing in it runs. `name`: what to call a skill at its root.
 */
export async function cloneSource(url: string): Promise<{ dir: string; name: string; cleanup: () => void } | { refused: string }> {
  const shown = shownUrl(url);
  if (url.startsWith("-")) return { refused: "A source cannot start with a dash." };
  if (!/^(https:\/\/|ssh:\/\/|git@|file:\/\/)/.test(url)) {
    if (isDir(url)) return { dir: url, name: sourceName(url), cleanup: () => {} };
    return { refused: `\`${shown}\` is neither a folder nor a URL starting with https://, ssh://, git@ or file://.` };
  }
  let dir: string;
  try { dir = mkdtempSync(join(tmpdir(), "loopstra-source-")); } catch (e) { return { refused: `A temporary folder for ${shown} could not be made: ${errorText(e)}` }; }
  const cleanup = () => removeQuietly(dir);
  try {
    const proc = Bun.spawn(["git", "clone", "--depth", "1", "--quiet", "--", url, dir], {
      stdout: "ignore", stderr: "pipe", stdin: "ignore", env: cloneEnv(process.env, configuredSshCommand()),
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, CLONE_TIMEOUT_MS);
    const err = new Response(proc.stderr).text().catch(() => "");
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) {
      // A child that outlived git may hold the pipe open, so reading stops after a moment.
      const text = await Promise.race([err, new Promise<string>((r) => setTimeout(() => r(""), 1000))]);
      cleanup();
      return { refused: `git could not fetch ${shown}${timedOut ? " in time" : ""}: ${shownUrl(text).trim() || `exit ${code}`}` };
    }
  } catch (e) {
    cleanup();
    return { refused: `git could not fetch ${shown}: ${e instanceof Error ? shownUrl(e.message) : String(e)}` };
  }
  return { dir, name: sourceName(url), cleanup };
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

/**
 * The normalized repo-relative path of a file to write. Throws when it is outside .claude/agents/ and
 * .claude/skills/, or when `.claude`, a folder below it or the file itself is a link already (a write
 * or removal would follow it out of the repo).
 */
export function checkedPath(root: string, file: { path: string }): string {
  const path = repoPath(file.path);
  if (!path) throw new Error(`${file.path} is not a place Loopstra writes: only under .claude/agents/ and .claude/skills/.`);
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const shown = parts.slice(0, i).join("/");
    let link: boolean;
    try { link = lstatSync(join(root, shown)).isSymbolicLink(); } catch { return path; }
    if (link) throw new Error(`${file.path} is not written: ${shown} is a link, and Loopstra does not write through links.`);
  }
  return path;
}
