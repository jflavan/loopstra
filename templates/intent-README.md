# Intents

This folder is the queue of changes for this repository. Each change is a folder with a plain name, for example `claims-status-self-service/`, holding one file you write and a few the system writes.

## To ask for a change

1. Make a folder with a short name in lowercase words joined by hyphens.
2. Copy the template below into `intent.md` inside it, and fill it in with your own words.
3. When you are ready, change `status: draft` to `status: accepted` and save.

The system takes it from there. Check `queue.md` in this folder to see where every change is; its "Needs a person" list is everything waiting for someone.

## Where a change is

The `status` line at the top of `intent.md` says where the change is, and the `note` line says what to do, if anything. Most of the time the system is working and you do nothing.

| Status | What it means | What you do |
|---|---|---|
| `draft` | You are still writing it. | Set `accepted` when it is ready. |
| `accepted` | Waiting to be designed. | Nothing. |
| `designing`, `planning`, `building`, `reviewing` | The system is working. | Nothing. |
| `spec-approved`, `plan-approved` | Approved, waiting for the next step. | Nothing. |
| `spec-review`, `plan-review` | The automatic checks passed and the system is waiting for a person to look. | Read `spec.md` or `plan.md`. If it is right, set `spec-approved` or `plan-approved`. If not, say what is wrong in the `note` and set the earlier status back. |
| `merge-review` | The automatic checks passed and the change is waiting to go into the main code. | Follow the note. If it says it is waiting for the checks on GitHub, nothing. If it asks you to approve the pull request, approve it on GitHub. If it asks you to set `merge-approved`, read `review.md` and set it. |
| `merge-approved` | You said the change may go into the main code. | Nothing. |
| `merged` | The change is in the main code. | Nothing. |
| `verifying` | The system is waiting for a person to confirm the change is done. | Look at the result. If it is right, set `done`. |
| `done` | Finished. | Nothing. |
| `blocked` | The system cannot go on by itself. | Read the `note`. It says in plain words what to do next. |
| `closed` | Stopped on purpose. | Nothing. |

To stop a change at any point, set `status: closed`.

Your changes to `intent.md` are picked up whether or not you commit them; saving the file is enough. The system never writes over what you wrote: if you change the status while it is working on that change, it stops that step and goes with your status.

A finished change also gets `lessons.md`, notes for the engineers; you can leave it to them.

`plan.md` is written for the engineers; you do not need to read it unless the note asks you to.

When a change is finished, `outcome.md` may have a section called "For a person to confirm". These are things the system could not check for itself. They never hold the change up; look at them when you can.

## Template

```markdown
---
status: draft
# priority: low, normal, high or urgent. Leave it out and Loopstra fills it in.
author: Your name
opened: 2026-01-01
note: ""
---
# Intent: a short title

## Problem
What is wrong or missing today, and for whom.

## Proposed outcome
What should be true when this is done.

## Done when
- A short list of things someone could check to confirm it is done.

## Affected users and systems
Who and what this touches.

## Constraints
Anything that must not change, or rules this has to follow.

## Open questions
Anything you are unsure about.
```

Priority is one of `low`, `normal`, `high`, `urgent`. You can leave it out: Loopstra then decides one from what you wrote and adds the line for you.
