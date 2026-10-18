import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "../package";
import { readStamp, STAMP_FILE, textSha, writeStamp } from "../stamp";

/**
 * `loopstra customize [prompt]`: copies a shipped prompt into loopstra/prompts/ as the repository's
 * override and records its base in the stamp, so later upgrades merge into it. With no name, lists
 * the prompts and which ones the repository overrides.
 */
export async function customize(root: string, name: string | undefined): Promise<{ ok: boolean; text: string }> {
  const shippedDir = templatePath("prompts");
  const names = readdirSync(shippedDir).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort();
  const own = (n: string) => existsSync(join(root, "loopstra", "prompts", `${n}.md`));
  if (!name) {
    return {
      ok: true,
      text: [
        "Prompts (yours: the repository's own copy in loopstra/prompts/ is used):",
        ...names.map((n) => `  ${n}${own(n) ? " (yours)" : ""}`),
        "",
        "loopstra customize <prompt> copies one into loopstra/prompts/ for you to edit.",
      ].join("\n"),
    };
  }
  const n = name.replace(/\.md$/, "");
  if (!names.includes(n)) return { ok: false, text: `No shipped prompt is called ${n}. Run loopstra customize to list them.` };
  const rel = `loopstra/prompts/${n}.md`;
  if (own(n)) return { ok: false, text: `${rel} is already yours.` };
  // Without a stamp the repository was set up by an older Loopstra; writing one here would stop
  // upgrade from adopting it (removing its old prompt copies and the old hook).
  const stamp = readStamp(root);
  if (!stamp) return { ok: false, text: `This repository has no ${STAMP_FILE} yet: run loopstra upgrade first, then loopstra customize ${n}.` };
  const text = readFileSync(join(shippedDir, `${n}.md`), "utf8");
  mkdirSync(join(root, "loopstra", "prompts"), { recursive: true });
  writeFileSync(join(root, rel), text);
  stamp.files[rel] = { base: textSha(text) };
  writeStamp(root, stamp);
  return { ok: true, text: `Wrote ${rel} and recorded it in ${STAMP_FILE}. Edit it, commit both, and the loop uses it from then on.` };
}
