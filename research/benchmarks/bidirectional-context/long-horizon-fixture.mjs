import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { estimateTokens } from "../../../pi-idea-extension/src/core.js";
import { compileBidirectionalContext, compileEvidenceLadderContext } from "./compiler.mjs";
import { neutralEvidenceFromCompilation } from "./local-ablation-protocol.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function serialize(message) {
  return `${String(message.role || "unknown").toUpperCase()}: ${String(message.content || "")}`;
}

function makeMessage(turn, sourceCaseKey, index) {
  return {
    role: turn.role,
    content: turn.content,
    entryId: turn.turnId,
    parentEntryId: index ? null : null,
    sessionId: sourceCaseKey,
    researchIdeaHash: sourceCaseKey,
    researchStageHash: `stage:${sourceCaseKey}`,
    entryTimestamp: null,
    timestamp: null,
  };
}

/** Build a multi-project history in which the target project is old rather
 * than the live tail.  Source case IDs are locator metadata only; no MemSyco
 * memory/evaluation fields enter the online view. */
export function buildLongHorizonCase(target, distractors, { targetAfter = 2 } = {}) {
  if (!target?.selectorView || !target?.reference) throw new Error("target case is required");
  const sources = [...distractors];
  sources.splice(Math.min(targetAfter, sources.length), 0, target);
  const history = [];
  const messages = [];
  const sourceRanges = [];
  for (const source of sources) {
    const start = history.length;
    for (let index = 0; index < source.selectorView.history.length; index += 1) {
      const turn = source.selectorView.history[index];
      history.push({ role: turn.role, content: turn.content, turnId: turn.turnId, timestamp: turn.timestamp ?? null });
      messages.push(makeMessage(turn, source.selectorView.caseKey, index));
    }
    sourceRanges.push({
      caseKey: source.selectorView.caseKey,
      start,
      end: history.length,
      target: source.selectorView.caseKey === target.selectorView.caseKey,
    });
  }
  return {
    selectorView: Object.freeze({
      caseKey: target.selectorView.caseKey,
      question: target.selectorView.question,
      history: Object.freeze(history),
    }),
    reference: target.reference,
    messages: Object.freeze(messages),
    sourceRanges: Object.freeze(sourceRanges),
    targetRange: Object.freeze(sourceRanges.find((row) => row.target)),
  };
}

function selectedEvidence(selectorView, indexes) {
  return [...new Set(indexes)].sort((left, right) => left - right).map((historyIndex) => {
    const turn = selectorView.history[historyIndex];
    return {
      kind: "cold",
      provenance: {
        turnId: turn.turnId,
        historyIndex,
        role: turn.role,
        timestamp: turn.timestamp ?? null,
        sourceUnitId: `sha256:${sha256(turn.content)}`,
      },
      verbatim: turn.content,
    };
  });
}

/** Transparent extractive rolling baseline: a recent verbatim tail plus a
 * bounded verbatim prefix sketch.  It is deliberately not described as the
 * proprietary Codex compactor. */
export function compileRollingExtractiveContext(selectorView, messages, { budget = 8192 } = {}) {
  const started = performance.now();
  const rows = messages.map((message, index) => ({
    index,
    role: message.role,
    text: serialize(message),
    tokens: estimateTokens(serialize(message)),
  }));
  const tailBudget = Math.floor(budget * 0.62);
  const sketchBudget = Math.floor(budget * 0.28);
  const tail = [];
  let tailTokens = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (tail.length && tailTokens + row.tokens > tailBudget) break;
    if (row.tokens > tailBudget && !tail.length) continue;
    tail.unshift(row);
    tailTokens += row.tokens;
  }
  const tailStart = tail.length ? tail[0].index : rows.length;
  const prefix = rows.slice(0, tailStart);
  const ranked = prefix.map((row) => ({
    ...row,
    rank: (row.role === "user" ? 4 : row.role === "toolResult" ? 3 : 1)
      + (/(?:goal|目标|constraint|约束|禁止|不要|只做|当前|active|mainline|policy|verified|验收)/i.test(row.text) ? 3 : 0)
      + row.index / Math.max(1, rows.length),
  })).sort((left, right) => right.rank - left.rank || right.index - left.index);
  const sketch = [];
  let sketchTokens = 0;
  for (const row of ranked) {
    if (sketchTokens + row.tokens > sketchBudget) continue;
    sketch.push(row);
    sketchTokens += row.tokens;
  }
  sketch.sort((left, right) => left.index - right.index);
  const context = [
    "<evicted_prefix_extract verbatim=\"true\">",
    ...sketch.map((row) => row.text),
    "</evicted_prefix_extract>",
    "<recent_raw_tail verbatim=\"true\">",
    ...tail.map((row) => row.text),
    "</recent_raw_tail>",
  ].join("\n\n");
  const contextTokens = estimateTokens(context);
  if (contextTokens > budget) throw new Error(`rolling extract exceeded budget: ${contextTokens} > ${budget}`);
  const selectedIndexes = [...sketch, ...tail].map((row) => row.index);
  return {
    overflow: false,
    context,
    contextTokens,
    assemblyMs: performance.now() - started,
    evidenceView: selectedEvidence(selectorView, selectedIndexes),
    outputHash: sha256(context),
    selectedIndexes,
  };
}

export function compileLongHorizonAssemblies(longCase, {
  rawBudget = 32768,
  compactBudget = 8192,
} = {}) {
  const raw = compileBidirectionalContext({
    messages: longCase.messages,
    query: longCase.selectorView.question,
    condition: "raw",
    budget: rawBudget,
    liveBlocks: 0,
  });
  if (raw.overflow) throw new Error(`${longCase.selectorView.caseKey} raw-long overflow`);
  const rolling = compileRollingExtractiveContext(longCase.selectorView, longCase.messages, { budget: compactBudget });
  const candidate = compileEvidenceLadderContext({
    messages: longCase.messages,
    query: longCase.selectorView.question,
    budget: compactBudget,
    activeContext: {
      ideaHash: longCase.selectorView.caseKey,
      stageHash: `stage:${longCase.selectorView.caseKey}`,
    },
  });
  if (candidate.overflow) throw new Error(`${longCase.selectorView.caseKey} evidence-ladder overflow`);
  return {
    "raw-long": {
      overflow: false,
      context: raw.context,
      contextTokens: raw.contextTokens,
      assemblyMs: raw.assemblyMs,
      evidenceView: neutralEvidenceFromCompilation(longCase.selectorView, raw),
      outputHash: raw.manifest.outputHash,
      manifest: raw.manifest,
    },
    "rolling-extractive": rolling,
    "evidence-ladder": {
      overflow: false,
      context: candidate.context,
      contextTokens: candidate.contextTokens,
      assemblyMs: candidate.assemblyMs,
      evidenceView: neutralEvidenceFromCompilation(longCase.selectorView, candidate),
      outputHash: candidate.manifest.outputHash,
      manifest: candidate.manifest,
    },
  };
}

export function targetEvidenceCoverage(longCase, assembly) {
  const selected = new Set(assembly.evidenceView.map((row) => row.provenance.historyIndex));
  const total = longCase.targetRange.end - longCase.targetRange.start;
  let covered = 0;
  for (let index = longCase.targetRange.start; index < longCase.targetRange.end; index += 1) {
    if (selected.has(index)) covered += 1;
  }
  return total ? covered / total : 0;
}
