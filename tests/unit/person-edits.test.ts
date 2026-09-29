import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PersonChangedStatus, setStatus, writeIntentPriority } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runStepGuarded } from "../../src/scheduler";
import { setupRepo } from "../helpers";

const INTENT = "intent/add-numbers/intent.md";

/** A design `before` command that edits intent.md the way a person would while the step runs. */
function editsDuringStep(): string {
  return `stages:\n  design:\n    before:\n      - bun person-edit.ts\n`;
}

async function withPersonScript(repo: string, body: string): Promise<void> {
  await Bun.write(join(repo, "person-edit.ts"), `const p = ${JSON.stringify(INTENT)};\nlet t = await Bun.file(p).text();\n${body}\nawait Bun.write(p, t);\n`);
}

describe("a person's edits to intent.md while a step runs", () => {
  test("a person sets closed mid-step: the step ends quietly, and the file keeps closed and the person's text", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: editsDuringStep() });
    await withPersonScript(repo.path, `t = t.replace(/status: \\S+/, "status: closed") + "\\nA line the person added.\\n";`);
    const r = await runStepGuarded(ctx);
    expect(r).toEqual({ ok: true, personChanged: true });
    const text = await Bun.file(join(repo.path, INTENT)).text();
    expect(text).toContain("status: closed");
    expect(text).toContain("A line the person added.");
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("closed");
    expect(i.file.frontmatter.priority).toBeUndefined();
    const ev = trace.events("add-numbers").filter((e) => e.type === "person-changed-status");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload)).toMatchObject({ from: "designing", to: "closed" });
    expect(trace.events("add-numbers").some((e) => e.type === "status_change" && e.payload.includes("\"to\":\"blocked\""))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a person edits only the body mid-step: the runtime's status change applies and the edit survives", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: editsDuringStep() });
    await withPersonScript(repo.path, `t = t + "\\nA line the person added.\\n";`);
    const r = await runStepGuarded(ctx);
    expect(r.ok).toBe(true);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(i.file.body).toContain("A line the person added.");
    // The person's edit is committed with the runtime's record of the change.
    expect((await new Git(repo.path).run(["show", `main:${INTENT}`])).out).toContain("A line the person added.");
    trace.close(); repo.cleanup();
  });

  test("YAML comments, key order and CRLF line endings survive a status change", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const owner = "---\r\n# Status is managed by Loopstra.\r\nstatus: accepted   # set to accepted when ready\r\nauthor: J. Ortiz\r\nopened: 2026-09-28\r\n---\r\n# Intent: add numbers\r\n\r\n## Problem\r\nNo add.\r\n\r\n## Proposed outcome\r\nAn add function.\r\n\r\n## Done when\r\n- add(1, 2) returns 3.\r\n";
    await Bun.write(join(repo.path, INTENT), owner);
    await ctx.reload();
    await setStatus(ctx, "designing", "Working on it.");
    const text = await Bun.file(join(repo.path, INTENT)).text();
    expect(text).toBe(owner
      .replace("status: accepted   # set", "status: designing   # set")
      .replace("opened: 2026-09-28\r\n", "opened: 2026-09-28\r\nnote: Working on it.\r\nresume_from: accepted\r\n"));
    trace.close(); repo.cleanup();
  });

  test("the priority is written only when nobody stated one, and never over a person's status", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await setStatus(ctx, "designing");
    const path = join(repo.path, INTENT);
    await Bun.write(path, (await Bun.file(path).text()).replace("status: designing", "status: designing\npriority: low"));
    await writeIntentPriority(ctx, "urgent");
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.priority).toBe("low");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: designing", "status: closed").replace("priority: low\n", ""));
    await expect(writeIntentPriority(ctx, "urgent")).rejects.toBeInstanceOf(PersonChangedStatus);
    const fm = (await readIntent(repo.path, "add-numbers")).file.frontmatter;
    expect(fm.status).toBe("closed");
    expect(fm.priority).toBeUndefined();
    trace.close(); repo.cleanup();
  });
});
