import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../../src/config";
import { claim, release } from "../../src/lanes";
import { changeEnv, sweepTempFolders, tempRoot } from "../../src/resources";
import { tempDir } from "../helpers";

let dirs: Array<{ cleanup: () => void }> = [];
let servers: Server[] = [];
afterEach(() => {
  for (const s of ["a", "b", "c"]) release(s);
  for (const r of roots) rmSync(tempRoot(r), { recursive: true, force: true });
  roots = [];
  for (const s of servers) s.close();
  for (const d of dirs) d.cleanup();
  servers = [];
  dirs = [];
});

let roots: string[] = [];
function root(): string {
  const d = tempDir();
  dirs.push(d);
  roots.push(d.path);
  return d.path;
}

function config(speed: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ version: 1, commands: { test: "x" }, speed });
}

/** A port taken on 127.0.0.1 until the test ends. */
function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ port, host: "127.0.0.1" }, () => resolve());
    servers.push(s);
  });
}

/** True when the port can be bound on 127.0.0.1 now (Windows reserves some ranges outright: EACCES). */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** The first of `count` ports in a row that all bind now, from a random start, so tests running at once rarely meet. */
async function freshFrom(count = 16): Promise<number> {
  for (let tries = 0; tries < 200; tries++) {
    const from = 21000 + Math.floor(Math.random() * 900) * 20;
    let all = true;
    for (let p = from; p < from + count && all; p++) all = await bindable(p);
    if (all) return from;
  }
  throw new Error("no free run of ports found");
}

describe("changeEnv", () => {
  test("a change that is not claimed gets nothing", async () => {
    expect(await changeEnv({ root: root(), cfg: config(), slug: "a" })).toEqual({});
  });

  test("a claimed change gets its slot, its own temp folder and a block of ports; release removes the folder", async () => {
    const r = root();
    const from = await freshFrom();
    const cfg = config({ ports_from: from, ports_per_change: 5 });
    claim("a");
    const env = await changeEnv({ root: r, cfg, slug: "a" });
    const temp = join(tempRoot(r), "s0");
    // Short, whatever the repository's path: tools make Unix sockets under TMPDIR.
    expect(temp.startsWith(tmpdir())).toBe(true);
    expect(env).toEqual({
      LOOPSTRA_SLOT: "0", TMPDIR: temp, TMP: temp, TEMP: temp,
      LOOPSTRA_PORT_BASE: String(from), LOOPSTRA_PORT_COUNT: "5",
    });
    expect(existsSync(temp)).toBe(true);
    // The same for the rest of the step.
    expect(await changeEnv({ root: r, cfg, slug: "a" })).toEqual(env);
    release("a");
    expect(existsSync(temp)).toBe(false);
  });

  test("two changes running at once never share ports, and a block with a busy port is passed over", async () => {
    const r = root();
    const from = await freshFrom();
    const cfg = config({ ports_from: from, ports_per_change: 4 });
    // The second block has a port in use by something else.
    await occupy(from + 4 + 2);
    claim("a");
    claim("b");
    const [a, b] = await Promise.all([changeEnv({ root: r, cfg, slug: "a" }), changeEnv({ root: r, cfg, slug: "b" })]);
    const bases = [a.LOOPSTRA_PORT_BASE, b.LOOPSTRA_PORT_BASE].map(Number).sort((x, y) => x - y);
    expect(bases).toEqual([from, from + 8]);
    // A released block is handed out again.
    const freed = a.LOOPSTRA_PORT_BASE;
    release("a");
    claim("c");
    expect((await changeEnv({ root: r, cfg, slug: "c" })).LOOPSTRA_PORT_BASE).toBe(freed);
  });

  test("no ports with ports_per_change 0, and none when no block up to the last port is free", async () => {
    const r = root();
    claim("a");
    expect(await changeEnv({ root: r, cfg: config({ ports_per_change: 0 }), slug: "a" })).not.toHaveProperty("LOOPSTRA_PORT_BASE");
    release("a");
    // One block of 10 fits below 65535 from 65526, and its last port is taken.
    await occupy(65535).catch(() => {}); // already taken on this machine is as good
    claim("b");
    expect(await changeEnv({ root: r, cfg: config({ ports_from: 65526, ports_per_change: 10 }), slug: "b" })).not.toHaveProperty("LOOPSTRA_PORT_BASE");
  });

  test("with own_caches, each slot gets its own cache folders, kept after the change is released", async () => {
    const r = root();
    const cfg = config({ own_caches: true, ports_per_change: 0 });
    claim("a");
    claim("b");
    const a = await changeEnv({ root: r, cfg, slug: "a" });
    const b = await changeEnv({ root: r, cfg, slug: "b" });
    const slotCache = (n: number, tool: string) => join(r, ".loopstra", "cache", `slot-${n}`, tool);
    expect(a.XDG_CACHE_HOME).toBe(slotCache(0, "xdg"));
    expect(b.XDG_CACHE_HOME).toBe(slotCache(1, "xdg"));
    expect([a.npm_config_cache, a.BUN_INSTALL_CACHE_DIR, a.YARN_CACHE_FOLDER, a.PIP_CACHE_DIR, a.GOCACHE]).toEqual(
      ["npm", "bun", "yarn", "pip", "go"].map((t) => slotCache(0, t)),
    );
    release("a");
    expect(existsSync(slotCache(0, "xdg"))).toBe(true);
    // Without the setting, none.
    claim("c");
    expect(await changeEnv({ root: r, cfg: config({ ports_per_change: 0 }), slug: "c" })).not.toHaveProperty("XDG_CACHE_HOME");
  });
});

describe("sweepTempFolders", () => {
  test("removes the temp folders of changes that are not claimed and keeps a running change's", async () => {
    const r = root();
    mkdirSync(join(tempRoot(r), "s7"), { recursive: true });
    claim("a");
    await changeEnv({ root: r, cfg: config({ ports_per_change: 0 }), slug: "a" });
    sweepTempFolders(r);
    expect(existsSync(join(tempRoot(r), "s7"))).toBe(false);
    expect(existsSync(join(tempRoot(r), "s0"))).toBe(true);
  });

  test("does nothing when there is no temp folder yet", () => {
    expect(() => sweepTempFolders(root())).not.toThrow();
  });
});
