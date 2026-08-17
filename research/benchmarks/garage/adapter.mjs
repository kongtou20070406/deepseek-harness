import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const GARAGE_BENCHMARK = "GaRAGe";
export const GARAGE_ADAPTER_SCHEMA_VERSION = 1;

export const GARAGE_OFFICIAL_DATA = Object.freeze({
  fileName: "GaRAGe_benchmark.jsonl",
  rows: 2_366,
  passages: 35_351,
  bytes: 28_426_483,
  sha256: "419e3941f6e8eb4082a74ca2140c1f9337f8b467ff76656a6b8b0290ca3f3a72",
  license: "CC-BY-NC-4.0",
});

const TOP_LEVEL_KEYS = new Set([
  "sample_id",
  "question_date",
  "grounding",
  "question",
  "question_valid",
  "question_false_premise",
  "question_seeking",
  "question_sensitive",
  "question_type",
  "question_complexity",
  "question_category",
  "question_popularity",
  "evidence_relevant",
  "evidence_correct",
  "answer_generate",
  "answer_related_info",
  "answer_validate",
  "comments",
  "evidence_cited",
  "question_tag",
  "topic_tag",
]);

const SELECTOR_KEYS = new Set([
  "schemaVersion",
  "benchmark",
  "caseKey",
  "question",
  "questionDate",
  "passages",
]);
const SELECTOR_PASSAGE_KEYS = new Set(["passageId", "text", "provenance"]);
const SELECTOR_PROVENANCE_KEYS = new Set([
  "provider",
  "sourceDate",
  "sourceAge",
  "citationId",
  "citationOrdinal",
  "questionDate",
]);

const DOMAINS = Object.freeze({
  yesNo: new Set(["YES", "NO"]),
  questionType: new Set(["", "FAST-CHANGING", "SLOW-CHANGING"]),
  questionComplexity: new Set([
    "Simple",
    "Simple w. condition",
    "Set",
    "Comparison",
    "Aggregation",
    "Multi-hop",
    "Post-processing heavy",
  ]),
  questionPopularity: new Set(["Head", "Torso", "Tail"]),
  evidenceRelevant: new Set(["", "YES", "NO"]),
  evidenceCorrect: new Set([
    "",
    "UNKNOWN",
    "ANSWER-THE-QUESTION",
    "RELATED-INFORMATION",
    "OUTDATED",
  ]),
  evidenceCited: new Set(["YES", "NO"]),
  answerValidate: new Set(["", "YES"]),
  questionTag: new Set(["web", "arxiv", "sec", "devops", "enron"]),
  topicTag: new Set(["web", "arxiv", "sec", "devops", "enron"]),
  provider: new Set(["web", "ent"]),
});

// All fields below are annotator outputs or post-hoc benchmark strata. The
// online selector is deliberately constrained to a closed allow-list as well,
// so renaming a gold field cannot accidentally bypass this recursive check.
const FORBIDDEN_ONLINE_KEYS = new Set([
  "sampleid",
  "questionvalid",
  "questionfalsepremise",
  "questionseeking",
  "questionsensitive",
  "questiontype",
  "questioncomplexity",
  "questioncategory",
  "questionpopularity",
  "evidencerelevant",
  "evidencecorrect",
  "evidencecited",
  "answergenerate",
  "answerrelatedinfo",
  "answervalidate",
  "comments",
  "questiontag",
  "topictag",
  "gold",
  "answer",
  "reference",
  "correct",
  "relevant",
  "cited",
  "eligibility",
  "eligibilitylabels",
]);

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expected.has(key)) throw new Error(`${label} has unsupported field ${JSON.stringify(key)}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing field ${JSON.stringify(key)}`);
  }
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function assertDomain(value, domain, label) {
  if (!domain.has(value)) {
    throw new Error(`${label} has unsupported value ${JSON.stringify(value)}`);
  }
}

function assertStringArray(value, domain, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new TypeError(`${label} must align one-to-one with grounding (${expectedLength} items)`);
  }
  value.forEach((item, index) => {
    if (typeof item !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    assertDomain(item, domain, `${label}[${index}]`);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseJsonLines(text, source) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${source}:${index + 1}: ${error.message}`);
      }
    });
}

/** Validate one official GaRAGe row and reject unknown fields. */
export function validateGarageRow(row, { source = "GaRAGe row" } = {}) {
  assertExactKeys(row, TOP_LEVEL_KEYS, source);
  assertString(row.sample_id, `${source}.sample_id`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.sample_id)) {
    throw new Error(`${source}.sample_id must be a UUID`);
  }
  assertString(row.question_date, `${source}.question_date`);
  assertString(row.question, `${source}.question`);
  if (!Array.isArray(row.grounding) || row.grounding.length === 0) {
    throw new TypeError(`${source}.grounding must be a non-empty array`);
  }

  row.grounding.forEach((passage, index) => {
    const label = `${source}.grounding[${index}]`;
    assertPlainObject(passage, label);
    const citationId = `cite_${index + 1}`;
    const expected = new Set(["age", "date", "provider", citationId]);
    assertExactKeys(passage, expected, label);
    assertString(passage.age, `${label}.age`);
    assertString(passage.date, `${label}.date`);
    assertString(passage.provider, `${label}.provider`);
    assertDomain(passage.provider, DOMAINS.provider, `${label}.provider`);
    assertString(passage[citationId], `${label}.${citationId}`);
  });

  assertDomain(row.question_valid, new Set(["YES"]), `${source}.question_valid`);
  assertDomain(row.question_false_premise, new Set(["NO"]), `${source}.question_false_premise`);
  assertDomain(row.question_seeking, new Set(["YES"]), `${source}.question_seeking`);
  assertDomain(row.question_sensitive, DOMAINS.yesNo, `${source}.question_sensitive`);
  assertDomain(row.question_type, DOMAINS.questionType, `${source}.question_type`);
  if ((row.question_sensitive === "YES") !== (row.question_type !== "")) {
    throw new Error(`${source}.question_type must be present exactly when question_sensitive is YES`);
  }
  assertDomain(row.question_complexity, DOMAINS.questionComplexity, `${source}.question_complexity`);
  assertString(row.question_category, `${source}.question_category`);
  assertDomain(row.question_popularity, DOMAINS.questionPopularity, `${source}.question_popularity`);

  const passageCount = row.grounding.length;
  assertStringArray(row.evidence_relevant, DOMAINS.evidenceRelevant, passageCount, `${source}.evidence_relevant`);
  assertStringArray(row.evidence_correct, DOMAINS.evidenceCorrect, passageCount, `${source}.evidence_correct`);
  assertStringArray(row.evidence_cited, DOMAINS.evidenceCited, passageCount, `${source}.evidence_cited`);

  assertString(row.answer_generate, `${source}.answer_generate`, { allowEmpty: true });
  assertString(row.answer_related_info, `${source}.answer_related_info`, { allowEmpty: true });
  assertDomain(row.answer_validate, DOMAINS.answerValidate, `${source}.answer_validate`);
  assertString(row.comments, `${source}.comments`, { allowEmpty: true });
  assertDomain(row.question_tag, DOMAINS.questionTag, `${source}.question_tag`);
  assertDomain(row.topic_tag, DOMAINS.topicTag, `${source}.topic_tag`);
  return true;
}

/**
 * These labels are for post-hoc stratification only. In particular,
 * question_sensitive is an annotation, not an online hint.
 */
export function deriveGarageEligibilityLabels(row) {
  validateGarageRow(row);
  const correctness = new Set(row.evidence_correct);
  const providers = new Set(row.grounding.map((passage) => passage.provider));
  const hasAnswer = correctness.has("ANSWER-THE-QUESTION");
  const hasRelevant = row.evidence_relevant.includes("YES");
  return Object.freeze([
    hasAnswer
      ? "answerable-grounding"
      : hasRelevant
        ? "relevant-only-grounding"
        : "insufficient-grounding",
    row.answer_validate === "YES" ? "answer-validated" : "answer-unvalidated",
    row.question_sensitive === "YES" ? "time-sensitive" : "not-time-sensitive",
    correctness.has("OUTDATED") ? "contains-outdated" : "no-outdated",
    providers.size > 1 ? "mixed-provider" : "single-provider",
  ]);
}

function selectorCaseKey(sampleId) {
  return `garage:${sha256(`garage-selector-v1\0${sampleId}`).slice(0, 20)}`;
}

/** Keep all judge fields physically separate from the online selector view. */
export function splitGarageRow(row) {
  validateGarageRow(row);
  const caseKey = selectorCaseKey(row.sample_id);
  const selectorView = deepFreeze({
    schemaVersion: GARAGE_ADAPTER_SCHEMA_VERSION,
    benchmark: GARAGE_BENCHMARK,
    caseKey,
    question: row.question,
    questionDate: row.question_date,
    passages: row.grounding.map((passage, index) => {
      const citationOrdinal = index + 1;
      const citationId = `cite_${citationOrdinal}`;
      return {
        passageId: `${caseKey}/${citationId}`,
        text: passage[citationId],
        provenance: {
          provider: passage.provider,
          sourceDate: passage.date,
          sourceAge: passage.age,
          citationId,
          citationOrdinal,
          questionDate: row.question_date,
        },
      };
    }),
  });

  const reference = deepFreeze({
    caseKey,
    officialId: row.sample_id,
    questionAnnotations: {
      valid: row.question_valid,
      falsePremise: row.question_false_premise,
      seeking: row.question_seeking,
      sensitive: row.question_sensitive,
      changeType: row.question_type,
      complexity: row.question_complexity,
      category: row.question_category,
      popularity: row.question_popularity,
      questionTag: row.question_tag,
      topicTag: row.topic_tag,
    },
    passageJudgments: row.grounding.map((_, index) => ({
      citationId: `cite_${index + 1}`,
      relevant: row.evidence_relevant[index],
      correct: row.evidence_correct[index],
      cited: row.evidence_cited[index],
    })),
    answer: {
      generated: row.answer_generate,
      relatedInfo: row.answer_related_info,
      validated: row.answer_validate,
      comments: row.comments,
    },
    eligibilityLabels: deriveGarageEligibilityLabels(row),
  });

  assertNoGarageGoldLeak(selectorView);
  return { selectorView, reference };
}

/** Recursively reject evaluation labels, then enforce a closed online schema. */
export function assertNoGarageGoldLeak(selectorView) {
  const walk = (value, path = "selectorView") => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_ONLINE_KEYS.has(normalizedKey(key))) {
        throw new Error(`GaRAGe gold/judge field leaked into online view at ${path}.${key}`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(selectorView);

  assertExactKeys(selectorView, SELECTOR_KEYS, "selectorView");
  if (selectorView.schemaVersion !== GARAGE_ADAPTER_SCHEMA_VERSION) {
    throw new Error(`selectorView.schemaVersion must be ${GARAGE_ADAPTER_SCHEMA_VERSION}`);
  }
  if (selectorView.benchmark !== GARAGE_BENCHMARK) {
    throw new Error(`selectorView.benchmark must be ${GARAGE_BENCHMARK}`);
  }
  assertString(selectorView.caseKey, "selectorView.caseKey");
  assertString(selectorView.question, "selectorView.question");
  assertString(selectorView.questionDate, "selectorView.questionDate");
  if (!Array.isArray(selectorView.passages) || selectorView.passages.length === 0) {
    throw new TypeError("selectorView.passages must be a non-empty array");
  }
  selectorView.passages.forEach((passage, index) => {
    const label = `selectorView.passages[${index}]`;
    assertExactKeys(passage, SELECTOR_PASSAGE_KEYS, label);
    assertString(passage.passageId, `${label}.passageId`);
    assertString(passage.text, `${label}.text`);
    assertExactKeys(passage.provenance, SELECTOR_PROVENANCE_KEYS, `${label}.provenance`);
    assertDomain(passage.provenance.provider, DOMAINS.provider, `${label}.provenance.provider`);
    assertString(passage.provenance.sourceDate, `${label}.provenance.sourceDate`);
    assertString(passage.provenance.sourceAge, `${label}.provenance.sourceAge`);
    const ordinal = index + 1;
    if (passage.provenance.citationId !== `cite_${ordinal}`) {
      throw new Error(`${label}.provenance.citationId is not aligned with passage order`);
    }
    if (passage.provenance.citationOrdinal !== ordinal) {
      throw new Error(`${label}.provenance.citationOrdinal is not aligned with passage order`);
    }
    if (passage.provenance.questionDate !== selectorView.questionDate) {
      throw new Error(`${label}.provenance.questionDate must preserve the case question date`);
    }
  });
  return true;
}

export function assertGarageOfficialFingerprint(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("GaRAGe bytes must be a Uint8Array");
  if (bytes.byteLength !== GARAGE_OFFICIAL_DATA.bytes) {
    throw new Error(`GaRAGe byte-size mismatch: expected ${GARAGE_OFFICIAL_DATA.bytes}, received ${bytes.byteLength}`);
  }
  const actual = sha256(bytes);
  if (actual !== GARAGE_OFFICIAL_DATA.sha256) {
    throw new Error(`GaRAGe SHA-256 mismatch: expected ${GARAGE_OFFICIAL_DATA.sha256}, received ${actual}`);
  }
  return actual;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function buildStats(rows) {
  const passageCounts = [];
  const providers = new Map();
  const complexities = new Map();
  const categories = new Map();
  const popularity = new Map();
  const changeTypes = new Map();
  const questionTags = new Map();
  const topicTags = new Map();
  const eligibilityLabels = new Map();
  const evidenceRelevant = new Map();
  const evidenceCorrect = new Map();
  const evidenceCited = new Map();

  for (const row of rows) {
    passageCounts.push(row.grounding.length);
    increment(complexities, row.question_complexity);
    increment(categories, row.question_category);
    increment(popularity, row.question_popularity);
    increment(changeTypes, row.question_type || "NOT-TIME-SENSITIVE");
    increment(questionTags, row.question_tag);
    increment(topicTags, row.topic_tag);
    for (const label of deriveGarageEligibilityLabels(row)) increment(eligibilityLabels, label);
    for (const passage of row.grounding) increment(providers, passage.provider);
    for (const label of row.evidence_relevant) increment(evidenceRelevant, label || "EMPTY");
    for (const label of row.evidence_correct) increment(evidenceCorrect, label || "EMPTY");
    for (const label of row.evidence_cited) increment(evidenceCited, label);
  }

  const passages = passageCounts.reduce((total, count) => total + count, 0);
  return deepFreeze({
    questions: rows.length,
    passages,
    passagesPerQuestion: {
      min: Math.min(...passageCounts),
      max: Math.max(...passageCounts),
      mean: passages / rows.length,
    },
    providers: sortedCounts(providers),
    categories: {
      complexity: sortedCounts(complexities),
      domainRaw: sortedCounts(categories),
      popularity: sortedCounts(popularity),
      changeType: sortedCounts(changeTypes),
      questionTag: sortedCounts(questionTags),
      topicTag: sortedCounts(topicTags),
    },
    eligibilityLabels: sortedCounts(eligibilityLabels),
    evidenceLabels: {
      relevant: sortedCounts(evidenceRelevant),
      correct: sortedCounts(evidenceCorrect),
      cited: sortedCounts(evidenceCited),
    },
  });
}

/** Load only the pinned official release; fixtures should use validateGarageRow. */
export async function loadGarageBench(rootOrFile) {
  const filePath = extname(rootOrFile).toLowerCase() === ".jsonl"
    ? rootOrFile
    : join(rootOrFile, "data", GARAGE_OFFICIAL_DATA.fileName);
  const bytes = await readFile(filePath);
  const actualSha256 = assertGarageOfficialFingerprint(bytes);
  const rows = parseJsonLines(bytes.toString("utf8"), filePath);
  if (rows.length !== GARAGE_OFFICIAL_DATA.rows) {
    throw new Error(`GaRAGe row-count mismatch: expected ${GARAGE_OFFICIAL_DATA.rows}, received ${rows.length}`);
  }

  const ids = new Set();
  rows.forEach((row, index) => {
    validateGarageRow(row, { source: `${filePath}:${index + 1}` });
    if (ids.has(row.sample_id)) throw new Error(`Duplicate GaRAGe sample_id at ${filePath}:${index + 1}`);
    ids.add(row.sample_id);
  });
  const stats = buildStats(rows);
  if (stats.passages !== GARAGE_OFFICIAL_DATA.passages) {
    throw new Error(`GaRAGe passage-count mismatch: expected ${GARAGE_OFFICIAL_DATA.passages}, received ${stats.passages}`);
  }

  const cases = rows.map((row) => splitGarageRow(row));
  return deepFreeze({
    benchmark: GARAGE_BENCHMARK,
    adapterSchemaVersion: GARAGE_ADAPTER_SCHEMA_VERSION,
    sourceFile: filePath,
    sourceBytes: bytes.byteLength,
    sourceSha256: `sha256:${actualSha256}`,
    cases,
    stats,
  });
}
