import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Git, samePath } from "./git";
import { stampVersion, templatePath } from "./package";
import { managedFiles, STAMP_FILE, textSha, writeStamp, type Stamp } from "./stamp";
import { OLD_HOOK_FILE } from "./upgrade/legacy";

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
    // The package manager by its lock file; scripts that call bun mean bun too.
    const locked = (name: string) => existsSync(join(root, name));
    const pm = locked("bun.lock") || locked("bun.lockb") ? "bun"
      : locked("pnpm-lock.yaml") ? "pnpm"
      : locked("yarn.lock") ? "yarn"
      : /\bbun\b/.test(Object.values(s).join(" ")) ? "bun" : "npm";
    const runner = `${pm} run`;
    const d: Detected = { install: `${pm} install` };
    if (s.test) d.test = pm === "bun" ? (s.test === "bun test" ? "bun test" : `${runner} test`) : `${pm} test`;
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
  if (existsSync(join(root, "pyproject.toml"))) {
    // A uv project's pytest is in its own environment, not on PATH.
    const uv = existsSync(join(root, "uv.lock"));
    return { test: uv ? "uv run pytest" : "pytest", install: uv ? "uv sync" : undefined };
  }
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

const template = (...parts: string[]) => Bun.file(templatePath(...parts)).text();

function commandLines(d: Detected): string {
  const q = (v: string) => JSON.stringify(v);
  const optional = ["install", "lint", "build", "run"] as const;
  return [
    "  # Optional: leave a key out if you do not have it.",
    ...optional.map((k) => (d[k] ? `  ${k}: ${q(d[k]!)}` : `  # ${k}:`)),
    "  # The single command that runs your tests and exits non-zero on failure. A chain (a && b) works:",
    "  # sessions may run the whole chain and each part of it.",
    `  test: ${d.test ? q(d.test) : '""'}`,
  ].join("\n");
}

/**
 * The top folder of the git repository `root` is in, when `root` is a folder below it; null at the
 * top or outside a repository. The loop works on a whole repository: its checkouts, sessions and
 * commands start at the top, and Claude Code reads the settings and hook there.
 */
export async function repositoryTop(root: string): Promise<string | null> {
  const top = await new Git(root).run(["rev-parse", "--show-toplevel"], true);
  if (top.code !== 0 || samePath(top.out.trim(), root)) return null;
  return top.out.trim();
}

export async function init(root: string): Promise<InitReport> {
  const report: InitReport = { written: [], kept: [], warnings: [], next: [] };
  // The loop lives in git (branches, worktrees, commits on main): without a repository, write nothing.
  if ((await new Git(root).run(["rev-parse", "--is-inside-work-tree"], true)).code !== 0) {
    return { ...report, stopped: true, warnings: ["This folder is not a git repository; run git init first."] };
  }
  const d = await detectCommands(root);
  const top = await repositoryTop(root);
  if (top) {
    const here = (await new Git(root).run(["rev-parse", "--show-prefix"])).out.trim().replace(/\/$/, "");
    // A folder name with a space is quoted, or the shell reads it as two words.
    const example = `cd ${/\s/.test(here) ? `"${here}"` : here} && ${d.test ?? "<your test command>"}`;
    return { ...report, stopped: true, warnings: [`This folder is inside the git repository at ${top}. Loopstra works on a whole repository: run loopstra init in ${top}, and set its commands to run in this folder (for example ${example}).`] };
  }

  const branch = await defaultBranch(root);
  const cfg = (await template("config.yaml"))
    .replace("__MAIN_BRANCH__", /^[\w./-]+$/.test(branch) ? branch : JSON.stringify(branch))
    .replace("__COMMANDS__", commandLines(d));
  if (!d.test) report.warnings.push("No test command was detected. Set commands.test in loopstra/config.yaml before starting the loop.");
  // Set up by a Loopstra from before the stamp: upgrade adopts it (drops old prompt copies and the
  // old hook), which it only does while there is no stamp, so init writes none.
  const older = !existsSync(join(root, STAMP_FILE))
    && (existsSync(join(root, "loopstra", "config.yaml")) || existsSync(join(root, "loopstra", "prompts")) || existsSync(join(root, OLD_HOOK_FILE)));
  await stamp(root, "loopstra/config.yaml", cfg, report);

  await stamp(root, "intent/README.md", await template("intent-README.md"), report);
  await stamp(root, "intent/queue.md", "# Queue\n\nGenerated by Loopstra on every pass. Nothing has run yet.\n", report);
  await stamp(root, "REVIEW.md", await template("REVIEW.md"), report);
  await stamp(root, ".claude/skills/loopstra/SKILL.md", await template("skill", "SKILL.md"), report);
  if (!older) await writeInitialStamp(root, report);

  await ensureClaudeMd(root, d, report);
  await ensureGitignore(root, report);

  if (older) report.next.push("This repository was set up by an older Loopstra: run `loopstra upgrade` to bring it up to date.");
  // Setup, then commit (what it saved goes in with the rest), then start.
  report.next.push(
    "Walk through the settings with `loopstra setup` (budgets, commands, gates, GitHub, chat, models), or edit loopstra/config.yaml.",
    `Commit the files init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore) on ${branch}. The loop works in its own checkouts, which only see what is committed.`,
    "Start the loop with `loopstra start`; watch it with `loopstra status` or `loopstra ui`.",
  );
  return report;
}

/**
 * Records where each managed file came from, when the repository has no stamp yet: each one that
 * exists gets the sha of today's shipped text. A file init just wrote is that text; a file of the
 * repository's own is then merged into only once the shipped text changes again. (A kept file that
 * is an older shipped text is adopted properly by upgrade; init stays fast and offline without the
 * shipped index.)
 */
async function writeInitialStamp(root: string, report: InitReport): Promise<void> {
  if (existsSync(join(root, STAMP_FILE))) { report.kept.push(STAMP_FILE); return; }
  const files: Stamp["files"] = {};
  for (const f of managedFiles(root)) {
    if (!existsSync(join(root, f.path))) continue;
    files[f.path] = { base: textSha(await Bun.file(f.shipped).text()) };
  }
  writeStamp(root, { loopstra: await stampVersion(), files });
  report.written.push(STAMP_FILE);
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
 * them: the config, the stamp, and any prompt override. Returns the ones missing from main, the
 * prompts folder as one entry. Only overrides are looked at (`<name>.md`, the only files read
 * there): a .DS_Store, an editor's swap file or a subfolder is not setup.
 */
export async function uncommittedSetup(root: string, main: string): Promise<string[]> {
  const dir = join(root, "loopstra", "prompts");
  const overrides = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".")).map((e) => `loopstra/prompts/${e.name}`)
    : [];
  const wanted = ["loopstra/config.yaml", STAMP_FILE, ...overrides];
  // -z: git quotes a name that is not ASCII otherwise, and the quoted name would match nothing here.
  const r = await new Git(root).run(["ls-tree", "-r", "-z", "--name-only", main, "--", ...wanted], true);
  const onMain = new Set(r.code === 0 ? r.out.split("\0") : []);
  const missing = wanted.filter((p) => !onMain.has(p) && existsSync(join(root, p)));
  return [...new Set(missing.map((p) => (p.startsWith("loopstra/prompts/") ? "loopstra/prompts/" : p)))];
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
