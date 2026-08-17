import assert from "node:assert/strict";
import test from "node:test";
import {
  blockizeMessages,
  compileBidirectionalContext,
  structuralDropCertificates,
} from "./compiler.mjs";

test("blockizer separates thinking, tool call, result and final text with call lineage", () => {
  const messages = [
    { role: "user", id: "u1", timestamp: 1, content: "检查文件 A" },
    { role: "assistant", id: "a1", stopReason: "toolUse", content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "我先读取。" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "A" } },
    ] },
    { role: "toolResult", id: "r1", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "VALUE=7" }] },
    { role: "assistant", id: "a2", stopReason: "stop", content: [{ type: "text", text: "结果是 7。" }] },
  ];
  const blocks = blockizeMessages(messages);
  assert.deepEqual(blocks.map((block) => block.kind), ["user_text", "assistant_thinking", "assistant_public", "tool_call", "tool_result", "assistant_final"]);
  assert.equal(blocks.find((block) => block.kind === "tool_call").callId, "c1");
  assert.equal(blocks.find((block) => block.kind === "tool_result").callId, "c1");
  assert.equal(blocks.find((block) => block.kind === "assistant_thinking").factCandidate, false);
});

test("structural GC never treats low similarity or age as a deletion certificate", () => {
  const blocks = blockizeMessages([
    { role: "user", id: "old", timestamp: 1, content: "罕见反证 ZETA-91" },
    { role: "custom", id: "noise", customType: "progress-status", content: "working 70%" },
    { role: "assistant", id: "think", content: [{ type: "thinking", thinking: "scratch" }] },
  ]);
  const certificates = structuralDropCertificates(blocks);
  assert.equal(certificates.has(blocks[0].blockId), false);
  assert.equal(certificates.get(blocks[1].blockId).ruleId, "UI_NOISE");
  assert.equal(certificates.get(blocks[2].blockId).ruleId, "NON_FACT_REASONING");
});

test("KEEP reachability overrides a DROP candidate and preserves a tool transaction", () => {
  const messages = [
    { role: "assistant", id: "a", stopReason: "toolUse", content: [{ type: "toolCall", id: "c9", name: "test", arguments: { target: "OMEGA" } }] },
    { role: "toolResult", id: "r", toolCallId: "c9", toolName: "test", fresh: true, content: [{ type: "text", text: "OMEGA failed with E17" }] },
    { role: "user", id: "u", content: "继续诊断 E17" },
  ];
  const result = compileBidirectionalContext({ messages, query: "诊断 E17", condition: "bidirectional", budget: 500 });
  const call = result.blocks.find((block) => block.kind === "tool_call");
  const tool = result.blocks.find((block) => block.kind === "tool_result");
  assert.equal(result.manifest.roots.some((root) => root.blockId === tool.blockId), true);
  assert.equal(result.manifest.retained.some((row) => row.blockId === tool.blockId), true);
  // tool_call is not rendered as factual evidence, but remains in the KEEP graph
  assert.equal(result.manifest.dropped.some((row) => row.blockId === call.blockId), false);
});

test("explicit supersession needs a shared state key and KEEP still wins", () => {
  const first = { role: "user", id: "old", content: "K=12", stateKey: "K", stateVersion: 1 };
  let blocks = blockizeMessages([first]);
  const olderId = blocks[0].blockId;
  const second = { role: "user", id: "new", content: "K=17", stateKey: "K", stateVersion: 2, supersedes: [olderId] };
  blocks = blockizeMessages([first, second]);
  const certificates = structuralDropCertificates(blocks);
  assert.equal(certificates.get(blocks[0].blockId).ruleId, "EXPLICIT_SUPERSESSION");
  const historyQuery = compileBidirectionalContext({ messages: [first, second], query: "旧值 K=12 是什么", condition: "bidirectional", budget: 500, liveBlocks: 0 });
  assert.equal(historyQuery.selectedBlocks.some((block) => block.raw === "K=12"), true);
});

test("same input creates the same context and manifest hashes", () => {
  const options = {
    messages: [
      { role: "user", id: "u1", content: "参数 ALPHA=3" },
      { role: "assistant", id: "a1", content: "收到。" },
      { role: "user", id: "u2", content: "参数 BETA=9" },
    ],
    query: "ALPHA 是多少",
    condition: "bidirectional-heat",
    budget: 100,
  };
  const first = compileBidirectionalContext(options);
  const second = compileBidirectionalContext(options);
  assert.equal(first.context, second.context);
  assert.equal(first.manifest.inputEventDigest, second.manifest.inputEventDigest);
  assert.equal(first.manifest.outputHash, second.manifest.outputHash);
});

test("rendered evidence metadata is included in the hard token budget", () => {
  const result = compileBidirectionalContext({
    messages: [
      { role: "user", id: "u1", content: "ALPHA is 3." },
      { role: "user", id: "u2", content: "BETA is 9." },
      { role: "user", id: "u3", content: "GAMMA is 12." },
    ],
    query: "unrelated request",
    condition: "gc-only",
    budget: 120,
    liveBlocks: 0,
  });
  assert.equal(result.overflow, false);
  assert.ok(result.contextTokens <= 120);
  assert.equal(result.contextTokens, result.manifest.tokens.rendered);
  assert.ok(result.manifest.tokens.rendered > result.manifest.tokens.rawSelected);
});

test("heat never resurrects UNKNOWN content without marginal task coverage", () => {
  const messages = [
    { role: "user", id: "u1", content: "ALPHA old observation" },
    { role: "user", id: "u2", content: "BETA one-off observation" },
    { role: "user", id: "u3", content: "ALPHA follow-up" },
    { role: "user", id: "u4", content: "ALPHA latest follow-up" },
  ];
  const base = compileBidirectionalContext({ messages, query: "unrelated", condition: "bidirectional", budget: 55, liveBlocks: 0 });
  const heated = compileBidirectionalContext({ messages, query: "unrelated", condition: "bidirectional-heat", budget: 55, liveBlocks: 0 });
  assert.equal(base.overflow, false);
  assert.equal(heated.overflow, false);
  assert.equal(base.context, "");
  assert.equal(heated.context, "");
  assert.deepEqual(heated.manifest.deferred.map((row) => row.reason), Array(4).fill("no-marginal-coverage"));
  assert.equal(heated.manifest.dropped.length, 0);
});

test("coverage-stop does not fill a large remaining budget with unrelated history", () => {
  const result = compileBidirectionalContext({
    messages: [
      { role: "user", id: "u1", content: "ALPHA is 3." },
      { role: "user", id: "u2", content: "unrelated note one" },
      { role: "user", id: "u3", content: "unrelated note two" },
    ],
    query: "What is ALPHA?",
    condition: "bidirectional",
    budget: 10_000,
    liveBlocks: 0,
  });
  assert.deepEqual(result.selectedBlocks.map((block) => block.raw), ["ALPHA is 3."]);
  assert.equal(result.manifest.selectionPolicy, "coverage-stop");
  assert.equal(result.manifest.deferred.length, 2);
  assert.ok(result.contextTokens < 100);
});

test("raw control keeps every factual block or overflows atomically", () => {
  const messages = [
    { role: "user", id: "u1", content: "ALPHA is 3." },
    { role: "assistant", id: "a1", content: "Noted." },
    { role: "user", id: "u2", content: "BETA is 9." },
  ];
  const raw = compileBidirectionalContext({ messages, query: "ALPHA", condition: "raw", budget: 500, liveBlocks: 0 });
  assert.equal(raw.overflow, false);
  assert.deepEqual(raw.selectedBlocks.map((block) => block.raw), ["ALPHA is 3.", "Noted.", "BETA is 9."]);
  const overflow = compileBidirectionalContext({ messages, query: "ALPHA", condition: "raw", budget: 10, liveBlocks: 0 });
  assert.equal(overflow.overflow, true);
  assert.equal(overflow.manifest.reason, "mandatory-closure-over-budget");
});

test("model-generated aliases are ignored rather than becoming selector signals", () => {
  const messages = [
    { role: "user", id: "u1", content: "测量响应为73。" },
    { role: "user", id: "u2", content: "界面颜色为蓝色。" },
  ];
  const base = {
    messages,
    query: "钴蓝结果是什么",
    condition: "bidirectional",
    budget: 20,
    liveBlocks: 0,
  };
  const withoutAlias = compileBidirectionalContext(base);
  const withAlias = compileBidirectionalContext({
    ...base,
    lunaFeatures: [{ quote: "测量响应为73。", retrievalCues: ["钴蓝结果"] }],
  });
  assert.equal(withAlias.context, withoutAlias.context);
  assert.equal(withAlias.manifest.outputHash, withoutAlias.manifest.outputHash);
  assert.equal(Object.hasOwn(withAlias.manifest, "lunaFeatures"), false);
});

test("local authority breaks similar lexical matches without deleting assistant history", () => {
  const result = compileBidirectionalContext({
    messages: [
      { role: "user", id: "u0", content: "An earlier generic discussion was recorded." },
      { role: "assistant", id: "a1", content: "Court case discussion groups can involve discussion and court analysis." },
      { role: "user", id: "u1", content: "I enjoy court case discussion groups." },
    ],
    query: "Which court case discussion activity fits the user?",
    condition: "bidirectional",
    budget: 100,
    liveBlocks: 0,
    maxPositiveKeeps: 1,
  });
  assert.equal(result.overflow, false);
  assert.deepEqual(result.selectedBlocks.map((block) => block.raw), ["I enjoy court case discussion groups."]);
  assert.equal(result.manifest.dropped.length, 0);
});

test("current research-state compatibility breaks context-confusable ties without deleting history", () => {
  const messages = [
    {
      role: "user",
      id: "old-stage",
      content: "ALPHA measurement is 3 in old-stage.",
      researchIdeaHash: "idea-1",
      researchStageHash: "stage-old",
    },
    {
      role: "user",
      id: "current-stage",
      content: "ALPHA measurement is 9 in current-stage.",
      researchIdeaHash: "idea-1",
      researchStageHash: "stage-current",
    },
  ];
  const current = compileBidirectionalContext({
    messages,
    query: "What is the ALPHA measurement?",
    condition: "bidirectional",
    budget: 100,
    liveBlocks: 0,
    maxPositiveKeeps: 1,
    activeContext: { ideaHash: "idea-1", stageHash: "stage-current" },
  });
  assert.deepEqual(current.selectedBlocks.map((block) => block.raw), ["ALPHA measurement is 9 in current-stage."]);
  assert.equal(current.manifest.recallFrame.contextualRanking, true);
  assert.equal(current.manifest.dropped.length, 0);

  const historical = compileBidirectionalContext({
    messages,
    query: "What was the previous ALPHA measurement in old-stage?",
    condition: "bidirectional",
    budget: 100,
    liveBlocks: 0,
    maxPositiveKeeps: 1,
    activeContext: { ideaHash: "idea-1", stageHash: "stage-current" },
  });
  assert.deepEqual(historical.selectedBlocks.map((block) => block.raw), ["ALPHA measurement is 3 in old-stage."]);
  assert.equal(historical.manifest.recallFrame.contextualRanking, false);
});
