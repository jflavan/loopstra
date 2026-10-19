#!/usr/bin/env bun
// Dead-code gate: knip finds unused files, exports, types and dependencies; this fails when they
// make up more than MAX_PERCENT (default 0: none allowed) of everything declared (source files plus `export` declarations).
// Usage: bun run deadcode [--max N]
import { Glob } from "bun";

const maxArg = process.argv.indexOf("--max");
const MAX_PERCENT = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : 0;

const proc = Bun.spawn({ cmd: ["bunx", "knip", "--reporter", "json", "--no-exit-code"], stdout: "pipe", stderr: "inherit" });
const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

type Item = { name: string };
interface Issue { file: string; files: Item[]; exports: Item[]; types: Item[]; dependencies: Item[]; devDependencies: Item[]; unlisted: Item[]; unresolved: Item[] }
const { issues } = JSON.parse(out) as { issues: Issue[] };

const dead: string[] = [];
for (const i of issues) {
  for (const f of i.files) dead.push(`unused file      ${f.name}`);
  for (const e of i.exports) dead.push(`unused export    ${i.file}: ${e.name}`);
  for (const t of i.types) dead.push(`unused type      ${i.file}: ${t.name}`);
  for (const d of [...i.dependencies, ...i.devDependencies]) dead.push(`unused dependency ${d.name}`);
  for (const u of i.unlisted) dead.push(`unlisted import  ${i.file}: ${u.name}`);
  for (const u of i.unresolved) dead.push(`unresolved import ${i.file}: ${u.name}`);
}

let declared = 0;
for (const pattern of ["src/**/*.{ts,tsx}", "tests/**/*.ts", "scripts/**/*.ts"]) {
  for (const file of new Glob(pattern).scanSync(".")) {
    declared += 1 + (((await Bun.file(file).text()).match(/^export\s/gm)) ?? []).length;
  }
}

const percent = (dead.length / declared) * 100;
for (const line of dead) console.log(line);
console.log(`\ndead code: ${dead.length} of ${declared} declarations = ${percent.toFixed(2)}% (limit ${MAX_PERCENT}%)`);
process.exit(percent > MAX_PERCENT ? 1 : 0);
