# Loopstra

## Commands

- Install: `bun install`
- Test: `bun run test` (four parallel shards); `bun run test:serial` runs it in one process
- Typecheck: `bun run typecheck`
- Run the checkout: `bun src/cli.ts <command>`

## Releases and npm

Loopstra is the npm package `loopstra`. Before changing anything about releases (`.github/workflows/release.yml`, `scripts/release.ts`, `scripts/shipped.ts`, `version` or `files` in `package.json`, `v*` tags), read `docs/publishing.md`. In short:

- Releases go through the release workflow only. It stages each version on npm; a maintainer approves it with 2FA.
- Never run `npm publish`, `npm stage publish`, `npm stage approve`, `npm stage reject` or `npm dist-tag`, never add an npm token, and never commit a real version (`package.json` stays `0.0.0-dev`).
