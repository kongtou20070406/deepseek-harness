import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkCases } from "./cases.mjs";
import { LunaBudgetLedger } from "./budget-ledger.mjs";
import { LunaRpcClient } from "./luna-client.mjs";
import {
  compileContext,
  groupTurns,
  makeFoldUnits,
  parseEvidenceTags,
  relevanceScores,
  serializeMessage,
  summaryPrompt,
} from "../../../pi-idea-extension/src/context-compiler.js";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(here, ".selector-cache");
const resultsDir = join(here, "results");
await mkdir(cacheDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });

const repetitions = Math.max(1, Math.min(5, Number(process.argv.find((value) => value.startsWith("--repetitions="))?.split("=")[1] || 3)));
const requestedConditions = process.argv.find((value) => value.startsWith("--conditions="))?.split("=")[1]?.split(",").filter(Boolean) || null;
const runId = `selector-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const ledger = await new LunaBudgetLedger(join(here, "luna-budget.json")).load();
const tagger = new LunaRpcClient({ timeoutMs: 180_000 });
const selector = new LunaRpcClient({ timeoutMs: 180_000 });
const answerer = new LunaRpcClient({ timeoutMs: 180_000 });

function hash(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || "{}"); }
  catch { return fallback; }
}

async function chargedRpc(client, prompt, { caseId, condition, maxTokens }) {
  const reservation = ledger.reserve({ prompt, maxTokens, runId, caseId, condition });
  try {
    const result = await client.complete(prompt);
    const charged = await ledger.settle(reservation, result.usage);
    return { ...result, charged };
  } catch (error) {
    await ledger.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

function tagPrompt(item, unit) {
  return `你是后台证据索引器，不回答科研问题，也不决定路线。只从下面原始工作块抽取会影响未来决定的事实、用户确认、否决、冲突、实验观测、权限和未决事项。\n` +
    `保留原文中的 EVIDENCE id；没有则 evidenceId 为 null。quote 必须是原块中的短原文，不得创造结论。纯工具过程不要收录。\n` +
    `只输出 JSON：{"claims":[{"evidenceId":"...或null","claim":"简洁事实","status":"confirmed|rejected|conflict|observation|proposal|unknown","entities":["检索词"],"quote":"短原文"}]}。最多 10 条。\n\n` +
    `<idea_identity>${hash(item.p0)}</idea_identity>\n<raw_block id="${unit.id}">\n${unit.text}\n</raw_block>`;
}

async function loadOrCreateTags(item, unit) {
  const prompt = tagPrompt(item, unit);
  const path = join(cacheDir, `${hash(prompt)}.json`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const result = await chargedRpc(tagger, prompt, { caseId: item.id, condition: "background-tagging", maxTokens: 900 });
  const parsed = parseJson(result.text, { claims: [] });
  const claims = (Array.isArray(parsed.claims) ? parsed.claims : []).slice(0, 10).map((claim, index) => ({
    id: `${unit.id}:${index}`,
    sourceUnitId: unit.id,
    evidenceId: typeof claim.evidenceId === "string" && claim.evidenceId !== "null" ? claim.evidenceId : null,
    claim: String(claim.claim || "").slice(0, 600),
    status: String(claim.status || "unknown"),
    entities: Array.isArray(claim.entities) ? claim.entities.map(String).slice(0, 12) : [],
    quote: String(claim.quote || "").slice(0, 600),
  })).filter((claim) => claim.claim || claim.quote);
  const saved = { claims, ms: result.ms, firstTokenMs: result.firstTokenMs, usage: result.charged };
  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

async function loadBlockSummaries(item, units) {
  const summaries = new Map();
  for (const unit of units) {
    const prompt = summaryPrompt(unit, `benchmark-batched:${item.id}`);
    const key = hash(`prepare-block-summary-batched\n${prompt}`);
    const cached = JSON.parse(await readFile(join(here, ".cache", `${key}.json`), "utf8"));
    summaries.set(unit.id, { summary: cached.text, tokens: estimateTokens(cached.text) });
  }
  return summaries;
}

function programSelect(claims, item, limit = 3) {
  const started = performance.now();
  const query = `${item.p0}\n${item.stage}\n${item.question}`;
  // Luna labels are suggestions, not authority. Drop its common "nothing
  // changed" housekeeping claims before ranking; they otherwise crowd out an
  // older but explicit checkpoint/constraint despite weak lexical overlap.
  const routine = /(例行检查|未产生新的(?:方向性结论|实验结果|用户决定)|没有新的方向性结论|(?:未发现|没有发现).*(?:改变|会改变).*新证据|未改变.*(?:目标|约束|路线)|结果与上次相同|无新增(?:事项|记录))/i;
  const informative = claims.filter((claim) => !routine.test(`${claim.claim}\n${claim.quote}`));
  const candidates = informative.map((claim) => ({
    ...claim,
    summary: `${claim.claim}\n${claim.status}\n${claim.entities.join(" ")}\n${claim.quote}`,
  }));
  const scores = relevanceScores(candidates, query);
  const selected = candidates.map((claim, index) => ({ ...claim, score: scores[index] }))
    .sort((a, b) => b.score - a.score || String(a.evidenceId).localeCompare(String(b.evidenceId)))
    .slice(0, limit);
  return { selected, ms: performance.now() - started };
}

function claimsText(claims) {
  return claims.map((claim) => `[EVIDENCE id=${claim.evidenceId || "unlabeled"} status=${claim.status} source=${claim.sourceUnitId}]\n${claim.claim}\n原文：${claim.quote}`).join("\n\n");
}

function tailText(item) {
  return groupTurns(item.messages).slice(-2).flatMap((turn) => turn.messages).map(serializeMessage).join("\n\n");
}

async function lunaSelect(claims, item) {
  const prompt = `你只负责从候选证据中选出回答当前任务必需的最小集合，不回答任务。最多选择 3 个 evidenceId；必须保留相关反面证据、冲突和用户最后确认值，排除过期候选与纯工程干扰。只输出 JSON：{"evidenceIds":["..."]}。\n\n` +
    `<authoritative_idea>${item.p0}</authoritative_idea>\n<stage>${item.stage}</stage>\n<task>${item.question}</task>\n<candidates>\n${claimsText(claims)}\n</candidates>`;
  const result = await chargedRpc(selector, prompt, { caseId: item.id, condition: "online-luna-selector", maxTokens: 180 });
  const ids = (parseJson(result.text, { evidenceIds: [] }).evidenceIds || []).map(String).slice(0, 3);
  return { selected: ids.map((id) => claims.find((claim) => claim.evidenceId === id)).filter(Boolean), ms: result.ms, firstTokenMs: result.firstTokenMs, usage: result.charged };
}

function answerPrompt(item, condition, context, nonce) {
  const options = Object.entries(item.options).map(([key, value]) => `${key}. ${value}`).join("\n");
  return `<authoritative_idea>\n${item.p0}\n</authoritative_idea>\n<current_stage>\n${item.stage}\n</current_stage>\n` +
    `<assembled_context condition="${condition}">\n${context}\n</assembled_context>\n` +
    `<task>\n${item.question}\n\n${options}\n</task>\n` +
    `只输出一行 JSON，不要解释：{"answer":"A/B/C/D","evidence":["证据ID"]}。evidence 只列真正决定答案的历史证据 ID。\n` +
    `<benchmark_nonce>${nonce}</benchmark_nonce>`;
}

function scoreAnswer(item, text) {
  const parsed = parseJson(text, {});
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [];
  const required = new Set(item.requiredEvidence);
  const hits = evidence.filter((id) => required.has(id)).length;
  return {
    answer: typeof parsed.answer === "string" ? parsed.answer.toUpperCase() : null,
    evidence,
    correct: String(parsed.answer || "").toUpperCase() === item.answer,
    evidenceRecall: required.size ? hits / required.size : 1,
    evidencePrecision: evidence.length ? hits / evidence.length : 0,
  };
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const prepared = [];
try {
  for (const item of benchmarkCases(8)) {
    const turns = groupTurns(item.messages);
    const cold = turns.slice(0, -4);
    const units = makeFoldUnits(cold, { minTokens: 4800, maxTokens: 7200 });
    const summaries = await loadBlockSummaries(item, units);
    const tagRecords = [];
    for (let index = 0; index < units.length; index += 1) {
      const record = await loadOrCreateTags(item, units[index]);
      tagRecords.push(record);
      process.stdout.write(`tagged ${item.id} ${index + 1}/${units.length} claims=${record.claims.length}\n`);
    }
    const claims = tagRecords.flatMap((record) => record.claims);
    const productionIndex = new Map(units.map((unit, index) => {
      const parsed = parseEvidenceTags(JSON.stringify({ claims: tagRecords[index].claims }), unit, {
        ideaHash: hash(item.p0),
      });
      return [unit.id, { schema: 2, id: unit.id, claims: parsed.claims, rejectedClaims: parsed.rejected }];
    }));
    const extractedIds = new Set(claims.map((claim) => claim.evidenceId).filter(Boolean));
    prepared.push({ item, units, summaries, claims, tagRecords, productionIndex, extractionRecall: item.requiredEvidence.filter((id) => extractedIds.has(id)).length / item.requiredEvidence.length });
  }

  const rows = [];
  const allConditions = ["full_raw", "block_compiler", "program_tag_index", "production_index", "local_raw_index", "online_luna_selector", "oracle_minimum"];
  const conditions = requestedConditions || allConditions;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (let caseIndex = 0; caseIndex < prepared.length; caseIndex += 1) {
      const entry = prepared[caseIndex];
      const { item, claims } = entry;
      const raw = item.messages.map(serializeMessage).join("\n\n--- TURN ---\n\n");
      const tail = tailText(item);
      const program = programSelect(claims, item);
      const compilerStarted = performance.now();
      const compiled = compileContext({ messages: item.messages, idea: item.p0, prompt: item.question, stage: item.stage, summaries: entry.summaries, liveTurns: 4, retrievalBudget: 3600, maxRetrievedUnits: 3, foldMinTokens: 4800, foldMaxTokens: 7200 });
      const compilerMs = performance.now() - compilerStarted;
      const productionStarted = performance.now();
      const production = compileContext({
        messages: item.messages,
        idea: item.p0,
        prompt: item.question,
        stage: item.stage,
        summaries: entry.productionIndex,
        liveTurns: 4,
        retrievalBudget: 3600,
        maxRetrievedUnits: 3,
        foldMinTokens: 4800,
        foldMaxTokens: 7200,
        strictEvidenceIndex: true,
      });
      const productionMs = performance.now() - productionStarted;
      const localStarted = performance.now();
      const local = compileContext({
        messages: item.messages,
        idea: item.p0,
        prompt: item.question,
        stage: item.stage,
        summaries: new Map(),
        liveTurns: 4,
        retrievalBudget: 3600,
        maxRetrievedUnits: 6,
        foldMinTokens: 4800,
        foldMaxTokens: 7200,
        localEvidenceIndex: true,
      });
      const localMs = performance.now() - localStarted;
      const rotated = [...conditions.slice((caseIndex + repetition) % conditions.length), ...conditions.slice(0, (caseIndex + repetition) % conditions.length)];
      for (const condition of rotated) {
        let context;
        let selectionMs = 0;
        let selectorUsage = null;
        let selectedEvidenceIds = null;
        if (condition === "full_raw") {
          context = raw;
          selectedEvidenceIds = item.facts.map(([_turn, id]) => id);
        }
        else if (condition === "block_compiler") {
          context = compiled.messages.map(serializeMessage).join("\n\n");
          selectionMs = compilerMs;
        } else if (condition === "program_tag_index") {
          context = `${claimsText(program.selected)}\n\n<recent_raw>\n${tail}\n</recent_raw>`;
          selectionMs = program.ms;
          selectedEvidenceIds = program.selected.map((claim) => claim.evidenceId).filter(Boolean);
        } else if (condition === "production_index") {
          context = production.messages.map(serializeMessage).join("\n\n");
          selectionMs = productionMs;
          selectedEvidenceIds = production.selectedClaims.map((claim) => claim.evidenceId).filter(Boolean);
        } else if (condition === "local_raw_index") {
          context = local.messages.map(serializeMessage).join("\n\n");
          selectionMs = localMs;
          selectedEvidenceIds = local.selectedPassages.map((passage) => passage.evidenceId).filter(Boolean);
        } else if (condition === "online_luna_selector") {
          const selection = await lunaSelect(claims, item);
          context = `${claimsText(selection.selected)}\n\n<recent_raw>\n${tail}\n</recent_raw>`;
          selectionMs = selection.ms;
          selectorUsage = selection.usage;
          selectedEvidenceIds = selection.selected.map((claim) => claim.evidenceId).filter(Boolean);
        } else {
          context = `${item.oracleEvidence}\n\n<recent_raw>\n${tail}\n</recent_raw>`;
          selectedEvidenceIds = [...item.requiredEvidence];
        }
        const prompt = answerPrompt(item, condition, context, `${runId}-${repetition}-${caseIndex}-${condition}`);
        const answer = await chargedRpc(answerer, prompt, { caseId: item.id, condition: `answer-${condition}`, maxTokens: 300 });
        const score = scoreAnswer(item, answer.text);
        const row = {
          repetition,
          caseId: item.id,
          condition,
          ...score,
          requiredEvidence: item.requiredEvidence,
          selectedEvidenceIds,
          selectionEvidenceRecall: selectedEvidenceIds
            ? item.requiredEvidence.filter((id) => selectedEvidenceIds.includes(id)).length / item.requiredEvidence.length
            : null,
          contextTokens: estimateTokens(context),
          selectionMs: Math.round(selectionMs * 100) / 100,
          answerMs: answer.ms,
          answerFirstTokenMs: answer.firstTokenMs,
          endToEndMs: Math.round(selectionMs + answer.ms),
          selectorUsage,
          answerUsage: answer.charged,
        };
        rows.push(row);
        process.stdout.write(`run ${repetition + 1}/${repetitions} ${item.id} ${condition} correct=${row.correct} recall=${row.evidenceRecall} e2e=${row.endToEndMs}\n`);
      }
    }
  }

  const aggregates = {};
  for (const condition of conditions) {
    const values = rows.filter((row) => row.condition === condition);
    const end = values.map((row) => row.endToEndMs);
    const ttft = values.map((row) => row.answerFirstTokenMs);
    aggregates[condition] = {
      calls: values.length,
      accuracy: values.filter((row) => row.correct).length / values.length,
      pass3: benchmarkCases(8).filter((item) => values.filter((row) => row.caseId === item.id).every((row) => row.correct)).length / 8,
      evidenceRecall: values.reduce((sum, row) => sum + row.evidenceRecall, 0) / values.length,
      evidencePrecision: values.reduce((sum, row) => sum + row.evidencePrecision, 0) / values.length,
      meanContextTokens: Math.round(values.reduce((sum, row) => sum + row.contextTokens, 0) / values.length),
      medianSelectionMs: Math.round(quantile(values.map((row) => row.selectionMs), 0.5) * 100) / 100,
      medianFirstTokenMs: Math.round(quantile(ttft, 0.5)),
      medianEndToEndMs: Math.round(quantile(end, 0.5)),
      p95EndToEndMs: Math.round(quantile(end, 0.95)),
      totalUsage: values.reduce((sum, row) => sum + row.answerUsage.total + (row.selectorUsage?.total || 0), 0),
    };
  }
  const background = prepared.flatMap((entry) => entry.tagRecords);
  const report = {
    schema: 1,
    benchmark: "pi-idea-selector-latency-accuracy-v1",
    runId,
    generatedAt: new Date().toISOString(),
    model: "openai-codex/gpt-5.6-luna",
    repetitions,
    backgroundTagging: {
      calls: background.length,
      requiredEvidenceRecall: prepared.reduce((sum, entry) => sum + entry.extractionRecall, 0) / prepared.length,
      cachedCalls: background.filter((record) => !record.usage).length,
      measuredUsage: background.reduce((sum, record) => sum + (record.usage?.total || 0), 0),
      meanLatencyMs: Math.round(background.reduce((sum, record) => sum + (record.ms || 0), 0) / background.length),
    },
    conditions: aggregates,
    rows,
    aggregateLunaBudget: ledger.ledger,
  };
  const path = resolve(resultsDir, `${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ path, backgroundTagging: report.backgroundTagging, conditions: aggregates, aggregateUsage: ledger.ledger.usage }, null, 2)}\n`);
} finally {
  tagger.close();
  selector.close();
  answerer.close();
}
