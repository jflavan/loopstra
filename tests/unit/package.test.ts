import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hookSettings, isDev, PACKAGE_ROOT, packageVersion, stampVersion, templatePath } from "../../src/package";

describe("package", () => {
  test("the package root holds package.json and the templates", () => {
    expect(existsSync(join(PACKAGE_ROOT, "package.json"))).toBe(true);
    expect(existsSync(templatePath("prompts", "build.md"))).toBe(true);
  });

  test("a checkout is the development version; its stamp version names the commit", async () => {
    expect(packageVersion()).toBe("0.0.0-dev");
    expect(isDev()).toBe(true);
    expect(await stampVersion()).toMatch(/^0\.0\.0-dev\+[0-9a-f]{7,}$/);
  });

  test("the hook settings run the shipped hook by absolute path, with forward slashes", () => {
    const s = JSON.parse(hookSettings()) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } };
    const entry = s.hooks.PreToolUse[0]!;
    expect(entry.matcher).toBe("Edit|Write|MultiEdit");
    expect(entry.hooks[0]!.command).toBe(`bun "${templatePath("hooks", "loopstra-protect-tests.ts").replace(/\\/g, "/")}"`);
    expect(entry.hooks[0]!.command).not.toContain("\\");
  });
});
