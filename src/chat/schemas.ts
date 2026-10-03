import { z } from "zod";
import { PRIORITIES } from "../intents";

/** What the orchestrator may hand to the writer: everything agreed, and the drafts it changes. */
export const Handoff = z.object({
  /** For the pull request. */
  title: z.string(),
  /** Everything agreed: problem, outcome, done-when, users, constraints, open questions, split, depends_on, priority. */
  brief: z.string(),
  /** Existing draft intents this changes (slugs); empty for new work only. */
  updates: z.array(z.string()),
});
export type Handoff = z.infer<typeof Handoff>;

/** One orchestrator turn. `handoff` and `accept` are proposals; the runtime asks a person before acting on either. */
export const OrchestratorTurn = z.object({
  reply: z.string(),
  handoff: Handoff.nullable(),
  accept: z.object({ slug: z.string() }).nullable(),
});
export type OrchestratorTurn = z.infer<typeof OrchestratorTurn>;

/** One intent the writer proposes. Section text is Markdown; the runtime adds the headings. */
export const DraftIntent = z.object({
  slug: z.string(),
  title: z.string(),
  priority: z.enum(PRIORITIES).nullable(),
  depends_on: z.array(z.string()),
  problem: z.string(),
  proposed_outcome: z.string(),
  done_when: z.string(),
  affected_users_and_systems: z.string(),
  constraints: z.string(),
  open_questions: z.string(),
});
export type DraftIntent = z.infer<typeof DraftIntent>;

export const WriterResult = z.object({
  status: z.enum(["success", "fail"]),
  /** For the pull request body; when status is fail, why the brief could not be written up. */
  summary: z.string(),
  intents: z.array(DraftIntent),
});
export type WriterResult = z.infer<typeof WriterResult>;
