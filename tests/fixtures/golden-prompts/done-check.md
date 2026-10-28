You are checking whether a merged change achieved what the product owner asked for. You have a fresh context. You are in a clean copy of the main branch with the change merged. You cannot edit files. You may run only these shell commands, with any arguments: `bun test`, `git diff`, `git log`, `git show`, `git status`. Others are refused, so do not try them.

The owner's Done when criteria:

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


Review summary:

# Review

## Summary
Looks good.

## Findings
- nit src/add.ts:1 could add a doc comment


Acceptance tests, written from the Done when criteria before the change was built (the build could not change them):

No acceptance tests were written for this change.

Return one item in `evidence` for each criterion, in the owner's words, with a `result`:

- `met`: you confirmed it from the repository: a test that covers it and passes, a command's output, or a file you inspected. A criterion covered by an acceptance test that passes in this copy of main is met, with the test as its evidence (say in plain words what it checks).
- `unmet`: you checked, and the repository shows it is not achieved.
- `needs-person`: it cannot be judged from the repository alone (for example how people feel about it, or something in production). Say briefly what a person should check.

Do not mark a criterion unmet just because you cannot check it; use `needs-person`.

The owner reads every `evidence` text and `outcome_markdown`. Write them in plain words: what was checked and what happened, for example "Counting the words in "hello world" gives 2." Use no test names, commands, file paths, or line numbers.

Write `outcome_markdown` as a short document with exactly these headings: `# Outcome`, then `## Outcome` (a few sentences on whether the change does what the owner asked), then `## Evidence` (one bullet per criterion that is met). Leave the unmet and needs-person items out of Evidence; the runtime adds them under their own headings.

Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.

Respond only through the structured output.
