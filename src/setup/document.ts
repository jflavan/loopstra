import { readFileSync } from "node:fs";
import { isCollection, isMap, isNode, isPair, isScalar, isSeq, parseDocument, Scalar, type Document, type Node } from "yaml";
import { ConfigError, configPath, validateConfig, type Config } from "../config";
import { writeFileAtomic } from "../fsutil";

/** Where a value is in the config, like ["claude", "max_budget_usd"]. */
export type Path = readonly (string | number)[];

/** Comment texts joined into one, skipping the empty ones; undefined when there are none. */
function joined(...comments: (string | null | undefined)[]): string | undefined {
  const kept = comments.filter((c): c is string => !!c);
  return kept.length ? kept.join("\n") : undefined;
}

/** Matches the line `# <key>:` with nothing after it, as the YAML library keeps it (without the #). */
function placeholderLine(key: string): RegExp {
  return new RegExp(`^ ?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);
}

/** The comments inside a node, other than inline ones on values: above keys and items, and at the end of maps and lists. */
function notesIn(node: unknown): (string | null | undefined)[] {
  if (isPair(node)) return [isScalar(node.key) ? node.key.commentBefore : undefined, ...notesIn(node.value)];
  if (isCollection(node)) return [node.commentBefore, ...node.items.flatMap((item) => notesIn(item)), node.comment];
  return isNode(node) ? [node.commentBefore] : [];
}

/**
 * loopstra/config.yaml as a YAML document: edits keep its comments, key order, and line endings.
 * Nothing is written until save(), and save() refuses a config that would not load.
 */
export class ConfigDocument {
  private dirty = false;

  private constructor(private readonly path: string, private readonly doc: Document, private readonly crlf: boolean) {}

  static load(root: string): ConfigDocument {
    const path = configPath(root);
    const text = readFileSync(path, "utf8");
    const doc = parseDocument(text);
    if (doc.errors.length) throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
    // Windows line endings only when most lines have them, so one stray CRLF does not convert the file.
    const crlf = (text.match(/\r\n/g)?.length ?? 0) * 2 > (text.match(/\n/g)?.length ?? 0);
    return new ConfigDocument(path, doc, crlf);
  }

  /** The value at `path` as plain data (maps and lists too), or undefined. */
  get(path: Path): unknown {
    const v = this.doc.getIn(path);
    return isCollection(v) ? v.toJSON() : v;
  }

  /**
   * Sets a value. `quote` writes a string in double quotes, the way init writes commands; `flow`
   * writes a list or map on one line (`[ a, b ]`).
   */
  set(path: Path, value: unknown, o: { quote?: boolean; flow?: boolean } = {}): void {
    if (JSON.stringify(this.get(path)) === JSON.stringify(value)) return;
    // A parent that is not a map to write into (`chat:` on its own, `gates: none`, `gates: []`)
    // becomes an empty one, keeping its comments; validation still decides what is valid.
    for (let i = 1; i < path.length; i++) {
      const parent = this.doc.getIn(path.slice(0, i), true) as Node | undefined;
      if (parent === undefined) break;
      if (isMap(parent) || (isSeq(parent) && typeof path[i] === "number")) continue;
      const map = this.doc.createNode({});
      map.commentBefore = joined(parent?.commentBefore, parent?.comment);
      this.doc.setIn(path.slice(0, i), map);
      break;
    }
    const node = this.doc.getIn(path, true);
    const quoted = <N>(n: N): N => { if (o.quote && isScalar(n) && typeof n.value === "string") n.type = Scalar.QUOTE_DOUBLE; return n; };
    // A scalar is changed in place, so a comment on its line stays with it.
    if (isScalar(node) && (value === null || typeof value !== "object")) quoted(node).value = value;
    else {
      const created = quoted(this.doc.createNode(value, { flow: !!o.flow }));
      if (node !== undefined || !this.fillPlaceholder(path, created)) this.doc.setIn(path, created);
    }
    this.dirty = true;
  }

  /** Whether the map holding `path` has the key commented out with nothing after it (`# lint:`). */
  hasPlaceholder(path: Path): boolean {
    const key = path[path.length - 1];
    const parent = path.length > 1 ? this.doc.getIn(path.slice(0, -1), true) : this.doc.contents;
    if (typeof key !== "string" || !isMap(parent)) return false;
    const line = placeholderLine(key);
    const comments = [parent.commentBefore, ...parent.items.map((p) => (isScalar(p.key) ? p.key.commentBefore : undefined)), parent.comment];
    return comments.some((c) => (c ?? "").split("\n").some((l) => line.test(l)));
  }

  /**
   * Adds a new key where its map has it commented out with nothing after it (the template's
   * `# lint:`): the placeholder line goes, the comments above it go with the new key (or stay above
   * the map, for one above its first key), and those below stay with the key they were on. One at
   * the end of a map (where clear leaves it after the last key) puts the key last. False when there
   * is no such line.
   */
  private fillPlaceholder(path: Path, value: Node): boolean {
    const key = path[path.length - 1];
    const parent = path.length > 1 ? this.doc.getIn(path.slice(0, -1), true) : this.doc.contents;
    if (typeof key !== "string" || !isMap(parent)) return false;
    const placeholder = placeholderLine(key);
    /** The comment's lines above and below the placeholder, or null when it has none. */
    const split = (comment: string | null | undefined) => {
      const lines = (comment ?? "").split("\n");
      const at = lines.findIndex((l) => placeholder.test(l));
      return at < 0 ? null : { above: lines.slice(0, at).join("\n") || undefined, below: lines.slice(at + 1).join("\n") || undefined };
    };
    const pair = this.doc.createPair(key, value);
    const added = pair.key as Scalar;
    // Comments above a map's first key belong to the map.
    const top = split(parent.commentBefore);
    if (top && parent.items.length) {
      const first = parent.items[0]!;
      if (!isScalar(first.key)) first.key = new Scalar(first.key);
      const firstKey = first.key as Scalar;
      parent.commentBefore = top.above;
      firstKey.commentBefore = joined(top.below, firstKey.commentBefore);
      parent.items.unshift(pair);
      return true;
    }
    for (let i = 0; i < parent.items.length; i++) {
      const after = parent.items[i]!.key;
      if (!isScalar(after)) continue;
      const hit = split(after.commentBefore);
      if (!hit) continue;
      added.commentBefore = hit.above;
      if (after.spaceBefore) { added.spaceBefore = true; after.spaceBefore = false; }
      after.commentBefore = hit.below;
      parent.items.splice(i, 0, pair);
      return true;
    }
    const end = split(parent.comment);
    if (!end) return false;
    added.commentBefore = end.above;
    parent.comment = end.below;
    parent.items.push(pair);
    return true;
  }

  /**
   * Sets a value, except that a key that is not in the file is only added when the value differs
   * from its default: the file says what someone chose, and later default changes still reach it.
   * Under a parent that is not a map (`gates: none`), the value is written anyway, so the parent
   * becomes a map that loads.
   */
  put(path: Path, value: unknown, fallback: unknown): void {
    const same = this.get(path) === undefined && JSON.stringify(value) === JSON.stringify(fallback);
    if (same && !this.underNonMap(path)) return;
    this.set(path, value);
  }

  /** Whether a parent on the path is there but is not a map (a word, an empty value, a list). */
  private underNonMap(path: Path): boolean {
    for (let i = 1; i < path.length; i++) {
      const parent = this.doc.getIn(path.slice(0, i), true);
      if (parent === undefined) return false;
      if (!isMap(parent) && !(isSeq(parent) && typeof path[i] === "number")) return true;
    }
    return false;
  }

  /**
   * Removes a key, and any map that leaves empty above it (never the whole document). With
   * `placeholder`, the key's line becomes `# <key>:`: it says the key was left out on purpose, and a
   * later set fills it again.
   */
  clear(path: Path, o: { placeholder?: boolean } = {}): void {
    if (!path.length || !this.doc.hasIn(path)) return;
    let at = path;
    for (let first = true; ; first = false) {
      this.remove(at, first && !!o.placeholder);
      at = at.slice(0, -1);
      const parent = at.length ? this.doc.getIn(at, true) : undefined;
      if (!isMap(parent) || parent.items.length) break;
    }
    this.dirty = true;
  }

  /**
   * Deletes one key. Comments above it, or anywhere inside what it held, move to the next key (or the
   * end of its map), followed by `# <key>:` with `placeholder`.
   */
  private remove(path: Path, placeholder = false): void {
    const parentPath = path.slice(0, -1);
    const parent = parentPath.length ? this.doc.getIn(parentPath, true) : this.doc.contents;
    const key = path[path.length - 1];
    const i = isMap(parent) ? parent.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === key) : -1;
    if (!isMap(parent) || i < 0) { this.doc.deleteIn(path); return; }
    const pair = parent.items[i]!;
    const keyNode = isScalar(pair.key) ? pair.key : undefined;
    const notes = joined(...notesIn(pair), placeholder ? ` ${String(key)}:` : undefined);
    const next = parent.items[i + 1];
    if (notes && next) {
      if (!isScalar(next.key)) next.key = new Scalar(next.key);
      const nextKey = next.key as Scalar;
      // An empty line keeps two comment paragraphs apart; a placeholder stands in the key's line, so none is added.
      nextKey.commentBefore = nextKey.commentBefore ? `${notes}\n${placeholder ? "" : "\n"}${nextKey.commentBefore}` : notes;
      if (keyNode?.spaceBefore) nextKey.spaceBefore = true;
    } else if (notes) {
      // A leading empty line keeps the blank line that was above the key.
      parent.comment = joined(parent.comment, keyNode?.spaceBefore ? `\n${notes}` : notes);
    }
    parent.items.splice(i, 1);
  }

  /** The config these edits make, checked the way loading checks it. Throws ConfigError. */
  validate(): Config {
    return validateConfig(this.doc.toJS() ?? {});
  }

  /** Writes the file when anything changed (true), after validating. Throws ConfigError, writing nothing. */
  save(): boolean {
    this.validate();
    if (!this.dirty) return false;
    writeFileAtomic(this.path, this.text());
    return true;
  }

  /** The file as it would be written, with the line endings it was read with. */
  text(): string {
    const text = String(this.doc);
    return this.crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  }
}
