import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  MEMORYARENA_CONFIGS,
  MEMORYARENA_DATASET,
  adaptMemoryArenaRow,
} from "./adapter.mjs";

/**
 * Content-addressed snapshot downloaded from the official Hugging Face dataset
 * on 2026-08-13. `main` is intentionally not treated as a reproducible
 * revision by itself; the byte length and SHA-256 are the authority.
 */
export const OFFICIAL_MEMORYARENA_SNAPSHOT = Object.freeze({
  bundled_shopping: Object.freeze({
    rows: 150,
    bytes: 1_601_723,
    sha256: "4411a2da528a33dc6aca519b49cc225895363f18b2d19b191fddb501200134ef",
  }),
  formal_reasoning_math: Object.freeze({
    rows: 40,
    bytes: 829_228,
    sha256: "ff5b0ad575847c7476a02d1e35661592a833bd0cff384cb54bc6f35b46de7803",
  }),
  formal_reasoning_phys: Object.freeze({
    rows: 20,
    bytes: 87_070,
    sha256: "580862006af2ff2bfc8c5d2d2b9a60bf33a46cbb64f27d60a2bfe039aec61cf6",
  }),
  group_travel_planner: Object.freeze({
    rows: 270,
    bytes: 6_165_901,
    sha256: "2f955d444f6f3ad3c5da2064359ab19f8fc1f90621ff9d00723a450a009c3732",
  }),
  progressive_search: Object.freeze({
    rows: 221,
    bytes: 3_618_343,
    sha256: "b445ee36fa3ccb9ad08eae9e7adda86bbc64f14f1e2a0682a8b2085cdb8e4c0e",
  }),
});

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotDigest(files) {
  const canonical = files
    .map(({ config, sha256, bytes, rows }) => `${config}:${sha256}:${bytes}:${rows}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseJsonl(bytes, filePath) {
  const text = bytes.toString("utf8");
  const rawLines = text.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    if (rawLine.trim().length === 0) continue;
    try {
      records.push({
        row: JSON.parse(rawLine),
        rowNumber: index + 1,
        rawLineSha256: createHash("sha256").update(rawLine, "utf8").digest("hex"),
      });
    } catch (error) {
      throw new SyntaxError(`${filePath}:${index + 1}: invalid JSONL (${error.message})`);
    }
  }
  return records;
}

export async function loadMemoryArenaConfig({
  root,
  config,
  revision = "main",
  verifySnapshot = true,
} = {}) {
  const definition = MEMORYARENA_CONFIGS[config];
  if (!definition) throw new Error(`Unknown MemoryArena config: ${config}`);
  if (!root) throw new Error("MemoryArena data root is required");

  const filePath = resolve(root, definition.fileName);
  const [bytes, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  const sha256 = sha256Bytes(bytes);
  const records = parseJsonl(bytes, filePath);
  const expected = OFFICIAL_MEMORYARENA_SNAPSHOT[config];
  const snapshotMatch =
    expected &&
    expected.sha256 === sha256 &&
    expected.bytes === fileStat.size &&
    expected.rows === records.length;

  if (verifySnapshot && !snapshotMatch) {
    throw new Error(
      `Official MemoryArena snapshot mismatch for ${config}: ` +
        `rows=${records.length}, bytes=${fileStat.size}, sha256=${sha256}`,
    );
  }

  const sourceUri = `https://huggingface.co/datasets/${MEMORYARENA_DATASET}/resolve/${revision}/${config}/data.jsonl`;
  const onlineCases = [];
  const referencesByCaseKey = new Map();
  const seenIds = new Set();

  for (const { row, rowNumber, rawLineSha256 } of records) {
    const idKey = String(row.id);
    if (seenIds.has(idKey)) {
      throw new Error(`${filePath}:${rowNumber}: duplicate row id ${idKey}`);
    }
    seenIds.add(idKey);

    const { onlineCase, referenceCase } = adaptMemoryArenaRow(row, {
      config,
      source: {
        sourceUri,
        revision,
        sourceFile: definition.fileName,
        sourceSha256: sha256,
        rowNumber,
        rawLineSha256,
      },
    });
    onlineCases.push(onlineCase);
    referencesByCaseKey.set(referenceCase.caseKey, referenceCase);
  }

  return {
    manifest: Object.freeze({
      benchmark: "MemoryArena",
      dataset: MEMORYARENA_DATASET,
      config,
      split: "test",
      requestedRevision: revision,
      sourceUri,
      sourceFile: definition.fileName,
      filePath,
      rows: records.length,
      bytes: fileStat.size,
      sha256,
      snapshotMatch: Boolean(snapshotMatch),
    }),
    onlineCases: Object.freeze(onlineCases),
    referencesByCaseKey,
  };
}

export async function loadMemoryArenaDataset({
  root,
  configs = Object.keys(MEMORYARENA_CONFIGS),
  revision = "main",
  verifySnapshot = true,
} = {}) {
  if (!root) throw new Error("MemoryArena data root is required");
  const normalizedRoot = resolve(root);
  const loaded = [];
  for (const config of configs) {
    loaded.push(
      await loadMemoryArenaConfig({
        root: normalizedRoot,
        config,
        revision,
        verifySnapshot,
      }),
    );
  }

  const onlineCases = [];
  const referencesByCaseKey = new Map();
  for (const part of loaded) {
    for (const onlineCase of part.onlineCases) onlineCases.push(onlineCase);
    for (const [caseKey, reference] of part.referencesByCaseKey) {
      if (referencesByCaseKey.has(caseKey)) {
        throw new Error(`Duplicate MemoryArena case key across configs: ${caseKey}`);
      }
      referencesByCaseKey.set(caseKey, reference);
    }
  }

  const files = loaded.map((part) => part.manifest);
  const allSnapshotMatched = files.every((file) => file.snapshotMatch);
  return {
    manifest: Object.freeze({
      benchmark: "MemoryArena",
      dataset: MEMORYARENA_DATASET,
      split: "test",
      requestedRevision: revision,
      root: normalizedRoot,
      configs: Object.freeze([...configs]),
      totalRows: onlineCases.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      snapshotDigest: snapshotDigest(files),
      officialSnapshotVerified: allSnapshotMatched,
      files: Object.freeze(files),
    }),
    onlineCases: Object.freeze(onlineCases),
    referencesByCaseKey,
  };
}

export function defaultOfficialDataRoot(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "../third_party/memoryarena");
}
