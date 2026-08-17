import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContext, groupTurns, makeFoldUnits, serializeMessage, summaryPrompt } from "../src/context-compiler.js";
import { estimateTokens } from "../src/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const workspace = resolve(packageRoot, "..");
const node = join(workspace, ".tools", "node-v24.18.0", "node-v24.18.0-win-x64", "node.exe");
const cli = join(workspace, ".tools", "pi-cli", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const cacheDir = join(here, ".cache");
mkdirSync(cacheDir, { recursive: true });

const facts = [
  ["KAPPA_037", "正则系数", "用户确认正则系数固定为 KAPPA_037，也就是 0.37；0.5 只是假设，已否决。"],
  ["RANK64_NAN", "秩六十四数值问题", "观测：秩达到 64 时出现 RANK64_NAN；当前解释是归一化顺序导致的数值不稳定，解释尚未证实。"],
  ["SPARSE_17P", "稀疏矩阵实验", "实验 E-17 显示稀疏矩阵吞吐提升 SPARSE_17P；密集矩阵没有显著变化。"],
  ["ROUTE_C_REJECTED", "被否决的路线 C", "用户否决路线 C，记录为 ROUTE_C_REJECTED；原因是它变成了已有的低秩近似方法。"],
  ["FLOAT64_ONLY", "数值精度", "当前验证阶段只允许 FLOAT64_ONLY；float32 的速度数据不能用于支持科学结论。"],
  ["KERNEL_CPP_142", "算子核心文件", "核心实现位于 src/kernel.cpp 第 142 行附近，检索标识 KERNEL_CPP_142。"],
  ["NEGATIVE_EVIDENCE_B7", "反面证据 B7", "NEGATIVE_EVIDENCE_B7 反对局部平滑假设，但不否定科学对象；需要寻找新解释。"],
  ["EQOP_ONLY", "远端权限", "本阶段远端操作范围是 EQOP_ONLY，不能扩展到服务器上的其他项目。"],
  ["ALPHA_CONFLICT", "冲突 alpha", "新结果与旧假设发生 ALPHA_CONFLICT：旧实验支持单调性，新实验在边界区间反例。"],
  ["SEED_20260813", "复现实验随机种子", "可复现实验必须使用 SEED_20260813，并保存完整环境摘要。"],
  ["STOP_AT_200", "硬停止条件", "局部试错硬上限是 STOP_AT_200 次评估；软检查点在 80 次。"],
  ["TARGET_OPERATOR", "最终科学对象", "科学对象仍是 TARGET_OPERATOR 的机制与性能，不是改进 Harness 本身。"],
];

const filler = "操作日志包含路径扫描、依赖检查、普通测试输出和重复状态更新；这些细节已经由最终结果取代，不应长期占据活动上下文。";
const messages = facts.flatMap(([token, topic, statement], index) => [
  { role: "user", content: `第 ${index + 1} 个阶段片段：讨论${topic}` },
  {
    role: "assistant",
    content: [{ type: "text", text: `${statement}\n${filler.repeat(12)}\n最终保留标识：${token}` }],
  },
]);

function luna(prompt) {
  const key = createHash("sha256").update(prompt).digest("hex");
  const cachePath = join(cacheDir, `${key}.txt`);
  if (existsSync(cachePath)) return readFileSync(cachePath, "utf8");
  const result = spawnSync(node, [
    cli,
    "--provider", "openai-codex",
    "--model", "gpt-5.6-luna",
    "--thinking", "low",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--offline",
    "-p",
    prompt,
  ], { cwd: workspace, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Luna failed (${result.status}): ${result.stderr || result.stdout}`);
  const output = result.stdout.trim();
  writeFileSync(cachePath, output, "utf8");
  return output;
}

const turns = groupTurns(messages);
const coldTurns = turns.slice(0, -2);
const units = makeFoldUnits(coldTurns);
const summaries = new Map();
const lunaRuns = [];
for (const unit of units) {
  const started = performance.now();
  const summary = luna(summaryPrompt(unit, "sha256:benchmark-idea"));
  lunaRuns.push({ id: unit.id, ms: Math.round(performance.now() - started), rawTokens: unit.tokens, summaryTokens: estimateTokens(summary) });
  summaries.set(unit.id, { summary, tokens: estimateTokens(summary) });
}

const globalStarted = performance.now();
const globalSummary = luna(`请把下面整段长任务历史压缩成一份可继续工作的综合摘要。保留主要目标、用户决定、实验结果、冲突、失败、权限和未决事项；删除重复工具日志。不要针对某个未来问题优化，不超过 900 中文字。\n\n${messages.map(serializeMessage).join("\n\n---\n\n")}`);
const globalMs = Math.round(performance.now() - globalStarted);

const fullText = messages.map(serializeMessage).join("\n");
const tailMessages = messages.slice(-4);
const tailText = tailMessages.map(serializeMessage).join("\n");
const globalText = `${globalSummary}\n${tailText}`;

function recalls(text, token) {
  return String(text).includes(token);
}

const foldProbeResults = [];
for (const [token, topic] of facts) {
  const stage = token === "FLOAT64_ONLY" ? "当前阶段核验数值精度，必须区分 float64 与 float32" : "";
  const result = compileContext({
    messages,
    prompt: `请回忆并准确说明${topic}的已确认信息`,
    stage,
    summaries,
    liveTurns: 2,
    retrievalBudget: 1800,
    maxRetrievedUnits: 4,
  });
  const text = result.messages.map(serializeMessage).join("\n");
  foldProbeResults.push({ token, hit: recalls(text, token), tokens: estimateTokens(text), selected: result.selected.map((item) => item.id) });
}

const recallRate = (predicate) => facts.filter(([token]) => predicate(token)).length / facts.length;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sortedTokens = foldProbeResults.map((item) => item.tokens).sort((a, b) => a - b);

const cpuMessages = Array.from({ length: 250 }, (_, index) => messages[index % messages.length]);
const cpuSummaries = new Map(makeFoldUnits(groupTurns(cpuMessages).slice(0, -4)).map((unit) => [unit.id, { summary: unit.text.slice(0, 300), tokens: estimateTokens(unit.text.slice(0, 300)) }]));
const cpuStarted = performance.now();
for (let index = 0; index < 500; index += 1) {
  compileContext({ messages: cpuMessages, prompt: `检索稀疏矩阵 ${index % 3}`, summaries: cpuSummaries, liveTurns: 4 });
}
const cpuMs = performance.now() - cpuStarted;

const report = {
  benchmark: "pi-idea-long-context-v1",
  model: "openai-codex/gpt-5.6-luna",
  facts: facts.length,
  rawTokens: estimateTokens(fullText),
  baselines: {
    fullRaw: { recall: 1, tokens: estimateTokens(fullText) },
    tail2Turns: { recall: recallRate((token) => recalls(tailText, token)), tokens: estimateTokens(tailText) },
    globalLunaSummaryPlusTail: { recall: recallRate((token) => recalls(globalText, token)), tokens: estimateTokens(globalText), ms: globalMs },
  },
  blockFoldRetrieve: {
    recall: foldProbeResults.filter((item) => item.hit).length / facts.length,
    meanTokensPerProbe: Math.round(mean(foldProbeResults.map((item) => item.tokens))),
    p95TokensPerProbe: sortedTokens[Math.floor(sortedTokens.length * 0.95)],
    summaryRuns: lunaRuns,
    probes: foldProbeResults,
  },
  deterministicCompiler: {
    iterations: 500,
    messages: cpuMessages.length,
    totalMs: Math.round(cpuMs),
    meanMs: Number((cpuMs / 500).toFixed(3)),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
