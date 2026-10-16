#!/usr/bin/env bun
// A project command for tests: `bun meet.ts <dir> <me> <other> <exit code>` marks <me> in <dir>,
// waits up to 3s for <other> to do the same, and exits 3 if it never does; else with <exit code>.
// Two of these pass only when they run at the same time.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, me, other, code] = Bun.argv.slice(2) as [string, string, string, string];
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, me), "");
const until = Date.now() + 3000;
while (!existsSync(join(dir, other))) {
  if (Date.now() > until) { console.log(`${me} never met ${other}`); process.exit(3); }
  await Bun.sleep(20);
}
console.log(`${me} met ${other}`);
process.exit(Number(code));
