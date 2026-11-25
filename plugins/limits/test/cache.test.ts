import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfterMs, ProviderLimitsCache } from "../dist/cache.js";
import type { ProviderLimits } from "../dist/types.js";

const okResult: ProviderLimits = {
  id: "anthropic",
  name: "Claude",
  status: "ok",
  rows: [{ label: "5h Session", percentUsed: 30 }],
};

test("ProviderLimitsCache returns cached responses inside TTL unless forced", () => {
  const cache = new ProviderLimitsCache(60_000);
  const t0 = 1_000_000;
  cache.recordSuccess("anthropic", okResult, t0);

  const hit = cache.get("anthropic", "Claude", t0 + 10_000, false);
  assert.equal(hit?.cached, true);
  assert.equal(hit?.status, "ok");

  assert.equal(cache.get("anthropic", "Claude", t0 + 10_000, true), undefined);
  assert.equal(cache.get("anthropic", "Claude", t0 + 61_000, false), undefined);
});

test("ProviderLimitsCache enforces 429 cooldown even when forced", () => {
  const cache = new ProviderLimitsCache(60_000);
  const t0 = 2_000_000;
  cache.recordSuccess("anthropic", okResult, t0);
  const waitMs = cache.recordRateLimit("anthropic", "45", t0);
  assert.equal(waitMs, 45_000);

  const duringCooldown = cache.get("anthropic", "Claude", t0 + 10_000, true);
  assert.equal(duringCooldown?.status, "ok");
  assert.equal(duringCooldown?.cached, true);

  cache.invalidate();
  assert.equal(cache.get("anthropic", "Claude", t0 + 10_000, true), undefined);
});

test("parseRetryAfterMs parses integer seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("12", 1000), 12_000);
  assert.equal(parseRetryAfterMs("Wed, 25 Nov 2026 12:01:00 GMT", Date.parse("2026-11-25T12:00:00Z")), 60_000);
});
