import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigError, configPath } from "../../src/config";
import { init } from "../../src/init";
import { ConfigDocument } from "../../src/setup/document";
import { tempDir, tempGitRepo } from "../helpers";

const TEXT = `# Top comment
version: 1
commands:
  test: bun test # the tests
claude:
  timeout_minutes: 30
  max_budget_usd: 5
gates:
  spec: { human: none, agent: true }
`;

function load(text = TEXT) {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  writeFileSync(configPath(t.path), text);
  return { t, doc: ConfigDocument.load(t.path), file: () => readFileSync(configPath(t.path), "utf8") };
}

describe("ConfigDocument", () => {
  test("reads values and collections, and undefined for what is not there", () => {
    const { t, doc } = load();
    try {
      expect(doc.get(["claude", "timeout_minutes"])).toBe(30);
      expect(doc.get(["gates", "spec"])).toEqual({ human: "none", agent: true });
      expect(doc.get(["chat", "model"])).toBeUndefined();
    } finally { t.cleanup(); }
  });

  test("set keeps comments and key order, and a scalar keeps the comment on its line", () => {
    const { t, doc } = load();
    try {
      doc.set(["commands", "test"], "npm test");
      doc.set(["gates", "spec", "human"], "status");
      const text = doc.text();
      expect(text).toStartWith("# Top comment\n");
      expect(text).toMatch(/test: npm test\s+# the tests/);
      expect(text.indexOf("version")).toBeLessThan(text.indexOf("commands"));
      expect(parse(text).gates.spec).toEqual({ human: "status", agent: true });
    } finally { t.cleanup(); }
  });

  test("set makes the maps it needs, and an id that looks like a number stays a string", () => {
    const { t, doc } = load();
    try {
      doc.set(["chat", "transports", "discord", "channel"], "123456789012345678");
      expect(parse(doc.text()).chat.transports.discord.channel).toBe("123456789012345678");
    } finally { t.cleanup(); }
  });

  test("set fills a parent written with no value", () => {
    const { t, doc } = load(`${TEXT}chat:\n`);
    try {
      doc.set(["chat", "model"], "cheap");
      expect(parse(doc.text()).chat).toEqual({ model: "cheap" });
    } finally { t.cleanup(); }
  });

  test("set replaces a parent that is not a map (a word, an empty string, a list) with one", () => {
    for (const gates of ["none", "''", "[]"]) {
      const { t, doc } = load(`version: 1\ncommands:\n  test: bun test\ngates: ${gates}\n`);
      try {
        doc.set(["gates", "spec", "human"], "status");
        expect(parse(doc.text()).gates).toEqual({ spec: { human: "status" } });
        expect(doc.validate().gates.spec.human).toBe("status");
      } finally { t.cleanup(); }
    }
  });

  test("a parent that is filled keeps the comment on its line, and commented-out lines under it", () => {
    const { t, doc } = load(`${TEXT}chat: # the orchestrator\nnext: 1\n`);
    try {
      doc.set(["chat", "model"], "cheap");
      expect(doc.text()).toContain("# the orchestrator");
      expect(parse(doc.text()).chat).toEqual({ model: "cheap" });
    } finally { t.cleanup(); }
    const b = load(`${TEXT}chat:\n  # model: default\n  # transports: {}\n`);
    try {
      b.doc.set(["chat", "model"], "cheap");
      expect(b.doc.text()).toContain("# model: default");
      expect(b.doc.text()).toContain("# transports: {}");
      expect(parse(b.doc.text()).chat).toEqual({ model: "cheap" });
    } finally { b.t.cleanup(); }
  });

  test("a file with Windows line endings keeps them, and only the edited line changes", () => {
    const crlf = TEXT.replace(/\n/g, "\r\n");
    const { t, doc, file } = load(crlf);
    try {
      doc.set(["claude", "timeout_minutes"], 45);
      doc.save();
      const before = crlf.split("\r\n");
      const after = file().split("\r\n");
      expect(file()).not.toMatch(/[^\r]\n/);
      expect(after.length).toBe(before.length);
      expect(after.filter((line, i) => line !== before[i])).toEqual(["  timeout_minutes: 45"]);
    } finally { t.cleanup(); }
  });

  test("put adds a key only when it differs from the default, but updates one that is there", () => {
    const { t, doc } = load();
    try {
      doc.put(["gates", "plan", "human"], "none", "none");
      expect(doc.get(["gates", "plan"])).toBeUndefined();
      doc.put(["gates", "spec", "agent"], true, true);
      expect(doc.get(["gates", "spec", "agent"])).toBe(true);
      doc.put(["gates", "spec", "agent"], false, true);
      expect(doc.get(["gates", "spec", "agent"])).toBe(false);
    } finally { t.cleanup(); }
  });

  test("clear removes a key and ignores one that is not there", () => {
    const { t, doc } = load();
    try {
      doc.clear(["claude", "max_budget_usd"]);
      doc.clear(["nothing", "here"]);
      expect(doc.get(["claude", "max_budget_usd"])).toBeUndefined();
      expect(doc.get(["claude", "timeout_minutes"])).toBe(30);
    } finally { t.cleanup(); }
  });

  test("clear removes the maps it leaves empty, keeping the comments above them, but never the document", () => {
    const { t, doc } = load(`${TEXT}\n# Chat heading\nchat:\n  transports:\n    discord:\n      channel: "1"\nsignals:\n  main_health: { every_minutes: 30 }\n`);
    try {
      doc.clear(["chat", "transports", "discord", "channel"]);
      expect(doc.get(["chat"])).toBeUndefined();
      expect(doc.text()).toContain("# Chat heading");
      expect(parse(doc.text()).signals).toEqual({ main_health: { every_minutes: 30 } });
      for (const key of ["version", "commands", "claude", "gates", "signals"]) doc.clear([key]);
      expect(parse(doc.text())).toEqual({});
      expect(doc.text()).toContain("# Chat heading");
    } finally { t.cleanup(); }
  });

  test("on the stamped template, a cleared map's comments, and those on its inner keys, stay, a paragraph apart", () => {
    const template = readFileSync(join(import.meta.dir, "../../templates/config.yaml"), "utf8")
      .replace("__MAIN_BRANCH__", "main").replace("__COMMANDS__", "  test: bun test");
    const { t, doc } = load(template);
    try {
      doc.clear(["gates"]);
      expect(doc.text()).toContain("everything after runs on its own.\n\n# Per-stage model");
      doc.clear(["claude"]);
      for (const line of ["# What a build session may do", "#   max_budget_usd_per_day: what the loop's sessions"]) expect(doc.text()).toContain(line);
      expect(doc.text()).toContain("together in a day\n\n# Gates between stages");
      expect(parse(doc.text()).claude).toBeUndefined();
    } finally { t.cleanup(); }
  });

  test("a placeholder above a map's first key is filled too (a Cargo project's commands)", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "Cargo.toml"), "[package]\nname = \"x\"\n");
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      const doc = ConfigDocument.load(repo.path);
      doc.set(["commands", "install"], "cargo fetch");
      doc.set(["commands", "lint"], "cargo clippy");
      doc.save();
      const after = readFileSync(configPath(repo.path), "utf8");
      expect(after).toContain([
        "commands:",
        "  # Optional: leave a key out if you do not have it.",
        "  install: cargo fetch",
        "  lint: cargo clippy",
        '  build: "cargo build"',
        "  # run:",
        "",
      ].join("\n"));
      expect(after.replace("  install: cargo fetch\n  lint: cargo clippy\n", "  # install:\n  # lint:\n")).toBe(before);
    } finally { repo.cleanup(); }
  });

  test("on the stamped template, a new key takes the place of its commented-out placeholder", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      const doc = ConfigDocument.load(repo.path);
      doc.set(["commands", "build"], "bun run build");
      doc.set(["commands", "lint"], "bun run lint");
      doc.set(["claude", "max_budget_usd"], 9);
      doc.save();
      const after = readFileSync(configPath(repo.path), "utf8");
      expect(after).toContain([
        "commands:",
        "  # Optional: leave a key out if you do not have it.",
        '  install: "bun install"',
        "  lint: bun run lint",
        "  build: bun run build",
        "  # run:",
        "  # The single command that runs your tests and exits non-zero on failure. A chain (a && b) works:",
        "  # sessions may run the whole chain and each part of it.",
        '  test: "bun test"',
        "",
      ].join("\n"));
      // A comment that only mentions a key, with words after it, is not a placeholder.
      expect(after).toContain("  timeout_minutes: 30\n  max_budget_usd: 9\n");
      expect(after).toContain("#   max_budget_usd: what one session may spend");
      // Nothing else moved.
      const without = after.replace("  lint: bun run lint\n  build: bun run build\n", "  # lint:\n  # build:\n").replace("  max_budget_usd: 9\n", "");
      expect(without).toBe(before);
    } finally { repo.cleanup(); }
  });

  test("clear can leave a placeholder where the key was, and a quoted value fills it again", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      const doc = ConfigDocument.load(repo.path);
      expect(doc.hasPlaceholder(["commands", "install"])).toBe(false);
      expect(doc.hasPlaceholder(["commands", "lint"])).toBe(true);
      doc.clear(["commands", "install"], { placeholder: true });
      expect(doc.hasPlaceholder(["commands", "install"])).toBe(true);
      expect(doc.text()).toBe(before.replace('  install: "bun install"\n', "  # install:\n"));
      doc.set(["commands", "install"], "npm ci", { quote: true });
      expect(doc.hasPlaceholder(["commands", "install"])).toBe(false);
      expect(doc.text()).toBe(before.replace('  install: "bun install"\n', '  install: "npm ci"\n'));
    } finally { repo.cleanup(); }
  });

  test("a placeholder after a map's last key is left at its end, and filled there", () => {
    const { t, doc } = load("version: 1\ncommands:\n  test: echo ok\n  install: bun install\nclaude:\n  timeout_minutes: 30\n");
    try {
      doc.clear(["commands", "install"], { placeholder: true });
      expect(doc.hasPlaceholder(["commands", "install"])).toBe(true);
      expect(parse(doc.text()).commands).toEqual({ test: "echo ok" });
      expect(doc.text()).toContain("  test: echo ok\n  # install:\nclaude:");
      doc.set(["commands", "install"], "npm ci", { quote: true });
      expect(doc.text()).toBe('version: 1\ncommands:\n  test: echo ok\n  install: "npm ci"\nclaude:\n  timeout_minutes: 30\n');
    } finally { t.cleanup(); }
  });

  test("one stray CRLF in a file with Unix line endings does not convert it", () => {
    const { t, doc, file } = load(TEXT.replace("version: 1\n", "version: 1\r\n"));
    try {
      doc.set(["claude", "timeout_minutes"], 45);
      doc.save();
      expect((file().match(/\r\n/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(file()).toContain("  timeout_minutes: 45\n");
    } finally { t.cleanup(); }
  });

  test("save writes only when something changed", () => {
    const { t, doc, file } = load();
    try {
      expect(doc.save()).toBe(false);
      expect(file()).toBe(TEXT);
      doc.set(["claude", "timeout_minutes"], 45);
      expect(doc.save()).toBe(true);
      expect(ConfigDocument.load(t.path).get(["claude", "timeout_minutes"])).toBe(45);
    } finally { t.cleanup(); }
  });

  test("save refuses a config that would not load, and writes nothing", () => {
    const { t, doc, file } = load();
    try {
      doc.set(["claude", "timeout_minutes"], -1);
      expect(() => doc.save()).toThrow(ConfigError);
      expect(file()).toBe(TEXT);
    } finally { t.cleanup(); }
  });

  test("a file that is not YAML is refused when loaded", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "loopstra"), { recursive: true });
      writeFileSync(configPath(t.path), "version: [1\n");
      expect(() => ConfigDocument.load(t.path)).toThrow(ConfigError);
    } finally { t.cleanup(); }
  });
});
