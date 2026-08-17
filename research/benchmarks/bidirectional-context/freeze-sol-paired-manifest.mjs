import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { sampleMemSycoByTaskPercent } from "../memsyco/runner-core.mjs";
import { compileBidirectionalContext, EVIDENCE_CONTEXT_COMPILER_VERSION } from "./compiler.mjs";
import { memSycoHistoryMessages } from "./memsyco-ablation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const seed = "memsyco-five-local-5pct-v1";
const budget = 8192;
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const output = resolve(outputArgument
  ? outputArgument.slice("--output=".length)
  : join(here, "results", "sol-lsc-epc-5pct-manifest-20260813.json"));

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

const loaded = await loadMemSycoBench(dataPath);
const selected = sampleMemSycoByTaskPercent(loaded.cases, { percent: 5, seed });
const cases = [];
for (const item of selected) {
  const messages = memSycoHistoryMessages(item.selectorView);
  const assemblies = {};
  for (const condition of ["raw", "bidirectional-heat"]) {
    const result = compileBidirectionalContext({
      messages,
      query: item.selectorView.question,
      condition,
      budget,
      liveBlocks: 1,
    });
    if (result.overflow) throw new Error(`${item.selectorView.caseKey}/${condition} overflowed frozen budget`);
    assemblies[condition] = {
      contextTokens: result.contextTokens,
      outputHash: result.manifest.outputHash,
      selectedBlockIdsHash: sha256(result.selectedBlocks.map((block) => block.blockId).join("|")),
    };
  }
  cases.push({
    caseKey: item.selectorView.caseKey,
    task: item.reference.task,
    onlineInputHash: sha256(JSON.stringify(item.selectorView)),
    assemblies,
  });
}

const manifest = {
  schema: 1,
  protocol: "memsyco-sol-raw-vs-lsc-epc-paired-v1",
  // Frozen protocol date, not wall-clock generation time, so regenerating the
  // artifact from the same official bytes produces the same manifest hash.
  frozenAt: "2026-08-13T00:00:00.000Z",
  data: { sha256: loaded.sha256, schemaVersion: loaded.schemaVersion, totalRows: loaded.cases.length },
  sample: { seed, percent: 5, count: cases.length, caseOrderHash: sha256(cases.map((item) => item.caseKey).join("|")) },
  assembly: {
    compilerVersion: EVIDENCE_CONTEXT_COMPILER_VERSION,
    budget,
    liveBlocks: 1,
    conditions: ["raw", "bidirectional-heat"],
    assemblyUsesModel: false,
  },
  cases,
};
manifest.manifestHash = sha256(JSON.stringify(manifest));
await mkdir(dirname(output), { recursive: true });
try {
  await access(output);
  throw new Error(`Refusing to overwrite frozen manifest ${output}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, manifestHash: manifest.manifestHash, cases: cases.length }, null, 2)}\n`);
