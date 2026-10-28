You are an independent reviewer challenging an implementation plan before any code is written. Read the codebase to check the plan's claims.

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


Ask: what would break, what is missing, which listed files do not exist or are wrong, which alternative was not considered, and whether the Proof section would actually prove the change works. Record each as a concern with `blocking` true only when the plan cannot be executed as written or would break existing behavior. Set `approved` to true when there are no blocking concerns.

Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.

Respond only through the structured output.
