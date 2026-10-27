import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { noEditsUnder, userHome } from "./agent-files";
import type { RunPhaseInput } from "./claude";
import { readJson } from "./fsutil";
import { readBlobs, type Git } from "./git";

/** What Claude Code loads of a project from its folder (a CLAUDE.md below the top is loaded only as files under it are read). */
const PROJECT_PATHS = ["CLAUDE.md", ".claude/CLAUDE.md", ".claude/rules", ".claude/settings.json", ".claude/skills", ".claude/agents", ".claude/commands", ".mcp.json"];
/** The ones that are instructions, loaded from an added dir. */
const MEMORY = /^(CLAUDE\.md|\.claude\/CLAUDE\.md|\.claude\/rules\/.+)$/;
/** The `.claude` folders a plugin carries too, as its own `skills`, `agents` and `commands`. */
const PLUGIN = /^\.claude\/(skills|agents|commands)\/(.+)$/;

/**
 * Claude Code's project setup as main has it, at the step's commit: its `.claude/settings.json`, the MCP
 * servers of its `.mcp.json`, a folder holding its CLAUDE.md files and rules (`memory`), and a plugin
 * folder holding its skills, agents and commands (`plugin`, null when it has none).
 */
export interface MainProject {
  settings: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
  memory: string;
  plugin: string | null;
}

type Settings = Record<string, unknown>;

const isMap = (v: unknown): v is Settings => typeof v === "object" && v !== null && !Array.isArray(v);

/** A file's JSON when it is a map, else an empty map. */
function jsonMap(bytes: Uint8Array | undefined): Settings {
  if (!bytes) return {};
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isMap(v) ? v : {};
  } catch { return {}; }
}

/**
 * Main's project setup at commit `sha` of the repository at `repo`, written into a folder of its own that
 * `remove` deletes, or null when the commit has none of it. Its files come from the commit, never a
 * checkout: a session could write a checkout (the step's snapshot, say) and so change what a later
 * session of the step is told and allowed. Links and submodules are left out, as is a file that
 * cannot be written here (a name Windows does not allow, say).
 */
export async function mainProjectAt(git: Git, repo: string, sha: string): Promise<{ project: MainProject; remove: () => void } | null> {
  const listed = await git.run(["ls-tree", "-r", "-z", sha, "--", ...PROJECT_PATHS]);
  const files = listed.out.split("\0").flatMap((line) => {
    const m = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    return m ? [{ mode: m[1]!, blob: m[2]!, path: m[3]! }] : [];
  });
  if (!files.length) return null;
  const blobs = await readBlobs(repo, [...new Set(files.map((f) => f.blob))]);
  const dir = mkdtempSync(join(tmpdir(), "loopstra-main-"));
  const remove = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ } };
  try {
    const memory = join(dir, "memory");
    const pluginDir = join(dir, "plugin");
    mkdirSync(memory);
    let plugin: string | null = null;
    const put = (path: string, bytes: Uint8Array, mode: string) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes, { mode: mode === "100755" ? 0o700 : 0o600 });
      } catch { /* left out (see above) */ }
    };
    for (const f of files) {
      const bytes = blobs.get(f.blob);
      if (!bytes) continue;
      if (MEMORY.test(f.path)) put(join(memory, ...f.path.split("/")), bytes, f.mode);
      const part = PLUGIN.exec(f.path);
      if (part) {
        plugin = pluginDir;
        put(join(pluginDir, part[1]!, ...part[2]!.split("/")), bytes, f.mode);
      }
    }
    if (plugin) put(join(plugin, ".claude-plugin", "plugin.json"), new TextEncoder().encode(JSON.stringify({ name: "project" })), "100644");
    const blobOf = (path: string) => {
      const f = files.find((x) => x.path === path);
      return f ? blobs.get(f.blob) : undefined;
    };
    const mcp = jsonMap(blobOf(".mcp.json"));
    return {
      project: { settings: jsonMap(blobOf(".claude/settings.json")), mcpServers: isMap(mcp.mcpServers) ? { ...mcp.mcpServers } : {}, memory, plugin },
      remove,
    };
  } catch (e) {
    remove();
    throw e;
  }
}

/**
 * `extra` laid over `base`: maps merge key by key, lists are joined, and anything else is `extra`'s. So
 * both files' hooks run, and both their allow rules and env apply.
 */
export function mergeSettings(base: Settings, extra: Settings): Settings {
  const out: Settings = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const was = out[k];
    out[k] = isMap(was) && isMap(v) ? mergeSettings(was, v) : Array.isArray(was) && Array.isArray(v) ? [...(was as unknown[]), ...(v as unknown[])] : v;
  }
  return out;
}

/** Names in a settings list (`disabledMcpjsonServers`), or none. */
function names(settings: Settings | null, key: string): string[] {
  const v = settings?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * What a session that runs in a branch's files (the change's worktree, or a copy of it) is given so
 * that Claude Code's project setup comes from main, never from the branch: a build could otherwise
 * change, through its branch's `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` or `.claude/skills`,
 * what the sessions after it (fix, verify, review, revise) are told and allowed.
 * - Claude Code loads no project or local settings (only the user's; none with `sources: repo`), so
 *   none of the branch's: not its settings, CLAUDE.md files, rules, skills, agents or MCP servers.
 * - main's settings ride in `--settings`, under `loopstraSettings` (the hook, and with `sources: repo`
 *   the sign-in settings): both sets of hooks run.
 * - main's CLAUDE.md files and rules are an added dir, read only, whose instructions are loaded (`env`).
 * - main's skills, agents and commands load as the plugin `project` (`project:<name>`).
 * - main's MCP servers come in `--mcp-config`, but for those settings disable.
 * Hooks and MCP servers from main's settings still start in the branch's folder, so one that runs a
 * script from the project runs the branch's copy. `main` is null when main has none of it (see
 * mainProjectAt): the session then loads only the user's settings, and Loopstra's.
 */
export function fromMain(main: MainProject | null, sources: "all" | "repo", loopstraSettings: string): {
  run: Pick<RunPhaseInput, "settingSources" | "settings" | "addDirs" | "pluginDir" | "mcpConfig">;
  deny: string[];
  env: Record<string, string>;
} {
  const settingSources = sources === "repo" ? "" : "user";
  if (main === null) return { run: { settingSources, settings: loopstraSettings }, deny: [], env: {} };
  const user = sources === "all" ? readJson<unknown>(join(userHome(), ".claude", "settings.json")) : null;
  const disabled = new Set([...names(main.settings, "disabledMcpjsonServers"), ...names(isMap(user) ? user : null, "disabledMcpjsonServers")]);
  const servers = Object.fromEntries(Object.entries(main.mcpServers).filter(([name]) => !disabled.has(name)));
  return {
    run: {
      settingSources,
      settings: JSON.stringify(mergeSettings(main.settings, JSON.parse(loopstraSettings) as Settings)),
      addDirs: [main.memory],
      ...(main.plugin ? { pluginDir: main.plugin } : {}),
      ...(Object.keys(servers).length ? { mcpConfig: JSON.stringify({ mcpServers: servers }) } : {}),
    },
    deny: noEditsUnder(main.memory),
    env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" },
  };
}
