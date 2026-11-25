import { createHash } from "node:crypto";
import type { McpCallResult } from "./mcp.js";
import { MCP_SERVER } from "./session.js";

/** The structural subset of OpenCode's `Message` this plugin reads. */
export interface Part {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly result?: { readonly type: string; readonly value: unknown };
}

export interface Msg {
  readonly role: string;
  readonly content: readonly Part[];
}

export function textOf(message: Msg): string {
  return message.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "media" ? "[attachment omitted]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function resultToMcp(result: NonNullable<Part["result"]>): McpCallResult {
  const { type, value } = result;
  if (type === "content" && Array.isArray(value)) {
    const text = value
      .map((item: { type: string; text?: string; name?: string; mime?: string }) =>
        item.type === "text" ? (item.text ?? "") : `[file: ${item.name ?? "unnamed"} (${item.mime ?? "unknown"}) not shown]`,
      )
      .join("\n");
    return { text };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { text: text ?? "", isError: type === "error" };
}

export function hashMessage(message: Msg): string {
  const body =
    message.role === "tool"
      ? message.content.map((part) => `${part.id}:${JSON.stringify(part.result)}`).join("|")
      : textOf(message);
  return createHash("sha1").update(`${message.role}\n${body}`).digest("hex");
}

/** Hashes of the messages agy cannot have written itself: user input and tool results. */
export function signature(messages: readonly Msg[]): string[] {
  return messages.filter((m) => m.role === "user" || m.role === "tool").map(hashMessage);
}

export function startsWith(whole: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= whole.length && prefix.every((hash, index) => whole[index] === hash);
}

/** Tool results delivered after the last assistant message, keyed by the call id we issued. */
export function trailingResults(messages: readonly Msg[]): Map<string, McpCallResult> {
  const results = new Map<string, McpCallResult>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") break;
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.id && part.result) results.set(part.id, resultToMcp(part.result));
    }
  }
  return results;
}

/** User messages after the last assistant message. */
export function trailingUserText(messages: readonly Msg[]): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant" || message.role === "tool") break;
    if (message.role === "user") texts.unshift(textOf(message));
  }
  return texts.join("\n\n");
}

export function renderCheckpoint(messages: readonly Msg[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") lines.push(`User: ${textOf(message)}`);
    else if (message.role === "assistant") {
      const text = textOf(message);
      if (text) lines.push(`Assistant: ${text}`);
      for (const part of message.content) {
        if (part.type === "tool-call") lines.push(`Assistant called ${part.name}(${JSON.stringify(part.input)})`);
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result" && part.result) lines.push(`Tool result: ${resultToMcp(part.result).text}`);
      }
    }
  }
  return lines.join("\n");
}

export function systemBlock(system: readonly { readonly text: string }[]): string {
  const instructions = system.map((part) => part.text).filter(Boolean).join("\n\n");
  return [
    "<opencode-system>",
    instructions,
    "",
    `You are running inside OpenCode. Your only tools are the ones named mcp_${MCP_SERVER}_*; OpenCode runs them for you. ` +
      "Antigravity's own built-in tools are disabled and will be refused, so never call them.",
    "</opencode-system>",
  ].join("\n");
}

/**
 * The first message of a fresh agy process. Anything agy has not seen is wrapped as a checkpoint, mirroring how
 * OpenCode feeds history to Claude Agent after a model switch.
 */
export function openingMessage(system: readonly { readonly text: string }[], messages: readonly Msg[]): string {
  const input = trailingUserText(messages);
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]!.role === "user";
  const history = lastIsUser ? messages.slice(0, messages.length - trailingUserCount(messages)) : messages;
  const checkpoint = renderCheckpoint(history);
  const parts = [systemBlock(system)];
  if (checkpoint) parts.push(`<conversation-checkpoint>\n${checkpoint}\n</conversation-checkpoint>`);
  parts.push(lastIsUser ? input : "Continue from the tool results above.");
  return parts.join("\n\n");
}

function trailingUserCount(messages: readonly Msg[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "user"; i--) count++;
  return count;
}
