import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, spawnBounded, withBunOnPath, within } from "../../src/shell";
import { tempDir } from "../helpers";

describe("runCommand", () => {
  test("captures exit code and combined output", async () => {
    const t = tempDir();
    const r = await runCommand("echo hello", t.path);
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe("hello");
    t.cleanup();
  });

  test("non-zero exit is reported, not thrown", async () => {
    const t = tempDir();
    const r = await runCommand("exit 3", t.path);
    expect(r.code).toBe(3);
    t.cleanup();
  });

  test("passes environment variables", async () => {
    const t = tempDir();
    const r = await runCommand("echo $LOOPSTRA_PHASE", t.path, { env: { LOOPSTRA_PHASE: "fix" } });
    expect(r.output.trim()).toBe("fix");
    t.cleanup();
  });

  test("a command that outlives its timeout is killed and reported plainly", async () => {
    const t = tempDir();
    const started = Date.now();
    const r = await runCommand(`bun -e "await Bun.sleep(5000)"`, t.path, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.lastLine).toBe("A project command did not finish in time.");
    const ok = await runCommand("echo fine", t.path, { timeoutMs: 10_000 });
    expect(ok.timedOut).toBe(false);
    t.cleanup();
  });

  test("lastLine returns the last non-empty line", async () => {
    const t = tempDir();
    const r = await runCommand("echo one; echo two", t.path);
    expect(r.lastLine).toBe("two");
    t.cleanup();
  });
});

describe("withBunOnPath", () => {
  const dir = dirname(process.execPath);
  test("puts the running Bun's folder first on PATH, keeping the key's spelling", () => {
    expect(withBunOnPath({ PATH: "/usr/bin" }).PATH).toBe(`${dir}${delimiter}/usr/bin`);
    const win = withBunOnPath({ Path: "C:\\Windows" });
    expect(win.Path).toBe(`${dir}${delimiter}C:\\Windows`);
    expect(Object.keys(win).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(withBunOnPath({}).PATH).toBe(dir);
    const already = { PATH: `${dir}${delimiter}/usr/bin` };
    expect(withBunOnPath(already)).toBe(already);
  });
});

/** Polls until `pid` is gone (true) or `ms` pass (false). */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > until) return false;
    await Bun.sleep(50);
  }
}

async function waitForFile(path: string, ms = 10_000): Promise<string> {
  const until = Date.now() + ms;
  while (!existsSync(path) || !readFileSync(path, "utf8").trim()) {
    if (Date.now() > until) throw new Error(`${path} never appeared`);
    await Bun.sleep(25);
  }
  return readFileSync(path, "utf8").trim();
}

describe("process trees (POSIX)", () => {
  test.skipIf(process.platform === "win32")("a timeout kill reaches a grandchild that started its own session", async () => {
    const t = tempDir();
    try {
      const pidFile = join(t.path, "grandchild.pid");
      const script = join(t.path, "child.ts");
      await Bun.write(script, `
const g = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.write(${JSON.stringify(pidFile)}, String(g.pid));
await Bun.sleep(60_000);
`);
      const r = await spawnBounded({ cmd: [process.execPath, script], cwd: t.path, timeoutMs: 1_500, onStop: "ignore" });
      expect(r.timedOut).toBe(true);
      const pid = Number(await waitForFile(pidFile, 100));
      expect(await gone(pid)).toBe(true);
    } finally { t.cleanup(); }
  });

  test.skipIf(process.platform === "win32")("SIGHUP asks for a stop; a second signal exits and kills the running child", async () => {
    const t = tempDir();
    try {
      const pidFile = join(t.path, "child.pid");
      const script = join(t.path, "parent.ts");
      const src = (f: string) => JSON.stringify(fileURLToPath(new URL(`../../src/${f}`, import.meta.url)));
      await Bun.write(script, `
import { spawnBounded } from ${src("shell.ts")};
import { installStopSignals } from ${src("stop.ts")};
installStopSignals();
void spawnBounded({
  cmd: [process.execPath, "-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}],
  cwd: ${JSON.stringify(t.path)}, timeoutMs: 60_000, onStop: "grace", graceMs: 60_000,
});
setInterval(() => {}, 1000);
`);
      const parent = Bun.spawn({ cmd: [process.execPath, script], cwd: t.path, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const pid = Number(await waitForFile(pidFile));
      parent.kill("SIGHUP");
      await Bun.sleep(300);
      expect(parent.exitCode).toBeNull();
      parent.kill("SIGTERM");
      expect(await within(parent.exited, 5_000, "hung")).toBe(130);
      expect(await gone(pid)).toBe(true);
    } finally { t.cleanup(); }
  });
});
