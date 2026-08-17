import assert from "node:assert/strict";
import test from "node:test";
import {
  attachSessionEntryProvenance,
  compileBaselineSafeContext,
  compileProductionContext,
  contextAdoptionMode,
} from "../src/production-context-assembly.js";

test("passed adoption gate enables evidence assembly by default with an explicit safe override", () => {
  assert.equal(contextAdoptionMode(), "production");
  assert.equal(contextAdoptionMode("experimental"), "production");
  assert.equal(contextAdoptionMode("safe"), "safe");
  assert.equal(contextAdoptionMode("anything-else"), "safe");
  const messages = [
    { role: "user", content: "old requirement" },
    { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    { role: "user", content: "current task" },
  ];
  const anchor = { role: "custom", customType: "idea-anchor-v1", content: "confirmed goal", display: false };
  const result = compileBaselineSafeContext({ messages, anchorMessage: anchor, contextWindow: 100_000 });
  assert.equal(result.messages.length, messages.length + 1);
  assert.deepEqual(result.messages.slice(1), messages);
  assert.equal(result.manifest.selectionPolicy, "no-history-removal");
  assert.match(result.manifest.benchmarkStatus, /passed-fixed-5pct-sol-paired-gate/);
});
import { STATE_TYPE, sha256 } from "../src/core.js";

function user(id, content) {
  return { role: "user", id, timestamp: Number(id.replace(/\D/g, "")) || 1, content };
}

function assistant(id, content) {
  return { role: "assistant", id, timestamp: Number(id.replace(/\D/g, "")) || 1, stopReason: "stop", content };
}

test("Pi SessionEntry provenance survives into the compiler adapter", () => {
  const messages = attachSessionEntryProvenance([{
    type: "message",
    id: "entry-7",
    parentId: "entry-6",
    timestamp: "2026-08-13T00:00:00.000Z",
    message: user("u7", "ALPHA=3"),
  }], { sessionId: "session-real" });
  assert.equal(messages[0].sessionId, "session-real");
  assert.equal(messages[0].entryId, "entry-7");
  assert.equal(messages[0].parentEntryId, "entry-6");
  assert.equal(messages[0].entryTimestamp, "2026-08-13T00:00:00.000Z");
});

test("research-state coordinates are bound at the event's original position", () => {
  const idea = { version: 3, hash: "sha256:idea-v3", content: "Goal", confirmedAt: "2026-08-13T00:00:00Z" };
  const messages = attachSessionEntryProvenance([
    { type: "custom", customType: STATE_TYPE, data: { schema: 1, op: "idea-confirmed", idea } },
    { type: "custom", customType: STATE_TYPE, data: { schema: 1, op: "stage-set", stage: "stage-A" } },
    { type: "message", id: "entry-A", parentId: null, timestamp: 1, message: user("uA", "ALPHA=3") },
    { type: "custom", customType: STATE_TYPE, data: { schema: 1, op: "stage-set", stage: "stage-B" } },
    { type: "message", id: "entry-B", parentId: "entry-A", timestamp: 2, message: user("uB", "ALPHA=9") },
  ], { sessionId: "session-real" });
  assert.equal(messages[0].researchIdeaHash, idea.hash);
  assert.equal(messages[0].researchIdeaVersion, 3);
  assert.equal(messages[0].researchStageHash, sha256("stage-A"));
  assert.equal(messages[1].researchStageHash, sha256("stage-B"));
});

test("production assembly stops after relevant coverage instead of filling budget", () => {
  const messages = [
    user("u1", "ALPHA is 3."),
    assistant("a1", "Noted."),
    user("u2", "unrelated old note"),
    assistant("a2", "Noted again."),
    user("u3", "What is ALPHA?"),
  ];
  const result = compileProductionContext({
    messages,
    prompt: "What is ALPHA?",
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    liveTurns: 1,
  });
  const evidence = result.messages.find((message) => message.customType === "idea-evidence-context-v2");
  assert.match(evidence.content, /ALPHA is 3\./);
  assert.doesNotMatch(evidence.content, /unrelated old note/);
  assert.equal(result.manifest.assembly.selectionPolicy, "risk-adaptive-proof-carrying-evidence-ladder");
  assert.equal(result.manifest.hardOverflow, false);
});

test("indexed hot path only scans the recent message tail", () => {
  const messages = [];
  for (let index = 0; index < 2000; index += 1) {
    messages.push(user(`u${index}`, `old request ${index}`));
    messages.push(assistant(`a${index}`, `old answer ${index}`));
  }
  messages.push(user("u-final", "current request"));
  const result = compileProductionContext({
    messages,
    memoryBlocks: [],
    prompt: "current request",
    contextWindow: 100_000,
    liveTurns: 4,
    coldMessagesIndexed: true,
    indexSnapshot: { pendingEntries: 0 },
  });
  assert.equal(result.manifest.source.sourceMessages, messages.length);
  assert.ok(result.manifest.source.hotPathSourceMessages <= 9);
  assert.equal(result.manifest.source.coldMessagesIndexed, true);
});

test("mandatory evidence may cross the soft line but never the hard line", () => {
  const largeRelevant = `EVIDENCE-X ${"z".repeat(1900)}`;
  const result = compileProductionContext({
    messages: [user("u1", largeRelevant), user("u2", "show EVIDENCE-X")],
    prompt: "show EVIDENCE-X",
    contextWindow: 1_000,
    maxOutputTokens: 0,
    toolSchemaReserveTokens: 0,
    liveTurns: 1,
  });
  assert.equal(result.hardOverflow, false);
  assert.equal(result.manifest.expansionLevel, "S4");
  assert.deepEqual(result.manifest.expansionReasons, ["mandatory-closure-over-soft-limit"]);
  assert.ok(result.manifest.tokens.estimatedInput <= result.manifest.watermarks.hardLimit);
});

test("an over-hard mandatory closure becomes an explicit gap, not a truncated fact", () => {
  const hugeRelevant = `EVIDENCE-X ${"z".repeat(5000)}`;
  const result = compileProductionContext({
    messages: [user("u1", hugeRelevant), user("u2", "show EVIDENCE-X")],
    prompt: "show EVIDENCE-X",
    contextWindow: 1_000,
    maxOutputTokens: 0,
    toolSchemaReserveTokens: 0,
    liveTurns: 1,
  });
  assert.equal(result.hardOverflow, true);
  assert.equal(result.messages.some((message) => message.customType === "idea-evidence-context-v2"), false);
  assert.equal(result.messages.some((message) => message.customType === "idea-context-gap-v1"), true);
  assert.equal(result.manifest.gaps.some((gap) => gap.reason === "hard-limit"), true);
});
