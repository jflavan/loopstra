import type { PhaseName } from "./envelopes";

/** The line the standards start under when phasePrompt adds them to a prompt. */
export const STANDARDS_HEADING = "Standards this repository holds every change to:";

/** What the build and the resolve are told about the rules: keep them, or ask. */
const KEEP_THE_RULES = "Keep every rule below. If the plan would make you break one, ask a question rather than break it.";

/**
 * What each phase does with the standards, said to its session. The shipped prompts are not changed:
 * this text reaches a session only when the repository has standards (see standardsBlock).
 */
export const STANDARDS_INSTRUCTIONS: Partial<Record<PhaseName, string>> = {
  design: [
    "Add `## Standards` after Areas of concern. List each rule below that your design decides something about, as `- LABEL: how the design keeps it`, and each rule it cannot keep, as `- LABEL: exception: why`. A person decides whether an exception is allowed. Write \"None.\" when there are none.",
    "The Standards section is for engineers, like Design and Affected code, and may be technical.",
  ].join("\n\n"),
  "spec-check": [
    "4. Check the spec against the standards below.",
    "   - Check each bullet of the spec's Standards section against its Design. Is the claim borne out?",
    "   - Does the design break any rule that applies, whether the Standards section mentions it or not? A rule it breaks without asking for an exception is a finding that is not met, with `standard` set to the rule's label.",
    "   - An exception is not yours to grant or refuse. Check that its reason is stated and that the design does what it says. Whether the exception is acceptable is a person's call.",
    "",
    "Standards, like Design and Affected code, is a section for engineers and may be technical.",
  ].join("\n"),
  plan: [
    "Add `## Standards` after Proof. Write one bullet for every rule below that applies. A standard marked as applying only to certain files applies when your Files that change lists a file its patterns match, so cover its rules too. Use one of three forms:",
    "- `- LABEL: how the plan keeps it, and which item under Proof shows it`",
    "- `- LABEL: does not apply: why`",
    "- `- LABEL: exception: why`",
    "A person decides whether an exception is allowed. A rule you cannot keep without an exception is not yours to skip.",
  ].join("\n"),
  "plan-challenge": [
    "Check the plan against the standards below.",
    "   - Check each bullet of the plan's Standards section against its Order of work and Proof. Is the claim borne out?",
    "   - Is each \"does not apply\" sound? A rule that does apply, set aside as not applying, is a concern with `blocking` true.",
    "   - Does the plan break any rule that applies, or claim something the Order of work does not carry out? That is a concern with `blocking` true. Set `standard` to the rule's label.",
    "   - An exception is not yours to grant or refuse. Check that its reason is stated and that the plan does what it says. Whether the exception is acceptable is a person's call.",
  ].join("\n"),
  "done-check": [
    "Judge each rule below that applies to this change, in `standards`, as you judge the Done when criteria: one item for each, with its `label`, a `result` and the `evidence`.",
    "- `met`: only with evidence from the repository (a test, a command's output, a file you inspected). A standard's check that passed at merge, listed below, can be the evidence for the rules it covers.",
    "- `unmet`: you checked, and the repository shows the change does not keep the rule.",
    "- `needs-person`: the repository cannot show it (for example, \"the alert exists in the monitoring system\"). Say briefly what a person should check.",
    "A rule listed under an approved exception is not yours to judge. Leave the standards out of `outcome_markdown`: the runtime writes their section.",
  ].join("\n"),
  build: KEEP_THE_RULES,
  resolve: KEEP_THE_RULES,
  review: [
    "A change that breaks a rule below is an important finding; set `standard` to the rule's label.",
    "A rule listed under an approved exception is one a person allowed this change not to keep, for the reason given: a breach within an approved exception is not a finding.",
  ].join(" "),
};

/** The standards as a phase's prompt gets them: the heading, the phase's instructions, then the standards. "" when there are none. */
export function standardsBlock(phase: PhaseName, standards: string): string {
  if (!standards) return "";
  const instructions = STANDARDS_INSTRUCTIONS[phase];
  return [STANDARDS_HEADING, ...(instructions ? [instructions] : []), standards].join("\n\n");
}
