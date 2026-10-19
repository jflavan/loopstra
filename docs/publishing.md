# Publishing Loopstra

How Loopstra gets to npm, what a person has to do, and what an agent must never do. Read this before
touching `.github/workflows/release.yml`, `scripts/release.ts`, `scripts/shipped.ts`, the `version`
or `files` in `package.json`, or any `v*` tag.

## What is published

- The npm package [`loopstra`](https://www.npmjs.com/package/loopstra), public, MIT. Users install it
  with `bun add -g loopstra` and move a repository to a newer release with `loopstra upgrade`.
- It ships `src/`, `templates/`, `shipped.json`, `README.md`, `tsconfig.json` and `LICENSE`
  (`files` in `package.json`; npm adds `LICENSE` and `package.json` itself). There is no build step:
  the CLI runs on Bun. `tsconfig.json` must ship, because Bun reads its JSX settings to bundle the
  console page when `loopstra ui` starts.
- `shipped.json` is built at release time (`bun scripts/shipped.ts shipped.json`) and never committed
  (`/shipped.json` is gitignored). It lists every text each template has had, which `loopstra upgrade`
  needs to merge a repository's edits.
- In git, `package.json` always says `"version": "0.0.0-dev"`. The real version exists only in the
  release: the workflow sets it in its own workspace and never commits it. Never commit a real version.

## How a release happens

Everything is in `.github/workflows/release.yml`. It runs after the `ci` workflow passes on a push to
`main`, or by hand (Actions, "release", Run workflow, on `main`).

1. **Plan** (`bun scripts/release.ts plan [--manual] [patch|minor]`, tested in
   `tests/unit/release.test.ts`):
   - The version comes from the latest `v*` tag. A commit since then with `!` before the colon
     (`feat!:`) or `BREAKING CHANGE` in its body bumps the minor version (we are on 0.x); anything
     else bumps the patch. A manual run's `bump` input forces one or the other.
   - An automatic run releases only when `src/`, `templates/` or `package.json` changed since that tag.
     A manual run always releases.
   - No run ever releases a commit that is already released: one that is the latest tag, or older.
2. **Version and index:** `npm version <v> --no-git-tag-version`, then `bun scripts/shipped.ts shipped.json`.
3. **Stage on npm:** `npm stage publish --provenance --access public`, authenticated by npm trusted
   publishing (GitHub's OIDC token; no npm token is stored anywhere). The version is uploaded with
   provenance but is **not installable** until a maintainer approves it (see below). If the version
   is already published, this step is skipped.
4. **Tag:** `v<version>` on the released commit, made on GitHub through its API (the checkout keeps no git token).
5. **GitHub Release:** `v<version>`, its notes the commit subjects since the previous tag.
   `loopstra upgrade` puts these notes in the upgrade commit's body.

Steps 4 and 5 happen at staging time, before approval. A version is "out" for the workflow (the next
run releases the next version) as soon as it is staged and tagged.

## The npm side (set up 2026-10-18)

- The account that owns the package uses a passkey for 2FA.
- **Trusted publisher:** GitHub Actions, user `jflavan`, repository `loopstra`, workflow
  `release.yml`, no environment. **"Allow npm publish" is off**, so the workflow can only stage;
  **"npm dist-tag" is off**, so it cannot move tags. Leave both off: that is the point of staging.
  Nothing in the repository can publish on its own.
- The first version, 0.1.0, was published by hand on 2026-10-18, because npm only lets you add a
  trusted publisher to a package that exists. It is tagged `v0.1.0` (`ed3b235`). Every later version
  comes from the workflow.

## Approving a staged version (a person does this)

After the workflow stages a version, its run summary says so. The maintainer then:

- on npmjs.com: the `loopstra` package, its staged versions, approve (passkey); or
- in a terminal of their own (a real one: npm needs a TTY for the browser sign-in). `npm stage` needs
  npm 11.15 or later; with an older npm (10.x says `Unknown command: "stage"`), put `npx npm@11` in
  place of `npm`, or upgrade it once with `npm install -g npm@11`:

  ```
  npm stage list loopstra
  npm stage view <stage-id>                 # optional: what was staged
  npm stage approve <stage-id> --auth-type=web
  ```

A newly staged version first shows as **validating**: npm is scanning it for malware, and it cannot
be approved until the scan finishes (usually a few minutes). Nothing is wrong; wait, then approve.

Approval asks for 2FA, so an agent cannot do it and must not try: tell the maintainer the version is
waiting, with the commands above. Once approved, `npm view loopstra version` shows it, and `loopstra
upgrade` offers it to users.

## Rules for agents

- Never run `npm publish`, `npm stage publish`, `npm stage approve`, `npm stage reject` or
  `npm dist-tag` yourself. Releases go through the workflow; approval and rejection are the
  maintainer's.
- Never add an npm token to the repository or to GitHub secrets, and never suggest turning on
  "Allow npm publish" or "npm dist-tag" for the trusted publisher.
- Never commit a real version in `package.json`, and never create, move or delete a `v*` tag, except
  in the recovery steps below with the maintainer's go-ahead.
- To release now without a code change, ask the maintainer to run the workflow by hand
  (or run `gh workflow run release.yml --ref main` if they asked you to).
- A change to what ships (`files`, a new runtime file outside `src/` or `templates/`) needs the
  end-to-end test (`tests/integration/upgrade-e2e.test.ts`) to pass. It packs exactly what `files`
  names, installs it into a throwaway `BUN_INSTALL`, upgrades an old repository, upgrades itself from
  a fake registry, and loads the console.

## When something goes wrong

- **CI on main failed, so no release ran.** Fix the cause and push, or re-run CI. Windows runners are
  slow: a timing-sensitive test is the usual suspect.
- **The run failed before staging** (plan, version, `shipped.json`). Fix it and run the workflow
  again by hand.
- **Staging failed with an authentication error.** Check the trusted publisher on npmjs.com against
  the values above (the workflow file name must be exactly `release.yml`), and that the job still has
  `permissions: id-token: write`.
- **The run failed after staging** (tag or GitHub Release). Approve the staged version first: a re-run
  before that fails at staging, since npm refuses to stage a version twice. After approval, a re-run
  sees the version published, skips staging, and adds the missing tag and release.
- **A staged version must not go out.** The maintainer rejects it (`npm stage reject <stage-id>`, or
  on npmjs.com). Delete its GitHub Release (`gh release delete v<version>`) but keep the tag, so the
  next release takes the next version number instead of reusing this one.
- **A version that went out is bad.** Fix it on main; the next release supersedes it. Deprecating it
  (`npm deprecate loopstra@<version> "<why>"`) is the maintainer's call and needs their 2FA.

## Checking a release

Install it somewhere that is not the real global install:

```
BUN_INSTALL=/tmp/lp bun add -g loopstra@<version>
/tmp/lp/bin/loopstra --version
```

Then, in a throwaway git repository: `loopstra init`, `loopstra upgrade --check` (it asks the real
registry and should say the version is the latest), and `loopstra ui` (the page should load its
script).
