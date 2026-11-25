import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { McpBridge, McpCallResult, McpTool } from "./mcp.js";

/** MCP server name agy sees. agy exposes its tools as `mcp_<server>_<tool>`. */
export const MCP_SERVER = "oc";
export const IDLE_MS = 5 * 60_000;
const CALL_GRACE_MS = 120;

export interface TokenUsage {
  readonly nonCachedInput: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly reasoning: number;
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type TurnEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool-calls"; readonly calls: readonly ToolCallRequest[]; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly usage: TokenUsage };

export interface SessionConfig {
  readonly agyPath: string;
  readonly model: string;
  readonly tools: readonly McpTool[];
  /** Everything that forces a new agy process when it changes. */
  readonly fingerprint: string;
}

type Inbound =
  | { readonly k: "text"; readonly text: string }
  | { readonly k: "usage"; readonly usage: TokenUsage }
  | { readonly k: "call"; readonly call: ToolCallRequest }
  | { readonly k: "result"; readonly status: string; readonly error?: string }
  | { readonly k: "exit"; readonly code: number | null; readonly stderr: string };

/** agy's built-in tools are denied; OpenCode's tools arrive over MCP and are the only ones allowed. */
export const AGY_DENY_RULES = [
  "command(*)",
  "unsandboxed(*)",
  "write_file(*)",
  "read_file(*)",
  "read_url(*)",
  "execute_url(*)",
];

export function agySettings(): string {
  return JSON.stringify({
    permissions: { allow: [`mcp(${MCP_SERVER}/*)`], deny: AGY_DENY_RULES },
  });
}

/** Unbounded async queue with a timed pop. */
class Channel<T> {
  private readonly items: T[] = [];
  private waiter: ((item: T | undefined) => void) | undefined;

  push(item: T): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  pop(timeoutMs?: number, signal?: AbortSignal): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      const done = (value: T | undefined) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = undefined;
        resolve(value);
      };
      const onAbort = () => done(undefined);
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => done(undefined), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = done;
    });
  }
}

const ZERO: TokenUsage = { nonCachedInput: 0, cacheRead: 0, output: 0, reasoning: 0 };

function toUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return {
    nonCachedInput: num("input_tokens"),
    cacheRead: num("cache_read_tokens"),
    output: num("output_tokens"),
    reasoning: num("thinking_tokens"),
  };
}

/**
 * One long-running `agy` process per OpenCode session. OpenCode owns the tools: agy calls them over MCP, the call
 * is held open, and the turn ends so OpenCode can run it. The next request delivers the result and the same agy
 * process continues.
 */
export class AgySession {
  readonly token = randomUUID();
  private readonly dir = join(tmpdir(), "opencode-antigravity-agent", this.token);
  private readonly inbox = new Channel<Inbound>();
  private readonly pending = new Map<string, (result: McpCallResult) => void>();
  private proc: ChildProcessWithoutNullStreams | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private busy = false;
  private closed = false;
  private stderr = "";
  /** Hashes of the user/tool messages agy has already seen, used to detect edits and undo. */
  known: string[] = [];

  private readonly bridge: McpBridge;
  readonly config: SessionConfig;
  private readonly onClose: () => void;

  constructor(bridge: McpBridge, config: SessionConfig, onClose: () => void) {
    this.bridge = bridge;
    this.config = config;
    this.onClose = onClose;
  }

  get alive(): boolean {
    return !this.closed;
  }

  get pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  async start(): Promise<void> {
    this.bridge.register(this.token, {
      tools: () => this.config.tools,
      call: (name, args, signal) => this.onToolCall(name, args, signal),
    });
    await mkdir(join(this.dir, ".agents"), { recursive: true });
    const tools = Object.fromEntries(this.config.tools.map((tool) => [tool.name, { eager: true }]));
    await writeFile(
      join(this.dir, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: { [MCP_SERVER]: { serverUrl: this.bridge.url(this.token), tools, timeoutSeconds: -1 } },
      }),
    );

    const proc = spawn(
      this.config.agyPath,
      [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--model", this.config.model,
        "--settings", agySettings(),
      ],
      { cwd: this.dir, stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    proc.on("error", (error) => {
      this.stderr += error.message;
      this.inbox.push({ k: "exit", code: null, stderr: this.stderr });
    });
    proc.on("close", (code) => {
      this.inbox.push({ k: "exit", code, stderr: this.stderr });
      void this.close();
    });
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    this.touch();
  }

  /** Send a user message and stream the turn until it finishes or agy asks OpenCode to run tools. */
  async *turn(text: string, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    this.write({ event: "user", message: { content: text } });
    yield* this.segment(signal);
  }

  /** Deliver tool results for held calls, then continue streaming the same turn. */
  async *resume(results: ReadonlyMap<string, McpCallResult>, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    for (const [id, result] of results) {
      const settle = this.pending.get(id);
      this.pending.delete(id);
      settle?.(result);
    }
    yield* this.segment(signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const [id, settle] of this.pending) {
      this.pending.delete(id);
      settle({ text: "Tool call was cancelled.", isError: true });
    }
    this.bridge.unregister(this.token);
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      proc.stdin.end();
      proc.kill("SIGTERM");
      setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 2000).unref();
    }
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.onClose();
  }

  private async *segment(signal: AbortSignal): AsyncGenerator<TurnEvent> {
    this.busy = true;
    clearTimeout(this.idleTimer);
    let usage = ZERO;
    let lastInput = ZERO;
    const total = () => ({ ...lastInput, output: usage.output, reasoning: usage.reasoning });
    try {
      while (true) {
        const item = await this.inbox.pop(undefined, signal);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (!item) continue;
        switch (item.k) {
          case "text":
            yield { type: "text", text: item.text };
            break;
          case "usage":
            lastInput = item.usage;
            usage = {
              ...usage,
              output: usage.output + item.usage.output,
              reasoning: usage.reasoning + item.usage.reasoning,
            };
            break;
          case "call": {
            const calls = [item.call];
            // agy may issue parallel calls; give them a moment to arrive so they ship in one step.
            for (let next = await this.inbox.pop(CALL_GRACE_MS, signal); next; next = await this.inbox.pop(CALL_GRACE_MS, signal)) {
              if (next.k === "call") calls.push(next.call);
              else if (next.k === "text") yield { type: "text", text: next.text };
              else if (next.k === "usage") lastInput = next.usage;
            }
            yield { type: "tool-calls", calls, usage: total() };
            return;
          }
          case "result":
            if (item.status !== "SUCCESS") {
              throw new AgyError(item.error || `agy ended the turn with status ${item.status}`);
            }
            yield { type: "finish", usage: total() };
            return;
          case "exit":
            throw new AgyError(item.stderr.trim() || `agy exited unexpectedly (code ${item.code})`);
        }
      }
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.busy = false;
      this.touch();
    }
  }

  private onToolCall(name: string, input: unknown, signal: AbortSignal): Promise<McpCallResult> {
    const id = `agy_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    return new Promise<McpCallResult>((resolve) => {
      this.pending.set(id, resolve);
      signal.addEventListener("abort", () => this.pending.delete(id), { once: true });
      this.inbox.push({ k: "call", call: { id, name, input } });
    });
  }

  private onLine(line: string): void {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.event === "step_update") {
      const step = event.step_update ?? {};
      if (step.step_type === "agent_response") {
        if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
          this.inbox.push({ k: "text", text: step.text_delta });
        }
        if (step.state === "DONE" && step.usage) this.inbox.push({ k: "usage", usage: toUsage(step.usage) });
      }
    } else if (event.event === "result") {
      const result = event.result ?? {};
      this.inbox.push({ k: "result", status: String(result.status ?? "UNKNOWN"), error: result.error });
    }
  }

  private write(message: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    if (this.closed || this.busy || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
    this.idleTimer.unref();
  }
}

export class AgyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgyError";
  }
}
