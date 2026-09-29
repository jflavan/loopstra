import { effectivePriority, orderQueue, plainStatus, scanIntents } from "../intents";
import { Trace } from "../trace";

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

export async function renderStatus(root: string): Promise<string> {
  const intents = orderQueue(await scanIntents(root));
  if (!intents.length) return "No intents yet. Create intent/<slug>/intent.md, or ask the loopstra skill to draft one.\n";
  const trace = Trace.open(root);
  try {
    const rows = intents.map((i) => {
      const s = trace.intentSummary(i.slug);
      const phase = s?.lastPhase ? `${s.lastPhase} (${s.lastPhaseStatus})` : "-";
      const cost = `$${(s?.costUsd ?? 0).toFixed(2)}`;
      return [i.slug, effectivePriority(i.file.frontmatter), plainStatus(i.file.frontmatter.status), phase, cost, i.file.frontmatter.note];
    });
    const headers = ["Change", "Priority", "Where it is", "Last phase", "Cost", "Note"];
    const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
    const line = (r: string[]) => r.map((v, c) => pad(v, widths[c]!)).join("  ");
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + "\n";
  } finally {
    trace.close();
  }
}
