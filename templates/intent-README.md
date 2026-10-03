# Intents

This folder is the queue of changes for this repository. Each change is a folder with a plain name, for example `claims-status-self-service/`, holding one file you write and a few the system writes.

## To ask for a change

1. Make a folder with a short name in lowercase words joined by hyphens.
2. Copy the template below into `intent.md` inside it, and fill it in with your own words.
3. When you are ready, change `status: draft` to `status: accepted` and save.

The system takes it from there. Check `queue.md` in this folder to see where every change is; its "Needs a person" list is everything waiting for someone.

## Or talk it through

If your team has set up Loopstra's chat (in the terminal, the dashboard, Slack or Discord), you can describe what you want there instead. It asks questions until the change is clear, shows you a summary, and when you say yes, writes the change up for you as a draft (usually as a pull request for someone to review and merge). A draft still waits for someone to accept it: set `status: accepted`, or, if you are allowed to, ask in the chat to start it. You can also ask the chat how any change is going.

## How big a change should be

One change is designed, planned, and built in one go, by one working session with a time and cost limit. A change the size of a whole product will not fit: it stops partway and waits for a person. Keep each change to something one person could build in a day or two. Split larger work into several changes, and say which ones must go into the main code first with `depends_on`.

## One change after another

When a change needs another one to be in the main code first, name that change in a `depends_on` line at the top of its `intent.md`:

```
depends_on: [01-foundation, 02-accounts]
```

The change waits until every change it names is `merged`, `verifying` or `done`. If one of them is blocked, it keeps waiting, and its note in `queue.md` says which change it waits for and where that one is. Without `depends_on`, changes run in order of priority and date, but a blocked change does not hold up the ones after it.

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

`spec.md` is written partly for you: its Summary, Requirements, Out of scope, Open questions, and Areas of concern say in plain words what the change will do. Its Design and Affected code sections are for the engineers. `plan.md` is written for the engineers; you do not need to read it unless the note asks you to.

When a change is finished, `outcome.md` may have a section called "For a person to confirm". These are things the system could not check for itself. They never hold the change up; look at them when you can.

## Template

```markdown
---
status: draft
# priority: low, normal, high or urgent. Leave it out and Loopstra fills it in.
# depends_on: [another-change] (optional: changes that must be merged first)
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
