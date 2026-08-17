import assert from "node:assert/strict";
import test from "node:test";

import {
  IdeaDocumentError,
  buildCandidate,
  formatLineDiff,
  normalizeIdeaDocument,
  validateCandidateAgainstBase,
} from "../src/idea-document.js";

test("P0 accepts arbitrary non-empty natural language without reserved markers", () => {
  const content = "我想完成一个科研辅助 Harness。\r\n科学对象：也可以只是正文中的普通文字。\n  核心机制：不再是必填标题。";
  assert.equal(normalizeIdeaDocument(content), content);
});

test("P0 rejects only non-text or empty input", () => {
  assert.throws(() => normalizeIdeaDocument("  \n\t"), IdeaDocumentError);
  assert.throws(() => normalizeIdeaDocument(null), IdeaDocumentError);
});

test("full-text candidates are validated without parsing their structure", () => {
  const base = "研究一个新的算子，并验证它是否改善局部结构表示。";
  const candidate = "研究一个新的算子。\n\n成功标准：改善局部结构表示，并得到可复现实验。";
  const built = buildCandidate(base, candidate);
  assert.equal(built.candidate, candidate);
  assert.deepEqual(built.changedFields, ["content"]);
  assert.throws(() => validateCandidateAgainstBase(base, base), /完全相同/);
});

test("line diff exposes exact additions and removals for free-form P0", () => {
  const before = "目标不变\n当前路线 A";
  const after = "目标不变\n当前路线 B";
  const diff = formatLineDiff(before, after);
  assert.match(diff, /- 当前路线 A/);
  assert.match(diff, /\+ 当前路线 B/);
});
