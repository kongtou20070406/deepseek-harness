import { Worker } from "node:worker_threads";
import { CONTEXT_POLICY } from "./context-policy.js";

/**
 * Single writer lane running outside Pi's event loop. schedule() only posts
 * bounded messages; segmentation, SQLite writes, and WAL checkpoints happen in
 * the worker. The context hook reads the last committed WAL snapshot.
 */
export class WorkerProjectIndex {
  constructor({ databasePath, cwd, batchSize = CONTEXT_POLICY.ingestion.batchEntries } = {}) {
    this.batchSize = Math.max(1, Number(batchSize) || CONTEXT_POLICY.ingestion.batchEntries);
    this.pendingEntries = 0;
    this.completedEntries = 0;
    this.completedBlocks = 0;
    this.lastCompletedAt = null;
    this.lastError = null;
    this.sequence = 0;
    this.waiters = new Map();
    this.closed = false;
    this.worker = new Worker(new URL("./project-index-worker.js", import.meta.url), {
      workerData: { databasePath, cwd },
    });
    this.worker.on("message", (message) => this.#onMessage(message));
    this.worker.on("error", (error) => { this.lastError = error.message; });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) this.lastError = `index worker exited with code ${code}`;
      for (const waiter of this.waiters.values()) waiter.resolve(this.snapshot());
      this.waiters.clear();
    });
  }

  #nextId(prefix) {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  #onMessage(message) {
    if (message.type === "ingest-complete") {
      this.pendingEntries = Math.max(0, this.pendingEntries - Number(message.entries || 0));
      this.completedEntries += Number(message.result?.entries || 0);
      this.completedBlocks += Number(message.result?.inserted || 0);
      this.lastCompletedAt = new Date().toISOString();
    } else if (message.type === "operation-error") {
      this.pendingEntries = Math.max(0, this.pendingEntries - Number(message.entries || 0));
      this.lastError = message.error || "unknown worker error";
    }
    const waiter = this.waiters.get(message.id);
    if (waiter) {
      this.waiters.delete(message.id);
      waiter.resolve(this.snapshot());
    }
  }

  schedule(entries = [], options = {}) {
    const work = Array.isArray(entries) ? entries : [];
    if (this.closed || work.length === 0) return this.snapshot();
    const activeEntryIds = Array.isArray(options.activeEntries)
      ? options.activeEntries.filter((entry) => entry?.type === "message" && entry.id).map((entry) => entry.id)
      : null;
    this.pendingEntries += work.length;
    for (let index = 0; index < work.length; index += this.batchSize) {
      const batch = work.slice(index, index + this.batchSize);
      const isLast = index + this.batchSize >= work.length;
      this.worker.postMessage({
        type: "ingest",
        id: this.#nextId("ingest"),
        entries: batch,
        options: {
          sessionId: options.sessionId,
          sessionFile: options.sessionFile,
          initialState: options.initialState,
          activeEntryIds: isLast ? activeEntryIds : null,
        },
      });
    }
    return this.snapshot();
  }

  touchBlocks(blockIds = []) {
    const ids = [...new Set(blockIds.filter(Boolean))];
    if (!this.closed && ids.length) {
      this.worker.postMessage({ type: "touch", id: this.#nextId("touch"), blockIds: ids, at: new Date().toISOString() });
    }
    return this.snapshot();
  }

  updateContinuationFrame(options = {}) {
    if (!this.closed && options.sessionId) {
      this.worker.postMessage({ type: "continuation-frame", id: this.#nextId("continuation-frame"), options });
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      schema: 1,
      mode: "worker-thread-deterministic-cpu",
      batchSize: this.batchSize,
      pendingEntries: this.pendingEntries,
      completedEntries: this.completedEntries,
      completedBlocks: this.completedBlocks,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
    });
  }

  barrier(type = "barrier") {
    if (this.closed) return Promise.resolve(this.snapshot());
    const id = this.#nextId(type);
    const promise = new Promise((resolve) => this.waiters.set(id, { resolve }));
    this.worker.postMessage({ type, id });
    return promise;
  }

  drain() {
    return this.barrier("barrier");
  }

  async close() {
    if (this.closed) return this.snapshot();
    await this.drain();
    const result = await this.barrier("close");
    this.closed = true;
    return result;
  }
}
