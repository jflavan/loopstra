import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { github } from "../../src/setup/sections/github";
import { run, tempDir, tempGitRepo, withEnv } from "../helpers";
import { askSection, checkSection } from "../setup-helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));
const CONFIG = "version: 1\ncommands:\n  test: echo ok\n";

async function repoWithRemote() {
  const repo = await tempGitRepo();
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  await run(["git", "remote", "add", "origin", remote.path], repo.path);
  await Bun.write(`${repo.path}/loopstra/config.yaml`, CONFIG);
  return { path: repo.path, cleanup: () => { repo.cleanup(); remote.cleanup(); } };
}

describe("the github section", () => {
  test("sets how a change is merged and the method", async () => {
    const r = await repoWithRemote();
    try {
      const { text, shown } = await askSection(github, r.path, ["pr", "merge"]);
      expect(parse(text).gates.merge).toEqual({ human: "pr", method: "merge" });
      expect(shown).toContain("This repository pushes to origin:");
    } finally { r.cleanup(); }
  });

  test("--defaults keeps merging on its own, squashed, and adds nothing", async () => {
    const r = await repoWithRemote();
    try {
      expect((await askSection(github, r.path, "defaults")).text).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("with a remote: the remote answers and gh is signed in; signed out fails", async () => {
    const r = await repoWithRemote();
    try {
      await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "0" }, async () => {
        expect((await checkSection(github, r.path)).map((c) => c.level)).toEqual(["ok", "ok"]);
      });
      await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "1" }, async () => {
        const [, gh] = await checkSection(github, r.path);
        expect(gh).toEqual({ level: "fail", text: "gh is not signed in (or not installed): run gh auth login. With a remote, Loopstra merges through pull requests." });
      });
    } finally { r.cleanup(); }
  });

  test("the GitHub executable comes from the setup's environment", async () => {
    const r = await repoWithRemote();
    try {
      await withEnv({ LOOPSTRA_FAKE_GH_SIGNED_OUT: "0" }, async () => {
        expect((await checkSection(github, r.path, { LOOPSTRA_GH_EXECUTABLE: FAKE_GH })).map((c) => c.level)).toEqual(["ok", "ok"]);
      });
    } finally { r.cleanup(); }
  });

  test("a remote that cannot be reached fails", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/loopstra/config.yaml`, CONFIG);
      await run(["git", "remote", "add", "origin", `${repo.path}/no-such-remote`], repo.path);
      await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "0" }, async () => {
        const [reach] = await checkSection(github, repo.path);
        expect(reach!.level).toBe("fail");
        expect(reach!.text).toStartWith("git remote origin could not be reached");
      });
    } finally { repo.cleanup(); }
  });

  test("without a remote: fine, unless merges are set to go through pull requests", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/loopstra/config.yaml`, CONFIG);
      expect(await checkSection(github, repo.path)).toEqual([{ level: "ok", text: "No git remote: changes merge locally." }]);
      await Bun.write(`${repo.path}/loopstra/config.yaml`, `${CONFIG}gates:\n  merge:\n    human: pr\n`);
      expect((await checkSection(github, repo.path))[0]!.level).toBe("fail");
    } finally { repo.cleanup(); }
  });
});
