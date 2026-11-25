import { createHash } from "node:crypto";
import { Effect, Schema, Stream } from "effect";
import { AIError, LLMEvent, ProviderInternalError, Usage, type LLMRequest } from "@opencode/ai/effect";
import { Auth, Endpoint, Protocol, Route } from "@opencode/ai/route";
import { McpBridge, type McpTool } from "./mcp.js";
import { findAgy } from "./models.js";
import {
  openingMessage,
  signature,
  startsWith,
  trailingResults,
  trailingUserText,
  type Msg,
} from "./prompt.js";
import { AgySession, type TokenUsage, type TurnEvent } from "./session.js";

export const PROVIDER_ID = "antigravity-agent";

type Frame =
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "tools"; readonly calls: readonly { id: string; name: string; input: unknown }[]; readonly usage: TokenUsage }
  | { readonly t: "finish"; readonly usage: TokenUsage };

interface StepState {
  readonly started: boolean;
  readonly textOpen: boolean;
}

const sessions = new Map<string, AgySession>();
let bridge: Promise<McpBridge> | undefined;

const debug = (...args: unknown[]) => {
  if (process.env.OPENCODE_AGY_DEBUG) console.error("[antigravity-agent]", ...args);
};

function sessionKey(request: LLMRequest): string {
  if (request.promptCacheKey) return `cache:${request.promptCacheKey}`;
  if (request.id) return `id:${request.id}`;
  const first = (request.messages as readonly Msg[]).find((m) => m.role === "user");
  return `hash:${createHash("sha1").update(first ? JSON.stringify(first.content) : "").digest("hex")}`;
}

function toMcpTools(request: LLMRequest): McpTool[] {
  const tools: McpTool[] = [];
  const visit = (entries: readonly unknown[]) => {
    for (const entry of entries as readonly Record<string, any>[]) {
      if (entry.type === "namespace") visit(entry.tools);
      else if (typeof entry.name === "string") {
        tools.push({
          name: entry.name.replace(/[^A-Za-z0-9_-]/g, "_"),
          description: entry.description ?? "",
          inputSchema: entry.inputSchema ?? { type: "object" },
        });
      }
    }
  };
  visit(request.tools);
  return tools;
}

async function ensureBridge(): Promise<McpBridge> {
  bridge ??= McpBridge.start();
  return bridge;
}

async function* run(request: LLMRequest, signal: AbortSignal): AsyncGenerator<TurnEvent> {
  const agyPath = findAgy();
  if (!agyPath) throw new Error("Antigravity CLI (agy) was not found. Install it, or set OPENCODE_AGY_PATH.");

  const messages = request.messages as readonly Msg[];
  const tools = toMcpTools(request);
  const fingerprint = createHash("sha1")
    .update(JSON.stringify([request.model.id, tools.map((tool) => [tool.name, tool.description, tool.inputSchema])]))
    .digest("hex");
  const config = { agyPath, model: request.model.id, tools, fingerprint };
  const sig = signature(messages);
  const mcp = await ensureBridge();

  // Requests without tools (titles, summaries) are one-shot: nothing to hold across requests.
  if (tools.length === 0) {
    const session = new AgySession(mcp, config, () => undefined);
    await session.start();
    try {
      yield* session.turn(openingMessage(request.system, messages), signal);
    } finally {
      await session.close();
    }
    return;
  }

  const key = sessionKey(request);
  let session = sessions.get(key);
  if (session && (!session.alive || session.config.fingerprint !== fingerprint)) {
    await session.close();
    session = undefined;
  }

  if (session) {
    const held = session.pendingIds;
    if (held.length > 0) {
      const results = trailingResults(messages);
      if (held.every((id) => results.has(id)) && startsWith(sig, session.known)) {
        session.known = sig;
        debug("resume", key, held.length);
        yield* session.resume(new Map(held.map((id) => [id, results.get(id)!])), signal);
        return;
      }
      debug("pending calls not answered; restarting", key);
      await session.close();
      session = undefined;
    } else if (startsWith(sig, session.known) && sig.length > session.known.length && messages.at(-1)?.role === "user") {
      session.known = sig;
      debug("continue", key);
      yield* session.turn(trailingUserText(messages), signal);
      return;
    } else {
      debug("history diverged; restarting", key);
      await session.close();
      session = undefined;
    }
  }

  const fresh = new AgySession(mcp, config, () => {
    if (sessions.get(key) === fresh) sessions.delete(key);
  });
  sessions.set(key, fresh);
  fresh.known = sig;
  await fresh.start();
  debug("fresh", key, "tools", tools.length);
  yield* fresh.turn(openingMessage(request.system, messages), signal);
}

const usage = (counts: TokenUsage) => {
  const input = counts.nonCachedInput + counts.cacheRead;
  return Usage.from({
    inputTokens: input,
    nonCachedInputTokens: counts.nonCachedInput,
    cacheReadInputTokens: counts.cacheRead,
    outputTokens: counts.output,
    reasoningTokens: counts.reasoning,
    totalTokens: input + counts.output,
    contextTokens: input,
    cost: 0,
  });
};

const frames = (request: LLMRequest): Stream.Stream<string, AIError> =>
  Stream.suspend(() => {
    const controller = new AbortController();
    let completed = false;
    const source = (async function* () {
      try {
        for await (const event of run(request, controller.signal)) {
          const frame: Frame =
            event.type === "text"
              ? { t: "text", text: event.text }
              : event.type === "tool-calls"
                ? { t: "tools", calls: event.calls, usage: event.usage }
                : { t: "finish", usage: event.usage };
          yield JSON.stringify(frame);
        }
        completed = true;
      } finally {
        // Interrupting mid-run stops agy; finishing a step with held tool calls must keep it alive.
        if (!completed) controller.abort();
      }
    })();
    return Stream.fromAsyncIterable(
      source,
      (error) =>
        new AIError({
          reason: new ProviderInternalError({ message: error instanceof Error ? error.message : String(error) }),
        }),
    );
  });

const protocol = Protocol.make({
  id: "antigravity-agent",
  body: {
    schema: Schema.Unknown as unknown as Schema.Codec<unknown, unknown>,
    from: () => Effect.succeed({}),
  },
  stream: {
    event: Schema.fromJsonString(Schema.Unknown) as unknown as Schema.Codec<Frame, string>,
    initial: (): StepState => ({ started: false, textOpen: false }),
    step: (state: StepState, frame: Frame) =>
      Effect.sync(() => {
        const events: LLMEvent[] = [];
        let next = state;
        const begin = () => {
          if (!next.started) {
            events.push(LLMEvent.stepStart({ index: 0 }));
            next = { ...next, started: true };
          }
        };
        const closeText = () => {
          if (next.textOpen) {
            events.push(LLMEvent.textEnd({ id: "text-0" }));
            next = { ...next, textOpen: false };
          }
        };
        if (frame.t === "text") {
          begin();
          if (!next.textOpen) {
            events.push(LLMEvent.textStart({ id: "text-0" }));
            next = { ...next, textOpen: true };
          }
          events.push(LLMEvent.textDelta({ id: "text-0", text: frame.text }));
        } else if (frame.t === "tools") {
          begin();
          closeText();
          for (const call of frame.calls) {
            events.push(LLMEvent.toolCall({ id: call.id, name: call.name, input: call.input }));
          }
          const reason = { normalized: "tool-calls" as const, raw: "mcp_tool_call" };
          events.push(
            LLMEvent.stepFinish({ index: 0, reason, usage: usage(frame.usage) }),
            LLMEvent.finish({ reason, usage: usage(frame.usage) }),
          );
          next = { started: false, textOpen: false };
        } else {
          begin();
          closeText();
          const reason = { normalized: "stop" as const, raw: "SUCCESS" };
          events.push(
            LLMEvent.stepFinish({ index: 0, reason, usage: usage(frame.usage) }),
            LLMEvent.finish({ reason, usage: usage(frame.usage) }),
          );
          next = { started: false, textOpen: false };
        }
        return [next, events] as const;
      }),
  },
});

const route = Route.make({
  id: "antigravity-agent",
  provider: PROVIDER_ID,
  protocol,
  // Required by Route but never dialed: the transport talks to a local agy process, not an HTTP endpoint.
  endpoint: Endpoint.path("/", { baseURL: "http://127.0.0.1" }),
  auth: Auth.none,
  transport: {
    id: "agy-process",
    prepare: () => Effect.succeed(undefined),
    execute: (_prepared: undefined, request: LLMRequest) => Effect.succeed({ frames: frames(request) }),
  },
});

/** Provider package entry point: OpenCode calls this to build a model from `providers.<id>.package`. */
export const model = (modelID: string) =>
  route.model({
    id: modelID,
    provider: PROVIDER_ID,
    capabilities: { tools: { supported: true } },
  });

export async function disposeAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => session.close()));
  sessions.clear();
  if (bridge) {
    const started = await bridge;
    bridge = undefined;
    await started.close();
  }
}
