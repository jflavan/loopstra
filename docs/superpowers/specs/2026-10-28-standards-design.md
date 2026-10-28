# Standards: rules every change is held to

2026-10-28. A way for an engineering or architecture team to write down the rules every change must keep (architecture, security, compliance controls such as SOC 2's), and have the loop check each change against them at every gate, with a record per rule of how the change met it. The user asked for this as a spec and left most decisions to Claude; each one marked "Claude's call" is recorded in `docs/decisions.md` when it is built. The user chose, from options, several parts; those are marked "The user's choice":
- how the record stays accurate as standards change;
- how exceptions are granted, and who may approve them;
- how tool checks run;
- how much the spec and plan list;
- the command, and keeping `needs_person`;
- changing a change's standards by hand;
- the console's editor, and its list of exceptions.

The user also asked for three more things:
- the whole workflow possible in the console (writing and scoping standards, approving exceptions, reviewing them);
- `loopstra setup` able to set up standards and their tool checks;
- the onboarding agent (the operator skill in a Claude Code session) able to help draft them.

## Why

Today a repository can tell Loopstra's sessions how to work (`CLAUDE.md`, `.claude/rules`, skills, agents, `REVIEW.md`), but nothing holds a change to that guidance except the reviewer, late, by its own reading:

- `spec-check` checks that the spec answers the intent and reads plainly. `plan-challenge` checks that the plan can be carried out. Neither is asked whether the design or the plan breaks the repository's rules, so a design that puts a second service on another's database passes both and is found, if at all, after it is built.
- `done-check` checks the owner's Done when list. A requirement that holds for every change ("every endpoint that returns customer data checks the caller's role") reaches it only if each owner writes it into each intent, which nobody will.
- Nothing records, per rule, how a change kept it. A team that answers to an auditor (SOC 2's change management, CC8.1, asks for evidence that each change was designed, reviewed, tested and approved against policy) has review.md and a pass, not "rule SEC-3: met, because…".
- A build session can edit `CLAUDE.md` or `REVIEW.md` on its branch. Since #89 that cannot change what the change's own later sessions are told, but once merged it changes what every later change is told, and no gate looks at it.

## Goals

- A team writes its rules once, as Markdown in the repository, and every change is checked against the ones that apply to it: at the spec, at the plan, in review, and after the merge.
- Each check that can be code is code: which rules apply, whether the plan addresses each one, whether a change edited the rules, and any rule a tool can check (a standard can name the command). The agents judge only what needs judgment: whether a design, plan or diff actually keeps a rule.
- A change that cannot keep a rule can ask for an exception, and only a person can grant it.
- Everything a person does with standards can be done in the console: write, scope and remove them, try their tool checks, see which apply to a change and why, add or remove a standard for one change, approve exceptions, and list every exception granted. `loopstra setup standards` does the writing and checking from a terminal.
- Every change leaves a plain record, in git, of the rules that applied to it and the evidence for each: the spec's and plan's Standards sections, review findings that name the rule, and a Standards section in `outcome.md` that names the version of the standards it was checked against.
- No standards, no change: a repository without `loopstra/standards/` runs exactly as before, and its specs and plans keep their current headings.

## Non-goals

- Loopstra does not make an application compliant with anything, and does not claim to. SOC 2 is an auditor's opinion of an organisation's controls over a period. Standards let a team state the technical controls it wants in the code and get evidence that each change kept them; access reviews, vendor management, incident response and the rest stay outside.
- No standards library shipped with Loopstra (no "SOC 2 pack"). The README shows an example; the rules are the team's, in its words.
- No session of the loop writes or edits standards. A person changes them on `main`: by hand, on the console's Standards page, or in `loopstra setup standards`. The console's writes are made by the loop's runtime (code) for the person who asked, as with agent files. The onboarding agent may draft them in the main checkout with a person (see The onboarding agent). Nothing it writes is in force until that person commits it, since the loop reads standards only from `main`'s commits.
- Chat neither edits standards nor changes which apply to a change (Claude's call: the orchestrator is an agent, and edits made through it would come from an agent). Chat still approves a spec or plan, its exceptions included, as it can today.
- Acceptance tests are not written from standards in this change (a follow-up; see the end).
- Chat does not read standards in this change. The orchestrator is not told them, and intents are unchanged: product owners never need to know the standards exist.
- No export of the trace for auditors (a follow-up). The records in `intent/<slug>/` are the durable evidence this change adds.

## Anti-goals

- **The loop's agents must never weaken the rules that judge their work.** No session of the loop may edit `loopstra/standards/`, and a change whose diff does is blocked, whatever the hook let through. No agent can grant an exception either. (The onboarding agent is not a session of the loop: it works with a person, outside any change, and only a commit by that person puts what it wrote in force.)
- **A broken standards file must never mean "no standards".** If a file on `main` cannot be read, the loop does nothing until it is fixed. It does not run changes as if the rules were not there.
- **Standards must not turn the owner's documents into engineering documents.** The parts of the spec and outcome written for the owner stay in plain words; rule labels and technical evidence go in sections of their own.

---

## Standard files

A standard is one Markdown file in `loopstra/standards/`, named `<name>.md` with lowercase words joined by dashes (like intent slugs). Any other file there is ignored, and `loopstra standards` lists it as ignored. Files are committed, and Loopstra reads them from `main`'s commit, never from a checkout (see Where they are read from).

```markdown
---
applies_to: ["services/**", "api/**"]
needs_person: false
check: bunx depcruise --config .dependency-cruiser.cjs services
---
# Service architecture

Why these rules exist, links to the design records in docs/adr/, examples of the right way.
Sessions are given the whole file, so this text is context, not decoration.

## Rules
- ARCH-1: Services call each other only through their published HTTP APIs. No service reads
  or writes another service's database.
- ARCH-2: New persistent data lives in Postgres, through the repository layer in `src/db/`.
```

- **The front matter is optional.**
  - `applies_to`: glob patterns, matched against repo-relative paths with `/`, with the same semantics as `gates.merge.risky.paths` (Bun.Glob; a bare name matches only at the top). The standard then applies only to a change that touches a matching file. Without it, the standard applies to every change.
  - `needs_person`: `true` makes a change this standard applies to wait for a person before it merges (see Merge). The default is `false`. The user's choice: keep it, so a standard's scope and who must approve it stay in one place rather than repeating the patterns in `gates.merge.risky.paths`.
  - `check`: a shell command that exits 0 when the code keeps the standard's rules a tool can check (a secret scanner, semgrep rules, a layering checker). It runs in the merge checks of every change the standard applies to (see Merge). Optional.
    - It gets `LOOPSTRA_BASE`, the commit where the change's branch left `main`, so a tool can report only what the change introduced: `semgrep scan --error --baseline-commit "$LOOPSTRA_BASE"`, `gitleaks git --log-opts="$LOOPSTRA_BASE..HEAD"`.
    - A check that looks at the whole repository fails every change while `main` itself fails it (see Checks that fail on main).
  - Unknown keys are errors, as in the config.
- **The title is the first `# ` heading.** It is required.
- **The rules are under `## Rules`.** The section is required and holds at least one rule.
  - Each rule is a bullet `- LABEL: text`, where the rule label is a short name the team gives the rule. The spec, the plan, review findings and the outcome point at a rule by its label. Indented lines that follow continue the rule.
  - A rule label starts with a capital letter and has up to 32 letters, digits, `.`, `_` and `-`, ending in a letter or digit: `ARCH-1`, `SOC2-CC6.1`, `SEC_3`. Claude's call: a team's own scheme (including a framework's control numbers) fits, and labels stay the same as rules are added. A rule's number in a list does not, so a label is never derived from its position.
  - No two rules have the same label, across all files.
  - A label may be given to a new rule after its old rule is deleted, and a rule's wording may change. Each outcome records the commit the standards were read from (see Done), so a past "SEC-4: met" always means SEC-4 as worded then. The user's choice: one line in the record instead of a list of retired labels.
- **Everything else in the file is free text.** Sessions read it; Loopstra does not parse it.

A file breaks these rules when it has no title, no Rules section, an empty one, a bullet without a valid rule label, a label used twice, a pattern that is not a valid glob, or front matter that does not parse. Such a file is unreadable (see When a file cannot be read).

### Which standards apply

Applicability is a fact about files, never an agent's judgment, except at the spec, where no file list exists yet:

| When | The files | The standards that apply |
|---|---|---|
| spec | none yet | every standard is shown, the scoped ones with their patterns; the designer judges which its design touches |
| plan | the plan's Files that change | every standard without `applies_to`, and each one whose patterns match a listed file |
| build, resolve | the plan's Files that change | as for the plan |
| review, merge | the branch's diff against `main` outside `intent/` (as `scoreRisk` reads it, renames by old and new path) | as for the plan, on the diff |
| done | the files the change brought into `main` | as for the plan, on those files |

A person can change this for one change (see Changing a change's standards): a standard they added applies at every step from then on, whatever the files, and one they removed applies at none.

A standard that applies is used whole: every rule in it applies. Claude's call: a rule-level scope would let a file of 30 controls send each rule to its own files, but it doubles what a team writes and reads, and splitting such a file in two does the same.

## Where they are read from

Standards are read with `git cat-file` from the same commit of `main` that the step's Claude setup comes from: the step's snapshot commit (`ctx.readCommit()`) for read-only steps, and the commit `main`'s setup is read from for steps in a change's branch (#89). A step reads them once, so all its sessions, and the code checks, use one version.

- A change that edits `loopstra/standards/` cannot change the rules its own steps are judged by (and is blocked anyway; see Protection).
- Uncommitted edits in the main checkout are not standards until committed, just like prompt overrides and the config's agent files.
- A plan written ahead (`speed.plan_ahead`) is used only if it was asked the same prompt, and the standards are part of the prompt, so a standards commit between the two discards it. This needs no new code.

## When a file cannot be read

Unreadable standards are treated like a config that does not load, and the check fails closed:

- At the start of each tick, after the config loads, the tick reads `loopstra/standards/` from `main`'s commit. If any file is unreadable, the tick starts no steps and traces it once while it stays the same (`eventOnChange`), with the reason `standards`. `loopstra status` and the console show it under Needs attention: "loopstra/standards/soc2.md cannot be read: the rule on line 14 has no rule label (write it as `- LABEL: text`). Fix it on main and commit; until then no change moves on."
- `loopstra start` refuses with the same sentence, and `loopstra setup --check` lists it under "To fix" and exits 1.
- A step that finds an unreadable file at its own commit (main moved between the tick's read and the step's) fails as `notTheStepsFault`, keeps its status and runs again. It never runs without the rules.

## `loopstra standards`

A new command for whoever writes the standards, read-only, needing no Claude, with no flags:

```
loopstra standards   # each standard: title, scope (every change, or its patterns), whether it needs a person, its check, its rule labels
```

It reads the files from `main`'s last commit. It names each problem in a file that cannot be read, and the files it ignores. Under the list, it says when the main checkout has uncommitted edits in `loopstra/standards/` that are not yet in force. It exits 0 either way: validating, with an exit code, is `loopstra setup --check`'s job, beside every other check. The user's choice: one command to list, and no second way to check. It warns when the standards together are over 40 KB, since every applicable standard goes into every prompt that uses them whole. Claude's call: a warning, not a limit; a team with large standards can scope them.

---

## The stages

### Prompt variable

Add `standards` to `PROMPT_VARS`. It renders each applicable standard whole, from its title down, under a line naming its scope, with the files that made a scoped one apply:

```
### Service architecture (loopstra/standards/architecture.md)
Applies because the change touches services/billing/api.ts and services/billing/db.ts.

<the file's text, without front matter>
```

For the spec, scoped standards are listed after the ones that apply to every change, under "These apply only to changes that touch the files named." With no standards, the variable is empty and renders as `(none)`.

Rules under an approved exception (see Exceptions) are listed as such, with the reason, in every prompt after the approval. Later steps then neither break the rest of the standard nor report the exception as a breach.

The shipped prompts that get it: `design`, `spec-check`, `plan`, `plan-challenge`, `build`, `resolve`, `review` and `done-check`. `fix`, `reconcile` and `revise` continue the build's session and already have it. A repository's own copy of one of these prompts without `{{standards}}` gets it appended at the end under "Standards this repository holds every change to:", exactly as `{{resolution}}` is appended to `review.md`, but only when the repository has standards, so a repository without them sees no change.

### Spec (design and spec-check)

The spec covers only the rules its design decides something about. The plan, where the files are known, covers every rule that applies. The user's choice: a 40-rule standard would otherwise put about 35 "does not apply" lines in each spec, repeated in its plan, and neither judge loses anything, since both look for breaches of every rule either way.

- **`design.md`** says: when standards are listed, add `## Standards` after Areas of concern. List each rule your design decides something about, `- LABEL: how the design keeps it`, and each rule it cannot keep, `- LABEL: exception: why` (see Exceptions). Write "None." when there are none. This section is for engineers and may be technical.
- **The spec gate gets a code check, `standards`,** run with the headings check when the repository has standards. It checks two things:
  - the `Standards` heading is present;
  - every label there is a real rule's. A label that matches no rule is a failure, which catches a rule the designer invented.

  Evidence: "3 rules addressed, 1 exception", or "no rule called SEC-9".
- **`spec-check.md`** gets a fourth task, when standards are listed:
  - Check each bullet of the Standards section against the Design. Is the claim borne out?
  - Does the design break any rule that applies, whether the section mentions it or not? A rule it breaks without asking for an exception is a finding that is not met, with `standard` set to the rule label.
  - An exception is not the judge's to grant or refuse. The judge does check that its reason is stated and that the design does what it says. Whether the exception is acceptable is a person's call.

  The readability task names Standards with Design and Affected code as the engineers' sections.
- **The envelope.** `requirement` gets an optional `standard: string`. The gate evidence and the rewrite's findings put the rule label first: "SEC-3: the design logs the request body, which holds card numbers".

A failure takes the existing path: one rewrite with the findings, then blocked with the stage's `failedNote`.

### Plan (plan and plan-challenge)

- **`plan.md`** says: when standards are listed, add `## Standards` after Proof. It has one bullet per rule that applies, in one of three forms:
  - `- LABEL: how the plan keeps it, and which item under Proof shows it`;
  - `- LABEL: does not apply: why`;
  - `- LABEL: exception: why`.
- **The plan gate's `standards` code check** checks three things, on the plan's applicable set:
  - the heading is present;
  - every rule of every standard that applies has a bullet, the scoped ones included;
  - every label there is a real rule's.

  It runs after the `files` check, on the files that check read. Evidence: "all 14 rules addressed", or "missing SEC-2, SEC-4; no rule called SEC-9".
- **`plan-challenge.md`** gets the same task as spec-check, on the plan: a "does not apply" that is not sound, a broken rule, or a claim the Order of work does not carry out is a concern with `blocking: true`. `concern` gets an optional `standard`. Exceptions are a person's call, as at the spec.

### Exceptions

A spec or plan can say a rule cannot be kept for this change: `- ARCH-1: exception: billing keeps reading the legacy orders table until it is migrated (ADR-12)`. No agent can grant it. The user's choice: inline in the spec or plan, approved by a person at that gate, rather than a separate file of standing waivers.

- **Who decides.** When a spec or plan passes its checks and has an exception not already approved for this change, its gate waits for a person, even when nobody is on that gate in the config. The runtime writes `spec_gate: status` or `plan_gate: status` in the intent's front matter, in the record that moves the status to `spec-review` or `plan-review`. It works as `merge_gate` does for a risky change: runtime-managed, left out when blank, and read through `changeGates` in `src/intents.ts` beside `merge_gate`, so the scheduler, `status`, the console and chat treat the change as waiting for a person. Unlike `merge_gate`, deleting the line by hand does not approve anything: no agent may grant an exception, so the change is settled again (its checks run again) and waits again.
- **The note.** "The plan asks for an exception to ARCH-1 (Service architecture): billing keeps reading the legacy orders table until it is migrated. Read plan.md. To allow it, set status to plan-approved; to have the plan written again without it, send it back with a note." With more than one exception, it names them all.
- **Who approves.** Whoever can approve the spec or plan today: a status edit, the console, or a chat acceptor. The user's choice: no separate list of approvers; the record says who approved and from where.
- **What counts as approved.** A person moving the status to `spec-approved` or `plan-approved` approves every exception in that artifact. The runtime writes the approval into the change's `standards.md` record (see below) in the same record as the status move: the rule, the reason, the gate, who, from where, and the date. Who is the request's person when the approval came as a request (the console, chat), and "a status edit" when it was made by hand. The trace has it too, as a gate row: `exception`, `pass`, with the labels. An exception approved at the spec and repeated in the plan for the same rule needs no second approval. An exception that is new in the plan, or a rule whose exception the plan's wording changes, does.
- **Later steps.** Build, resolve and review are told which rules are under an approved exception and why (see Prompt variable). A breach of that rule, within what the exception says, is not a finding. The build cannot ask for an exception itself: when the plan would make it break a rule, it asks a question, as it can today, and a person answers or sends the change back.
- **The record.** The outcome's Standards section lists the rule as `- ARCH-1 (Service architecture): exception, approved by J. at the plan: <the reason>` (see Done), and the done-check does not judge it.

### Changing a change's standards

A person can add a standard to one change, or remove one from it, with a note saying why. The user's choice: both, with removing recorded like an exception, so a missed case can be covered and a wrong match taken off, and each is on the record.

- **Where.** From the change's page in the console (see The console), or by editing the change's `standards.md` record by hand. Not from chat.
- **When.** At any status before `done`. It applies from the next step on.
  - **Added after the plan was approved:** review, the merge checks and the done-check check the standard; the plan does not cover it. The console's dialog offers "Send the change back to planning" in the same step, for a person who wants the plan to cover it.
  - **Removed:** the standard stops applying from the next step, its tool check and its `needs_person` included. Removing one is a person taking responsibility for that, and the record says so.
- **The record.** It is a request (`standards-scope`: the change, the status it expects, add or remove, the standard's name and the note, which removing requires). The loop applies it as one record on `main`, `loopstra(<slug>): standard payments added by J. from the dashboard`, writing it into the change's `standards.md`. The trace gets a row, and the outcome's Standards section lists it: "Payments data was added to this change by J.: <note>", or "Service architecture was removed from this change by M.: <note>".

### The change's `standards.md` record

`intent/<slug>/standards.md` holds what people decided about standards for one change, written by the runtime in a fixed format:

```markdown
# Standards decisions for billing-refunds

## Added
- payments: card data passes through the shared lib the patterns miss (J., from the console, 2026-10-28)

## Removed
- architecture: prototype behind a flag, see ADR-14 (M., from the console, 2026-10-28)

## Exceptions approved
- ARCH-1 at the plan: billing keeps reading the legacy orders table until it is migrated (J., from the console, 2026-10-28)
```

- It is written only when there is something to record. A change without decisions has no such file.
- The loop reads Added and Removed to work out which standards apply, and Exceptions approved to know which exceptions need no second approval.
- A person may edit it by hand. Their edit wins, as everywhere. A line that does not read (an unknown standard, or a bullet in another form) is listed under Needs attention, and is not applied until fixed.
- It is the durable record that the console's list of exceptions reads.

### Build and resolve

`build.md` and `resolve.md` get the plan's applicable standards, with one line: "Keep every rule below. If the plan would make you break one, ask a question rather than break it." The build is not checked against them here; review and the merge checks are.

A standard's `check` is not run in the build's own test runs. The user's choice: it runs once, in the merge checks, so a build is not slowed by checks run on every fix. The build session may still run it: each applicable standard's `check` is added to the commands the build, fix, reconcile and revise sessions may run, as the configured commands are.

### Review

- **`review.md`** gets the standards that apply to the diff, with: "A change that breaks a rule below is an important finding; set `standard` to the rule's label."
- **`finding` gets an optional `standard`.** `review.md`, the record, lists a finding's rule label before its location.
- **`REVIEW.md`'s shipped template** gets a Standards pass: "the change keeps every rule in `loopstra/standards/` that applies to it". That covers a Claude review of the repository outside the loop too.
- **A rule that applies to the diff but was not in the plan's set** (the build touched a scoped standard's files the plan did not list) needs no special handling. The reviewer is given it like any other, and the drift check's reconcile has already rewritten the plan.

### Merge

**Tool checks.** After the tests pass in the merge checks, each standard that applies to the diff and has a `check` runs it, in the change's worktree. It gets the same environment as the project's commands (`LOOPSTRA_SLUG`, `LOOPSTRA_SLOT`, the change's temp folder and ports), plus `LOOPSTRA_BASE`: the merge base of the branch and `main`, the same commit the test-protection hook's `LOOPSTRA_BASE` names.
- **Failure.** A check that fails is handled as a failing test there: its output goes to the same test loop (`testLoop`, with the build's fix budget, `stages.build.max_fix_loops`), and fixes then go back to review as other merge-check fixes do.
- **Reruns.** Like the tests, a check that passed on the same code is not run again.
- **Past the fix budget.** The change blocks with a note that names the standard: "The change does not pass the automatic check of the standard Secrets (loopstra/standards/secrets.md), even after 3 tries to fix it. The details are in the trace. An engineer can fix it on the branch and retry the change, or close it."
- **The record.** Each check is a gate row (`merge`, `check:<name>`, `pass` or `fail`), and the outcome's Standards section says it passed.
- **Where the command comes from.** It is read from `main`'s commit with the rest of the standard, so a branch cannot change it. As with hooks from `main`'s settings, a check that runs a script from the repository runs the branch's copy of that script, and a reviewer should read changes to such scripts.

The user's choice: at the merge checks only, once per merge attempt, rather than in every build test run.

**Checks that fail on main.** A tool that scans the whole repository fails on problems already on `main` (an old secret in the history, existing code a new semgrep rule flags). Each change would then fail its merge check for something it did not do, and its fix session would be sent after code outside the change. Loopstra does not try to tell old findings from new ones itself, since only the tool knows its findings. Instead:
- **Base-aware commands.** Every check gets `LOOPSTRA_BASE`, and the README, setup's suggestions, the console's examples and the onboarding agent all use the forms that report only new findings.
- **Trying a check on main.** Setup, `loopstra setup --check`, the console's "Try it on main" and the onboarding agent run each check on `main`'s last commit, with `LOOPSTRA_BASE` set to that commit. A check that fails there is reported with what to do: "The check of Secrets fails on main already, so every change under it would fail it too. Use a form that looks only at what a change adds (with $LOOPSTRA_BASE), or fix main first." In setup it is listed under "To fix", in the console it is a problem at the top of Standards, and `loopstra start` warns once (Claude's call: a warning, not a refusal, since the team may be fixing `main` right now).
- **The block note.** When a change blocks past the fix budget on a check that does not use `LOOPSTRA_BASE`, the note adds: "If main fails this check too, the problem may not be this change's; see loopstra setup --check."

The merge gate also gets two checks, both code, both at `passMergeGate` with the risk check, on the same diff:

1. **`standards-untouched`**: the diff touches nothing under `loopstra/standards/`. If it does, the change is blocked, and the gate row names the files. The note: "This change edits the repository's standards (loopstra/standards/soc2.md), which only a person may change. An engineer can take that edit out of the change's branch and retry the change, or close it." Claude's call: block rather than let a person approve it. An approval at the merge gate is about the change, and a standards edit hidden in a feature is exactly what the reviewer at the gate is least likely to read.
2. **`needs_person`**: a standard with `needs_person: true` that applies to the diff makes the change risky, as a file in `gates.merge.risky.paths` does. The same rule holds as for risk: it only changes who decides when nobody is on the config's merge gate. `scoreRisk` is given the patterns of those standards beside `risky.paths`, and `riskNote` names the standard: "This change falls under the standard Payments data (loopstra/standards/payments.md), which is set to need a person before merging: it touches services/billing/api.ts. Approve the pull request on GitHub, or set status to merge-approved." A `needs_person` standard without `applies_to` makes every change wait. `loopstra standards` says so, since it is the same as `gates.merge.human: pr`.

The trace gets a `standards` row on the merge gate when the repository has standards. It names the standards that apply and their rule labels, so the record of what applied is fixed at the commit that merged.

### Done (done-check and outcome.md)

- **The files** are those the change brought into `main`: the diff of the commit that brought it in, against its first parent (for a squash, the squash commit; for a merge, the merge commit). It is read where the done-check's clean copy of `main` is made. Claude's call: this is the same answer for a local merge, a pull request merged by Loopstra and one merged by hand. If the step cannot name that commit, it uses the merge gate's `standards` row.
- **`done-check.md`** gets the applicable standards, the approved exceptions, and the result of each `check` at merge. The envelope gets `standards: [{ label, result: met | unmet | needs-person, evidence }]`, one item per applicable rule not under an exception, judged as the criteria are: `met` only with evidence from the repository, `needs-person` for what the repository cannot show ("the alert exists in the monitoring system"). A standard's passing `check` can be the evidence for the rules it covers.
- **The runtime writes the section, not the agent.** It appends `## Standards` to `outcome.md`, after the owner's sections. Its first line is a plain sentence for the owner that names the version of the standards: "The engineering rules this change was checked against (the standards as of commit 3f9c2ab):". The commit is the one the done-check's standards were read from.
- **What the section lists:**
  - one bullet per rule, `- LABEL (Title): met: evidence`;
  - an exception as `- LABEL (Title): exception, approved by a person at the plan: <the reason>`;
  - each tool check as `- Check of Secrets: passed at merge`;
  - each standard a person added to or removed from the change, with who and the note, from its `standards.md`.

  The format is the runtime's, so it is the same in every outcome and a script can read it.
- **Unmet rules block,** as unmet criteria do, with their own note when only standards are unmet: "The change merged, but the final check found engineering rules it does not keep. The details are in outcome.md. An engineer should decide whether to open a follow-up change, then set this one to done or closed." When both are unmet, the existing note gets "and engineering rules" after "Done when criteria". `needs-person` rules go under the existing "For a person to confirm" heading too, with their labels.
- **With `gates.done.agent: false`** no rule is judged, and the Standards section lists the rules that applied with "not checked automatically". Claude's call: the record still says what applied.

## Protection

The test-protection hook (`templates/hooks/loopstra-protect-tests.ts`) refuses an edit under `loopstra/standards/` in every session that can write, whatever `LOOPSTRA_PHASE` is: acceptance, build, fix, reconcile, revise and resolve. The refusal message says that standards are changed by a person on `main`. The merge check above is the backstop for what a hook cannot see (a write through a shell command the session was allowed).

Claude's call: a standard is not added to `.claude/rules`, and `.claude/rules` is not treated as a standard. Rules there are guidance Claude Code loads into sessions. Standards are what the gates check, with rule labels and a record. A team keeps conventions in the first and the must-haves in the second, and can point one at the other.

## The console

The console never writes the repository itself, here as elsewhere. Each change a person makes is a request the loop applies and commits (see Writes).

### Settings › Standards

A third section of the Settings page, after Models and Agents.

- **Problems at the top:** unreadable files with each problem, standards edited in the main checkout but not yet committed (not in force), lines in a change's `standards.md` that do not read, and a `check` that names a program not installed.
- **The list.** One row per standard:
  - its title and file;
  - its scope: "every change", or its patterns with how many files on `main` they match now;
  - whether it needs a person;
  - its tool check;
  - how many rules it has;
  - how many changes in progress it applies to.

  Actions: New standard (blank, or from one of the README's two examples), Edit, Remove (with a confirmation that names the changes in progress it applies to).
- **The editor.** The user's choice: a form, with "Edit as Markdown" for the whole file. Both are checked before saving.
  - **The form:**
    - the title;
    - the patterns, each with a live count of matching files on `main` and, on request, the list;
    - "Needs a person before merging";
    - the tool check, with "Try it on main";
    - the rules, as label and text rows to add, edit or remove;
    - the context text.
  - **As you edit:** a label used twice, a label that is not valid, or a pattern that is not a glob shows next to its field.
  - **Markdown:** the whole file in one editor, with the same problems listed under it and a preview.
  - **Saving:** "Save" is offered only when the file would read. The console cannot put an unreadable standard on `main`.
  - **Changing the rules a change in progress is held to:** saving says so, naming the changes ("billing-refunds and csv-export are in progress under this standard; their next steps use the new rules").
- **Try it on main** runs the standard's `check` in a throwaway checkout of `main`'s last commit, as `loopstra setup` runs `commands.test`, with `commands.install` first, `LOOPSTRA_BASE` set to that commit, and `timeout_minutes` as its limit. It shows whether it passed, how long it took and the end of its output. A failure on main gets the warning in Checks that fail on main, with the base-aware form of the command when it is one of the known scanners. It writes nothing to the repository.
- **Exceptions granted.** The user's choice: one list across all changes, read from every change's `standards.md`. For each exception it shows the rule (with its standard), the change, the reason, who approved it, from where, when, and at which gate. It can be filtered by standard and by rule, and links to the change. Standards added to or removed from a change are listed beside it, under "Changes to scope", with the same columns.

### The change page

A **Standards** panel, shown when the repository has standards. It lists each standard that applies and why ("touches services/billing/api.ts", "every change", "added by J."). Under each standard, each rule shows how the change stands on it so far:
- what the spec or plan said;
- findings from review;
- the tool check;
- the result after the merge;
- exceptions, asked for and approved.

- **Exceptions waiting.** When the change waits for a person over an exception, the panel puts it first: the rule, the reason, and where in the spec or plan it is asked for. The buttons say what they do: "Allow the exception and approve the plan", and "Send back" with a note. Approving is the existing `approve` request; the runtime writes the approval into `standards.md` as it applies it.
- **Add a standard…** and **Remove…** open a dialog. It names the standard, asks for the note (required to remove), and says what happens next (see Changing a change's standards), with the option to send the change back to planning.

### Inbox, status and chat

- A change waiting for a person to approve an exception shows in `loopstra status`, the console's inbox and chat as waiting for a person, through `changeGates`, labelled "Waiting for you: exception to ARCH-1" with its note.
- Unreadable standards, and unreadable lines in a change's `standards.md`, show under Needs attention (see When a file cannot be read).
- The session page needs nothing new. The gate rows (`standards` on spec, plan, merge and done, `exception`, `check:<name>`, scope changes, and findings with rule labels) show in the trace as rows do today.
- The spec, plan, review and outcome pages already render those files, and the new sections show there.
- Nothing is added to the intent template or the owner's guide.

### Writes

- **Standard files** go through the existing `agent-files` request, which also takes paths under `loopstra/standards/` (`<name>.md` only). The loop refuses, with nothing committed:
  - a standard that would not read (the console checks first; the loop checks again);
  - a file with uncommitted changes in the main checkout;
  - a file that changed since the page read it, as for agent files.

  The record is `loopstra(_settings): standards: edit architecture.md by J. from the dashboard`.
- **A change's scope** goes through the new `standards-scope` request (see Changing a change's standards).
- **Exceptions** go through the existing `approve` and `send-back` requests.
- **The routes:**
  - `GET /api/standards`: the list, the problems, the counts;
  - `POST /api/standards/check`: a draft's problems and pattern matches;
  - `POST /api/standards/try`: Try it on main;
  - `GET /api/standards/exceptions`: the list of exceptions granted;
  - the change's panel, in the change's existing detail.

  Each route has the Host check every console route has.

## Setup, skill and docs

- **`loopstra init`** writes no standards. Off is the default and means absent.
- **`loopstra setup standards`**, a new section (see below).
- **`loopstra setup --check`** reads the standards from `main`'s last commit and lists each problem under "To fix". It warns when a standard's `check` names a program that is not installed, as it does for the commands.
- **The operator skill** (`templates/skill/SKILL.md`) gets an Onboard step for standards (see The onboarding agent). Its Tune section says the same flow is how to change standards later, beside `loopstra setup standards` and the console's Standards page.
- **README** gets a Standards section with two worked examples:
  - an architecture standard for every change;
  - a SOC 2 technical-controls standard scoped to `services/**` and `infra/**`: authentication and role checks, audit logs for access to customer data, encryption in transit and at rest, no secrets or personal data in logs, keeping and deleting data on schedule. Its `check` runs a secret scanner over what a change adds (`$LOOPSTRA_BASE`).

  It states plainly the limits under Non-goals, and how the records it leaves map to a change-management control (the intent is the request, the spec and plan the design, `review.md` the review, the outcome the evidence, and the pull request's approval with `merge.human: pr` the approval).
- **`docs/architecture.md`** lists `standards.ts` in layer 3.

### `loopstra setup standards`

A new section, listed with the others and runnable alone. Like agents, it is not part of the first full walk-through unless the person says yes to "Set up standards, rules every change is checked against, now? (y/N)".

1. **What is there.** It lists the standards on `main`: title, file, scope, whether it needs a person, the tool check, the number of rules. It lists the problems with them too.
2. **The menu:** add a standard, edit one, remove one, or finish. "Add" offers a blank standard or one of the README's two examples, to edit.
3. **Add or edit** asks, showing the current value and a suggestion, with the usual Enter for the suggestion and `-` for empty:
   - the file name (add only), as lowercase words joined by dashes;
   - the title;
   - which files it applies to: comma-separated patterns, `-` for every change. It answers with how many files on `main` they match, and asks again if one is not a valid pattern;
   - "Does a change under this standard need a person before it merges? (y/N)";
   - the tool check. The suggestion is the first of these found on PATH, in a form that fails on findings and, where the tool can, looks only at what a change adds: `gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"`, `semgrep scan --error --baseline-commit "$LOOPSTRA_BASE"`, `trivy fs --exit-code 1 .`, `checkov -d . --quiet`. Otherwise there is none. `-` leaves it out. Setup says in one line that `$LOOPSTRA_BASE` is where the change left `main`;
   - **the rules.** It lists the current ones by label, then asks "Add a rule as LABEL: text (Enter when done)", one at a time. A label already used is refused with the rule that has it. Then it asks "Rules to remove (labels, comma-separated)". To reword a rule, a person removes it and adds it again with the same label.
   - The context text is not asked. A new file gets a line saying where to write it, and setup says the file is plain Markdown to edit any time.
4. **Saving and checking.** It saves with the rest of setup, once, at the end. If the result would not read, it saves nothing, as for the config. Then it checks, with the section's other checks: every standard reads, and each new or changed tool check passes on `main` in a throwaway checkout, as `commands.test` is checked, with `LOOPSTRA_BASE` set to `main`'s commit. A check that fails there gets the warning in Checks that fail on main. What is not ok is listed under "To fix", with `loopstra setup standards` to run again. Like the rest of setup, it does not commit; it says to commit `loopstra/standards/`.

`loopstra setup --defaults` adds no standards. `loopstra setup --check` reads them and runs each tool check on `main`, as it does `commands.test`.

### The onboarding agent

The `loopstra` operator skill, in a Claude Code session with an engineer, can do more than setup's questions: it can read the team's own material and draft standards from it. The skill's Onboard list gets a new step after "Set up the agents", "Set up the standards". It is offered, not required; a team with no rules to state skips it.

1. **Ask what governs the code,** in the team's words:
   - an architecture team's principles, design records, a compliance framework (SOC 2, HIPAA, PCI), security policies;
   - where each lives: in the repository, pasted into the session, or behind an MCP tool the session has (a wiki, say).

   Ask who approves exceptions today, and which kinds of change already need a named person.
2. **Read what is there:**
   - `docs/adr/` or wherever design records are, `CLAUDE.md`, `.claude/rules`, `REVIEW.md`, `CODEOWNERS`;
   - lint and layering configs (eslint boundaries, dependency-cruiser, import-linter, ArchUnit);
   - the CI workflows, for the scanners that already run;
   - the code's layout, for where each rule would apply.
3. **Propose the standards,** one file per subject, each shown in full before anything is written:
   - rules stated against this repository's real code ("through the repository layer in `src/db/`", not "use good data access"), each one a judge could check from a spec, a plan or a diff; a vague source rule is rewritten so, and the original quoted beside it;
   - rule labels in the team's own scheme, a framework's control numbers included (`SOC2-CC6.1`);
   - `applies_to` patterns taken from the actual layout, with how many files each matches (from `loopstra standards`, once written, or by globbing);
   - `needs_person` where the team already wants a named person;
   - a `check` wherever a tool can enforce a rule, preferring a tool the repository or its CI already uses, in a form that looks only at what a change adds (`$LOOPSTRA_BASE`). A tool that would need installing is said so.
4. **Sort what goes where.** Must-haves are standards. Conventions and how-tos belong in `CLAUDE.md` or `.claude/rules`, which the skill can add to with the engineer. Who must approve becomes `needs_person` or the gates (`loopstra setup gates`). Controls that are not about code (access reviews, vendor management, incident response) are outside Loopstra, and the agent says so plainly, rather than writing rules no judge can check.
5. **Write and check.** Once the engineer agrees:
   - The agent writes the files in `loopstra/standards/` in the main checkout, with the context text the team's sources gave: why, links to the design records, examples.
   - It runs `loopstra setup --check`, which reads them and runs each tool check on `main`.
   - It fixes what does not read. For a check that fails on `main`, it explains why (old findings, or a real problem on `main`) and offers the base-aware form, or a change to fix `main` first.
   - It shows the diff, and the engineer commits it on `main`. Until then nothing is in force.
6. **Afterwards,** it says where standards are changed: this flow again, `loopstra setup standards`, or the console's Standards page. It also says what the team will see: the Standards sections in specs and plans, exceptions waiting in the inbox, and the record in each outcome.

The agent never writes a standard the engineer has not seen and agreed to, and never commits. Like the skill's other steps, it does not run `loopstra start`. It does not grant exceptions or change a change's standards: those are a person's actions in the console or the change's records, and the agent can explain them.
- **`docs/decisions.md`** gets the calls in this spec.

## Code

- **`src/standards.ts`** (layer 3, state on disk). It holds:
  - the zod schema of the front matter and the parsed `Standard` (`name`, `path`, `title`, `appliesTo?`, `needsPerson`, `check?`, `rules: { label, text }[]`, `body`);
  - `readStandards(git, commit)`, which returns the standards or the problems, each naming the file and line;
  - `applying(standards, files)`;
  - `renderStandards(applying, matched, exceptions)`, for the prompt variable;
  - `readStandardsSection(markdown)`, which returns the section's bullets as `{ label, kind: keeps | not-applicable | exception, text }`;
  - `checkStandardsSection(section, required, known)`, for the gate checks; `required` is empty for the spec;
  - `exceptionsToApprove(spec, plan)`, the exceptions in an artifact not already approved for this change.

  The section is found with the same heading reader `headingsPresent` uses.
- **`src/stages/design.ts` and `plan.ts`**: a `standards` check in `checks`, and the variable in `vars` and the judge's `vars`. `ArtifactStage` already has a hook for every check. The exception wait is new in `runArtifactStep`: after the checks pass, a pass with exceptions to approve goes to the review status with `spec_gate` or `plan_gate` written.
- **`src/intents.ts`**: `spec_gate` and `plan_gate` in the front matter, left out when blank, and in `changeGates`.
- **`src/stages/build.ts`, `review.ts`, `merge.ts` and `verify.ts`**: the variable, and the standards' checks in the commands build sessions may run. `merge.ts` runs the tool checks after the tests and adds the two checks in `passMergeGate`. `verify.ts` adds the done-check items, the outcome section and the note.
- **`src/risk.ts`**: `scoreRisk` takes the extra patterns with the standard each came from, and `riskNote` names it.
- **`src/envelopes.ts`**: the optional `standard` fields, and `done-check`'s `standards` array (default `[]`, so a prompt override that never asks for it still parses).
- **`src/scheduler.ts`**: the tick's read and the `standards` problem, beside `traceConfigProblem`.
- **`src/commands/standards.ts`**, the command.
- **`src/attention.ts`**, the Needs attention entries.
- **`src/requests.ts` and `src/apply.ts`**: the `standards-scope` request; `agent-files` taking `loopstra/standards/<name>.md` with the readability check; and the `approve` request's record also writing a change's approved exceptions into `standards.md`, as a status edit noticed by the loop does.
- **`src/console/standards.ts`** (the routes), with `src/ui/views/StandardSettings.tsx`, `src/ui/views/Exceptions.tsx` and the change page's `Standards` part. They follow the Agents settings pattern: read-only views from the server, and writes as requests.
- **`src/setup/sections/standards.ts`**, the setup section, sharing the throwaway-checkout run with the commands check.
- **The hook**, the refusal.

## Tests

- **Unit, in `tests/unit/standards.test.ts`:**
  - parsing: front matter, titles, rules with continuation lines, each kind of unreadable file, and a label used in two files;
  - applicability, renames included;
  - the section reader: the three kinds of bullet, and continuation lines;
  - the section check: at the spec only labels that match no rule fail, and at the plan missing labels fail too;
  - exceptions to approve: new at the spec, repeated in the plan (none), new or reworded in the plan.

  A property test in `properties.test.ts` checks that parsing a rendered rule list gives back the same labels and texts.
- **Stages, with the fake claude:**
  - a spec without a Standards section fails the check and is rewritten once, and a spec that lists only the rules it decides something about passes;
  - a plan missing a rule that applies fails the check;
  - a spec with an exception waits in `spec-review` with `spec_gate: status` and the note, even with `gates.spec.human: none`; approving it lets the plan repeat the exception without a second wait, and a new exception in the plan waits in `plan-review`;
  - a failing `check` at the merge checks goes to the fix loop, then to review; past the fix budget it blocks with the note naming the standard; a passing one is not run again on the same code;
  - a spec-check finding with `standard` reaches the rewrite's findings and the gate evidence;
  - a plan's scoped standards come from its file list;
  - a review finding with `standard` is important and is listed with its label;
  - a merge whose diff touches `loopstra/standards/` blocks with the note;
  - a `needs_person` standard makes a change wait in `merge-review` with the standard named, and only when nobody is on the merge gate;
  - the done-check's unmet rule blocks, its `needs-person` rule does not, and `outcome.md` has the runtime-written section, with the standards' commit, the exceptions and the tool checks;
  - a repository without standards produces the same prompts, headings and gate rows as before (a golden comparison).
- **Integration:**
  - one tick in a repository with an unreadable standard on `main` starts no step and traces `standards`;
  - one change runs from accepted to done with one standard for every change and one scoped standard.
- **The hook:** an edit under `loopstra/standards/` is refused in each writing phase.
- **Requests:**
  - `agent-files` writing a standard that would not read is refused with nothing committed, and so is one that changed since the page read it;
  - `standards-scope` adds and removes with the note, refuses a removal without one, and the next step uses the new set;
  - approving a plan with an exception, by request and by a status edit, writes the approval into `standards.md` with who and from where.
- **Console:**
  - the routes, with their Host check;
  - a draft's problems and pattern counts;
  - Try it on main in a throwaway checkout, which leaves the repository unchanged;
  - the exceptions list read from several changes' `standards.md`;
  - the UI's views, as the Agents settings views are tested.
- **Setup:** the section adds, edits and removes a standard, refuses a label used twice, suggests a scanner found on PATH in its base-aware form, saves nothing when the result would not read, and lists a tool check that fails on `main` under "To fix" with the warning.
- **`LOOPSTRA_BASE`:** a tool check at the merge checks gets the merge base. A check that writes it out shows the right commit, after main has moved on, and after a conflict resolution squashed the branch.
- **Checks that fail on main:** "Try it on main" and `setup --check` report the warning, `loopstra start` warns once, and the block note gets its extra sentence only for a check that does not use `LOOPSTRA_BASE`.
- **The skill:** its Onboard list has the standards step, and its Tune section points to it. The skill's existing structure checks cover it, if any.

## Follow-ups (not in this change)

- **Acceptance tests from standards.** Give the `acceptance` step the plan's applicable rules, so the rules a test can check get one, listed in `acceptance.md` by rule label, which the done-check then reads like the criteria's.
- **Chat.** Tell the orchestrator the standards' titles and scopes, so it can answer "what rules would this change fall under?" while an intent is worked out. Whether chat may change a change's standards is decided then.
- **An export for auditors.** `loopstra export <since>` would write each change's records and its trace rows (gates, approvals, who did what, when) into one folder or archive, since `.loopstra/` is local and not kept.
- **Standing waivers.** A file of exceptions people approved once for a set of files, with a reason and an end date, which a spec or plan could cite instead of asking each time. Worth it only if the same exception keeps coming back.
- **`loopstra retro`** could report which rules most often fail at which gate, and which exceptions are asked for most. That is the signal that a rule is unclear, or that a design keeps fighting it.

## Changed while building

The code differs from this spec in these places; `docs/decisions.md`, under "Standards (2026-10-28)", says why for each.

- Deleting `spec_gate` or `plan_gate` does not take the change back to the config's gate: it is settled again and waits again (corrected above).
- `loopstra start` runs no tool checks and does not warn about one that fails on main. The console shows that warning with Try it on main's result, not as a problem at the top of Standards.
- The done step judges by the standards the merge gate recorded (the run-folder marker `standards.applied`), or the plan's Files that change, not the merge commit's diff.
- The shipped prompts are unchanged: the standards and each phase's instructions are appended from `src/standards-prompt.ts` only when the change has standards to show. The spec gate's `standards` check runs only then too.
- When standards with a `check` apply, the merge checks run the tests again even on a commit the build tested. With `speed.parallel_checks`, tool checks start alongside test, lint and build.
- `standards-untouched` is the first merge check, in `checkMerge`, and has a row only when main has standards or the diff touches the folder.
- `review.md` gets a runtime-written "Findings against the standards" section; a finding that names a rule is not forced to `important`.
- The acceptance session gets no standards. Build sessions see `LOOPSTRA_BASE` as main's branch name; the merge checks give a tool check the merge base.
- The scope dialog has no "Send the change back to planning"; it says that review, the merge checks and the final check cover a standard added after the plan. Re-adding a removed standard writes an Added line, and adding without a note writes "no note".
- `loopstra setup standards` asks "Rules to remove" before "Add a rule".
- The console has a `POST /api/standards/scope` route, and `/api/agents/files` takes an operation `standard`.
- A standard file to be saved is checked together with main's other standards, in the console and in the loop.
- The done-check's `standards` field is optional rather than defaulting to `[]`. `exceptionsToApprove` is in `src/standards-record.ts`, and the other functions sit where `docs/architecture.md` lists them.
