/** The longest target shown for one tool call. */
const TARGET_MAX = 120;

/** `path` relative to `cwd` when it lies inside it, with forward slashes; otherwise `path` as it is. */
export function relativePath(path: string, cwd?: string): string {
  if (!path) return "";
  const p = path.replaceAll("\\", "/");
  const base = cwd?.replaceAll("\\", "/").replace(/\/+$/, "");
  // Case-blind, so a Windows drive letter written either way still matches; this is for display only.
  if (base && p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return p.slice(base.length + 1);
  return p;
}

/** What a tool call works on, in one short line: the command, the file, the pattern. "" when nothing fits. */
export function toolTarget(name: string, input: unknown, cwd?: string): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let target: string;
  switch (name) {
    case "Bash": target = str(i.command).split(/\r?\n/)[0] ?? ""; break;
    case "Read": case "Edit": case "MultiEdit": case "Write": target = relativePath(str(i.file_path), cwd); break;
    case "NotebookEdit": target = relativePath(str(i.notebook_path), cwd); break;
    case "Grep": case "Glob": target = str(i.pattern); break;
    case "WebFetch": target = str(i.url); break;
    case "WebSearch": target = str(i.query); break;
    case "Task": case "Agent": target = str(i.description); break;
    case "Skill": target = str(i.skill); break;
    default: target = "";
  }
  return target.length > TARGET_MAX ? `${target.slice(0, TARGET_MAX - 1)}…` : target;
}

const VERBS: Record<string, string> = {
  Bash: "Running", Read: "Reading", Edit: "Editing", MultiEdit: "Editing", Write: "Writing", NotebookEdit: "Editing",
  Grep: "Searching for", Glob: "Looking for", WebFetch: "Fetching", WebSearch: "Searching the web for",
  Task: "Handing off", Agent: "Handing off", Skill: "Using the skill", TodoWrite: "Updating its todo list",
  StructuredOutput: "Writing its answer",
};

/** What a session is doing, from its newest tool call: "Running bun test", "Editing src/a.ts". */
export function nowText(tool: string, target: string): string {
  const verb = VERBS[tool] ?? `Using ${tool}`;
  return target ? `${verb} ${target}` : verb;
}
