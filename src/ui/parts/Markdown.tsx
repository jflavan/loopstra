import { useMemo } from "preact/hooks";
import { renderMarkdown } from "../markdown";

/** Markdown drawn safely: renderMarkdown never passes raw HTML through, so its output can be set as HTML. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
