import {
  EVIDENCE_LADDER_VERSION,
  blockizeMessages,
  compileEvidenceLadderContext,
} from "./evidence-context-compiler.js";
import { groupTurns } from "./context-compiler.js";
import { CONTEXT_POLICY } from "./context-policy.js";
import {
  STATE_TYPE,
  applyEvent,
  emptyState,
  estimateTokens,
  sha256,
} from "./core.js";

const ASSEMBLY_FIELDS = new Set([
  "entryId",
  "parentEntryId",
  "entryTimestamp",
  "sessionId",
  "researchIdeaHash",
  "researchIdeaVersion",
  "researchStageHash",
]);

export function attachSessionEntryProvenance(entries = [], {
  sessionId = "unknown-session",
  initialState = null,
} = {}) {
  let researchState = structuredClone(initialState || emptyState());
  const messages = [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry?.customType === STATE_TYPE) {
      researchState = applyEvent(researchState, entry.data);
      continue;
    }
    if (entry?.type !== "message" || !entry.message) continue;
    messages.push({
      ...entry.message,
      sessionId,
      entryId: entry.id,
      parentEntryId: entry.parentId,
      entryTimestamp: entry.timestamp,
      researchIdeaHash: entry.message.researchIdeaHash ?? researchState.idea?.hash ?? null,
      researchIdeaVersion: entry.message.researchIdeaVersion ?? researchState.idea?.version ?? null,
      researchStageHash: entry.message.researchStageHash ?? (researchState.stage ? sha256(researchState.stage) : null),
    });
  }
  return messages;
}

export function providerSafeMessage(message) {
  return Object.fromEntries(Object.entries(message || {}).filter(([key]) => !ASSEMBLY_FIELDS.has(key)));
}

function messagesTokens(messages) {
  return groupTurns(messages).reduce((sum, turn) => sum + turn.tokens, 0);
}

export function contextAdoptionMode(value = process.env.PI_IDEA_CONTEXT_MODE) {
  const normalized = String(value || "production").trim().toLowerCase();
  if (normalized === "production" || normalized === "experimental") return "production";
  return "safe";
}

/** Preserve Pi's native context verbatim while the selective compiler has not
 * passed the paired performance gate. This path still injects the confirmed
 * research anchor and emits observability, but never drops history. */
export function compileBaselineSafeContext({
  messages = [],
  anchorMessage = null,
  systemPrompt = "",
  contextWindow = 272000,
  toolSchemaReserveTokens = 8192,
} = {}) {
  const safeMessages = messages.map(providerSafeMessage);
  const outputMessages = [anchorMessage, ...safeMessages].filter(Boolean);
  const window = Math.max(1, Number(contextWindow) || 272000);
  const softLimit = Math.floor(window * CONTEXT_POLICY.watermarks.softFraction);
  const hardLimit = Math.floor(window * CONTEXT_POLICY.watermarks.hardFraction);
  const tokens = {
    system: estimateTokens(systemPrompt),
    toolSchemaReserve: Math.max(0, Number(toolSchemaReserveTokens) || 0),
    anchor: anchorMessage ? messagesTokens([anchorMessage]) : 0,
    nativeMessages: messagesTokens(safeMessages),
  };
  tokens.estimatedInput = tokens.system + tokens.toolSchemaReserve + tokens.anchor + tokens.nativeMessages;
  return {
    messages: outputMessages,
    hardOverflow: tokens.estimatedInput > hardLimit,
    manifest: {
      schema: 1,
      compilerVersion: "baseline-safe-native-context-v1",
      policyVersion: CONTEXT_POLICY.version,
      adoptionMode: "safe",
      selectionPolicy: "no-history-removal",
      tokens,
      watermarks: {
        contextWindow: window,
        softLimit,
        hardLimit,
        softExceeded: tokens.estimatedInput > softLimit,
        hardExceeded: tokens.estimatedInput > hardLimit,
      },
      source: { sourceMessages: messages.length, outputMessages: outputMessages.length },
      benchmarkStatus: "manual-safe-override; evidence-ladder-v6.4-passed-fixed-5pct-sol-paired-gate",
    },
  };
}

function recentMessageSlice(messages, requestedTurns) {
  const source = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Number(requestedTurns) || 1);
  let users = 0;
  let start = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index]?.role === "user") users += 1;
    if (users > limit) {
      start = index + 1;
      break;
    }
  }
  return source.slice(start);
}

function evidenceMessage(context) {
  if (!context) return null;
  return {
    role: "custom",
    customType: "idea-evidence-context-v2",
    content: context,
    display: false,
    timestamp: 0,
  };
}

function gapMessage(gaps, reason) {
  if (!gaps.length && !reason) return null;
  const slots = gaps.map((gap) => `${gap.slot}:${gap.reason}`).join(", ");
  return {
    role: "custom",
    customType: "idea-context-gap-v1",
    content: `<context_gap authority="compiler" reason=${JSON.stringify(reason || "retrieval-uncertain")}>${slots || "mandatory historical dependency could not be included safely"}. Do not infer the missing history; request a bounded memory lookup before making a history-dependent decision.</context_gap>`,
    display: false,
    timestamp: 0,
  };
}

/**
 * Assemble the production prompt with a lexicographic objective: preserve the
 * mandatory task/evidence closure first, then minimize historical tokens. The
 * 60% line permits a justified retry; the 85% line is never crossed.
 */
export function compileProductionContext({
  messages = [],
  memoryBlocks = [],
  anchorMessage = null,
  prompt = "",
  stage = "",
  systemPrompt = "",
  contextWindow = 272000,
  maxOutputTokens = 32000,
  toolSchemaReserveTokens = 8192,
  liveTurns = 4,
  condition = "evidence-ladder",
  maxPositiveKeeps = CONTEXT_POLICY.retrieval.maxPositiveRoots,
  maxOptionalKeeps = CONTEXT_POLICY.retrieval.maxOptionalRoots,
  activeContext = null,
  coldMessagesIndexed = false,
  indexSnapshot = null,
  explicitRootIds = [],
  candidateReranker = null,
} = {}) {
  const started = performance.now();
  const window = Math.max(1, Number(contextWindow) || 272000);
  const modelMaxOutput = Math.max(0, Math.min(window, Number(maxOutputTokens) || 0));
  const toolReserve = Math.max(0, Number(toolSchemaReserveTokens) || 0);
  // The user-facing 85% rule is an input occupancy hard line, not a request to
  // reserve the model catalog's *maximum possible* output on every turn. Pi's
  // catalog currently advertises a 128k output capability for Sol; subtracting
  // that capability would silently move the hard line from 85% to ~53% of the
  // local 272k window. Keep 15% of the window as response headroom and report
  // the catalog capability separately.
  const hardLimit = Math.max(0, Math.floor(window * CONTEXT_POLICY.watermarks.hardFraction));
  const outputHeadroom = window - hardLimit;
  const softLimit = Math.min(hardLimit, Math.floor(window * CONTEXT_POLICY.watermarks.softFraction));
  const assemblyMessages = coldMessagesIndexed ? recentMessageSlice(messages, liveTurns) : messages;
  const turns = groupTurns(assemblyMessages);
  let liveCount = Math.max(0, Math.min(turns.length, Number(liveTurns) || 0));
  if (turns.length && liveCount === 0) liveCount = 1;

  const anchorTokens = anchorMessage ? messagesTokens([anchorMessage]) : 0;
  const systemTokens = estimateTokens(systemPrompt);
  const baseFor = (count) => {
    const live = count ? turns.slice(turns.length - count) : [];
    return systemTokens + toolReserve + anchorTokens + live.reduce((sum, turn) => sum + turn.tokens, 0);
  };
  while (liveCount > 1 && baseFor(liveCount) > softLimit) liveCount -= 1;

  const split = Math.max(0, turns.length - liveCount);
  const coldMessages = coldMessagesIndexed ? [] : turns.slice(0, split).flatMap((turn) => turn.messages);
  const liveMessages = turns.slice(split).flatMap((turn) => turn.messages).map(providerSafeMessage);
  const liveTokens = turns.slice(split).reduce((sum, turn) => sum + turn.tokens, 0);
  const baseTokens = systemTokens + toolReserve + anchorTokens + liveTokens;
  const query = [stage, prompt].filter(Boolean).join("\n");
  const queryLower = query.toLowerCase();
  const productionCandidates = [...memoryBlocks, ...blockizeMessages(coldMessages)];
  const exactRootEventIds = new Set(productionCandidates
    .filter((block) => block.factCandidate && block.refs.some((ref) => queryLower.includes(ref)))
    .map((block) => block.logicalEventId));
  const exactRootBlockIds = productionCandidates
    .filter((block) => exactRootEventIds.has(block.logicalEventId))
    .map((block) => block.blockId);
  const mandatoryRootIds = [...new Set([...(explicitRootIds || []), ...exactRootBlockIds])];
  const missesExactRoots = (candidate) => {
    if (!exactRootEventIds.size) return false;
    const selectedEvents = new Set((candidate.selectedBlocks || []).map((block) => block.logicalEventId));
    return [...exactRootEventIds].some((eventId) => !selectedEvents.has(eventId));
  };
  const compileAt = (budget) => compileEvidenceLadderContext({
    messages: coldMessages,
    memoryBlocks,
    query,
    budget: Math.max(0, budget),
    activeContext,
    explicitRootIds: mandatoryRootIds,
    includeLocalTail: false,
  });

  let expansionLevel = "S0";
  const expansionReasons = [];
  let compilation = compileAt(softLimit - baseTokens);
  if ((compilation.overflow || missesExactRoots(compilation)) && baseTokens < hardLimit) {
    expansionLevel = "S4";
    expansionReasons.push("mandatory-closure-over-soft-limit");
    compilation = compileAt(hardLimit - baseTokens);
  }

  const compilerGaps = compilation.manifest?.gaps || [];
  let evidence = null;
  let gap = null;
  let hardOverflow = false;
  if (compilation.overflow || missesExactRoots(compilation)) {
    hardOverflow = true;
    gap = gapMessage(compilerGaps, missesExactRoots(compilation)
      ? "exact-reference-over-hard-limit"
      : "mandatory-closure-over-hard-limit");
  } else {
    evidence = evidenceMessage(compilation.context);
    gap = gapMessage(compilerGaps, null);
  }
  const outputMessages = [anchorMessage, gap, evidence, ...liveMessages].filter(Boolean);
  const assembledMessageTokens = messagesTokens(outputMessages);
  const estimatedInputTokens = systemTokens + toolReserve + assembledMessageTokens;
  if (estimatedInputTokens > hardLimit) {
    hardOverflow = true;
    evidence = null;
    const finalGap = gapMessage(compilerGaps, "assembled-input-over-hard-limit");
    outputMessages.splice(0, outputMessages.length, ...[anchorMessage, finalGap, ...liveMessages].filter(Boolean));
  }
  const finalEstimatedInputTokens = systemTokens + toolReserve + messagesTokens(outputMessages);
  const manifest = {
    schema: 1,
    compilerVersion: "proof-carrying-production-v4",
    evidenceCompilerVersion: EVIDENCE_LADDER_VERSION,
    policyVersion: CONTEXT_POLICY.version,
    inputEventDigest: sha256(coldMessages.map((message) => `${message.entryId || message.id || "?"}:${message.timestamp || ""}`).join("|")),
    queryHash: sha256(query),
    condition,
    watermarks: {
      contextWindow: window,
      outputHeadroom,
      modelMaxOutput,
      softLimit,
      hardLimit,
      softExceeded: finalEstimatedInputTokens > softLimit,
      hardExceeded: finalEstimatedInputTokens > hardLimit,
    },
    tokens: {
      system: systemTokens,
      toolSchemaReserve: toolReserve,
      anchor: anchorTokens,
      live: liveTokens,
      evidence: compilation.contextTokens || 0,
      estimatedInput: finalEstimatedInputTokens,
    },
    source: {
      turns: turns.length,
      coldTurns: split,
      liveTurns: liveCount,
      sourceMessages: messages.length,
      hotPathSourceMessages: assemblyMessages.length,
      externalMemoryCandidates: memoryBlocks.length,
      outputMessages: outputMessages.length,
      coldMessagesIndexed,
      indexSnapshot,
    },
    expansionLevel,
    expansionReasons,
    gaps: hardOverflow
      ? [...compilerGaps, { slot: "mandatory-closure", reason: "hard-limit", requestedEscalation: "bounded-raw-lookup-or-task-split" }]
      : compilerGaps,
    hardOverflow,
    assembly: compilation.manifest,
    outputHash: sha256(outputMessages.map((message) => JSON.stringify(message)).join("\n")),
    assemblyMs: performance.now() - started,
    conservativeProviderReserves: ["tool-schemas"],
    adoptionEvidence: {
      gate: "fixed-5pct-sol-paired-v2",
      manifestHash: "sha256:b40e3ff44bbe74973ed797c3f3ced860562ee2f48a9e349818aae963f5d3d880",
      resultId: "long-horizon-sol-5pct-e963f5d3d880-result",
      passed: true,
    },
    ignoredOptionalRankers: candidateReranker ? ["candidateReranker"] : [],
  };
  return {
    messages: outputMessages,
    manifest,
    compilation,
    hardOverflow,
  };
}
