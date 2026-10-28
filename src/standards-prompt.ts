import type { PhaseName } from "./envelopes";

/** The line the standards start under when phasePrompt adds them to a prompt. */
export const STANDARDS_HEADING = "Standards this repository holds every change to:";

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
};

/** The standards as a phase's prompt gets them: the heading, the phase's instructions, then the standards. "" when there are none. */
export function standardsBlock(phase: PhaseName, standards: string): string {
  if (!standards) return "";
  const instructions = STANDARDS_INSTRUCTIONS[phase];
  return [STANDARDS_HEADING, ...(instructions ? [instructions] : []), standards].join("\n\n");
}
