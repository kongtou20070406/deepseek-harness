import { createHash } from "node:crypto";

import { assertNoGoldLeak, deepFreeze } from "./adapter.mjs";

export const PROTOCOL_SCHEMA_VERSION = 1;
export const MEMORYARENA_CONDITIONS = Object.freeze(["local", "luna"]);

const PRIVATE_FEEDBACK_KEYS = new Set([
  "answer",
  "answers",
  "correctanswer",
  "correctanswers",
  "gold",
  "goldanswer",
  "goldanswers",
  "groundtruth",
  "matchgroundtruth",
  "referenceanswer",
  "referenceanswers",
  "targetasin",
  "targetproducts",
]);

function normalizeKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertJsonSafe(value, path = "value") {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonSafe(child, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_FEEDBACK_KEYS.has(normalizeKey(key))) {
        throw new Error(`Benchmark-private evaluator field is not agent-visible: ${path}.${key}`);
      }
      assertJsonSafe(child, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} is not JSON-safe`);
}

function isoOrNull(value, label) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

export function normalizeCondition(condition) {
  const requested = condition?.requested;
  const effective = condition?.effective ?? requested;
  if (!MEMORYARENA_CONDITIONS.includes(requested)) {
    throw new Error(`Unknown requested condition: ${requested}`);
  }
  if (!MEMORYARENA_CONDITIONS.includes(effective)) {
    throw new Error(`Unknown effective condition: ${effective}`);
  }
  const fellBack = requested !== effective;
  if (fellBack && requested !== "luna") {
    throw new Error("Only a requested Luna condition may fall back to local");
  }
  if (fellBack && !condition.fallbackReason) {
    throw new Error("Luna-to-local fallback requires a reason");
  }
  const fallbackWaitMs = Number(condition?.fallbackWaitMs ?? 0);
  if (!Number.isFinite(fallbackWaitMs) || fallbackWaitMs < 0) {
    throw new TypeError("fallbackWaitMs must be a finite non-negative number");
  }
  if (fellBack && fallbackWaitMs !== 0) {
    throw new Error("Non-blocking Luna fallback must not wait before using local assembly");
  }
  return deepFreeze({
    requested,
    effective,
    fellBack,
    fallbackReason: fellBack ? String(condition.fallbackReason) : null,
    fallbackWaitMs,
    lunaIndexReady: condition?.lunaIndexReady ?? null,
  });
}

function eventDigest(event) {
  return createHash("sha256").update(JSON.stringify(event), "utf8").digest("hex");
}

/**
 * Captures executor-visible sessions, actions, and feedback without exposing
 * benchmark answer keys. Sequence ordinals are authoritative when the source
 * contains no wall-clock time; no synthetic timestamp is invented.
 */
export function createTraceRecorder(onlineCase, conditionInput) {
  assertNoGoldLeak(onlineCase);
  const condition = normalizeCondition(conditionInput);
  const sessions = new Map(onlineCase.sessions.map((session) => [session.sessionId, session]));
  const state = new Map();
  const events = [];

  const getSession = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown MemoryArena session: ${sessionId}`);
    return session;
  };

  const append = (event) => {
    const withDigest = deepFreeze({ ...event, eventSha256: eventDigest(event) });
    events.push(withDigest);
    return withDigest;
  };

  const baseProvenance = (session, kind, stepOrdinal, recordedAt) => ({
    benchmark: onlineCase.benchmark,
    dataset: onlineCase.dataset,
    config: onlineCase.config,
    split: onlineCase.split,
    caseKey: onlineCase.caseKey,
    sessionId: session.sessionId,
    sessionOrdinal: session.sessionOrdinal,
    stepOrdinal,
    eventOrdinal: events.length + 1,
    kind,
    sourceUri: onlineCase.provenance.sourceUri,
    sourceSha256: onlineCase.provenance.sourceSha256,
    rowNumber: onlineCase.provenance.rowNumber,
    rowSha256: onlineCase.provenance.rowSha256,
    sourceTimestamp: null,
    recordedAt: isoOrNull(recordedAt, "recordedAt"),
  });

  return {
    condition,

    startSession(sessionId, { recordedAt } = {}) {
      const session = getSession(sessionId);
      if (state.has(sessionId)) throw new Error(`Session already started: ${sessionId}`);
      state.set(sessionId, { nextStep: 1, awaitingFeedback: false });
      return append({
        type: "session.start",
        content: {
          instruction: session.instruction,
          background: session.background,
          initialContextRefs: session.initialContextRefs,
        },
        provenance: baseProvenance(session, "benchmark-session", 0, recordedAt),
      });
    },

    recordAction(sessionId, { content, model = null, recordedAt } = {}) {
      const session = getSession(sessionId);
      const sessionState = state.get(sessionId);
      if (!sessionState) throw new Error(`Session must start before an action: ${sessionId}`);
      if (sessionState.awaitingFeedback) {
        throw new Error(`Action ${sessionState.nextStep} is still awaiting feedback`);
      }
      assertJsonSafe(content, "action.content");
      const stepOrdinal = sessionState.nextStep;
      sessionState.awaitingFeedback = true;
      return append({
        type: "agent.action",
        content: structuredClone(content),
        producer: {
          requestedCondition: condition.requested,
          effectiveCondition: condition.effective,
          model,
        },
        provenance: baseProvenance(session, "agent-action", stepOrdinal, recordedAt),
      });
    },

    recordFeedback(sessionId, { observation, reward = null, done = false, recordedAt } = {}) {
      const session = getSession(sessionId);
      const sessionState = state.get(sessionId);
      if (!sessionState?.awaitingFeedback) {
        throw new Error(`Feedback requires a preceding action in session ${sessionId}`);
      }
      assertJsonSafe(observation, "feedback.observation");
      if (reward !== null && (!Number.isFinite(reward) || typeof reward !== "number")) {
        throw new TypeError("feedback.reward must be a finite number or null");
      }
      if (typeof done !== "boolean") throw new TypeError("feedback.done must be boolean");
      const stepOrdinal = sessionState.nextStep;
      sessionState.awaitingFeedback = false;
      sessionState.nextStep += 1;
      return append({
        type: "environment.feedback",
        content: {
          observation: structuredClone(observation),
          reward,
          done,
        },
        provenance: baseProvenance(session, "environment-feedback", stepOrdinal, recordedAt),
      });
    },

    finish() {
      for (const [sessionId, sessionState] of state) {
        if (sessionState.awaitingFeedback) {
          throw new Error(`Cannot finish: ${sessionId} has an action without feedback`);
        }
      }
      return deepFreeze({
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        benchmark: onlineCase.benchmark,
        caseKey: onlineCase.caseKey,
        condition,
        events: Object.freeze([...events]),
      });
    },
  };
}

export function assertAgentVisibleFeedback(payload) {
  assertJsonSafe(payload, "feedback");
  return true;
}
