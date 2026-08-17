import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkingStatePatch,
  decideControlAction,
  emptyWorkingState,
  makeAuthorityLayer,
  splitLegacyIdea,
  workingStateText,
} from "../src/research-state.js";
import { applyEvent, buildAnchor, confirmProposal, emptyState, makeProposal } from "../src/core.js";

test("legacy P0 is split without summarizing or rewriting either side", () => {
  const source = "科学对象：\n解决长期漂移\n\n终点标准：\n跨周稳定\n\n当前路线 v1：\n基于 Pi 扩展\n先做 CLI";
  const migrated = splitLegacyIdea(source);
  assert.equal(migrated.status, "deterministic-split");
  assert.equal(migrated.kernelContent, "科学对象：\n解决长期漂移\n\n终点标准：\n跨周稳定");
  assert.equal(migrated.frameContent, "基于 Pi 扩展\n先做 CLI");
  assert.equal(`${migrated.kernelContent}\n${migrated.frameContent}`.includes("跨周稳定"), true);
});

test("unstructured legacy Idea remains intact instead of guessing a frame", () => {
  const migrated = splitLegacyIdea("一个没有固定标题的自由格式 Idea");
  assert.equal(migrated.status, "needs-user-frame");
  assert.equal(migrated.kernelContent, migrated.legacyContent);
  assert.equal(migrated.frameContent, "");
});

test("model fills Working State but cannot decide phase or acceptance", () => {
  const initial = emptyWorkingState();
  const next = applyWorkingStatePatch(initial, {
    activeHypothesis: "索引噪声导致漂移",
    nextAction: "运行固定回放",
    stopProposal: "若两次回放无差异，建议停止该任务",
  }, { actor: "model" });
  assert.equal(next.phase, "discuss");
  assert.equal(next.revision, 1);
  assert.match(workingStateText(next), /运行固定回放/);
  assert.throws(() => applyWorkingStatePatch(next, { phase: "complete" }, { actor: "model" }), /cannot update/);
  const completed = applyWorkingStatePatch(next, { phase: "complete", acceptanceStatus: "passed" }, { actor: "harness" });
  assert.equal(completed.phase, "complete");
});

test("fast controller continues on executable work but never trusts a model stop proposal", () => {
  const running = applyWorkingStatePatch(emptyWorkingState(), { nextAction: "run the bounded probe" }, { actor: "model" });
  assert.deepEqual(decideControlAction(running), { action: "continue", reason: "executable-next-action" });
  const proposed = applyWorkingStatePatch(running, { stopProposal: "the probe appears sufficient" }, { actor: "model" });
  assert.deepEqual(decideControlAction(proposed), { action: "verify-stop", reason: "model-stop-proposal" });
});

test("anchor begins with the small Idea Kernel and labels frame and work as lower authority", () => {
  const legacy = confirmProposal(makeProposal("旧的完整 P0"));
  let state = applyEvent(emptyState(), {
    schema: 1,
    op: "idea-confirmed",
    idea: legacy,
    ideaKernel: makeAuthorityLayer("只保留科学对象和成功条件"),
    researchFrame: makeAuthorityLayer("允许在 A/B 两条路线间自主选择"),
  });
  state = applyEvent(state, {
    schema: 1,
    op: "working-state-updated",
    workingState: applyWorkingStatePatch(state.workingState, { nextAction: "先验证 A" }, { actor: "model" }),
  });
  const anchor = buildAnchor(state, "继续");
  assert.ok(anchor.content.startsWith("只保留科学对象和成功条件"));
  assert.match(anchor.content, /<research_frame authority="user-confirmed"/);
  assert.match(anchor.content, /<working_state authority="model-fillable-not-decisive"/);
  assert.doesNotMatch(anchor.content, /^旧的完整 P0/);
});
