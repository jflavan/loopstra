import { z } from "zod";

const base = z.object({
  status: z.enum(["success", "fail"]),
  summary: z.string(),
  notes_for_next_phase: z.string(),
});

const finding = z.object({
  severity: z.enum(["important", "nit"]),
  file: z.string(),
  line: z.number().int().nonnegative(),
  finding: z.string(),
});

const requirement = z.object({
  requirement: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});

const codeChange = base.extend({
  changed_files: z.array(z.string()),
  commit_message: z.string(),
});

export const Envelopes = {
  intake: base.extend({
    priority: z.enum(["low", "normal", "high", "urgent"]),
    missing_sections: z.array(z.string()),
    question: z.string(),
  }),
  design: base.extend({
    spec_markdown: z.string(),
    concerns: z.array(z.string()),
  }),
  "spec-check": base.extend({
    approved: z.boolean(),
    findings: z.array(requirement),
  }),
  plan: base.extend({
    plan_markdown: z.string(),
    files: z.array(z.object({ path: z.string(), new: z.boolean() })),
  }),
  "plan-challenge": base.extend({
    approved: z.boolean(),
    concerns: z.array(z.object({ concern: z.string(), blocking: z.boolean() })),
  }),
  build: codeChange,
  fix: codeChange,
  reconcile: base.extend({ plan_markdown: z.string() }),
  verify: base.extend({
    passed: z.boolean(),
    observations: z.array(z.string()),
  }),
  review: base.extend({
    approved: z.boolean(),
    findings: z.array(finding),
    review_markdown: z.string(),
  }),
  revise: codeChange,
  "done-check": base.extend({
    /** One item per Done when criterion. needs-person: it cannot be judged from the repository. */
    evidence: z.array(z.object({ criterion: z.string(), result: z.enum(["met", "unmet", "needs-person"]), evidence: z.string() })),
    outcome_markdown: z.string(),
  }),
  lessons: base.extend({
    lessons: z.array(z.string()),
    claude_md_additions: z.string(),
  }),
} as const;

export type PhaseName = keyof typeof Envelopes;
export type Envelope<N extends PhaseName> = z.infer<(typeof Envelopes)[N]>;

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
  [key: string]: unknown;
}

/** JSON Schema for `--json-schema`, generated from the one Zod definition. */
export function jsonSchemaFor(name: PhaseName): JsonSchemaObject {
  const schema = z.toJSONSchema(Envelopes[name], { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    ...(schema as object),
    type: "object",
    properties: (schema.properties ?? {}) as Record<string, unknown>,
    required: (schema.required ?? []) as string[],
    additionalProperties: false,
  };
}
