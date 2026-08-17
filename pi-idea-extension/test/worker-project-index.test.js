import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemoryStore } from "../src/project-memory-store.js";
import { WorkerProjectIndex } from "../src/worker-project-index.js";

test("production index worker commits off the caller thread and exposes a stable snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-index-worker-"));
  const source = join(root, "session.jsonl");
  await writeFile(source, "durable raw\n", "utf8");
  let reader;
  let indexer;
  try {
    reader = new ProjectMemoryStore({ dataDir: join(root, "data"), cwd: join(root, "project") });
    indexer = new WorkerProjectIndex({ databasePath: reader.databasePath, cwd: join(root, "project"), batchSize: 2 });
    const entries = Array.from({ length: 5 }, (_, index) => ({
      type: "message",
      id: `e-${index}`,
      parentId: index ? `e-${index - 1}` : null,
      timestamp: `2026-08-13T00:00:0${index}.000Z`,
      message: { role: index % 2 ? "assistant" : "user", content: `worker evidence ${index}` },
    }));
    const scheduled = indexer.schedule(entries, {
      sessionId: "worker-session",
      sessionFile: source,
      activeEntries: entries,
    });
    assert.equal(scheduled.pendingEntries, 5);
    assert.equal(reader.countBlocks(), 0);
    const completed = await indexer.drain();
    assert.equal(completed.pendingEntries, 0);
    assert.equal(completed.completedEntries, 5);
    assert.equal(reader.countBlocks(), 5);
    assert.equal(reader.searchBlocks("worker evidence 4").some((block) => block.raw.includes("worker evidence 4")), true);
    indexer.updateContinuationFrame({
      sessionId: "worker-session",
      ideaHash: "idea-worker",
      stageHash: "stage-worker",
      supportingBlockIds: [],
    });
    await indexer.drain();
    const frame = reader.loadContinuationFrame({ ideaHash: "idea-worker", stageHash: "stage-worker" });
    assert.equal(frame.sessionId, "worker-session");
    assert.ok(frame.currentLoopBlockIds.length >= 1);
  } finally {
    await indexer?.close();
    reader?.close();
    await rm(root, { recursive: true, force: true });
  }
});
