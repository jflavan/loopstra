import { attention, type AttentionItem } from "../attention";
import { loadConfig, type Config } from "../config";
import { loopStatusLine } from "../heartbeat";
import { effectivePriority, orderQueue, plainStatus, scanRepo } from "../intents";
import { Trace } from "../trace";

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

/** A note is never squeezed narrower than this; on a very narrow terminal the lines run long. */
const MIN_NOTE_WIDTH = 24;

/**
 * The loop line, what needs a person, then every change. Nothing is padded past its text, and long
 * text wraps to `width` (the terminal's, else 100).
 */
export async function renderStatus(root: string, width = process.stdout.columns || 100): Promise<string> {
  let config: Config | { problem: string };
  try { config = await loadConfig(root); } catch (e) { config = { problem: e instanceof Error ? e.message : String(e) }; }
  const trace = Trace.open(root);
  try {
    const items = await attention(root, config, trace);
    return `${await loopStatusLine(root)}\n${attentionBlock(items, width)}\n${await renderTable(root, trace, width)}`;
  } finally {
    trace.close();
  }
}

/** "Needs attention:" and one wrapped line per item, or a line saying nothing does. */
function attentionBlock(items: AttentionItem[], width: number): string {
  if (!items.length) return "Nothing needs you right now.\n";
  const lines = items.flatMap((a) => {
    const [first = "", ...rest] = wrap(`${a.label}${a.slug ? ` (${a.slug})` : ""}: ${a.what}`, Math.max(MIN_NOTE_WIDTH, width - 2));
    return [`- ${first}`, ...rest.map((l) => `  ${l}`)];
  });
  return ["Needs attention:", ...lines].join("\n") + "\n";
}

async function renderTable(root: string, trace: Trace, width: number): Promise<string> {
  const scan = await scanRepo(root);
  const intents = orderQueue(scan.intents);
  if (!intents.length && !scan.unreadable.length) return "No intents yet. Create intent/<slug>/intent.md, or ask the loopstra skill to draft one.\n";
  const rows = intents.map((i) => {
    const s = trace.intentSummary(i.slug);
    const phase = s?.lastPhase ? `${s.lastPhase} (${s.lastPhaseStatus})` : "-";
    const cost = `$${(s?.costUsd ?? 0).toFixed(2)}`;
    return [i.slug, effectivePriority(i.file.frontmatter), plainStatus(i.file.frontmatter.status), phase, cost, i.file.frontmatter.note];
  });
  // An intent.md that cannot be read still shows, with what to fix.
  for (const u of scan.unreadable) rows.push([u.slug, "-", plainStatus("blocked"), "-", "-", u.problem]);
  const headers = ["Change", "Priority", "Where it is", "Last phase", "Cost", "Note"];
  const last = headers.length - 1;
  // Every column but the note is padded to its widest cell; the note is never padded, and wraps.
  const widths = headers.slice(0, last).map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const indent = widths.reduce((n, w) => n + w + 2, 0);
  const noteWidth = Math.max(MIN_NOTE_WIDTH, width - indent);
  const line = (r: string[]) => {
    const head = r.slice(0, last).map((v, c) => pad(v, widths[c]!)).join("  ");
    const [first = "", ...more] = wrap((r[last] ?? "").replace(/\s*\r?\n\s*/g, " "), noteWidth);
    return [`${head}  ${first}`.trimEnd(), ...more.map((m) => `${" ".repeat(indent)}${m}`)].join("\n");
  };
  return [line(headers), line([...widths.map((w) => "-".repeat(w)), "----"]), ...rows.map(line)].join("\n") + "\n";
}

/** Splits text into lines of at most `width` characters at spaces; a longer word is cut. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let lineText = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w; ) {
      const piece = w.slice(0, width);
      w = w.slice(piece.length);
      if (!lineText) lineText = piece;
      else if (lineText.length + 1 + piece.length <= width) lineText += ` ${piece}`;
      else { out.push(lineText); lineText = piece; }
    }
  }
  if (lineText || !out.length) out.push(lineText);
  return out;
}
