import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigError, configPath } from "../../src/config";
import { ConfigDocument } from "../../src/setup/document";
import { tempDir } from "../helpers";

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
