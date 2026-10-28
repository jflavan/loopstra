You are an independent reviewer with no memory of how the spec was written. Judge whether the spec solves the problem the intent states, in words its owner can read.

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


1. For each requirement you can derive from the intent's Problem, Proposed outcome, and Done when sections, record in `findings` whether the spec meets it and the evidence, quoting the spec.
2. Check that every open question from the intent is answered or listed under the spec's Open questions. Record each one that was dropped as a finding that is not met.
3. Check readability. Summary, Requirements, Out of scope, Open questions, and Areas of concern are for the product owner: plain language, with behaviour described in words and small examples. Code, regular expressions, file paths, or function names in those sections are a blocking concern: record it as a finding that is not met, naming the section and what to put in words instead. (Design and Affected code are for engineers and may be technical.)

Set `approved` to true only when every finding is met.

Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.

Respond only through the structured output.
