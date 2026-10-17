import type { Tab } from "../router";

export function Change({ slug }: { slug: string; tab: Tab }) {
  return <section class="view"><div class="view-head"><h1>{slug}</h1></div></section>;
}
