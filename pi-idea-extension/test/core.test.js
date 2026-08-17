import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_TYPE,
  applyEvent,
  budgetFor,
  buildAnchor,
  confirmProposal,
  emptyState,
  extractIdeaCandidate,
  extractSkillCandidates,
  makeProposal,
  makeConfirmedStateFact,
  narrowStateText,
  replay,
  selectToolboxItem,
  toolBoundaryDecision,
} from "../src/core.js";

test("P0 is byte-for-byte at the beginning of every anchor", () => {
  const proposal = makeProposal("科学对象：测试\n终点：通过");
  const idea = confirmProposal(proposal);
  let state = applyEvent(emptyState(), { schema: 1, op: "idea-confirmed", idea });
  state = applyEvent(state, { schema: 1, op: "stage-set", stage: "当前阶段" });
  for (let index = 0; index < 10; index += 1) {
    const anchor = buildAnchor(state, "实现一个最小测试");
    assert.ok(anchor.content.startsWith(idea.content));
    assert.equal(state.idea.hash, idea.hash);
  }
});

test("unconfirmed proposal never changes authoritative idea", () => {
  const first = confirmProposal(makeProposal("原 Idea"));
  let state = applyEvent(emptyState(), { schema: 1, op: "idea-confirmed", idea: first });
  state = applyEvent(state, { schema: 1, op: "proposal-created", proposal: makeProposal("候选") });
  assert.equal(state.idea.content, "原 Idea");
  assert.equal(state.proposal.content, "候选");
});

test("confirmed Idea versions retain an immutable parent hash", () => {
  const first = confirmProposal(makeProposal("第一版"));
  const second = confirmProposal(makeProposal("第二版"), first);
  assert.equal(second.version, 2);
  assert.equal(second.parentHash, first.hash);
  assert.notEqual(second.hash, first.hash);
  assert.equal(first.content, "第一版");
});

test("confirmed narrow state is versioned, replaceable, and injected without summaries", () => {
  const idea = confirmProposal(makeProposal("研究总目标"));
  let state = applyEvent(emptyState(), { schema: 1, op: "idea-confirmed", idea });
  const first = makeConfirmedStateFact({ key: "authority", value: "CPU_STATIC_ONLY" });
  state = applyEvent(state, { schema: 1, op: "state-fact-set", fact: first });
  const second = makeConfirmedStateFact({ key: "authority", value: "CPU_AND_SOL_GATE", previous: first });
  state = applyEvent(state, { schema: 1, op: "state-fact-set", fact: second });
  assert.equal(second.version, 2);
  assert.equal(second.parentHash, first.hash);
  assert.equal(narrowStateText(state.narrowState), "authority=CPU_AND_SOL_GATE");
  const anchor = buildAnchor(state, "继续");
  assert.match(anchor.content, /<confirmed_narrow_state>/);
  assert.match(anchor.content, /authority=CPU_AND_SOL_GATE/);
  assert.doesNotMatch(anchor.content, /CPU_STATIC_ONLY/);

  state = applyEvent(state, { schema: 1, op: "state-fact-unset", key: "authority" });
  assert.equal(narrowStateText(state.narrowState), "");
  assert.doesNotMatch(buildAnchor(state, "继续").content, /confirmed_narrow_state/);
});

test("narrow state shares the trusted-state budget and is never silently truncated", () => {
  const fact = makeConfirmedStateFact({ key: "large", value: "约束".repeat(1800) });
  const budget = budgetFor({ idea: "目标", stage: "阶段", narrowState: [fact], contextWindow: 32_000 });
  assert.equal(budget.ok, false);
  assert.ok(budget.stateTokens > budget.stateLimit);
  assert.equal(fact.value.length, 3600);
});

test("replay restores pause and does not leak unrelated entries", () => {
  const idea = confirmProposal(makeProposal("A"));
  const entries = [
    { type: "custom", customType: "other", data: { schema: 1, op: "disabled" } },
    { type: "custom", customType: STATE_TYPE, data: { schema: 1, op: "idea-confirmed", idea } },
    { type: "custom", customType: STATE_TYPE, data: { schema: 1, op: "paused" } },
  ];
  const state = replay(entries);
  assert.equal(state.idea.content, "A");
  assert.equal(state.paused, true);
});

test("budget rejects oversized P0 without truncation", () => {
  const idea = "研".repeat(3000);
  const budget = budgetFor({ idea, contextWindow: 272000 });
  assert.equal(budget.ok, false);
  assert.equal(idea.length, 3000);
});

test("candidate markers are captured without enforcing a format", () => {
  const parsed = extractIdeaCandidate("[[IDEA_CANDIDATE]]自由格式内容[[/IDEA_CANDIDATE]]");
  assert.equal(parsed.candidate, "自由格式内容");
  assert.match(parsed.visible, /候选 Idea/);
});

test("skill candidate stays candidate and malformed output is ignored", () => {
  const valid = extractSkillCandidates('a[[SKILL_CANDIDATE]]{"lesson":"复用现有脚本","triggers":["测试"],"evidence":"T1 passed"}[[/SKILL_CANDIDATE]]b');
  assert.equal(valid.skills.length, 1);
  assert.equal(valid.skills[0].status, "candidate");
  assert.equal(valid.cleaned, "ab");
  assert.equal(extractSkillCandidates("[[SKILL_CANDIDATE]]bad[[/SKILL_CANDIDATE]]").skills.length, 0);
});

test("boundary gate blocks authoritative Idea writes only when Idea is active", () => {
  const active = toolBoundaryDecision({
    toolName: "edit", input: { path: "IDEA.md" }, cwd: "C:\\work", ideaEnabled: true,
  });
  assert.equal(active.action, "block");
  const ordinary = toolBoundaryDecision({
    toolName: "edit", input: { path: "IDEA.md" }, cwd: "C:\\work", ideaEnabled: false,
  });
  assert.equal(ordinary.action, "allow");
});

test("boundary gate permits in-scope work and asks once for an external root", () => {
  assert.equal(toolBoundaryDecision({
    toolName: "write", input: { path: "src/a.js" }, cwd: "C:\\work", ideaEnabled: true,
  }).action, "allow");
  const outside = toolBoundaryDecision({
    toolName: "write", input: { path: "C:\\other\\a.js" }, cwd: "C:\\work", ideaEnabled: true,
  });
  assert.equal(outside.action, "confirm");
  assert.equal(toolBoundaryDecision({
    toolName: "write",
    input: { path: "C:\\other\\b.js" },
    cwd: "C:\\work",
    ideaEnabled: true,
    approvedRoots: [outside.approvalRoot],
  }).action, "allow");
});

test("boundary gate confirms broad destructive commands and blocks shell Idea writes", () => {
  assert.equal(toolBoundaryDecision({
    toolName: "bash", input: { command: "Remove-Item -Recurse $HOME" }, cwd: "C:\\work",
  }).action, "confirm");
  assert.equal(toolBoundaryDecision({
    toolName: "bash", input: { command: "Set-Content IDEA.md x" }, cwd: "C:\\work", ideaEnabled: true,
  }).action, "block");
});

test("toolbox selects at most one relevant atom and does not appear otherwise", () => {
  assert.equal(selectToolboxItem("让便宜模型作为工作线程整理结果").id, "worker-handoff");
  assert.equal(selectToolboxItem("讨论这个假设是否合理"), null);

  const idea = confirmProposal(makeProposal("原始 Idea"));
  const state = applyEvent(emptyState(), { schema: 1, op: "idea-confirmed", idea });
  const anchor = buildAnchor(state, "整理新证据并汇总实验结果");
  assert.equal(anchor.selectedToolboxId, "evidence-brief");
  assert.equal((anchor.content.match(/<idea_toolbox/g) || []).length, 1);
});

test("user-edited Todos enter the next anchor while the detective board does not", () => {
  const idea = confirmProposal(makeProposal("长期研究目标"));
  let state = applyEvent(emptyState(), { schema: 1, op: "idea-confirmed", idea, ideaId: "idea-1" });
  state = applyEvent(state, {
    schema: 1,
    op: "workspace-bound",
    ideaId: "idea-1",
    conversationKind: "main",
    workspaces: [{ workspace: "D:/research", isDefault: true }],
    todos: [{ todoId: "todo-1", text: "先做最小验证", status: "pending", pendingModelReview: true }],
    workflows: [{ runId: "worker-secret", label: "不应注入的侦探白板线程", status: "running" }],
  });
  const anchor = buildAnchor(state, "继续");
  assert.ok(anchor.content.startsWith(idea.content));
  assert.match(anchor.content, /<working_todos/);
  assert.match(anchor.content, /先做最小验证/);
  assert.match(anchor.content, /kind="main"/);
  assert.doesNotMatch(anchor.content, /detective|白板|节点位置|board/i);
  assert.doesNotMatch(anchor.content, /worker-secret|侦探白板线程/i);
});

test("BTW conversations are explicitly non-authoritative in the anchor", () => {
  const idea = confirmProposal(makeProposal("长期研究目标"));
  let state = applyEvent(emptyState(), { schema: 1, op: "idea-confirmed", idea });
  state = applyEvent(state, { schema: 1, op: "workspace-bound", ideaId: "idea-1", conversationKind: "btw", idea });
  const anchor = buildAnchor(state, "讨论另一个可能性");
  assert.match(anchor.content, /kind="btw"/);
  assert.match(anchor.content, /不得接管主路线/);
});
