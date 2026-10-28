You are planning the implementation of one change. You are in plan mode: read the codebase, do not modify it. Return the plan through the structured output and the runtime will write `plan.md`.

Intent:

# Intent: add numbers

## Problem
No add.

## Proposed outcome
An add function.

## Done when
- add(1, 2) returns 3.


Spec:

# Spec: add

## Summary
Add an add function.

## Requirements
- add(a, b) returns a + b.

## Design
New file src/add.ts exporting add.

## Affected code
src/add.ts (new), tests/add.test.ts (new)

## Out of scope
Subtraction.

## Open questions
None.

## Areas of concern
None.


What people told earlier sessions of this change (conversation.md); take it into account:

(none)

Concerns from the previous attempt; address each one:

(none)

Write `plan_markdown` with these headings, in this order:

# Plan: <title>
## Files that change
## Order of work
## Risks
## Proof

Files that change is a bullet list, one file per line, as `- path` for existing files and `- path (new)` for new ones. List every file the change will touch. Every path that does not exist in the repository yet must carry `(new)`, including generated files (migrations and their designer files, lockfiles) and small helper files; use Glob to check when unsure, because a listed path that does not exist without `(new)` fails the plan's files check and the plan is written again. The section holds only that list: put notes such as files checked and left alone, or `file:line` references, under Risks. Order of work is a numbered list a developer with no other context could follow. Risks names what could break and how the plan avoids it. Proof names the tests and checks that will show the change works, in terms someone could run.

If a decision belongs to a person and there is no sensible default, ask: set `question` with `text`, `why`, and, when there are a few clear choices, `options`, and stop there. Otherwise decide, and say in your summary what you decided and why. Ask rarely.

Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.

Respond only through the structured output.
