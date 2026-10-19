type DiffRow = { kind: "file" | "hunk" | "add" | "del" | "ctx" | "meta"; text: string };

/**
 * Unified diff text as rows: git's (`diff --git`, its header, hunks) or an edit's from a transcript
 * (`--- path`, `+++ path`, hunks). A `---` line counts as a header only when a `+++` line follows it.
 */
export function parseDiff(text: string): DiffRow[] {
  const lines = text.split(/\r?\n/);
  const rows: DiffRow[] = [];
  let header = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (line.startsWith("diff --git ")) {
      rows.push({ kind: "file", text: line.replace(/^diff --git a\/.+? b\//, "") });
      header = true;
    } else if (line.startsWith("--- ") && lines[k + 1]?.startsWith("+++ ")) {
      if (!header) rows.push({ kind: "file", text: line.slice(4).replace(/^a\//, "") });
      k++;
    } else if (header && !line.startsWith("@@")) {
      // A rename, a new or deleted file, a mode change and a binary file say so: a file changed only
      // that way has no hunks, so its header is all there is to show. The index line is left out.
      if (/^(Binary files|rename (from|to) |new file mode |deleted file mode |old mode |new mode )/.test(line)) rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("@@")) {
      rows.push({ kind: "hunk", text: line });
      header = false;
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", text: line.slice(1) });
    else if (line) rows.push({ kind: "meta", text: line });
  }
  return rows;
}

/** How many lines a diff adds and removes. */
export function diffCounts(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of parseDiff(text)) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}
