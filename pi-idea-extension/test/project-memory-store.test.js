import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileProductionContext } from "../src/production-context-assembly.js";
import { ProjectMemoryStore, projectIdentity } from "../src/project-memory-store.js";
import { sha256 } from "../src/core.js";

function entry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp: `2026-08-13T00:00:0${id.slice(-1)}.000Z`, message };
}

test("project memory is incremental, cross-session, raw, and project-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-memory-"));
  const dataDir = join(root, "agent-data");
  const cwd = join(root, "research-a");
  let store;
  try {
    store = new ProjectMemoryStore({ dataDir, cwd });
    const initialState = {
      enabled: true,
      paused: false,
      idea: { version: 2, content: "Study ALPHA", hash: "sha256:idea", confirmedAt: "2026-08-13T00:00:00Z" },
      stage: "verify",
      skills: [],
    };
    const entries = [
      entry("e1", null, { role: "user", content: "The confirmed ALPHA value is 3." }),
      entry("e2", "e1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "result.txt" } }],
      }),
      entry("e3", "e2", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "VALUE-77" }],
      }),
    ];
    const first = store.ingestEntries(entries, {
      sessionId: "session-one", sessionFile: "s1.jsonl", activeEntries: entries, initialState,
    });
    const repeated = store.ingestEntries(entries, {
      sessionId: "session-one", sessionFile: "s1.jsonl", activeEntries: entries, initialState,
    });
    assert.equal(first.inserted, 3);
    assert.equal(repeated.inserted, 0);
    assert.equal(store.countBlocks(), 3);

    // Simulate an index created before research-state coordinates were added.
    // Replaying the immutable session must backfill metadata without adding
    // duplicate ledger or FTS rows.
    const legacyRows = store.db.prepare("SELECT block_id,block_json FROM blocks").all();
    const scrubLegacy = store.db.prepare(`UPDATE blocks
      SET idea_hash=NULL,idea_version=NULL,stage_hash=NULL,block_json=?
      WHERE block_id=?`);
    for (const row of legacyRows) {
      const legacy = JSON.parse(row.block_json);
      delete legacy.researchIdeaHash;
      delete legacy.researchIdeaVersion;
      delete legacy.researchStageHash;
      scrubLegacy.run(JSON.stringify(legacy), row.block_id);
    }
    const migrated = store.ingestEntries(entries, {
      sessionId: "session-one", sessionFile: "s1.jsonl", activeEntries: entries, initialState,
    });
    assert.equal(migrated.inserted, 0);
    assert.equal(store.countBlocks(), 3);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM blocks_fts").get().n, 3);

    store.saveCapsule(initialState);
    assert.equal(store.loadCapsule().idea.content, "Study ALPHA");
    store.close();

    store = new ProjectMemoryStore({ dataDir, cwd });
    const alpha = store.searchBlocks("What was ALPHA?", {
      excludeSessionId: "session-two",
      activeIdeaHash: "sha256:idea",
      activeStageHash: sha256("verify"),
    });
    assert.equal(alpha.some((block) => block.raw === "The confirmed ALPHA value is 3."), true);
    assert.equal(alpha.every((block) => block.provenance.sessionId === "session-one"), true);
    assert.equal(alpha.every((block) => block.researchIdeaHash === "sha256:idea"), true);
    assert.equal(alpha.every((block) => block.researchIdeaVersion === 2), true);
    assert.equal(alpha.every((block) => block.researchStageHash === sha256("verify")), true);
    const transaction = store.searchBlocks("VALUE-77", { excludeSessionId: "session-two" });
    assert.equal(transaction.some((block) => block.kind === "tool_result"), true);
    assert.equal(transaction.some((block) => block.kind === "tool_call"), true);

    store.ingestEntries([], { sessionId: "session-one", sessionFile: "s1.jsonl", activeEntries: entries.slice(0, 1) });
    assert.equal(store.searchBlocks("VALUE-77", { excludeSessionId: "session-two" }).length, 0);
    store.ingestEntries([], { sessionId: "session-one", sessionFile: "s1.jsonl", activeEntries: entries });

    const assembled = compileProductionContext({
      messages: [{ role: "user", id: "u-new", content: "What was ALPHA?" }],
      memoryBlocks: alpha,
      prompt: "What was ALPHA?",
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      liveTurns: 1,
    });
    const evidence = assembled.messages.find((message) => message.customType === "idea-evidence-context-v2");
    assert.match(evidence.content, /ALPHA value is 3/);
    assert.equal(assembled.manifest.source.externalMemoryCandidates, alpha.length);

    assert.notEqual(projectIdentity(cwd).projectId, projectIdentity(join(root, "research-b")).projectId);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup is dry-run first, recovery-gated, and preserves retention closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-retention-"));
  const dataDir = join(root, "agent-data");
  const cwd = join(root, "research");
  let store;
  try {
    store = new ProjectMemoryStore({ dataDir, cwd });
    const ids = {};
    for (const name of ["delete", "pin", "dependency", "unresolved", "touched", "missing"]) {
      const source = join(root, `${name}.jsonl`);
      if (name !== "missing") await writeFile(source, `raw source for ${name}\n`, "utf8");
      const entries = [entry(`${name}-1`, null, { role: "user", content: `confirmed retention ${name}` })];
      store.ingestEntries(entries, {
        sessionId: `session-${name}`,
        sessionFile: source,
        activeEntries: entries,
      });
      ids[name] = store.db.prepare("SELECT block_id FROM blocks WHERE session_id=?").get(`session-${name}`).block_id;
    }

    assert.equal(store.pinBlock(ids.pin, "test-pin"), true);
    store.db.prepare("INSERT INTO block_edges(src_block_id,dst_block_id,relation) VALUES(?,?,?)")
      .run(ids.pin, ids.dependency, "depends_on");
    store.db.prepare("UPDATE blocks SET unresolved=1 WHERE block_id=?").run(ids.unresolved);
    store.touchBlocks([ids.touched], "2999-01-01T00:00:00.000Z");

    const options = {
      softLogicalBytes: 1,
      hardLogicalBytes: 1,
      minInactiveDays: 0,
      recentAccessDays: 30,
      keepRecentSessions: 0,
      maxDeleteBlocks: 100,
    };
    const before = store.countBlocks();
    const dry = store.cleanup({ dryRun: true, ...options });
    assert.equal(dry.status, "planned");
    assert.equal(store.countBlocks(), before);
    assert.deepEqual(dry.candidates.map((candidate) => candidate.blockId), [ids.delete]);

    assert.throws(() => store.cleanup({ dryRun: false, ...options }), /explicit user authorization/);
    const cleaned = store.cleanup({ dryRun: false, authorized: true, ...options });
    assert.equal(cleaned.status, "verified");
    assert.equal(cleaned.deletedCount, 1);
    assert.deepEqual(cleaned.verification, {
      deletedStillPresent: 0,
      protectedMissing: 0,
      protectedSample: 2,
    });
    assert.equal(store.db.prepare("SELECT 1 FROM blocks WHERE block_id=?").get(ids.delete), undefined);
    for (const name of ["pin", "dependency", "unresolved", "touched", "missing"]) {
      assert.ok(store.db.prepare("SELECT 1 FROM blocks WHERE block_id=?").get(ids[name]), `${name} must survive cleanup`);
    }
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation frame survives sessions and restores exact complete islands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-continuation-"));
  const dataDir = join(root, "agent-data");
  const cwd = join(root, "research");
  let store;
  try {
    store = new ProjectMemoryStore({ dataDir, cwd });
    const source = join(root, "session.jsonl");
    await writeFile(source, "durable raw\n", "utf8");
    const entries = [
      entry("c1", null, { role: "user", content: "ACTIVE_NODE=RUN_PAIRED_REPLAY" }),
      entry("c2", "c1", {
        role: "assistant", stopReason: "toolUse",
        content: [
          { type: "text", text: "I will verify RESULT-77." },
          { type: "toolCall", id: "call-c", name: "shell", arguments: { command: "SECRET_COMMAND" } },
        ],
      }),
      entry("c3", "c2", {
        role: "toolResult", toolCallId: "call-c", toolName: "shell",
        content: [{ type: "text", text: "VERIFIED_RESULT=77" }],
      }),
      entry("c4", "c3", { role: "assistant", stopReason: "stop", content: "Next step is SCORE_RESULT_77." }),
    ];
    store.ingestEntries(entries, { sessionId: "session-a", sessionFile: source, activeEntries: entries });
    const frame = store.saveContinuationFrame({
      sessionId: "session-a", ideaHash: "idea-1", stageHash: "stage-1",
    });
    assert.equal(frame.loopId, "c1");
    assert.ok(frame.dialogueBlockIds.length >= 3);
    assert.equal(frame.toolEvidenceBlockIds.length, 1);
    store.close();

    store = new ProjectMemoryStore({ dataDir, cwd });
    const restored = store.loadContinuationFrame({ ideaHash: "idea-1", stageHash: "stage-1" });
    assert.equal(restored.loopId, "c1");
    assert.equal(store.loadContinuationFrame({ ideaHash: "idea-1", stageHash: "wrong" }), null);
    const blocks = store.loadBlocksByIds(restored.allBlockIds);
    assert.match(blocks.map((block) => block.raw).join("\n"), /ACTIVE_NODE=RUN_PAIRED_REPLAY/);
    assert.match(blocks.map((block) => block.raw).join("\n"), /VERIFIED_RESULT=77/);
    assert.match(blocks.map((block) => block.raw).join("\n"), /SCORE_RESULT_77/);
    assert.equal(blocks.some((block) => block.raw.includes("SECRET_COMMAND")), false);
    const cleanupPlan = store.planCleanup({
      softLogicalBytes: 1,
      hardLogicalBytes: 1,
      minInactiveDays: 0,
      recentAccessDays: 0,
      keepRecentSessions: 0,
      maxDeleteBlocks: 100,
    });
    assert.equal(cleanupPlan.candidates.length, 0, "active continuation closure must survive explicit cleanup planning");

    const assembled = compileProductionContext({
      messages: [{ role: "user", id: "new-session-continue", content: "继续" }],
      memoryBlocks: blocks,
      anchorMessage: {
        role: "custom", customType: "idea-anchor-v1", display: false, timestamp: 0,
        content: "CONFIRMED_GOAL\n<confirmed_narrow_state>authority=CPU_ONLY</confirmed_narrow_state>",
      },
      prompt: "继续",
      stage: "",
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      toolSchemaReserveTokens: 0,
      liveTurns: 1,
      coldMessagesIndexed: true,
      explicitRootIds: blocks.map((block) => block.blockId),
    });
    const evidence = assembled.messages.find((message) => message.customType === "idea-evidence-context-v2");
    assert.match(evidence.content, /ACTIVE_NODE=RUN_PAIRED_REPLAY/);
    assert.match(evidence.content, /VERIFIED_RESULT=77/);
    assert.match(evidence.content, /SCORE_RESULT_77/);
    assert.doesNotMatch(evidence.content, /SECRET_COMMAND/);
    assert.equal(assembled.messages.filter((message) => message.role === "user" && message.content === "继续").length, 1);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
