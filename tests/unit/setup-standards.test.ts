import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Git } from "../../src/git";
import { standards } from "../../src/setup/sections/standards";
import { tempDir, tempGitRepo, withEnv, writeTestStamp } from "../helpers";
import { askSection, checkSection } from "../setup-helpers";

const CONFIG = "version: 1\ncommands:\n  test: echo ok\n";
const std = (title: string, rules: string, front = "") => `${front}# ${title}\n\n## Rules\n${rules}`;
const dirs: Array<{ cleanup: () => void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()!.cleanup(); });

/** A committed repo with the config, some source files and these standard files. */
async function repo(files: Record<string, string> = {}) {
  const r = await tempGitRepo();
  dirs.push(r);
  mkdirSync(join(r.path, "loopstra", "standards"), { recursive: true });
  mkdirSync(join(r.path, "services"), { recursive: true });
  writeFileSync(join(r.path, "loopstra", "config.yaml"), CONFIG);
  writeFileSync(join(r.path, "services", "a.ts"), "x\n");
  writeFileSync(join(r.path, "services", "b.ts"), "x\n");
  writeTestStamp(r.path);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(r.path, "loopstra", "standards", name), text);
  await new Git(r.path).commitAll("standards");
  return r.path;
}

const asked = (root: string, answers: string[] | "defaults", only = true) => askSection(standards, root, answers, {}, { only });
const onDisk = (root: string, name: string) => readFileSync(join(root, "loopstra", "standards", `${name}.md`), "utf8");

describe("the standards section", () => {
  test("in a full setup it asks first, and no asks nothing more; --defaults adds none", async () => {
    const root = await repo();
    const no = await asked(root, ["n"], false);
    expect(no.shown).toContain("Set up standards, rules every change is checked against, now?");
    expect(no.shown).not.toContain("What to do with the standards");
    expect(no.files).toEqual([]);
    const d = await asked(root, "defaults", true);
    expect(d.files).toEqual([]);
    expect(existsSync(join(root, "loopstra", "standards", "security.md"))).toBe(false);
  });

  test("alone it lists the existing standards and the problems", async () => {
    const root = await repo({
      "arch.md": std("Architecture", "- ARCH-1: Use ports.\n- ARCH-2: Use repos.\n", '---\napplies_to: ["services/**"]\nneeds_person: true\ncheck: echo hi\n---\n'),
      "broken.md": "no title\n",
    });
    const { shown } = await asked(root, ["done"]);
    expect(shown).toContain("Architecture (loopstra/standards/arch.md): applies to services/**; needs a person before it merges; check echo hi; 2 rules");
    expect(shown).toContain("loopstra/standards/broken.md cannot be read");
  });

  test("adds a blank standard: name, title, patterns with their match count, person, check, two rules", async () => {
    const root = await repo();
    const r = await asked(root, ["add", "", "security", "Security", "services/**", "y", "-", "SEC-1: No secrets in code.", "SEC-2: Log access.", "", "done"]);
    expect(r.shown).toContain("2 files on main match.");
    expect(r.shown).toContain("$LOOPSTRA_BASE");
    expect(r.files).toEqual(["loopstra/standards/security.md"]);
    expect(onDisk(root, "security")).toBe('---\napplies_to: ["services/**"]\nneeds_person: true\n---\n# Security\n\n## Rules\n- SEC-1: No secrets in code.\n- SEC-2: Log access.\n');
    expect(r.shown).toContain("Commit loopstra/standards/");
  });

  test("a label used twice is refused naming the rule that has it, and a bad pattern is asked again", async () => {
    const root = await repo({ "arch.md": std("Architecture", "- ARCH-1: Use ports.\n") });
    const r = await asked(root, ["add", "", "security", "Security", "services/[", "services/**", "n", "-", "ARCH-1: Mine.", "SEC-1: Mine.", "SEC-1: Again.", "", "done"]);
    expect(r.shown).toContain("is an unclosed bracket");
    expect(r.shown).toContain('The label ARCH-1 is already used by the rule "Use ports." in Architecture.');
    expect(r.shown).toContain('The label SEC-1 is already used by this standard\'s rule "Mine."');
    expect(onDisk(root, "security")).toContain("- SEC-1: Mine.\n");
    expect(onDisk(root, "security")).not.toContain("ARCH-1");
  });

  test("the check suggestion is the base-aware gitleaks form when gitleaks is on PATH", async () => {
    const root = await repo();
    const bin = tempDir("loopstra-bin-");
    dirs.push(bin);
    const tool = join(bin.path, "gitleaks");
    writeFileSync(tool, "#!/bin/sh\nexit 0\n");
    chmodSync(tool, 0o755);
    const r = await withEnv({ PATH: `${bin.path}${delimiter}${process.env.PATH ?? ""}` }, () => asked(root, ["add", "", "secrets", "Secrets", "-", "n", "", "SEC-1: No secrets.", "", "done"]));
    expect(r.shown).toContain('[gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"]');
    expect(onDisk(root, "secrets")).toContain('check: gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"');
    // - leaves it out.
    const none = await withEnv({ PATH: `${bin.path}${delimiter}${process.env.PATH ?? ""}` }, () => asked(root, ["add", "", "plain", "Plain", "-", "n", "-", "P-1: Fine.", "", "done"]));
    expect(none.files).toEqual(["loopstra/standards/plain.md"]);
    expect(onDisk(root, "plain")).not.toContain("check:");
  });

  test("an example is offered to start from", async () => {
    const root = await repo();
    const r = await asked(root, ["add", "Architecture, for every change", "", "", "", "", "", "", "", "done"]);
    expect(r.files).toEqual(["loopstra/standards/architecture.md"]);
    expect(onDisk(root, "architecture")).toContain("- ARCH-1: Modules use each other");
  });

  test("edit removes a rule and rewords another", async () => {
    const root = await repo({ "arch.md": std("Architecture", "- ARCH-1: Use ports.\n- ARCH-2: Use repos.\n- ARCH-3: Keep ADRs.\n", "---\nneeds_person: false\n---\n") });
    const r = await asked(root, ["edit", "arch", "", "", "", "", "ARCH-2, ARCH-3", "ARCH-3: Keep ADRs in docs/adr/.", "", "done"]);
    expect(r.files).toEqual(["loopstra/standards/arch.md"]);
    expect(onDisk(root, "arch")).toBe("# Architecture\n\n## Rules\n- ARCH-1: Use ports.\n- ARCH-3: Keep ADRs in docs/adr/.\n");
  });

  test("remove deletes the file", async () => {
    const root = await repo({ "arch.md": std("Architecture", "- ARCH-1: Use ports.\n") });
    const r = await asked(root, ["remove", "arch", "done"]);
    expect(r.files).toEqual(["loopstra/standards/arch.md"]);
    expect(existsSync(join(root, "loopstra", "standards", "arch.md"))).toBe(false);
  });

  test("a result that would not read saves nothing", async () => {
    const root = await repo({ "broken.md": "no title\n" });
    await expect(asked(root, ["add", "", "security", "Security", "-", "n", "-", "SEC-1: Fine.", "", "done"])).rejects.toThrow("the standards would not read, so none were saved: loopstra/standards/broken.md cannot be read");
    expect(existsSync(join(root, "loopstra", "standards", "security.md"))).toBe(false);
  });

  test("the check lists a tool check that fails on main, with the warning", async () => {
    const root = await repo({ "gate.md": std("Gate", "- G-1: Pass it.\n", '---\ncheck: bun -e "process.exit(3)"\n---\n') });
    const checks = await checkSection(standards, root);
    const bad = checks.find((c) => c.level === "warn");
    expect(bad?.text).toContain("The check of Gate fails on main already");
  });
});
