import { loadConfig } from "../config";
import { setup, type SetupOptions } from "./index";
import { StreamPrompt } from "./prompt";

/**
 * After `loopstra init`, in a terminal: offer the walkthrough now. One prompt reads the input for the
 * offer and for setup's questions: a second reader after the first closes would lose input (or hang).
 * Setup says why when it saves nothing; init has succeeded either way, so this returns nothing.
 */
export async function offerSetup(root: string, o: Pick<SetupOptions, "input" | "output" | "interactive" | "env" | "sections" | "checkMs"> = {}): Promise<void> {
  if (!(o.interactive ?? process.stdin.isTTY)) return;
  const output = o.output ?? process.stdout;
  const ask = new StreamPrompt(o.input ?? process.stdin, output);
  let walk = false;
  try { walk = await ask.yesNo("\nWalk through the settings now?", true); } catch { /* input ended */ }
  if (!walk) { ask.close(); return; }
  await setup(root, { ...o, output, interactive: true, prompt: ask });
  const branch = await loadConfig(root).then((c) => ` on ${c.main_branch}`, () => "");
  output.write(`\nNext: commit what init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore)${branch}, then run \`loopstra start\`.\n`);
}
