export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface ToolUse { name: string; input: unknown }

export interface Collected {
  sessionId: string | null;
  subtype: string;
  structuredOutput: unknown;
  costUsd: number;
  usage: unknown;
  toolUses: ToolUse[];
  resultText: string;
  events: StreamEvent[];
  isError: boolean;
}

/** Accumulates `--output-format stream-json` lines into one result. */
export class StreamCollector {
  private sessionId: string | null = null;
  private result: StreamEvent | null = null;
  private toolUses: ToolUse[] = [];
  readonly events: StreamEvent[] = [];

  push(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let e: StreamEvent;
    try { e = JSON.parse(trimmed) as StreamEvent; } catch { return null; }
    this.events.push(e);
    if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
    if (e.type === "assistant") {
      const content = (e as { message?: { content?: Array<{ type: string; name?: string; input?: unknown }> } }).message?.content ?? [];
      for (const c of content) if (c.type === "tool_use" && c.name) this.toolUses.push({ name: c.name, input: c.input });
    }
    if (e.type === "result") this.result = e;
    return e;
  }

  finish(): Collected {
    const r = this.result as (StreamEvent & {
      structured_output?: unknown; total_cost_usd?: number; usage?: unknown; result?: string; is_error?: boolean;
    }) | null;
    return {
      sessionId: this.sessionId ?? r?.session_id ?? null,
      subtype: r?.subtype ?? "missing_result",
      structuredOutput: r?.structured_output,
      costUsd: r?.total_cost_usd ?? 0,
      usage: r?.usage,
      toolUses: this.toolUses,
      resultText: r?.result ?? "",
      events: this.events,
      isError: r?.is_error ?? r === null,
    };
  }
}
