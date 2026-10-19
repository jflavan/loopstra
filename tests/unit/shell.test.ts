import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorText, runCommand, spawnBounded, withBunOnPath, within, withoutGitLocation, type StdinWriter } from "../../src/shell";
import { Cancelled } from "../../src/stop";
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

  test("a timeout longer than a timer can hold (35,792 minutes and up) waits that long at least, not 1 ms", async () => {
    const t = tempDir();
    const r = await runCommand(`bun -e "await Bun.sleep(300)"`, t.path, { timeoutMs: 40_000 * 60_000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    let settle: (v: string) => void = () => {};
    const slow = new Promise<string>((resolve) => { settle = resolve; });
    const waited = within(slow, 35_792 * 60_000, "late");
    expect(await Promise.race([waited, Bun.sleep(100).then(() => "still waiting")])).toBe("still waiting");
    settle("done"); // so within clears its timer
    expect(await waited).toBe("done");
    t.cleanup();
  });

  test("a cancelled command is killed at once and throws Cancelled; once cancelled, none starts", async () => {
    const t = tempDir();
    const cancel = new AbortController();
    const started = Date.now();
    setTimeout(() => cancel.abort(), 200);
    expect(await runCommand(`bun -e "await Bun.sleep(5000)"`, t.path, { signal: cancel.signal }).catch((e: unknown) => e)).toBeInstanceOf(Cancelled);
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(await runCommand("echo never > ran.txt", t.path, { signal: cancel.signal }).catch((e: unknown) => e)).toBeInstanceOf(Cancelled);
    expect(existsSync(join(t.path, "ran.txt"))).toBe(false);
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

describe("spawnBounded's stdin", () => {
  test("stdin kept open: a writer goes to the caller, and what it writes reaches the process", async () => {
    const t = tempDir();
    try {
      let w: StdinWriter | null = null;
      const lines: string[] = [];
      const script = "for await (const c of Bun.stdin.stream()) process.stdout.write(new TextDecoder().decode(c));";
      const r = await spawnBounded({
        cmd: [process.execPath, "-e", script], cwd: t.path, timeoutMs: 10_000, onStop: "kill",
        stdin: { open: "first\n" },
        onStdin: (writer) => { w = writer; },
        onLine: (l) => { lines.push(l); if (l === "first") w!.write("second\n"); if (l === "second") w!.end(); return false; },
      });
      expect(r.code).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(lines).toEqual(["first", "second"]);
      // Closed, the writer takes nothing more.
      expect(w!.write("third\n")).toBe(false);
    } finally { t.cleanup(); }
  });

  test("an open stdin is closed once reading ends, so the process can exit by itself", async () => {
    const t = tempDir();
    try {
      // Prints a line, then waits for stdin to close before it exits.
      const script = "console.log('ready'); for await (const _ of Bun.stdin.stream()) {} process.exit(7);";
      const r = await spawnBounded({
        cmd: [process.execPath, "-e", script], cwd: t.path, timeoutMs: 10_000, onStop: "kill", graceMs: 5_000,
        stdin: { open: "" },
        onLine: (l) => l === "ready",
      });
      expect(r.code).toBe(7);
    } finally { t.cleanup(); }
  });
});

describe("spawnBounded's onLine", () => {
  test("a line split across two writes is delivered once, whole", async () => {
    const t = tempDir();
    try {
      const lines: string[] = [];
      const script = "process.stdout.write('abc'); await Bun.sleep(150); process.stdout.write('def\\nghi\\n');";
      const r = await spawnBounded({ cmd: [process.execPath, "-e", script], cwd: t.path, timeoutMs: 10_000, onStop: "kill", onLine: (l) => { lines.push(l); return false; } });
      expect(r.code).toBe(0);
      expect(lines).toEqual(["abcdef", "ghi"]);
    } finally { t.cleanup(); }
  });

  test("a handler that throws ends the call with its error, not with a timeout", async () => {
    const t = tempDir();
    try {
      const script = "console.log('one'); await Bun.sleep(60_000);";
      const started = Date.now();
      await expect(spawnBounded({ cmd: [process.execPath, "-e", script], cwd: t.path, timeoutMs: 30_000, onStop: "kill", graceMs: 500, onLine: () => { throw new Error("handler bug"); } })).rejects.toThrow("handler bug");
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally { t.cleanup(); }
  });
});

describe("errorText", () => {
  test("an Error gives its message; anything else is shown as text, never [object Object]", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(null)).not.toContain("[object");
    expect(errorText({ code: "ENOENT" })).not.toBe("[object Object]");
  });
});

describe("a project command's environment", () => {
  test("a hook's repository variables (GIT_DIR, GIT_INDEX_FILE) do not reach the command", async () => {
    const t = tempDir();
    const had = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = join(t.path, "elsewhere", ".git");
    process.env.GIT_INDEX_FILE = join(t.path, "elsewhere", "index");
    try {
      const script = "console.log(JSON.stringify([process.env.GIT_DIR ?? null, process.env.GIT_INDEX_FILE ?? null, typeof process.env.PATH]))";
      const r = await runCommand(`bun -e "${script.replace(/[\\"]/g, "\\$&")}"`, t.path);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.output.trim())).toEqual([null, null, "string"]);
      const env: Record<string, string | undefined> = { GIT_DIR: "x", GIT_WORK_TREE: "y", HOME: "h" };
      expect(withoutGitLocation(env)).toEqual({ HOME: "h" });
      // The other variables a hook or alias exports that change what a git call does: how pathspecs
      // are read, the dates of the commit it is part of, and its -c settings. An author's name stays
      // (gitEnv drops it for the runtime's own calls).
      const hook: Record<string, string | undefined> = {
        GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "1", GIT_NOGLOB_PATHSPECS: "1", GIT_ICASE_PATHSPECS: "1",
        GIT_AUTHOR_DATE: "d", GIT_COMMITTER_DATE: "d", GIT_CONFIG_PARAMETERS: "'a.b'='c'", GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_CONFIG_KEY_1: "d.e", GIT_CONFIG_VALUE_1: "f",
        GIT_AUTHOR_NAME: "Person", GIT_CONFIG_GLOBAL: "/home/p/.gitconfig", HOME: "h",
      };
      expect(withoutGitLocation(hook)).toEqual({ GIT_AUTHOR_NAME: "Person", GIT_CONFIG_GLOBAL: "/home/p/.gitconfig", HOME: "h" });
    } finally {
      for (const [k, v] of Object.entries(had)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      t.cleanup();
    }
  });
});
