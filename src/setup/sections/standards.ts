import { Git } from "../../git";
import { STANDARD_EXAMPLES } from "../../standard-examples";
import { formToMarkdown, globProblem, parseStandards, problemText, RULE_LABEL, standardsFilesAt, STANDARD_NAME, STANDARDS_DIR, standardToForm, type StandardForm, type StandardsRead } from "../../standards";
import { baseAware } from "../../standards-check";
import { andList, printable } from "../../text";
import { standardsChecks } from "../standards-checks";
import type { Section, SetupContext } from "../types";

/** The tool checks offered; the first one found on PATH is the suggestion. */
const TOOLS: { program: string; command: string }[] = [
  { program: "gitleaks", command: baseAware("gitleaks") ?? "" },
  { program: "semgrep", command: baseAware("semgrep") ?? "" },
  { program: "trivy", command: "trivy fs --exit-code 1 ." },
  { program: "checkov", command: "checkov -d . --quiet" },
];

const BLANK = "a blank standard";
const list = (answer: string) => answer.split(",").map((s) => s.trim()).filter(Boolean);
const pathOf = (name: string) => `${STANDARDS_DIR}/${name}.md`;

/** What one run knows: the standard files as main has them with this run's changes, and the files on main. */
interface Run {
  ctx: SetupContext;
  /** Every file in the standards folder: main's, then this run's writes (null removes). */
  files: Map<string, string | null>;
  mainFiles: string[];
}

function read(run: Run): StandardsRead {
  return parseStandards([...run.files].flatMap(([path, text]) => (text === null ? [] : [{ path, text }])));
}

function toolSuggestion(env: SetupContext["env"]): string {
  const path = env.PATH ?? process.env.PATH;
  return TOOLS.find((t) => t.command && Bun.which(t.program, { PATH: path }))?.command ?? "";
}

function mainName(ctx: SetupContext): string {
  const v = ctx.doc.get(["main_branch"]);
  return typeof v === "string" && v ? v : "main";
}

/** The standards folder on main and every file on main; nothing when there is no git or no commit. */
async function load(ctx: SetupContext): Promise<{ files: { path: string; text: string }[]; names: string[] }> {
  try {
    const git = new Git(ctx.root);
    const main = await git.commitOf(mainName(ctx));
    if (!main) return { files: [], names: [] };
    const files = (await standardsFilesAt(git, main)).files;
    const tree = await git.run(["ls-tree", "-r", "-z", "--name-only", main]);
    return { files, names: tree.out.split("\0").filter(Boolean) };
  } catch {
    return { files: [], names: [] };
  }
}

function describe(r: StandardsRead): string[] {
  return r.standards.map((s) => {
    const scope = s.appliesTo ? s.appliesTo.join(", ") : "every change";
    return `  ${printable(s.title)} (${s.path}): applies to ${printable(scope)}; ${s.needsPerson ? "needs a person before it merges" : "needs no person"}; ${s.check ? `check ${printable(s.check)}` : "no tool check"}; ${s.rules.length} rule${s.rules.length === 1 ? "" : "s"}`;
  });
}

/** Where a label is already used, as a phrase naming the rule, or null. */
function labelOwner(run: Run, label: string, form: StandardForm): string | null {
  const own = form.rules.find((r) => r.label === label);
  if (own) return `this standard's rule "${printable(own.text)}"`;
  for (const s of read(run).standards) {
    if (s.name === form.name) continue;
    const r = s.rules.find((x) => x.label === label);
    if (r) return `the rule "${printable(r.text)}" in ${printable(s.title)}`;
  }
  return null;
}

async function askRules(run: Run, form: StandardForm): Promise<void> {
  const { ask } = run.ctx;
  if (form.rules.length) {
    ask.say(`The rules now:\n${form.rules.map((r) => `  ${printable(r.label)}: ${printable(r.text)}`).join("\n")}`);
    // Removal comes first so a rule can be reworded: remove it, then add it again with the same label.
    const gone = list(await ask.text("Rules to remove (labels, comma-separated)", {
      optional: true,
      check: (a) => {
        const unknown = list(a).filter((l) => !form.rules.some((r) => r.label === l));
        return unknown.length ? `Not a rule here: ${unknown.join(", ")}.` : null;
      },
    }));
    form.rules = form.rules.filter((r) => !gone.includes(r.label));
  }
  for (;;) {
    const answer = await ask.text("Add a rule as LABEL: text (Enter when done)", { optional: true });
    if (!answer) {
      if (form.rules.length || !ask.interactive) return;
      ask.say("  A standard needs at least one rule.");
      continue;
    }
    const m = /^(\S+?):\s*(\S.*)$/.exec(answer);
    if (!m) { ask.say("  Write it as LABEL: text, like ARCH-1: Modules use each other only through what they export."); continue; }
    const [label, text] = [m[1] ?? "", m[2] ?? ""];
    if (!RULE_LABEL.test(label)) { ask.say("  A label starts with a capital letter and has up to 32 letters, digits, dots, underscores and dashes, ending in a letter or digit, like ARCH-1."); continue; }
    const owner = labelOwner(run, label, form);
    if (owner) { ask.say(`  The label ${label} is already used by ${owner}.`); continue; }
    form.rules.push({ label, text });
  }
}

/** The patterns' problem in words, or null. */
function patternProblem(answer: string): string | null {
  for (const p of list(answer)) {
    const why = globProblem(p);
    if (why) return `${printable(p)} is ${why}. Write patterns like services/** or src/**/*.ts, separated by commas.`;
  }
  return null;
}

async function askForm(run: Run, start: StandardForm, isNew: boolean): Promise<StandardForm> {
  const { ask } = run.ctx;
  const form: StandardForm = { ...start, patterns: [...start.patterns], rules: start.rules.map((r) => ({ ...r })) };
  if (isNew) {
    form.name = await ask.text("File name (lowercase words joined by dashes, like security)", {
      suggestion: form.name || undefined,
      check: (n) => (!STANDARD_NAME.test(n) ? "A name is lowercase words joined by dashes, like security." : run.files.get(pathOf(n)) != null ? `There is already a standard called ${n}.` : null),
    });
  }
  form.title = await ask.text("Title", { suggestion: form.title || undefined });
  const patterns = await ask.text("Files it applies to (patterns, comma-separated; - for every change)", { suggestion: form.patterns.join(", ") || undefined, optional: true, check: patternProblem });
  form.patterns = list(patterns);
  if (form.patterns.length) {
    const globs = form.patterns.map((p) => new Bun.Glob(p));
    const count = run.mainFiles.filter((f) => globs.some((g) => g.match(f))).length;
    ask.say(`  ${count} file${count === 1 ? "" : "s"} on ${mainName(run.ctx)} ${count === 1 ? "matches" : "match"}.`);
  }
  form.needsPerson = await ask.yesNo("Does a change under this standard need a person before it merges?", form.needsPerson);
  ask.say("A tool check is a command that exits 0 when the code keeps the rules. It gets $LOOPSTRA_BASE, the commit where the change left main, so a scanner can look only at what the change adds.");
  form.check = await ask.text("Tool check (- for none)", { suggestion: form.check || toolSuggestion(run.ctx.env) || undefined, optional: true });
  await askRules(run, form);
  return form;
}

function stage(run: Run, path: string, text: string | null): void {
  run.files.set(path, text);
  run.ctx.files.push({ path, content: text });
}

async function add(run: Run): Promise<void> {
  const way = await run.ctx.ask.pick("Start from", [BLANK, ...STANDARD_EXAMPLES.map((e) => e.label)], BLANK);
  const example = STANDARD_EXAMPLES.find((e) => e.label === way);
  const start: StandardForm = example ? { ...example.form } : { name: "", title: "", patterns: [], needsPerson: false, check: "", rules: [], context: "" };
  const form = await askForm(run, start, true);
  stage(run, pathOf(form.name), formToMarkdown(form));
  run.ctx.ask.say(`${pathOf(form.name)} will be written. ${form.context ? "" : "Write why these rules exist, links to your design records and examples under its title. "}It is plain Markdown to edit any time.`);
}

async function edit(run: Run): Promise<void> {
  const { ask } = run.ctx;
  const all = read(run).standards;
  if (!all.length) { ask.say("There are no standards to edit."); return; }
  const name = await ask.pick("Which standard to edit", all.map((s) => s.name), all[0]!.name);
  const current = all.find((s) => s.name === name)!;
  stage(run, current.path, formToMarkdown(await askForm(run, standardToForm(current), false)));
}

async function remove(run: Run): Promise<void> {
  const { ask } = run.ctx;
  const names = [...run.files].filter(([, t]) => t !== null).map(([p]) => p.slice(STANDARDS_DIR.length + 1, -3)).filter((n) => STANDARD_NAME.test(n));
  if (!names.length) { ask.say("There are no standards to remove."); return; }
  const name = await ask.pick("Which standard to remove", names, names[0]!);
  stage(run, pathOf(name), null);
  ask.say(`${pathOf(name)} will be removed.`);
}

export const standards: Section = {
  name: "standards",
  title: "Standards",
  covers: [],

  async ask(ctx) {
    if (!ctx.only && !(await ctx.ask.yesNo("Set up standards, rules every change is checked against, now?", false))) return;
    const { files, names } = await load(ctx);
    const run: Run = { ctx, files: new Map(files.map((f) => [f.path, f.text])), mainFiles: names };
    const first = read(run);
    ctx.ask.say("A standard is a Markdown file in loopstra/standards/ that states rules; every change it applies to is checked against them.");
    ctx.ask.say(first.standards.length ? `The standards on ${mainName(ctx)}:\n${describe(first).join("\n")}` : `There are no standards on ${mainName(ctx)} yet.`);
    if (first.problems.length) ctx.ask.say(`These cannot be read:\n${first.problems.map((p) => `  ${problemText(p)}`).join("\n")}`);
    for (;;) {
      const choice = await ctx.ask.pick("What to do with the standards", ["done", "add", "edit", "remove"] as const, "done");
      if (choice === "done") break;
      if (choice === "add") await add(run);
      else if (choice === "edit") await edit(run);
      else await remove(run);
    }
    if (!ctx.files.some((f) => f.path.startsWith(`${STANDARDS_DIR}/`))) return;
    // The whole resulting set must read, or nothing is saved.
    const result = read(run);
    if (result.problems.length) throw new Error(`the standards would not read, so none were saved: ${andList(result.problems.map(problemText))}`);
    ctx.ask.say("Commit loopstra/standards/ on the main branch once it is written.");
  },

  check: (ctx, cfg) => standardsChecks(ctx.root, cfg),
};
