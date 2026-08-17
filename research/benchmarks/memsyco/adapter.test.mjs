import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  MEMSYCO_TASK_SPECS,
  OFFICIAL_MANIFEST_V1_2,
  assertNoMemSycoGoldLeak,
  canonicalCrlfBytes,
  loadMemSycoBench,
  memSycoSelectorToPiMessages,
  splitMemSycoRow,
  validateMemSycoRow,
} from "./adapter.mjs";
import { MEMSYCO_FIXTURE_NOTICE, MEMSYCO_SCHEMA_FIXTURES } from "./fixtures.mjs";

test("all five synthetic fixtures follow official schema v1.2 task/policy pairs", () => {
  assert.match(MEMSYCO_FIXTURE_NOTICE, /SYNTHETIC/);
  assert.equal(MEMSYCO_SCHEMA_FIXTURES.length, 5);
  const tasks = new Set();
  for (const row of MEMSYCO_SCHEMA_FIXTURES) {
    assert.equal(validateMemSycoRow(row), true);
    assert.equal(row.memory.policy, MEMSYCO_TASK_SPECS[row.task].policy);
    tasks.add(row.task);
  }
  assert.deepEqual(tasks, new Set(Object.keys(MEMSYCO_TASK_SPECS)));
});

test("online selector hides task, official id, gold memory, rubric and analysis metadata", () => {
  const row = MEMSYCO_SCHEMA_FIXTURES[2];
  const { selectorView, reference } = splitMemSycoRow(row);
  assert.equal(assertNoMemSycoGoldLeak(selectorView), true);
  const serialized = JSON.stringify(selectorView);
  assert.equal(serialized.includes(row.id), false);
  assert.equal(serialized.includes(row.task), false);
  assert.equal(serialized.includes(row.evaluation.reference_answer), false);
  assert.equal(Object.hasOwn(selectorView, "memory"), false);
  assert.equal(reference.officialId, row.id);
  assert.equal(reference.memoryPolicy, "defer_to_evidence");
});

test("Pi message conversion preserves official text/roles without label markers", () => {
  const row = MEMSYCO_SCHEMA_FIXTURES[4];
  const { selectorView } = splitMemSycoRow(row);
  const messages = memSycoSelectorToPiMessages(selectorView);
  assert.equal(messages.length, row.dialogue.length + 1);
  assert.deepEqual(messages.slice(0, -1), row.dialogue);
  assert.deepEqual(messages.at(-1), { role: "user", content: row.question });
  assert.equal(JSON.stringify(messages).includes("memsyco_turn"), false);
});

test("schema rejects unknown fields and a task/policy mismatch", () => {
  const extra = structuredClone(MEMSYCO_SCHEMA_FIXTURES[0]);
  extra.gold_hint = "Jupiter";
  assert.throws(() => validateMemSycoRow(extra), /unsupported field/);
  const mismatch = structuredClone(MEMSYCO_SCHEMA_FIXTURES[0]);
  mismatch.memory.policy = "use";
  assert.throws(() => validateMemSycoRow(mismatch), /memory\.policy/);
});

test("leak checker rejects nested gold labels", () => {
  assert.throws(() => assertNoMemSycoGoldLeak({
    caseKey: "msy:x",
    question: "q",
    history: [{ content: "x", helper: { rubric: { answer: "gold" } } }],
  }), /leaked/);
});

test("loader verifies a complete manifest, counts and checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "memsyco-adapter-"));
  try {
    const tasks = {};
    for (const row of MEMSYCO_SCHEMA_FIXTURES) {
      const spec = MEMSYCO_TASK_SPECS[row.task];
      const text = `${JSON.stringify(row)}\n`;
      await writeFile(join(root, spec.file), text, "utf8");
      tasks[row.task] = {
        file: spec.file,
        samples: 1,
        memory_policy: spec.policy,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
    }
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      name: "MemSyco-Bench-fixture",
      schema_version: "1.2-fixture",
      total_samples: 5,
      tasks,
    }), "utf8");
    const loaded = await loadMemSycoBench(root, { requirePinnedManifest: false });
    assert.equal(loaded.cases.length, 5);
    assert.deepEqual(Object.values(loaded.counts), [1, 1, 1, 1, 1]);
    assert.match(loaded.sha256, /^sha256:[0-9a-f]{64}$/);

    await writeFile(join(root, MEMSYCO_TASK_SPECS.objective_fact_judgment.file), "tampered\n", "utf8");
    await assert.rejects(() => loadMemSycoBench(root, { requirePinnedManifest: false }), /Checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader accepts an LF transport only when its canonical CRLF hash matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "memsyco-crlf-"));
  try {
    const tasks = {};
    for (const row of MEMSYCO_SCHEMA_FIXTURES) {
      const spec = MEMSYCO_TASK_SPECS[row.task];
      const lfBytes = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
      await writeFile(join(root, spec.file), lfBytes);
      tasks[row.task] = {
        file: spec.file,
        samples: 1,
        memory_policy: spec.policy,
        sha256: createHash("sha256").update(canonicalCrlfBytes(lfBytes)).digest("hex"),
      };
    }
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      name: "MemSyco-Bench-fixture",
      schema_version: "1.2-fixture",
      total_samples: 5,
      tasks,
    }), "utf8");
    const loaded = await loadMemSycoBench(root, { requirePinnedManifest: false });
    assert.deepEqual(
      new Set(Object.values(loaded.fileDigests).map(({ checksumMode }) => checksumMode)),
      new Set(["canonical-crlf"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real downloaded release loads all 1,550 rows with pinned content and no online gold", async () => {
  const root = fileURLToPath(new URL("../third_party/memsyco/", import.meta.url));
  const loaded = await loadMemSycoBench(root);
  assert.equal(loaded.schemaVersion, "1.2");
  assert.equal(loaded.cases.length, 1550);
  assert.deepEqual(loaded.counts, {
    objective_fact_judgment: 300,
    contextual_scope_control: 300,
    memory_evidence_conflict: 300,
    valid_memory_selection: 350,
    personalized_memory_use: 300,
  });
  for (const [task, digest] of Object.entries(loaded.fileDigests)) {
    assert.ok(["raw", "canonical-crlf"].includes(digest.checksumMode));
    assert.equal(digest.canonicalCrlfSha256, OFFICIAL_MANIFEST_V1_2.tasks[task].sha256);
  }
  for (const { selectorView } of loaded.cases) assert.equal(assertNoMemSycoGoldLeak(selectorView), true);
});
