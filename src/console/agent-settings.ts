import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkAgentSetup, userHome } from "../agent-files";
import { checkedPath, CLONE_TIMEOUT_MS, cloneSource, copyItem, listLibrary, newAgentFile, scanFolder, shownUrl, type FileWrite, type LibraryItem } from "../agent-library";
import { BUILTIN_AGENTS, CHAT_STEPS, CONTINUES_BUILD, READ_ONLY_STEPS, TEAM_WAYS } from "../agents";
import { localUser } from "../chat/transports/shared";
import type { Config, StepAgents } from "../config";
import { Git } from "../git";
import { STAGE_NAMES, STEP_KEYS, STEPS } from "../models";
import { CONSOLE, submitRequest } from "../requests";
import { CONFIG_REL, fileVersion, STALE_SETTINGS, UNCOMMITTED_FILES } from "../settings";
import { modelName } from "../setup/sections/models";
import { localDate } from "../signals";
import { andList, printable } from "../text";
import { loopNow } from "./model";
import { json, refuse } from "./routes";
import { readConfig } from "./settings";
import { AGENT_FIELDS, type AgentField, type AgentFields, type AgentFilesOp, type AgentsView, type AgentStepRow, type LibraryItemView, type SourceItems } from "./types";

/*
 * The Agents section's server side: the read-only view (`/api/agents`), what a git repository or
 * folder holds (`/api/agents/source`), and the file operations (`/api/agents/files`), each turned
 * into an `agent-files` request the loop applies and commits. The console never writes the
 * repository itself.
 */

type Kind = LibraryItem["kind"];

/** A name Loopstra gives an agent or a skill in the repository. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME = 64;
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DESCRIPTION = 1_000;
const MAX_PROMPT = 100_000;
const MAX_URL = 2_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The longest version a page sends: a sha256 in hex, or "absent". */
const MAX_VERSION = 100;

/** How long a route that clones may stay silent: longer than a clone may take (see CLONE_TIMEOUT_MS). */
export const SOURCE_IDLE_SECONDS = Math.ceil(CLONE_TIMEOUT_MS / 1000) + 30;

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * Who names an agent, a skill or a team, in the config's words: `agents.all`, `agents.steps.review`,
 * and for an agent `team reviewers` (a member), for a skill `stages.review` (a stage's skills).
 */
function usersOf(cfg: Config, kind: Kind | "team", name: string): string[] {
  const sets: Array<[string, StepAgents]> = [["agents.all", cfg.agents.all]];
  for (const step of STEP_KEYS) {
    const set = cfg.agents.steps[step];
    if (set) sets.push([`agents.steps.${step}`, set]);
  }
  const names = (s: StepAgents): Array<string | undefined> => (kind === "agent" ? [s.agent, ...s.subagents] : kind === "skill" ? s.skills : s.teams);
  const out = sets.filter(([, s]) => names(s).includes(name)).map(([where]) => where);
  if (kind === "agent") out.push(...Object.entries(cfg.agents.teams).filter(([, t]) => t.members.includes(name)).map(([team]) => `team ${team}`));
  if (kind === "skill") out.push(...STAGE_NAMES.filter((s) => cfg.stages[s].skills.includes(name)).map((s) => `stages.${s}`));
  return out;
}

/** The fields a setup sets: an agent when there is one, each list that is not empty. */
function fieldsOf(set: StepAgents | undefined): AgentFields {
  const out: AgentFields = {};
  if (!set) return out;
  const put = (f: AgentField, v: string | string[] | undefined) => {
    if (v !== undefined && v.length) out[f] = Array.isArray(v) ? [...v] : v;
  };
  for (const f of AGENT_FIELDS) put(f, set[f]);
  return out;
}

/** An item as the page shows it; null for a fetched source's, which the library never lists. */
function libraryView(cfg: Config, item: LibraryItem): LibraryItemView | null {
  const from = item.from;
  if (from === "source") return null;
  const text = readText(item.kind === "agent" ? item.path : join(item.path, "SKILL.md"));
  // Only an agent the page can name back (see the edit operation) is offered for editing.
  const editable = item.kind === "agent" && item.from === "repo" && NAME.test(item.name) && item.name.length <= MAX_NAME;
  return {
    kind: item.kind,
    name: item.name,
    description: printable(item.description),
    from,
    usedBy: usersOf(cfg, item.kind, item.name),
    base: fileVersion(text),
    editable,
    ...(editable && text !== null ? { text } : {}),
  };
}

/**
 * What the Agents section shows. The file is read once, so its version and the values come from the
 * same text. A file that cannot be read or does not load gives a problem in words and nothing to edit.
 */
export async function agentsView(root: string): Promise<AgentsView> {
  const builtins = [...BUILTIN_AGENTS];
  const ways = [...TEAM_WAYS];
  const loaded = await readConfig(root);
  if ("problem" in loaded) return { version: loaded.version, problem: loaded.problem, sources: "all", steps: [], teams: [], library: [], problems: [], builtins, ways };
  const { cfg, version } = loaded;
  const home = userHome();
  const all: AgentStepRow = { key: "all", what: "what every step gets, but chat's two", readOnly: true, chat: false, continuesBuild: false, own: fieldsOf(cfg.agents.all), fromAll: {}, fromStage: [] };
  const steps = STEPS.map((s): AgentStepRow => {
    const chat = CHAT_STEPS.has(s.key);
    return {
      key: s.key,
      what: s.what,
      readOnly: READ_ONLY_STEPS.has(s.key),
      chat,
      continuesBuild: CONTINUES_BUILD.has(s.key),
      own: fieldsOf(cfg.agents.steps[s.key]),
      fromAll: chat ? {} : fieldsOf(cfg.agents.all),
      fromStage: s.group === "chat" ? [] : [...cfg.stages[s.group].skills],
    };
  });
  // A name with control characters cannot be named in the config as it is, nor copied (see copyItem).
  const library = listLibrary(root, home, "all").filter((i) => !CONTROL.test(i.name)).flatMap((i) => libraryView(cfg, i) ?? []);
  return {
    version,
    problem: null,
    sources: cfg.agents.sources,
    steps: [all, ...steps],
    teams: Object.entries(cfg.agents.teams).map(([name, t]) => ({ name, members: [...t.members], way: t.way, usedBy: usersOf(cfg, "team", name) })),
    library,
    problems: await checkAgentSetup(cfg, { repo: root, home, sources: cfg.agents.sources }),
    builtins,
    ways,
  };
}

/** What a git repository or folder holds: cloned into a temporary folder, listed, and the folder removed. */
export async function sourceItems(url: string): Promise<SourceItems> {
  const fetched = await cloneSource(url);
  if ("refused" in fetched) return { error: printable(fetched.refused) };
  try {
    return { items: scanFolder(fetched.dir, fetched.name).items.map((i) => ({ kind: i.kind, name: i.name, description: printable(i.description) })) };
  } finally {
    fetched.cleanup();
  }
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const kindOf = (v: unknown): Kind | null => (v === "agent" || v === "skill" ? v : null);

/** The repo name an agent or skill is written under, or why it cannot be. */
function nameProblem(name: string | null, kind: Kind): string | null {
  if (name === null || !NAME.test(name) || name.length > MAX_NAME) return `${kind === "agent" ? "An agent" : "A skill"} name is lowercase letters, digits and dashes (at most ${MAX_NAME}), like lead-reviewer.`;
  return null;
}

/** The body as an operation, or why it is not one (a 400). */
function parseOp(b: Record<string, unknown>): AgentFilesOp | string {
  if (b.replace !== undefined && typeof b.replace !== "boolean") return "Say replace as true or false.";
  const replace = b.replace === true;
  const kind = kindOf(b.kind);
  const base = str(b.base, MAX_VERSION);
  /** A replacement names the version of the agent file or SKILL.md the page read ("absent" for none). */
  const replaced = (what: string): { replace: true; base: string } | { replace: false } | string =>
    !replace ? { replace: false } : base ? { replace: true, base } : `Say which version of ${what} the page read, to replace it.`;
  switch (b.op) {
    case "copy": {
      const name = str(b.name, 200);
      if (!kind || !name) return "Say which agent or skill to copy.";
      if (b.from !== "personal" && b.from !== "plugin") return "Say whether it is copied from this machine (personal) or a plugin.";
      const r = replaced(`the ${kind}`);
      return typeof r === "string" ? r : { op: "copy", kind, name, from: b.from, ...r };
    }
    case "fetch": {
      const url = str(b.url, MAX_URL)?.trim();
      if (!url) return "Say which git repository or folder to fetch from.";
      if (!kind) return "Say whether it adds agents or skills.";
      const names = Array.isArray(b.names) && b.names.length >= 1 && b.names.length <= MAX_FILES && b.names.every((n) => typeof n === "string") ? b.names : null;
      if (!names) return "Say which agents or skills to add.";
      if (!replace) return { op: "fetch", url, names, kind, replace };
      // A replacement names, for each item, the version of its agent file or SKILL.md the page read.
      const bases = b.base && typeof b.base === "object" && !Array.isArray(b.base) ? (b.base as Record<string, unknown>) : {};
      const versions: Record<string, string> = {};
      for (const n of names) {
        const v = Object.hasOwn(bases, n) ? str(bases[n], MAX_VERSION) : null;
        if (!v) return `Say which version of each ${kind} the page read, to replace them.`;
        versions[n] = v;
      }
      return { op: "fetch", url, names, kind, replace, base: versions };
    }
    case "new": {
      const name = str(b.name, MAX_NAME);
      const bad = nameProblem(name, "agent");
      if (bad) return bad;
      if (BUILTIN_AGENTS.has(name!)) return `${name!} is one of Claude Code's own agents; pick another name.`;
      const description = str(b.description, MAX_DESCRIPTION)?.trim() ?? "";
      if (!description || CONTROL.test(description)) return `Say what the agent is for, in one line (at most ${MAX_DESCRIPTION} characters).`;
      const prompt = str(b.prompt, MAX_PROMPT)?.trim() ?? "";
      if (!prompt) return `Say the agent's role (at most ${MAX_PROMPT} characters).`;
      const tools = Array.isArray(b.tools) && b.tools.length <= 64 && b.tools.every((t) => typeof t === "string") ? b.tools.map((t) => t.trim()).filter(Boolean) : null;
      if (!tools || tools.some((t) => t.includes(",") || CONTROL.test(t))) return "Say its tools as a list of rules, each without commas, like Read or Bash(bun test).";
      if (b.model !== null && b.model !== undefined && typeof b.model !== "string") return "Say its model as a word, or null for the step's.";
      const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : null;
      const modelProblem = model === null ? null : modelName(model);
      if (modelProblem) return modelProblem;
      const r = replaced("the agent");
      return typeof r === "string" ? r : { op: "new", name: name!, description, prompt, tools, model, ...r };
    }
    case "edit": {
      const name = str(b.name, MAX_NAME);
      const bad = nameProblem(name, "agent");
      if (bad) return bad;
      const text = str(b.text, MAX_BYTES);
      if (!text?.trim()) return "Say the agent's new text.";
      return base ? { op: "edit", name: name!, text, base } : "Say which version of the agent the page read.";
    }
    case "remove": {
      if (!kind) return "Say whether it removes an agent or a skill.";
      const name = str(b.name, MAX_NAME);
      const bad = nameProblem(name, kind);
      if (bad) return bad;
      return base ? { op: "remove", kind, name: name!, base } : `Say which version of the ${kind} the page read.`;
    }
    default:
      return "Say copy, fetch, new, edit or remove.";
  }
}

/** Where an agent or skill lives in the repository. */
const targetOf = (kind: Kind, name: string) => (kind === "agent" ? `.claude/agents/${name}.md` : `.claude/skills/${name}`);
/** The file whose version stands for an agent or skill (LibraryItemView.base): the agent file, or SKILL.md. */
const mainFileOf = (kind: Kind, name: string) => (kind === "agent" ? targetOf(kind, name) : `${targetOf(kind, name)}/SKILL.md`);
/** The version of a file in the checkout now ("absent" when it is not there). */
const versionNow = (root: string, path: string) => fileVersion(readText(join(root, path)));

/** The repo-relative files at `rel` in the working tree: the file, or every file under the folder. A link is listed, not followed. */
function filesUnder(root: string, rel: string): string[] {
  let st;
  try { st = lstatSync(join(root, rel)); } catch { return []; }
  if (!st.isDirectory()) return [rel];
  let names: string[];
  try { names = readdirSync(join(root, rel)).sort(); } catch { return []; }
  return names.flatMap((n) => filesUnder(root, `${rel}/${n}`));
}

/**
 * An operation's writes and words. `seen`: the versions the request's base takes as they are, not as
 * the files are read when it is sent: what the page read, or "absent" for what was found missing.
 */
type Built = { what: string; writes: FileWrite[]; seen: Record<string, string> } | { refused: string; status: number };

const STALE: Built = { refused: STALE_SETTINGS, status: 409 };

/** The commit's words: `add .claude/agents/lead.md` for one agent file, else `add skill tone (3 files)`, at most 200 characters. */
function whatOf(verb: string, kind: Kind, names: string[], writes: FileWrite[]): string {
  const files = `(${writes.length} file${writes.length === 1 ? "" : "s"})`;
  const ways = [
    ...(kind === "agent" && writes.length === 1 ? [`${verb} ${writes[0]!.path}`] : []),
    names.length === 1 ? `${verb} ${kind} ${names[0]!} ${files}` : `${verb} ${kind}s ${names.join(", ")} ${files}`,
  ];
  return ways.find((w) => w.length <= 200) ?? `${verb} ${names.length} ${kind}${names.length === 1 ? "" : "s"} ${files}`;
}

type Picked = { name: string; writes: FileWrite[] | { refused: string } };
type Replace = { replace: false } | { replace: true; base: (name: string) => string };

/**
 * The writes that add items to the repository. One the repository has already is refused unless
 * replaced, and a replacement is refused as stale unless the page read the agent file or SKILL.md as
 * it is now; replaced, a skill's files the new copy does not have are removed, so it is replaced whole.
 */
function added(root: string, kind: Kind, picked: Picked[], r: Replace): Built {
  const writes: FileWrite[] = [];
  const seen: Record<string, string> = {};
  let replacing = false;
  for (const p of picked) {
    if ("refused" in p.writes) return { refused: printable(p.writes.refused), status: 409 };
    const old = filesUnder(root, targetOf(kind, p.name));
    const fresh = p.writes;
    if (r.replace) {
      const main = mainFileOf(kind, p.name);
      if (versionNow(root, main) !== r.base(p.name)) return STALE;
      seen[main] = r.base(p.name);
    } else if (old.length) {
      return { refused: `There is already ${kind === "agent" ? "an agent" : "a skill"} called ${p.name} in the repo. Replace it, or pick another name.`, status: 409 };
    } else {
      for (const w of fresh) seen[w.path] = "absent";
    }
    replacing ||= old.length > 0;
    writes.push(...old.filter((o) => !fresh.some((w) => w.path === o)).map((path) => ({ path, content: null })), ...fresh);
  }
  return { what: whatOf(replacing ? "replace" : "add", kind, picked.map((p) => p.name), writes), writes, seen };
}

/** How an add operation replaces: not at all, or with the version the page read of each item. */
function replaceOf(op: { replace?: boolean; base?: string | Record<string, string> }): Replace {
  if (!op.replace) return { replace: false };
  const base = op.base;
  return { replace: true, base: (name) => (typeof base === "string" ? base : base?.[name] ?? "") };
}

/** The name an item gets in the repository: a plugin's `plugin:name` becomes `name`. */
const plainName = (name: string) => name.slice(name.indexOf(":") + 1);

/** The operation's writes and words, or why it cannot be done now. */
async function build(root: string, cfg: Config, op: AgentFilesOp): Promise<Built> {
  switch (op.op) {
    case "copy": {
      const item = listLibrary(root, userHome(), "all").find((i) => i.kind === op.kind && i.name === op.name && i.from === op.from);
      if (!item) return { refused: `There is no ${op.kind} ${printable(op.name)} ${op.from === "plugin" ? "in an enabled plugin" : "on this machine"}.`, status: 404 };
      return added(root, op.kind, [{ name: plainName(item.name), writes: copyItem(item, { root, today: localDate() }) }], replaceOf(op));
    }
    case "fetch": {
      const fetched = await cloneSource(op.url);
      if ("refused" in fetched) return { refused: printable(fetched.refused), status: 409 };
      try {
        const { items } = scanFolder(fetched.dir, fetched.name);
        const picked: Picked[] = [];
        for (const name of new Set(op.names)) {
          const item = items.find((i) => i.kind === op.kind && i.name === name);
          if (!item) return { refused: `There is no ${op.kind} ${printable(name)} in ${printable(shownUrl(op.url))}.`, status: 404 };
          const inside = relative(fetched.dir, item.path).split(sep).join("/");
          picked.push({ name, writes: copyItem(item, { root, source: inside ? `${op.url} (${inside})` : op.url, today: localDate() }) });
        }
        return added(root, op.kind, picked, replaceOf(op));
      } finally {
        fetched.cleanup();
      }
    }
    case "new":
      return added(root, "agent", [{ name: op.name, writes: [newAgentFile(op)] }], replaceOf(op));
    case "edit": {
      const path = targetOf("agent", op.name);
      const text = readText(join(root, path));
      if (text === null) return { refused: `There is no agent ${op.name} in the repo.`, status: 404 };
      if (fileVersion(text) !== op.base) return STALE;
      return { what: `edit ${path}`, writes: [{ path, content: op.text }], seen: { [path]: op.base } };
    }
    case "remove": {
      const files = filesUnder(root, targetOf(op.kind, op.name));
      if (!files.length) return { refused: `There is no ${op.kind} ${op.name} in the repo.`, status: 404 };
      const users = usersOf(cfg, op.kind, op.name);
      if (users.length) return { refused: `The ${op.kind} ${op.name} is used by ${andList(users)}: take it off ${users.length > 1 ? "them" : users[0]!} first.`, status: 409 };
      const main = mainFileOf(op.kind, op.name);
      if (versionNow(root, main) !== op.base) return STALE;
      const writes = files.map((path) => ({ path, content: null }));
      return { what: whatOf("remove", op.kind, [op.name], writes), writes, seen: { [main]: op.base } };
    }
  }
}

/**
 * What the loop would refuse that can be seen now (it checks again when it applies the request): too
 * many files or bytes, a name it would read as another path, a link on the way, or a file with
 * changes that are not committed (or not in git).
 */
async function writesProblem(root: string, writes: FileWrite[]): Promise<string | null> {
  if (writes.length > MAX_FILES) return `A change is saved with at most ${MAX_FILES} files.`;
  if (writes.reduce((n, w) => n + Buffer.byteLength(w.content ?? ""), 0) > MAX_BYTES) return "A change is saved with at most 5 MB of files.";
  for (const w of writes) {
    if (w.path.includes("\\") || CONTROL.test(w.path)) return `${printable(w.path)} has a backslash or control character in its name.`;
    try { checkedPath(root, w); } catch (e) { return e instanceof Error ? e.message : String(e); }
  }
  const status = await new Git(root).run(["--literal-pathspecs", "status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...writes.map((w) => w.path)], { allowFail: true });
  return status.code === 0 && status.out.trim() ? UNCOMMITTED_FILES : null;
}

/**
 * Turns the page's operation into an `agent-files` request and leaves it for the loop. Its base is
 * what the page read of the files it saw (an edited or removed agent file, a replaced or removed
 * SKILL.md), "absent" for what is added new, and otherwise the files as they are in the checkout now;
 * the loop refuses the whole request as stale when any differs by the time it commits.
 * Refused in words: 400 when the operation is not well formed, 404 when what it names is not there,
 * 409 when it cannot be done now.
 */
export async function agentFilesAction(root: string, body: Record<string, unknown>): Promise<Response> {
  const op = parseOp(body);
  if (typeof op === "string") return refuse(op, 400);
  const loaded = await readConfig(root);
  if ("problem" in loaded) return refuse(`${CONFIG_REL} does not load, so nothing changed: ${loaded.problem}`);
  const built = await build(root, loaded.cfg, op);
  if ("refused" in built) return refuse(built.refused, built.status);
  const problem = await writesProblem(root, built.writes);
  if (problem) return refuse(problem);
  const base = Object.fromEntries(built.writes.map((w) => [w.path, built.seen[w.path] ?? versionNow(root, w.path)]));
  const user = localUser();
  const sent = submitRequest(root, { kind: "agent-files", what: built.what, writes: built.writes, base, by: user, byName: user, via: "the dashboard", transport: CONSOLE, thread: "" });
  return json({ id: sent.id, loop: loopNow(root, loaded.cfg.poll_seconds, new Date()).state.state }, 202);
}
