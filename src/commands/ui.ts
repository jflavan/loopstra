import { serveConsole } from "../console/server";
import { installStopSignals, resetStop, stopPromise } from "../stop";

/**
 * `loopstra ui`: the console on 127.0.0.1, with the orchestrator's chat unless `chat` is false. Runs
 * until Ctrl-C, which ends chat's sessions in progress (as `loopstra chat` does) before it returns.
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
    const server = serveConsole(root, port, { chat: dashboard });
    console.log(`Loopstra console: http://127.0.0.1:${server.port}  (Ctrl-C to stop)`);
    await stopPromise();
    server.stop(true);
    return 0;
  } finally {
    await service?.stop();
    uninstall();
  }
}
