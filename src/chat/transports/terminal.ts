import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { OnMessage, Transport } from "../service";
import { localUser } from "./shared";

/**
 * `loopstra chat` in a terminal: one conversation, the person at the keyboard. They run it on their
 * own machine in the repository, so they may start drafts, like editing the status line themselves.
 */
export class TerminalTransport implements Transport {
  readonly name = "terminal";
  readonly via = "the terminal";
  readonly announceFrom = "now" as const;
  private rl: Interface | null = null;
  private busy = Promise.resolve();
  private readonly user: string;
  /** Resolves when the person ends input (Ctrl-D, or the end of piped input). */
  readonly closed: Promise<void>;
  private resolveClosed: () => void = () => {};

  constructor(private readonly io: { input: Readable; output: Writable; user?: string; thread?: string } = { input: process.stdin, output: process.stdout }) {
    this.user = io.user ?? localUser();
    this.closed = new Promise((r) => { this.resolveClosed = r; });
  }

  private get thread(): string { return this.io.thread ?? "local"; }

  private write(text: string): void { this.io.output.write(text); }

  private prompt(): void { this.write("you> "); }

  async start(onMessage: OnMessage): Promise<void> {
    this.write("Loopstra chat. Ask how things are going, or talk through a new change. Ctrl-D or /quit to leave.\n");
    this.prompt();
    this.rl = createInterface({ input: this.io.input, terminal: false });
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) { this.prompt(); return; }
      if (text === "/quit" || text === "/exit") { this.rl?.close(); return; }
      // One message at a time: the next is read once the answer to this one is in.
      this.busy = this.busy.then(() => onMessage({ thread: this.thread, authorId: this.user, authorName: this.user, text, canAccept: true, acceptors: "you" }))
        .catch((e) => { this.write(`loopstra> Something went wrong: ${e instanceof Error ? e.message : String(e)}\n`); })
        .finally(() => this.prompt());
    });
    this.rl.on("close", () => { void this.busy.finally(() => this.resolveClosed()); });
  }

  async send(_thread: string, text: string): Promise<void> {
    this.write(`loopstra> ${text.replace(/\n/g, "\n          ")}\n`);
  }

  async announce(text: string): Promise<void> {
    this.write(`\n[loopstra] ${text}\n`);
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
