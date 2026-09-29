You are writing the spec for one change: what it must do, and how it fits the code. Read the codebase as needed. You cannot change files: return the spec through the structured output and the runtime writes `spec.md`.

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

Two readers:

- Summary, Requirements, Out of scope, Open questions, and Areas of concern are for the product owner, who approves the spec. Write them in plain language. Describe behaviour in words and small examples (for example: "hello world" counts as 2 words). Use no code, regular expressions, file paths, or function names there.
- Design and Affected code are for engineers and may be as technical as needed.

Requirements are a list of statements someone could check, each one testable. Design describes how the change fits the existing code, naming the real files and modules you found. Affected code lists them. Carry every open question from the intent forward: answer it, or list it under Open questions. Areas of concern lists anything where policies, constraints, or existing code conflict, or where you had to guess; write "None." when there is nothing.
