import { CONTEXT_POLICY } from "./context-policy.js";

function defaultYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A single-lane, yielding queue for deterministic CPU indexing. schedule()
 * never waits for blockization. Work is split into bounded batches and the
 * context loop reads the last fully committed SQLite snapshot.
 */
export class IncrementalIndexQueue {
  constructor({ batchSize = CONTEXT_POLICY.ingestion.batchEntries, yieldControl = defaultYield } = {}) {
    this.batchSize = Math.max(1, Number(batchSize) || 64);
    this.yieldControl = yieldControl;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.pendingEntries = 0;
    this.completedEntries = 0;
    this.completedBlocks = 0;
    this.lastError = null;
    this.lastCompletedAt = null;
  }

  reset() {
    this.generation += 1;
    this.queue = Promise.resolve();
    this.pendingEntries = 0;
    this.lastError = null;
  }

  schedule(store, entries = [], options = {}) {
    const work = Array.isArray(entries) ? entries : [];
    if (!store || work.length === 0) return this.snapshot();
    const generation = this.generation;
    const batches = [];
    for (let index = 0; index < work.length; index += this.batchSize) {
      batches.push(work.slice(index, index + this.batchSize));
    }
    this.pendingEntries += work.length;
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const isLast = index === batches.length - 1;
      this.queue = this.queue
        .then(() => this.yieldControl())
        .then(() => {
          if (generation !== this.generation || !store.db) {
            this.pendingEntries = Math.max(0, this.pendingEntries - batch.length);
            return null;
          }
          const result = store.ingestEntries(batch, {
            ...options,
            activeEntries: isLast ? options.activeEntries : null,
          });
          this.pendingEntries = Math.max(0, this.pendingEntries - batch.length);
          this.completedEntries += Number(result?.entries || 0);
          this.completedBlocks += Number(result?.inserted || 0);
          this.lastCompletedAt = new Date().toISOString();
          return result;
        })
        .catch((error) => {
          this.pendingEntries = Math.max(0, this.pendingEntries - batch.length);
          this.lastError = error instanceof Error ? error.message : String(error);
          return null;
        });
    }
    return this.snapshot();
  }

  scheduleMaintenance(task) {
    const generation = this.generation;
    this.queue = this.queue
      .then(() => this.yieldControl())
      .then(() => generation === this.generation ? task() : null)
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        return null;
      });
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      schema: 1,
      mode: "async-deterministic-cpu",
      batchSize: this.batchSize,
      pendingEntries: this.pendingEntries,
      completedEntries: this.completedEntries,
      completedBlocks: this.completedBlocks,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
    });
  }

  async drain() {
    await this.queue;
    return this.snapshot();
  }
}
