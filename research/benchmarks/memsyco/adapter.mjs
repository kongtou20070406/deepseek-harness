import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MEMSYCO_TASK_SPECS = Object.freeze({
  objective_fact_judgment: Object.freeze({
    policy: "ignore_as_evidence",
    samples: 300,
    file: "objective_fact_judgment.jsonl",
    retrievalRequirement: "not-required",
  }),
  contextual_scope_control: Object.freeze({
    policy: "constrain_to_scope",
    samples: 300,
    file: "contextual_scope_control.jsonl",
    retrievalRequirement: "required",
  }),
  memory_evidence_conflict: Object.freeze({
    policy: "defer_to_evidence",
    samples: 300,
    file: "memory_evidence_conflict.jsonl",
    retrievalRequirement: "required",
  }),
  valid_memory_selection: Object.freeze({
    policy: "update",
    samples: 350,
    file: "valid_memory_selection.jsonl",
    retrievalRequirement: "required",
  }),
  personalized_memory_use: Object.freeze({
    policy: "use",
    samples: 300,
    file: "personalized_memory_use.jsonl",
    retrievalRequirement: "required",
  }),
});

export const OFFICIAL_MANIFEST_V1_2 = Object.freeze({
  name: "MemSyco-Bench",
  schema_version: "1.2",
  total_samples: 1550,
  tasks: Object.freeze({
    personalized_memory_use: Object.freeze({
      file: "personalized_memory_use.jsonl",
      samples: 300,
      memory_policy: "use",
      // The Hugging Face manifest hashes canonical CRLF bytes. The GitHub
      // checkout is LF for this file; both describe the same released rows.
      sha256: "6140d63fa2f1952b794466542ff87f4ed586d8137e40acafb9cb192b18f06025",
      rawLfSha256: "7e4384008478265e338c8571a0f6d8e7a8720439f97dff8e735c1c858f613e17",
    }),
    valid_memory_selection: Object.freeze({
      file: "valid_memory_selection.jsonl",
      samples: 350,
      memory_policy: "update",
      sha256: "afaba4b6dff5163469fa6bdabd5e492b8fbe8348c6af6a2732386ba740dd040e",
      rawLfSha256: "7db0f062306a925f7cea9ea9cfb32cb94bbe2bb17999eff3e4a764aeabc4d498",
    }),
    memory_evidence_conflict: Object.freeze({
      file: "memory_evidence_conflict.jsonl",
      samples: 300,
      memory_policy: "defer_to_evidence",
      sha256: "dc3ffe396251c58fbf5ca77458d4bd3c405d2322dda8f65f9996d082568f16be",
      rawLfSha256: "adf9a924bae5bf4d554c0f7bf69c8c867037caf13c9839afa93605cb39442823",
    }),
    contextual_scope_control: Object.freeze({
      file: "contextual_scope_control.jsonl",
      samples: 300,
      memory_policy: "constrain_to_scope",
      sha256: "43c09e35b57ecfaabb76f08fee0565d96d0b81e3b90a3fa8e82c23a83f272e20",
      rawLfSha256: "a233ee49a17434255fd372a95284f57bfa3bbbbcbb5cf9be2d0c6c793865d748",
    }),
    objective_fact_judgment: Object.freeze({
      file: "objective_fact_judgment.jsonl",
      samples: 300,
      memory_policy: "ignore_as_evidence",
      sha256: "c6ea7e17df9a90480115c0b7ebf8930aa36a39504acbfa1b650d2be167546f97",
      rawLfSha256: "cd34eb4136dc9a5e2b4eff742a43de25d50bd1044455160a4b4eea0f082b81bc",
    }),
  }),
});

const TOP_LEVEL_KEYS = new Set(["id", "task", "dialogue", "question", "memory", "evaluation", "metadata"]);
const MEMORY_STATUSES = new Set(["active", "current", "outdated"]);
const DIALOGUE_ROLES = new Set(["user", "assistant"]);
const GOLD_OR_ANALYSIS_KEYS = new Set([
  "task",
  "memory",
  "policy",
  "items",
  "evaluation",
  "reference_answer",
  "referenceAnswer",
  "preference_aligned_answer",
  "preferenceAlignedAnswer",
  "rubric",
  "metadata",
  "source_id",
  "sourceId",
  "subtype",
  "topic",
  "officialId",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function assertExactKeys(value, allowed, required, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required field ${JSON.stringify(key)}`);
  }
}

function clone(value) {
  return structuredClone(value);
}

function parseJsonLines(text, source) {
  return String(text).split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${source}:${index + 1}: ${error.message}`);
    }
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Normalize only physical line endings. JSON text and the terminal newline
 * remain otherwise byte-for-byte intact. This mirrors the official HF
 * manifest's CRLF hashes while allowing an LF checkout to verify exactly. */
export function canonicalCrlfBytes(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  return Buffer.from(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n"), "utf8");
}

function assertPinnedManifest(manifest) {
  if (manifest.name !== OFFICIAL_MANIFEST_V1_2.name) {
    throw new Error(`Unexpected MemSyco manifest name: ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.schema_version !== OFFICIAL_MANIFEST_V1_2.schema_version) {
    throw new Error(`Expected MemSyco schema 1.2, received ${JSON.stringify(manifest.schema_version)}`);
  }
  if (manifest.total_samples !== OFFICIAL_MANIFEST_V1_2.total_samples) {
    throw new Error(`Expected 1550 MemSyco samples, received ${JSON.stringify(manifest.total_samples)}`);
  }
  assertObject(manifest.tasks, "manifest.tasks");
  for (const [task, expected] of Object.entries(OFFICIAL_MANIFEST_V1_2.tasks)) {
    const actual = manifest.tasks[task];
    assertObject(actual, `manifest.tasks.${task}`);
    for (const key of ["file", "samples", "memory_policy"]) {
      if (actual[key] !== expected[key]) {
        throw new Error(`Pinned manifest mismatch at ${task}.${key}: expected ${JSON.stringify(expected[key])}, received ${JSON.stringify(actual[key])}`);
      }
    }
    const acceptedHashes = new Set([expected.sha256, expected.rawLfSha256]);
    if (!acceptedHashes.has(actual.sha256)) {
      throw new Error(`Pinned manifest mismatch at ${task}.sha256: unrecognized official hash ${JSON.stringify(actual.sha256)}`);
    }
  }
}

/**
 * Validate the released schema v1.2 without a runtime JSON-schema dependency.
 * This deliberately rejects extra fields at every level where the official
 * schema sets additionalProperties=false.
 */
export function validateMemSycoRow(row, { source = "MemSyco row", requireTaskSemantics = true } = {}) {
  assertExactKeys(row, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS, source);
  assertNonEmptyString(row.id, `${source}.id`);
  assertNonEmptyString(row.task, `${source}.task`);
  const taskSpec = MEMSYCO_TASK_SPECS[row.task];
  if (!taskSpec) throw new Error(`${source}.task is not a canonical MemSyco task: ${JSON.stringify(row.task)}`);

  if (!Array.isArray(row.dialogue) || row.dialogue.length === 0) {
    throw new Error(`${source}.dialogue must contain at least one turn`);
  }
  row.dialogue.forEach((turn, index) => {
    const label = `${source}.dialogue[${index}]`;
    assertExactKeys(turn, new Set(["role", "content"]), new Set(["role", "content"]), label);
    if (!DIALOGUE_ROLES.has(turn.role)) throw new Error(`${label}.role must be user or assistant`);
    assertNonEmptyString(turn.content, `${label}.content`);
  });
  assertNonEmptyString(row.question, `${source}.question`);

  assertExactKeys(row.memory, new Set(["policy", "items"]), new Set(["policy", "items"]), `${source}.memory`);
  if (row.memory.policy !== taskSpec.policy) {
    throw new Error(`${source}.memory.policy must be ${JSON.stringify(taskSpec.policy)} for ${row.task}`);
  }
  if (!Array.isArray(row.memory.items) || row.memory.items.length === 0) {
    throw new Error(`${source}.memory.items must contain at least one item`);
  }
  row.memory.items.forEach((item, index) => {
    const label = `${source}.memory.items[${index}]`;
    assertExactKeys(item, new Set(["content", "type", "status"]), new Set(["content", "type", "status"]), label);
    assertNonEmptyString(item.content, `${label}.content`);
    assertNonEmptyString(item.type, `${label}.type`);
    if (!MEMORY_STATUSES.has(item.status)) throw new Error(`${label}.status is not recognized`);
  });
  if (requireTaskSemantics && row.task === "valid_memory_selection") {
    const statuses = new Set(row.memory.items.map((item) => item.status));
    if (!statuses.has("current") || !statuses.has("outdated")) {
      throw new Error(`${source} update task must contain both current and outdated memory`);
    }
  }

  assertExactKeys(
    row.evaluation,
    new Set(["reference_answer", "preference_aligned_answer", "rubric"]),
    new Set(["reference_answer", "rubric"]),
    `${source}.evaluation`,
  );
  assertNonEmptyString(row.evaluation.reference_answer, `${source}.evaluation.reference_answer`);
  if (Object.hasOwn(row.evaluation, "preference_aligned_answer")) {
    assertNonEmptyString(row.evaluation.preference_aligned_answer, `${source}.evaluation.preference_aligned_answer`);
  }
  assertObject(row.evaluation.rubric, `${source}.evaluation.rubric`);
  if (Object.keys(row.evaluation.rubric).length === 0) throw new Error(`${source}.evaluation.rubric must not be empty`);

  assertExactKeys(
    row.metadata,
    new Set(["source_id", "subtype", "topic", "source"]),
    new Set(),
    `${source}.metadata`,
  );
  for (const key of ["source_id", "subtype", "topic"]) {
    if (Object.hasOwn(row.metadata, key) && typeof row.metadata[key] !== "string") {
      throw new Error(`${source}.metadata.${key} must be a string`);
    }
  }
  if (Object.hasOwn(row.metadata, "source")) {
    const label = `${source}.metadata.source`;
    const required = new Set(["dataset", "split", "row_index", "question", "url"]);
    assertExactKeys(row.metadata.source, required, required, label);
    // Unlike the core text fields, schema v1.2 gives these provenance strings
    // no minLength. Some released rows intentionally have an empty URL.
    for (const key of ["dataset", "split", "question", "url"]) {
      if (typeof row.metadata.source[key] !== "string") throw new Error(`${label}.${key} must be a string`);
    }
    if (!Number.isInteger(row.metadata.source.row_index)) throw new Error(`${label}.row_index must be an integer`);
  }
  return true;
}

export function assertNoMemSycoGoldLeak(selectorView) {
  const walk = (value, path = "selectorView") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (GOLD_OR_ANALYSIS_KEYS.has(key)) {
        throw new Error(`MemSyco gold/analysis label leaked into online view at ${path}.${key}`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(selectorView);
  return true;
}

/**
 * Split an official row into physically separate online and evaluation views.
 * The online key is an opaque hash: task-coded IDs such as mso_* never reach
 * the assembler. Timestamps are intentionally absent because the benchmark
 * release does not provide any; the adapter never fabricates them.
 */
export function splitMemSycoRow(row) {
  validateMemSycoRow(row);
  const caseKey = `msy:${sha256(`memsyco-case-v1\0${row.id}`).slice(0, 20)}`;
  const selectorView = {
    caseKey,
    question: row.question,
    history: row.dialogue.map((turn, index) => ({
      turnId: `${caseKey}:turn:${String(index).padStart(4, "0")}`,
      role: turn.role,
      content: turn.content,
    })),
  };
  const reference = {
    caseKey,
    officialId: row.id,
    task: row.task,
    question: row.question,
    memoryPolicy: row.memory.policy,
    memoryItems: clone(row.memory.items),
    evaluation: clone(row.evaluation),
    metadata: clone(row.metadata),
    questionSha256: `sha256:${sha256(row.question)}`,
    historySha256: `sha256:${sha256(JSON.stringify(row.dialogue))}`,
  };
  assertNoMemSycoGoldLeak(selectorView);
  return { selectorView, reference };
}

/** Preserve the official dialogue text and role exactly. Provenance stays in
 * the sidecar turnId; it is not injected as benchmark-visible marker text. */
export function memSycoSelectorToPiMessages(selectorView, { includeQuestion = true } = {}) {
  assertNoMemSycoGoldLeak(selectorView);
  const messages = selectorView.history.map((turn) => ({ role: turn.role, content: turn.content }));
  if (includeQuestion) messages.push({ role: "user", content: selectorView.question });
  return messages;
}

export function memSycoSourceMap(selectorView) {
  assertNoMemSycoGoldLeak(selectorView);
  return Object.fromEntries(selectorView.history.map((turn, index) => [turn.turnId, {
    historyIndex: index,
    role: turn.role,
    // No timestamp field: the official schema has none.
  }]));
}

export async function loadMemSycoBench(root, {
  requirePinnedManifest = true,
  verifyChecksums = true,
  requireTaskSemantics = true,
} = {}) {
  const manifestPath = join(root, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid MemSyco manifest at ${manifestPath}: ${error.message}`);
  }
  if (requirePinnedManifest) assertPinnedManifest(manifest);
  assertObject(manifest.tasks, "manifest.tasks");

  const cases = [];
  const counts = {};
  const fileDigests = {};
  const datasetDigest = createHash("sha256").update("memsyco-adapter-dataset-v1\0").update(manifestBytes);
  const taskOrder = Object.keys(MEMSYCO_TASK_SPECS);
  for (const task of taskOrder) {
    const taskManifest = manifest.tasks[task];
    assertObject(taskManifest, `manifest.tasks.${task}`);
    assertNonEmptyString(taskManifest.file, `manifest.tasks.${task}.file`);
    const filePath = join(root, taskManifest.file);
    const bytes = await readFile(filePath);
    const actualSha256 = sha256(bytes);
    const canonicalBytes = canonicalCrlfBytes(bytes);
    const canonicalCrlfSha256 = sha256(canonicalBytes);
    const checksumMode = actualSha256 === taskManifest.sha256
      ? "raw"
      : canonicalCrlfSha256 === taskManifest.sha256
        ? "canonical-crlf"
        : null;
    if (verifyChecksums && !checksumMode) {
      throw new Error(`Checksum mismatch for ${filePath}: expected ${taskManifest.sha256}, raw=${actualSha256}, canonical-crlf=${canonicalCrlfSha256}`);
    }
    if (requirePinnedManifest && canonicalCrlfSha256 !== OFFICIAL_MANIFEST_V1_2.tasks[task].sha256) {
      throw new Error(`Pinned content mismatch for ${filePath}: expected canonical CRLF ${OFFICIAL_MANIFEST_V1_2.tasks[task].sha256}, received ${canonicalCrlfSha256}`);
    }
    const rows = parseJsonLines(bytes.toString("utf8"), filePath);
    if (rows.length !== taskManifest.samples) {
      throw new Error(`Sample count mismatch for ${task}: expected ${taskManifest.samples}, received ${rows.length}`);
    }
    rows.forEach((row, index) => {
      validateMemSycoRow(row, { source: `${filePath}:${index + 1}`, requireTaskSemantics });
      if (row.task !== task) throw new Error(`${filePath}:${index + 1} declares task ${row.task}, expected ${task}`);
      cases.push(splitMemSycoRow(row));
    });
    counts[task] = rows.length;
    fileDigests[task] = Object.freeze({
      manifestSha256: taskManifest.sha256,
      rawSha256: actualSha256,
      canonicalCrlfSha256,
      checksumMode: checksumMode ?? "unchecked",
    });
    datasetDigest.update("\0").update(task).update("\0").update(canonicalBytes);
  }
  const totalExpected = Number(manifest.total_samples);
  if (!Number.isInteger(totalExpected) || cases.length !== totalExpected) {
    throw new Error(`Total sample count mismatch: manifest=${manifest.total_samples}, loaded=${cases.length}`);
  }
  return {
    schemaVersion: String(manifest.schema_version),
    cases,
    counts,
    fileDigests,
    sha256: `sha256:${datasetDigest.digest("hex")}`,
    manifestSha256: `sha256:${sha256(manifestBytes)}`,
  };
}
