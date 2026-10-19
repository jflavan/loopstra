import { serveConsole } from "../console/server";
import { installStopSignals, resetStop, stopPromise } from "../stop";

/** True for the error Bun.serve throws when another program listens on the port already. */
const portInUse = (e: unknown): boolean => e instanceof Error && (e as { code?: unknown }).code === "EADDRINUSE";

/**
 * `loopstra ui`: the console on 127.0.0.1, with the orchestrator's chat unless `chat` is false. Runs
 * until Ctrl-C, which ends chat's sessions in progress (as `loopstra chat` does) before it returns.
 * A port another program is on is said in one line (exit 1), not thrown.
 */
export async function ui(root: string, port: number, chat: boolean): Promise<number> {
  resetStop();
  const uninstall = installStopSignals("Stopping the console.");
  let service: import("../chat/service").ChatService | undefined;
  try {
    let dashboard: import("../chat/transports/dashboard").DashboardTransport | undefined;
    if (chat) {
      const { DashboardTransport } = await import("../chat/transports/dashboard");
      const { ChatService } = await import("../chat/service");
      dashboard = new DashboardTransport(root);
      service = new ChatService(root, [dashboard]);
      await service.start();
    }
    let server: ReturnType<typeof serveConsole>;
    try {
      server = serveConsole(root, port, { chat: dashboard });
    } catch (e) {
      if (!portInUse(e)) throw e;
      console.error(`Port ${port} is in use: pick another with --port <n>.`);
      return 1;
    }
    console.log(`Loopstra console: http://127.0.0.1:${server.port ?? port}  (Ctrl-C to stop)`);
    await stopPromise();
    await server.stop(true);
    return 0;
  } finally {
    await service?.stop();
    uninstall();
  }
}
