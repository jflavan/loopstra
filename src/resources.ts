/**
 * What a running change gets of the machine, so changes running at the same time do not share it:
 * its slot (see slotEnv), its own temp folder, a block of free ports, and (speed.own_caches) its
 * slot's own tool caches. Every project command, hook command and session that may run commands
 * gets them through changeEnv. A change that is not claimed (main's health check) gets none.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Config } from "./config";
import { isClaimed, onRelease, slotEnv } from "./lanes";
import { loopstraDir } from "./paths";

/** The folder of every change's temp folder, `.loopstra/tmp/`. */
export function tempRoot(root: string): string {
  return join(loopstraDir(root), "tmp");
}

/** The folder of each slot's caches, `.loopstra/cache/`. */
function cacheRoot(root: string): string {
  return join(loopstraDir(root), "cache");
}

/** How many blocks of ports are tried before a change goes without (each try binds every port of the block). */
const PORT_TRIES = 50;

/** Each claimed change's temp folder, removed when its step releases it. */
const temps = new Map<string, string>();
/** Each claimed change's port block (its first port), or null when none was free; a promise while it is looked for. */
const ports = new Map<string, Promise<number | null>>();
/** The block index each claimed change holds or is trying, so two changes never try the same one. */
const blocks = new Map<string, number>();
/** The look for a block in progress for each claimed change (see portBlock). */
const looks = new Map<string, symbol>();

onRelease((slug) => {
  const temp = temps.get(slug);
  temps.delete(slug);
  ports.delete(slug);
  blocks.delete(slug);
  looks.delete(slug);
  if (temp) rmSync(temp, { recursive: true, force: true, maxRetries: 2 });
});

/** The tool caches a project may share between changes, each set to its own folder under the slot's cache folder. */
const CACHE_VARS: ReadonlyArray<[string, string]> = [
  ["XDG_CACHE_HOME", "xdg"], ["npm_config_cache", "npm"], ["BUN_INSTALL_CACHE_DIR", "bun"],
  ["YARN_CACHE_FOLDER", "yarn"], ["PIP_CACHE_DIR", "pip"], ["GOCACHE", "go"],
];

/**
 * The environment a claimed change's commands and command-running sessions get (on top of
 * LOOPSTRA_SLUG): LOOPSTRA_SLOT; TMPDIR, TMP and TEMP set to `.loopstra/tmp/<slug>/`;
 * LOOPSTRA_PORT_BASE and LOOPSTRA_PORT_COUNT when speed.ports_per_change is above 0 and a block of
 * ports is free; and with speed.own_caches, the CACHE_VARS under `.loopstra/cache/slot-<n>/`. The
 * same for the rest of the step. Empty for a change that is not claimed.
 */
export async function changeEnv(on: { root: string; cfg: Config; slug: string }): Promise<Record<string, string>> {
  const slot = slotEnv(on.slug).LOOPSTRA_SLOT;
  if (slot === undefined) return {};
  const env: Record<string, string> = { LOOPSTRA_SLOT: slot };
  const temp = tempFolder(on.root, on.slug);
  Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp });
  const count = on.cfg.speed.ports_per_change;
  if (count > 0) {
    const base = await portBlock(on.slug, count, on.cfg.speed.ports_from);
    if (base !== null) Object.assign(env, { LOOPSTRA_PORT_BASE: String(base), LOOPSTRA_PORT_COUNT: String(count) });
  }
  if (on.cfg.speed.own_caches) {
    for (const [name, folder] of CACHE_VARS) {
      const dir = join(cacheRoot(on.root), `slot-${slot}`, folder);
      mkdirSync(dir, { recursive: true });
      env[name] = dir;
    }
  }
  return env;
}

/** The change's temp folder, made on first use. */
function tempFolder(root: string, slug: string): string {
  let dir = temps.get(slug);
  if (!dir) {
    dir = join(tempRoot(root), slug);
    temps.set(slug, dir);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The first port of the change's block: the lowest block (`from + i × count`) that no other claimed
 * change holds and whose ports all bind on 127.0.0.1 now. Null when none of the first PORT_TRIES free
 * blocks are, or the ports run out. Looked for once per step; asking again meanwhile waits for it.
 */
function portBlock(slug: string, count: number, from: number): Promise<number | null> {
  const known = ports.get(slug);
  if (known) return known;
  // Which look this is: one the change was released during (its step ended) stops.
  const look = Symbol(slug);
  looks.set(slug, look);
  const found = (async () => {
    let tried = 0;
    for (let i = 0; from + (i + 1) * count - 1 <= 65535 && tried < PORT_TRIES; i++) {
      if ([...blocks.values()].includes(i)) continue;
      blocks.set(slug, i);
      tried++;
      if (await allFree(from + i * count, count)) return from + i * count;
      // Released meanwhile: the step ended, so it needs no ports.
      if (looks.get(slug) !== look) return null;
      blocks.delete(slug);
    }
    blocks.delete(slug);
    return null;
  })();
  ports.set(slug, found);
  return found;
}

/** True when every port from `base` (`count` of them) can be bound on 127.0.0.1 now. */
async function allFree(base: number, count: number): Promise<boolean> {
  for (let p = base; p < base + count; p++) {
    if (!(await bindable(p))) return false;
  }
  return true;
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Removes the temp folders of changes that are not claimed: a step that crashed, or a loop that was
 * killed, left them. Best effort; run at a tick's start.
 */
export function sweepTempFolders(root: string): void {
  let names: string[];
  try { names = readdirSync(tempRoot(root)); } catch { return; }
  for (const name of names) {
    if (isClaimed(name)) continue;
    try { rmSync(join(tempRoot(root), name), { recursive: true, force: true }); } catch { /* the next tick tries again */ }
  }
}
