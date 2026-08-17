import test from "node:test";
import assert from "node:assert/strict";
import {
  compileContext,
  compileDualTrackContext,
  evidenceTagPrompt,
  groupTurns,
  makeFoldUnits,
  parseEvidenceTags,
  summaryPrompt,
} from "../src/context-compiler.js";

function turn(index, body = `内容 ${index}`) {
  return [
    { role: "user", content: `任务 ${index}` },
    { role: "assistant", content: [{ type: "text", text: body }] },
  ];
}

test("grouping never separates a tool result from its turn", () => {
  const messages = [
    { role: "user", content: "检查" },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: "结果" }] },
    { role: "assistant", content: [{ type: "text", text: "完成" }] },
    { role: "user", content: "下一项" },
  ];
  const blocks = groupTurns(messages);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].messages.length, 4);
});

test("fold blocks preserve event lineage while only raw factual events become retrieval candidates", () => {
  const messages = [
    { role: "user", content: "检查蓝盒", sessionId: "s1", branchId: "b1", timestamp: 10 },
    { role: "assistant", parentId: "u1", content: [
      { type: "thinking", thinking: "REASONING_SECRET_91" },
      { type: "toolCall", id: "call-7", name: "read", arguments: { path: "TOOL_CALL_SECRET_82" } },
    ] },
    { role: "toolResult", parentId: "a1", toolCallId: "call-7", toolName: "read", content: [{ type: "text", text: "工具原始结果 KEY-44。" }], timestamp: 11 },
    { role: "custom", customType: "idea-tag-v1", content: "DERIVED_SECRET_73" },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "历史判断：KEY-44 可用。" }] },
    ...turn(2, "当前工作"),
    ...turn(3, "最新工作"),
  ];
  const blocks = groupTurns(messages);
  const events = blocks[0].events;
  assert.equal(events.some((event) => event.eventType === "reasoning_summary" && event.factCandidate === false), true);
  assert.equal(events.some((event) => event.eventType === "tool_call" && event.callId === "call-7" && event.factCandidate === false), true);
  assert.equal(events.some((event) => event.eventType === "tool_result" && event.callId === "call-7" && event.factCandidate === true), true);
  assert.equal(events.some((event) => event.eventType === "tag" && event.factCandidate === false), true);
  assert.equal(events.every((event) => /^sha256:[a-f0-9]{64}$/.test(event.rawHash)), true);
  const compiled = compileContext({
    messages,
    prompt: "KEY-44 SECRET",
    liveTurns: 2,
    retrievalBudget: 100,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
    localEvidenceIndex: true,
  });
  const injected = compiled.messages.map((message) => String(message.content || "")).join("\n");
  assert.match(injected, /工具原始结果 KEY-44/);
  assert.doesNotMatch(injected, /REASONING_SECRET_91|TOOL_CALL_SECRET_82|DERIVED_SECRET_73/);
  const toolPassage = compiled.selectedPassages.find((passage) => passage.eventType === "tool_result");
  assert.equal(toolPassage.callId, "call-7");
  assert.equal(toolPassage.evidenceClass, "tool-raw");
  assert.match(toolPassage.eventRawHash, /^sha256:[a-f0-9]{64}$/);
});

test("tool-use assistant text is historical judgment, not a final or primary raw source", () => {
  const blocks = groupTurns([
    { role: "user", content: "继续" },
    { role: "assistant", stopReason: "toolUse", content: [
      { type: "text", text: "先读取资料。" },
      { type: "toolCall", id: "call-9", name: "read", arguments: { path: "x" } },
    ] },
    { role: "toolResult", toolCallId: "call-9", toolName: "read", content: [{ type: "text", text: "PRIMARY-91" }] },
  ]);
  const events = blocks[0].events;
  assert.equal(events.some((event) => event.eventType === "final"), false);
  assert.equal(events.some((event) => event.eventType === "assistant_public" && event.factCandidate), true);
  assert.equal(events.some((event) => event.eventType === "tool_result" && event.factCandidate), true);
});

test("fold units are always rooted in raw block ids", () => {
  const blocks = groupTurns([...turn(1), ...turn(2), ...turn(3)]);
  const units = makeFoldUnits(blocks, { minTokens: 1, maxTokens: 1000 });
  assert.equal(units.length, 3);
  assert.deepEqual(units[0].blockIds, [blocks[0].id]);
  assert.match(summaryPrompt(units[0], "sha256:idea"), new RegExp(units[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("evidence tags require a grounded raw quote and normalize enum fields", () => {
  const unit = makeFoldUnits(groupTurns(turn(1, "用户确认 KAPPA = 0.37；旧值 0.42 已否决。")), { minTokens: 1, maxTokens: 1000 })[0];
  const parsed = parseEvidenceTags(JSON.stringify({ claims: [
    {
      evidenceId: null,
      claim: "确认参数为 0.37",
      quote: "用户确认 KAPPA=0.37；旧值 0.42 已否决。",
      kind: "decision",
      authority: "user",
      status: "active",
      entities: ["KAPPA", "KAPPA"],
      retrievalCues: ["Which parameter value should the next run use?", "Which parameter value should the next run use?"],
      thematicScopes: ["sparse operator benchmark", "sparse operator benchmark"],
      eventType: "parameter decision",
      entityRoles: ["hyperparameter", "rejected value"],
      links: [{ type: "supersedes", target: "0.42" }],
    },
    { claim: "模型凭空补充", quote: "原始块中不存在的句子", kind: "decision" },
  ] }), unit, { ideaHash: "sha256:idea", stageHash: "sha256:stage" });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.claims.length, 1);
  assert.equal(parsed.rejected, 1);
  assert.match(parsed.claims[0].quote, /KAPPA = 0\.37/);
  assert.deepEqual(parsed.claims[0].entities, ["KAPPA"]);
  assert.deepEqual(parsed.claims[0].retrievalCues, ["Which parameter value should the next run use?"]);
  assert.deepEqual(parsed.claims[0].thematicScopes, ["sparse operator benchmark"]);
  assert.deepEqual(parsed.claims[0].eventTypes, ["parameter decision"]);
  assert.deepEqual(parsed.claims[0].entityRoles, ["hyperparameter", "rejected value"]);
  assert.match(parsed.claims[0].rawHash, /^sha256:[a-f0-9]{64}$/);
  const prompt = evidenceTagPrompt(unit, { ideaHash: "identity-only" });
  assert.match(prompt, /Idea identity: identity-only/);
  assert.match(prompt, /retrievalCues/);
  assert.match(prompt, /thematicScopes\/eventTypes\/entityRoles/);
});

test("default fold units batch stable work instead of creating tiny summaries", () => {
  const blocks = groupTurns(Array.from({ length: 16 }, (_, index) => turn(index, "x".repeat(1200))).flat());
  const units = makeFoldUnits(blocks);
  assert.ok(units.length < blocks.length / 2);
  assert.equal(units.slice(0, -1).every((unit) => unit.stable), true);
  assert.equal(units.every((unit) => unit.tokens <= 7200), true);
});

test("compiler keeps live turns, retrieves relevant folded block, and omits unrelated cold work", () => {
  const messages = [
    ...turn(1, "无关 UI 颜色"),
    ...turn(2, "实验发现算子在稀疏矩阵上提升 17%"),
    ...turn(3, "无关安装日志"),
    ...turn(4, "当前实现"),
    ...turn(5, "最近验证"),
  ];
  const cold = makeFoldUnits(groupTurns(messages).slice(0, 3), { minTokens: 1, maxTokens: 1000 });
  const summaries = new Map(cold.map((unit, index) => [unit.id, {
    summary: index === 1 ? "稀疏矩阵实验提升 17%" : `无关摘要 ${index}`,
    tokens: 10,
  }]));
  const result = compileContext({
    messages,
    prompt: "稀疏矩阵实验是多少",
    summaries,
    liveTurns: 2,
    retrievalBudget: 100,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  assert.equal(result.selected.some((item) => item.summary.includes("17%")), true);
  assert.deepEqual(result.messages.slice(-4), messages.slice(-4));
  assert.ok(result.metrics.compiledTokens < result.metrics.rawTokens);
});

test("compiler never performs recursive summarization", () => {
  const messages = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
  const result = compileContext({ messages, liveTurns: 2 });
  assert.equal(result.coldUnits.every((unit) => unit.text.includes("USER") && !unit.text.includes("folded_context")), true);
});

test("unsummarized cold work remains raw until a derived fold exists", () => {
  const messages = [...turn(1, "尚未折叠的关键事实"), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
  const result = compileContext({
    messages,
    prompt: "新的无关问题",
    liveTurns: 2,
    retrievalBudget: 1000,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  assert.equal(result.selected.some((item) => item.injectMode === "raw-pending"), true);
  assert.match(result.messages[0].content, /尚未折叠的关键事实/);
});

test("exact verification requests retrieve the original raw block", () => {
  const messages = [
    ...turn(1, "原始测量 ID QX-771，提升 13.25%"),
    ...turn(2, "中间步骤"),
    ...turn(3, "当前工作"),
    ...turn(4, "最新工作"),
  ];
  const cold = makeFoldUnits(groupTurns(messages).slice(0, 2), { minTokens: 1, maxTokens: 1000 });
  const summaries = new Map(cold.map((unit) => [unit.id, {
    summary: unit.text.includes("QX-771") ? "QX-771 的测量已完成" : "中间步骤摘要",
    tokens: 12,
  }]));
  const result = compileContext({
    messages,
    prompt: "请逐字核验 QX-771 的原始数值",
    summaries,
    liveTurns: 2,
    retrievalBudget: 1000,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  assert.equal(result.selected.some((item) => item.injectMode === "raw-verified"), true);
  assert.match(result.messages[0].content, /13\.25%/);
});

test("P0 stays out of generic retrieval while prompt and stage select evidence", () => {
  const messages = [
    ...turn(1, "用户最终确认运行参数 KAPPA=0.37；0.42 是已否决的过期候选。"),
    ...turn(2, "完成无关的界面检查"),
    ...turn(3, "完成无关的安装检查"),
    ...turn(4, "旧配置文件仍残留 KAPPA=0.42，尚未更新。"),
    ...turn(5, "准备生成最终配置"),
    ...turn(6, "等待写入"),
  ];
  const cold = makeFoldUnits(groupTurns(messages).slice(0, 4), { minTokens: 1, maxTokens: 1000 });
  const summaries = new Map(cold.map((unit) => [unit.id, {
    summary: unit.text.includes("0.37")
      ? "用户确认 KAPPA=0.37；0.42 已否决"
      : unit.text.includes("旧配置") ? "旧配置文件残留 KAPPA=0.42" : "无关工作",
    tokens: 14,
  }]));
  const idea = "只使用用户最后确认的运行参数；已否决候选和旧配置不得覆盖确认值。";
  const options = {
    messages,
    prompt: "生成最终配置",
    stage: "把已确认参数写入配置",
    summaries,
    liveTurns: 2,
    retrievalBudget: 20,
    maxRetrievedUnits: 1,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  };
  const result = compileContext({ ...options, idea });
  const changedP0 = compileContext({ ...options, idea: "完全不同的科学对象与路线边界 ZXQ-991" });
  assert.equal(result.selected.length, 1);
  assert.match(result.selected[0].summary, /0\.37/);
  assert.deepEqual(changedP0.selected.map((item) => item.id), result.selected.map((item) => item.id));
  assert.equal(result.coldUnits.some((unit) => unit.text.includes(idea)), false);
});

test("typed evidence index selects claims, drops routine labels, and keeps P0 out of derived evidence", () => {
  const idea = "绝密P0正文：最后确认参数优先于过期配置。";
  const messages = [
    ...turn(1, "用户最后确认 KAPPA=0.37，旧配置 0.42 已过期。"),
    ...turn(2, "例行检查，没有新的方向性结论。"),
    ...turn(3, "旧配置文件仍残留 KAPPA=0.42。"),
    ...turn(4, "无关工作"),
    ...turn(5, "准备生成配置"),
    ...turn(6, "等待写入"),
  ];
  const units = makeFoldUnits(groupTurns(messages).slice(0, 4), { minTokens: 1, maxTokens: 1000 });
  const tags = [
    { claim: "MODEL_GENERATED_CLAIM_991", quote: "用户最后确认 KAPPA=0.37，旧配置 0.42 已过期。", kind: "decision", authority: "user", status: "active", entities: ["KAPPA", "确认参数"], retrievalCues: ["PRIVATE_CUE_884"], thematicScopes: ["PRIVATE_SCOPE_773"] },
    { claim: "没有新的方向性结论", quote: "例行检查，没有新的方向性结论。", kind: "other", authority: "tool", status: "unknown", entities: ["方向性结论"] },
    { claim: "旧文件残留 KAPPA=0.42", quote: "旧配置文件仍残留 KAPPA=0.42。", kind: "observation", authority: "tool", status: "superseded", entities: ["KAPPA", "旧配置"] },
    { claim: "无关工作", quote: "无关工作", kind: "other", authority: "tool", status: "unknown", entities: ["无关"] },
  ];
  const index = new Map(units.map((unit, index) => {
    const parsed = parseEvidenceTags(JSON.stringify({ claims: [tags[index]] }), unit, { ideaHash: "sha256:idea" });
    return [unit.id, { claims: parsed.claims }];
  }));
  const result = compileContext({
    messages,
    idea,
    prompt: "最终配置中的 KAPPA 应该是多少",
    stage: "生成确认配置",
    summaries: index,
    liveTurns: 2,
    retrievalBudget: 300,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  assert.equal(result.metrics.mode, "typed-evidence-index");
  assert.equal(result.selectedClaims.some((claim) => /MODEL_GENERATED_CLAIM_991/.test(claim.claim)), true);
  assert.equal(result.selectedClaims.some((claim) => /没有新的方向性结论/.test(claim.claim)), false);
  assert.match(result.messages[0].content, /用户最后确认 KAPPA=0\.37/);
  assert.equal(result.selectedPassages.some((passage) => /0\.37/.test(passage.quote)), true);
  assert.doesNotMatch(result.messages[0].content, /MODEL_GENERATED_CLAIM_991|PRIVATE_CUE_884|PRIVATE_SCOPE_773/);
  assert.doesNotMatch(result.messages[0].content, /kind=|authority=user|status=active/);
  assert.doesNotMatch(result.messages[0].content, /绝密P0正文/);
});

test("strict typed evidence index never falls back to raw on a zero lexical match", () => {
  const messages = [...turn(1, "事实甲"), ...turn(2, "事实乙"), ...turn(3, "事实丙"), ...turn(4, "当前工作"), ...turn(5, "最新工作")];
  const units = makeFoldUnits(groupTurns(messages).slice(0, 3), { minTokens: 1, maxTokens: 1000 });
  const index = new Map(units.map((unit) => {
    const quote = unit.text.match(/事实[甲乙丙]/)?.[0];
    const parsed = parseEvidenceTags(JSON.stringify({ claims: [{ claim: quote, quote, kind: "observation", authority: "experiment", status: "active", entities: [quote] }] }), unit);
    return [unit.id, { claims: parsed.claims }];
  }));
  const result = compileContext({
    messages,
    idea: "完全不同对象",
    prompt: "ZXQ-UNSEEN-777",
    stage: "陌生任务",
    summaries: index,
    liveTurns: 2,
    retrievalBudget: 1000,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
    strictEvidenceIndex: true,
  });
  assert.equal(result.metrics.rawFallbackCount, 0);
  assert.equal(result.metrics.indexComplete, true);
  assert.equal(result.selectedClaims.length, 0);
  assert.equal(result.messages.some((message) => /raw-low-confidence/.test(String(message.content || ""))), false);
});

test("strict evidence mode exposes pending blocks without injecting their raw text", () => {
  const messages = [
    ...turn(1, "尚未标注的秘密结果 SECRET-441"),
    ...turn(2, "中间工作"),
    ...turn(3, "当前工作"),
    ...turn(4, "最新工作"),
  ];
  const result = compileContext({
    messages,
    prompt: "SECRET-441",
    summaries: new Map(),
    liveTurns: 2,
    retrievalBudget: 1000,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
    strictEvidenceIndex: true,
  });
  assert.ok(result.metrics.pendingIndexCount > 0);
  assert.equal(result.metrics.indexComplete, false);
  assert.equal(result.messages.some((message) => /SECRET-441/.test(String(message.content || ""))), false);
});

test("local raw passage index retrieves grounded evidence without Luna labels", () => {
  const messages = [
    ...turn(1, "用户最后确认 kappa 固定为 0.37，旧候选 0.42 已经过期。"),
    ...turn(2, "普通格式检查通过，没有新的方向性结论。"),
    ...turn(3, "当前实现工作"),
    ...turn(4, "最新工作"),
  ];
  const result = compileContext({
    messages,
    idea: "必须使用用户最后确认的参数",
    prompt: "kappa 最终是多少",
    summaries: new Map(),
    liveTurns: 2,
    retrievalBudget: 300,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
    localEvidenceIndex: true,
  });
  assert.equal(result.metrics.mode, "local-raw-passage-index");
  assert.equal(result.metrics.pendingIndexCount, 0);
  assert.equal(result.selectedPassages.some((item) => /0\.37/.test(item.quote)), true);
  assert.match(result.messages[0].content, /quote_hash=/);
  assert.equal(result.messages[0].content.includes("普通格式检查"), false);
});

test("auditable loop signals can change per-loop retrieval without consulting P0", () => {
  const messages = [
    ...turn(1, "FRESH-77 对应蓝盒。"),
    ...turn(2, "OLD-22 对应红盒。"),
    ...turn(3, "当前工作"),
    ...turn(4, "最新工作"),
  ];
  const options = {
    messages,
    prompt: "继续处理",
    stage: "核对本轮结果",
    loopSignals: {
      phase: "after-tool",
      lastEventType: "tool_result",
      lastToolType: "experiment",
      freshEvidenceIds: ["FRESH-77"],
      freshResultStatus: ["success"],
      previousRequestedAction: "核验蓝盒",
    },
    liveTurns: 2,
    retrievalBudget: 100,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
    localEvidenceIndex: true,
  };
  const first = compileContext({ ...options, idea: "P0-A" });
  const second = compileContext({ ...options, idea: "P0-B entirely different" });
  assert.equal(first.selectedPassages.some((passage) => /FRESH-77/.test(passage.quote)), true);
  assert.deepEqual(second.selectedPassages.map((passage) => passage.quoteHash), first.selectedPassages.map((passage) => passage.quoteHash));
  assert.equal(first.metrics.retrievalSignals.lastEventType, "tool_result");
  assert.deepEqual(first.metrics.retrievalSignals.freshEvidenceIds, ["FRESH-77"]);
  assert.match(first.metrics.retrievalQueryHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.selectedPassages.every((passage) => Boolean(passage.candidateSource && passage.selectionReason)), true);
});

test("dual track immediately uses local raw evidence while Luna index is incomplete", () => {
  const messages = [
    ...turn(1, "用户确认关键参数 OMEGA=17，旧值 12 已否决。"),
    ...turn(2, "实验结果显示 OMEGA=17 可以复现。"),
    ...turn(3, "当前工作"),
    ...turn(4, "最新工作"),
  ];
  const started = performance.now();
  const result = compileDualTrackContext({
    messages,
    idea: "保持最后确认参数",
    prompt: "OMEGA 最终是多少",
    summaries: new Map(),
    liveTurns: 2,
    retrievalBudget: 300,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  assert.equal(result.track, "local-fallback");
  assert.equal(result.enhancedReady, false);
  assert.ok(result.pendingIndexCount > 0);
  assert.match(result.compiled.messages[0].content, /OMEGA=17/);
  assert.ok(performance.now() - started < 100);
});

test("local and Luna evidence preserve session/date provenance after passage splitting", () => {
  const messages = [
    { role: "user", content: "[memory_session id=s_old date=2025/01/02 turn=0]\nThe preferred value was 12." },
    { role: "assistant", content: [{ type: "text", text: "[memory_session id=s_new date=2026/03/04 turn=0]\nThe user updated the preferred value to 17." }] },
    ...turn(3, "当前工作"),
    ...turn(4, "最新工作"),
  ];
  const local = compileDualTrackContext({
    messages,
    prompt: "What is the updated preferred value?",
    liveTurns: 2,
    retrievalBudget: 500,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  assert.match(local.compiled.messages[0].content, /memory_session=s_new memory_date="2026\/03\/04"/);

  const units = makeFoldUnits(groupTurns(messages).slice(0, 2), { minTokens: 1, maxTokens: 1000 });
  const summaries = new Map(units.map((unit) => {
    const quote = unit.text.match(/The user updated the preferred value to 17\./)?.[0]
      || unit.text.match(/The preferred value was 12\./)?.[0];
    const parsed = parseEvidenceTags(JSON.stringify({ claims: [{
      claim: quote,
      quote,
      kind: "observation",
      authority: "user",
      status: "active",
      entities: ["preferred value"],
    }] }), unit);
    return [unit.id, { claims: parsed.claims }];
  }));
  const enhanced = compileDualTrackContext({
    messages,
    prompt: "What is the updated preferred value?",
    summaries,
    liveTurns: 2,
    retrievalBudget: 500,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  });
  const derived = enhanced.compiled.messages.map((message) => String(message.content || "")).join("\n");
  assert.match(derived, /memory_session=s_new memory_date="2026\/03\/04"/);
});

test("dual track preserves the full local baseline and uses labels only for nonduplicate raw-quote supplements", () => {
  const messages = [
    ...turn(1, "测量响应为73。"),
    ...turn(2, "界面颜色是蓝色。"),
    ...turn(3, "用户确认关键参数 OMEGA=17，旧值 12 已否决。"),
    ...turn(4, "实验结果显示 OMEGA=17 可以复现。"),
    ...turn(5, "普通安装检查已结束。"),
    ...turn(6, "当前工作"),
    ...turn(7, "最新工作"),
  ];
  const cold = makeFoldUnits(groupTurns(messages).slice(0, 5), { minTokens: 1, maxTokens: 1000 });
  const summaries = new Map(cold.map((unit, index) => {
    const quote = unit.text.match(/测量响应为73。/)?.[0]
      || unit.text.match(/用户确认[^\n。]*[。]?/)?.[0]
      || unit.text.match(/实验结果[^\n。]*[。]?/)?.[0]
      || unit.text.match(/(?:界面颜色|普通安装)[^\n。]*[。]?/)?.[0];
    const parsed = parseEvidenceTags(JSON.stringify({ claims: [{
      claim: index === 0 ? "MODEL_LABEL_COBALT_OUTCOME" : quote,
      quote,
      kind: "observation",
      authority: "experiment",
      status: "active",
      entities: index === 0 ? ["response"] : ["OMEGA"],
      retrievalCues: index === 0 ? ["钴蓝结果"] : [],
    }] }), unit);
    return [unit.id, { claims: parsed.claims }];
  }));
  const options = {
    messages,
    prompt: "钴蓝结果与最终 OMEGA 是什么？",
    summaries,
    liveTurns: 2,
    retrievalBudget: 500,
    foldMinTokens: 1,
    foldMaxTokens: 1000,
  };
  const baseline = compileContext({ ...options, idea: "P0-A", localEvidenceIndex: true });
  const result = compileDualTrackContext({ ...options, idea: "P0-A" });
  const changedP0 = compileDualTrackContext({ ...options, idea: "P0-B contains cobalt and unrelated OMEGA directions" });
  assert.equal(result.track, "luna-enhanced");
  assert.equal(result.enhancedReady, true);
  assert.equal(result.pendingIndexCount, 0);
  assert.equal(result.compiled.metrics.mode, "local-first-luna-supplement");
  assert.equal(result.compiled.metrics.localTokens, baseline.metrics.retrievedTokens);
  assert.equal(result.compiled.metrics.retrievedTokens <= options.retrievalBudget, true);
  assert.equal(result.compiled.metrics.enhancementTokens > 0, true);
  assert.equal(result.compiled.metrics.dedupedPassageCount > 0, true);
  assert.equal(result.compiled.metrics.rankFusion, "local-first-supplement-v1");
  const resultHashes = new Set(result.compiled.selectedPassages.map((passage) => passage.quoteHash));
  assert.equal(baseline.selectedPassages.every((passage) => resultHashes.has(passage.quoteHash)), true);
  assert.ok(result.compiled.selectedClaims.length > 0);
  assert.equal(result.compiled.selectedPassages.some((passage) => passage.candidateSource === "luna-label" && passage.quote === "测量响应为73。"), true);
  const injected = result.compiled.messages.map((message) => String(message.content || "")).join("\n");
  assert.match(injected, /测量响应为73。/);
  assert.doesNotMatch(injected, /MODEL_LABEL_COBALT_OUTCOME|kind=|authority=experiment|status=active|钴蓝结果/);
  assert.equal(new Set(result.compiled.selectedPassages.map((passage) => passage.quoteHash)).size, result.compiled.selectedPassages.length);
  assert.deepEqual(changedP0.compiled.selectedPassages.map((passage) => passage.quoteHash), result.compiled.selectedPassages.map((passage) => passage.quoteHash));
});

test("ten repeated compile loops preserve stable summaries and hard retrieval budget", () => {
  const messages = Array.from({ length: 14 }, (_, index) => turn(index, `实验 ${index} 结果 TAG-${index}`)).flat();
  const cold = makeFoldUnits(groupTurns(messages).slice(0, 10), { minTokens: 1, maxTokens: 1000 });
  const summaries = new Map(cold.map((unit, index) => [unit.id, { summary: `TAG-${index}`, tokens: 4 }]));
  let firstIds = null;
  for (let loop = 0; loop < 10; loop += 1) {
    const result = compileContext({
      messages,
      prompt: "复查 TAG-3",
      summaries,
      liveTurns: 4,
      retrievalBudget: 24,
      maxRetrievedUnits: 3,
      foldMinTokens: 1,
      foldMaxTokens: 1000,
    });
    assert.ok(result.metrics.retrievedTokens <= 24);
    const ids = result.selected.map((item) => item.id);
    firstIds ??= ids;
    assert.deepEqual(ids, firstIds);
  }
});
