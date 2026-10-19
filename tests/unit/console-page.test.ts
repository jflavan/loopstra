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

  test("an empty toast region stays in the accessibility tree, so its first toast is read out, but is unseen and takes no room", async () => {
    const css = await Bun.file(join(import.meta.dir, "..", "..", "src", "ui", "theme.css")).text();
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect({ selector, found: at >= 0 }).toEqual({ selector, found: true });
      return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)).split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean);
    };
    const empty = rule(".toasts > div:empty");
    // display: none (or visibility: hidden) would take the region out of the tree.
    expect(empty.some((d) => /^(display: none|visibility: hidden)$/.test(d))).toBe(false);
    // Out of the grid's flow (no cell, no gap), one pixel, and clipped away.
    expect(empty).toEqual(expect.arrayContaining(["position: absolute", "width: 1px", "height: 1px", "overflow: hidden", "clip-path: inset(50%)"]));
    // The regions with toasts still stack as one list.
    expect(rule(".toasts > div")).toEqual(expect.arrayContaining(["display: grid", "gap: 8px"]));
  });
});
