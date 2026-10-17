import { route } from "../nav";
import { inbox, running } from "../store";
import { Icon } from "./Icon";
import { Link } from "./Link";

const SCREENS = [
  { href: "/", label: "Live", icon: "live", on: ["live", "session"] },
  { href: "/inbox", label: "Inbox", icon: "inbox", on: ["inbox"] },
  { href: "/changes", label: "Changes", icon: "changes", on: ["changes", "change"] },
  { href: "/activity", label: "Activity", icon: "activity", on: ["activity"] },
  { href: "/spend", label: "Spend", icon: "spend", on: ["spend"] },
];

export function Rail() {
  const at = route.value.name;
  const agents = running.value?.now.length ?? 0;
  const waiting = inbox.value?.length ?? 0;
  return (
    <nav class="rail" aria-label="Screens">
      {SCREENS.map((s) => (
        <Link key={s.href} href={s.href} class={`rail-item${s.on.includes(at) ? " on" : ""}`} current={s.on.includes(at)} title={s.label}>
          <Icon name={s.icon} />
          <span class="label">{s.label}</span>
          {s.href === "/" && agents > 0 && <span class="chip">{agents}</span>}
          {s.href === "/inbox" && waiting > 0 && <span class="count">{waiting}</span>}
        </Link>
      ))}
    </nav>
  );
}
