import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitVerbatimFragments } from "../src/evidence-context-compiler.js";
import { compileProductionContext } from "../src/production-context-assembly.js";
import { ProjectMemoryStore } from "../src/project-memory-store.js";
import { WorkerProjectIndex } from "../src/worker-project-index.js";

const HISTORY_BLOCKS = Number(process.env.PI_IDEA_BENCH_BLOCKS || 5000);
const ITERATIONS = Number(process.env.PI_IDEA_BENCH_ITERATIONS || 2000);
const WARMUP = Math.min(250, Math.max(20, Math.floor(ITERATIONS / 10)));

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) || 0,
  };
}

function roundTree(value) {
  if (Array.isArray(value)) return value.map(roundTree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, roundTree(child)]));
  return typeof value === "number" ? Number(value.toFixed(4)) : value;
}

function entry(index) {
  const topic = index % 64;
  const content = index % 251 === 0
    ? `verified eqop sentinel topic-${topic} fresh paired evidence manifest-${index}`
    : `routine historical work topic-${topic} artifact-${index} diagnostic only`;
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    timestamp: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
    message: { role: "user", content },
  };
}

const root = await mkdtemp(join(tmpdir(), "pi-idea-cpu-bench-"));
let store;
let workerIndexer;
try {
  const source = join(root, "session.jsonl");
  await writeFile(source, "rebuildable benchmark raw source\n", "utf8");
  store = new ProjectMemoryStore({ dataDir: join(root, "data"), cwd: join(root, "project") });
  const entries = Array.from({ length: HISTORY_BLOCKS }, (_, index) => entry(index));
  store.ingestEntries(entries, {
    sessionId: "history",
    sessionFile: source,
    activeEntries: entries,
  });

  const liveMessages = Array.from({ length: 4001 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    id: `live-${index}`,
    content: `live event ${index}`,
  }));
  const query = "eqop sentinel fresh paired evidence manifest";
  const runAssembly = () => {
    const memoryBlocks = store.searchBlocks(query, { limit: 24 });
    return compileProductionContext({
      messages: liveMessages,
      memoryBlocks,
      prompt: query,
      stage: "fresh causal verification",
      contextWindow: 272000,
      maxOutputTokens: 32000,
      toolSchemaReserveTokens: 8192,
      liveTurns: 4,
      coldMessagesIndexed: true,
      indexSnapshot: { schema: 1, completedBlocks: HISTORY_BLOCKS, pendingEntries: 0 },
    });
  };
  for (let index = 0; index < WARMUP; index += 1) runAssembly();
  const assemblyTimes = [];
  let last = null;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    last = runAssembly();
    assemblyTimes.push(performance.now() - started);
  }

  const continuationSupport = store.searchBlocks(query, { limit: 24 }).map((block) => block.blockId);
  store.saveContinuationFrame({
    sessionId: "history",
    ideaHash: "benchmark-idea",
    stageHash: null,
    supportingBlockIds: continuationSupport,
  });
  const runContinuationAssembly = () => {
    const frame = store.loadContinuationFrame({ ideaHash: "benchmark-idea", stageHash: null });
    const memoryBlocks = store.loadBlocksByIds(frame.allBlockIds);
    return compileProductionContext({
      messages: liveMessages,
      memoryBlocks,
      explicitRootIds: memoryBlocks.map((block) => block.blockId),
      prompt: "继续",
      stage: "fresh causal verification",
      contextWindow: 272000,
      maxOutputTokens: 32000,
      toolSchemaReserveTokens: 8192,
      liveTurns: 4,
      coldMessagesIndexed: true,
      indexSnapshot: { schema: 1, completedBlocks: HISTORY_BLOCKS, pendingEntries: 0 },
    });
  };
  for (let index = 0; index < WARMUP; index += 1) runContinuationAssembly();
  const continuationTimes = [];
  let lastContinuation = null;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    lastContinuation = runContinuationAssembly();
    continuationTimes.push(performance.now() - started);
  }

  const longEvent = `${"没有模型参与的确定性切段。".repeat(400)}\n${"verified-evidence ".repeat(800)}`;
  for (let index = 0; index < WARMUP; index += 1) splitVerbatimFragments(longEvent);
  const splitTimes = [];
  let fragments = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    fragments = splitVerbatimFragments(longEvent);
    splitTimes.push(performance.now() - started);
  }

  const assembly = stats(assemblyTimes);
  const indexScheduleTimes = [];
  const indexBatchSize = 8;
  const indexBatchIterations = Math.min(500, Math.max(50, Math.floor(ITERATIONS / 4)));
  workerIndexer = new WorkerProjectIndex({ databasePath: store.databasePath, cwd: join(root, "project"), batchSize: indexBatchSize });
  const eventLoopDelays = [];
  let previousPulse = performance.now();
  const pulse = setInterval(() => {
    const now = performance.now();
    eventLoopDelays.push(Math.max(0, now - previousPulse - 1));
    previousPulse = now;
  }, 1);
  const backgroundStarted = performance.now();
  for (let batchIndex = 0; batchIndex < indexBatchIterations; batchIndex += 1) {
    const base = HISTORY_BLOCKS + batchIndex * indexBatchSize;
    const batch = Array.from({ length: indexBatchSize }, (_, offset) => entry(base + offset));
    const started = performance.now();
    workerIndexer.schedule(batch, {
      sessionId: "background-index",
      sessionFile: source,
      activeEntries: null,
    });
    indexScheduleTimes.push(performance.now() - started);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await workerIndexer.drain();
  const backgroundTotalMs = performance.now() - backgroundStarted;
  clearInterval(pulse);
  await workerIndexer.close();
  workerIndexer = null;
  const indexSchedule = stats(indexScheduleTimes);
  const report = roundTree({
    schema: 1,
    benchmark: "pi-idea-context-assembly-cpu-v1",
    cpuOnly: true,
    historyBlocks: HISTORY_BLOCKS,
    sourceMessages: liveMessages.length,
    hotPathSourceMessages: last.manifest.source.hotPathSourceMessages,
    retrievedCandidates: last.manifest.source.externalMemoryCandidates,
    iterations: ITERATIONS,
    warmup: WARMUP,
    fullLoop: assembly,
    continuationLoop: {
      ...stats(continuationTimes),
      rootedBlocks: lastContinuation.manifest.assembly.retained.length,
    },
    backgroundWorker: {
      batchEntries: indexBatchSize,
      batches: indexBatchIterations,
      totalMs: backgroundTotalMs,
      scheduleCall: indexSchedule,
      callerEventLoopDelay: stats(eventLoopDelays),
    },
    deterministicSegmentation: {
      ...stats(splitTimes),
      inputChars: longEvent.length,
      fragments: fragments.length,
      byteExactReconstruction: fragments.map((fragment) => fragment.raw).join("") === longEvent,
    },
    gates: {
      p95Under100ms: assembly.p95Ms <= 100,
      p95Under10msStretch: assembly.p95Ms <= 10,
      continuationP95Under100ms: stats(continuationTimes).p95Ms <= 100,
      continuationP95Under10msStretch: stats(continuationTimes).p95Ms <= 10,
      loopWaitsForSegmentation: false,
      backgroundScheduleP95Under10ms: indexSchedule.p95Ms <= 10,
      callerEventLoopDelayP95Under10ms: stats(eventLoopDelays).p95Ms <= 10,
    },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.gates.p95Under100ms) process.exitCode = 1;
} finally {
  await workerIndexer?.close();
  store?.close();
  await rm(root, { recursive: true, force: true });
}
