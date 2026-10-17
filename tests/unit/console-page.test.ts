import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("the console's page", () => {
  test("bundles without errors, and its scripts stay under 80 KB gzipped", async () => {
    const r = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "..", "src", "ui", "index.html")], minify: true });
    expect(r.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
    expect(r.success).toBe(true);
    let gzipped = 0;
    for (const o of r.outputs) if (o.path.endsWith(".js")) gzipped += Bun.gzipSync(new Uint8Array(await o.arrayBuffer())).length;
    expect(gzipped).toBeGreaterThan(10_000);
    expect(gzipped).toBeLessThan(80 * 1024);
  });
});
