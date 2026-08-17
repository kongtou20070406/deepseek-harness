import { createHash } from "node:crypto";
import { blockizeMessages } from "./evidence-context-compiler.js";
import { CONTEXT_POLICY } from "./context-policy.js";

export const OBELISK_EVIDENCE_SCHEMA = "pi-idea-obelisk-evidence-v1";

function rawDigest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function createObeliskLookupPlan({ projectPath, query, reason = "historical-evidence-gap" } = {}) {
  const text = String(query || "").trim();
  if (!projectPath || !text) throw new Error("Obelisk lookup needs an exact projectPath and non-empty query");
  return Object.freeze({
    schema: 1,
    adapter: "obelisk-skill-compat-v1",
    mode: CONTEXT_POLICY.obelisk.mode,
    projectPath: String(projectPath),
    query: text,
    queryHash: rawDigest(text),
    reason,
    limits: {
      maxEvidenceRows: CONTEXT_POLICY.obelisk.maxEvidenceRows,
      planningSnippetChars: CONTEXT_POLICY.obelisk.maxSnippetCharsForPlanning,
    },
    contract: [
      "Use Obelisk skill outside the context hot path.",
      "Orient and search compactly, then expand only selected message IDs to verbatim raw text.",
      "Return message text, stable IDs, timestamps, content_type, is_meta, source, and SHA-256.",
      "Do not return summaries, thinking, meta rows, or model-generated claims as evidence.",
    ],
  });
}

/** Convert an explicitly retrieved Obelisk envelope into ordinary immutable
 * evidence blocks. The adapter never runs Obelisk and is absent from hot-path
 * assembly unless a caller supplies a verified envelope. */
export function adaptObeliskEvidence(envelope, { maxRows = CONTEXT_POLICY.obelisk.maxEvidenceRows } = {}) {
  if (envelope?.schema !== OBELISK_EVIDENCE_SCHEMA) throw new Error("Unsupported Obelisk evidence schema");
  const rows = Array.isArray(envelope.rows) ? envelope.rows.slice(0, Math.max(0, maxRows)) : [];
  const accepted = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const reason = row.isMeta ? "meta"
      : !CONTEXT_POLICY.obelisk.acceptedContentTypes.includes(String(row.contentType || "")) ? "content-type"
        : row.truncated ? "truncated"
          : typeof row.raw !== "string" || !row.raw ? "missing-raw"
            : !row.sessionId || !row.messageId ? "missing-stable-id"
              : rawDigest(row.raw) !== String(row.rawHash || "").replace(/^sha256:/, "").toLowerCase() ? "raw-hash-mismatch"
                : null;
    if (reason) {
      rejected.push({ index, messageId: row.messageId || null, reason });
      continue;
    }
    accepted.push(row);
  }
  const messages = accepted.map((row) => ({
    role: row.role === "user" ? "user" : "assistant",
    stopReason: row.role === "user" ? undefined : "stop",
    content: row.raw,
    sessionId: String(row.sessionId),
    entryId: String(row.messageId),
    entryTimestamp: row.timestamp ?? null,
    timestamp: row.timestamp ?? null,
    recoverableRef: row.recoverableRef || `obelisk:message:${row.messageId}`,
    sourceIdentity: `obelisk:${row.source || "unknown"}:${row.messageId}`,
  }));
  const blocks = blockizeMessages(messages);
  return Object.freeze({
    blocks,
    manifest: Object.freeze({
      schema: 1,
      adapter: "obelisk-skill-compat-v1",
      envelopeQueryHash: envelope.queryHash || null,
      suppliedRows: Array.isArray(envelope.rows) ? envelope.rows.length : 0,
      acceptedRows: accepted.length,
      acceptedBlocks: blocks.length,
      rejected,
      outputDigest: rawDigest(blocks.map((block) => block.blockId).join("|")),
    }),
  });
}
