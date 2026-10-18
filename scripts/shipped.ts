#!/usr/bin/env bun
// Writes shipped.json (every text each template has had, and the commit that first had it) for a release.
import { buildShippedIndex } from "../src/shipped";

const out = process.argv[2] ?? "shipped.json";
await Bun.write(out, `${JSON.stringify(await buildShippedIndex(process.cwd()), null, 1)}\n`);
console.log(`wrote ${out}`);
