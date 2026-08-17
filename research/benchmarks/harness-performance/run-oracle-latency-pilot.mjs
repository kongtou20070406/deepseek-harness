import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkCases } from "./cases.mjs";
import { LunaBudgetLedger } from "./budget-ledger.mjs";
import { completeLuna, LunaRpcClient } from "./luna-client.mjs";
import { groupTurns, serializeMessage } from "../../../pi-idea-extension/src/context-compiler.js";

const here = dirname(fileURLToPath(import.meta.url));
const runId = `oracle-latency-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const ledger = await new LunaBudgetLedger(join(here, "luna-budget.json")).load();
const rpc = new LunaRpcClient({ timeoutMs: 180_000 });

function taskPrompt(item, nonce) {
  const options = Object.entries(item.options).map(([key, value]) => `${key}. ${value}`).join("\n");
  const tail = groupTurns(item.messages).slice(-2).flatMap((turn) => turn.messages).map(serializeMessage).join("\n\n");
  return `<authoritative_idea>\n${item.p0}\n</authoritative_idea>\n` +
    `<current_stage>\n${item.stage}\n</current_stage>\n` +
    `<assembled_context condition="oracle_minimum">\n${item.oracleEvidence}\n\n<recent_raw>\n${tail}\n</recent_raw>\n</assembled_context>\n` +
    `<task>\n${item.question}\n\n${options}\n</task>\n` +
    `只输出一行 JSON，不要解释：{"answer":"A/B/C/D","evidence":["证据ID"]}。evidence 只列真正决定答案的历史证据 ID。\n` +
    `<latency_nonce>${nonce}</latency_nonce>`;
}

function parse(text) {
  try { return JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || "{}"); }
  catch { return {}; }
}

async function chargedCall(prompt, item, transport) {
  const condition = `oracle-${transport}`;
  const reservation = ledger.reserve({ prompt, maxTokens: 300, runId, caseId: item.id, condition });
  try {
    const result = transport === "rpc" ? await rpc.complete(prompt) : await completeLuna(prompt, { maxTokens: 300 });
    const charged = await ledger.settle(reservation, result.usage);
    const parsed = parse(result.text);
    return { caseId: item.id, transport, expected: item.answer, answer: parsed.answer, correct: parsed.answer === item.answer, ms: result.ms, firstTokenMs: result.firstTokenMs ?? null, initMs: result.initMs ?? null, usage: charged };
  } catch (error) {
    await ledger.settle(reservation, null, { failed: true, error: error.message });
    throw error;
  }
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (position - low));
}

function aggregate(rows) {
  const values = rows.map((row) => row.ms);
  const ttft = rows.map((row) => row.firstTokenMs).filter(Number.isFinite);
  return {
    calls: rows.length,
    accuracy: rows.filter((row) => row.correct).length / rows.length,
    meanMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    medianMs: quantile(values, 0.5),
    p75Ms: quantile(values, 0.75),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    medianFirstTokenMs: ttft.length ? quantile(ttft, 0.5) : null,
  };
}

const rows = [];
try {
  const cases = benchmarkCases(8);
  // Alternate transports to reduce time-of-day bias. A unique nonce prevents
  // accidental response-cache reuse while leaving task semantics unchanged.
  for (let index = 0; index < cases.length; index += 1) {
    const order = index % 2 ? ["rpc", "spawn"] : ["spawn", "rpc"];
    for (const transport of order) {
      const item = cases[index];
      const row = await chargedCall(taskPrompt(item, `${runId}-${index}-${transport}`), item, transport);
      rows.push(row);
      process.stdout.write(`${item.id} ${transport} correct=${row.correct} ms=${row.ms} ttft=${row.firstTokenMs ?? "n/a"}\n`);
    }
  }
} finally {
  rpc.close();
}

const report = {
  schema: 1,
  runId,
  generatedAt: new Date().toISOString(),
  model: "openai-codex/gpt-5.6-luna",
  conditions: {
    spawn: aggregate(rows.filter((row) => row.transport === "spawn")),
    warmRpc: aggregate(rows.filter((row) => row.transport === "rpc")),
  },
  rows,
  aggregateLunaBudget: ledger.ledger,
};
const path = resolve(here, "results", `${runId}.json`);
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ path, conditions: report.conditions, aggregateUsage: ledger.ledger.usage }, null, 2)}\n`);
