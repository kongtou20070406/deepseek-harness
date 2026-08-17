import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKING_MESSAGE,
  installWorkingVisual,
  workingIndicatorOptions,
  workingMessageForTool,
} from "../src/working-visual.js";

test("working messages expose actions without leaking tool arguments", () => {
  assert.equal(workingMessageForTool("luna_refresh_context"), "Luna 正在整理相关历史…");
  assert.equal(workingMessageForTool("shell_command"), "正在执行命令…");
  assert.equal(workingMessageForTool("grep_search"), "正在查找相关信息…");
  assert.equal(workingMessageForTool("apply_patch"), "正在更新文件…");
  assert.equal(workingMessageForTool("unknown_private_tool"), "正在使用工具…");
});

test("working indicator uses Pi's public loader API and remains compact", () => {
  const calls = {};
  const ctx = {
    ui: {
      theme: { fg: (_color, value) => `<${value}>` },
      setWorkingVisible(value) { calls.visible = value; },
      setWorkingIndicator(value) { calls.indicator = value; },
      setWorkingMessage(value) { calls.message = value; },
    },
  };

  installWorkingVisual(ctx);
  assert.equal(calls.visible, true);
  assert.equal(calls.message, DEFAULT_WORKING_MESSAGE);
  assert.equal(calls.indicator.intervalMs, 110);
  assert.equal(calls.indicator.frames.length, 6);
  assert.deepEqual(calls.indicator, workingIndicatorOptions(ctx.ui.theme));
});
