import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { configPath, NOT_SET_UP } from "../../src/config";
import { NEEDS_TERMINAL, setup } from "../../src/setup";
import { tempDir } from "../helpers";
import { configRepo } from "../setup-helpers";

function io(...answers: string[]) {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  return { input: Readable.from(answers.map((a) => `${a}\n`)), output, text: () => text };
}

const CONFIG = "version: 1\ncommands:\n  test: echo ok\n";

describe("loopstra setup", () => {
  test("outside a set-up folder, it says so", async () => {
    const t = tempDir();
    try {
      const o = io();
      expect(await setup(t.path, { output: o.output, defaults: true })).toBe(1);
      expect(o.text()).toContain(NOT_SET_UP);
    } finally { t.cleanup(); }
  });

  test("without a terminal and without --defaults or --check, it refuses and writes nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, interactive: false })).toBe(1);
      expect(o.text()).toContain(NEEDS_TERMINAL);
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("an unknown section is named, with the ones there are", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, section: "nope", defaults: true })).toBe(1);
      expect(o.text()).toContain("There is no setup section called nope.");
    } finally { r.cleanup(); }
  });

  test("--check with a config that does not load reports why and fails", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\nclaude:\n  timeout_minutes: -1\n");
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, check: true })).toBe(1);
      expect(o.text()).toContain("claude.timeout_minutes");
    } finally { r.cleanup(); }
  });

  test("input that runs out saves nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const code = await setup(r.root, { input: o.input, output: o.output, interactive: true });
      // With no sections yet this saves nothing either way; with sections, the first question ends it.
      expect([0, 1]).toContain(code);
      expect(readFileSync(configPath(r.root), "utf8")).toBe(CONFIG);
    } finally { r.cleanup(); }
  });
});
