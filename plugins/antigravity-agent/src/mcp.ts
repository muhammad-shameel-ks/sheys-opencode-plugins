import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface McpCallResult {
  readonly text: string;
  readonly isError?: boolean;
}

export interface McpEndpoint {
  tools(): readonly McpTool[];
  /** Resolves when OpenCode has produced the tool result. `signal` aborts if agy drops the request. */
  call(name: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const PROTOCOL_FALLBACK = "2025-06-18";

/**
 * Minimal Streamable HTTP MCP server. One listener serves many agy sessions; each session owns an unguessable
 * path token. Only POST with plain JSON responses is implemented, which the transport allows.
 */
export class McpBridge {
  private readonly endpoints = new Map<string, McpEndpoint>();

  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
    server.on("request", (req, res) => void this.handle(req, res));
  }

  static async start(): Promise<McpBridge> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    return new McpBridge(server);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  url(token: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${token}`;
  }

  register(token: string, endpoint: McpEndpoint): void {
    this.endpoints.set(token, endpoint);
  }

  unregister(token: string): void {
    this.endpoints.delete(token);
  }

  async close(): Promise<void> {
    this.endpoints.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([A-Za-z0-9-]+)$/.exec(req.url ?? "");
    const endpoint = match ? this.endpoints.get(match[1]!) : undefined;
    if (!endpoint) return void send(res, 404, { error: "not found" });
    if (req.method !== "POST") return void send(res, 405, { error: "method not allowed" });

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(await readBody(req)) as JsonRpcRequest;
    } catch {
      return void send(res, 400, rpcError(null, -32700, "parse error"));
    }

    const id = message.id ?? null;
    const isNotification = message.id === undefined;

    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        return void send(res, 200, rpcResult(id, {
          protocolVersion: typeof requested === "string" ? requested : PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "opencode", version: "0.1.0" },
        }));
      }
      case "ping":
        return void send(res, 200, rpcResult(id, {}));
      case "tools/list":
        return void send(res, 200, rpcResult(id, {
          tools: endpoint.tools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }));
      case "tools/call": {
        const controller = new AbortController();
        res.once("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        const name = typeof message.params?.name === "string" ? message.params.name : "";
        try {
          const result = await endpoint.call(name, message.params?.arguments ?? {}, controller.signal);
          if (controller.signal.aborted) return;
          return void send(res, 200, rpcResult(id, {
            content: [{ type: "text", text: result.text }],
            isError: result.isError === true,
          }));
        } catch (error) {
          if (controller.signal.aborted) return;
          return void send(res, 200, rpcResult(id, {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          }));
        }
      }
      default:
        if (isNotification) {
          res.writeHead(202).end();
          return;
        }
        return void send(res, 200, rpcError(id, -32601, `method not found: ${message.method ?? ""}`));
    }
  }
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
