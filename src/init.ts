import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Git } from "./git";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

export interface InitReport {
  /** Files created or changed. */
  written: string[];
  /** Files that already existed and were left exactly as they were. */
  kept: string[];
  warnings: string[];
  next: string[];
  /** Set when init wrote nothing because the folder cannot be set up (the warning says why). */
  stopped?: boolean;
}

interface Detected { test?: string; install?: string; lint?: string; build?: string; run?: string }

export async function detectCommands(root: string): Promise<Detected> {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let s: Record<string, string> = {};
    try {
      s = (JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch { /* an unreadable package.json means nothing is detected */ }
    const bun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) || /\bbun\b/.test(Object.values(s).join(" "));
    const runner = bun ? "bun run" : "npm run";
    const d: Detected = { install: bun ? "bun install" : "npm install" };
    if (s.test) d.test = bun ? (s.test === "bun test" ? "bun test" : `${runner} test`) : "npm test";
    if (s.lint) d.lint = `${runner} lint`;
    if (s.build) d.build = `${runner} build`;
    if (s.start) d.run = `${runner} start`;
    else if (s.dev) d.run = `${runner} dev`;
    return d;
  }
  // GNU make reads GNUmakefile, makefile, then Makefile.
  const makefile = ["GNUmakefile", "makefile", "Makefile"].find((n) => hasEntry(root, n));
  if (makefile) {
    const mk = await Bun.file(join(root, makefile)).text();
    const has = (t: string) => new RegExp(`^${t}:`, "m").test(mk);
    return { test: has("test") ? "make test" : undefined, lint: has("lint") ? "make lint" : undefined, build: has("build") ? "make build" : undefined, run: has("run") ? "make run" : undefined };
  }
  if (existsSync(join(root, "pyproject.toml"))) return { test: "pytest", install: existsSync(join(root, "uv.lock")) ? "uv sync" : undefined };
  if (existsSync(join(root, "Cargo.toml"))) return { test: "cargo test", build: "cargo build" };
  if (existsSync(join(root, "go.mod"))) return { test: "go test ./...", build: "go build ./..." };
  return {};
}

/**
 * The branch the loop treats as main: the one checked out now, else (a detached HEAD) git's
 * init.defaultBranch, else `main`. `symbolic-ref` also names the branch of a repository with no
 * commits yet.
 */
async function defaultBranch(root: string): Promise<string> {
  const git = new Git(root);
  const head = await git.run(["symbolic-ref", "--short", "HEAD"], true);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  const configured = await git.run(["config", "init.defaultBranch"], true);
  if (configured.code === 0 && configured.out.trim()) return configured.out.trim();
  return "main";
}

/**
 * Whether the folder has an entry spelled exactly `name`. existsSync ignores case on Windows and
 * macOS, so `claude.md` would pass for `CLAUDE.md` there but not on Linux; this answers the same
 * everywhere.
 */
function hasEntry(dir: string, name: string): boolean {
  try { return readdirSync(dir).includes(name); } catch { return false; }
}

/**
 * True (with a warning) when the folder has `name` only in another case (`claude.md` for
 * `CLAUDE.md`). Writing `name` next to it would replace it on Windows and macOS, and it is not what
 * git or Claude Code read on Linux, so init leaves such a file alone and says so.
 */
function otherCase(dir: string, name: string, report: InitReport): boolean {
  let found: string | undefined;
  try { found = readdirSync(dir).find((n) => n !== name && n.toLowerCase() === name.toLowerCase()); } catch { /* no folder */ }
  if (!found || hasEntry(dir, name)) return false;
  report.kept.push(found);
  report.warnings.push(`There is a ${found} but no ${name}. Rename it to ${name} (the spelling every system reads), then run init again.`);
  return true;
}

/** Writes a file only when it does not exist yet; an existing file is never touched. */
async function stamp(root: string, rel: string, content: string, report: InitReport): Promise<void> {
  const target = join(root, rel);
  if (existsSync(target)) { report.kept.push(rel); return; }
  mkdirSync(dirname(target), { recursive: true });
  await Bun.write(target, content);
  report.written.push(rel);
}

const template = (...parts: string[]) => Bun.file(join(TEMPLATES, ...parts)).text();

function commandLines(d: Detected): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    d.test ? `  test: ${q(d.test)}` : "  test:",
    "  # Optional. Leave a key out if you do not have it.",
    d.install ? `  install: ${q(d.install)}` : "  # install:",
    d.lint ? `  lint: ${q(d.lint)}` : "  # lint:",
    d.build ? `  build: ${q(d.build)}` : "  # build:",
    d.run ? `  run: ${q(d.run)}` : "  # run:",
  ].join("\n");
}

export async function init(root: string): Promise<InitReport> {
  const report: InitReport = { written: [], kept: [], warnings: [], next: [] };
  // The loop lives in git (branches, worktrees, commits on main): without a repository, write nothing.
  if ((await new Git(root).run(["rev-parse", "--is-inside-work-tree"], true)).code !== 0) {
    return { ...report, stopped: true, warnings: ["This folder is not a git repository; run git init first."] };
  }
  const d = await detectCommands(root);

  const branch = await defaultBranch(root);
  const cfg = (await template("config.yaml"))
    .replace("__MAIN_BRANCH__", /^[\w./-]+$/.test(branch) ? branch : JSON.stringify(branch))
    .replace("__COMMANDS__", commandLines(d));
  if (!d.test) report.warnings.push("No test command was detected. Set commands.test in loopstra/config.yaml before starting the loop.");
  await stamp(root, "loopstra/config.yaml", cfg, report);

  for (const name of readdirSync(join(TEMPLATES, "prompts")).sort()) {
    await stamp(root, `loopstra/prompts/${name}`, await template("prompts", name), report);
  }
  await stamp(root, "intent/README.md", await template("intent-README.md"), report);
  await stamp(root, "intent/queue.md", "# Queue\n\nGenerated by Loopstra on every pass. Nothing has run yet.\n", report);
  await stamp(root, "REVIEW.md", await template("REVIEW.md"), report);
  await stamp(root, ".claude/skills/loopstra/SKILL.md", await template("skill", "SKILL.md"), report);
  await stamp(root, HOOK_FILE, await template("hooks", "loopstra-protect-tests.ts"), report);

  await mergeSettings(root, report);
  await ensureClaudeMd(root, d, report);
  await ensureGitignore(root, report);

  report.next.push(
    `Commit the files init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore) on ${branch}. The loop works in its own checkouts, which only see what is committed.`,
    "Open loopstra/config.yaml and confirm commands.test.",
    "Decide which gates get a person (gates.*.human).",
    "Start the loop with `loopstra start`; watch it with `loopstra status` or `loopstra ui`.",
  );
  return report;
}

/** The hook init stamps, and the name that marks it in .claude/settings.json. */
export const HOOK_FILE = ".claude/hooks/loopstra-protect-tests.ts";
export const HOOK_MARK = "loopstra-protect-tests";
const HOOK_COMMAND = `bun "$CLAUDE_PROJECT_DIR/${HOOK_FILE}"`;

async function mergeSettings(root: string, report: InitReport): Promise<void> {
  const rel = ".claude/settings.json";
  const path = join(root, rel);
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    const text = await Bun.file(path).text();
    try {
      settings = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      report.warnings.push(`${rel} is not valid JSON, so the test-protection hook was not added. Fix the file and run init again.`);
      report.kept.push(rel);
      return;
    }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  const pre = hooks.PreToolUse ?? [];
  if (pre.some((h) => JSON.stringify(h).includes(HOOK_MARK))) { report.kept.push(rel); return; }
  pre.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  hooks.PreToolUse = pre;
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
  report.written.push(`${rel} (hook added)`);
}

async function ensureClaudeMd(root: string, d: Detected, report: InitReport): Promise<void> {
  const rel = "CLAUDE.md";
  const path = join(root, rel);
  if (otherCase(root, rel, report)) return;
  const existing = hasEntry(root, rel) ? await Bun.file(path).text() : "";
  if (/^##\s+Commands\s*$/m.test(existing)) { report.kept.push(rel); return; }
  const lines = [
    "## Commands",
    "",
    `- Test: ${d.test ? `\`${d.test}\`` : "(set in loopstra/config.yaml)"}`,
    ...(d.install ? [`- Install: \`${d.install}\``] : []),
    ...(d.lint ? [`- Lint: \`${d.lint}\``] : []),
    ...(d.build ? [`- Build: \`${d.build}\``] : []),
    ...(d.run ? [`- Run: \`${d.run}\``] : []),
    "",
  ].join("\n");
  const head = existing ? existing.replace(/\s*$/, "\n\n") : "# Project\n\n";
  await Bun.write(path, head + lines);
  report.written.push(existing ? "CLAUDE.md (Commands added)" : rel);
}

/**
 * Loopstra's own files that must be committed on `main` for the loop's checkouts (worktrees) to see
 * them: the config, the prompts, and, when init wired the test-protection hook, the settings and the
 * hook. Returns the ones that are missing from main, the prompts folder as one entry.
 */
export async function uncommittedSetup(root: string, main: string): Promise<string[]> {
  const prompts = existsSync(join(root, "loopstra", "prompts")) ? readdirSync(join(root, "loopstra", "prompts")).map((n) => `loopstra/prompts/${n}`) : [];
  const settings = join(root, ".claude", "settings.json");
  const hooked = existsSync(settings) && (await Bun.file(settings).text()).includes(HOOK_MARK);
  const wanted = ["loopstra/config.yaml", ...prompts, ...(hooked ? [".claude/settings.json", HOOK_FILE] : [])];
  const r = await new Git(root).run(["ls-tree", "-r", "--name-only", main, "--", ...wanted], true);
  const onMain = new Set(r.code === 0 ? r.out.split(/\r?\n/).map((l) => l.trim()) : []);
  const missing = wanted.filter((p) => !onMain.has(p) && existsSync(join(root, p)));
  const named = missing.map((p) => (p.startsWith("loopstra/prompts/") ? "loopstra/prompts/" : p));
  return [...new Set(named)];
}

async function ensureGitignore(root: string, report: InitReport): Promise<void> {
  const rel = ".gitignore";
  const path = join(root, rel);
  if (otherCase(root, rel, report)) return;
  const existing = hasEntry(root, rel) ? await Bun.file(path).text() : "";
  if (existing.split(/\r?\n/).some((l) => l.trim() === ".loopstra/" || l.trim() === ".loopstra")) { report.kept.push(rel); return; }
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  await Bun.write(path, `${existing}${sep}.loopstra/\n`);
  report.written.push(existing ? ".gitignore (.loopstra/ added)" : rel);
}
