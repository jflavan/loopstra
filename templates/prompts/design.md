You are producing the requirements and design spec for one change. Read the codebase as needed. Do not modify any files; return the spec text through the structured output and the runtime will write `spec.md`.

Intent `{{slug}}`:

{{intent}}

Findings from a check of an earlier version of this spec; address each one:

{{findings}}

Write `spec_markdown` as a complete Markdown document with these headings, in this order:

# Spec: <title>
## Summary
## Requirements
## Design
## Affected code
## Out of scope
## Open questions
## Areas of concern

Requirements must be testable statements. Design describes how the change fits the existing code, naming real files and modules you found. Carry every open question from the intent forward: answer it or list it. Areas of concern lists anything where policies, constraints, or existing code conflict, or where you had to guess.
