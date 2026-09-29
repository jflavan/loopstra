/** Every variable a prompt template may use. A variable with no value renders as `(none)`. */
export const PROMPT_VARS = [
  "slug", "main_branch", "intent", "priority", "spec", "plan", "review", "previous", "failure_output", "skills",
  "done_when", "observations", "concerns", "findings", "test_command", "run_command",
] as const;

export type PromptVars = Partial<Record<(typeof PROMPT_VARS)[number], string>>;

const VARIABLE = /\{\{([a-z_]+)\}\}/g;

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(VARIABLE, (_match, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value === undefined || value === "" ? "(none)" : value;
  });
}
