import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowRunRegistry,
  contextGauge,
  observedSessionUsage,
  relativeAge,
  researchFooterLine,
} from "../src/research-console-ui.js";

const plainTheme = { fg: (_color, text) => text };

test("research console exposes honest local usage and runtime state", () => {
  const usage = observedSessionUsage([
    { type: "message", message: { usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 5, cost: { total: 0.01 } } } },
    { type: "message", message: { usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } },
  ]);
  assert.deepEqual(usage, { input: 150, output: 30, cacheRead: 40, cacheWrite: 5, cost: 0.03, total: 225 });
  assert.match(contextGauge(60), /60%/);
  assert.equal(relativeAge("2026-08-13T00:00:00.000Z", Date.parse("2026-08-13T00:42:00.000Z")), "42m");
  const registry = new WorkflowRunRegistry();
  registry.upsert({ taskId: "w1", label: "lookup", status: "running" });
  registry.upsert({ taskId: "w2", label: "done", status: "complete" });
  assert.equal(registry.snapshot().activeCount, 1);
});

test("research footer stays compact and omits zero-value noise", () => {
  const line = researchFooterLine({
    state: {},
    mode: "evidence",
    context: { percent: 0, tokens: 0, contextWindow: 272000 },
    usage: { input: 0, output: 0, cacheRead: 0 },
    workflows: { activeCount: 0 },
    activeTools: [],
    modelId: "gpt-5.6-sol",
    thinkingLevel: "max",
    width: 240,
    theme: plainTheme,
  });
  assert.equal(line, "◇ Pi-Idea · /idea-start · Sol max · 上下文 0%");
  assert.doesNotMatch(line, /流0|工0|↑0|0\/272k|gpt-5\.6/);
});

test("research footer reveals active state without stretching to terminal width", () => {
  const line = researchFooterLine({
    state: { idea: { version: 4, confirmedAt: new Date().toISOString() } },
    mode: "evidence",
    context: { percent: 63, tokens: 171000, contextWindow: 272000 },
    usage: { input: 12000, output: 900, cacheRead: 40000 },
    workflows: { activeCount: 2 },
    activeTools: [{}, {}],
    modelId: "gpt-5.6-sol",
    thinkingLevel: "max",
    width: 240,
    theme: plainTheme,
  });
  assert.match(line, /^◆ Idea v4 · 刚刚 · 证据组装 · Sol max · 上下文 63% 171k\/272k/);
  assert.match(line, /Workflow 2 · 工具 2/);
  assert.match(line, /会话 ↑12k ↓900 ↺40k/);
  assert.ok(line.length < 140);
});

test("research footer drops secondary detail before truncating core state", () => {
  const line = researchFooterLine({
    state: { idea: { version: 4, confirmedAt: new Date().toISOString() } },
    mode: "evidence",
    context: { percent: 63, tokens: 171000, contextWindow: 272000 },
    usage: { input: 12000, output: 900, cacheRead: 40000 },
    workflows: { activeCount: 0 },
    activeTools: [],
    modelId: "gpt-5.6-sol",
    thinkingLevel: "max",
    width: 50,
    theme: plainTheme,
  });
  assert.doesNotMatch(line, /会话|171k\/272k/);
  assert.match(line, /Idea v4/);
  assert.match(line, /Sol max/);
  assert.match(line, /上下文 63%/);
  assert.ok(line.length <= 50);
});
