import { createHash } from "node:crypto";

export class IdeaDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdeaDocumentError";
  }
}

export function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * P0 is deliberately free-form. The Harness validates only that it is
 * non-empty, then preserves the user's confirmed bytes exactly.
 */
export function normalizeIdeaDocument(content) {
  if (typeof content !== "string") throw new IdeaDocumentError("P0 必须是文本");
  if (!content.trim()) throw new IdeaDocumentError("P0 不能为空");
  return content;
}

/**
 * Convenience renderer for examples/tests. These headings are presentation,
 * never parser requirements; users may use any wording or structure.
 */
export function renderIdeaDocument({
  scientificObject,
  endCriteria,
  routeMechanism,
  routeBoundary,
}) {
  const sections = [
    ["科学对象", scientificObject],
    ["达成标准", endCriteria],
    ["当前路线", routeMechanism],
    ["路线边界", routeBoundary],
  ].filter(([, value]) => typeof value === "string" && value.trim());
  return normalizeIdeaDocument(sections.map(([title, value]) => `${title}\n${value}`).join("\n\n"));
}

export function renderIdeaTemplate() {
  return [
    "直接写下你的想法即可，不要求标题、字段、缩进或固定格式。",
    "AI 会整理成简洁候选；只有你确认后的文本才会成为逐字冻结的 P0。",
  ].join("\n");
}

export function changedIdeaFields(beforeContent, afterContent) {
  return normalizeIdeaDocument(beforeContent) === normalizeIdeaDocument(afterContent) ? [] : ["content"];
}

export function validateCandidateAgainstBase(baseContent, candidateContent) {
  const base = normalizeIdeaDocument(baseContent);
  const candidate = normalizeIdeaDocument(candidateContent);
  const changedFields = changedIdeaFields(base, candidate);
  if (changedFields.length === 0) {
    throw new IdeaDocumentError("提案与当前 Idea 完全相同");
  }
  return { candidate, changedFields };
}

export function buildCandidate(baseContent, candidateContent) {
  return validateCandidateAgainstBase(baseContent, candidateContent);
}

export function formatLineDiff(beforeContent, afterContent) {
  const before = beforeContent.replace(/\n$/, "").split("\n");
  const after = afterContent.replace(/\n$/, "").split("\n");
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = Array.from({ length: rows }, () => new Uint32Array(columns));

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = before[i] === after[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const output = ["--- 当前 IDEA.md", "+++ 候选 IDEA.md"];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      output.push(`  ${before[i]}`);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      output.push(`- ${before[i]}`);
      i += 1;
    } else {
      output.push(`+ ${after[j]}`);
      j += 1;
    }
  }
  while (i < before.length) output.push(`- ${before[i++]}`);
  while (j < after.length) output.push(`+ ${after[j++]}`);
  return output.join("\n");
}
