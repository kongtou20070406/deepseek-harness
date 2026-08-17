import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemSycoBench } from "../memsyco/adapter.mjs";
import { EVIDENCE_LADDER_VERSION } from "./compiler.mjs";
import { buildLongHorizonCase, compileLongHorizonAssemblies, targetEvidenceCoverage } from "./long-horizon-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const dataPath = join(workspace, "research", "benchmarks", "third_party", "memsyco");
const resultDir = join(here, "results");
const output = join(resultDir, "long-horizon-sol-5pct-v2-manifest.json");
const seed = "pi-idea-long-horizon-sol-independent-5pct-v2";
const taskCounts = Object.freeze({ objective_fact_judgment: 15, personalized_memory_use: 15, memory_evidence_conflict: 15, contextual_scope_control: 15, valid_memory_selection: 18 });
const distractorCount = 8;
const rawBudget = 65536;
const compactBudget = 8192;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function priorModelCaseKeys() {
  const names = await readdir(resultDir, { recursive: true });
  const keys = new Set();
  for (const name of names) {
    const normalized = String(name).replaceAll("\\", "/");
    if (!normalized.includes("frozen-online/")) continue;
    const match = normalized.match(/msy_([0-9a-f]{20})\.json$/u);
    if (match) keys.add(`msy:${match[1]}`);
  }
  return keys;
}

function chooseDistractors(target, pool) {
  return pool.filter((item) => item.selectorView.caseKey !== target.selectorView.caseKey && item.reference.task !== target.reference.task)
    .map((item) => ({ item, tie: hash(`${seed}\0${target.selectorView.caseKey}\0${item.selectorView.caseKey}`) }))
    .sort((left, right) => left.tie.localeCompare(right.tie)).slice(0, distractorCount).map((row) => row.item);
}

async function sourceDigest() {
  const paths = [
    join(workspace, "pi-idea-extension", "src", "evidence-context-compiler.js"),
    join(here, "long-horizon-fixture.mjs"),
    join(here, "long-horizon-sol-protocol.mjs"),
  ];
  return hash(Buffer.concat(await Promise.all(paths.map((path) => readFile(path)))));
}

await mkdir(resultDir, { recursive: true });
try {
  await access(output);
  throw new Error(`Refusing to overwrite frozen manifest ${output}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const loaded = await loadMemSycoBench(dataPath);
const excluded = await priorModelCaseKeys();
const eligible = loaded.cases.filter((item) => !excluded.has(item.selectorView.caseKey));
const selected = [];
for (const [task, count] of Object.entries(taskCounts)) {
  const pool = eligible.filter((item) => item.reference.task === task)
    .map((item) => ({ item, tie: hash(`${seed}\0target\0${item.selectorView.caseKey}`) }))
    .sort((left, right) => left.tie.localeCompare(right.tie));
  if (pool.length < count) throw new Error(`${task} has only ${pool.length} eligible targets`);
  selected.push(...pool.slice(0, count).map((row) => row.item));
}
const cases = selected.map((target) => {
  const distractors = chooseDistractors(target, eligible);
  const targetAfter = 2 + (Number.parseInt(hash(`${seed}\0depth\0${target.selectorView.caseKey}`).slice(0, 8), 16) % 3);
  const longCase = buildLongHorizonCase(target, distractors, { targetAfter });
  const assemblies = compileLongHorizonAssemblies(longCase, { rawBudget, compactBudget });
  const paired = Object.fromEntries(["raw-long", "evidence-ladder"].map((condition) => [condition, assemblies[condition]]));
  return {
    caseKey: target.selectorView.caseKey,
    officialId: target.reference.officialId,
    task: target.reference.task,
    distractorCaseKeys: distractors.map((item) => item.selectorView.caseKey),
    targetAfter,
    totalTurns: longCase.selectorView.history.length,
    assemblies: Object.fromEntries(Object.entries(paired).map(([condition, assembly]) => [condition, {
      contextTokens: assembly.contextTokens,
      outputHash: assembly.outputHash,
      targetEvidenceCoverage: targetEvidenceCoverage(longCase, assembly),
    }])),
  };
});
const manifest = {
  schema: 1,
  protocol: "pi-idea-long-horizon-sol-raw-vs-dialogue-islands-v2",
  frozenAt: new Date().toISOString(),
  dataSha256: loaded.sha256,
  compilerVersion: EVIDENCE_LADDER_VERSION,
  sourceDigest: await sourceDigest(),
  sample: { seed, percent: 5, count: cases.length, taskCounts, excludedPriorModelCases: excluded.size },
  assembly: { distractorCount, rawBudget, compactBudget, conditions: ["raw-long", "evidence-ladder"], cpuOnly: true },
  cases,
};
manifest.manifestHash = `sha256:${hash(JSON.stringify(manifest))}`;
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, manifestHash: manifest.manifestHash, cases: cases.length, excluded: excluded.size }, null, 2)}\n`);
