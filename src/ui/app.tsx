import { render } from "preact";
import { useEffect } from "preact/hooks";
import { startAlerts } from "./alerts";
import { listenToHistory, route } from "./nav";
import { Boundary } from "./parts/Boundary";
import { Drawer } from "./parts/Drawer";
import { Help } from "./parts/Help";
import { Link } from "./parts/Link";
import { Palette } from "./parts/Palette";
import { Rail } from "./parts/Rail";
import { Toasts } from "./parts/Toasts";
import { TopBar } from "./parts/TopBar";
import { installKeys } from "./shortcuts";
import { connect, connection, drawer, helpOpen, paletteOpen, toast } from "./store";
import { applyTheme, theme } from "./theme";
import { Activity } from "./views/Activity";
import { Agents } from "./views/Agents";
import { Change } from "./views/Change";
import { Changes } from "./views/Changes";
import { Inbox } from "./views/Inbox";
import { Live } from "./views/Live";
import { Session } from "./views/Session";
import { Spend } from "./views/Spend";

function Screen() {
  const r = route.value;
  switch (r.name) {
    case "live": return <Live />;
    case "inbox": return <Inbox />;
    case "changes": return <Changes />;
    case "change": return <Change key={r.slug} slug={r.slug} tab={r.tab} />;
    case "session": return <Session key={`${r.slug}/${r.seq}`} slug={r.slug} seq={r.seq} />;
    case "activity": return <Activity />;
    case "agents": return <Agents />;
    case "spend": return <Spend />;
    case "missing":
      return (
        <section class="view">
          <h1>Nothing here</h1>
          <p class="muted">There is no screen at {r.path}. <Link href="/">Go to Live</Link>.</p>
        </section>
      );
  }
}

/** How long after one toast about a page error the next may come: a loop of errors must not bury the page in toasts. */
const ERROR_TOAST_MS = 10_000;

/** An error nothing caught (in a handler, a timer, a promise) is said once in a toast; the browser's console has the error itself. */
function tellErrors(): void {
  let saidAt = 0;
  const say = () => {
    const t = Date.now();
    if (t - saidAt < ERROR_TOAST_MS) return;
    saidAt = t;
    toast("Something went wrong on the page. The browser's console says what.", "bad");
  };
  addEventListener("error", say);
  addEventListener("unhandledrejection", say);
}

function App() {
  useEffect(() => {
    connect();
    listenToHistory();
    installKeys();
    startAlerts();
    tellErrors();
  }, []);
  const r = route.value;
  // Each part is drawn inside its own boundary: one that fails is replaced, and the rest stay. The
  // screen's boundary starts over on every screen (its key, the same as Screen's: a change's tabs
  // share one), and an overlay's each time it opens.
  const screenKey = r.name === "change" ? `change:${r.slug}` : r.name === "session" ? `session:${r.slug}/${r.seq}` : r.name;
  return (
    <div class="shell">
      <Boundary name="the top bar" fallback={null}><TopBar /></Boundary>
      <Boundary name="the rail" fallback={null}><Rail /></Boundary>
      <main class="main" id="main">
        {connection.value === "stale" && <div class="reconnecting" role="status">Reconnecting… what you see may be out of date.</div>}
        <Boundary name="this screen" key={screenKey}><Screen /></Boundary>
      </main>
      <Boundary name="the orchestrator's drawer" fallback={null} key={`d${drawer.value.open}`}><Drawer /></Boundary>
      <Boundary name="the command palette" fallback={null} key={`p${paletteOpen.value}`}><Palette /></Boundary>
      <Boundary name="the keys help" fallback={null} key={`h${helpOpen.value}`}><Help /></Boundary>
      <Toasts />
    </div>
  );
}

const app = document.getElementById("app")!;
// Inside another page the console could be clicked through unseen (clickjacking). Its headers cannot
// forbid framing, since Bun serves the page itself, so the page refuses to draw there.
if (window.top !== window.self) {
  app.textContent = "Loopstra does not run inside another page. Open it in its own tab.";
} else {
  applyTheme(theme.value);
  render(<App />, app);
}
