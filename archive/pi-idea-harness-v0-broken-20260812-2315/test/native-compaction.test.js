import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExplicitSessionIntent,
  nativeCompactionDecision,
  NATIVE_COMPACTION_INDEX_LIMIT,
  parseNativeCompactionBlocks,
} from "../src/native-compaction.js";
import { temporaryIdeaStore } from "./helpers.js";

test("native compaction starts at a soft threshold instead of overflow", () => {
  assert.equal(nativeCompactionDecision({ tokens: 49_000, contextWindow: 128_000 }).shouldCompact, false);
  const ready = nativeCompactionDecision({ tokens: 52_000, contextWindow: 128_000 });
  assert.equal(ready.shouldCompact, true);
  assert.equal(ready.threshold, 51_200);
  assert.equal(nativeCompactionDecision({ tokens: 108_000, contextWindow: 272_000 }).shouldCompact, false);
  assert.equal(nativeCompactionDecision({ tokens: 109_000, contextWindow: 272_000 }).shouldCompact, true);
});

test("native summary parser exposes six bounded semantic blocks without copying content", () => {
  const summary = [
    "## Progress",
    "### [FINDINGS]", "证据 A",
    "### [HYPOTHESES]", "假设 B",
    "### [CONFLICTS]", "冲突 C",
    "### [OPERATIONS]", "命令 D",
    "### [DECISIONS]", "决定 E",
    "### [OPEN_LOOP]", "任务 F",
  ].join("\n");
  const blocks = parseNativeCompactionBlocks(summary);
  assert.deepEqual(blocks.map((block) => block.kind), [
    "FINDINGS", "HYPOTHESES", "CONFLICTS", "OPERATIONS", "DECISIONS", "OPEN_LOOP",
  ]);
  assert.equal(blocks.some((block) => Object.hasOwn(block, "content")), false);
  assert.ok(blocks.every((block) => block.hash.startsWith("sha256:")));
});

test("native block inventory is capped per session", () => {
  const fixture = temporaryIdeaStore();
  try {
    for (let index = 0; index < NATIVE_COMPACTION_INDEX_LIMIT + 4; index += 1) {
      fixture.store.saveNativeCompactionSet({
        compactionId: `cmp-${index}`,
        sessionId: "main",
        reason: "threshold",
        summaryHash: `sha256:summary-${index}`,
        tokensBefore: 60_000 + index,
        blocks: [{ kind: "FINDINGS", hash: `sha256:block-${index}`, tokens: 10, characters: 20, empty: false }],
        createdAt: new Date(1_000 + index).toISOString(),
      });
    }
    const retained = fixture.store.listNativeCompactionSets("main", 100);
    assert.equal(retained.length, NATIVE_COMPACTION_INDEX_LIMIT);
    assert.equal(retained[0].compactionId, `cmp-${NATIVE_COMPACTION_INDEX_LIMIT + 3}`);
  } finally {
    fixture.cleanup();
  }
});

test("plain pi and explicit session invocations are distinguishable", () => {
  assert.equal(hasExplicitSessionIntent([]), false);
  assert.equal(hasExplicitSessionIntent(["--session-id", "new-main"]), true);
  assert.equal(hasExplicitSessionIntent(["--resume"]), true);
  assert.equal(hasExplicitSessionIntent(["--mode", "rpc"]), false);
});
