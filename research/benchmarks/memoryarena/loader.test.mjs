import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { assertNoGoldLeak } from "./adapter.mjs";
import {
  OFFICIAL_MEMORYARENA_SNAPSHOT,
  defaultOfficialDataRoot,
  loadMemoryArenaConfig,
  loadMemoryArenaDataset,
} from "./loader.mjs";

const REAL_DATA_ROOT = resolve(
  import.meta.dirname,
  "../third_party/memoryarena",
);

test("default data root resolves correctly on Windows", () => {
  assert.equal(defaultOfficialDataRoot(import.meta.url), REAL_DATA_ROOT);
});

test("all 701 official rows pass strict schema and no-gold-leak validation", async () => {
  const dataset = await loadMemoryArenaDataset({ root: REAL_DATA_ROOT });

  assert.equal(dataset.manifest.totalRows, 701);
  assert.equal(dataset.manifest.officialSnapshotVerified, true);
  assert.equal(dataset.onlineCases.length, 701);
  assert.equal(dataset.referencesByCaseKey.size, 701);
  assert.match(dataset.manifest.snapshotDigest, /^[0-9a-f]{64}$/);

  const counts = Object.fromEntries(
    dataset.manifest.files.map((file) => [file.config, file.rows]),
  );
  assert.deepEqual(counts, {
    bundled_shopping: 150,
    progressive_search: 221,
    group_travel_planner: 270,
    formal_reasoning_math: 40,
    formal_reasoning_phys: 20,
  });

  for (const onlineCase of dataset.onlineCases) {
    assert.equal(assertNoGoldLeak(onlineCase), true);
    assert.equal(dataset.referencesByCaseKey.has(onlineCase.caseKey), true);
    assert.equal(onlineCase.sessions.every((session) => session.provenance.rowSha256), true);
  }
});

test("each official file is pinned by rows, byte length, and SHA-256", async () => {
  const dataset = await loadMemoryArenaDataset({ root: REAL_DATA_ROOT });
  for (const file of dataset.manifest.files) {
    assert.deepEqual(
      {
        rows: file.rows,
        bytes: file.bytes,
        sha256: file.sha256,
      },
      OFFICIAL_MEMORYARENA_SNAPSHOT[file.config],
    );
    assert.equal(file.snapshotMatch, true);
  }
});

test("content verification fails closed on an unpinned fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoryarena-adapter-"));
  await writeFile(
    join(root, "progressive_search.jsonl"),
    `${JSON.stringify({ id: 1, questions: ["a", "b"], answers: ["x", "y"] })}\n`,
    "utf8",
  );

  await assert.rejects(
    loadMemoryArenaConfig({ root, config: "progressive_search" }),
    /snapshot mismatch/,
  );

  const fixture = await loadMemoryArenaConfig({
    root,
    config: "progressive_search",
    verifySnapshot: false,
    revision: "fixture",
  });
  assert.equal(fixture.manifest.snapshotMatch, false);
  assert.equal(fixture.onlineCases.length, 1);
});
