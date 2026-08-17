import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const FORBIDDEN_SELECTOR_KEYS = new Set([
  "answer",
  "answer_session_ids",
  "has_answer",
  "question_id",
  "autoeval_label",
]);

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function sanitizeTurn(turn) {
  const role = turn?.role === "assistant" ? "assistant" : "user";
  return { role, content: String(turn?.content || "") };
}

function walkKeys(value, visitor) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visitor(key, child);
    walkKeys(child, visitor);
  }
}

export async function loadLongMemEval(path) {
  const raw = await readFile(path);
  const rows = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("LongMemEval data must be a non-empty JSON array");
  return { rows, sha256: hash(raw), bytes: raw.length };
}

/**
 * Split the public selector view from private scoring labels. The selector
 * never receives the original question id, answer, answer-session ids or
 * turn-level has_answer annotations.
 */
export function splitLongMemEval(rows, { blindSalt = "pi-idea-longmemeval-v1" } = {}) {
  const publicCases = [];
  const references = new Map();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const sessionIds = Array.isArray(row.haystack_session_ids) ? row.haystack_session_ids.map(String) : [];
    const sessions = Array.isArray(row.haystack_sessions) ? row.haystack_sessions : [];
    const dates = Array.isArray(row.haystack_dates) ? row.haystack_dates : [];
    if (sessions.length !== sessionIds.length || dates.length !== sessionIds.length) {
      throw new Error(`Malformed LongMemEval row ${rowIndex}: session arrays differ in length`);
    }
    const blindIds = new Map(sessionIds.map((id) => [id, `s_${hash(`${blindSalt}\0${id}`).slice(0, 16)}`]));
    const selectorSessions = sessions.map((turns, index) => ({
      id: blindIds.get(sessionIds[index]),
      date: String(dates[index] || ""),
      turns: (Array.isArray(turns) ? turns : []).map(sanitizeTurn),
    }));
    const caseKey = `q_${hash(`${blindSalt}\0${row.question_id}\0${rowIndex}`).slice(0, 20)}`;
    const selectorView = freeze({
      question: String(row.question || ""),
      questionDate: String(row.question_date || ""),
      sessions: selectorSessions,
    });
    const reference = freeze({
      questionId: String(row.question_id || ""),
      questionType: String(row.question_type || "unknown"),
      abstention: String(row.question_id || "").endsWith("_abs"),
      answer: String(row.answer || ""),
      evidenceSessionIds: (Array.isArray(row.answer_session_ids) ? row.answer_session_ids : [])
        .map(String).map((id) => blindIds.get(id)).filter(Boolean),
      rawEvidenceSessionIds: (Array.isArray(row.answer_session_ids) ? row.answer_session_ids : []).map(String),
    });
    assertNoLabelLeak(selectorView, reference);
    publicCases.push(freeze({ caseKey, questionType: reference.questionType, abstention: reference.abstention, selectorView }));
    references.set(caseKey, reference);
  }
  return { publicCases, references };
}

export function assertNoLabelLeak(selectorView, reference = null) {
  const found = [];
  walkKeys(selectorView, (key) => {
    if (FORBIDDEN_SELECTOR_KEYS.has(key)) found.push(key);
  });
  if (found.length) throw new Error(`Selector label leak: ${[...new Set(found)].join(", ")}`);
  const serialized = JSON.stringify(selectorView);
  for (const rawId of reference?.rawEvidenceSessionIds || []) {
    if (rawId && serialized.includes(rawId)) throw new Error(`Selector leaked answer session id: ${rawId}`);
  }
  return true;
}

export function selectorViewToPiMessages(selectorView) {
  return selectorView.sessions.flatMap((session) => session.turns.map((turn, index) => ({
    role: turn.role,
    // Repeat temporal provenance on every raw message. A fold boundary may
    // split a long session, so attaching it only to the first turn silently
    // removes the date from later evidence passages.
    content: `[memory_session id=${session.id} date=${session.date} turn=${index}]\n${turn.content}`,
  })));
}

export function stratifiedSample(publicCases, count, { seed = "pi-idea-public-pilot-v1" } = {}) {
  if (!Number.isFinite(count) || count <= 0 || count >= publicCases.length) return [...publicCases];
  const groups = new Map();
  for (const item of publicCases) {
    const stratum = `${item.questionType}:${item.abstention ? "abs" : "answerable"}`;
    const group = groups.get(stratum) || [];
    group.push(item);
    groups.set(stratum, group);
  }
  for (const group of groups.values()) group.sort((a, b) => hash(`${seed}\0${a.caseKey}`).localeCompare(hash(`${seed}\0${b.caseKey}`)));
  const selected = [];
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  while (selected.length < count) {
    let progressed = false;
    for (const [, group] of orderedGroups) {
      if (!group.length || selected.length >= count) continue;
      selected.push(group.shift());
      progressed = true;
    }
    if (!progressed) break;
  }
  return selected;
}

export function datasetProfile(publicCases) {
  const sessionCounts = publicCases.map((item) => item.selectorView.sessions.length).sort((a, b) => a - b);
  const medianSessions = sessionCounts[Math.floor(sessionCounts.length / 2)] || 0;
  return {
    questions: publicCases.length,
    minSessions: sessionCounts[0] || 0,
    medianSessions,
    maxSessions: sessionCounts.at(-1) || 0,
    likelyOracleOnly: medianSessions < 10,
  };
}
