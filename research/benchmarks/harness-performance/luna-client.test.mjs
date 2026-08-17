import assert from "node:assert/strict";
import test from "node:test";
import { parsePiAuthCheck } from "./luna-client.mjs";

test("Pi auth readiness follows the 0.84.1 JSON ready contract", () => {
  assert.deepEqual(parsePiAuthCheck('{"status":"ready","provider":"openai-codex","authType":"oauth"}', "openai-codex", 0), {
    provider: "openai-codex",
    ready: true,
    exitCode: 0,
    status: "ready",
    authType: "oauth",
  });
  assert.equal(parsePiAuthCheck('{"status":"invalid","provider":"openai-codex"}', "openai-codex", 1).ready, false);
  assert.equal(parsePiAuthCheck("not-json", "openai-codex", 0).ready, false);
});
