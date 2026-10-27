import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../src/package";

const read = (path: string) => readFileSync(join(PACKAGE_ROOT, path), "utf8");

// CI and the release run the Bun .bun-version names, and Loopstra refuses an older one (see oldBun), so
// the tests run on the oldest Bun it allows. Changing it means changing it here, in package.json and in the README.
test("one Bun version: .bun-version, engines.bun, the README, and every workflow that installs Bun", () => {
  const version = read(".bun-version").trim();
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect((JSON.parse(read("package.json")) as { engines: { bun: string } }).engines.bun).toBe(`>=${version}`);
  const readme = read("README.md");
  expect([...readme.matchAll(/Bun\]\(https:\/\/bun\.sh\) (\S+) or later|Bun (\d+\.\d+\.\d+)\+/g)].map((m) => m[1] ?? m[2])).toEqual([version, version]);
  for (const workflow of ["ci.yml", "release.yml"]) {
    const text = read(`.github/workflows/${workflow}`);
    const setups = text.match(/uses: oven-sh\/setup-bun@/g)?.length ?? 0;
    expect(setups).toBeGreaterThan(0);
    // Without the file, setup-bun would fall back to the newest Bun engines.bun allows.
    expect(text.match(/bun-version-file: \.bun-version\r?$/gm)?.length).toBe(setups);
    expect(text).not.toMatch(/bun-version:/);
  }
});
