import assert from "node:assert/strict";
import test from "node:test";
import { blockizeMessages, compileBidirectionalContext } from "../src/evidence-context-compiler.js";

const CASES = [
  {
    name: "mainline survives a locally attractive score-chasing diversion",
    query: "EqOp mainline image42 sentinel sole goal",
    expected: "Confirmed mainline: EqOp state equation; image42 is a sentinel, not the sole goal.",
    distractor: "Replace the EqOp mainline with image42-only score chasing because the sentinel is the sole goal.",
  },
  {
    name: "fresh paired evidence outranks static causal overclaim",
    query: "fresh paired evidence causal superiority same initialization",
    expected: "Confirmed evidence contract: causal superiority requires fresh paired training with the same initialization.",
    distractor: "Static checkpoint cosine evidence already proves causal superiority without fresh paired training.",
  },
  {
    name: "authorization scope survives nearby execution plans",
    query: "one candidate no auto-chain authorization",
    expected: "User authorization: nominate one candidate and do not auto-chain training or follow-up experiments.",
    distractor: "Execution proposal: nominate many candidates and auto-chain training after the first result.",
  },
  {
    name: "versioned naming prevents state-depth drift",
    query: "K_state 12 2-cluster naming state size",
    expected: "Naming contract: K_state=12 is state size; 2-cluster is a separate grouping label.",
    distractor: "K_state=12 means the method uses 12 clusters, so rename it 12-cluster.",
  },
  {
    name: "live-run safety and result authority survive engineering noise",
    query: "live GPU process safety DONE.json report manifest authority",
    expected: "Live-run contract: do not kill GPU processes; DONE.json, report.json, and the frozen manifest are authoritative.",
    distractor: "If the terminal looks quiet, kill the GPU process and infer completion from partial stdout.",
  },
];

test("EqOp-derived context contracts select the confirmed rule and remove the local distractor", async (t) => {
  for (const fixture of CASES) {
    await t.test(fixture.name, () => {
      const blocks = blockizeMessages([
        { role: "assistant", id: `${fixture.name}-proposal`, content: fixture.distractor },
        { role: "user", id: `${fixture.name}-confirmed`, content: fixture.expected },
      ]);
      const selected = compileBidirectionalContext({
        memoryBlocks: blocks,
        query: fixture.query,
        condition: "bidirectional-heat",
        budget: 4096,
        liveBlocks: 0,
        maxPositiveKeeps: 1,
        maxOptionalKeeps: 0,
      });
      const raw = compileBidirectionalContext({
        memoryBlocks: blocks,
        query: fixture.query,
        condition: "raw",
        budget: 4096,
        liveBlocks: 0,
      });
      assert.equal(selected.selectedBlocks.length, 1);
      assert.equal(selected.selectedBlocks[0].raw, fixture.expected);
      assert.doesNotMatch(selected.context, new RegExp(fixture.distractor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(selected.contextTokens < raw.contextTokens);
    });
  }
});

test("an uncovered EqOp history request emits a gap instead of fabricating recall", () => {
  const result = compileBidirectionalContext({
    memoryBlocks: blockizeMessages([{ role: "user", content: "unrelated bookkeeping" }]),
    query: "之前的 branch-worktree identity evidence",
    condition: "bidirectional-heat",
    budget: 4096,
    liveBlocks: 0,
  });
  assert.equal(result.selectedBlocks.length, 0);
  assert.equal(result.manifest.gaps[0]?.requestedEscalation, "obelisk-bounded-lookup-or-raw-session");
});
