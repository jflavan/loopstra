import { useEffect, useRef, useState } from "preact/hooks";
import { notificationsOn, setNotifications } from "../alerts";
import { enterPressed, keyLabel, onMac } from "../keys";
import { navigate } from "../nav";
import { clampAt, filterCommands, type Command } from "../palette";
import { setLoopHeld } from "../requests";
import { changes, loop, openDrawer, paletteOpen, running, toast } from "../store";
import { cycleTheme } from "../theme";
import { useInertPage, useReturnFocus } from "./focus";

/** Everything the palette can do: go to a screen, watch an agent, open a change, and a few settings. */
function commands(): Command[] {
  const list: Command[] = [
    { id: "live", title: "Go to Live", hint: "g l", run: () => navigate("/") },
    { id: "inbox", title: "Go to Inbox", hint: "g i", run: () => navigate("/inbox") },
    { id: "changes", title: "Go to Changes", hint: "g c", run: () => navigate("/changes") },
    { id: "activity", title: "Go to Activity", hint: "g a", run: () => navigate("/activity") },
    { id: "agents", title: "Go to Agents", hint: "g w", run: () => navigate("/agents") },
    { id: "spend", title: "Go to Spend", hint: "g s", run: () => navigate("/spend") },
    { id: "ask", title: "Ask the orchestrator", hint: keyLabel("mod+j", onMac), run: () => openDrawer() },
    { id: "theme", title: "Change the theme", run: cycleTheme },
    loop.value?.held
      ? { id: "resume", title: "Resume the loop", run: () => void setLoopHeld(false) }
      : { id: "pause", title: "Pause the loop", hint: "running steps finish", run: () => void setLoopHeld(true) },
    {
      id: "notify",
      title: notificationsOn() ? "Turn off notifications" : "Turn on notifications",
      run: () => {
        const want = !notificationsOn();
        void setNotifications(want).then((on) => {
          // Turning them on that ends up off means the browser said no; turning them off always works.
          if (want && !on) toast("The browser did not allow notifications.", "bad");
          else toast(on ? "You will be told when something needs you while this tab is in the background." : "Notifications are off.");
        });
      },
    },
  ];
  for (const p of running.value?.now ?? []) list.push({ id: `s:${p.slug}:${p.seq}`, title: `Watch ${p.title}: ${p.name}`, hint: "running", run: () => navigate(`/agents#${p.slug}:${p.seq}`) });
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
  useReturnFocus();
  useInertPage();
  useEffect(() => { input.current?.focus(); }, []);
  const items = filterCommands(commands(), query);
  // The list can shrink under the highlighted row (typing, or an agent finishing), so it is clamped on every draw.
  const cur = clampAt(at, items.length);
  useEffect(() => { document.getElementById(`palette-option-${cur}`)?.scrollIntoView({ block: "nearest" }); }, [cur, query]);
  const close = () => { paletteOpen.value = false; };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  return (
    <div class="overlay" onClick={close}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Search and commands" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          value={query}
          placeholder="Open a change, watch an agent, or run a command…"
          aria-label="Search"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `palette-option-${cur}` : undefined}
          onInput={(e) => { setQuery(e.currentTarget.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(clampAt(cur + 1, items.length)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(clampAt(cur - 1, items.length)); }
            else if (enterPressed(e)) { e.preventDefault(); run(items[cur]); }
          }}
        />
        <ul role="listbox" id="palette-list" aria-label="Results" hidden={!items.length}>
          {items.map((c, k) => (
            <li key={c.id} id={`palette-option-${k}`} role="option" aria-selected={k === cur} class={k === cur ? "on" : ""} onMouseEnter={() => setAt(k)} onClick={() => run(c)}>
              <span>{c.title}</span>
              {c.hint && <span class="muted">{c.hint}</span>}
            </li>
          ))}
        </ul>
        {!items.length && <p class="none muted" role="status">Nothing matches.</p>}
      </div>
    </div>
  );
}
