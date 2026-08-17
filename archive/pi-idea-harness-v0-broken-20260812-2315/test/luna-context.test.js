import assert from "node:assert/strict";
import test from "node:test";

import {
  LunaContextError,
  buildLunaCandidates,
  buildLunaRequest,
  parseLunaSelection,
  renderLunaPacket,
} from "../src/luna-context.js";

function entry(id, role, content, timestamp) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp },
  };
}

test("Luna receives bounded source-ID candidates and preserves the main task verbatim", () => {
  const entries = [
    entry("e1", "user", "验证门控消融，而不是继续改工具。", 1_000),
    entry("e2", "assistant", [{ type: "text", text: "实验 A 表明去除门控后收益消失。" }], 2_000),
  ];
  const built = buildLunaCandidates(entries, { sessionId: "main" });
  assert.deepEqual(built.candidates.map((item) => item.candidateId), ["H001", "H002"]);
  assert.deepEqual(built.candidates[0].sourceRefs, ["pi-session:main:entry:e1"]);

  const task = "只判断门控机制是否通过消融验证；不要改 Harness。";
  const request = buildLunaRequest({
    task,
    trigger: "new_evidence",
    constraints: ["工程优化不能替代机制验证"],
    routeVersion: 3,
    p1Content: "当前等待消融结果。",
    candidates: built.candidates,
  });
  assert.equal(request.exactTask, task);
  const payload = JSON.parse(request.context.messages[0].content);
  assert.equal(payload.exact_task, task);
  assert.equal(payload.route_version, 3);
  assert.equal(request.context.tools.length, 0);
});

test("Luna selection is source-grounded and renders a derived packet", () => {
  const built = buildLunaCandidates([
    entry("e1", "user", "关键负面证据：基线也获得同样提升。", 1_000),
  ], { sessionId: "main" });
  const selection = parseLunaSelection(JSON.stringify({
    task_interpretation: "检查收益是否来自机制",
    selected: [{
      candidate_id: "H001",
      kind: "failure",
      summary: "基线获得同样提升，当前归因受到反证。",
      why: "这是判断机制是否成立的直接负面证据。",
    }],
    conflicts: [],
    excluded: [],
  }), built.candidates);
  assert.deepEqual(selection.selected[0].sourceRefs, ["pi-session:main:entry:e1"]);

  const packet = renderLunaPacket({
    id: "luna-test",
    routeVersion: 1,
    task: "判断机制是否成立",
    constraints: [],
    selection,
  });
  assert.match(packet, /可撤销派生上下文/);
  assert.match(packet, /pi-session:main:entry:e1/);
  assert.match(packet, /以 P0\/P1 为准/);
});

test("Luna harmlessly deduplicates repeated offered source IDs", () => {
  const built = buildLunaCandidates([
    entry("e1", "user", "同一条真实证据", 1_000),
  ], { sessionId: "main" });
  const selection = parseLunaSelection(JSON.stringify({
    selected: [
      { candidate_id: "H001", kind: "evidence", summary: "真实证据", why: "相关" },
      { candidate_id: "H001", kind: "evidence", summary: "重复证据", why: "重复" },
    ],
    conflicts: [],
    excluded: [],
  }), built.candidates);
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0].summary, "真实证据");
  assert.equal(selection.duplicateCount, 1);
});

test("Luna cannot cite a source ID that was not offered", () => {
  const built = buildLunaCandidates([
    entry("e1", "user", "真实历史", 1_000),
  ], { sessionId: "main" });
  assert.throws(
    () => parseLunaSelection(JSON.stringify({
      selected: [{ candidate_id: "H999", kind: "evidence", summary: "伪造", why: "伪造" }],
      conflicts: [],
      excluded: [],
    }), built.candidates),
    (error) => error instanceof LunaContextError && error.code === "LUNA_UNKNOWN_SOURCE",
  );
});
