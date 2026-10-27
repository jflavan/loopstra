
/**
 * What every route of the console shares: its answers, the checks a write goes through, and the
 * small readings of a path. Data is read fresh every time, so every answer says `no-store`: a
 * document or a change read again, or a request's result, must not come from the browser's cache.
 */
export const NO_STORE = { "cache-control": "no-store" };

/** A JSON answer. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** A refusal in plain words, `{ error }`; 409 (the change is not as the page showed it) unless said otherwise. */
export function refuse(error: string, status = 409): Response {
  return json({ error }, status);
}

/** A plain-text answer, which the browser must not read as anything else. */
export function plain(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...NO_STORE } });
}

/** A path part as text; one that cannot be decoded is "", which names no change, request or file. */
export function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return ""; }
}

/** True when a write comes from the page itself: its Origin is the console's own. */
export function fromPage(req: Request, url: URL): boolean {
  return req.headers.get("origin") === url.origin;
}

/** True when a content type's MIME essence (before any parameters) is JSON. */
function isJson(ct: string | null): boolean {
  return ((ct ?? "").split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

/**
 * True when a read that has a side effect may go ahead: the browser says the request comes from the
 * console's own page (or from nowhere, as the address bar). An `<img src>` or a link on another site
 * is refused even though it carries no Origin. A request that says nothing of its site (an older
 * browser, or a client on this machine) must show it comes from the page some other way: an Origin
 * that is the console's own, as a write does, or a Referer on the console (the page's fetch of a
 * result asks for one, see src/ui/requests.ts).
 */
export function ownSite(req: Request, url: URL): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  return fromPage(req, url) || refererOrigin(req.headers.get("referer")) === url.origin;
}

/** The origin a Referer names, or null when there is none or it is not an address. */
function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

/**
 * The checks every JSON write goes through, in this order, then `handle` with the body as an object:
 * the method (405, before anything else: a GET of a write's path is not a write that lacks an
 * Origin), the page's own Origin (403), a JSON content type (415), a body that is JSON (400) and an
 * object (400).
 */
export async function jsonWrite(req: Request, url: URL, handle: (body: Record<string, unknown>) => Response | Promise<Response>): Promise<Response> {
  if (req.method !== "POST") return plain("Method not allowed", 405);
  if (!fromPage(req, url)) return plain("Forbidden", 403);
  if (!isJson(req.headers.get("content-type"))) return plain("Expected JSON", 415);
  let body: unknown;
  try { body = await req.json(); } catch { return refuse("The request was not JSON.", 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse("The request was not an object.", 400);
  return handle(body as Record<string, unknown>);
}
