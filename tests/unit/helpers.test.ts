import { describe, expect, test } from "bun:test";
import { FAKE_CLAUDE, setupRepo, withEnv } from "../helpers";

describe("setupRepo", () => {
  test("sets the fake claude for the test and puts back what was there on cleanup", async () => {
    await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: "before" }, async () => {
      const { repo, trace } = await setupRepo("draft");
      expect(process.env.LOOPSTRA_CLAUDE_EXECUTABLE).toBe(FAKE_CLAUDE);
      trace.close(); repo.cleanup();
      expect(process.env.LOOPSTRA_CLAUDE_EXECUTABLE).toBe("before");
    });
  });
});
