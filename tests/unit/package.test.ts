import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunRange, hookSettings, isDev, oldBun, PACKAGE_ROOT, packageVersion, stampVersion, templatePath } from "../../src/package";

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

test("oldBun holds Bun to the package's engines range", () => {
  expect(bunRange()).toMatch(/^>=\d+\.\d+\.\d+$/);
  // The Bun running these tests is one the package runs on.
  expect(oldBun("start Loopstra again")).toBeNull();
  expect(oldBun("start Loopstra again", "1.4.2", ">=1.4.4")).toBe("Loopstra needs Bun 1.4.4 or later; this is Bun 1.4.2. Run bun upgrade, then start Loopstra again.");
  expect(oldBun("x", "1.4.4", ">=1.4.4")).toBeNull();
  expect(oldBun("x", "1.10.0", ">=1.4.4")).toBeNull();
  // A canary counts as its release: a newer one is fine, an older one is not.
  expect(oldBun("x", "1.4.5-canary.1+abc", ">=1.4.4")).toBeNull();
  expect(oldBun("x", "1.4.4-canary.1", ">=1.4.4")).toBeNull();
  expect(oldBun("x", "1.4.3-canary.9", ">=1.4.4")).not.toBeNull();
});
