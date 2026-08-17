import { createHash } from "node:crypto";
import { estimateTokens } from "./core.js";
import { CONTEXT_POLICY } from "./context-policy.js";

export const BIDIRECTIONAL_CONDITIONS = Object.freeze([
  "raw",
  "positive-only",
  "gc-only",
  "bidirectional",
  "bidirectional-heat",
]);
export const EVIDENCE_CONTEXT_COMPILER_VERSION = "lsc-epc-authority-closure-v4";
export const EVIDENCE_LADDER_VERSION = "proof-carrying-dialogue-islands-v6.4";

const FACT_KINDS = new Set(["user_text", "assistant_public", "assistant_final", "tool_result", "bash_result"]);
const NEVER_FACT_KINDS = new Set([
  "assistant_thinking",
  "assistant_truncated",
  "assistant_incomplete",
  "tool_call",
  "bash_command",
  "custom_derived",
  "compaction_derived",
  "ui_noise",
]);

// These signals are retrieval metadata only. They are never rendered as facts.
// The expressions intentionally require first-person or explicit normative
// language so ordinary topical prose does not become an authority root.
const AUTHORITY_UPDATE = /(?:\b(?:anymore|no longer|instead|reconsider(?:ing|ed)?|shift(?:ing|ed)?\s+(?:to|toward)|switch(?:ing|ed)?\s+(?:to|from)|mov(?:e|ed|ing)\s+away|drift(?:ed|ing)?\s+away|done with|lost interest|changed? my mind|from now on|lately (?:i(?:'ve| have) )?(?:discovered|realized|found)|now i(?:'m| am)?\s+(?:prefer|enjoy|want|into)|actually (?:prefer|enjoy|want)|resubscrib(?:e|ed|ing)|return(?:ed|ing)?\s+to|start(?:ed|ing)?\s+again|matters? more)\b|不再|以后(?:都)?|现在(?:更|开始)?|最近(?:发现|意识到)|改成|改为|转向|重新考虑|撤回|作废|取代|不想再)/i;
const AUTHORITY_PREFERENCE = /(?:\b(?:i\s+(?:prefer|want|need|like|dislike|value|would rather|do not want|don't want|must|only)|i(?:'d| would)\s+rather|i(?:'m| am)\s+(?:really\s+)?into|my\s+(?:preference|priority|constraint)|for me)\b|我(?:更|最)?(?:喜欢|偏好|希望|想要|需要|不喜欢|不要)|对我来说|我的(?:偏好|优先级|约束)|必须|只能|不要|不许|禁止)/i;
const AUTHORITY_SCOPE = /(?:\b(?:only for|except|unless|within|outside|applies? to|does not apply|don't assume|do not assume|minimal social|without|rather than)\b|仅限|只适用|不适用|除非|范围内|范围外|不要假设|而不是|不依赖|无需)/i;
const AUTHORITY_ROOT_REASONS = new Set(["authority-update", "authority-scope-bridge"]);
const RELATION_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "about", "have", "has", "had", "was", "were", "are", "but", "not", "you", "your", "their", "they", "them", "our", "out", "all", "can", "could", "would", "should", "will", "just", "really", "more", "some", "any", "how", "what", "when", "where", "which", "while", "than", "then", "also", "been", "being", "because", "after", "before", "over", "under", "want", "need", "like", "prefer", "rather", "now", "instead",
]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function textParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("\n");
}

function stopKind(stopReason) {
  if (stopReason === "stop") return "assistant_final";
  if (stopReason === "toolUse") return "assistant_public";
  if (stopReason === "length") return "assistant_truncated";
  if (stopReason === "error" || stopReason === "aborted") return "assistant_incomplete";
  return "assistant_public";
}

function extractRefs(raw) {
  const text = String(raw || "");
  const paths = text.match(/(?:[A-Za-z]:\\|\.?\.?\/)[^\s"'<>|]+/g) || [];
  const ids = text.match(/\b(?:[A-Z][A-Z0-9_.-]{2,}|[A-Za-z]+[-_:]\d+[A-Za-z0-9_.:-]*)\b/g) || [];
  const symbols = text.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g) || [];
  return [...new Set([...paths, ...ids, ...symbols].map((value) => value.toLowerCase()))].sort();
}

function provenanceFor(message, messageIndex, partIndex = 0, overrides = {}) {
  const entryId = message?.entryId || message?.id || `synthetic-entry-${messageIndex}`;
  return {
    sessionId: message?.sessionId || "synthetic-session",
    entryId,
    parentEntryId: message?.parentEntryId || message?.parentId || null,
    entryTimestamp: message?.entryTimestamp ?? message?.timestamp ?? null,
    messageTimestamp: message?.timestamp ?? null,
    sourceOrder: messageIndex * 1_000_000 + partIndex * 1000,
    contentIndex: partIndex,
    ...overrides,
  };
}

function makeBlock({ message, messageIndex, partIndex = 0, kind, raw, source, callId = null, metadata = {} }) {
  const provenance = provenanceFor(message, messageIndex, partIndex, metadata.provenance || {});
  const rawText = String(raw || "");
  const rawHash = sha256(rawText);
  const logicalEventId = metadata.logicalEventId || `${provenance.entryId}:${partIndex}:${kind}`;
  const loopId = metadata.loopId || message?.loopId || provenance.entryId;
  const sliceType = ["tool_call", "tool_result", "bash_command", "bash_result"].includes(kind) ? "tool-evidence" : "dialogue";
  const assemblyIslandId = metadata.assemblyIslandId || message?.assemblyIslandId
    || metadata.dialogueBlockId || message?.dialogueBlockId || `${loopId}:${sliceType}`;
  const blockId = sha256(canonical({
    sessionId: provenance.sessionId,
    entryId: provenance.entryId,
    contentIndex: partIndex,
    fragmentIndex: metadata.fragmentIndex || 0,
    charStart: metadata.charStart || 0,
    charEnd: metadata.charEnd ?? rawText.length,
    requiresEventClosure: Boolean(metadata.requiresEventClosure),
    kind,
    rawHash,
  }));
  const authoritySignals = kind === "user_text" ? detectAuthoritySignals(rawText) : Object.freeze({ update: false, preference: false, scope: false, any: false });
  return Object.freeze({
    schema: 1,
    blockId,
    logicalEventId,
    loopId,
    sliceType,
    assemblyIslandId,
    dialogueBlockId: assemblyIslandId,
    fragmentIndex: metadata.fragmentIndex || 0,
    fragmentCount: metadata.fragmentCount || 1,
    charStart: metadata.charStart || 0,
    charEnd: metadata.charEnd ?? rawText.length,
    requiresEventClosure: Boolean(metadata.requiresEventClosure),
    kind,
    role: String(message?.role || "unknown"),
    source,
    callId,
    raw: rawText,
    rawHash,
    tokens: estimateTokens(rawText),
    refs: extractRefs(rawText),
    factCandidate: FACT_KINDS.has(kind),
    authority: kind === "user_text" ? "user" : kind === "tool_result" || kind === "bash_result" ? "tool" : "model",
    authoritySignals,
    provenance,
    stateKey: metadata.stateKey || message?.stateKey || null,
    stateVersion: metadata.stateVersion ?? message?.stateVersion ?? null,
    supersedes: [...new Set(metadata.supersedes || message?.supersedes || [])],
    dependsOn: [...new Set(metadata.dependsOn || message?.dependsOn || [])],
    contradicts: [...new Set(metadata.contradicts || message?.contradicts || [])],
    validates: [...new Set(metadata.validates || message?.validates || [])],
    operationId: metadata.operationId || message?.operationId || null,
    resolvedBy: metadata.resolvedBy || message?.resolvedBy || null,
    isError: Boolean(metadata.isError ?? message?.isError),
    excludeFromContext: Boolean(metadata.excludeFromContext ?? message?.excludeFromContext),
    recoverableRef: metadata.recoverableRef || message?.recoverableRef || null,
    sourceIdentity: metadata.sourceIdentity || message?.sourceIdentity || null,
    streamFinalId: metadata.streamFinalId || message?.streamFinalId || null,
    fresh: Boolean(metadata.fresh ?? message?.fresh),
    unresolved: Boolean(metadata.unresolved ?? message?.unresolved),
    researchIdeaHash: metadata.researchIdeaHash ?? message?.researchIdeaHash ?? null,
    researchIdeaVersion: metadata.researchIdeaVersion ?? message?.researchIdeaVersion ?? null,
    researchStageHash: metadata.researchStageHash ?? message?.researchStageHash ?? null,
  });
}

function detectAuthoritySignals(raw) {
  const text = String(raw || "");
  const update = AUTHORITY_UPDATE.test(text);
  const preference = AUTHORITY_PREFERENCE.test(text);
  const scope = AUTHORITY_SCOPE.test(text);
  return Object.freeze({ update, preference, scope, any: update || preference || scope });
}

function hardSlice(text, absoluteStart, hardTokens) {
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let low = offset + 1;
    let high = text.length;
    let fit = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokens(text.slice(offset, middle)) <= hardTokens) {
        fit = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (fit < text.length) {
      const tail = text.slice(offset, fit);
      const preferred = Math.max(
        tail.lastIndexOf("\n"),
        tail.lastIndexOf(" "),
        tail.lastIndexOf("\t"),
      );
      if (preferred >= Math.floor(tail.length * 0.75)) fit = offset + preferred + 1;
    }
    parts.push({
      raw: text.slice(offset, fit),
      charStart: absoluteStart + offset,
      charEnd: absoluteStart + fit,
      requiresEventClosure: true,
    });
    offset = fit;
  }
  return parts;
}

/** Split an event into non-overlapping verbatim fragments. Concatenating raw
 * fragments always reconstructs the original event byte-for-byte in JS text. */
export function splitVerbatimFragments(raw, {
  targetTokens = CONTEXT_POLICY.fragmentation.targetTokens,
  hardTokens = CONTEXT_POLICY.fragmentation.hardTokens,
} = {}) {
  const text = String(raw || "");
  if (!text) return [];
  if (estimateTokens(text) <= hardTokens) return [{
    raw: text,
    charStart: 0,
    charEnd: text.length,
    requiresEventClosure: false,
  }];

  const natural = [];
  const boundary = /(?:\r?\n\r?\n|\r?\n|[。！？!?；;]+[ \t]*)/g;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    if (end > start) natural.push({ raw: text.slice(start, end), charStart: start, charEnd: end, requiresEventClosure: false });
    start = end;
  }
  if (start < text.length) natural.push({ raw: text.slice(start), charStart: start, charEnd: text.length, requiresEventClosure: false });
  if (!natural.length) natural.push({ raw: text, charStart: 0, charEnd: text.length, requiresEventClosure: false });

  const atomic = natural.flatMap((part) => estimateTokens(part.raw) <= hardTokens
    ? [part]
    : hardSlice(part.raw, part.charStart, hardTokens));
  const packed = [];
  let current = null;
  const flush = () => {
    if (current) packed.push(current);
    current = null;
  };
  for (const part of atomic) {
    if (!current) current = { ...part };
    else {
      const joined = current.raw + part.raw;
      if (estimateTokens(joined) > hardTokens) {
        flush();
        current = { ...part };
      } else {
        current = {
          raw: joined,
          charStart: current.charStart,
          charEnd: part.charEnd,
          requiresEventClosure: Boolean(current.requiresEventClosure || part.requiresEventClosure),
        };
      }
    }
    if (current && estimateTokens(current.raw) >= targetTokens) flush();
  }
  flush();
  return packed;
}

function appendEventBlocks(blocks, options) {
  const fragments = FACT_KINDS.has(options.kind)
    ? splitVerbatimFragments(options.raw)
    : [{ raw: String(options.raw || ""), charStart: 0, charEnd: String(options.raw || "").length }];
  const logicalEventId = `${options.message?.entryId || options.message?.id || `synthetic-entry-${options.messageIndex}`}:${options.partIndex || 0}:${options.kind}`;
  for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
    const fragment = fragments[fragmentIndex];
    blocks.push(makeBlock({
      ...options,
      raw: fragment.raw,
      metadata: {
        ...(options.metadata || {}),
        logicalEventId,
        fragmentIndex,
        fragmentCount: fragments.length,
        charStart: fragment.charStart,
        charEnd: fragment.charEnd,
        requiresEventClosure: Boolean(fragment.requiresEventClosure),
        provenance: {
          ...(options.metadata?.provenance || {}),
          sourceOrder: options.messageIndex * 1_000_000 + (options.partIndex || 0) * 1000 + fragmentIndex,
        },
      },
    }));
  }
}

/** Convert Pi-like messages into immutable typed blocks. SessionEntry metadata can
 * be attached to each message by the adapter; benchmark fixtures use synthetic IDs. */
export function blockizeMessages(messages = []) {
  const blocks = [];
  let loopId = null;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const original = messages[messageIndex] || {};
    if (String(original.role || "unknown") === "user") {
      loopId = original.loopId || original.entryId || original.id || `loop-${messageIndex}`;
    }
    if (!loopId) loopId = original.loopId || original.entryId || original.id || `loop-${messageIndex}`;
    const message = { ...original, loopId: original.loopId || loopId };
    const role = String(message.role || "unknown");
    if (role === "assistant" && Array.isArray(message.content)) {
      for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
        const part = message.content[partIndex] || {};
        if (part.type === "thinking") {
          appendEventBlocks(blocks, { message, messageIndex, partIndex, kind: "assistant_thinking", raw: part.thinking || part.text || "", source: "assistant" });
        } else if (part.type === "toolCall") {
          appendEventBlocks(blocks, { message, messageIndex, partIndex, kind: "tool_call", raw: canonical(part.arguments || {}), source: part.name || "tool", callId: part.id || part.toolCallId || null });
        } else if (part.type === "text" && part.text) {
          appendEventBlocks(blocks, { message, messageIndex, partIndex, kind: stopKind(message.stopReason), raw: part.text, source: "assistant" });
        }
      }
      continue;
    }
    if (role === "toolResult") {
      appendEventBlocks(blocks, { message, messageIndex, kind: "tool_result", raw: textParts(message.content), source: message.toolName || "tool", callId: message.toolCallId || message.callId || null });
    } else if (role === "bashExecution") {
      appendEventBlocks(blocks, { message, messageIndex, partIndex: 0, kind: "bash_command", raw: message.command || "", source: "bash", metadata: { excludeFromContext: message.excludeFromContext } });
      appendEventBlocks(blocks, { message, messageIndex, partIndex: 1, kind: "bash_result", raw: message.output || "", source: "bash", metadata: { isError: message.exitCode !== 0, excludeFromContext: message.excludeFromContext } });
    } else if (role === "custom") {
      const kind = /compact/i.test(String(message.customType || "")) ? "compaction_derived"
        : /status|spinner|progress|tui/i.test(String(message.customType || "")) ? "ui_noise"
          : "custom_derived";
      appendEventBlocks(blocks, { message, messageIndex, kind, raw: String(message.content || ""), source: message.customType || "custom" });
    } else if (role === "user") {
      appendEventBlocks(blocks, { message, messageIndex, kind: "user_text", raw: textParts(message.content), source: "user" });
    } else if (role === "assistant") {
      appendEventBlocks(blocks, { message, messageIndex, kind: stopKind(message.stopReason), raw: textParts(message.content), source: "assistant" });
    }
  }
  return blocks.filter((block) => block.raw.length > 0);
}

function terms(text) {
  const value = String(text || "").toLowerCase();
  const latin = (value.match(/[a-z0-9_./:-]{2,}/g) || [])
    .map((term) => term.replace(/^[./:-]+|[./:-]+$/g, ""))
    .filter((term) => term.length >= 2);
  const cjkRuns = value.match(/[\u3400-\u9fff]{2,}/g) || [];
  const cjk = cjkRuns.flatMap((run) => Array.from({ length: Math.max(0, run.length - 1) }, (_, index) => run.slice(index, index + 2)));
  return new Set([...latin, ...cjk]);
}

function relationTerms(text) {
  return new Set([...terms(text)].filter((term) => {
    if (RELATION_STOP_WORDS.has(term)) return false;
    if (/^[a-z]+$/i.test(term) && term.length < 3) return false;
    return true;
  }));
}

function termIntersectionSize(left, right) {
  let count = 0;
  for (const term of left) if (right.has(term)) count += 1;
  return count;
}

function recallMode(query) {
  return /(?:旧值|旧的|以前|之前|此前|上次|历史|曾经|当时|earlier|previous|formerly|old value|history)/i.test(String(query || ""))
    ? "historical"
    : "current";
}

function contextCompatibility(block, activeContext, mode) {
  if (!activeContext || mode === "historical") return 0;
  let score = 0;
  if (activeContext.ideaHash && block.researchIdeaHash) {
    score += block.researchIdeaHash === activeContext.ideaHash
      ? CONTEXT_POLICY.ranking.sameIdea
      : CONTEXT_POLICY.ranking.differentIdea;
  }
  if (activeContext.stageHash && block.researchStageHash) {
    score += block.researchStageHash === activeContext.stageHash
      ? CONTEXT_POLICY.ranking.sameStage
      : CONTEXT_POLICY.ranking.differentStage;
  }
  return score;
}

function scoreBlocks(blocks, query, activeContext = null) {
  const queryTerms = terms(query);
  const normalizedQuery = String(query || "").toLowerCase();
  const mode = recallMode(query);
  const docs = blocks.map((block) => terms(block.raw));
  const df = new Map();
  for (const doc of docs) for (const term of doc) df.set(term, (df.get(term) || 0) + 1);
  return blocks.map((block, index) => {
    let lexical = 0;
    let overlap = 0;
    const matchedTerms = [];
    for (const term of queryTerms) {
      if (!docs[index].has(term)) continue;
      overlap += 1;
      matchedTerms.push(term);
      lexical += Math.log(1 + blocks.length / (df.get(term) || 1));
    }
    const normalizedRaw = block.raw.trim().toLowerCase();
    const exactRef = block.refs.some((ref) => normalizedQuery.includes(ref))
      || (normalizedRaw.length >= 3 && normalizedQuery.includes(normalizedRaw));
    const authorityWeight = CONTEXT_POLICY.ranking.authorityBySource[block.authority]
      ?? CONTEXT_POLICY.ranking.authorityBySource.unknown;
    return {
      block,
      lexical,
      overlap,
      matchedTerms,
      exactRef,
      authorityWeight,
      contextCompatibility: contextCompatibility(block, activeContext, mode),
    };
  });
}

export function buildDependencyGraph(blocks) {
  const byId = new Map(blocks.map((block) => [block.blockId, block]));
  const edges = new Map(blocks.map((block) => [block.blockId, new Set()]));
  const authorityEdges = new Map(blocks.map((block) => [block.blockId, new Set()]));
  const calls = new Map();
  const forcedEvents = new Map();
  const dialogueBlocks = new Map();
  for (const block of blocks) {
    const islandId = block.assemblyIslandId || block.dialogueBlockId;
    if (islandId && block.factCandidate) {
      if (!dialogueBlocks.has(islandId)) dialogueBlocks.set(islandId, []);
      dialogueBlocks.get(islandId).push(block.blockId);
    }
    if (block.callId) {
      if (!calls.has(block.callId)) calls.set(block.callId, []);
      calls.get(block.callId).push(block.blockId);
    }
    if (block.requiresEventClosure) {
      if (!forcedEvents.has(block.logicalEventId)) forcedEvents.set(block.logicalEventId, []);
      forcedEvents.get(block.logicalEventId).push(block.blockId);
    }
    for (const target of [...block.dependsOn, ...block.contradicts, ...block.validates, ...block.supersedes]) {
      if (!byId.has(target)) continue;
      edges.get(block.blockId).add(target);
      edges.get(target).add(block.blockId);
      authorityEdges.get(block.blockId).add(target);
      authorityEdges.get(target).add(block.blockId);
    }
  }
  for (const ids of calls.values()) {
    for (const left of ids) for (const right of ids) if (left !== right) {
      edges.get(left).add(right);
      authorityEdges.get(left).add(right);
    }
  }
  for (const [logicalEventId] of forcedEvents) {
    const ids = blocks.filter((block) => block.logicalEventId === logicalEventId).map((block) => block.blockId);
    for (const left of ids) for (const right of ids) if (left !== right) {
      edges.get(left).add(right);
      authorityEdges.get(left).add(right);
    }
  }
  // Fragmentation is an internal locator optimization. A loop produces at
  // most two rendered islands: dialogue and tool evidence. Non-factual
  // tool-call payloads remain provenance only and are never rendered.
  for (const ids of dialogueBlocks.values()) {
    for (const left of ids) for (const right of ids) if (left !== right) edges.get(left).add(right);
  }
  // authorityEdges deliberately omit the rest of the dialogue island. A user
  // revision is already an authoritative raw event; coupling it to a verbose
  // assistant reply can price the decisive constraint out of the budget.
  return { byId, edges, authorityEdges };
}

/** Generate deletion candidates without mutating the graph. KEEP reachability is
 * resolved afterward and always overrides these certificates. */
export function structuralDropCertificates(blocks) {
  const certificates = new Map();
  const certify = (block, ruleId, proof = {}) => certificates.set(block.blockId, Object.freeze({
    blockId: block.blockId,
    rawHash: block.rawHash,
    ruleId,
    ruleVersion: 1,
    scope: "loop",
    disposition: "EXCLUDED",
    storageDisposition: "RAW_LEDGER_RETAINED",
    proof,
    recoverableRef: block.recoverableRef,
  }));
  const byId = new Map(blocks.map((block) => [block.blockId, block]));
  const sourceSeen = new Map();
  for (const block of blocks) {
    if (block.excludeFromContext) certify(block, "EXCLUDED_BY_SOURCE", { explicit: true });
    else if (block.kind === "assistant_thinking") certify(block, "NON_FACT_REASONING", { kind: block.kind });
    else if (block.kind === "ui_noise") certify(block, "UI_NOISE", { kind: block.kind });
    else if (block.kind === "custom_derived" || block.kind === "compaction_derived") certify(block, "DERIVED_NOT_FACT", { kind: block.kind });
    else if (block.streamFinalId && byId.has(block.streamFinalId)) certify(block, "FINAL_COVERS_STREAM", { finalId: block.streamFinalId });
    if (block.sourceIdentity) {
      const key = `${block.sourceIdentity}\0${block.rawHash}`;
      if (sourceSeen.has(key)) certify(block, "DUPLICATE_INGEST", { retainedId: sourceSeen.get(key) });
      else sourceSeen.set(key, block.blockId);
    }
  }
  for (const newer of blocks) {
    for (const olderId of newer.supersedes) {
      const older = byId.get(olderId);
      if (older && newer.stateKey && older.stateKey === newer.stateKey) {
        certify(older, "EXPLICIT_SUPERSESSION", { supersededBy: newer.blockId, stateKey: newer.stateKey, version: newer.stateVersion });
      }
    }
    if (newer.resolvedBy && byId.has(newer.resolvedBy)) certify(newer, "RESOLVED_ATTEMPT", { resolvedBy: newer.resolvedBy, operationId: newer.operationId });
  }
  return certificates;
}

function closure(seedIds, graph, edgeSet = "edges") {
  const visited = new Set();
  const queue = [...seedIds];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id) || !graph.byId.has(id)) continue;
    visited.add(id);
    for (const next of graph[edgeSet].get(id) || []) if (!visited.has(next)) queue.push(next);
  }
  return visited;
}

function closureFromRootReasons(rootReasons, graph) {
  const visited = new Set();
  for (const [id, reasons] of rootReasons) {
    const authorityProjection = reasons.length > 0 && reasons.every((reason) => AUTHORITY_ROOT_REASONS.has(reason));
    for (const member of closure([id], graph, authorityProjection ? "authorityEdges" : "edges")) visited.add(member);
  }
  return visited;
}

function deriveHeat(blocks) {
  const heat = new Map();
  const futureReferenceCount = new Map();
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const explicitReferences = blocks[index].refs.reduce(
      (maximum, ref) => Math.max(maximum, futureReferenceCount.get(ref) || 0),
      0,
    );
    const age = blocks.length - 1 - index;
    heat.set(blocks[index].blockId, Math.log1p(explicitReferences) + Math.exp(-age / 8));
    for (const ref of blocks[index].refs) {
      futureReferenceCount.set(ref, (futureReferenceCount.get(ref) || 0) + 1);
    }
  }
  return heat;
}

function evidenceFragment(block) {
  const timestamp = block.provenance.messageTimestamp ?? block.provenance.entryTimestamp ?? null;
  const time = timestamp == null ? "" : ` t=${JSON.stringify(timestamp)}`;
  const context = [];
  if (block.provenance.sessionId && block.provenance.sessionId !== "synthetic-session") {
    context.push(`sid=${JSON.stringify(String(block.provenance.sessionId).slice(0, 12))}`);
  }
  if (block.provenance.entryId && !String(block.provenance.entryId).startsWith("synthetic-entry-")) {
    context.push(`eid=${JSON.stringify(String(block.provenance.entryId).slice(0, 16))}`);
  }
  if (block.researchIdeaHash) context.push(`idea=${JSON.stringify(String(block.researchIdeaHash).slice(-12))}`);
  if (block.researchStageHash) context.push(`stage=${JSON.stringify(String(block.researchStageHash).slice(-12))}`);
  const contextText = context.length ? ` ${context.join(" ")}` : "";
  return `[e:${block.blockId.slice(0, 16)} k=${block.kind} src=${JSON.stringify(block.source)}${time}${contextText}]\n${block.raw}`;
}

function renderEvidence(blocks) {
  if (!blocks.length) return "";
  return `<history_evidence authority="verbatim-raw">\n${blocks.map(evidenceFragment).join("\n\n")}\n</history_evidence>`;
}

const SOURCE_POLICY = `<source_policy>
USER: preferences, constraints, decisions, and what the user said; not proof of factual truth. TOOL: provenance-bearing but may err. PRIOR ASSISTANT: non-authoritative. Use only relevant evidence; do not invent missing history.
</source_policy>`;

function ladderQueryProfile(query, blocks = []) {
  const text = String(query || "");
  const history = blocks.map((block) => block.raw).join("\n");
  const memorySeeking = /(?:之前|前面|上次|以前|还记得|历史|原文|earlier|previous|remember|last time|history)/i.test(text);
  const continuation = /^(?:请|麻烦)?\s*(?:继续|接着|往下做|继续做|continue|keep going|go on)(?:吧|。|！|!|\.)?\s*$/i.test(text);
  const personalization = /(?:偏好|喜好|口味|适合(?:我|用户|他|她|我们)|给我推荐|为(?:我|用户|我们)推荐|根据(?:我|用户|我们).{0,16}(?:经历|体验|偏好)|选择哪|哪个最|for me|for the user|\bpreferences?\b|\btastes?\b|\bpast experience\b|\bprefer(?:s|red|ring)?\b|best (?:fits?|suits?|aligns?)|\bmy\b.{0,48}(?:favorite|preference|recommend|suggest)|\bour\b.{0,24}(?:taste|preference)|(?:recommend|suggest).{0,32}\b(?:me|my|our)\b|(?:fits?|suits?|aligns?).{0,20}\b(?:my|our)\s+(?:taste|preferences?))/i.test(text);
  const authority = /(?:我(?:要|想|希望|需要|决定|改成|不再|不要)|用户(?:要求|确认)|constraint|requirement|decision|i (?:want|need|prefer|decided)|must|do not)/i.test(text);
  const factualRisk = /(?:事实|真假|是否属实|证据|危险|阴谋|为什么|\bfacts?\b|\bevidence\b|\bdangerous\b|\bmyth\b|\bconspiracy\b|\b(?:conclusively\s+)?(?:proven|proved)\b|why is|is (?:it|this|that) true|(?:is|are|was|were) .{0,24}\b(?:true|false)\b|according to)/i.test(text);
  const highStakes = /(?:医疗|健康|法律|财务|安全|medicine|medical|health|legal|financial|safety)/i.test(text);
  const contextDiscard = /(?:(?:周围|其余|前文|上下文).{0,12}(?:不重要|无关)|只回答|问题本身|surrounding (?:material|context).{0,20}(?:not important|no longer important|irrelevant)|question itself|answer this part|missing part is simply|here is what we were wondering|rest of the conversation)/i.test(text);
  const situational = /(?:情况|场景|我们讨论的|situation we discussed|current situation|for this situation)/i.test(text);
  const decisionCue = /(?:最终建议|最后建议|选择|选哪个|recommendation|recommend|choose|select|decision)/i.test(text);
  const historyEvidenceCue = /(?:检索|搜索|来源|证据|结果|比较|测试|search|source|evidence|result|tested|compared|according|data)/i.test(history);
  const evidenceDecision = decisionCue && historyEvidenceCue;
  const factualStandalone = (factualRisk || contextDiscard) && !memorySeeking && !situational && !evidenceDecision;
  const broadAuthoritySpine = memorySeeking || personalization;
  return Object.freeze({
    memorySeeking, continuation, personalization, authority, factualRisk, highStakes,
    contextDiscard, situational, evidenceDecision, factualStandalone, broadAuthoritySpine,
  });
}

function taskPolicy(profile) {
  if (profile.factualStandalone) return "For this standalone factual question, history is not evidence. Answer the literal real-world truth directly and minimally; do not add folklore or unsupported detail unless asked.";
  if (profile.evidenceDecision) return "When a preference conflicts with evidence about current requirements, consequential evidence governs; treat preference as a tradeoff, not the answer.";
  if (profile.situational) return "A personal preference governs the user only. Other people and current shared constraints bound its scope; apply the preference only where compatible.";
  if (profile.personalization) return "Give one direct, concrete recommendation. Treat every explicit reason behind a positive or negative user preference as a constraint: preserve the named causes and convert disliked causes into corresponding positive requirements. A later explicit revision supersedes older conflict. Do not ask for options when a fitting category can be recommended.";
  return "Use current, valid evidence and preserve the scope of each statement. Within one active topic, a later explicit user revision supersedes an older conflicting preference; do not compromise between them merely to preserve both.";
}

function renderLadderEvidence(blocks, profile) {
  const rendered = blocks.map((block) => evidenceFragment(block)).join("\n\n");
  return `${SOURCE_POLICY}\n<task_rule>${taskPolicy(profile)}</task_rule>\n\n<assembled_history order="chronological" verbatim="true">${rendered ? `\n${rendered}\n` : ""}</assembled_history>`;
}

function ladderRenderedTokens(blocks, profile) {
  return estimateTokens(renderLadderEvidence(blocks, profile));
}

function tokenUnits(text) {
  const value = String(text || "");
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk * 1.15 + (value.length - cjk) / 3.2;
}

const RENDER_PREFIX_UNITS = tokenUnits('<history_evidence authority="verbatim-raw">\n');
const RENDER_SEPARATOR_UNITS = tokenUnits("\n\n");
const RENDER_SUFFIX_UNITS = tokenUnits("\n</history_evidence>");

function renderedTokenUnits(blocks) {
  if (!blocks.length) return 0;
  return RENDER_PREFIX_UNITS
    + RENDER_SUFFIX_UNITS
    + RENDER_SEPARATOR_UNITS * (blocks.length - 1)
    + blocks.reduce((sum, block) => sum + tokenUnits(evidenceFragment(block)), 0);
}

function renderedTokens(blocks) {
  return Math.ceil(renderedTokenUnits(blocks));
}

function ledgerOrder(block) {
  const value = block?.provenance?.ledgerOrder;
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER / 2 + (block?.provenance?.sourceOrder || 0);
}

function mergeBlocks(memoryBlocks, currentBlocks) {
  const byId = new Map();
  for (const block of [...(memoryBlocks || []), ...(currentBlocks || [])]) {
    if (!block?.blockId || !block?.rawHash || typeof block.raw !== "string") continue;
    if (!byId.has(block.blockId)) byId.set(block.blockId, block);
  }
  return [...byId.values()].sort((left, right) => ledgerOrder(left) - ledgerOrder(right));
}

/** Deterministic benchmark-local compiler. It never calls a model and never
 * treats derived labels as facts. */
export function compileBidirectionalContext({
  messages = [],
  memoryBlocks = [],
  query = "",
  condition = "bidirectional",
  budget = 12000,
  liveBlocks = 1,
  maxPositiveKeeps = CONTEXT_POLICY.retrieval.maxPositiveRoots,
  maxOptionalKeeps = CONTEXT_POLICY.retrieval.maxOptionalRoots,
  activeContext = null,
  explicitRootIds = [],
  candidateReranker = null,
} = {}) {
  if (!BIDIRECTIONAL_CONDITIONS.includes(condition)) throw new Error(`Unknown condition ${JSON.stringify(condition)}`);
  const started = performance.now();
  const blocks = mergeBlocks(memoryBlocks, blockizeMessages(messages));
  const graph = buildDependencyGraph(blocks);
  const useGc = condition !== "positive-only" && condition !== "raw";
  const usePositive = condition !== "gc-only" && condition !== "raw";
  const useHeat = condition === "bidirectional-heat";
  const certificates = useGc ? structuralDropCertificates(blocks) : new Map();
  const scores = scoreBlocks(blocks.filter((block) => block.factCandidate), query, activeContext);
  const lexicalCeiling = scores.length ? Math.max(...scores.map((row) => row.lexical)) : 0;
  const positiveRank = (row) => CONTEXT_POLICY.ranking.lexical * row.lexical / Math.max(1e-9, lexicalCeiling)
    + CONTEXT_POLICY.ranking.authority * row.authorityWeight
    + row.contextCompatibility;
  const ranked = scores.sort((a, b) => b.exactRef - a.exactRef
    || positiveRank(b) - positiveRank(a)
    || b.lexical - a.lexical
    || ledgerOrder(b.block) - ledgerOrder(a.block));
  const rootReasons = new Map();
  const addRoot = (id, reason) => {
    if (!rootReasons.has(id)) rootReasons.set(id, []);
    rootReasons.get(id).push(reason);
  };
  const factBlocks = blocks.filter((block) => block.factCandidate);
  const liveCount = Math.max(0, Math.min(factBlocks.length, Number(liveBlocks) || 0));
  const live = liveCount ? factBlocks.slice(factBlocks.length - liveCount) : [];
  for (const block of live) addRoot(block.blockId, "live-tail");
  for (const block of blocks) if (block.fresh || block.unresolved) addRoot(block.blockId, block.fresh ? "fresh-event" : "unresolved");
  for (const blockId of explicitRootIds || []) if (blocks.some((block) => block.blockId === blockId)) addRoot(blockId, "continuation-frame");
  const latestCall = [...blocks].reverse().find((block) => block.callId)?.callId;
  if (latestCall) for (const block of blocks.filter((item) => item.callId === latestCall)) addRoot(block.blockId, "provider-tail");
  if (condition === "raw") {
    for (const block of factBlocks) addRoot(block.blockId, "full-raw-control");
  } else if (condition === "gc-only") {
    for (const block of factBlocks) {
      if (!certificates.has(block.blockId)) addRoot(block.blockId, "structural-gc-retain");
    }
  }
  if (usePositive && ranked.length) {
    const maxLexical = ranked[0].lexical;
    let added = 0;
    for (const row of ranked) {
      const highConfidence = row.exactRef || (row.overlap >= CONTEXT_POLICY.retrieval.multiTermMinimum
        && row.lexical >= Math.max(
          CONTEXT_POLICY.retrieval.absoluteLexicalFloor,
          maxLexical * CONTEXT_POLICY.retrieval.relativeLexicalFloor,
        ));
      if (!highConfidence || added >= maxPositiveKeeps) continue;
      addRoot(row.block.blockId, row.exactRef ? "exact-reference" : "multi-term-local-match");
      added += 1;
    }
  }
  const relationMinimum = Math.max(1, Number(CONTEXT_POLICY.retrieval.authorityRelationMinimum) || 1);
  const queryRelationTerms = relationTerms(query);
  const liveIslandIds = new Set(live.map((block) => block.assemblyIslandId || block.dialogueBlockId).filter(Boolean));
  const liveUserBlocks = factBlocks.filter((block) => block.authority === "user"
    && liveIslandIds.has(block.assemblyIslandId || block.dialogueBlockId));
  const preliminaryRoots = [...rootReasons.keys()].map((id) => graph.byId.get(id)).filter(Boolean);
  const relationPeers = [...new Map([...liveUserBlocks, ...preliminaryRoots].map((block) => [block.blockId, block])).values()];
  const peerTerms = relationPeers.map((block) => relationTerms(block.raw));
  const authorityCandidates = factBlocks.filter((block) => block.authority === "user" && block.authoritySignals?.any)
    .map((block) => {
      const ownTerms = relationTerms(block.raw);
      const queryOverlap = termIntersectionSize(ownTerms, queryRelationTerms);
      const peerOverlap = peerTerms.reduce((maximum, candidate) => Math.max(maximum, termIntersectionSize(ownTerms, candidate)), 0);
      return { block, queryOverlap, peerOverlap, order: ledgerOrder(block) };
    });
  const authorityRelations = [];
  const addAuthorityRoot = (row, reason) => {
    if (rootReasons.has(row.block.blockId)) {
      // Replace an ordinary full-island root with an authority projection when
      // no hard provider/live dependency requires the full dialogue outcome.
      const existing = rootReasons.get(row.block.blockId);
      if (existing.every((value) => ["exact-reference", "multi-term-local-match", "marginal-query-coverage"].includes(value))) {
        rootReasons.set(row.block.blockId, [reason]);
      } else if (!existing.includes(reason)) existing.push(reason);
    } else addRoot(row.block.blockId, reason);
    authorityRelations.push({
      blockId: row.block.blockId,
      reason,
      signals: row.block.authoritySignals,
      queryOverlap: row.queryOverlap,
      peerOverlap: row.peerOverlap,
    });
  };
  const updateRows = authorityCandidates.filter((row) => row.block.authoritySignals.update
    && (row.queryOverlap >= relationMinimum || row.peerOverlap >= relationMinimum))
    .sort((left, right) => right.queryOverlap - left.queryOverlap
      || right.peerOverlap - left.peerOverlap
      || right.order - left.order)
    .slice(0, Math.max(0, Number(CONTEXT_POLICY.retrieval.maxAuthorityUpdateRoots) || 0));
  for (const row of updateRows) addAuthorityRoot(row, "authority-update");

  // A strong later user revision does not erase raw history. It changes the
  // prompt disposition of older same-topic preference islands from candidates
  // to locator-only. This prevents obsolete but lexically attractive material
  // from competing with the revision that governs the current decision.
  const shadowedIds = new Set();
  const shadowedBy = new Map();
  for (const update of updateRows) {
    const updateTerms = relationTerms(update.block.raw);
    const olderUsers = factBlocks.filter((block) => block.authority === "user"
      && ledgerOrder(block) < update.order
      && termIntersectionSize(relationTerms(block.raw), updateTerms) >= relationMinimum);
    const olderIslands = new Set(olderUsers.map((block) => block.assemblyIslandId || block.dialogueBlockId).filter(Boolean));
    for (const block of factBlocks) {
      if (!olderIslands.has(block.assemblyIslandId || block.dialogueBlockId)) continue;
      shadowedIds.add(block.blockId);
      if (!shadowedBy.has(block.blockId)) shadowedBy.set(block.blockId, update.block.blockId);
    }
  }
  for (const [blockId, reasons] of [...rootReasons]) {
    if (!shadowedIds.has(blockId)) continue;
    if (reasons.every((reason) => ["exact-reference", "multi-term-local-match", "marginal-query-coverage"].includes(reason))) {
      rootReasons.delete(blockId);
    }
  }

  const bridgeRows = authorityCandidates.filter((row) => !row.block.authoritySignals.update
    && row.block.authoritySignals.preference
    && row.peerOverlap >= relationMinimum)
    .sort((left, right) => right.peerOverlap - left.peerOverlap
      || right.queryOverlap - left.queryOverlap
      || right.order - left.order)
    .slice(0, Math.max(0, Number(CONTEXT_POLICY.retrieval.maxAuthorityBridgeRoots) || 0));
  for (const row of bridgeRows) addAuthorityRoot(row, "authority-scope-bridge");

  const keep = closureFromRootReasons(rootReasons, graph);
  const state = new Map(blocks.map((block) => [block.blockId, keep.has(block.blockId) ? "KEEP" : certificates.has(block.blockId) ? "DROP" : "UNKNOWN"]));
  const heat = deriveHeat(blocks);
  const scoreById = new Map(ranked.map((row) => [row.block.blockId, row]));
  const mandatory = blocks.filter((block) => state.get(block.blockId) === "KEEP" && block.factCandidate);
  const mandatoryUnits = renderedTokenUnits(mandatory);
  const mandatoryTokens = Math.ceil(mandatoryUnits);
  if (mandatoryTokens > budget) {
    return {
      overflow: true,
      context: "",
      selectedBlocks: [],
      blocks,
      manifest: {
        schema: 1,
        condition,
        reason: "mandatory-closure-over-budget",
        budget,
        mandatoryTokens,
        roots: [...rootReasons].map(([blockId, reasons]) => ({ blockId, reasons })),
      },
      assemblyMs: performance.now() - started,
    };
  }
  const selected = [...mandatory];
  const selectedIds = new Set(selected.map((block) => block.blockId));
  let usedUnits = mandatoryUnits;
  const heatValues = [...heat.values()];
  const maxHeat = heatValues.length ? Math.max(...heatValues) : 1;
  const maxLexical = ranked.length ? Math.max(...ranked.map((row) => row.lexical)) : 1;
  const factOrder = new Map(factBlocks.map((block, index) => [block.blockId, index]));
  const rerankerScores = new Map();
  const rerankerAudit = {
    mode: candidateReranker?.score ? "numeric-feature-reranker" : "none",
    modelId: candidateReranker?.modelId || null,
    candidatesScored: 0,
    failures: 0,
  };
  if (candidateReranker?.score) {
    for (const row of ranked) {
      const block = row.block;
      if (shadowedIds.has(block.blockId)) continue;
      const order = factOrder.get(block.blockId) || 0;
      const features = Object.freeze({
        exactReference: row.exactRef ? 1 : 0,
        lexicalNormalized: row.lexical / Math.max(1e-9, maxLexical),
        overlap: row.overlap,
        authorityWeight: row.authorityWeight,
        contextCompatibility: row.contextCompatibility,
        heatNormalized: (heat.get(block.blockId) || 0) / Math.max(1e-9, maxHeat),
        recency: factBlocks.length <= 1 ? 1 : order / (factBlocks.length - 1),
        tokenCost: block.tokens,
        userAuthority: block.authority === "user" ? 1 : 0,
        toolAuthority: block.authority === "tool" ? 1 : 0,
        authorityUpdate: block.authoritySignals?.update ? 1 : 0,
        authorityPreference: block.authoritySignals?.preference ? 1 : 0,
        authorityScope: block.authoritySignals?.scope ? 1 : 0,
      });
      try {
        const score = Number(candidateReranker.score(features));
        rerankerScores.set(block.blockId, Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0);
        rerankerAudit.candidatesScored += 1;
      } catch {
        rerankerScores.set(block.blockId, 0);
        rerankerAudit.failures += 1;
      }
    }
  }
  const optional = blocks.filter((block) => block.factCandidate
    && state.get(block.blockId) === "UNKNOWN"
    && !shadowedIds.has(block.blockId)).sort((left, right) => {
    const a = scoreById.get(left.blockId) || { exactRef: false, lexical: 0, overlap: 0, matchedTerms: [], authorityWeight: 0, contextCompatibility: 0 };
    const b = scoreById.get(right.blockId) || { exactRef: false, lexical: 0, overlap: 0, matchedTerms: [], authorityWeight: 0, contextCompatibility: 0 };
    const aRank = CONTEXT_POLICY.ranking.lexical * a.lexical / Math.max(1e-9, maxLexical)
      + CONTEXT_POLICY.ranking.authority * a.authorityWeight + a.contextCompatibility
      + (useHeat ? CONTEXT_POLICY.ranking.optionalHeat * heat.get(left.blockId) / Math.max(1e-9, maxHeat) : 0)
      + CONTEXT_POLICY.ranking.optionalReranker * (rerankerScores.get(left.blockId) || 0);
    const bRank = CONTEXT_POLICY.ranking.lexical * b.lexical / Math.max(1e-9, maxLexical)
      + CONTEXT_POLICY.ranking.authority * b.authorityWeight + b.contextCompatibility
      + (useHeat ? CONTEXT_POLICY.ranking.optionalHeat * heat.get(right.blockId) / Math.max(1e-9, maxHeat) : 0)
      + CONTEXT_POLICY.ranking.optionalReranker * (rerankerScores.get(right.blockId) || 0);
    return b.exactRef - a.exactRef || bRank - aRank || b.lexical - a.lexical || ledgerOrder(right) - ledgerOrder(left);
  });
  const coveredTerms = new Set();
  for (const block of selected) {
    for (const term of scoreById.get(block.blockId)?.matchedTerms || []) coveredTerms.add(term);
  }
  const deferredReasons = new Map();
  let optionalRoots = 0;
  for (const block of optional) {
    if (selectedIds.has(block.blockId)) continue;
    const row = scoreById.get(block.blockId);
    const newTerms = (row?.matchedTerms || []).filter((term) => !coveredTerms.has(term));
    const eligible = usePositive
      && optionalRoots < Math.max(0, Number(maxOptionalKeeps) || 0)
      && Boolean(row)
      && (row.exactRef || (row.lexical > 0 && newTerms.length > 0));
    if (!eligible) {
      deferredReasons.set(block.blockId, "no-marginal-coverage");
      continue;
    }
    const dependencyIds = closure([block.blockId], graph);
    const additions = blocks.filter((candidate) => dependencyIds.has(candidate.blockId)
      && candidate.factCandidate
      && !selectedIds.has(candidate.blockId));
    const trial = [...selected, ...additions].sort((a, b) => ledgerOrder(a) - ledgerOrder(b));
    const nextUnits = renderedTokenUnits(trial);
    if (Math.ceil(nextUnits) > budget) {
      deferredReasons.set(block.blockId, "budget");
      continue;
    }
    addRoot(block.blockId, row.exactRef ? "exact-reference" : "marginal-query-coverage");
    optionalRoots += 1;
    for (const id of dependencyIds) {
      keep.add(id);
      state.set(id, "KEEP");
    }
    for (const addition of additions) {
      selected.push(addition);
      selectedIds.add(addition.blockId);
      for (const term of scoreById.get(addition.blockId)?.matchedTerms || []) coveredTerms.add(term);
    }
    usedUnits = nextUnits;
  }
  selected.sort((a, b) => ledgerOrder(a) - ledgerOrder(b));
  const context = renderEvidence(selected);
  const contextTokens = estimateTokens(context);
  if (contextTokens !== renderedTokens(selected) || contextTokens > budget) {
    throw new Error(`Rendered context budget invariant failed: ${contextTokens}/${budget}`);
  }
  const retained = selected.map((block) => ({
    blockId: block.blockId,
    state: state.get(block.blockId),
    disposition: "MATERIALIZED",
    storageDisposition: "RAW_LEDGER_RETAINED",
    reasons: rootReasons.get(block.blockId) || (keep.has(block.blockId) ? ["dependency-closure"] : ["budget-fit"]),
    heat: heat.get(block.blockId),
    localSignals: scoreById.has(block.blockId) ? {
      exactRef: scoreById.get(block.blockId).exactRef,
      lexical: scoreById.get(block.blockId).lexical,
      overlap: scoreById.get(block.blockId).overlap,
      matchedTerms: scoreById.get(block.blockId).matchedTerms,
      authorityWeight: scoreById.get(block.blockId).authorityWeight,
      contextCompatibility: scoreById.get(block.blockId).contextCompatibility,
    } : null,
  }));
  const dropped = blocks.filter((block) => state.get(block.blockId) === "DROP").map((block) => certificates.get(block.blockId));
  const deferred = blocks.filter((block) => state.get(block.blockId) === "UNKNOWN" && block.factCandidate && !selectedIds.has(block.blockId)).map((block) => ({
    blockId: block.blockId,
    state: "UNKNOWN",
    disposition: "LOCATOR_ONLY",
    storageDisposition: "RAW_LEDGER_RETAINED",
    reason: shadowedIds.has(block.blockId) ? "superseded-by-authority-update" : deferredReasons.get(block.blockId) || "no-marginal-coverage",
    shadowedBy: shadowedBy.get(block.blockId) || null,
    rank: scoreById.get(block.blockId)?.lexical || 0,
    heat: heat.get(block.blockId),
    authorityWeight: scoreById.get(block.blockId)?.authorityWeight || 0,
  }));
  const queryTerms = [...terms(query)];
  const coveredQueryTerms = queryTerms.filter((term) => coveredTerms.has(term));
  const missingQueryTerms = queryTerms.filter((term) => !coveredTerms.has(term));
  const memorySeeking = /(?:之前|前面|上次|以前|还记得|那个|继续|历史|旧值|原文|evidence|earlier|previous|remember|last time)/i.test(String(query || ""));
  const retrievalRoots = [...rootReasons].filter(([, reasons]) => reasons.some((reason) => [
    "exact-reference",
    "multi-term-local-match",
    "marginal-query-coverage",
  ].includes(reason)));
  const gaps = condition === "raw" || condition === "gc-only" ? []
    : memorySeeking && retrievalRoots.length === 0
      ? [{ slot: "historical-evidence", reason: "memory-request-without-confident-root", requestedEscalation: "obelisk-bounded-lookup-or-raw-session" }]
      : [];
  const manifest = {
    schema: 1,
    compilerVersion: EVIDENCE_CONTEXT_COMPILER_VERSION,
    policyVersion: CONTEXT_POLICY.version,
    condition,
    selectionPolicy: condition === "raw" ? "full-raw-control"
      : condition === "gc-only" ? "structural-gc-control"
        : "coverage-stop",
    recallFrame: {
      mode: recallMode(query),
      ideaHash: activeContext?.ideaHash || null,
      stageHash: activeContext?.stageHash || null,
      contextualRanking: Boolean(activeContext && recallMode(query) === "current"),
    },
    inputEventDigest: sha256(blocks.map((block) => block.blockId).join("|")),
    queryHash: sha256(query),
    budget,
    roots: [...rootReasons].map(([blockId, reasons]) => ({ blockId, reasons })),
    authorityClosure: {
      policy: "hard-relations-before-soft-ranking",
      relations: authorityRelations,
      liveBridgeBlockIds: liveUserBlocks.map((block) => block.blockId),
      materializedAuthorityRoots: authorityRelations.filter((row) => selectedIds.has(row.blockId)).length,
      shadowedToLocatorOnly: [...shadowedIds].filter((blockId) => !selectedIds.has(blockId)).map((blockId) => ({
        blockId,
        shadowedBy: shadowedBy.get(blockId),
      })),
    },
    reranker: rerankerAudit,
    retained,
    dropped,
    deferred,
    dispositions: {
      materialized: selected.length,
      locatorOnly: deferred.length,
      excludedFromPrompt: dropped.length,
      physicallyDeleted: 0,
    },
    coverage: {
      queryTermCount: queryTerms.length,
      coveredQueryTerms,
      missingQueryTerms,
      optionalRoots,
      stopReason: optionalRoots >= Math.max(0, Number(maxOptionalKeeps) || 0)
        ? "optional-root-limit"
        : deferred.some((row) => row.reason === "budget") ? "budget"
          : "no-additional-marginal-coverage",
    },
    gaps,
    tokens: {
      mandatoryRendered: mandatoryTokens,
      rawSelected: selected.reduce((sum, block) => sum + block.tokens, 0),
      rendered: contextTokens,
    },
    outputHash: sha256(context),
  };
  return {
    overflow: false,
    context,
    contextTokens,
    selectedBlocks: selected,
    blocks,
    manifest,
    assemblyMs: performance.now() - started,
  };
}

/**
 * Proof-carrying evidence ladder.
 *
 * The ladder is intentionally a separate compiler rather than a new v4 flag:
 * it changes the representation presented to the model, not just ranking. It
 * keeps exact raw events, labels their epistemic source, and stops expanding
 * only after the query's authority/evidence risks have a deterministic cover.
 * No model is called on the assembly path.
 */
export function compileEvidenceLadderContext({
  messages = [],
  memoryBlocks = [],
  query = "",
  budget = 12000,
  activeContext = null,
  explicitRootIds = [],
  userSpineLimit = 8,
  assistantLimit = 1,
  personalizationBridgeLimit = 3,
  toolLimit = 4,
  includeLocalTail = true,
} = {}) {
  const started = performance.now();
  const blocks = mergeBlocks(memoryBlocks, blockizeMessages(messages));
  const factBlocks = blocks.filter((block) => block.factCandidate);
  const certificates = structuralDropCertificates(blocks);
  const allEligible = factBlocks.filter((block) => !certificates.has(block.blockId));
  const matchesActiveContext = (block) => {
    if (!activeContext) return true;
    if (activeContext.ideaHash && block.researchIdeaHash !== activeContext.ideaHash) return false;
    if (activeContext.stageHash && block.researchStageHash !== activeContext.stageHash) return false;
    return true;
  };
  const activeDomain = activeContext ? allEligible.filter(matchesActiveContext) : [];
  // Active Idea/stage is a retrieval domain boundary, not a soft ranking
  // feature. If the domain exists, all source types are scoped together;
  // otherwise fall back to the global ledger for recoverability.
  const eligible = activeDomain.length ? activeDomain : allEligible;
  const crossDomainLocatorOnly = activeDomain.length
    ? allEligible.filter((block) => !matchesActiveContext(block))
    : [];
  const profile = ladderQueryProfile(query, eligible);
  const scored = scoreBlocks(eligible, query, activeContext);
  const scoreById = new Map(scored.map((row) => [row.block.blockId, row]));
  const queryTerms = relationTerms(query);
  const maximumLexical = Math.max(1e-9, ...scored.map((row) => row.lexical));
  const normalizedRank = (block) => {
    const row = scoreById.get(block.blockId);
    if (!row) return 0;
    return Number(row.exactRef) * 4
      + row.lexical / maximumLexical
      + row.authorityWeight * 0.25
      + row.contextCompatibility;
  };
  const ranked = [...eligible].sort((left, right) => normalizedRank(right) - normalizedRank(left)
    || ledgerOrder(right) - ledgerOrder(left));
  const userBlocks = eligible.filter((block) => block.authority === "user");
  const assistantBlocks = eligible.filter((block) => block.authority === "model");
  const toolBlocks = eligible.filter((block) => block.authority === "tool");
  const shadowedUserIds = new Set();
  // Personalized queries are intentionally excluded: an implicit preference
  // cannot be safely declared obsolete by lexical/regex evidence. Until a
  // user-confirmed state event exists, uncertainty means restoring user raw.
  if (recallMode(query) !== "historical" && !profile.personalization) {
    const queryRelevantUpdates = userBlocks.filter((block) => block.authoritySignals?.update)
      .map((block) => ({ block, row: scoreById.get(block.blockId) }))
      .filter(({ block }) => termIntersectionSize(relationTerms(block.raw), queryTerms) > 0)
      .sort((left, right) => (right.row?.lexical || 0) - (left.row?.lexical || 0)
        || ledgerOrder(right.block) - ledgerOrder(left.block))
      .slice(0, 1)
      .map(({ block }) => block);
    for (const update of queryRelevantUpdates) {
      const updateTerms = relationTerms(update.raw);
      for (const older of userBlocks) {
        if (ledgerOrder(older) >= ledgerOrder(update)) continue;
        if (termIntersectionSize(relationTerms(older.raw), updateTerms) >= 2) shadowedUserIds.add(older.blockId);
      }
    }
  }
  const activeUserBlocks = userBlocks.filter((block) => !shadowedUserIds.has(block.blockId));
  const contextScopedUsers = activeContext && activeUserBlocks.some(matchesActiveContext)
    ? activeUserBlocks.filter(matchesActiveContext)
    : activeUserBlocks;
  const reasonsById = new Map();
  const selectedIds = new Set();
  const eventMembers = new Map();
  for (const block of eligible) {
    if (!eventMembers.has(block.logicalEventId)) eventMembers.set(block.logicalEventId, []);
    eventMembers.get(block.logicalEventId).push(block);
  }
  const selectedBlocks = () => eligible.filter((block) => selectedIds.has(block.blockId))
    .sort((left, right) => ledgerOrder(left) - ledgerOrder(right));
  const addEvent = (block, reason, { required = false } = {}) => {
    if (!block) return false;
    const members = eventMembers.get(block.logicalEventId) || [block];
    const additions = members.filter((member) => !selectedIds.has(member.blockId));
    if (!additions.length) {
      for (const member of members) {
        if (!reasonsById.has(member.blockId)) reasonsById.set(member.blockId, []);
        reasonsById.get(member.blockId).push(reason);
      }
      return true;
    }
    const trial = [...selectedBlocks(), ...additions].sort((left, right) => ledgerOrder(left) - ledgerOrder(right));
    if (ladderRenderedTokens(trial, profile) > budget && !required) return false;
    for (const member of additions) {
      selectedIds.add(member.blockId);
      if (!reasonsById.has(member.blockId)) reasonsById.set(member.blockId, []);
      reasonsById.get(member.blockId).push(reason);
    }
    return true;
  };

  // Tier 0: explicit continuation state and the most recent dialogue turn.
  for (const blockId of explicitRootIds || []) {
    addEvent(eligible.find((block) => block.blockId === blockId), "explicit-continuation", { required: true });
  }
  for (const block of eligible.filter((item) => item.fresh || item.unresolved)) {
    addEvent(block, block.fresh ? "fresh-event" : "unresolved-event");
  }
  const latestUser = contextScopedUsers.at(-1);
  const latestAssistant = assistantBlocks.at(-1);
  if (includeLocalTail && !profile.factualStandalone) addEvent(latestUser, "live-user-tail");
  if (includeLocalTail && (profile.continuation || !latestUser)) addEvent(latestAssistant, "live-assistant-tail");

  // Once the run loop supplies an active Idea/stage, its user authority chain
  // is state, not ordinary retrieval material.  A terse next request need not
  // repeat the vocabulary of an earlier decision or preference.  Keep a
  // bounded verbatim fallback (updates first, then other authority statements,
  // newest first) unless the query is explicitly standalone factual.  The
  // trusted-state layer may later replace these provisional raw roots with
  // user-confirmed state keys, but the selector must never silently omit them.
  if (activeContext && !profile.factualStandalone) {
    const activeAuthorityLimit = profile.evidenceDecision || profile.situational
      ? Math.min(2, userSpineLimit)
      : profile.personalization
        ? userSpineLimit
        : Math.min(4, userSpineLimit);
    const scopedAuthority = contextScopedUsers.filter((block) => block.authoritySignals?.any)
      .sort((left, right) => Number(right.authoritySignals.update) - Number(left.authoritySignals.update)
        || ledgerOrder(right) - ledgerOrder(left))
      .slice(0, activeAuthorityLimit)
      .sort((left, right) => ledgerOrder(left) - ledgerOrder(right));
    for (const block of scopedAuthority) addEvent(block, "active-idea-authority-spine");
  }

  // Tier 1: query-bearing user events and explicit authority updates. This is
  // the governing spine; assistant prose never outranks it.
  const latestUserTerms = latestUser ? relationTerms(latestUser.raw) : new Set();
  const relevantUsers = [...contextScopedUsers].sort((left, right) => {
    const boundedMode = profile.situational || profile.evidenceDecision;
    if (boundedMode) {
      const relationDifference = termIntersectionSize(relationTerms(right.raw), latestUserTerms)
        - termIntersectionSize(relationTerms(left.raw), latestUserTerms);
      if (relationDifference) return relationDifference;
    }
    return normalizedRank(right) - normalizedRank(left) || ledgerOrder(right) - ledgerOrder(left);
  });
  let boundedAuthorityAdds = 0;
  if (profile.situational) {
    const explicitPreference = relevantUsers.find((block) => block.blockId !== latestUser?.blockId
      && /(?:\bi\s+(?:strongly\s+|usually\s+|generally\s+)?prefer\b|\bmy preference\b|我(?:通常|一般|更|最)?(?:偏好|喜欢))/i.test(block.raw)
      && termIntersectionSize(relationTerms(block.raw), latestUserTerms) >= 1);
    if (explicitPreference && addEvent(explicitPreference, "scope-bounded-personal-preference")) boundedAuthorityAdds += 1;
  }
  for (const block of relevantUsers) {
    if (profile.factualStandalone || block.blockId === latestUser?.blockId || selectedIds.has(block.blockId)) continue;
    const row = scoreById.get(block.blockId);
    const latestRelation = latestUser ? termIntersectionSize(relationTerms(block.raw), relationTerms(latestUser.raw)) : 0;
    const boundedMode = profile.situational || profile.evidenceDecision;
    const authorityRelated = block.authoritySignals?.any
      && (profile.personalization || latestRelation >= 1 || (row?.overlap || 0) >= 1);
    const queryMatched = row?.exactRef || row?.overlap >= (boundedMode ? 2 : 1);
    if (!authorityRelated && !queryMatched) continue;
    if (boundedMode && boundedAuthorityAdds >= 2) continue;
    if (addEvent(block, "governing-user-match") && boundedMode) boundedAuthorityAdds += 1;
  }

  // Tier 2: high-risk questions get a bounded exact user spine. In short
  // histories this is complete; in multi-week histories it is a reversible
  // projection selected by authority, relevance, and recency.
  if (profile.broadAuthoritySpine) {
    const spine = contextScopedUsers.length <= userSpineLimit
      ? [...contextScopedUsers]
      : [...contextScopedUsers].sort((left, right) => Number(right.authoritySignals?.any) - Number(left.authoritySignals?.any)
        || normalizedRank(right) - normalizedRank(left)
        || ledgerOrder(right) - ledgerOrder(left)).slice(0, userSpineLimit);
    for (const block of spine.sort((left, right) => ledgerOrder(left) - ledgerOrder(right))) addEvent(block, "bounded-user-spine");
  }

  // A personalized preference is often expressed as a negative experience,
  // while the immediately following assistant turn carries the usable
  // transformation (problem -> concrete alternative).  Keeping only the user
  // side preserves authority but can destroy that inference.  Restore a
  // bounded number of complete user/reply dialogue islands, prioritizing
  // explicit user constraints, lexical relation, then recency.  This is an
  // exact event projection: no generated summary enters the evidence path.
  if (profile.personalization && personalizationBridgeLimit > 0) {
    const selectedUsers = selectedBlocks().filter((block) => block.authority === "user");
    const nextAssistantFor = (userBlock) => assistantBlocks
      .filter((candidate) => ledgerOrder(candidate) > ledgerOrder(userBlock)
        && !userBlocks.some((other) => ledgerOrder(other) > ledgerOrder(userBlock)
          && ledgerOrder(other) < ledgerOrder(candidate)))
      .sort((left, right) => ledgerOrder(left) - ledgerOrder(right))[0];
    const bridgeCandidates = selectedUsers.map((userBlock) => ({
      userBlock,
      assistantBlock: nextAssistantFor(userBlock),
      relation: nextAssistantFor(userBlock)
        ? termIntersectionSize(relationTerms(userBlock.raw), relationTerms(nextAssistantFor(userBlock).raw))
        : 0,
    })).filter((row) => row.assistantBlock)
      .sort((left, right) => Number(right.userBlock.authoritySignals?.update) - Number(left.userBlock.authoritySignals?.update)
        || Number(right.userBlock.authoritySignals?.any) - Number(left.userBlock.authoritySignals?.any)
        || right.relation - left.relation
        || ledgerOrder(right.userBlock) - ledgerOrder(left.userBlock));
    let bridgeAdds = 0;
    for (const { assistantBlock } of bridgeCandidates) {
      if (bridgeAdds >= personalizationBridgeLimit) break;
      if (addEvent(assistantBlock, "personalization-dialogue-island")) bridgeAdds += 1;
    }
  }

  // Tier 3: recover a small amount of supporting assistant/tool context. The
  // ranking also measures relation to already selected user events, which
  // catches semantically local replies even when the current query is terse.
  const selectedUserTerms = selectedBlocks().filter((block) => block.authority === "user").map((block) => relationTerms(block.raw));
  const supportRank = (block) => normalizedRank(block)
    + selectedUserTerms.reduce((maximum, candidate) => Math.max(maximum, termIntersectionSize(relationTerms(block.raw), candidate)), 0) * 0.08
    + (block.loopId === latestUser?.loopId ? 0.2 : 0);
  const rankedTools = [...toolBlocks].sort((left, right) => supportRank(right) - supportRank(left)
    || ledgerOrder(right) - ledgerOrder(left));
  const rankedAssistants = [...assistantBlocks].sort((left, right) => supportRank(right) - supportRank(left)
    || ledgerOrder(right) - ledgerOrder(left));
  let toolAdds = 0;
  for (const block of rankedTools) {
    const row = scoreById.get(block.blockId);
    if (toolAdds >= toolLimit || (!row?.exactRef && row?.overlap === 0 && !block.fresh && !block.unresolved)) continue;
    if (addEvent(block, "supporting-tool-evidence")) toolAdds += 1;
  }
  let assistantAdds = selectedBlocks().filter((block) => block.authority === "model").length;
  const effectiveAssistantLimit = profile.evidenceDecision ? Math.max(3, assistantLimit)
    : profile.personalization ? personalizationBridgeLimit
      : assistantLimit;
  for (const block of rankedAssistants) {
    if (profile.factualStandalone || assistantAdds >= effectiveAssistantLimit) break;
    const relatedToSelected = selectedUserTerms.some((candidate) => termIntersectionSize(relationTerms(block.raw), candidate) >= 1);
    const row = scoreById.get(block.blockId);
    const queryRelationOverlap = termIntersectionSize(relationTerms(block.raw), queryTerms);
    const evidenceBearing = /(?:search|source|evidence|result|tested|compared|according|data|found|requirement|tradeoff|recommend|检索|搜索|来源|证据|结果|比较|测试|要求|权衡|建议)/i.test(block.raw);
    // Mere similarity to a user claim is not enough: that frequently pulls a
    // verbose assistant paraphrase back into the prompt. Assistant history is
    // materialized only when the current query points to it, or when a vague
    // continuation needs the immediately related working tail.
    if (!row?.exactRef && queryRelationOverlap === 0
      && !(profile.continuation && relatedToSelected)
      && !(profile.evidenceDecision && evidenceBearing)) continue;
    if (addEvent(block, "supporting-assistant-history")) assistantAdds += 1;
  }

  // Tier 4: if ordinary questions still have no lexical evidence, take the
  // highest-ranked exact event. Personalized/memory questions are already
  // covered by the user spine and do not fall back merely because wording is
  // semantically different.
  const selectedTermSet = new Set(selectedBlocks().flatMap((block) => [...relationTerms(block.raw)]));
  const coveredQueryTerms = [...queryTerms].filter((term) => selectedTermSet.has(term));
  const coverageRatio = queryTerms.size ? coveredQueryTerms.length / queryTerms.size : 1;
  if (!profile.broadAuthoritySpine && !profile.factualStandalone && coverageRatio === 0) addEvent(ranked[0], "zero-coverage-fallback");

  const selected = selectedBlocks();
  const context = renderLadderEvidence(selected, profile);
  const contextTokens = estimateTokens(context);
  if (contextTokens > budget) {
    return {
      overflow: true,
      context: "",
      selectedBlocks: [],
      blocks,
      manifest: {
        schema: 1,
        compilerVersion: EVIDENCE_LADDER_VERSION,
        reason: "evidence-ladder-over-budget",
        budget,
        attemptedTokens: contextTokens,
      },
      assemblyMs: performance.now() - started,
    };
  }
  const allUserEventIds = new Set(activeUserBlocks.map((block) => block.logicalEventId));
  const selectedUserEventIds = new Set(selected.filter((block) => block.authority === "user").map((block) => block.logicalEventId));
  const userSpineComplete = [...allUserEventIds].every((id) => selectedUserEventIds.has(id));
  const selectedTermSetFinal = new Set(selected.flatMap((block) => [...relationTerms(block.raw)]));
  const finalCoveredTerms = [...queryTerms].filter((term) => selectedTermSetFinal.has(term));
  const finalMissingTerms = [...queryTerms].filter((term) => !selectedTermSetFinal.has(term));
  const selectedByAuthority = Object.fromEntries(["user", "tool", "model"].map((authorityName) => [
    authorityName,
    selected.filter((block) => block.authority === authorityName).length,
  ]));
  const rawContext = renderEvidence(factBlocks);
  const rawEquivalentTokens = estimateTokens(rawContext);
  const gaps = [];
  if (profile.memorySeeking && selectedUserEventIds.size === 0) {
    gaps.push({ slot: "historical-user-evidence", reason: "memory-query-without-user-event", requestedEscalation: "raw-ledger-or-obelisk-bounded-lookup" });
  }
  if (profile.continuation && !(explicitRootIds || []).length && !eligible.some((block) => block.fresh || block.unresolved)) {
    gaps.push({ slot: "continuation-frame", reason: "vague-continuation-without-explicit-state", requestedEscalation: "latest-unresolved-loop-or-raw-tail" });
  }
  const manifest = {
    schema: 1,
    compilerVersion: EVIDENCE_LADDER_VERSION,
    policyVersion: CONTEXT_POLICY.version,
    condition: "evidence-ladder",
    selectionPolicy: "risk-adaptive-proof-carrying-evidence-ladder",
    queryHash: sha256(query),
    inputEventDigest: sha256(blocks.map((block) => block.blockId).join("|")),
    budget,
    profile,
    ladder: {
      reachedTier: profile.broadAuthoritySpine ? 3 : 4,
      userSpineComplete,
      userSpineLimit,
      assistantLimit: effectiveAssistantLimit,
      toolLimit,
      includeLocalTail,
      sourcePolicyRendered: true,
      shadowedSupersededUserBlocks: shadowedUserIds.size,
    },
    coverage: {
      queryTermCount: queryTerms.size,
      coveredQueryTerms: finalCoveredTerms,
      missingQueryTerms: finalMissingTerms,
      lexicalCoverageRatio: queryTerms.size ? finalCoveredTerms.length / queryTerms.size : 1,
      authorityCoverage: userBlocks.length ? selectedUserEventIds.size / allUserEventIds.size : 1,
      stopReason: "bounded-risk-cover-reached",
    },
    roots: selected.map((block) => ({ blockId: block.blockId, reasons: [...new Set(reasonsById.get(block.blockId) || [])] })),
    retained: selected.map((block) => ({
      blockId: block.blockId,
      disposition: "MATERIALIZED",
      storageDisposition: "RAW_LEDGER_RETAINED",
      authority: block.authority,
      reasons: [...new Set(reasonsById.get(block.blockId) || [])],
    })),
    deferred: eligible.filter((block) => !selectedIds.has(block.blockId)).map((block) => ({
      blockId: block.blockId,
      disposition: "LOCATOR_ONLY",
      storageDisposition: "RAW_LEDGER_RETAINED",
      authority: block.authority,
      reason: "coverage-stop",
      rank: normalizedRank(block),
    })),
    dropped: [...certificates.values()],
    dispositions: {
      materialized: selected.length,
      locatorOnly: eligible.length - selected.length,
      excludedFromPrompt: certificates.size,
      physicallyDeleted: 0,
      selectedByAuthority,
      crossDomainLocatorOnly: crossDomainLocatorOnly.length,
    },
    gaps,
    tokens: {
      rendered: contextTokens,
      rawEquivalent: rawEquivalentTokens,
      reductionFraction: rawEquivalentTokens ? 1 - contextTokens / rawEquivalentTokens : 0,
    },
    outputHash: sha256(context),
  };
  return {
    overflow: false,
    context,
    contextTokens,
    selectedBlocks: selected,
    blocks,
    manifest,
    assemblyMs: performance.now() - started,
  };
}
