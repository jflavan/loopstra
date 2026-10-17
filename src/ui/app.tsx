import { render } from "preact";
import { useEffect } from "preact/hooks";
import { startAlerts } from "./alerts";
import { listenToHistory, route } from "./nav";
import { Drawer } from "./parts/Drawer";
import { Help } from "./parts/Help";
import { Link } from "./parts/Link";
import { Palette } from "./parts/Palette";
import { Rail } from "./parts/Rail";
import { Toasts } from "./parts/Toasts";
import { TopBar } from "./parts/TopBar";
import { installKeys } from "./shortcuts";
import { connect, connection } from "./store";
import { applyTheme, theme } from "./theme";
import { Activity } from "./views/Activity";
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

function App() {
  useEffect(() => {
    connect();
    listenToHistory();
    installKeys();
    startAlerts();
  }, []);
  return (
    <div class="shell">
      <TopBar />
      <Rail />
      <main class="main" id="main">
        {connection.value === "stale" && <div class="reconnecting" role="status">Reconnecting… what you see may be out of date.</div>}
        <Screen />
      </main>
      <Drawer />
      <Palette />
      <Help />
      <Toasts />
    </div>
  );
}

applyTheme(theme.value);
render(<App />, document.getElementById("app")!);
