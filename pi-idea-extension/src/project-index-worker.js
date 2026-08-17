import { parentPort, workerData } from "node:worker_threads";
import { ProjectMemoryStore } from "./project-memory-store.js";

const store = new ProjectMemoryStore(workerData);

parentPort.on("message", (message) => {
  try {
    if (message.type === "ingest") {
      const result = store.ingestEntries(message.entries, message.options);
      parentPort.postMessage({ type: "ingest-complete", id: message.id, entries: message.entries.length, result });
    } else if (message.type === "touch") {
      const changed = store.touchBlocks(message.blockIds, message.at);
      parentPort.postMessage({ type: "touch-complete", id: message.id, changed });
    } else if (message.type === "continuation-frame") {
      const frame = store.saveContinuationFrame(message.options);
      parentPort.postMessage({ type: "continuation-frame-complete", id: message.id, frame });
    } else if (message.type === "barrier") {
      parentPort.postMessage({ type: "barrier", id: message.id });
    } else if (message.type === "close") {
      store.close();
      parentPort.postMessage({ type: "closed", id: message.id });
      parentPort.close();
    }
  } catch (error) {
    parentPort.postMessage({
      type: "operation-error",
      id: message.id,
      entries: message.entries?.length || 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
