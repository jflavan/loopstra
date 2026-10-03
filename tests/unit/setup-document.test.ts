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
