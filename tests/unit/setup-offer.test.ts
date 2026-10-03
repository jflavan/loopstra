import { describe, expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { offerSetup } from "../../src/setup/offer";
import type { Section } from "../../src/setup/types";
import { configRepo } from "../setup-helpers";

const CONFIG = "version: 1\nmain_branch: trunk\ncommands:\n  test: echo ok\n";
const WROTE = "commit what init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore)";
const NEXT = `Next: ${WROTE}`;
/** After a walkthrough that saved nothing. */
const AGAIN = `Next: run \`loopstra setup\` again when you are ready (or edit loopstra/config.yaml), ${WROTE}`;

/** Answers one per line on a stream, and what was written. */
function io(...answers: string[]) {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  return { input: Readable.from(answers.map((a) => `${a}\n`)), output, text: () => text };
}

/** Like a terminal: the answers are typed, and the input stays open after them. */
function open(...answers: string[]) {
  const o = io();
  const input = new PassThrough();
  input.write(answers.map((a) => `${a}\n`).join(""));
  return { ...o, input };
}

/** A section that asks for the test command; it notes how many readers the input has while it asks. */
function section(input: Readable, readers: number[]): Section {
  return {
    name: "fake",
    title: "The fake section",
    covers: ["commands"],
    async ask(ctx) {
      readers.push(input.listenerCount("data"));
      ctx.doc.set(["commands", "test"], await ctx.ask.text("Test command", { suggestion: "echo ok" }));
    },
    async check() { return []; },
  };
}

describe("init's offer to walk through the settings", () => {
  test("without a terminal it asks nothing and reads nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io("y");
      await offerSetup(r.root, { input: o.input, output: o.output, interactive: false });
      expect(o.text()).toBe("");
      expect(o.input.listenerCount("data")).toBe(0);
    } finally { r.cleanup(); }
  });

  test("n: setup does not run, and the prompt is closed", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = open("n", "bun test");
      const readers: number[] = [];
      await offerSetup(r.root, { input: o.input, output: o.output, interactive: true, sections: [section(o.input, readers)] });
      expect(o.text()).toContain("Walk through the settings now? [Y/n]: ");
      expect(o.text()).not.toContain("The fake section");
      expect(o.text()).not.toContain(NEXT);
      expect(readers).toEqual([]);
      expect(o.input.listenerCount("data")).toBe(0);
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("y: the answers after it go to setup's questions, through the same reader", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = open("y", "");
      const readers: number[] = [];
      await offerSetup(r.root, { input: o.input, output: o.output, interactive: true, sections: [section(o.input, readers)] });
      expect(o.text()).toContain("The fake section");
      expect(o.text()).toContain("No changes.");
      expect(readers).toEqual([1]);
      expect(o.input.listenerCount("data")).toBe(0);
      expect(o.text()).toContain(`${NEXT} on trunk, then run \`loopstra start\`.`);

      const changed = io("y", "bun test");
      await offerSetup(r.root, { input: changed.input, output: changed.output, interactive: true, sections: [section(changed.input, [])] });
      expect(changed.text()).toContain("Saved loopstra/config.yaml.");
      expect(r.text()).toContain("test: bun test");
    } finally { r.cleanup(); }
  });

  test("y, then the input ends: setup stops, and the offer still resolves", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io("y");
      await offerSetup(r.root, { input: o.input, output: o.output, interactive: true, sections: [section(o.input, [])] });
      expect(o.text()).toContain("Setup stopped; nothing was saved.");
      expect(o.text()).toContain(`${AGAIN} on trunk, then run \`loopstra start\`.`);
      expect(o.text()).not.toContain(NEXT);
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("the input ends at the offer: setup does not run", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      await offerSetup(r.root, { input: o.input, output: o.output, interactive: true, sections: [section(o.input, [])] });
      expect(o.text()).not.toContain("The fake section");
    } finally { r.cleanup(); }
  });

  test("a config that does not load: setup again, and the last line names no branch", async () => {
    const bad = "version: 1\ncommands:\n  test: echo ok\nclaude:\n  timeout_minutes: -1\n";
    const r = configRepo(bad);
    try {
      const o = io("y");
      await offerSetup(r.root, { input: o.input, output: o.output, interactive: true, sections: [section(o.input, [])] });
      expect(o.text()).toContain(`${AGAIN}, then run \`loopstra start\`.`);
    } finally { r.cleanup(); }
  });
});
