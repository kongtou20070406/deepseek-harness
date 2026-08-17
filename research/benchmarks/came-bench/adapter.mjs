import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

function parseJsonLines(text, source) {
  return String(text).split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL at ${source}:${index + 1}: ${error.message}`); }
  });
}

function parseAnswer(answer) {
  const raw = answer?.free_form_answer ?? answer?.freeFormAnswer ?? null;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Keep official labels physically separate from the selector view. */
export function splitCameQuestion(question, turns) {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const visibleTurns = (question.question_turn_ids || []).map((id) => {
    const turn = byId.get(id);
    if (!turn) throw new Error(`Question ${question.id} references missing turn ${id}`);
    return {
      id: String(turn.id),
      role: String(turn.role || "unknown"),
      content: String(turn.content || ""),
      timestampMapping: turn.timestamp_mapping && typeof turn.timestamp_mapping === "object"
        ? { ...turn.timestamp_mapping }
        : {},
    };
  });
  const selectorView = {
    caseKey: String(question.id),
    question: String(question.content || ""),
    questionDate: String(question.date || ""),
    questionType: String(question.type || "unknown"),
    answerType: String(question.answer_type || "unknown"),
    turns: visibleTurns,
  };
  const reference = {
    caseKey: String(question.id),
    answer: parseAnswer(question.answer),
    answerTurnIds: [...(question.answer_turn_ids || [])].map(String),
    // Gold structural fields remain available only for post-hoc diagnostics.
    turnDiagnostics: Object.fromEntries(visibleTurns.map(({ id }) => {
      const turn = byId.get(id);
      return [id, {
        partition: Array.isArray(turn.partition) ? [...turn.partition] : [],
        action: turn.action || null,
        actionObject: turn.action_object || null,
      }];
    })),
  };
  assertNoCameLabelLeak(selectorView);
  return { selectorView, reference };
}

export function assertNoCameLabelLeak(selectorView) {
  const forbidden = new Set(["answer", "answer_turn_ids", "answerTurnIds", "partition", "action", "action_object", "actionObject"]);
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw new Error(`CAME-Bench label leaked into selector view: ${key}`);
      walk(child);
    }
  };
  walk(selectorView);
  return true;
}

export function cameSelectorToPiMessages(selectorView) {
  return selectorView.turns.map((turn) => {
    const timestamps = Object.entries(turn.timestampMapping || {})
      .map(([scope, time]) => `${scope}=${JSON.stringify(time)}`).join(" ");
    return {
      // Each event is a separate immutable trajectory step. The original actor
      // is retained in the header; using user here avoids accidental merging of
      // consecutive non-chat actors by the ordinary Pi turn grouper.
      role: "user",
      content: `[came_turn id=${turn.id} actor=${JSON.stringify(turn.role)}${timestamps ? ` ${timestamps}` : ""}]\n${turn.content}`,
    };
  });
}

export async function loadDecodedCameBench(root) {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^traj-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  if (!names.length) throw new Error(`No decoded CAME-Bench traj-* directories found at ${root}`);
  const cases = [];
  const digest = createHash("sha256");
  for (const name of names) {
    const turnPath = join(root, name, "turns.jsonl");
    const questionPath = join(root, name, "questions.jsonl");
    const [turnText, questionText] = await Promise.all([readFile(turnPath, "utf8"), readFile(questionPath, "utf8")]);
    digest.update(name).update("\0").update(turnText).update("\0").update(questionText).update("\0");
    const turns = parseJsonLines(turnText, turnPath);
    for (const question of parseJsonLines(questionText, questionPath)) {
      cases.push({ trajectory: name, ...splitCameQuestion(question, turns) });
    }
  }
  return { cases, trajectories: names.length, sha256: `sha256:${digest.digest("hex")}` };
}
