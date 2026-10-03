import { readFileSync } from "node:fs";
import { isCollection, isScalar, parseDocument, type Document } from "yaml";
import { ConfigError, configPath, validateConfig, type Config } from "../config";
import { writeFileAtomic } from "../fsutil";

/** Where a value is in the config, like ["claude", "max_budget_usd"]. */
export type Path = readonly (string | number)[];

/**
 * loopstra/config.yaml as a YAML document: edits keep its comments and key order. Nothing is written
 * until save(), and save() refuses a config that would not load.
 */
export class ConfigDocument {
  private dirty = false;

  private constructor(private readonly path: string, private readonly doc: Document) {}

  static load(root: string): ConfigDocument {
    const path = configPath(root);
    const doc = parseDocument(readFileSync(path, "utf8"));
    if (doc.errors.length) throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
    return new ConfigDocument(path, doc);
  }

  /** The value at `path` as plain data (maps and lists too), or undefined. */
  get(path: Path): unknown {
    const v = this.doc.getIn(path);
    return isCollection(v) ? v.toJSON() : v;
  }

  set(path: Path, value: unknown): void {
    if (JSON.stringify(this.get(path)) === JSON.stringify(value)) return;
    // A parent written with no value (`chat:` on its own) is an empty map to fill, not a scalar.
    for (let i = 1; i < path.length; i++) {
      const parent = this.doc.getIn(path.slice(0, i), true);
      if (parent === undefined) break;
      if (isScalar(parent) && (parent.value === null || parent.value === undefined)) {
        this.doc.setIn(path.slice(0, i), this.doc.createNode({}));
        break;
      }
    }
    const node = this.doc.getIn(path, true);
    // A scalar is changed in place, so a comment on its line stays with it.
    if (isScalar(node) && (value === null || typeof value !== "object")) node.value = value;
    else this.doc.setIn(path, this.doc.createNode(value));
    this.dirty = true;
  }

  /**
   * Sets a value, except that a key that is not in the file is only added when the value differs
   * from its default: the file says what someone chose, and later default changes still reach it.
   */
  put(path: Path, value: unknown, fallback: unknown): void {
    if (this.get(path) === undefined && JSON.stringify(value) === JSON.stringify(fallback)) return;
    this.set(path, value);
  }

  clear(path: Path): void {
    if (!this.doc.hasIn(path)) return;
    this.doc.deleteIn(path);
    this.dirty = true;
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

  text(): string {
    return String(this.doc);
  }
}
