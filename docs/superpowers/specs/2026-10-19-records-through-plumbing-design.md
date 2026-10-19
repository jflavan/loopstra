# Records through git plumbing

Date: 2026-10-19. Follows the hardening pass (#47, #58, #59), which left this one item as a change of its own.

## Why

Every record the loop keeps on main (a status, an artifact, a conversation entry, chat's drafts, the main-health draft, a person's edits) is written by `commitRecord` in `src/context.ts`: write the files into the main checkout, then `git add` and `git commit` them. Between the write and the commit the files sit on disk uncommitted, and everything after has to cope with that:

- `commitRecord` snapshots the paths before the write and puts the files back when the write throws or the commit fails (`putBackRecord`, `nothingLanded`), with a special case for a person's own change (`PersonChangedStatus`), which a put-back must not undo.
- The applier (`src/apply.ts`) keeps, on each request, which change folders it wrote and their hashes (`written`, `writtenHash`, `recordHash`), so that a later pass can tell its own uncommitted write from a person's edit (`stillOurs`, `ownBefore`, `changedSince`, `markWritten`), finish a request the loop was killed in, or put its writes back when it gives up (`putBack`, `putBackConversation`). About 150 lines.
- `recordQuestion` (`src/questions.ts`) keeps the same kind of hash map for its two files, and its own `putBack`.

A record left written but not committed holds up every sync and local merge, so all of it is load-bearing, and the review of the hardening pass found two bugs in exactly this machinery. The redesign makes the window disappear: the commit is made first, from what the record will write, and the checkout is brought up to it afterwards. Nothing is ever on disk that is not committed, except for a moment after HEAD moved, and that moment has one small, explicit recovery.

## What stays the same

- `commitRecord(root, main, slug, what, write)` is still the one way to write a record, under the checkout lock, only on `main_branch` (`MainCheckoutMoved` otherwise), not stopped by a stop request once it commits.
- What a record commits: everything under `intent/<slug>/` and `intent/queue.md` as it will be, a person's uncommitted edits in that folder included (as `recordPersonEdits` relies on), with ignored and untracked files left out as `commitPaths` does now. The message is `loopstra(<slug>): <what> [skip ci]`; the repository's hooks do not run; the identity is the runtime's.
- `PersonChangedStatus`, `expectStatus` and every caller's decision logic: what a record writes and when it refuses are unchanged.

## Components

- **`RecordDraft`** (new, `src/record-draft.ts`): the files one record changes, held in memory. `read(rel)` gives the draft's version, else the file on disk; `write(rel, text)`, `remove(rel)`, `changes()`. `rel` is relative to the repository and must be under `intent/<slug>/` or be `intent/queue.md`: anything else throws, since a record never writes elsewhere. It knows nothing of git.
- **`Git.commitFiles(parent, paths, changes, message)`** (new, `src/git.ts`): a commit made from `parent`, without touching the checkout's index or files. In a temporary index (`GIT_INDEX_FILE` in a fresh temporary folder, removed after): `read-tree parent`; then `paths` as they are on disk, staged by the same rules `commitPaths` uses today (ignored and untracked files left out, a removal taken along), through a `stagePaths` split out of `commitPaths`; then each draft change over that: a content is hashed with `hash-object -w --path=<rel> --stdin`, so the repository's line-ending and attribute rules apply exactly as `git add` applies them, and set with `update-index --cacheinfo`; a removal with `update-index --force-remove`; then `write-tree`. When the tree is `parent`'s, there is nothing to commit (null). Otherwise `commit-tree -p parent`, run as the runtime (`runtime("commit-tree", ...)`), so hooks are skipped and the identity is the records' as today; it gives the new commit's sha. `GitRunOptions` gains `env` and `stdin`.
- **`Git.moveHead(from, to)`** (new): `update-ref -m <message> HEAD <to> <from>`, a compare-and-swap: false when HEAD is no longer `from` (someone committed meanwhile). The reflog line says it was a Loopstra record.
- **The record marker**, `.loopstra/recording.json` (`{ parent, commit, slug, paths }`, `paths` being the files the draft changed): written just before HEAD moves, removed once the checkout matches the commit. **`settleRecord(root, trace)`** (new, `src/context.ts`) finishes or drops one a kill left behind (see Recovery).
- **The six write sites** go through the draft instead of the disk: `writeChangeFile` (and so `writeIntent` and `writeArtifact`), the three `conversation.md` writes (apply's `writeRecord`, `appendConversation`, `recordQuestion`), apply's new-intent write, and the main-health intent in `src/signals.ts`. `writeIntent` and `writeChangeFile` take the draft as an argument; what they write is unchanged.

## How a record is committed

`commitRecord` with a draft, under the checkout lock:

1. On main (`MainCheckoutMoved` otherwise); a marker left behind is settled first (`settleRecord`); `throwIfStopping`.
2. `parent` = HEAD.
3. `write(draft)`. A throw goes on as it is: nothing was written anywhere, so nothing is put back, `PersonChangedStatus` included. `false`, or a draft with no changes and nothing of a person's to take along, commits nothing.
4. What each drafted file holds on disk now is noted (to tell a person's save at step 8).
5. From here the record is not stopped by a stop request (as `finish: true` is today). `commit = commitFiles(parent, [intent/<slug>, intent/queue.md], draft.changes(), message)`: what is on disk under those paths, with the draft over it. Null (the tree is `parent`'s): nothing is committed (false).
6. The marker is written (`writeFileAtomic`).
7. `moveHead(parent, commit)`. False (someone committed on main meanwhile, a person in the main checkout): the marker goes, and steps 2 to 7 run once more from the new HEAD, the callback included (its reads see the new state; `expectStatus` refuses as it would). False again: `RecordRaced` ("main moved twice while a record was being committed; it is tried again on the next tick"), which callers meet like a failed commit today.
8. The checkout is brought up to the commit: each drafted file is written (`writeFileAtomic`, temp file in `.loopstra`) or removed, unless the file on disk changed since step 4 saw it (a person saved it in between; for a file the draft made, one that appeared since): then the person's version stays on disk, uncommitted, as any edit of theirs would, and the next record takes it along. Then `reset -q <commit> -- intent/<slug> intent/queue.md`, so the index matches HEAD for those paths.
9. The marker goes. True.

The request applier passes its request id: the commit message gains a trailer, `Loopstra-Request: <id>`, so a later pass can ask git whether a request's record landed (see Callers).

## Recovery

A kill can land in three places:

- **Before HEAD moved** (steps 1 to 7): nothing changed in the checkout, the index or any ref. The commit's objects are unreferenced and git's gc drops them. A marker written at step 6 names a commit HEAD never reached.
- **After HEAD moved, before the checkout matched** (steps 7 to 9): HEAD has the record, the checkout does not; seen alone, the checkout's files look like a person's edit undoing it.
- **After the marker went**: done.

`settleRecord` runs at the start of each tick, beside `settleCutShortMove` and before anything reads the checkout, and at the start of `commitRecord`. With a marker:

- HEAD is the marker's `parent`: HEAD never moved; the marker goes.
- HEAD is the marker's `commit`, or has it as an ancestor: each file the marker names is brought up to the commit (`checkout <commit> -- <path>`, or removed when the commit has none) when it still holds what `parent` had, by git's own comparison (`diff --quiet <parent> -- <path>`, so line endings compare as git sees them): the run was killed before writing it. One that already holds the commit's content is left. One that holds anything else is a person's edit since, and is left. Then the index for the marker's paths is reset to HEAD; the marker goes; the trace says the record was finished.
- Anything else (HEAD moved to something without the commit: a person reset main): the marker goes, and the trace says so.

## Callers

- **`src/context.ts`**: `setStatus`, `writeArtifact`, `writeIntentPriority` and `writeForStep` draft through `writeIntent(intent, patch, opts, draft)` and `writeChangeFile(intent, name, text, draft)`. `recordPersonEdits` passes no callback: what it commits is the person's files on disk, as now. `commitForStep` keeps restoring the in-memory intent when the record fails. `putBackRecord`, `nothingLanded` and `filesUnder`'s put-back use go; `filesUnder` stays for step 4.
- **`src/apply.ts`**: each request's record carries its id (above). A pass that finds a claimed request first asks whether a commit with its trailer landed on main since the request was made (`git log --fixed-strings --grep "Loopstra-Request: <id>" --since <at> -1 HEAD`): landed, the request is finished as applied, with the result its kind gives, and nothing is written again; not landed, it is applied as a fresh request (nothing of an earlier try is on disk to find). Giving up has nothing to put back: the request is finished with its refusal. `written`, `writtenHash`, `recordHash`, `stillOurs`, `ownBefore`, `changedSince`, `markWritten`, `putBack` and `putBackConversation` go, with the `Request` schema's fields for them (an old claimed request that still has them reads, and they are ignored). The sent-back note (`writeSentBack`, `dropSentBack`, in the run folder, outside the record) stays as it is.
- **`src/questions.ts`**: `recordQuestion` drafts its two files; its hash map and `putBack` go. `question.json` is written after the commit, as now.
- **`src/conversation.ts`**, **`src/signals.ts`**: their writes go through the draft.
- **Not in scope**: the steering inbox's own dedupe (`recorded.json`, `inbox/unrecorded/`), which is about a message delivered to a session whose record then failed, not about files on disk; it keeps working, since its record goes through `commitRecord` like any other.

## Errors

- **The callback throws**: nothing to undo; the error goes on.
- **A git call fails before HEAD moved** (a full disk, a timeout): nothing to undo; the marker goes if it was written; the error goes on.
- **HEAD moved under the record**: tried once more (step 7); then `RecordRaced`.
- **The checkout cannot be brought up** (step 8: Windows refusing a file held open, past `writeFileAtomic`'s retries): the marker stays, the trace says which file, and the error goes on; the next tick's `settleRecord` finishes it. Until then the sync sees unsaved changes and waits, as it would for any held file.
- **The temporary index** is in a fresh folder under the system temporary directory, removed in a `finally`; one a kill leaves there is outside the repository and harmless, and the system clears it.

## Testing

- **`RecordDraft`**: reads fall through to disk and are remembered; a path outside the change's folder or `queue.md` throws.
- **`Git.commitFiles`**: adds, changes and removes the right paths; files outside them, the main checkout's files and its index are untouched; no hook runs (a failing pre-commit hook in the test repository); the message and identity are the runtime's.
- **`Git.moveHead`**: moves only from the expected commit.
- **`commitRecord`**: a callback that throws leaves the checkout, the index and HEAD as they were; a person's uncommitted edit elsewhere in the folder is committed along; a person's save of a drafted file between the draft's read and step 8 stays on disk, uncommitted, and the commit has the record's; HEAD moved by a person's commit during the record is tried again and succeeds; moved twice, `RecordRaced`; a stop request after step 5 does not stop it.
- **`settleRecord`**, by writing a marker and the matching state as a kill would leave it: HEAD at `parent` (the marker goes, nothing else changes); HEAD at `commit` with the files still at `parent`'s content (brought up, index reset); with one file a person edited since (left); HEAD reset elsewhere (marker dropped). And a tick with such a marker starts with it settled.
- **The applier**: a request whose record landed but whose pass was killed before it finished is finished as applied on the next pass, without a second commit; one killed before its commit is applied fresh; giving up leaves the change folder as HEAD has it. These replace the current tests of a write left uncommitted.
- **Everything else is the guard**: `apply`, `context`, `questions`, `conversation`, `steering`, `signals`, the stages and the scheduler and lane suites must pass with their assertions unchanged, apart from the tests that set up "written but not committed" by hand, which now set up "committed, checkout behind" instead.

## Rollout

One pull request after #59, in this order, each step green on its own: `RecordDraft` and the two `Git` helpers with their tests; `commitRecord` on them, with `settleRecord` and the marker, the write sites moved to the draft; the applier's request trailer and the removal of its put-back family; `recordQuestion`'s; the docs (`docs/decisions.md`, a section for the change; the README's description of how records are kept, if it mentions the old behaviour).
