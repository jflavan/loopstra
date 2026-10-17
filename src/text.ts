/** Items as a plain list: "a", "a and b", "a, b and c" ("" for none). */
export function andList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}
