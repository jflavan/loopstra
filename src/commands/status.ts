import { loopStatusLine } from "../heartbeat";
import { effectivePriority, orderQueue, plainStatus, scanRepo } from "../intents";
import { Trace } from "../trace";

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

export async function renderStatus(root: string): Promise<string> {
  return (await loopStatusLine(root)) + "\n" + await renderTable(root);
}

async function renderTable(root: string): Promise<string> {
  const scan = await scanRepo(root);
  const intents = orderQueue(scan.intents);
  if (!intents.length && !scan.unreadable.length) return "No intents yet. Create intent/<slug>/intent.md, or ask the loopstra skill to draft one.\n";
  const trace = Trace.open(root);
  try {
    const rows = intents.map((i) => {
      const s = trace.intentSummary(i.slug);
      const phase = s?.lastPhase ? `${s.lastPhase} (${s.lastPhaseStatus})` : "-";
      const cost = `$${(s?.costUsd ?? 0).toFixed(2)}`;
      return [i.slug, effectivePriority(i.file.frontmatter), plainStatus(i.file.frontmatter.status), phase, cost, i.file.frontmatter.note];
    });
    // An intent.md that cannot be read still shows, with what to fix.
    for (const u of scan.unreadable) rows.push([u.slug, "-", plainStatus("blocked"), "-", "-", u.problem]);
    const headers = ["Change", "Priority", "Where it is", "Last phase", "Cost", "Note"];
    const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
    const line = (r: string[]) => r.map((v, c) => pad(v, widths[c]!)).join("  ");
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + "\n";
  } finally {
    trace.close();
  }
}
