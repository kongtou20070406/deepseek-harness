import { performance } from "node:perf_hooks";

import { estimateTokens } from "../../../pi-idea-extension/src/core.js";
import { compileContext } from "../../../pi-idea-extension/src/context-compiler.js";
import { assertNoGarageGoldLeak } from "./adapter.mjs";

export const GARAGE_SELECTION_PROTOCOL = "garage-selection-v1";

const STOP_WORDS = new Set((
  "a an and are as at be been being by can could did do does for from had has have " +
  "how i if in into is it its may might of on or our should that the their them then " +
  "there these they this those to was were what when where which who why will with would " +
  "about after before during most more much many some any all each than through under over"
).split(/\s+/));

const TEMPORAL_QUERY = /\b(?:as of|current(?:ly)?|latest|newest|recent(?:ly)?|today|now|this (?:year|month|week)|last (?:year|month|week)|when|how long|still|up to date|in \d{4}|since \d{4})\b/i;
const SET_QUERY = /\b(?:compare|comparison|difference|versus|vs\.?|list|which (?:ones|countries|companies|states)|what are|how many|all|each|respectively|top \d+)\b/i;
const NEGATION = /\b(?:no|not|never|neither|without|cannot|can't|didn't|doesn't|isn't|wasn't|weren't|won't|false|declined|decreased)\b/i;

function stem(token) {
  if (/^\d/.test(token) || token.length < 5) return token;
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function tokens(text, { keepStopWords = false } = {}) {
  return (String(text || "").toLowerCase().match(/[a-z0-9]+(?:[._'-][a-z0-9]+)*/g) || [])
    .map((token) => token.replace(/'s$/u, ""))
    .map(stem)
    .filter((token) => token.length > 1 && (keepStopWords || !STOP_WORDS.has(token)));
}

function tokenSet(text) {
  return new Set(tokens(text));
}

function overlap(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  const common = overlap(left, right);
  return common / Math.max(1, left.size + right.size - common);
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function parseDurationDays(value) {
  const raw = String(value || "").toLowerCase().trim();
  if (!raw || /unknown|not defined|n\/a/.test(raw)) return null;
  let days = 0;
  let matched = false;
  const units = [
    [/([\d.]+)\s*(?:year|years|yr|yrs)\b/g, 365],
    [/([\d.]+)\s*(?:month|months)\b/g, 30.4375],
    [/([\d.]+)\s*(?:week|weeks|wk|wks)\b/g, 7],
    [/([\d.]+)\s*(?:day|days)\b/g, 1],
    [/([\d.]+)\s*(?:hour|hours|hr|hrs)\b/g, 1 / 24],
    [/([\d.]+)\s*(?:minute|minutes|min|mins)\b/g, 1 / 1440],
  ];
  for (const [pattern, multiplier] of units) {
    for (const match of raw.matchAll(pattern)) {
      days += Number(match[1]) * multiplier;
      matched = true;
    }
  }
  return matched && Number.isFinite(days) ? Math.max(0, days) : null;
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw || /not defined|unknown|published date:\s*n\/a|^n\/a$/i.test(raw)) return null;
  const timestamp = Date.parse(raw.replace(/^published date:\s*/i, ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function temporalFeature(passage, question, questionDate) {
  const questionTime = parseDate(questionDate);
  const sourceTime = parseDate(passage.provenance.sourceDate);
  const relativeDays = parseDurationDays(passage.provenance.sourceAge);
  const temporalIntent = TEMPORAL_QUERY.test(question);
  let ageDays = relativeDays;
  if (ageDays == null && questionTime != null && sourceTime != null) {
    ageDays = (questionTime - sourceTime) / 86_400_000;
  }
  const future = ageDays != null && ageDays < -1;
  const known = ageDays != null;
  const consistency = future ? 0 : known ? 1 : 0.55;
  const freshness = !temporalIntent
    ? consistency
    : future
      ? 0
      : known
        ? 1 / (1 + Math.max(0, ageDays) / 30)
        : 0.35;
  return { ageDays, known, future, temporalIntent, consistency, freshness };
}

function factualSignature(text) {
  const raw = String(text || "");
  return {
    numbers: new Set(raw.match(/\b\d+(?:[.,]\d+)*(?:%|bn|m|k|million|billion|trillion)?\b/gi) || []),
    negated: NEGATION.test(raw),
  };
}

function possibleConflict(left, right) {
  const lexical = jaccard(left.termSet, right.termSet);
  if (lexical < 0.16) return false;
  if (left.signature.negated !== right.signature.negated) return true;
  if (!left.signature.numbers.size || !right.signature.numbers.size) return false;
  const common = overlap(left.signature.numbers, right.signature.numbers);
  return common === 0 && lexical >= 0.24;
}

function passageEnvelope(passage) {
  const provenance = passage.provenance;
  return `[EVIDENCE id=${passage.passageId}] [PROVENANCE provider=${JSON.stringify(provenance.provider)} source_date=${JSON.stringify(provenance.sourceDate)} source_age=${JSON.stringify(provenance.sourceAge)} question_date=${JSON.stringify(provenance.questionDate)} citation=${provenance.citationId}] ${passage.text}`;
}

function selectionItem(passage, extra = {}) {
  const context = passageEnvelope(passage);
  return {
    passageId: passage.passageId,
    citationId: passage.provenance.citationId,
    text: passage.text,
    context,
    tokens: estimateTokens(context),
    provenance: { ...passage.provenance },
    ...extra,
  };
}

export function garageSelectorToPiMessages(selectorView) {
  assertNoGarageGoldLeak(selectorView);
  return selectorView.passages.map((passage) => ({ role: "user", content: passageEnvelope(passage) }));
}

function sourcePassageId(selectedPassage) {
  const raw = selectedPassage?.unit?.messages?.map((message) => String(message?.content || "")).join("\n") || "";
  return raw.match(/\[EVIDENCE\s+id=([^\]\s]+)\]/i)?.[1] || selectedPassage?.evidenceId || null;
}

/** Condition A: call the production local selector rather than reimplementing it. */
export function selectWithProductionLocal(selectorView, {
  retrievalBudget = 4_096,
  maxPassages = 8,
} = {}) {
  assertNoGarageGoldLeak(selectorView);
  const byId = new Map(selectorView.passages.map((passage) => [passage.passageId, passage]));
  const started = performance.now();
  const compiled = compileContext({
    messages: garageSelectorToPiMessages(selectorView),
    prompt: `${selectorView.question}\nQuestion date: ${selectorView.questionDate}`,
    idea: "",
    stage: "",
    liveTurns: 0,
    retrievalBudget,
    maxRetrievedUnits: maxPassages,
    foldMinTokens: 1,
    foldMaxTokens: 1_000_000,
    localEvidenceIndex: true,
  });
  const assemblyMs = performance.now() - started;
  const selected = new Map();
  for (const segment of compiled.selectedPassages || []) {
    const passageId = sourcePassageId(segment);
    const passage = byId.get(passageId);
    if (!passage) continue;
    const existing = selected.get(passageId) || selectionItem(passage, {
      tokens: 0,
      selectedSegments: [],
      productionScores: [],
    });
    existing.tokens += segment.tokens || estimateTokens(segment.quote || "");
    existing.selectedSegments.push(segment.quote || "");
    existing.productionScores.push(segment.score || 0);
    selected.set(passageId, existing);
  }
  const items = [...selected.values()].sort((left, right) => left.provenance.citationOrdinal - right.provenance.citationOrdinal);
  return {
    protocol: GARAGE_SELECTION_PROTOCOL,
    condition: "A-production-local",
    selected: items,
    sufficient: items.length > 0,
    sufficiencyReason: items.length ? "production-positive-score" : "no-positive-production-score",
    conflicts: [],
    metrics: {
      assemblyMs,
      selectedPassages: items.length,
      selectedSegments: compiled.selectedPassages?.length || 0,
      selectedTokens: items.reduce((total, item) => total + item.tokens, 0),
      production: { ...compiled.metrics },
    },
  };
}

function candidateFeatures(selectorView) {
  const queryTokens = tokens(selectorView.question);
  const querySet = new Set(queryTokens);
  const documents = selectorView.passages.map((passage) => tokenSet(passage.text));
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of document) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  const weights = new Map([...querySet].map((term) => [
    term,
    Math.log(1 + (selectorView.passages.length + 0.5) / ((documentFrequency.get(term) || 0) + 0.5))
      * (/^\d/.test(term) ? 1.5 : 1),
  ]));
  const totalQueryWeight = [...weights.values()].reduce((sum, value) => sum + value, 0) || 1;
  const rows = selectorView.passages.map((passage, index) => {
    const termSet = documents[index];
    let matchedWeight = 0;
    for (const [term, weight] of weights) if (termSet.has(term)) matchedWeight += weight;
    const coverage = matchedWeight / totalQueryWeight;
    const lengthNorm = 1 / (1 + Math.max(0, termSet.size - 120) / 240);
    const lexical = clamp(coverage * (0.88 + 0.12 * lengthNorm));
    return {
      passage,
      termSet,
      signature: factualSignature(passage.text),
      temporal: temporalFeature(passage, selectorView.question, selectorView.questionDate),
      matchedTerms: new Set([...querySet].filter((term) => termSet.has(term))),
      coverage,
      lexical,
    };
  });
  return { rows, weights, totalQueryWeight, querySet };
}

function weightedCoverage(covered, weights, total) {
  let value = 0;
  for (const term of covered) value += weights.get(term) || 0;
  return value / Math.max(1e-9, total);
}

/**
 * Condition B: deterministic evidence-set optimization over the closed online
 * view. Provider is never an authority score; it is only a weak diversity bit.
 */
export function selectJudgmentEvidenceSet(selectorView, {
  retrievalBudget = 4_096,
  maxPassages = 8,
} = {}) {
  assertNoGarageGoldLeak(selectorView);
  const started = performance.now();
  const { rows, weights, totalQueryWeight } = candidateFeatures(selectorView);
  const selected = [];
  const covered = new Set();
  let usedTokens = 0;
  const topLexical = Math.max(0, ...rows.map((row) => row.lexical));
  const minimumLexical = Math.max(0.035, topLexical * 0.18);
  const multiAspect = SET_QUERY.test(selectorView.question)
    || /\b(?:and|while|along with|together with)\b/i.test(selectorView.question);
  const desiredMinimum = Math.min(maxPassages, multiAspect ? 4 : 3);

  while (selected.length < Math.max(1, maxPassages)) {
    let best = null;
    for (const row of rows) {
      if (selected.includes(row)) continue;
      const itemTokens = estimateTokens(passageEnvelope(row.passage));
      if (usedTokens + itemTokens > retrievalBudget) continue;
      const newTerms = new Set([...row.matchedTerms].filter((term) => !covered.has(term)));
      const coverageGain = weightedCoverage(newTerms, weights, totalQueryWeight);
      const similarities = selected.map((other) => jaccard(row.termSet, other.termSet));
      const maximumSimilarity = similarities.length ? Math.max(...similarities) : 0;
      const novelty = 1 - maximumSimilarity;
      const conflictWith = selected.filter((other) => possibleConflict(row, other));
      // Once a passage adds no uncovered question aspect, a lexically similar
      // non-conflicting passage is a duplicate rather than independent gain.
      if (selected.length && coverageGain < 0.005 && maximumSimilarity > 0.28 && conflictWith.length === 0) continue;
      const hasIndependentProvider = selected.length > 0
        && selected.some((other) => other.passage.provenance.provider !== row.passage.provenance.provider);
      // Domain diversity is deliberately tiny: web/ent is not credibility.
      const independence = row.lexical * novelty + (hasIndependentProvider ? 0.01 : 0);
      const temporalValue = row.temporal.temporalIntent
        ? row.temporal.freshness
        : row.temporal.consistency * 0.25;
      const conflictValue = conflictWith.length && row.lexical >= topLexical * 0.35 ? 0.07 : 0;
      const redundancyPenalty = maximumSimilarity >= 0.72 ? (maximumSimilarity - 0.72) * 0.9 : 0;
      const futurePenalty = row.temporal.future ? 0.35 : 0;
      const marginal = 0.48 * row.lexical
        + 0.34 * coverageGain
        + 0.18 * independence
        + 0.08 * temporalValue
        + conflictValue
        - redundancyPenalty
        - futurePenalty;
      if (!best || marginal > best.marginal
        || (marginal === best.marginal && row.passage.provenance.citationOrdinal < best.row.passage.provenance.citationOrdinal)) {
        best = { row, marginal, coverageGain, maximumSimilarity, conflictWith, itemTokens };
      }
    }
    if (!best || best.row.lexical < minimumLexical) break;
    if (selected.length >= desiredMinimum && best.coverageGain < 0.01 && best.conflictWith.length === 0) break;
    const currentCoverage = weightedCoverage(covered, weights, totalQueryWeight);
    const enoughForSimple = selected.length >= 1 && currentCoverage >= 0.62;
    const enoughForSet = selected.length >= 2 && currentCoverage >= 0.68;
    const enough = SET_QUERY.test(selectorView.question) ? enoughForSet : enoughForSimple;
    const weakMarginal = best.coverageGain < 0.015
      && best.maximumSimilarity > 0.25
      && best.conflictWith.length === 0;
    if (selected.length >= desiredMinimum && enough && weakMarginal) break;
    if (selected.length >= desiredMinimum && best.marginal < Math.max(0.08, selected[0].lexical * 0.15)) break;
    selected.push(best.row);
    usedTokens += best.itemTokens;
    for (const term of best.row.matchedTerms) covered.add(term);
  }

  const conflicts = [];
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (!possibleConflict(selected[left], selected[right])) continue;
      conflicts.push({
        left: selected[left].passage.passageId,
        right: selected[right].passage.passageId,
        type: selected[left].signature.negated !== selected[right].signature.negated
          ? "negation-mismatch"
          : "numeric-mismatch",
      });
    }
  }
  const achievedCoverage = weightedCoverage(covered, weights, totalQueryWeight);
  const minimumCount = SET_QUERY.test(selectorView.question) ? 2 : 1;
  const sufficient = selected.length >= minimumCount
    && topLexical >= 0.075
    && achievedCoverage >= (SET_QUERY.test(selectorView.question) ? 0.34 : 0.25);
  const items = selected
    .map((row) => selectionItem(row.passage, {
      lexical: row.lexical,
      temporal: { ...row.temporal },
    }))
    .sort((left, right) => left.provenance.citationOrdinal - right.provenance.citationOrdinal);
  return {
    protocol: GARAGE_SELECTION_PROTOCOL,
    condition: "B-judgment-set",
    selected: items,
    sufficient,
    sufficiencyReason: sufficient
      ? `coverage=${achievedCoverage.toFixed(3)}`
      : `insufficient coverage=${achievedCoverage.toFixed(3)} top=${topLexical.toFixed(3)}`,
    conflicts,
    metrics: {
      assemblyMs: performance.now() - started,
      selectedPassages: items.length,
      selectedSegments: items.length,
      selectedTokens: items.reduce((total, item) => total + item.tokens, 0),
      queryCoverage: achievedCoverage,
      topLexical,
      conflictPairs: conflicts.length,
    },
  };
}

export function selectionContext(selection) {
  return selection.selected.map((item) => item.context).join("\n\n");
}
