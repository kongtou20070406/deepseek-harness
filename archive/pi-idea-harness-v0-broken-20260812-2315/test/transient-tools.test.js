import assert from "node:assert/strict";
import test from "node:test";

import { transientToolRenderers } from "../src/transient-tools.js";

const theme = {
  fg: (_color, value) => value,
};

function rendererContext({ expanded = false } = {}) {
  return {
    state: {},
    expanded,
    executionStarted: true,
    isError: false,
    invalidate() {},
  };
}

test("transient tools are visible while running and disappear after collapsed success", () => {
  const renderer = transientToolRenderers({ title: "Bash", describeArgs: (args) => args.command });
  const context = rendererContext();
  const call = renderer.renderCall({ command: "npm test" }, theme, context);
  assert.deepEqual(call.render(80), [" ✳ Bash npm test"]);

  const result = renderer.renderResult(
    { content: [{ type: "text", text: "37 tests passed" }] },
    { isPartial: false, isError: false },
    theme,
    context,
  );
  assert.deepEqual(call.render(80), []);
  assert.deepEqual(result.render(80), []);
});

test("Ctrl+O expanded state restores completed tool call and output", () => {
  const renderer = transientToolRenderers({ title: "Read", describeArgs: (args) => args.path });
  const context = rendererContext({ expanded: true });
  const call = renderer.renderCall({ path: "src/file.js" }, theme, context);
  const result = renderer.renderResult(
    { content: [{ type: "text", text: "line one\nline two" }] },
    { isPartial: false, isError: false },
    theme,
    context,
  );
  assert.deepEqual(call.render(80), [" ✓ Read src/file.js"]);
  assert.deepEqual(result.render(80), ["  line one", "  line two"]);
});

test("failed transient tools retain one compact error without a shell box", () => {
  const renderer = transientToolRenderers({ title: "Luna", describeArgs: () => "整理相关历史" });
  const context = rendererContext();
  const call = renderer.renderCall({}, theme, context);
  const result = renderer.renderResult(
    { content: [{ type: "text", text: "未知来源 H999\nextra details" }] },
    { isPartial: false, isError: true },
    theme,
    context,
  );
  assert.deepEqual(call.render(80), [" ✗ Luna 整理相关历史"]);
  assert.deepEqual(result.render(80), ["   ↳ 未知来源 H999"]);
});
