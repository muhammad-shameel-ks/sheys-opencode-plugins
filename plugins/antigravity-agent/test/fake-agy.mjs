#!/usr/bin/env node
// Stand-in for `agy` in stream-json mode. For each user message it calls the MCP tool `echo` found in
// .agents/mcp_config.json (like the real agy does for eager tools), then answers with the tool output.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(readFileSync(".agents/mcp_config.json", "utf8"));
const { serverUrl } = config.mcpServers.oc;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let id = 0;
const rpc = async (method, params) => {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return (await response.json()).result;
};

out({ event: "init", conversation_id: "fake", init: { tools: [] } });
await rpc("initialize", { protocolVersion: "2025-06-18" });

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const text = message.message.content;
  if (text.includes("FAIL")) {
    out({ event: "result", result: { status: "ERROR", error: "boom", response: "" } });
    continue;
  }
  const listed = await rpc("tools/list", {});
  const tool = listed.tools[0]?.name;
  let reply = `no tools; saw: ${text.slice(-40)}`;
  if (tool) {
    const result = await rpc("tools/call", { name: tool, arguments: { text: "hi" } });
    reply = `tool said: ${result.content[0].text}`;
  }
  out({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: reply.slice(0, 5) } });
  out({
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      state: "DONE",
      text_delta: reply.slice(5),
      usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 7, thinking_tokens: 1 },
    },
  });
  out({ event: "result", result: { status: "SUCCESS", response: reply } });
}
