import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, installCommand, latestVersion, releaseNotes, updateNotice } from "../../src/upgrade/tool";
import { tempDir } from "../helpers";

function serve(routes: Record<string, unknown>) {
  let asked = 0;
  const server = Bun.serve({ port: 0, fetch: (req) => {
    asked++;
    const path = new URL(req.url).pathname;
    return path in routes ? Response.json(routes[path]) : new Response("no", { status: 404 });
  } });
  return { url: `http://localhost:${server.port}`, asked: () => asked, stop: () => server.stop(true) };
}

describe("versions", () => {
  test("compareVersions", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.0.0-dev+abc", "0.0.1")).toBeLessThan(0);
    expect(compareVersions("0.0.0-dev+abc", "0.0.0")).toBeLessThan(0);
  });

  test("latestVersion reads the registry; null when it cannot", async () => {
    const s = serve({ "/loopstra/latest": { version: "0.4.2" } });
    try {
      expect(await latestVersion(s.url)).toBe("0.4.2");
      expect(await latestVersion(`${s.url}/nothing`)).toBeNull();
      expect(await latestVersion("http://localhost:1")).toBeNull();
    } finally { s.stop(); }
  });

  test("releaseNotes collects the releases after `from` up to `to`, newest first", async () => {
    const s = serve({ "/repos/jflavan/loopstra/releases": [
      { tag_name: "v0.5.1", body: "- fix: too new" }, { tag_name: "v0.5.0", body: "- feat: c" }, { tag_name: "v0.4.1", body: "- fix: b" }, { tag_name: "v0.4.0", body: "- feat: a" },
    ] });
    try {
      expect(await releaseNotes("0.4.0", "0.5.0", s.url)).toBe("## 0.5.0\n- feat: c\n\n## 0.4.1\n- fix: b");
      expect(await releaseNotes("0.4.0", "0.5.0", "http://localhost:1")).toBe("");
    } finally { s.stop(); }
  });

  test("the notice is cached for a day and silent in a development checkout", async () => {
    const t = tempDir();
    const s = serve({ "/loopstra/latest": { version: "0.9.0" } });
    const out = "Loopstra 0.9.0 is out (you have 0.4.0): run loopstra upgrade.";
    try {
      expect(await updateNotice(t.path, { installed: "0.0.0-dev", registry: s.url })).toBeNull();
      expect(s.asked()).toBe(0);
      expect(await updateNotice(t.path, { installed: "0.4.0", registry: s.url, now: 1_000 })).toBe(out);
      expect(existsSync(join(t.path, ".loopstra", "update-check.json"))).toBe(true);
      s.stop();
      // Cached: the stopped server is not asked again within the day.
      expect(await updateNotice(t.path, { installed: "0.4.0", registry: s.url, now: 2_000 })).toBe(out);
      // A day later the registry is asked again; it cannot be reached, so there is nothing to say.
      expect(await updateNotice(t.path, { installed: "0.4.0", registry: s.url, now: 1_000 + 25 * 60 * 60_000 })).toBeNull();
      expect(await updateNotice(t.path, { installed: "0.9.0", registry: s.url, stamp: "0.8.0" })).toBe("This repository is on Loopstra 0.8.0 and 0.9.0 is installed: run loopstra upgrade.");
      expect(await updateNotice(t.path, { installed: "0.9.0", registry: s.url, stamp: "0.0.0-dev+abc1234" })).toBe("This repository is on Loopstra 0.0.0-dev+abc1234 and 0.9.0 is installed: run loopstra upgrade.");
    } finally { s.stop(); t.cleanup(); }
  });

  test("up to date: no notice", async () => {
    const t = tempDir();
    const s = serve({ "/loopstra/latest": { version: "0.9.0" } });
    try {
      expect(await updateNotice(t.path, { installed: "0.9.0", registry: s.url, stamp: "0.9.0" })).toBeNull();
    } finally { s.stop(); t.cleanup(); }
  });
});

describe("installCommand", () => {
  const saved = process.env.LOOPSTRA_INSTALL_COMMAND;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOPSTRA_INSTALL_COMMAND;
    else process.env.LOOPSTRA_INSTALL_COMMAND = saved;
  });

  test("bun add -g by default; the test override as words or as a JSON array", () => {
    delete process.env.LOOPSTRA_INSTALL_COMMAND;
    expect(installCommand("0.5.0")).toEqual(["bun", "add", "-g", "loopstra@0.5.0"]);
    process.env.LOOPSTRA_INSTALL_COMMAND = "bun add -g /tmp/loopstra-{version}.tgz";
    expect(installCommand("0.5.0")).toEqual(["bun", "add", "-g", "/tmp/loopstra-0.5.0.tgz"]);
    process.env.LOOPSTRA_INSTALL_COMMAND = JSON.stringify(["bun", "add", "-g", "C:/a folder/loopstra-{version}.tgz"]);
    expect(installCommand("0.5.0")).toEqual(["bun", "add", "-g", "C:/a folder/loopstra-0.5.0.tgz"]);
  });
});
