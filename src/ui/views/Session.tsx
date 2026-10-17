export function Session({ slug, seq }: { slug: string; seq: number }) {
  return <section class="view"><div class="view-head"><h1>{slug} · step {seq}</h1></div></section>;
}
