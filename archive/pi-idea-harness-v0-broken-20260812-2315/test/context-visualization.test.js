import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateContextBar,
  buildContextComposition,
  formatRelativeTime,
} from "../src/context-visualization.js";

test("context composition exposes every actual model-input source", () => {
  const composition = buildContextComposition({
    tokens: { p0: 100, p1: 200, luna: 300, dynamic: 400, control: 10 },
    budget: {
      contextWindow: 2_000,
      outputReserve: 200,
      safetyMargin: 100,
      systemTokens: 250,
      toolTokens: 150,
    },
  });
  assert.deepEqual(
    Object.fromEntries(composition.segments.map((segment) => [segment.key, segment.tokens])),
    { p0: 100, p1: 200, luna: 300, dynamic: 400, system: 260, tools: 150 },
  );
  assert.equal(composition.used, 1_410);
  assert.equal(composition.free, 290);
});

test("context bar maps used tokens to the full window and leaves the remainder empty", () => {
  const composition = buildContextComposition({
    tokens: { p0: 1, p1: 2, luna: 3, dynamic: 900, control: 1 },
    budget: { contextWindow: 2_000, systemTokens: 50, toolTokens: 40 },
  });
  const bar = allocateContextBar(composition, 24);
  const expectedUsed = Math.round(24 * composition.used / composition.contextWindow);
  assert.equal(bar.usedColumns, expectedUsed);
  assert.equal(bar.emptyColumns, 24 - expectedUsed);
  assert.equal(bar.segments.reduce((sum, segment) => sum + segment.columns, 0), expectedUsed);
  assert.equal(bar.segments.every((segment) => segment.columns >= 1), true);
  assert.equal(bar.columns, 24);
});

test("relative update time is readable rather than a version counter", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-08-12T10:00:00.000Z", now), "2小时前");
});
