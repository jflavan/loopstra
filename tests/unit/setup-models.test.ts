import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { configPath } from "../../src/config";
import { init } from "../../src/init";
import { models } from "../../src/setup/sections/models";
import { tempGitRepo } from "../helpers";
import { askSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

describe("the models section", () => {
  test("names the three models and picks one for each stage and chat", async () => {
    const r = configRepo(BASE);
    try {
      // default, cheap, strong; design, plan, build, review, verify; chat.
      const { text } = await askSection(models, r.root, ["", "", "claude-opus-5-5", "", "", "strong", "", "", "cheap"]);
      const yaml = parse(text);
      expect(yaml.claude).toEqual({ models: { strong: "claude-opus-5-5" } });
      expect(yaml.stages).toEqual({ build: { model: "strong" } });
      expect(yaml.chat).toEqual({ model: "cheap" });
    } finally { r.cleanup(); }
  });

  test("--defaults adds nothing", async () => {
    const r = configRepo(BASE);
    try {
      expect((await askSection(models, r.root, "defaults")).text).toBe(BASE);
    } finally { r.cleanup(); }
  });

  test("in the config init writes, a change edits its one place", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/package.json`, JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      expect((await askSection(models, repo.path, "defaults")).text).toBe(before);
      const { text } = await askSection(models, repo.path, ["", "", "", "", "", "strong", "", "", ""]);
      expect(text).toBe(before.replace("build: { model: default,", "build: { model: strong,"));
    } finally { repo.cleanup(); }
  });
});
