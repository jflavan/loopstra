export type PromptVars = Partial<Record<
  "slug" | "intent" | "spec" | "plan" | "review" | "previous" | "failure_output" | "skills" | "done_when" | "observations" | "concerns" | "findings",
  string
>>;

const VARIABLE = /\{\{([a-z_]+)\}\}/g;

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(VARIABLE, (_match, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value === undefined || value === "" ? "(none)" : value;
  });
}
