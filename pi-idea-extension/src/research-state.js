import { createHash, randomUUID } from "node:crypto";

export const RESEARCH_STATE_SCHEMA = 1;

const PHASES = new Set(["discuss", "plan", "execute", "verify", "blocked", "complete"]);
const ACCEPTANCE = new Set(["unknown", "pending", "passed", "failed"]);
const MODEL_FIELDS = new Set([
  "activeHypothesis",
  "activeRoute",
  "evidenceGap",
  "nextAction",
  "expectedInformation",
  "continueReason",
  "stopProposal",
  "conflicts",
]);
const HARNESS_FIELDS = new Set([...MODEL_FIELDS, "phase", "acceptanceStatus", "blockedReason"]);

function hash(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function timestamp() {
  return new Date().toISOString();
}

function boundedText(value, field, limit = 4000) {
  const text = String(value ?? "").trim();
  if (text.length > limit) throw new Error(`${field} must not exceed ${limit} characters.`);
  return text;
}

function boundedStrings(value, field, limit = 16) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > limit) throw new Error(`${field} must contain at most ${limit} items.`);
  return value.map((item, index) => boundedText(item, `${field}[${index}]`, 1000)).filter(Boolean);
}

export function splitLegacyIdea(content) {
  const source = String(content || "").trim();
  if (!source) throw new Error("Legacy Idea content is required.");
  const marker = /(?:^|\r?\n)[ \t]*当前路线(?:[ \t]+v[^：:\r\n]+)?[：:][ \t]*(?:\r?\n)?/m.exec(source);
  if (!marker) {
    return Object.freeze({
      schema: RESEARCH_STATE_SCHEMA,
      status: "needs-user-frame",
      legacyContent: source,
      legacyHash: hash(source),
      kernelContent: source,
      frameContent: "",
      splitOffset: null,
    });
  }
  const markerStart = marker.index + (marker[0].startsWith("\n") || marker[0].startsWith("\r\n") ? marker[0].match(/^\r?\n/)[0].length : 0);
  const kernelContent = source.slice(0, markerStart).trim();
  const frameStart = marker.index + marker[0].length;
  const frameContent = source.slice(frameStart).trim();
  if (!kernelContent || !frameContent) {
    return Object.freeze({
      schema: RESEARCH_STATE_SCHEMA,
      status: "needs-user-frame",
      legacyContent: source,
      legacyHash: hash(source),
      kernelContent: source,
      frameContent: "",
      splitOffset: null,
    });
  }
  return Object.freeze({
    schema: RESEARCH_STATE_SCHEMA,
    status: "deterministic-split",
    legacyContent: source,
    legacyHash: hash(source),
    kernelContent,
    frameContent,
    splitOffset: markerStart,
  });
}

export function makeAuthorityLayer(content, { version = 1, parentHash = null, source = "user-confirmed", confirmedAt = timestamp() } = {}) {
  const value = boundedText(content, "authority content", 24_000);
  if (!value) throw new Error("Authority content is required.");
  return Object.freeze({
    schema: RESEARCH_STATE_SCHEMA,
    version,
    content: value,
    hash: hash(value),
    parentHash,
    source,
    confirmedAt,
  });
}

export function emptyWorkingState({ updatedBy = "harness" } = {}) {
  const updatedAt = timestamp();
  const value = {
    schema: RESEARCH_STATE_SCHEMA,
    revision: 0,
    phase: "discuss",
    acceptanceStatus: "unknown",
    activeHypothesis: "",
    activeRoute: "",
    evidenceGap: "",
    nextAction: "",
    expectedInformation: "",
    continueReason: "",
    stopProposal: "",
    blockedReason: "",
    conflicts: [],
    updatedBy,
    updatedAt,
  };
  return Object.freeze({ ...value, hash: hash(JSON.stringify(value)) });
}

export function applyWorkingStatePatch(current, patch, { actor = "model", at = timestamp() } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Working State patch must be an object.");
  const previous = current?.schema === RESEARCH_STATE_SCHEMA ? current : emptyWorkingState();
  const allowed = actor === "model" ? MODEL_FIELDS : actor === "harness" || actor === "user" ? HARNESS_FIELDS : new Set();
  const rejected = Object.keys(patch).filter((key) => !allowed.has(key));
  if (rejected.length) throw new Error(`${actor} cannot update Working State fields: ${rejected.join(", ")}`);
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "conflicts") next.conflicts = boundedStrings(value, key);
    else if (key === "phase") {
      const phase = String(value);
      if (!PHASES.has(phase)) throw new Error("Invalid Working State phase.");
      next.phase = phase;
    } else if (key === "acceptanceStatus") {
      const status = String(value);
      if (!ACCEPTANCE.has(status)) throw new Error("Invalid acceptance status.");
      next.acceptanceStatus = status;
    } else {
      next[key] = boundedText(value, key);
    }
  }
  next.schema = RESEARCH_STATE_SCHEMA;
  next.revision = Number(previous.revision || 0) + 1;
  next.updatedBy = actor;
  next.updatedAt = at;
  delete next.hash;
  return Object.freeze({ ...next, hash: hash(JSON.stringify(next)) });
}

export function createFrameProposal({ ideaId, content, currentFrame = null, source = "model-suggestion" } = {}) {
  const value = boundedText(content, "Research Frame proposal", 24_000);
  if (!ideaId || !value) throw new Error("Idea id and Research Frame proposal are required.");
  return Object.freeze({
    schema: RESEARCH_STATE_SCHEMA,
    proposalId: randomUUID(),
    ideaId,
    baseVersion: currentFrame?.version || 0,
    baseHash: currentFrame?.hash || null,
    content: value,
    contentHash: hash(value),
    source,
    createdAt: timestamp(),
  });
}

export function workingStateText(state) {
  const value = state?.schema === RESEARCH_STATE_SCHEMA ? state : emptyWorkingState();
  const rows = [
    `phase=${value.phase}`,
    `acceptance=${value.acceptanceStatus}`,
  ];
  for (const [key, label] of [
    ["activeHypothesis", "hypothesis"],
    ["activeRoute", "route"],
    ["evidenceGap", "evidence_gap"],
    ["nextAction", "next_action"],
    ["expectedInformation", "expected_information"],
    ["continueReason", "continue_reason"],
    ["stopProposal", "stop_proposal"],
    ["blockedReason", "blocked_reason"],
  ]) {
    if (value[key]) rows.push(`${label}=${value[key]}`);
  }
  if (value.conflicts?.length) rows.push(`conflicts=${value.conflicts.join(" | ")}`);
  return rows.join("\n");
}

export function decideControlAction(state) {
  const value = state?.schema === RESEARCH_STATE_SCHEMA ? state : emptyWorkingState();
  if (value.acceptanceStatus === "passed") return Object.freeze({ action: "complete", reason: "acceptance-passed" });
  if (value.blockedReason) return Object.freeze({ action: "ask-user", reason: "harness-blocked" });
  if (value.stopProposal) return Object.freeze({ action: "verify-stop", reason: "model-stop-proposal" });
  if (value.nextAction) return Object.freeze({ action: "continue", reason: "executable-next-action" });
  return Object.freeze({ action: "discuss", reason: "no-executable-next-action" });
}
