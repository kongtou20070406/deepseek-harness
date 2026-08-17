import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_USAGE_URL,
  CodexUsageError,
  queryCodexSubscriptionUsage,
} from "../src/codex-usage.js";

function context({ modelBaseUrl = "https://chatgpt.com/backend-api/codex", authBaseUrl = modelBaseUrl } = {}) {
  const authorization = "Bearer oauth-secret-token";
  return {
    model: {
      provider: "openai-codex",
      id: "gpt-5.4-codex",
      name: "GPT 5.4 Codex",
      baseUrl: modelBaseUrl,
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, headers: { Authorization: authorization } };
      },
      async getProviderAuth() {
        return { auth: { baseUrl: authBaseUrl, headers: { Authorization: authorization } } };
      },
    },
  };
}

const payload = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_786_500_000 },
    secondary_window: { used_percent: 45, limit_window_seconds: 604_800, reset_at: 1_787_000_000 },
  },
  credits: { has_credits: false, unlimited: false },
};

test("Codex usage queries the official endpoint with only current Pi runtime authorization", async () => {
  let request;
  const result = await queryCodexSubscriptionUsage(context(), {
    salt: Buffer.alloc(32, 7),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(request.url, CODEX_USAGE_URL);
  assert.deepEqual(Object.keys(request.options.headers).sort(), ["Authorization", "User-Agent"]);
  assert.equal(request.options.headers.Authorization, "Bearer oauth-secret-token");
  assert.equal(result.bank.source, "usage-endpoint");
  assert.equal(result.bank.limits[0].primary.remainingPercent, 75);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /oauth-secret-token/);
});

test("Codex usage fails closed for custom or proxy origins", async () => {
  let called = false;
  await assert.rejects(
    queryCodexSubscriptionUsage(context({ modelBaseUrl: "https://proxy.example.test/codex" }), {
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    }),
    (error) => error instanceof CodexUsageError && error.code === "CODEX_UNSAFE_MODEL_ORIGIN",
  );
  assert.equal(called, false);

  await assert.rejects(
    queryCodexSubscriptionUsage(context({ authBaseUrl: "https://proxy.example.test/codex" }), {
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    }),
    (error) => error instanceof CodexUsageError && error.code === "CODEX_UNSAFE_AUTH_ORIGIN",
  );
  assert.equal(called, false);
});

test("Codex usage redacts OAuth secrets from endpoint errors", async () => {
  await assert.rejects(
    queryCodexSubscriptionUsage(context(), {
      fetchImpl: async () => new Response("invalid Bearer oauth-secret-token", {
        status: 401,
        statusText: "Unauthorized",
      }),
    }),
    (error) => {
      assert.equal(error.code, "CODEX_USAGE_HTTP_ERROR");
      assert.doesNotMatch(error.message, /oauth-secret-token/);
      assert.match(error.message, /<redacted>/);
      return true;
    },
  );
});
