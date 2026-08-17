import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCodexBankDetails,
  formatCodexBankLabel,
  parseCodexBankHeaders,
  parseCodexUsagePayload,
} from "../src/codex-bank.js";

test("Codex usage accepts authoritative response-header windows as a fallback", () => {
  const bank = parseCodexBankHeaders({
    "x-codex-primary-used-percent": "12.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1786500000",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1787000000",
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-unlimited": "false",
    "x-codex-credits-balance": "$12.50",
  });
  assert.equal(bank.limits[0].primary.remainingPercent, 87.5);
  assert.equal(bank.limits[0].secondary.remainingPercent, 60);
  assert.equal(bank.source, "response-headers");
  assert.equal(formatCodexBankLabel(bank), "Codex 87.5% 5h / 60% wk");
});

test("Codex usage endpoint supports plan, reset credits, and a current-model bucket", () => {
  const bank = parseCodexUsagePayload({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_786_500_000 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: 1_787_000_000 },
    },
    additional_rate_limits: [{
      limit_name: "Codex Spark",
      metered_feature: "codex_spark",
      rate_limit: {
        primary_window: { used_percent: 8, limit_window_seconds: 18_000, reset_at: 1_786_500_100 },
      },
    }],
    credits: { has_credits: true, unlimited: false, balance: 12.5 },
    rate_limit_reset_credits: { available_count: 2 },
  });
  const model = { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" };
  assert.equal(bank.source, "usage-endpoint");
  assert.equal(formatCodexBankLabel(bank, model), "Codex spark 92% 5h");
  assert.match(formatCodexBankDetails(bank, model), /当前模型额度 · Codex Spark/);
  assert.match(formatCodexBankDetails(bank, model), /可用 usage-limit resets：2/);
});

test("Codex usage stays unknown when no verified fields are returned", () => {
  assert.equal(parseCodexBankHeaders({ date: "today", server: "example" }), null);
  assert.equal(formatCodexBankLabel(null), "Codex —");
  assert.throws(() => parseCodexUsagePayload({ plan_type: "plus" }), /没有可显示/);
});
