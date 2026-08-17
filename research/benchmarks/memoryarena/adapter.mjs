import { createHash } from "node:crypto";

export const MEMORYARENA_DATASET = "ZexueHe/memoryarena";
export const MEMORYARENA_BENCHMARK = "MemoryArena";
export const ADAPTER_SCHEMA_VERSION = 1;

export const MEMORYARENA_CONFIGS = Object.freeze({
  bundled_shopping: Object.freeze({
    fileName: "bundled_shopping.jsonl",
    answerShape: "shopping-product",
    successRule: "all-subtasks",
  }),
  progressive_search: Object.freeze({
    fileName: "progressive_search.jsonl",
    answerShape: "text",
    successRule: "final-subtask",
  }),
  group_travel_planner: Object.freeze({
    fileName: "group_travel_planner.jsonl",
    answerShape: "travel-plan",
    successRule: "all-subtasks",
  }),
  formal_reasoning_math: Object.freeze({
    fileName: "formal_reasoning_math.jsonl",
    answerShape: "text",
    successRule: "final-subtask",
  }),
  formal_reasoning_phys: Object.freeze({
    fileName: "formal_reasoning_phys.jsonl",
    answerShape: "text",
    successRule: "final-subtask",
  }),
});

const FORBIDDEN_ONLINE_KEYS = new Set([
  "answer",
  "answers",
  "correctanswer",
  "correctanswers",
  "gold",
  "goldanswer",
  "goldanswers",
  "groundtruth",
  "matchgroundtruth",
  "reference",
  "referenceanswer",
  "referenceanswers",
  "targetasin",
  "targetproducts",
]);

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function validateAnswer(answer, shape, label) {
  if (shape === "text") {
    assertNonEmptyString(answer, label);
    return;
  }

  if (shape === "shopping-product") {
    assertPlainObject(answer, label);
    assertNonEmptyString(answer.target_asin, `${label}.target_asin`);
    if (!Array.isArray(answer.attributes)) {
      throw new TypeError(`${label}.attributes must be an array`);
    }
    for (const [index, attribute] of answer.attributes.entries()) {
      assertNonEmptyString(attribute, `${label}.attributes[${index}]`);
    }
    return;
  }

  if (shape === "travel-plan") {
    if (!Array.isArray(answer) || answer.length === 0) {
      throw new TypeError(`${label} must be a non-empty array of daily-plan objects`);
    }
    for (const [index, day] of answer.entries()) {
      assertPlainObject(day, `${label}[${index}]`);
    }
    return;
  }

  throw new Error(`Unsupported MemoryArena answer shape: ${shape}`);
}

export function validateMemoryArenaRow(row, config) {
  const definition = MEMORYARENA_CONFIGS[config];
  if (!definition) throw new Error(`Unknown MemoryArena config: ${config}`);
  assertPlainObject(row, "row");

  if (!Number.isInteger(row.id) && !(typeof row.id === "string" && row.id.length > 0)) {
    throw new TypeError("row.id must be an integer or non-empty string");
  }
  if (!Array.isArray(row.questions) || row.questions.length < 2) {
    throw new TypeError("row.questions must contain at least two ordered subtasks");
  }
  if (!Array.isArray(row.answers) || row.answers.length !== row.questions.length) {
    throw new TypeError("row.answers must align one-to-one with row.questions");
  }

  for (const [index, question] of row.questions.entries()) {
    assertNonEmptyString(question, `row.questions[${index}]`);
    validateAnswer(row.answers[index], definition.answerShape, `row.answers[${index}]`);
  }

  if (config === "bundled_shopping") {
    assertNonEmptyString(row.category, "row.category");
  } else if (config === "group_travel_planner") {
    assertPlainObject(row.base_person, "row.base_person");
    assertNonEmptyString(row.base_person.name, "row.base_person.name");
    assertNonEmptyString(row.base_person.query, "row.base_person.query");
    if (!Array.isArray(row.base_person.daily_plans) || row.base_person.daily_plans.length === 0) {
      throw new TypeError("row.base_person.daily_plans must be a non-empty array");
    }
  } else if (config.startsWith("formal_reasoning_")) {
    assertNonEmptyString(row.paper_name, "row.paper_name");
    if (!Array.isArray(row.backgrounds) || row.backgrounds.length !== row.questions.length) {
      throw new TypeError("row.backgrounds must align one-to-one with formal-reasoning questions");
    }
    for (const [index, background] of row.backgrounds.entries()) {
      if (typeof background !== "string") {
        throw new TypeError(`row.backgrounds[${index}] must be a string`);
      }
    }
  }

  return row;
}

function sourceProvenance({ config, row, source = {}, rowSha256 }) {
  return {
    benchmark: MEMORYARENA_BENCHMARK,
    dataset: MEMORYARENA_DATASET,
    config,
    split: "test",
    sourceUri:
      source.sourceUri ??
      `https://huggingface.co/datasets/${MEMORYARENA_DATASET}/resolve/${source.revision ?? "main"}/${config}/data.jsonl`,
    requestedRevision: source.revision ?? "main",
    sourceFile: source.sourceFile ?? MEMORYARENA_CONFIGS[config].fileName,
    sourceSha256: source.sourceSha256 ?? null,
    rowNumber: source.rowNumber ?? null,
    rowId: row.id,
    rowSha256: source.rawLineSha256 ?? rowSha256,
  };
}

function sessionProvenance(caseProvenance, sessionOrdinal, fieldPaths) {
  return {
    ...caseProvenance,
    kind: "benchmark-session",
    sessionOrdinal,
    eventOrdinal: 0,
    fieldPaths,
    sourceTimestamp: null,
  };
}

function publicInitialContext(row, config, caseProvenance) {
  if (config !== "group_travel_planner") return [];
  return [
    {
      contextId: "base-person",
      kind: "benchmark-background",
      content: cloneJson(row.base_person),
      provenance: {
        ...caseProvenance,
        kind: "benchmark-background",
        fieldPaths: ["base_person"],
        sessionOrdinal: 0,
        eventOrdinal: 0,
        sourceTimestamp: null,
      },
    },
  ];
}

function publicSession(row, config, index, caseKey, caseProvenance) {
  const sessionOrdinal = index + 1;
  const sessionId = `${caseKey}/session/${sessionOrdinal}`;
  const fieldPaths = [`questions[${index}]`];
  let background = null;
  if (config.startsWith("formal_reasoning_")) {
    background = row.backgrounds[index];
    fieldPaths.push(`backgrounds[${index}]`);
  }

  return {
    sessionId,
    sessionOrdinal,
    instruction: row.questions[index],
    background,
    initialContextRefs: config === "group_travel_planner" ? ["base-person"] : [],
    provenance: sessionProvenance(caseProvenance, sessionOrdinal, fieldPaths),
  };
}

function privateEvaluationMetadata(row, config) {
  if (config === "bundled_shopping") return { category: row.category };
  if (config.startsWith("formal_reasoning_")) return { paperName: row.paper_name };
  return {};
}

/**
 * Split one official row into an executor-safe online case and a judge-only
 * reference. The online object is deep-frozen and never contains answer keys.
 */
export function adaptMemoryArenaRow(row, { config, source = {} } = {}) {
  validateMemoryArenaRow(row, config);
  const definition = MEMORYARENA_CONFIGS[config];
  const rowSha256 = sha256Text(JSON.stringify(row));
  const caseKey = `memoryarena/${config}/test/${row.id}`;
  const provenance = sourceProvenance({ config, row, source, rowSha256 });

  const onlineCase = deepFreeze({
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    benchmark: MEMORYARENA_BENCHMARK,
    dataset: MEMORYARENA_DATASET,
    caseKey,
    config,
    split: "test",
    initialContext: publicInitialContext(row, config, provenance),
    sessions: row.questions.map((_, index) =>
      publicSession(row, config, index, caseKey, provenance),
    ),
    provenance,
  });

  assertNoGoldLeak(onlineCase);

  const referenceCase = deepFreeze({
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    benchmark: MEMORYARENA_BENCHMARK,
    dataset: MEMORYARENA_DATASET,
    caseKey,
    config,
    split: "test",
    successRule: definition.successRule,
    goldAnswers: cloneJson(row.answers),
    evaluationMetadata: privateEvaluationMetadata(row, config),
    provenance,
  });

  return { onlineCase, referenceCase };
}

export function assertNoGoldLeak(onlineCase) {
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_ONLINE_KEYS.has(normalizedKey(key))) {
        throw new Error(`Benchmark-private key leaked into online case at ${path}.${key}`);
      }
      walk(child, `${path}.${key}`);
    }
  };

  walk(onlineCase, "onlineCase");
  if (!Array.isArray(onlineCase.sessions) || onlineCase.sessions.length < 2) {
    throw new Error("Online case must contain ordered sessions");
  }
  for (const [index, session] of onlineCase.sessions.entries()) {
    if (!session.provenance || session.provenance.sessionOrdinal !== index + 1) {
      throw new Error(`Session ${index + 1} is missing ordered provenance`);
    }
  }
  return true;
}

export function containsForbiddenOnlineKey(value) {
  try {
    assertNoGoldLeak(value);
    return false;
  } catch (error) {
    if (String(error.message).includes("Benchmark-private key leaked")) return true;
    throw error;
  }
}
