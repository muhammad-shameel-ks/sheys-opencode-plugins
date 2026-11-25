import assert from "node:assert/strict";
import test from "node:test";
import { ProviderLimitsCache } from "../dist/cache.js";
import { parseAnthropicUsageResponse } from "../dist/providers/anthropic.js";
import {
  parseDeepSeekResponse,
  parseGlmQuotaResponse,
  parseKimiUsageResponse,
  parseMiniMaxResponse,
  parseOllamaCloudResponse,
  parseOpenRouterResponse,
} from "../dist/providers/api-key-vendors.js";
import { fetchAntigravityAgent, parseAgyUsageOutput } from "../dist/providers/antigravity-cli.js";
import { parseCopilotUserResponse } from "../dist/providers/copilot.js";
import { parseAgyQuotaResponse, parseGeminiCliQuotaResponse } from "../dist/providers/google.js";
import { collectLimitsSnapshot } from "../dist/providers/index.js";
import { parseOpenAIUsageResponse } from "../dist/providers/openai.js";
import { parseGoConsoleStatus, parseGoUsageResponse } from "../dist/providers/opencode-go.js";
import { parseZenConsoleResponses } from "../dist/providers/opencode-zen.js";

test("OpenCode Go parsers handle API key usage and Console status", () => {
  const apiParsed = parseGoUsageResponse({
    usage: {
      rolling: { status: "ok", percent: 19.5, resetsAt: "2026-11-26T10:00:00Z" },
      weekly: { status: "ok", percent: 29.7, resetsAt: "2026-12-01T00:00:00Z" },
      monthly: { status: "rate-limited", percent: 99, resetsAt: "2026-12-01T00:00:00Z" },
    },
  });
  assert.ok("rows" in apiParsed);
  assert.equal(apiParsed.rows[0].percentUsed, 19.5);
  assert.equal(apiParsed.rows[2].percentUsed, 100);

  const consoleParsed = parseGoConsoleStatus({
    access: {
      endsAt: "2026-12-01T00:00:00Z",
      meters: {
        fiveHour: { limitMicroCents: 1000, usedMicroCents: 250 },
        week: { limitMicroCents: 2000, usedMicroCents: 1000 },
        month: { limitMicroCents: 5000, usedMicroCents: 2500 },
      },
    },
  });
  assert.ok("subscribed" in consoleParsed && consoleParsed.subscribed);
  assert.equal(consoleParsed.rows[0].percentUsed, 25);
});

test("OpenCode Zen parser computes balance and monthly budget", () => {
  const parsed = parseZenConsoleResponses({
    statusJson: { balanceMicroCents: 1_250_000_000 },
    accountJson: { creditLimitMicroCents: 2_000_000_000 },
    costByDayJson: [{ date: "2026-11-05", totalCostMicroCents: 500_000_000 }],
    now: new Date("2026-11-25T00:00:00Z"),
  });
  assert.ok("rows" in parsed);
  assert.equal(parsed.rows[0].percentUsed, 25);
  assert.equal(parsed.rows[0].valueText, "$5.00 / $20.00");
  assert.equal(parsed.rows[1].valueText, "$12.50");
});

test("Anthropic parser handles five_hour, seven_day, model windows, and extra_usage", () => {
  const parsed = parseAnthropicUsageResponse({
    five_hour: { utilization: 37.0, resets_at: "2026-11-25T15:00:00Z" },
    seven_day: { utilization: 26.0, resets_at: "2026-12-01T00:00:00Z" },
    seven_day_sonnet: { utilization: 5.0, resets_at: "2026-12-01T00:00:00Z" },
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250 },
  });
  assert.ok("rows" in parsed);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[0].percentUsed, 37);
  assert.equal(parsed.rows[3].percentUsed, 25);
  assert.equal(parsed.rows[3].valueText, "$12.50 / $50.00");
});

test("OpenAI / Codex parser extracts windows and plan", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const parsed = parseOpenAIUsageResponse(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 42, reset_after_seconds: 3600 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 15, reset_at: 1795800000 },
      },
      code_review_rate_limit: {
        primary_window: { used_percent: 10, reset_after_seconds: 7200 },
      },
    },
    now,
  );
  assert.ok("rows" in parsed);
  assert.equal(parsed.plan, "Plus");
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].label, "5h Rolling");
  assert.equal(parsed.rows[0].percentUsed, 42);
});

test("GitHub Copilot parser handles entitlement and unlimited", () => {
  const parsed = parseCopilotUserResponse({
    copilot_plan: "pro",
    quota_reset_date_utc: "2026-12-01T00:00:00Z",
    quota_snapshots: {
      premium_interactions: { entitlement: 300, quota_remaining: 240, percent_remaining: 80 },
    },
  });
  assert.ok("rows" in parsed);
  assert.equal(parsed.plan, "pro");
  assert.equal(parsed.rows[0].percentUsed, 20);
  assert.equal(parsed.rows[0].valueText, "60/300");
});

test("Google AGY and Gemini CLI parsers convert remainingFraction to percentUsed", () => {
  const agy = parseAgyQuotaResponse({
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [{ window: "FIVE_HOUR", remainingFraction: 0.75, resetTime: "2026-11-25T15:00:00Z" }],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [{ window: "WEEKLY", remainingFraction: 0.4, resetTime: "2026-12-01T00:00:00Z" }],
      },
    ],
  });
  assert.ok("rows" in agy);
  assert.equal(agy.rows[0].label, "Gemini 5h");
  assert.equal(agy.rows[0].percentUsed, 25);
  assert.equal(agy.rows[1].label, "Claude/GPT Weekly");
  assert.equal(agy.rows[1].percentUsed, 60);

  const gemini = parseGeminiCliQuotaResponse({
    buckets: [
      { modelId: "gemini-2.5-pro", remainingFraction: 0.9 },
      { modelId: "gemini-2.5-flash", remainingFraction: 0.5 },
    ],
  });
  assert.ok("rows" in gemini);
  assert.equal(gemini.rows[0].label, "Gemini Pro");
  assert.equal(gemini.rows[0].percentUsed, 10);
});

test("Antigravity agy /usage parser and fetcher", async () => {
  const output = [
    "Gemini Models\tWeekly Limit Remaining\t74%\t2026-12-02T04:17:14Z",
    "Gemini Models\tFive Hour Limit Remaining\t98%\t2026-11-25T14:17:14Z",
    "Claude and GPT models\tWeekly Limit Remaining\t82%\t2026-12-02T07:30:10Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t64%\t2026-11-25T12:30:10Z",
  ].join("\n");
  const parsed = parseAgyUsageOutput(output);
  assert.ok("rows" in parsed);
  assert.deepEqual(
    parsed.rows.map((r) => [r.label, r.percentUsed]),
    [
      ["Gemini Weekly", 26],
      ["Gemini 5h", 2],
      ["Claude/GPT Weekly", 18],
      ["Claude/GPT 5h", 36],
    ],
  );
  assert.equal(parsed.rows[1].resetsAt, "2026-11-25T14:17:14.000Z");

  assert.ok("error" in parseAgyUsageOutput("garbage without tabs\nfoo\tbar\tbaz"));
  assert.deepEqual(parseAgyUsageOutput("  \n"), { error: "Empty agy /usage output" });

  const cache = new ProviderLimitsCache();
  const ctx = {} as Parameters<typeof collectLimitsSnapshot>[0]["ctx"];
  const ok = await fetchAntigravityAgent({ ctx, cache, execImpl: async () => output });
  assert.equal(ok?.status, "ok");
  assert.equal(ok?.rows.length, 4);
  const missing = await fetchAntigravityAgent({
    ctx,
    cache,
    execImpl: async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    },
  });
  assert.equal(missing, undefined);
  const failed = await fetchAntigravityAgent({
    ctx,
    cache,
    execImpl: async () => {
      throw Object.assign(new Error("secret-token"), { code: 1 });
    },
  });
  assert.equal(failed?.status, "error");
  assert.ok(!failed?.error?.includes("secret"));
});

test("Tier 2 API-key vendor parsers handle expected JSON shapes", () => {
  const kimi = parseKimiUsageResponse({
    usage: { limit: 100, used: 30, reset_at: "2026-12-01T00:00:00Z" },
    limits: [{ name: "5h Rate", detail: { limit: 10, remaining: 4, reset_in: 600 } }],
  });
  assert.ok("rows" in kimi);
  assert.equal(kimi.rows[0].percentUsed, 30);
  assert.equal(kimi.rows[1].percentUsed, 60);

  const glm = parseGlmQuotaResponse(
    { success: true, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 18, nextResetTime: 1795651200000 }] } },
    "zai",
  );
  assert.ok("rows" in glm);
  assert.equal(glm.rows[0].percentUsed, 18);

  const minimax = parseMiniMaxResponse(
    {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: "MiniMax-M*",
          current_interval_total_count: 100,
          current_interval_usage_count: 80,
          remains_time: 60_000,
        },
      ],
    },
    "international",
    1_000_000,
  );
  assert.ok("rows" in minimax);
  assert.equal(minimax.rows[0].percentUsed, 20);
  assert.equal(minimax.rows[0].valueText, "20/100 req");

  const ollama = parseOllamaCloudResponse({
    included: { balance_usd: 15, allowance_usd: 20, period: { until: "2026-12-01T00:00:00Z" } },
    purchased: { balance_usd: 5 },
  });
  assert.ok("rows" in ollama);
  assert.equal(ollama.rows[0].percentUsed, 25);
  assert.equal(ollama.rows[1].valueText, "$5.00");

  const openrouter = parseOpenRouterResponse({ data: { limit: 50, limit_remaining: 35, usage: 15 } });
  assert.ok("rows" in openrouter);
  assert.equal(openrouter.rows[0].percentUsed, 30);

  const deepseek = parseDeepSeekResponse({
    balance_infos: [{ currency: "USD", total_balance: "14.25" }],
  });
  assert.ok("rows" in deepseek);
  assert.equal(deepseek.rows[0].valueText, "14.25 USD");
});

test("collectLimitsSnapshot auto-detects configured providers and filters cleanly", async () => {
  const credentials = new Map<string, { id: string; label: string; method: "oauth" | "key"; value: unknown }>([
    [
      "opencode",
      {
        id: "conn-oc",
        label: "default",
        method: "oauth",
        value: { type: "oauth", access: "oc-access-token", metadata: { email: "dev@example.com" } },
      },
    ],
    [
      "anthropic",
      {
        id: "conn-cl",
        label: "Pro",
        method: "oauth",
        value: { type: "oauth", access: "cl-access-token", expires: Date.now() + 3600_000 },
      },
    ],
  ]);

  const fakeCtx = {
    integration: {
      list: async () => ({
        data: [...credentials.entries()].map(([id, c]) => ({
          id,
          connections: [{ type: "credential", id: c.id, label: c.label, method: c.method }],
        })),
      }),
      connection: {
        active: async (id: string) => {
          const c = credentials.get(id);
          return c ? { type: "credential", id: c.id, label: c.label, method: c.method } : undefined;
        },
        resolve: async (conn: { id: string }) => {
          for (const entry of credentials.values()) {
            if (entry.id === conn.id) return entry.value;
          }
          return undefined;
        },
      },
    },
  } as unknown as Parameters<typeof collectLimitsSnapshot>[0]["ctx"];

  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/go/status")) {
      return new Response(
        JSON.stringify({
          access: {
            endsAt: "2026-12-01T00:00:00Z",
            meters: {
              fiveHour: { limitMicroCents: 1000, usedMicroCents: 100 },
              week: { limitMicroCents: 1000, usedMicroCents: 200 },
              month: { limitMicroCents: 1000, usedMicroCents: 300 },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/billing/status")) {
      return new Response(JSON.stringify({ balanceMicroCents: 500_000_000 }), { status: 200 });
    }
    if (url.includes("/api/billing/account") || url.includes("/api/usage/cost-by-day")) {
      return new Response("null", { status: 404 });
    }
    if (url === "https://api.anthropic.com/api/oauth/usage") {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 12, resets_at: "2026-11-25T15:00:00Z" },
          seven_day: { utilization: 40, resets_at: "2026-12-01T00:00:00Z" },
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const cache = new ProviderLimitsCache();
  const snapshot = await collectLimitsSnapshot(
    {
      ctx: fakeCtx,
      cache,
      fetchImpl: fakeFetch,
      execImpl: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    },
    { pluginOptions: { exclude: ["opencode-zen"] } },
  );

  assert.deepEqual(
    snapshot.providers.map((p) => p.id),
    ["opencode-go", "anthropic"],
  );
  assert.equal(snapshot.providers[0].status, "ok");
  assert.equal(snapshot.providers[0].rows[0].percentUsed, 10);
  assert.equal(snapshot.providers[1].status, "ok");
  assert.equal(snapshot.providers[1].rows[0].percentUsed, 12);
});
