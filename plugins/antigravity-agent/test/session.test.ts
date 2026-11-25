import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpBridge } from "../dist/mcp.js";
import { parseModels } from "../dist/models.js";
import {
  openingMessage,
  resultToMcp,
  signature,
  startsWith,
  trailingResults,
  trailingUserText,
  type Msg,
} from "../dist/prompt.js";
import { AGY_DENY_RULES, AgyError, AgySession, agySettings, type TurnEvent } from "../dist/session.js";

const fakeAgy = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));
chmodSync(fakeAgy, 0o755);

const tool = { name: "echo", description: "Echo", inputSchema: { type: "object" } };
const config = (tools = [tool]) => ({ agyPath: fakeAgy, model: "fake", tools, fingerprint: "f" });

async function collect(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const text = (events: TurnEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

test("holds an MCP tool call, ends the step, and resumes with OpenCode's result", async () => {
  const bridge = await McpBridge.start();
  const session = new AgySession(bridge, config(), () => undefined);
  await session.start();
  const controller = new AbortController();
  try {
    const first = await collect(session.turn("go", controller.signal));
    const step = first.at(-1);
    assert.equal(step?.type, "tool-calls");
    assert.ok(step?.type === "tool-calls");
    assert.equal(step.calls.length, 1);
    assert.equal(step.calls[0]!.name, "echo");
    assert.deepEqual(step.calls[0]!.input, { text: "hi" });
    assert.deepEqual(session.pendingIds, [step.calls[0]!.id]);

    const second = await collect(
      session.resume(new Map([[step.calls[0]!.id, { text: "RESULT" }]]), controller.signal),
    );
    assert.equal(text(second), "tool said: RESULT");
    const finish = second.at(-1);
    assert.ok(finish?.type === "finish");
    assert.deepEqual(finish.usage, { nonCachedInput: 10, cacheRead: 7, output: 3, reasoning: 1 });
    assert.deepEqual(session.pendingIds, []);
  } finally {
    await session.close();
    await bridge.close();
  }
});

test("a turn with no tools finishes in one segment", async () => {
  const bridge = await McpBridge.start();
  const session = new AgySession(bridge, config([]), () => undefined);
  await session.start();
  try {
    const events = await collect(session.turn("hello there", new AbortController().signal));
    assert.match(text(events), /no tools; saw: hello there/);
    assert.equal(events.at(-1)?.type, "finish");
  } finally {
    await session.close();
    await bridge.close();
  }
});

test("a non-SUCCESS result surfaces as an error and closes the session", async () => {
  const bridge = await McpBridge.start();
  let closed = false;
  const session = new AgySession(bridge, config([]), () => (closed = true));
  await session.start();
  try {
    await assert.rejects(collect(session.turn("FAIL", new AbortController().signal)), (error) => {
      assert.ok(error instanceof AgyError);
      assert.match(error.message, /boom/);
      return true;
    });
    assert.equal(session.alive, false);
    assert.equal(closed, true);
  } finally {
    await bridge.close();
  }
});

test("aborting a turn stops agy and cancels held tool calls", async () => {
  const bridge = await McpBridge.start();
  const session = new AgySession(bridge, config(), () => undefined);
  await session.start();
  const controller = new AbortController();
  try {
    const first = await collect(session.turn("go", controller.signal));
    assert.equal(first.at(-1)?.type, "tool-calls");
    const pending = collect(session.resume(new Map(), controller.signal));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(session.alive, false);
  } finally {
    await bridge.close();
  }
});

test("agy is started with every built-in tool class denied and only OpenCode's MCP server allowed", () => {
  const settings = JSON.parse(agySettings());
  assert.deepEqual(settings.permissions.allow, ["mcp(oc/*)"]);
  assert.deepEqual(settings.permissions.deny, AGY_DENY_RULES);
  for (const rule of ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)"]) {
    assert.ok(settings.permissions.deny.includes(rule), rule);
  }
});

test("parseModels reads agy's tab-separated list and skips progress lines", () => {
  const output = "Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
  assert.deepEqual(parseModels(output), [
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ]);
});

const user = (t: string): Msg => ({ role: "user", content: [{ type: "text", text: t }] });
const assistant = (t: string): Msg => ({ role: "assistant", content: [{ type: "text", text: t }] });
const toolMsg = (id: string, value: unknown): Msg => ({
  role: "tool",
  content: [{ type: "tool-result", id, name: "read", result: { type: "text", value } }],
});

test("history signature detects appended input versus edits", () => {
  const before = signature([user("a"), assistant("x")]);
  assert.ok(startsWith(signature([user("a"), assistant("x"), user("b")]), before));
  assert.ok(!startsWith(signature([user("a2"), assistant("x"), user("b")]), before));
});

test("trailing tool results and user text are read from after the last assistant message", () => {
  const messages = [user("a"), assistant("calling"), toolMsg("agy_1", "ok"), toolMsg("agy_2", "fine")];
  assert.deepEqual([...trailingResults(messages)], [
    ["agy_2", { text: "fine", isError: false }],
    ["agy_1", { text: "ok", isError: false }],
  ]);
  assert.equal(trailingUserText([user("a"), assistant("x"), user("b"), user("c")]), "b\n\nc");
});

test("tool errors and file content map to MCP results", () => {
  assert.deepEqual(resultToMcp({ type: "error", value: "nope" }), { text: "nope", isError: true });
  assert.equal(
    resultToMcp({ type: "content", value: [{ type: "text", text: "t" }, { type: "file", name: "p.pdf", mime: "application/pdf" }] }).text,
    "t\n[file: p.pdf (application/pdf) not shown]",
  );
});

test("a fresh session after a model switch gets a checkpoint of everything agy has not seen", () => {
  const message = openingMessage(
    [{ text: "Be brief." }],
    [user("first"), assistant("reply"), user("second")],
  );
  assert.match(message, /<opencode-system>\nBe brief\./);
  assert.match(message, /<conversation-checkpoint>\nUser: first\nAssistant: reply\n<\/conversation-checkpoint>/);
  assert.ok(message.endsWith("second"));
});
