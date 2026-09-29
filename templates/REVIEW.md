# Review instructions

Loopstra's reviewer and any Claude review of this repository follow these rules.

## Passes
- Bugs: logic errors, broken edge cases, subtle regressions.
- Security: injection risks, authentication gaps, secrets or PII in logs.
- Compliance: the change matches `spec.md` and `plan.md` for its intent, and the repository's conventions in `CLAUDE.md`.

## What Important means here
Reserve `important` for findings that break behavior, leak data, breach policy, or contradict the spec or plan. Style and naming are nits.

## Cap the nits
Report at most five nits per review; summarize the rest as a count.

## Do not report
Generated files, lockfiles, and anything CI already enforces.
