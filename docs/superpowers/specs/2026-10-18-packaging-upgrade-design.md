# Packaging and upgrade: one command brings a repo up to the latest Loopstra

Date: 2026-10-18. Status: built (plan: docs/superpowers/plans/2026-10-18-packaging-upgrade.md). One plan, one pull request.

Choices made with the user: publish Loopstra as the public npm package `loopstra`, released
automatically from every green merge to `main`; defaults (prompts, the test hook) live in the
package and a repository keeps only what it customised; one command, `loopstra upgrade`, run in a
project repository, installs the latest release and brings the repository up to it in one commit.

## Problem

Loopstra changes every day, and the repositories that use it fall behind in two ways.

- **The tool.** The global `loopstra` is `bun link`ed to the development checkout
  (`C:\Source\Repos\loopstra`), where other sessions switch branches. A project repository runs
  whatever branch happens to be checked out, and there is no version to name.
- **The stamped files.** `loopstra init` copies 15 prompts, the operator skill, the
  test-protection hook, `REVIEW.md` and `intent/README.md` into the repository and never
  overwrites a file. Every improvement to them is copied by hand. The prompts are coupled to the
  code (`src/phases.ts` documents variables "the shipped templates say the same"), so a stale copy
  can quietly degrade a phase. Code already works around this: `chatTemplate`
  (`src/chat/agents.ts`) patches old orchestrator prompts in place, and `withNote`
  (`src/phases.ts`) appends notes for prompts older than a variable.

What we want: in any project repository, `loopstra upgrade` and nothing else.

## Distribution

**Package.** The npm package `loopstra` (the name is free; `jflavan/loopstra` is public).
`package.json` gets a `files` list (`src/`, `templates/`, `shipped.json`, `README.md`) and keeps
`bin: { loopstra: "./src/cli.ts" }`. There is no build step: `src/cli.ts` starts with
`#!/usr/bin/env bun`, so Bun stays a requirement, as today.

**Install.** `bun add -g loopstra` (or `npm i -g loopstra`, with `bun` on PATH). The README's
Install section changes to this; the clone and `bun link` move to a "Develop Loopstra" section.

**Versions.** In the repository, `package.json` says `"version": "0.0.0-dev"`. The published version
exists only in the release (see Releases). `loopstra --version` prints the version, so a
development checkout reports `0.0.0-dev`.

**The development checkout.** It stops being the global install: `bun unlink` there, and run it
with `bun src/cli.ts` (or an alias). Project repositories then only ever run published releases.

## What lives where

Every file `init` writes today falls in one of four groups.

| Group | Files | Rule |
|---|---|---|
| Package-owned | `templates/prompts/*.md` (15), `templates/hooks/loopstra-protect-tests.ts` | Not copied into the repository. Read from the installed package. |
| Managed | `.claude/skills/loopstra/SKILL.md`, `intent/README.md`, `REVIEW.md`, and any prompt override in `loopstra/prompts/` | In the repository, recorded in `loopstra/stamp.json`, updated by `upgrade`. |
| The repository's own | the Commands block in `CLAUDE.md`, the `.loopstra/` line in `.gitignore`, `intent/queue.md` | Written once by `init`, never touched again. |
| Config | `loopstra/config.yaml` | Versioned migrations. |

### Prompts

A phase reads `loopstra/prompts/<name>.md` when the repository has one (an override), else the
package's `templates/prompts/<name>.md`. `init` no longer copies prompts. The `missing-prompt`
failure stays only for a broken install (no override and no shipped file). The old-copy patching in
`chatTemplate` goes: it rewrote specific sentences of old shipped orchestrator prompts, which
`upgrade` now brings up to date. `withNote` and the conversation fallback in `phasePrompt` stay,
because an engineer's override may leave a variable out on purpose.

`loopstra customize <prompt>` copies a shipped prompt into `loopstra/prompts/` and records it in
the stamp, so later upgrades can merge into it. Run with no name it lists the prompts and which are
overridden.

`templateSha` (`src/judges.ts`) hashes the prompt actually used: the override, else the
shipped one.

### The test-protection hook

The hook only acts when `LOOPSTRA_PHASE=fix`, so it belongs to the loop's sessions, not to the
repository. Every agent-phase session Loopstra starts gets (the hook itself does nothing outside a fix phase)
`--settings '{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|MultiEdit","hooks":[{"type":"command","command":"bun \"<package>/templates/hooks/loopstra-protect-tests.ts\""}]}]}}'`
to the `claude` arguments, with the hook's absolute path in the installed package. `init` stops
writing `.claude/hooks/` and stops editing `.claude/settings.json`.

Verified on Windows (2026-10-18): `claude -p --settings '<inline JSON>'` runs the PreToolUse hook,
and its exit 2 blocks the Write. The path is written with forward slashes for Git Bash.

### `loopstra/stamp.json`

Committed. Example:

```json
{
  "loopstra": "0.6.0",
  "files": {
    ".claude/skills/loopstra/SKILL.md": { "base": "<sha256 of the shipped text it came from>" },
    "REVIEW.md": { "base": "<sha256>" },
    "intent/README.md": { "base": "<sha256>", "deleted": true },
    "loopstra/prompts/review.md": { "base": "<sha256>" }
  }
}
```

`base` is the sha256 of the shipped text the file was last written from or merged to. `deleted`
marks a managed file the repository removed on purpose; `upgrade` does not bring it back. `init`
writes the stamp. Hashes are of text with line endings normalised to `\n`, so a checkout with
`core.autocrlf` hashes the same.

### `shipped.json`

Built at release time by `scripts/shipped.ts` from the full git history and included in the package
(not committed). For every package-owned and managed template path, the sha256 of every text it has
ever had and the commit that first had it:

```json
{ "templates/REVIEW.md": [{ "sha": "<sha256>", "commit": "<git sha>" }] }
```

Two uses: recognising an unedited file in a repository with no stamp yet (its hash is in the
list), and finding the base text for a merge, fetched from
`https://raw.githubusercontent.com/jflavan/loopstra/<commit>/<path>`.

## `loopstra upgrade`

Run in a project repository.

1. **Tool.** Fetch `https://registry.npmjs.org/loopstra/latest`. If it is newer than the running
   version, run `bun add -g loopstra@<version>`, then run the new version's `loopstra upgrade
   --repo` and exit with its code. The new code runs the new migrations. If the global install
   fails (for instance, the Windows shim is locked by the running process), run
   `bunx loopstra@<version> upgrade --repo` instead and print the one install command to run by
   hand. Verified on Windows (2026-10-18): a running Bun global shim can `bun add -g` a new version
   of its own package, so the fallback is only for an install that fails for another reason. The new
   version is run as `<bun pm bin -g>/loopstra`.
2. **Loop.** If the loop is running in this repository (its heartbeat says running or paused and
   its process is alive), refuse: "The loop is running. Stop it (Ctrl-C in its terminal), run
   loopstra upgrade, then start it again." A stop is in-process (a signal), Windows has no graceful
   signal to send another process, and a loop restarted in the background would lose its terminal.
   The tool step (1) runs before this check, since installing does not touch the repository; loops
   in other repositories keep the code they loaded until they are restarted.
3. **Checks.** The main checkout must be on `main_branch`, and no managed file, `stamp.json` or the
   config may have uncommitted changes. Otherwise refuse, name what is wrong, write nothing.
4. **Repo files.** Apply the rules below to each managed file, migrate the config, write the stamp.
5. **Commit.** One commit on main, made as the runtime (Loopstra's author, like its records), so
   the loop's next tick shares it with the remote the way it shares its own records (`shareMain`):
   `loopstra: upgrade to 0.6.0 (from 0.4.2)`, with the release notes between the two versions in
   the body. Files left with conflict markers are not in the commit.
6. **Report.** What changed per file, the version change, and any file to resolve by hand.

`loopstra upgrade --repo` runs steps 2 to 6 with the installed version only.

**A development checkout** (version `0.0.0-dev`, run through `bun link` or `bun src/cli.ts`) is not
upgraded from npm: step 1 says to `git pull` instead, and the repo steps run with the checkout's
templates. Without a `shipped.json` it builds the same index from its own git history, and fetches
base texts with `git show` instead of from GitHub. The stamp records `0.0.0-dev+<short commit>`. The
update notice is off in a development checkout.
`loopstra upgrade --check` changes nothing: it prints the installed and latest versions, the
release notes between them, and what would happen to each file.

### Rules for a managed file

Let `theirs` be the repository's file, `base` the shipped text its stamp names, `new` the shipped
text now.

- `theirs` is missing and the stamp says `deleted`: leave it.
- `theirs` is missing and was never deleted (a new managed file): write `new`.
- `hash(theirs) == base`: unedited. Write `new`.
- Otherwise, edited: fetch `base` text and run `git merge-file theirs base new`. A clean merge is
  written. A conflict leaves the markers in the file, keeps the stamp's old `base` for it, and
  lists it. If `base` cannot be fetched (offline), the file is left alone and listed.
- After a write, the stamp's `base` becomes `hash(new)`.

A managed file deleted since the last upgrade is recorded as `deleted`.

### The first upgrade of a repository set up before this

No stamp yet.

- Each `loopstra/prompts/<name>.md` whose hash is in `shipped.json` for that prompt was never
  edited: delete it. Any other one is an override: keep it, with the closest shipped version
  (fewest differing lines, among the versions in `shipped.json`) as its base, then apply the rules
  above. The report names the version used as the base.
- The skill, `REVIEW.md` and `intent/README.md` get the same treatment: a known hash means
  unedited, otherwise the closest version is the base.
- Remove `.claude/hooks/loopstra-protect-tests.ts` and the hook entry marked
  `loopstra-protect-tests` in `.claude/settings.json` (deleting the file if nothing else is left
  in it).
- Write the stamp.

### Config migrations

`config.yaml` has `version: 1`. Migrations live in `src/upgrade/migrations.ts`, one function per
step (`1 → 2`, ...), each editing the parsed YAML document so comments survive (the same `yaml`
document editing `setup` uses). `upgrade` applies every step from the file's version to the current
one, then checks that the result loads; if a step throws or the result does not load, nothing is
written and the setting is named. Keys added with a default need no migration (the schema defaults
them); renames and removals do. This design adds no migration; the first comes with the first
change that needs one.

## Staying aware

`loopstra start` and `loopstra status` print one line when the registry has a newer release
(`Loopstra 0.6.0 is out (you have 0.4.2): run loopstra upgrade`) or when the repository's stamp names a
different version from the installed one. The check is cached for a day in `.loopstra/` and never
blocks. The loop never upgrades itself.

`uncommittedSetup` (the check `start` makes) asks for the config, `stamp.json` and any overrides to
be committed on main, and no longer for prompts or the hook.

## Releases

`.github/workflows/release.yml`, triggered by `workflow_run` of `ci` completing with success on a
push to `main`, plus `workflow_dispatch` with an optional `bump: patch|minor`.

1. Check out with full history.
2. Skip if nothing under `src/`, `templates/` or `package.json` changed since the latest `v*` tag
   (a manual run never skips).
3. Next version: from the latest tag (none yet: `0.1.0`), a commit since it whose subject has `!`
   before the colon, or whose body has `BREAKING CHANGE`, bumps the minor version (0.x); anything
   else bumps the patch. A manual `bump` overrides. A pure function in `scripts/release.ts`.
4. Set the version in the workspace's `package.json` only (`npm version --no-git-tag-version`).
5. Build `shipped.json` with `scripts/shipped.ts`.
6. `npm publish --provenance --access public` through npm trusted publishing (OIDC; no token
   stored).
7. Tag the commit `v<version>` and create a GitHub Release whose notes are the commit subjects
   since the previous tag.

The first publish is by hand (trusted publishing is configured on a package that exists): `npm
publish` from a clean checkout of main with the version and `shipped.json` set as the workflow would.

## Errors

| Situation | What happens |
|---|---|
| The registry cannot be reached | Says so, and offers the repo step for the installed version (`--repo`). |
| The global install fails | Runs the repo step through `bunx`, prints the install command. |
| Not on main, or managed files or the config have uncommitted changes | Refuses, names them, writes nothing. |
| A merge conflicts | Markers stay in that file, it is listed and left out of the commit. |
| A merge base cannot be fetched | That file is left alone and listed. |
| A config migration fails | Nothing is written; the setting is named. |
| The loop is running in this repository | Refuses, says to stop it first. The tool step has already run. |

## Testing

Unit tests:

- grouping and the managed-file rules (unedited, edited and clean, edited with conflict, deleted,
  new, base unavailable), with an injected base fetcher;
- the first upgrade of a stampless repository: unedited prompts removed, overrides kept, closest
  base chosen, hook file and settings entry removed;
- prompt resolution: override first, else shipped; `customize`;
- an agent session's `--settings` argument carries the hook's absolute path;
- the migration runner (a test migration, a throwing one, one whose result does not load);
- next-version calculation and the release-skip check;
- `shipped.json` built from a throwaway repository with history;
- the refusals in step 3, and the commit message.

End to end: `bun pm pack` the package, install it into a temporary global folder, `init` a
temporary repository with an older build, then `upgrade` against a fake registry (the registry URL
and the install command can be injected through environment variables used only by tests).

Checked by hand once: the first npm publish, and trusted publishing on the first workflow release.

## Out of scope

- Compiled single-file binaries; Bun stays a requirement.
- Upgrading automatically, or from the loop.
- Release channels (a `next` tag for unreleased main).
- Migrating intents or trace data; their formats are not versioned by this design.
