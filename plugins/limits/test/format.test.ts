import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLimitsText,
  formatPercent,
  formatResetCountdown,
  renderBar,
} from "../dist/format.js";

test("formatPercent clamps and formats integers cleanly", () => {
  assert.equal(formatPercent(-5), "0%");
  assert.equal(formatPercent(26.0), "26%");
  assert.equal(formatPercent(19.54), "19.5%");
  assert.equal(formatPercent(120), "100%");
});

test("renderBar renders proportional filled blocks", () => {
  assert.equal(renderBar(0, 10), "[░░░░░░░░░░]");
  assert.equal(renderBar(50, 10), "[█████░░░░░]");
  assert.equal(renderBar(100, 10), "[██████████]");
});

test("formatResetCountdown handles short, multi-day, and past timestamps", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(formatResetCountdown("2026-11-25T11:59:00Z", now), "resetting");
  assert.equal(formatResetCountdown("2026-11-25T12:00:30Z", now), "resets <1m");
  assert.equal(formatResetCountdown("2026-11-25T12:18:00Z", now), "resets in 18m");
  assert.equal(formatResetCountdown("2026-11-25T14:14:00Z", now), "resets in 2h 14m");
  assert.equal(formatResetCountdown("2026-11-29T23:00:00Z", now), "resets in 4d 11h");
});

test("formatLimitsText prints clean multi-provider summary", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const text = formatLimitsText(
    {
      fetchedAtMs: now,
      providers: [
        {
          id: "opencode-go",
          name: "OpenCode Go",
          status: "ok",
          rows: [
            { label: "5h Rolling", percentUsed: 20, resetsAt: "2026-11-25T14:00:00Z" },
          ],
        },
        {
          id: "anthropic",
          name: "Claude",
          account: "Pro",
          status: "ok",
          cached: true,
          rows: [
            { label: "5h Session", percentUsed: 50, resetsAt: "2026-11-25T13:00:00Z" },
          ],
        },
      ],
    },
    now,
  );
  assert.match(text, /OpenCode Go/);
  assert.match(text, /5h Rolling/);
  assert.match(text, /Claude \(Pro\) \[cached\]/);
  assert.match(text, /resets in 2h/);
});
