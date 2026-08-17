import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { blockizeMessages, compileBidirectionalContext } from "../src/evidence-context-compiler.js";
import { estimateTokens } from "../src/core.js";

const IDEA_HASH = "idea:context-assembly-performance-first";
const STAGE_HASH = "stage:multiturn-intent-benchmark";
const ANCHOR = [
  "CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY",
  "PRIORITY=TASK_PERFORMANCE_THEN_INPUT_TOKENS_THEN_CPU_LATENCY",
  "CONSTRAINT=CPU_ONLY",
  "CONSTRAINT=RAW_PERMANENT_UNTIL_USER_CLEANUP",
  "CONSTRAINT=OBELISK_COMPATIBILITY_NOT_HOT_PATH",
].join("\n");

function loop(id, user, assistant, extra = {}) {
  return [
    {
      role: "user", id: `${id}-u`, entryId: `${id}-u`, loopId: id,
      content: user, researchIdeaHash: IDEA_HASH, researchStageHash: STAGE_HASH,
      ...extra.user,
    },
    {
      role: "assistant", id: `${id}-a`, entryId: `${id}-a`, loopId: id,
      stopReason: "stop", content: assistant,
      researchIdeaHash: IDEA_HASH, researchStageHash: STAGE_HASH,
      ...extra.assistant,
    },
  ];
}

function noiseLoops(prefix, count, start = 0) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return loop(
      `${prefix}-${index}`,
      `局部工程事项 ${prefix}-${index}：检查缓存、格式和测试日志。LOCAL_${prefix}_${index}`,
      `已记录局部结果 LOCAL_RESULT_${prefix}_${index}；这不是研究方向变更。`,
    );
  }).flat();
}

function toolNoise(loopId, index) {
  return [
    {
      role: "assistant", id: `${loopId}-tc-${index}`, entryId: `${loopId}-tc-${index}`, loopId,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: `call-${loopId}-${index}`, name: "shell", arguments: { command: `NOISY_SECRET_COMMAND_${index}` } }],
      researchIdeaHash: IDEA_HASH, researchStageHash: STAGE_HASH,
    },
    {
      role: "toolResult", id: `${loopId}-tr-${index}`, entryId: `${loopId}-tr-${index}`, loopId,
      toolCallId: `call-${loopId}-${index}`, toolName: "shell",
      content: [{ type: "text", text: `TOOL_LOG_${index} routine check passed` }],
      researchIdeaHash: IDEA_HASH, researchStageHash: STAGE_HASH,
    },
  ];
}

function buildScenarios() {
  const common = [
    ...loop("goal", ANCHOR, "我会以已确认科研目标为最高层约束。"),
    ...noiseLoops("setup", 12),
  ];
  return [
    {
      id: "bare-continue",
      archetype: "真实历史中大量单独的继续消息",
      messages: [
        ...common,
        ...loop("active-bench", "现在构建目标漂移测试。ACTIVE_NODE=BUILD_DRIFT_BENCHMARK；不要转去模型路由。", "已建立测试骨架，下一步是运行 paired replay。NEXT_STEP=RUN_PAIRED_REPLAY"),
        ...toolNoise("active-bench", 1),
      ],
      prompt: "继续",
      continuationLoopIds: ["active-bench"],
      stateFrame: ["ACTIVE_NODE=BUILD_DRIFT_BENCHMARK", "NEXT_STEP=RUN_PAIRED_REPLAY"],
      maxPositiveKeeps: 0,
      expected: ["CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY", "ACTIVE_NODE=BUILD_DRIFT_BENCHMARK", "NEXT_STEP=RUN_PAIRED_REPLAY", "CONSTRAINT=CPU_ONLY"],
      forbidden: ["NOISY_SECRET_COMMAND_1"],
    },
    {
      id: "late-correction",
      archetype: "用户纠正旧参数后经过很多局部回合再次询问",
      messages: [
        ...common,
        ...loop("old-param", "先试 PARAM_BIAS=-1。", "当前候选是 PARAM_BIAS=-1。"),
        ...loop("correct-param", "纠正：不是 PARAM_BIAS=-1，ACTIVE_WARMUP=200 才是当前决定。", "已更正，ACTIVE_WARMUP=200。"),
        ...noiseLoops("after-correction", 18),
      ],
      prompt: "当前 warmup 参数到底是什么？",
      continuationLoopIds: [],
      stateFrame: ["CURRENT_PARAMETER=ACTIVE_WARMUP=200"],
      maxPositiveKeeps: 0,
      expected: ["CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY", "ACTIVE_WARMUP=200", "CONSTRAINT=CPU_ONLY"],
      forbidden: [],
      staleMarkers: ["PARAM_BIAS=-1"],
    },
    {
      id: "switch-and-return",
      archetype: "中途切换工作，随后明确返回旧主线",
      messages: [
        ...common,
        ...loop("mainline", "主线节点 MAINLINE=LOCATOR_THEN_FULL_ISLAND，验收是 NO_ORPHAN_FRAGMENT。", "已记录主线和验收。"),
        ...noiseLoops("side-task", 24),
      ],
      prompt: "回到 LOCATOR_THEN_FULL_ISLAND 主线，验收标准是什么？",
      continuationLoopIds: [],
      stateFrame: [],
      expected: ["CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY", "MAINLINE=LOCATOR_THEN_FULL_ISLAND", "NO_ORPHAN_FRAGMENT"],
      forbidden: [],
    },
    {
      id: "authority-and-scope",
      archetype: "工具证据、模型推断和用户授权必须分层",
      messages: [
        ...common,
        ...loop("claim", "只做 CPU 静态验证；禁止启动 Sol，禁止 GPU。AUTH_SCOPE=CPU_STATIC_ONLY", "明白，我不会启动模型。"),
        {
          role: "toolResult", id: "auth-tool", entryId: "auth-tool", loopId: "auth-check",
          toolCallId: "auth-call", toolName: "auth-check",
          content: [{ type: "text", text: "VERIFIED_EVENT=PI_AUTH_INVALID EXIT_CODE=2" }],
          researchIdeaHash: IDEA_HASH, researchStageHash: STAGE_HASH,
        },
        ...loop("model-guess", "报告当前可验证状态。", "我猜登录已经有效，可以直接启动 SOL_MODEL_RUN。"),
        ...noiseLoops("after-auth", 14),
      ],
      prompt: "现在允许做什么、验证到了什么？",
      continuationLoopIds: [],
      evidenceLoopIds: ["auth-check"],
      stateFrame: ["CURRENT_AUTHORITY=AUTH_SCOPE=CPU_STATIC_ONLY", "LATEST_VERIFIED_EVIDENCE=auth-check"],
      maxPositiveKeeps: 0,
      expected: ["CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY", "AUTH_SCOPE=CPU_STATIC_ONLY", "VERIFIED_EVENT=PI_AUTH_INVALID", "EXIT_CODE=2"],
      forbidden: ["SOL_MODEL_RUN"],
    },
    {
      id: "task-switch-with-new-constraint",
      archetype: "追加任务不能覆盖原目标，新权限约束必须立即生效",
      messages: [
        ...common,
        ...loop("retention", "RAW_POLICY=PERMANENT。除非用户明确清理，否则永远保留 raw。", "已记录 raw 永久保留。"),
        ...noiseLoops("middle", 20),
        ...loop("new-node", "还有：先测滚动压缩，不要先做工具线程。ACTIVE_NODE=COMPARE_ROLLING_COMPACTION", "当前节点切换为 COMPARE_ROLLING_COMPACTION。"),
      ],
      prompt: "继续做当前节点",
      continuationLoopIds: ["new-node"],
      stateFrame: ["RETENTION=RAW_POLICY=PERMANENT", "ACTIVE_NODE=COMPARE_ROLLING_COMPACTION", "SCOPE=不要先做工具线程"],
      maxPositiveKeeps: 0,
      expected: ["CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY", "RAW_POLICY=PERMANENT", "ACTIVE_NODE=COMPARE_ROLLING_COMPACTION", "不要先做工具线程"],
      forbidden: [],
    },
    {
      id: "goal-crowding-stress",
      archetype: "大量局部目标挤压最初研究意图",
      messages: [
        ...common,
        ...Array.from({ length: 48 }, (_, index) => loop(
          `crowd-${index}`,
          `当前局部目标=LOCAL_GOAL_${index}；验收 LOCAL_ACCEPT_${index}。这只是执行节点。`,
          `局部目标 LOCAL_GOAL_${index} 已推进，研究总目标未重新确认。`,
        )).flat(),
      ],
      prompt: "我们最初确认、现在仍然有效的研究总目标是什么？",
      continuationLoopIds: [],
      stateFrame: [],
      maxPositiveKeeps: 0,
      expected: ["CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY", "PRIORITY=TASK_PERFORMANCE_THEN_INPUT_TOKENS_THEN_CPU_LATENCY"],
      forbidden: ["LOCAL_GOAL_47"],
    },
  ];
}

function serialize(message) {
  if (typeof message.content === "string") return `${message.role.toUpperCase()}: ${message.content}`;
  const text = (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const calls = (message.content || []).filter((part) => part.type === "toolCall").map((part) => `TOOL_CALL ${part.name} ${JSON.stringify(part.arguments)}`).join("\n");
  return `${message.role.toUpperCase()}: ${[text, calls].filter(Boolean).join("\n")}`;
}

function takeNewestWithin(items, budget, tokenOf) {
  const selected = [];
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const tokens = tokenOf(items[index]);
    if (selected.length && used + tokens > budget) break;
    if (tokens > budget && selected.length === 0) continue;
    selected.unshift(items[index]);
    used += tokens;
  }
  return selected;
}

/** Transparent Codex-style approximation: recent raw tail plus a bounded,
 * repeatedly replaceable extractive summary of the evicted prefix. It is not
 * claimed to reproduce the proprietary Codex compactor. */
function rollingCompaction(messages, prompt, budget = 900) {
  const tailBudget = Math.floor(budget * 0.62);
  const summaryBudget = Math.floor(budget * 0.28);
  const serialized = messages.map((message, index) => ({ index, text: serialize(message), role: message.role }));
  const tail = takeNewestWithin(serialized, tailBudget, (row) => estimateTokens(row.text));
  const tailStart = tail.length ? tail[0].index : serialized.length;
  const prefix = serialized.slice(0, tailStart);
  const candidates = prefix.map((row) => {
    const authority = row.role === "user" ? 4 : row.role === "toolResult" ? 3 : 1;
    const directive = /(goal|目标|constraint|约束|禁止|不要|只做|当前|active|mainline|policy|verified|验收)/i.test(row.text) ? 3 : 0;
    return { ...row, score: authority + directive + row.index / Math.max(1, serialized.length) };
  }).sort((a, b) => b.score - a.score || b.index - a.index);
  const picked = [];
  let summaryTokens = 0;
  for (const row of candidates) {
    const tokens = estimateTokens(row.text);
    if (summaryTokens + tokens > summaryBudget) continue;
    picked.push(row);
    summaryTokens += tokens;
  }
  picked.sort((a, b) => a.index - b.index);
  const context = [
    "[ROLLING_COMPACTION_SIMULATION]",
    ...picked.map((row) => row.text),
    "[RECENT_RAW_TAIL]",
    ...tail.map((row) => row.text),
    `USER: ${prompt}`,
  ].join("\n\n");
  return { context, tokens: estimateTokens(context), prefixMessages: prefix.length, tailMessages: tail.length, summaryMessages: picked.length };
}

function piIdeaAssembly(scenario, budget = 900, { useFrames = true } = {}) {
  const blocks = blockizeMessages(scenario.messages);
  const rootedLoopIds = new Set(useFrames
    ? [...(scenario.continuationLoopIds || []), ...(scenario.evidenceLoopIds || [])]
    : []);
  const explicitRootIds = blocks
    .filter((block) => rootedLoopIds.has(block.loopId) && block.factCandidate)
    .map((block) => block.blockId);
  const stateFrame = useFrames && (scenario.stateFrame || []).length
    ? `[NARROW_CONFIRMED_STATE]\n${scenario.stateFrame.join("\n")}`
    : "";
  const result = compileBidirectionalContext({
    memoryBlocks: blocks,
    query: scenario.prompt,
    condition: "bidirectional-heat",
    budget: Math.max(256, budget - estimateTokens(ANCHOR) - estimateTokens(stateFrame) - estimateTokens(scenario.prompt)),
    liveBlocks: 0,
    maxPositiveKeeps: useFrames ? (scenario.maxPositiveKeeps ?? 4) : 4,
    maxOptionalKeeps: useFrames && scenario.maxPositiveKeeps === 0 ? 0 : 3,
    activeContext: { ideaHash: IDEA_HASH, stageHash: STAGE_HASH },
    explicitRootIds,
  });
  const context = [ANCHOR, stateFrame, result.context, `USER: ${scenario.prompt}`].filter(Boolean).join("\n\n");
  return {
    context,
    tokens: estimateTokens(context),
    overflow: result.overflow,
    selectedBlocks: result.selectedBlocks.length,
    continuationRoots: explicitRootIds.length,
  };
}

function fullLedger(scenario) {
  const context = `${scenario.messages.map(serialize).join("\n\n")}\n\nUSER: ${scenario.prompt}`;
  return { context, tokens: estimateTokens(context) };
}

function score(strategy, scenario) {
  const expectedHits = scenario.expected.filter((marker) => strategy.context.includes(marker));
  const forbiddenHits = scenario.forbidden.filter((marker) => strategy.context.includes(marker));
  const staleHits = (scenario.staleMarkers || []).filter((marker) => strategy.context.includes(marker));
  const unresolvedStaleLeak = staleHits.length > 0 && expectedHits.length < scenario.expected.length;
  const goalPresent = strategy.context.includes("CONFIRMED_GOAL=BUILD_EXTERNAL_MEMORY_CONTEXT_ASSEMBLY");
  const questionOccurrences = strategy.context.split(scenario.prompt).length - 1;
  return {
    expected: scenario.expected.length,
    expectedHits: expectedHits.length,
    coverage: expectedHits.length / scenario.expected.length,
    missing: scenario.expected.filter((marker) => !strategy.context.includes(marker)),
    forbiddenHits,
    staleHits,
    unresolvedStaleLeak,
    goalDrift: !goalPresent,
    currentQuestionExactlyOnce: questionOccurrences === 1,
    pass: expectedHits.length === scenario.expected.length && forbiddenHits.length === 0 && goalPresent && questionOccurrences === 1,
  };
}

function aggregate(rows, name) {
  const items = rows.map((row) => row[name]);
  const fullTokens = rows.map((row) => row.full.tokens);
  return {
    scenarios: items.length,
    passRate: items.filter((item) => item.score.pass).length / items.length,
    goalDriftRate: items.filter((item) => item.score.goalDrift).length / items.length,
    meanExpectedCoverage: items.reduce((sum, item) => sum + item.score.coverage, 0) / items.length,
    forbiddenLeakScenarios: items.filter((item) => item.score.forbiddenHits.length).length,
    staleMentionScenarios: items.filter((item) => item.score.staleHits.length).length,
    unresolvedStaleLeakScenarios: items.filter((item) => item.score.unresolvedStaleLeak).length,
    questionDuplicationScenarios: items.filter((item) => !item.score.currentQuestionExactlyOnce).length,
    meanTokens: items.reduce((sum, item) => sum + item.tokens, 0) / items.length,
    meanFractionOfFullLedger: items.reduce((sum, item, index) => sum + item.tokens / fullTokens[index], 0) / items.length,
  };
}

function runBenchmark({ write = true } = {}) {
  const scenarios = buildScenarios();
  const rows = scenarios.map((scenario) => {
    const full = fullLedger(scenario);
    const rolling = rollingCompaction(scenario.messages, scenario.prompt);
    const piIdea = piIdeaAssembly(scenario);
    const retrievalOnly = piIdeaAssembly(scenario, 900, { useFrames: false });
    return {
      id: scenario.id,
      archetype: scenario.archetype,
      prompt: scenario.prompt,
      expected: scenario.expected,
      forbidden: scenario.forbidden,
      staleMarkers: scenario.staleMarkers || [],
      full,
      rolling: { ...rolling, score: score(rolling, scenario) },
      piIdea: { ...piIdea, score: score(piIdea, scenario) },
      retrievalOnly: { ...retrievalOnly, score: score(retrievalOnly, scenario) },
    };
  });
  const report = {
    schema: 1,
    benchmark: "Pi-Idea Multi-Turn Intent Continuity Replay v1",
    generatedAt: "2026-08-13T00:00:00.000Z",
    limits: [
      "The rolling baseline is a transparent deterministic Codex-style simulation, not the proprietary Codex compactor.",
      "This benchmark measures context sufficiency and drift exposure, not downstream Sol answer quality.",
      "Scenario structures are derived from bounded Obelisk history retrieval; contents are anonymized synthetic fixtures.",
      "Pi-Idea receives user-confirmed narrow state and pointer frames; this is the architecture under test, not an equal-input retriever contest.",
    ],
    budgets: { strategyContextTokens: 900 },
    provenance: {
      source: "bounded Obelisk user-message audit on 2026-08-13",
      observedArchetypes: ["bare continuation", "late correction", "task switch", "scope and authority", "new constraint"],
    },
    aggregate: {
      rolling: aggregate(rows, "rolling"),
      piIdea: aggregate(rows, "piIdea"),
      retrievalOnlyAblation: aggregate(rows, "retrievalOnly"),
    },
    scenarios: rows,
  };
  const outputPath = resolve(process.cwd(), "..", "research", "MULTITURN_INTENT_DRIFT_BENCHMARK_2026-08-13.json");
  if (write) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { outputPath, report, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { outputPath, report, rows } = runBenchmark();
  console.log(JSON.stringify({ outputPath, aggregate: report.aggregate, scenarios: rows.map((row) => ({
    id: row.id,
    fullTokens: row.full.tokens,
    rolling: { tokens: row.rolling.tokens, ...row.rolling.score },
    piIdea: { tokens: row.piIdea.tokens, ...row.piIdea.score },
    retrievalOnly: { tokens: row.retrievalOnly.tokens, ...row.retrievalOnly.score },
  })) }, null, 2));
}

export { ANCHOR, buildScenarios, rollingCompaction, piIdeaAssembly, runBenchmark, score };
