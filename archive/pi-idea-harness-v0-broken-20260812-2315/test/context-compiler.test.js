import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_PACKET_MARKER,
  ContextBudgetError,
  ContextCompiler,
  estimateMessageTokens,
  estimateTextTokens,
} from "../src/context-compiler.js";
import { temporaryIdeaStore } from "./helpers.js";
import { sha256 } from "../src/idea-document.js";

test("P0 is the byte-identical prefix and packets are reused between substantive events", () => {
  const fixture = temporaryIdeaStore();
  try {
    const compiler = new ContextCompiler(fixture.store);
    const originalMessages = [{ role: "user", content: "继续当前实验", timestamp: 1 }];
    const first = compiler.compile({ messages: originalMessages, contextWindow: 128_000 });
    // Simulate a runtime that presents the previously injected packet again.
    // Free-form P0 must replace it instead of accumulating duplicate packets.
    const second = compiler.compile({ messages: first.messages, contextWindow: 128_000 });
    const p0 = fixture.store.getCurrentIdea().content;

    assert.equal(first.messages[0].content.slice(0, p0.length), p0);
    assert.equal(first.messages[0].content, `${p0}${CONTEXT_PACKET_MARKER}`);
    assert.equal(second.messages.length, first.messages.length);
    assert.equal(
      second.messages.filter((message) => message.content?.endsWith?.(CONTEXT_PACKET_MARKER)).length,
      1,
    );
    assert.equal(second.manifest.tokens.dynamic, estimateMessageTokens(originalMessages[0]));
    assert.equal(first.manifest.p0Hash, fixture.store.getCurrentIdea().hash);
    assert.equal(first.manifest.packetId, second.manifest.packetId);
    assert.equal(second.manifest.reused, true);
    assert.notEqual(first.manifest.invocationId, second.manifest.invocationId);
  } finally {
    fixture.cleanup();
  }
});

test("ten simulated compactions never alter or omit P0", () => {
  const fixture = temporaryIdeaStore();
  try {
    const compiler = new ContextCompiler(fixture.store);
    const p0 = fixture.store.getCurrentIdea();
    for (let index = 0; index < 10; index += 1) {
      compiler.invalidate(`compression-${index}`);
      const result = compiler.compile({
        messages: [{ role: "user", content: `压缩后的摘要 ${index}`, timestamp: index + 1 }],
        contextWindow: 128_000,
      });
      assert.equal(result.messages[0].content.slice(0, p0.content.length), p0.content);
      assert.equal(result.manifest.p0Hash, p0.hash);
      assert.equal(fixture.store.getCurrentIdea().hash, p0.hash);
    }
  } finally {
    fixture.cleanup();
  }
});

test("retrieval/history may be empty while protected Idea remains present", () => {
  const fixture = temporaryIdeaStore();
  try {
    const result = new ContextCompiler(fixture.store).compile({ messages: [], contextWindow: 128_000 });
    assert.equal(result.messages.length, 1);
    assert.equal(
      result.messages[0].content,
      `${fixture.store.getCurrentIdea().content}${CONTEXT_PACKET_MARKER}`,
    );
    assert.equal(result.manifest.tokens.dynamic, 0);
  } finally {
    fixture.cleanup();
  }
});

test("oversized P1 stops compilation and is never truncated", () => {
  const fixture = temporaryIdeaStore();
  try {
    const oversized = "证".repeat(5_000);
    fixture.store.updateP1(oversized, { actor: "test:main", reason: "budget test" });
    const compiler = new ContextCompiler(fixture.store);
    assert.throws(
      () => compiler.compile({ messages: [], contextWindow: 128_000 }),
      (error) => error instanceof ContextBudgetError && /没有自动截断/.test(error.message),
    );
    assert.equal(fixture.store.getCurrentP1().content.trim(), oversized);
  } finally {
    fixture.cleanup();
  }
});

test("CJK token estimate is conservative instead of chars divided by four", () => {
  assert.equal(estimateTextTokens("科学对象"), 4);
  assert.equal(estimateTextTokens("abcd"), 1);
});

test("stored Luna snapshots are audit-only and Pi native history remains intact", () => {
  const fixture = temporaryIdeaStore();
  try {
    const idea = fixture.store.getCurrentIdea();
    const p1 = fixture.store.getCurrentP1();
    const lunaPacket = "[Luna task context snapshot]\n当前任务：验证消融\n证据：收益在去除门控后消失\n[/Luna task context snapshot]";
    fixture.store.saveLunaSnapshot({
      id: "luna-compile-1",
      ideaVersion: idea.version,
      ideaHash: idea.hash,
      routeVersion: idea.routeVersion,
      p1Version: p1.version,
      sessionId: "main",
      cutoffTimestamp: 1_000,
      trigger: "new_evidence",
      task: "验证消融",
      constraints: [],
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-luna",
      candidateCount: 2,
      candidateTokens: 200,
      candidateHash: sha256("candidates"),
      selection: { selected: [], conflicts: [], excluded: [], unselectedCount: 2 },
      packetContent: lunaPacket,
      packetHash: sha256(lunaPacket),
      packetTokens: estimateTextTokens(lunaPacket),
      usage: { input: 200, output: 30 },
      diff: { added: [], removed: [], retained: [], taskChanged: false },
      createdAt: new Date(1_000).toISOString(),
    });
    const result = new ContextCompiler(fixture.store).compile({
      messages: [
        { role: "user", content: "很早的工程噪声", timestamp: 500 },
        { role: "user", content: "快照后的新问题", timestamp: 1_500 },
      ],
      contextWindow: 128_000,
    });
    assert.equal(result.messages[0].content.slice(0, idea.content.length), idea.content);
    assert.doesNotMatch(result.messages[0].content, /Luna task context snapshot/);
    assert.equal(result.messages.some((message) => message.content === "很早的工程噪声"), true);
    assert.equal(result.messages.some((message) => message.content === "快照后的新问题"), true);
    assert.equal(result.manifest.tokens.luna, 0);
    assert.equal(result.manifest.tokens.removedByLuna, 0);
    assert.equal(result.manifest.sources.some((source) => source.source.startsWith?.("luna:snapshot:")), false);
    assert.ok(result.manifest.excluded.some((item) => item.reason === "disabled_in_favor_of_pi_native_compaction"));
  } finally {
    fixture.cleanup();
  }
});
