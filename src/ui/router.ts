import { ANY_SLUG } from "../console/types";

export type Tab = "overview" | "documents" | "timeline" | "code" | "gates";
export const TABS: readonly Tab[] = ["overview", "documents", "timeline", "code", "gates"];

export type Route =
  | { name: "live" } | { name: "inbox" } | { name: "changes" } | { name: "activity" } | { name: "agents" } | { name: "spend" } | { name: "settings" } | { name: "exceptions" }
  | { name: "change"; slug: string; tab: Tab }
  | { name: "session"; slug: string; seq: number }
  | { name: "missing"; path: string };

function decode(part: string): string | null {
  try { return decodeURIComponent(part); } catch { return null; }
}

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean).map(decode);
  const missing: Route = { name: "missing", path };
  if (parts.some((p) => p === null)) return missing;
  const [a, b, c] = parts as string[];
  if (!a) return { name: "live" };
  if (parts.length === 1 && (a === "inbox" || a === "changes" || a === "activity" || a === "agents" || a === "spend" || a === "settings")) return { name: a };
  if (a === "settings" && b === "exceptions" && parts.length === 2) return { name: "exceptions" };
  if (a === "c" && b && ANY_SLUG.test(b) && !b.startsWith("_") && parts.length <= 3) {
    if (!c) return { name: "change", slug: b, tab: "overview" };
    if ((TABS as readonly string[]).includes(c)) return { name: "change", slug: b, tab: c as Tab };
  }
  if (a === "s" && b && ANY_SLUG.test(b) && c && /^\d+$/.test(c) && parts.length === 3) return { name: "session", slug: b, seq: Number(c) };
  return missing;
}

/**
 * Whether `path` is another address than the one the page is at: its path, its query ("/c/x?tab=y")
 * and its part after # ("/agents#csv:3") all count. A link to where the page already is adds
 * nothing to the history, so pressing Watch twice leaves one entry, not two.
 */
export function changesAddress(here: { pathname: string; search: string; hash: string }, path: string): boolean {
  return path !== here.pathname + here.search + here.hash;
}

export function routePath(r: Route): string {
  switch (r.name) {
    case "live": return "/";
    case "change": return r.tab === "overview" ? `/c/${r.slug}` : `/c/${r.slug}/${r.tab}`;
    case "session": return `/s/${r.slug}/${r.seq}`;
    case "exceptions": return "/settings/exceptions";
    case "missing": return r.path;
    default: return `/${r.name}`;
  }
}
