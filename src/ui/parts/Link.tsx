import type { ComponentChildren } from "preact";
import { navigate } from "../nav";

/** A link inside the console: a plain click changes screen without reloading; a modified click opens a tab as usual. */
export function Link(props: { href: string; class?: string; title?: string; current?: boolean; children?: ComponentChildren }) {
  return (
    <a
      href={props.href}
      class={props.class}
      title={props.title}
      aria-current={props.current ? "page" : undefined}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
