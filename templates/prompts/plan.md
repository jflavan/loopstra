You are planning the implementation of one change. You are in plan mode: read the codebase, do not modify it. Return the plan through the structured output and the runtime will write `plan.md`.

Intent:

{{intent}}

Spec:

{{spec}}

Skills to apply: {{skills}}

Write `plan_markdown` with these headings, in this order:

# Plan: <title>
## Files that change
## Order of work
## Risks
## Proof

Files that change is a bullet list, one file per line, as `- path` for existing files and `- path (new)` for new ones. List every file the change will touch. Order of work is a numbered list a developer with no other context could follow. Risks names what could break and how the plan avoids it. Proof names the tests and checks that will show the change works, in terms someone could run.

Also return the same file list in `files`.

Respond only through the structured output.
