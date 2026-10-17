import { serveConsole } from "../console/server";

/** `loopstra ui`: the console on 127.0.0.1, with the orchestrator's chat unless `chat` is false. Runs until the process ends. */
export async function ui(root: string, port: number, chat: boolean): Promise<number> {
  let dashboard: import("../chat/transports/dashboard").DashboardTransport | undefined;
  if (chat) {
    const { DashboardTransport } = await import("../chat/transports/dashboard");
    const { ChatService } = await import("../chat/service");
    dashboard = new DashboardTransport(root);
    await new ChatService(root, [dashboard]).start();
  }
  const server = serveConsole(root, port, { chat: dashboard });
  console.log(`Loopstra console: http://127.0.0.1:${server.port}  (Ctrl-C to stop)`);
  await new Promise(() => {});
  return 0;
}
