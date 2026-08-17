import assert from "node:assert/strict";
import test from "node:test";

import { fitTuiLine, fitTuiLines, visibleWidth } from "../src/tui-layout.js";

test("custom TUI lines never exceed the width with ANSI and CJK text", () => {
  const colored = `\x1b[33m${"阶段与上下文".repeat(30)}\x1b[39m · ${"|".repeat(80)}`;
  for (const width of [1, 18, 40, 80, 120]) {
    const fitted = fitTuiLine(colored, width);
    assert.ok(visibleWidth(fitted) <= width, `${visibleWidth(fitted)} > ${width}`);
  }
});

test("all widget rows are width-bounded after terminal resize", () => {
  const rows = fitTuiLines([
    "◆ Idea 21小时前确认 · 阶段 21小时前 · Luna — · 思考 high · Bank — · ? /guide",
    `CTX 141k/272k 52%  [${"|".repeat(32)}]  |Idea 701  |阶段 552  |对话 135k  |系统 2.5k  |工具 2.8k  余 110k`,
  ], 120);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => visibleWidth(row) <= 120), true);
});
