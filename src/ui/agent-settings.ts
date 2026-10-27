import { once } from "../agents";
import type { AgentField, AgentsView, AgentStepRow } from "../console/types";

/*
 * The Agents section's plain logic: what a step ends up with and where it comes from, what each
 * picker offers, and how a typed list is read. The loop checks every change in full before it saves.
 */

export type Field = AgentField;

/** Where a step's value comes from: its own, all steps, its stage's skills, or the build's agent (fix, reconcile, revise). */
type From = "own" | "all" | "stage" | "build" | null;

export interface Effective { value: string | string[] | null; from: From }

const listOf = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/**
 * What a step's session gets for a field, the way the loop adds it up (see resolveSetup): one agent
 * (its own, else all steps'), or a list of all steps', the stage's skills and its own, each once.
 * `from` names the first that sets it: own, then all steps, then the stage. Fix, reconcile and revise
 * run as the build's agent: given the build's row, the value is that agent.
 */
export function effective(row: AgentStepRow, field: Field, build?: AgentStepRow): Effective {
  if (field === "agent") {
    if (row.continuesBuild) return { value: build ? effective(build, "agent").value : null, from: "build" };
    const own = row.own.agent;
    if (typeof own === "string") return { value: own, from: "own" };
    const all = row.fromAll.agent;
    return typeof all === "string" ? { value: all, from: "all" } : { value: null, from: null };
  }
  const own = listOf(row.own[field]);
  const all = listOf(row.fromAll[field]);
  const stage = field === "skills" ? row.fromStage : [];
  const from: From = own.length ? "own" : all.length ? "all" : stage.length ? "stage" : null;
  return { value: once([...all, ...stage, ...own]), from };
}

/**
 * The muted note beside a value: "from all steps", "stage skill", "as build", "from all steps and
 * stage skills", or for a step's own list that gets more from elsewhere, "with all steps". "" when
 * the value is the step's own alone, or there is none.
 */
export function fromNote(e: Effective, row: AgentStepRow, field: Field): string {
  if (e.from === "build") return "as build";
  if (e.from === null || field === "agent") return e.from === "all" ? "from all steps" : "";
  const fromAll = listOf(row.fromAll[field]).length > 0;
  const fromStage = field === "skills" && row.fromStage.length > 0;
  if (e.from === "stage") return Array.isArray(e.value) && e.value.length === 1 ? "stage skill" : "stage skills";
  const parts = [...(fromAll ? ["all steps"] : []), ...(fromStage ? ["stage skills"] : [])];
  if (!parts.length) return "";
  return `${e.from === "own" ? "with" : "from"} ${parts.join(" and ")}`;
}

/**
 * What a step gets for a field, as text beside its control: the value with where it comes from
 * ("Read (from all steps)", "lead (as build)"), "none" when it gets nothing, and "" when it gets
 * only its own value, which the control shows already.
 */
export function getsText(e: Effective, row: AgentStepRow, field: Field): string {
  const shown = Array.isArray(e.value) ? listText(e.value) : e.value ?? "none";
  const note = fromNote(e, row, field);
  if (note) return `${shown} (${note})`;
  return e.from === null ? "none" : "";
}

/**
 * A list picker's summary: what the step gets for a list field, in the order the session gets it,
 * with the names it gets from all steps or its stage marked, as the models page's picker says what a
 * step runs on: "tone (from all steps)", "tone, house (tone from all steps)", "none". A name the step
 * also sets itself counts as inherited: taking it off the step would leave it. The checkboxes stay
 * the step's own list.
 */
export function pickSummary(row: AgentStepRow, field: Field): string {
  const e = effective(row, field);
  const names = Array.isArray(e.value) ? e.value : [];
  const fromAll = listOf(row.fromAll[field]);
  const fromStage = field === "skills" ? row.fromStage.filter((n) => !fromAll.includes(n)) : [];
  const sources = [{ names: fromAll, where: "from all steps" }, { names: fromStage, where: "from the stage" }].filter((x) => x.names.length);
  if (!sources.length) return listText(names);
  if (sources.length === 1 && sources[0]!.names.length === names.length) return `${listText(names)} (${sources[0]!.where})`;
  return `${listText(names)} (${sources.map((x) => `${x.names.join(", ")} ${x.where}`).join("; ")})`;
}

/** A text with backticked names, as parts: the names to show as code, the rest as text. A backtick without its pair stays text. */
export function codeParts(text: string): { text: string; code: boolean }[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) {
    const tail = parts.pop()!;
    parts[parts.length - 1] += `\`${tail}`;
  }
  return parts.map((t, i) => ({ text: t, code: i % 2 === 1 })).filter((p) => p.text !== "");
}

/**
 * What a step's picker offers for a field: for its own agent, the library's agents but Claude Code's
 * built-ins (a step runs as an agent defined in a file), none for a step that runs as the build's;
 * for subagents (and a team's members), the library's agents and the built-ins; the teams by name;
 * the library's skills. With `sources: repo`, only the repository's items, as only those load.
 * Tools are typed, not picked.
 */
export function choicesFor(view: AgentsView, field: Field, step: AgentStepRow["key"]): string[] {
  const usable = view.library.filter((i) => view.sources === "all" || i.from === "repo");
  const agents = once(usable.filter((i) => i.kind === "agent").map((i) => i.name));
  switch (field) {
    case "agent": {
      if (view.steps.find((r) => r.key === step)?.continuesBuild) return [];
      const builtins = new Set(view.builtins);
      return agents.filter((n) => !builtins.has(n));
    }
    case "subagents": return once([...agents, ...view.builtins]);
    case "teams": return view.teams.map((t) => t.name);
    case "skills": return once(usable.filter((i) => i.kind === "skill").map((i) => i.name));
    default: return [];
  }
}

/** A picker's choices with the names already chosen added after them, so a name it does not offer can be taken off. */
export function withChosen(choices: readonly string[], chosen: readonly string[]): string[] {
  return once([...choices, ...chosen]);
}

/** A list as the page shows it: "a, b", or "none". */
export function listText(v: readonly string[]): string {
  return v.length ? v.join(", ") : "none";
}

/** A typed list read back: split on commas, trimmed, empties dropped, each once, in order. */
export function parseList(text: string): string[] {
  return once(text.split(",").map((s) => s.trim()).filter(Boolean));
}
