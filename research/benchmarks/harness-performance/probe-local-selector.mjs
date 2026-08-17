import { benchmarkCases } from "./cases.mjs";
import { compileContext } from "../../../pi-idea-extension/src/context-compiler.js";

for (const item of benchmarkCases(8)) {
  const result = compileContext({
    messages: item.messages,
    idea: item.p0,
    prompt: item.question,
    stage: item.stage,
    summaries: new Map(),
    liveTurns: 4,
    retrievalBudget: 3600,
    maxRetrievedUnits: 6,
    foldMinTokens: 4800,
    foldMaxTokens: 7200,
    localEvidenceIndex: true,
  });
  process.stdout.write(`${item.id}\n`);
  for (const passage of result.selectedPassages) {
    process.stdout.write(`  ${passage.score.toFixed(2)} ${passage.evidenceId || passage.passageId.slice(0, 8)} ${passage.quote.slice(0, 180)}\n`);
  }
}
