import { Marked } from "marked";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Links go to the web or stay relative; anything else (javascript:, data:, file:) is shown as its text.
 * An address with spaces or control characters is refused first: marked passes `<java\tscript:…>` on
 * unchanged, and browsers drop those characters, which would turn it back into a live script link.
 * One starting with two slashes (`//evil.example`) is refused too: it reads as relative but leaves
 * for another host. So is any with a backslash, which browsers read as a slash in a web address:
 * `/\evil.example` and `\\evil.example` leave for another host the same way.
 */
function safeHref(href: string): boolean {
  if (/[\u0000- \u007f-\u009f\\]/.test(href) || href.startsWith("//")) return false;
  return /^https?:\/\//i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * Markdown from documents, notes and agents is untrusted: raw HTML is shown as text, images as
 * their alt text (nothing is fetched), and only safe links are links, opening in a new tab.
 */
const md = new Marked({ gfm: true, async: false });
md.use({
  renderer: {
    html(token) { return escapeHtml(token.text); },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      return safeHref(token.href) ? `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token) { return escapeHtml(token.text || token.href); },
  },
});

export function renderMarkdown(text: string): string {
  return md.parse(text) as string;
}

/**
 * intent.md without its status block, which the page shows on its own. The block is the one the
 * parser reads, by the same rule (closingFence in src/intents.ts, which the page cannot import: that
 * module reads the disk): a byte order mark dropped, `---` alone on the first line, and the first
 * later line that is `---` with nothing but spaces after it, so an empty block (`---` then `---`)
 * goes too. A line of more dashes (`----`) or an indented `---` closes nothing, and text without a
 * block is shown whole. tests/unit/ui-logic.test.ts checks that the two agree.
 */
export function stripFrontmatter(text: string): string {
  const t = text.replace(/^\uFEFF/, "");
  const parts = t.split(/(?<=\n)/);
  if (!/^---\r?\n$/.test(parts[0] ?? "")) return t;
  const close = parts.findIndex((p, i) => i > 0 && p.replace(/\r?\n$/, "").trimEnd() === "---");
  return close < 0 ? t : parts.slice(close + 1).join("");
}
