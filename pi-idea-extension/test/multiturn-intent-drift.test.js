import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScenarios,
  piIdeaAssembly,
  rollingCompaction,
  score,
} from "../benchmark/multiturn-intent-drift.js";

test("multi-turn replay always includes the current question exactly once", () => {
  for (const scenario of buildScenarios()) {
    const rolling = score(rollingCompaction(scenario.messages, scenario.prompt), scenario);
    const piIdea = score(piIdeaAssembly(scenario), scenario);
    assert.equal(rolling.currentQuestionExactlyOnce, true, `${scenario.id}: rolling duplicated the live question`);
    assert.equal(piIdea.currentQuestionExactlyOnce, true, `${scenario.id}: Pi-Idea duplicated the live question`);
  }
});

test("Pi-Idea continuation frame resolves a bare continue without lexical guessing", () => {
  const scenario = buildScenarios().find((item) => item.id === "bare-continue");
  const result = piIdeaAssembly(scenario);
  const scored = score(result, scenario);
  assert.equal(result.continuationRoots > 0, true);
  assert.equal(scored.goalDrift, false);
  assert.deepEqual(scored.missing, []);
  assert.deepEqual(scored.forbiddenHits, []);
});

test("Pi-Idea keeps the confirmed goal in every replay scenario", () => {
  for (const scenario of buildScenarios()) {
    const result = score(piIdeaAssembly(scenario), scenario);
    assert.equal(result.goalDrift, false, scenario.id);
    assert.equal(result.pass, true, `${scenario.id}: ${result.missing.join(",")}`);
  }
});
