import assert from "node:assert/strict";
import test from "node:test";
import { IncrementalIndexQueue } from "../src/incremental-index-queue.js";

test("incremental indexing is scheduled without waiting and commits serial batches", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const store = {
    db: {},
    ingestEntries(entries) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(entries.map((entry) => entry.id));
      active -= 1;
      return { entries: entries.length, blocks: entries.length, inserted: entries.length };
    },
  };
  let releases = 0;
  const queue = new IncrementalIndexQueue({
    batchSize: 2,
    yieldControl: async () => { releases += 1; },
  });
  const scheduled = queue.schedule(store, [1, 2, 3, 4, 5].map((id) => ({ id })), { sessionId: "s" });
  assert.equal(scheduled.pendingEntries, 5);
  assert.equal(calls.length, 0);
  const completed = await queue.drain();
  assert.deepEqual(calls, [[1, 2], [3, 4], [5]]);
  assert.equal(maximumActive, 1);
  assert.equal(releases, 3);
  assert.equal(completed.pendingEntries, 0);
  assert.equal(completed.completedEntries, 5);
});

test("reset cancels queued work owned by a previous session", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const store = { db: {}, ingestEntries() { calls += 1; return { entries: 1, inserted: 1 }; } };
  const queue = new IncrementalIndexQueue({ yieldControl: () => gate });
  queue.schedule(store, [{ id: 1 }], { sessionId: "old" });
  queue.reset();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(queue.snapshot().pendingEntries, 0);
});

test("maintenance is deferred behind indexing and never executes in schedule call", async () => {
  const order = [];
  const queue = new IncrementalIndexQueue({ yieldControl: async () => order.push("yield") });
  const store = {
    db: {},
    ingestEntries(entries) {
      order.push(`index-${entries[0].id}`);
      return { entries: entries.length, inserted: entries.length };
    },
  };
  queue.schedule(store, [{ id: 1 }], { sessionId: "s" });
  queue.scheduleMaintenance(() => order.push("maintenance"));
  assert.deepEqual(order, []);
  await queue.drain();
  assert.deepEqual(order, ["yield", "index-1", "yield", "maintenance"]);
});
