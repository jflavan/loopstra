import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "loopstra-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export async function tempGitRepo(): Promise<{ path: string; cleanup: () => void }> {
  const t = tempDir("loopstra-repo-");
  await run(["git", "init", "-q", "-b", "main"], t.path);
  await run(["git", "config", "user.email", "loopstra-test@example.com"], t.path);
  await run(["git", "config", "user.name", "Loopstra Test"], t.path);
  await Bun.write(join(t.path, "README.md"), "# test repo\n");
  await run(["git", "add", "-A"], t.path);
  await run(["git", "commit", "-q", "-m", "init"], t.path);
  return t;
}
