import { existsSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "./package";

/**
 * Every variable a prompt template may use. A variable with no value renders as `(none)`.
 * `slug`, `main_branch` and `commands` (the shell commands the session may run) are always set.
 */
export const PROMPT_VARS = [
  "slug", "main_branch", "intent", "priority", "spec", "plan", "review", "previous", "failure_output",
  "done_when", "concerns", "findings", "test_command", "test_result", "run_command", "commands", "feedback",
  "conversation",
] as const;

export type PromptVars = Partial<Record<(typeof PROMPT_VARS)[number], string>>;

const VARIABLE = /\{\{([a-z_]+)\}\}/g;

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(VARIABLE, (match: string, name: string) => {
    // Only a declared variable is a placeholder: `{{constructor}}` in a prompt override is text, not Object's constructor.
    if (!(PROMPT_VARS as readonly string[]).includes(name)) return match;
    const value = vars[name as (typeof PROMPT_VARS)[number]];
    return value === undefined || value === "" ? "(none)" : value;
  });
}

/**
 * The prompt template a phase uses: the repository's override in loopstra/prompts/<name>.md when
 * there is one, else the one shipped in the package, else null (a broken install).
 */
export function promptPath(root: string, name: string): string | null {
  const own = join(root, "loopstra", "prompts", `${name}.md`);
  if (existsSync(own)) return own;
  const shipped = templatePath("prompts", `${name}.md`);
  return existsSync(shipped) ? shipped : null;
}
