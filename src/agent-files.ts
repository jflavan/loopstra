import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { inlineName } from "./agents";

/** An agent definition read from a Claude Code agent file. */
export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools: string[] | null;
  model: string | null;
  skills: string[] | null;
  /** Frontmatter keys Loopstra does not carry over, in file order. */
  dropped: string[];
  from: "repo" | "personal" | "plugin";
  path: string;
}

/** Where to look: `repo` is a checkout of main (the step's snapshot, or the root). */
export interface Where { repo: string; home: string; sources: "all" | "repo" }

const KEPT = new Set(["name", "description", "tools", "model", "skills", "color"]);
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** A comma-separated string or a list as a list of names; null when absent or empty. */
function names(v: unknown): string[] | null {
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  const out = list.filter((x): x is string | number => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : null;
}

export function parseAgentFile(name: string, text: string, from: AgentDefinition["from"], path: string): AgentDefinition {
  const m = FRONTMATTER.exec(text);
  let front: Record<string, unknown> = {};
  if (m) {
    try {
      const v: unknown = parse(m[1] ?? "");
      if (v && typeof v === "object" && !Array.isArray(v)) front = v as Record<string, unknown>;
    } catch { /* unreadable frontmatter counts as none */ }
  }
  const body = m ? (m[2] ?? "") : text;
  return {
    name,
    description: typeof front.description === "string" ? front.description.trim() : "",
    prompt: body.trim(),
    tools: names(front.tools),
    model: typeof front.model === "string" && front.model.trim() ? front.model.trim() : null,
    skills: names(front.skills),
    dropped: Object.keys(front).filter((k) => !KEPT.has(k)),
    from,
    path,
  };
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The install folder of an installed and enabled plugin, by its short name (before the `@`). */
function pluginRoot(plugin: string, home: string): string | null {
  const installed = readJson(join(home, ".claude/plugins/installed_plugins.json"))?.plugins;
  const enabled = readJson(join(home, ".claude/settings.json"))?.enabledPlugins;
  if (!installed || typeof installed !== "object" || !enabled || typeof enabled !== "object") return null;
  for (const [key, entries] of Object.entries(installed)) {
    if (!key.startsWith(`${plugin}@`) || (enabled as Record<string, unknown>)[key] !== true || !Array.isArray(entries)) continue;
    const path = (entries[0] as { installPath?: unknown } | undefined)?.installPath;
    if (typeof path === "string") return path;
  }
  return null;
}

/** The places a definition may live, in lookup order, for a file under `<base>/<dir>/…`. */
function candidates(name: string, where: Where, file: (n: string) => string, dir: string): { from: AgentDefinition["from"]; path: string }[] {
  const colon = name.indexOf(":");
  const local = colon < 0 ? name : null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return [];
  const out: { from: AgentDefinition["from"]; path: string }[] = [];
  if (local !== null) out.push({ from: "repo", path: join(where.repo, ".claude", dir, file(local)) });
  if (where.sources !== "all") return out;
  if (local !== null) out.push({ from: "personal", path: join(where.home, ".claude", dir, file(local)) });
  else {
    const root = pluginRoot(name.slice(0, colon), where.home);
    if (root) out.push({ from: "plugin", path: join(root, dir, file(name.slice(colon + 1))) });
  }
  return out;
}

export async function findAgent(name: string, where: Where): Promise<AgentDefinition | null> {
  for (const c of candidates(name, where, (n) => `${n}.md`, "agents")) {
    const text = readText(c.path);
    if (text !== null) return parseAgentFile(name, text, c.from, c.path);
  }
  return null;
}

export async function findSkill(name: string, where: Where): Promise<AgentDefinition["from"] | null> {
  for (const c of candidates(name, where, (n) => join(n, "SKILL.md"), "skills")) {
    if (readText(c.path) !== null) return c.from;
  }
  return null;
}

export interface InlineAgent { description: string; prompt: string; tools?: string[]; model?: string; skills?: string[] }

/** The `--agents` JSON: the main agent, then the others, keyed by their Loopstra names. */
export function inlineAgents(main: AgentDefinition | null, others: AgentDefinition[]): Record<string, InlineAgent> {
  const out: Record<string, InlineAgent> = {};
  const entry = (d: AgentDefinition, isMain: boolean): InlineAgent => {
    const e: InlineAgent = { description: d.description, prompt: d.prompt };
    if (d.tools) e.tools = isMain && !d.tools.includes("StructuredOutput") ? [...d.tools, "StructuredOutput"] : d.tools;
    if (d.model && !isMain) e.model = d.model;
    if (d.skills) e.skills = d.skills;
    return e;
  };
  if (main) out[inlineName(main.name)] = entry(main, true);
  for (const d of others) out[inlineName(d.name)] = entry(d, false);
  return out;
}
