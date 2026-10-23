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
  test("names the four models and picks one for each stage and chat", async () => {
    const r = configRepo(BASE);
    try {
      // cheap, default, strong, max; then design, plan, build, review, verify each with its steps question; then chat the same.
      const { text } = await askSection(models, r.root, ["", "", "claude-opus-5-5", "", "", "", "", "", "strong", "", "", "", "", "", "cheap", ""]);
      const yaml = parse(text);
      expect(yaml.claude).toEqual({ models: { strong: "claude-opus-5-5" } });
      expect(yaml.stages).toEqual({ build: { model: "strong" } });
      expect(yaml.chat).toEqual({ model: "cheap" });
    } finally { r.cleanup(); }
  });

  test("steps one by one", async () => {
    const r = configRepo(BASE);
    try {
      // The four names and four stages' two questions each take twelve blanks; then verify's model, yes, its three steps, then chat.
      const blank = (n: number) => Array<string>(n).fill("");
      const { text, shown } = await askSection(models, r.root, [...blank(12), "", "y", "auto", "max", "auto", "", ""]);
      expect(shown).toContain("Model for done-check (judges whether the change did what it said; auto = strong)");
      expect(shown).toContain("Model for verify (runs and reads the checks; auto = follows verify)");
      expect(parse(text).stages).toEqual({ verify: { steps: { "done-check": "max" } } });
    } finally { r.cleanup(); }
  });

  test("run again, it suggests what the config says", async () => {
    const r = configRepo(`${BASE}stages:\n  verify:\n    steps:\n      done-check: max\n`);
    try {
      expect((await askSection(models, r.root, "defaults")).text).toBe(`${BASE}stages:\n  verify:\n    steps:\n      done-check: max\n`);
    } finally { r.cleanup(); }
  });

  test("auto removes a step's own setting", async () => {
    const r = configRepo(`${BASE}stages:\n  verify:\n    steps:\n      done-check: max\n`);
    try {
      const { text } = await askSection(models, r.root, ["", "", "", "", "", "", "", "", "", "", "", "", "", "y", "auto", "auto", "auto", "", ""]);
      expect(parse(text).stages?.verify?.steps).toBeUndefined();
    } finally { r.cleanup(); }
  });

  test("--defaults never picks max", async () => {
    const r = configRepo(BASE);
    try {
      const { text } = await askSection(models, r.root, "defaults");
      expect(text).not.toContain("max");
      expect(text).toBe(BASE);
    } finally { r.cleanup(); }
  });

  test("a model name has no spaces", async () => {
    const r = configRepo(BASE);
    try {
      const { text, shown } = await askSection(models, r.root, ["claude sonnet", "claude-sonnet-5", ...Array<string>(15).fill("")]);
      expect(shown).toContain("A model name has no spaces, like sonnet or claude-opus-5-5.");
      expect(parse(text).claude).toEqual({ models: { cheap: "claude-sonnet-5" } });
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
      const { text } = await askSection(models, repo.path, ["", "", "", "", "", "", "", "", "strong", "", "", "", "", "", "", ""]);
      expect(text).toBe(before.replace("build: { model: default,", "build: { model: strong,"));
    } finally { repo.cleanup(); }
  });
});
