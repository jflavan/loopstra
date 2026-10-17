import { useEffect, useRef, useState } from "preact/hooks";
import { notificationsOn, setNotifications } from "../alerts";
import { navigate } from "../nav";
import { filterCommands, type Command } from "../palette";
import { changes, openDrawer, paletteOpen, running, toast } from "../store";
import { cycleTheme } from "../theme";

/** Everything the palette can do: go to a screen, watch an agent, open a change, and a few settings. */
function commands(): Command[] {
  const list: Command[] = [
    { id: "live", title: "Go to Live", hint: "g l", run: () => navigate("/") },
    { id: "inbox", title: "Go to Inbox", hint: "g i", run: () => navigate("/inbox") },
    { id: "changes", title: "Go to Changes", hint: "g c", run: () => navigate("/changes") },
    { id: "activity", title: "Go to Activity", hint: "g a", run: () => navigate("/activity") },
    { id: "spend", title: "Go to Spend", hint: "g s", run: () => navigate("/spend") },
    { id: "ask", title: "Ask the orchestrator", hint: "Ctrl J", run: () => openDrawer() },
    { id: "theme", title: "Change the theme", run: cycleTheme },
    {
      id: "notify",
      title: notificationsOn() ? "Turn off notifications" : "Turn on notifications",
      run: () => void setNotifications(!notificationsOn()).then((on) =>
        toast(on ? "You will be told when something needs you while this tab is in the background." : "Notifications are off.")),
    },
  ];
  for (const p of running.value?.now ?? []) list.push({ id: `s:${p.slug}:${p.seq}`, title: `Watch ${p.title}: ${p.name}`, hint: "running", run: () => navigate(`/s/${p.slug}/${p.seq}`) });
  for (const c of changes.value ?? []) list.push({ id: `c:${c.slug}`, title: `Open ${c.title}`, hint: c.plain, run: () => navigate(`/c/${c.slug}`) });
  return list;
}

export function Palette() {
  return paletteOpen.value ? <PaletteBox /> : null;
}

function PaletteBox() {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const items = filterCommands(commands(), query);
  const close = () => { paletteOpen.value = false; };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  return (
    <div class="overlay" onClick={close}>
      <div class="palette" role="dialog" aria-label="Search and commands" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          value={query}
          placeholder="Open a change, watch an agent, or run a command…"
          aria-label="Search"
          onInput={(e) => { setQuery(e.currentTarget.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(Math.min(at + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(at - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(items[at]); }
          }}
        />
        <ul role="listbox">
          {items.map((c, k) => (
            <li key={c.id} role="option" aria-selected={k === at} class={k === at ? "on" : ""} onMouseEnter={() => setAt(k)} onClick={() => run(c)}>
              <span>{c.title}</span>
              {c.hint && <span class="muted">{c.hint}</span>}
            </li>
          ))}
          {!items.length && <li class="muted">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
