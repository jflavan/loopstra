import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git";

/** The installed package's folder (the checkout, in development): the one holding package.json, src/ and templates/. */
export const PACKAGE_ROOT = join(import.meta.dir, "..");

/** The version every development checkout has in package.json; a release sets the real one in CI only. */
export const DEV_VERSION = "0.0.0-dev";

/** A shipped template's path, e.g. templatePath("prompts", "build.md"). */
export function templatePath(...parts: string[]): string {
  return join(PACKAGE_ROOT, "templates", ...parts);
}

/** The version in the package's package.json. */
export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
}

/** True for a development checkout (run through `bun link` or `bun src/cli.ts`), which is never upgraded from npm. */
export function isDev(): boolean {
  return packageVersion() === DEV_VERSION;
}

/** The version a repository's stamp records: the release, or `0.0.0-dev+<short commit>` for a checkout. */
export async function stampVersion(): Promise<string> {
  if (!isDev()) return packageVersion();
  const r = await new Git(PACKAGE_ROOT).run(["rev-parse", "--short", "HEAD"], true);
  return r.code === 0 && r.out.trim() ? `${DEV_VERSION}+${r.out.trim()}` : DEV_VERSION;
}

/**
 * The `claude --settings` JSON that adds the test-protection hook to a session Loopstra starts. The
 * hook runs from the installed package by absolute path (forward slashes, for the Git Bash Claude
 * Code runs hooks through on Windows); it does nothing outside a fix phase.
 */
export function hookSettings(): string {
  const hook = templatePath("hooks", "loopstra-protect-tests.ts").replace(/\\/g, "/");
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `bun "${hook}"` }] }] } });
}
