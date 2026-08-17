import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  adaptObeliskEvidence,
  createObeliskLookupPlan,
  OBELISK_EVIDENCE_SCHEMA,
} from "../src/obelisk-compat.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("Obelisk compatibility produces a bounded external lookup plan, not a hot-path call", () => {
  const plan = createObeliskLookupPlan({
    projectPath: "D:\\research\\eqop",
    query: "recover the matched fresh60k decision",
  });
  assert.equal(plan.mode, "explicit-gap-compatibility-only");
  assert.equal(plan.limits.maxEvidenceRows, 8);
  assert.match(plan.contract.join("\n"), /outside the context hot path/);
});

test("Obelisk adapter accepts only complete hash-verified visible text", () => {
  const raw = "The matched fresh60k result was negative.";
  const result = adaptObeliskEvidence({
    schema: OBELISK_EVIDENCE_SCHEMA,
    queryHash: "q1",
    rows: [
      { sessionId: "s1", messageId: "m1", timestamp: "2026-08-01T00:00:00Z", role: "assistant", contentType: "text", isMeta: false, raw, rawHash: digest(raw), source: "codex" },
      { sessionId: "s1", messageId: "m2", role: "assistant", contentType: "thinking", isMeta: false, raw: "hidden", rawHash: digest("hidden") },
      { sessionId: "s1", messageId: "m3", role: "user", contentType: "text", isMeta: true, raw: "injected", rawHash: digest("injected") },
      { sessionId: "s1", messageId: "m4", role: "user", contentType: "text", isMeta: false, raw: "cut", rawHash: digest("cut"), truncated: true },
      { sessionId: "s1", messageId: "m5", role: "user", contentType: "text", isMeta: false, raw: "tampered", rawHash: digest("other") },
    ],
  });
  assert.equal(result.manifest.acceptedRows, 1);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].raw, raw);
  assert.equal(result.blocks[0].provenance.sessionId, "s1");
  assert.deepEqual(result.manifest.rejected.map((row) => row.reason), ["content-type", "meta", "truncated", "raw-hash-mismatch"]);
});
