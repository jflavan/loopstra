import { pillText, usd } from "../format";
import { inbox, loop, openDrawer, paletteOpen, totals } from "../store";
import { cycleTheme, theme } from "../theme";
import { Icon } from "./Icon";
import { Link } from "./Link";

export function TopBar() {
  const l = loop.value;
  const t = totals.value;
  const n = inbox.value?.length ?? 0;
  return (
    <header class="topbar">
      <Link href="/" class="brand"><Icon name="logo" class="logo" /><span class="hide-narrow">Loopstra</span></Link>
      <span class={`pill ${l?.state ?? ""}`} title={l?.text ?? "Connecting to the console…"}>
        <span class="dot" aria-hidden="true" />
        {l ? pillText(l) : "Connecting…"}
      </span>
      <span class="grow" />
      {t && <span class="muted hide-narrow" title="Spent today, chat included">{usd(t.todayUsd)} today</span>}
      <button class="ghost" onClick={() => { paletteOpen.value = true; }} title="Search and commands (Ctrl K)">
        <Icon name="search" /><span class="hide-narrow">Search</span><kbd class="hide-narrow">Ctrl K</kbd>
      </button>
      <button class="ghost" onClick={() => openDrawer()} title="Ask the orchestrator (Ctrl J)"><Icon name="ask" /><span class="hide-narrow">Ask</span></button>
      <Link href="/inbox" class="ghost" title={n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}>
        <Icon name="bell" />{n > 0 && <span class="count">{n}</span>}
      </Link>
      <button class="ghost" onClick={cycleTheme} title={`Theme: ${theme.value}. Click to change.`} aria-label="Change the theme"><Icon name="theme" /></button>
    </header>
  );
}
