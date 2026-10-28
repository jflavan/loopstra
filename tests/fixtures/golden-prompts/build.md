You are implementing one change in an isolated worktree on branch `intent/add-numbers`. Follow the plan. Do not commit: the runtime commits your work when you finish.

Plan:

# Plan: add

## Files that change
- src/add.ts (new)
- tests/add.test.ts (new)

## Order of work
1. Write the failing test.
2. Implement add.

## Risks
None.

## Proof
`bun test` passes with tests/add.test.ts covering add(1, 2).


Spec, for reference:

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

A person's notes on an earlier build of this change; address each one:

(none)

Rules:

- Implement what the plan lists. If you must touch a file the plan does not list, do it and say so in your summary.
- Add or update tests that prove the new behaviour. Do not weaken, skip, or delete existing tests.
- Run the test command (`bun test`) before you finish and fix what fails.
- The shell commands you may run, with any arguments: `bun`, `git diff`, `git log`, `git show`, `git status`, `bun test`. Others are refused, so do not try them.

When done, write a one-line `commit_message` for your work; the runtime uses it.

If a decision belongs to a person and there is no sensible default, ask: set `question` with `text`, `why`, and, when there are a few clear choices, `options`, and stop there. Otherwise decide, and say in your summary what you decided and why. Ask rarely.

Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.

Respond only through the structured output.
