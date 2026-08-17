import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { blockizeMessages } from "./evidence-context-compiler.js";
import { STATE_TYPE, applyEvent, emptyState, sha256 } from "./core.js";
import { CONTEXT_POLICY } from "./context-policy.js";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalWorkspace(cwd) {
  const normalized = resolve(cwd || ".").replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function projectIdentity(cwd) {
  const workspace = canonicalWorkspace(cwd);
  return Object.freeze({ workspace, projectId: digest(`pi-idea-project-v1\0${workspace}`).slice(0, 24) });
}

function searchTerms(value) {
  const text = String(value || "").toLowerCase();
  const latin = (text.match(/[a-z0-9_./:-]{2,}/g) || [])
    .map((term) => term.replace(/^[./:-]+|[./:-]+$/g, ""))
    .filter((term) => term.length >= 2);
  const runs = text.match(/[\u3400-\u9fff]{2,}/g) || [];
  const cjk = runs.flatMap((run) => [run, ...Array.from(
    { length: Math.max(0, run.length - 1) },
    (_, index) => run.slice(index, index + 2),
  )]);
  return [...new Set([...latin, ...cjk])].sort((left, right) => right.length - left.length).slice(0, 12);
}

function ftsPhrase(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function hydrate(row) {
  const block = JSON.parse(row.block_json);
  return Object.freeze({
    ...block,
    provenance: Object.freeze({
      ...block.provenance,
      ledgerOrder: Number(row.ledger_order),
    }),
  });
}

function ensureColumn(db, table, column, declaration) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function recoverableFile(reference) {
  const value = String(reference || "");
  if (!value || /^obelisk:/i.test(value)) return null;
  const marker = value.lastIndexOf("#");
  const candidate = marker > 1 ? value.slice(0, marker) : value;
  return existsSync(candidate) ? candidate : null;
}

export class ProjectMemoryStore {
  constructor({ dataDir, cwd, databasePath = null } = {}) {
    if (!dataDir && !databasePath) throw new Error("ProjectMemoryStore needs dataDir or databasePath");
    const identity = projectIdentity(cwd);
    this.projectId = identity.projectId;
    this.workspace = identity.workspace;
    this.databasePath = databasePath || join(dataDir, "idea-extension", "projects", this.projectId, "memory.sqlite");
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    // Keep the hot reader non-blocking and avoid SQLite's default ~1000-page
    // checkpoint cadence creating frequent latency spikes during 64-entry
    // background batches. The WAL remains bounded to roughly 16 MiB between
    // passive checkpoints on the usual 4 KiB page size.
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=4096;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        session_file TEXT,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_entries (
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        PRIMARY KEY(session_id, entry_id)
      );
      CREATE TABLE IF NOT EXISTS blocks (
        ledger_order INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        parent_entry_id TEXT,
        entry_timestamp TEXT,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        call_id TEXT,
        raw TEXT NOT NULL,
        raw_hash TEXT NOT NULL,
        refs TEXT NOT NULL,
        fact_candidate INTEGER NOT NULL,
        unresolved INTEGER NOT NULL,
        idea_hash TEXT,
        idea_version INTEGER,
        stage_hash TEXT,
        block_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_session_entry ON blocks(session_id, entry_id);
      CREATE INDEX IF NOT EXISTS blocks_call ON blocks(call_id);
      CREATE INDEX IF NOT EXISTS blocks_raw_hash ON blocks(raw_hash);
      CREATE TABLE IF NOT EXISTS retention_pins (
        block_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        pinned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS continuation_frame_blocks (
        block_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS block_edges (
        src_block_id TEXT NOT NULL,
        dst_block_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY(src_block_id,dst_block_id,relation)
      );
      CREATE INDEX IF NOT EXISTS block_edges_src ON block_edges(src_block_id);
      CREATE TABLE IF NOT EXISTS cleanup_runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        dry_run INTEGER NOT NULL,
        before_logical_bytes INTEGER NOT NULL,
        after_logical_bytes INTEGER,
        candidate_count INTEGER NOT NULL,
        deleted_count INTEGER NOT NULL DEFAULT 0,
        plan_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
        block_id UNINDEXED,
        raw,
        refs,
        tokenize='unicode61'
      );
    `);
    ensureColumn(this.db, "blocks", "idea_hash", "TEXT");
    ensureColumn(this.db, "blocks", "idea_version", "INTEGER");
    ensureColumn(this.db, "blocks", "stage_hash", "TEXT");
    ensureColumn(this.db, "blocks", "logical_event_id", "TEXT");
    ensureColumn(this.db, "blocks", "loop_id", "TEXT");
    ensureColumn(this.db, "blocks", "dialogue_block_id", "TEXT");
    ensureColumn(this.db, "blocks", "recoverable_ref", "TEXT");
    ensureColumn(this.db, "blocks", "ingested_at", "TEXT");
    ensureColumn(this.db, "blocks", "last_access_at", "TEXT");
    ensureColumn(this.db, "blocks", "access_count", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS blocks_last_access ON blocks(last_access_at); CREATE INDEX IF NOT EXISTS blocks_logical_event ON blocks(logical_event_id); CREATE INDEX IF NOT EXISTS blocks_loop ON blocks(session_id,loop_id); CREATE INDEX IF NOT EXISTS blocks_dialogue ON blocks(dialogue_block_id);");
    this.sessionStates = new Map();
    this.sessionLoopIds = new Map();
    this.db.prepare(`INSERT INTO meta(key,value,updated_at) VALUES('workspace',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(this.workspace, new Date().toISOString());
  }

  saveCapsule(state) {
    const capsule = {
      schema: 1,
      projectId: this.projectId,
      workspace: this.workspace,
      enabled: Boolean(state?.enabled),
      paused: Boolean(state?.paused),
      ideaId: state?.ideaId || null,
      conversationKind: state?.conversationKind === "btw" ? "btw" : "main",
      workspaces: Array.isArray(state?.workspaces) ? state.workspaces : [],
      idea: state?.idea || null,
      stage: String(state?.stage || ""),
      narrowState: Array.isArray(state?.narrowState) ? state.narrowState : [],
      todos: Array.isArray(state?.todos) ? state.todos : [],
      skills: Array.isArray(state?.skills) ? state.skills.filter((skill) => skill?.status === "active") : [],
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO meta(key,value,updated_at) VALUES('capsule',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(JSON.stringify(capsule), capsule.updatedAt);
    return Object.freeze(capsule);
  }

  loadCapsule() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='capsule'").get();
    if (!row) return null;
    const capsule = JSON.parse(row.value);
    if (capsule?.schema !== 1 || capsule?.projectId !== this.projectId) return null;
    return Object.freeze(capsule);
  }

  loadBlocksByIds(blockIds = [], { excludeEntryIds = [] } = {}) {
    const ids = [...new Set((blockIds || []).filter(Boolean))].slice(0, 64);
    if (!ids.length) return [];
    const excluded = new Set((excludeEntryIds || []).filter(Boolean));
    const placeholders = ids.map(() => "?").join(",");
    const selected = new Map();
    const add = (row) => {
      if (!row || excluded.has(row.entry_id) || selected.has(row.block_id)) return;
      selected.set(row.block_id, row);
    };
    const roots = this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order
      FROM blocks b JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
      WHERE b.fact_candidate=1 AND b.block_id IN (${placeholders}) ORDER BY b.ledger_order`).all(...ids);
    for (const row of roots) add(row);
    const islandIds = [...new Set(roots.map((row) => {
      const block = JSON.parse(row.block_json);
      return block.assemblyIslandId || block.dialogueBlockId;
    }).filter(Boolean))];
    for (const islandId of islandIds) {
      for (const row of this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order
        FROM blocks b JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
        WHERE b.fact_candidate=1 AND b.dialogue_block_id=? ORDER BY b.ledger_order`).all(islandId)) add(row);
    }
    return [...selected.values()].map(hydrate).sort((left, right) => left.provenance.ledgerOrder - right.provenance.ledgerOrder);
  }

  saveContinuationFrame({ sessionId, ideaHash = null, stageHash = null, supportingBlockIds = [] } = {}) {
    if (!sessionId) throw new Error("saveContinuationFrame requires sessionId");
    const latest = this.db.prepare(`SELECT b.loop_id FROM blocks b
      JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
      WHERE b.session_id=? AND b.fact_candidate=1 AND b.loop_id IS NOT NULL
      ORDER BY b.ledger_order DESC LIMIT 1`).get(sessionId);
    if (!latest?.loop_id) return null;
    const currentRows = this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order FROM blocks b
      JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
      WHERE b.session_id=? AND b.loop_id=? AND b.fact_candidate=1 ORDER BY b.ledger_order`).all(sessionId, latest.loop_id);
    const currentBlocks = currentRows.map(hydrate);
    const currentLoopBlockIds = currentBlocks.map((block) => block.blockId);
    const supportingBlocks = this.loadBlocksByIds(supportingBlockIds)
      .filter((block) => !currentLoopBlockIds.includes(block.blockId))
      .slice(-CONTEXT_POLICY.retrieval.returnedCandidateLimit);
    const frame = {
      schema: 1,
      projectId: this.projectId,
      workspace: this.workspace,
      ideaHash,
      stageHash,
      sessionId,
      loopId: latest.loop_id,
      currentLoopBlockIds,
      dialogueBlockIds: currentBlocks.filter((block) => block.sliceType === "dialogue").map((block) => block.blockId),
      toolEvidenceBlockIds: currentBlocks.filter((block) => block.sliceType === "tool-evidence").map((block) => block.blockId),
      supportingBlockIds: supportingBlocks.map((block) => block.blockId),
      updatedAt: new Date().toISOString(),
    };
    frame.allBlockIds = [...new Set([...frame.currentLoopBlockIds, ...frame.supportingBlockIds])];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO meta(key,value,updated_at) VALUES('continuation-frame',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(JSON.stringify(frame), frame.updatedAt);
      this.db.prepare("DELETE FROM continuation_frame_blocks").run();
      const pin = this.db.prepare("INSERT OR IGNORE INTO continuation_frame_blocks(block_id) VALUES(?)");
      for (const blockId of frame.allBlockIds) pin.run(blockId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return Object.freeze(frame);
  }

  loadContinuationFrame({ ideaHash = null, stageHash = null } = {}) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='continuation-frame'").get();
    if (!row) return null;
    const frame = JSON.parse(row.value);
    if (frame?.schema !== 1 || frame?.projectId !== this.projectId) return null;
    if (ideaHash && frame.ideaHash !== ideaHash) return null;
    if ((stageHash || frame.stageHash) && frame.stageHash !== stageHash) return null;
    return Object.freeze(frame);
  }

  ingestEntries(entries = [], {
    sessionId,
    sessionFile = null,
    activeEntries = null,
    activeEntryIds = null,
    initialState = null,
  } = {}) {
    if (!sessionId) throw new Error("ingestEntries requires sessionId");
    let researchState = this.sessionStates.get(sessionId) || structuredClone(initialState || emptyState());
    let loopId = this.sessionLoopIds.get(sessionId) || null;
    const messages = [];
    for (const entry of entries) {
      if (entry?.type === "custom" && entry?.customType === STATE_TYPE) {
        researchState = applyEvent(researchState, entry.data);
        continue;
      }
      if (entry?.type !== "message" || !entry.message) continue;
      if (entry.message.role === "user") loopId = entry.id;
      if (!loopId) loopId = entry.id;
      messages.push({
        ...entry.message,
        sessionId,
        entryId: entry.id,
        parentEntryId: entry.parentId,
        entryTimestamp: entry.timestamp,
        loopId,
        recoverableRef: `${sessionFile || sessionId}#${entry.id}`,
        researchIdeaHash: entry.message.researchIdeaHash ?? researchState.idea?.hash ?? null,
        researchIdeaVersion: entry.message.researchIdeaVersion ?? researchState.idea?.version ?? null,
        researchStageHash: entry.message.researchStageHash ?? (researchState.stage ? sha256(researchState.stage) : null),
      });
    }
    this.sessionStates.set(sessionId, researchState);
    this.sessionLoopIds.set(sessionId, loopId);
    const blocks = blockizeMessages(messages);
    const insertBlock = this.db.prepare(`INSERT OR IGNORE INTO blocks(
      block_id,session_id,entry_id,parent_entry_id,entry_timestamp,kind,role,call_id,
      raw,raw_hash,refs,fact_candidate,unresolved,idea_hash,idea_version,stage_hash,
      logical_event_id,loop_id,dialogue_block_id,recoverable_ref,ingested_at,last_access_at,access_count,block_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`);
    const insertFts = this.db.prepare("INSERT INTO blocks_fts(block_id,raw,refs) VALUES(?,?,?)");
    const backfillBlockContext = this.db.prepare(`UPDATE blocks
      SET idea_hash=COALESCE(idea_hash,?),
          idea_version=COALESCE(idea_version,?),
          stage_hash=COALESCE(stage_hash,?),
          logical_event_id=COALESCE(logical_event_id,?),
          loop_id=COALESCE(loop_id,?),
          dialogue_block_id=COALESCE(dialogue_block_id,?),
          recoverable_ref=COALESCE(recoverable_ref,?),
          ingested_at=COALESCE(ingested_at,?),
          block_json=?
      WHERE block_id=?`);
    let inserted = 0;
    const now = new Date().toISOString();
    const insertEdge = this.db.prepare("INSERT OR IGNORE INTO block_edges(src_block_id,dst_block_id,relation) VALUES(?,?,?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const block of blocks) {
        const result = insertBlock.run(
          block.blockId,
          sessionId,
          block.provenance.entryId,
          block.provenance.parentEntryId,
          block.provenance.entryTimestamp == null ? null : String(block.provenance.entryTimestamp),
          block.kind,
          block.role,
          block.callId,
          block.raw,
          block.rawHash,
          block.refs.join(" "),
          block.factCandidate ? 1 : 0,
          block.unresolved ? 1 : 0,
          block.researchIdeaHash,
          block.researchIdeaVersion,
          block.researchStageHash,
          block.logicalEventId,
          block.loopId,
          block.assemblyIslandId || block.dialogueBlockId,
          block.recoverableRef,
          now,
          null,
          JSON.stringify(block),
        );
        if (Number(result.changes) === 0) {
          // Databases created before research-state coordinates existed retain
          // their immutable block ids and FTS rows. Replaying the raw session
          // after an upgrade deterministically supplies the missing coordinates
          // without duplicating either the ledger block or its search entry.
          backfillBlockContext.run(
            block.researchIdeaHash,
            block.researchIdeaVersion,
            block.researchStageHash,
            block.logicalEventId,
            block.loopId,
            block.assemblyIslandId || block.dialogueBlockId,
            block.recoverableRef,
            now,
            JSON.stringify(block),
            block.blockId,
          );
          continue;
        }
        insertFts.run(block.blockId, block.raw, block.refs.join(" "));
        inserted += 1;
      }
      for (const block of blocks) {
        const relations = [
          ...(block.dependsOn || []).map((id) => [id, "depends_on"]),
          ...(block.contradicts || []).map((id) => [id, "contradicts"]),
          ...(block.validates || []).map((id) => [id, "validates"]),
          ...(block.supersedes || []).map((id) => [id, "supersedes"]),
          ...(block.resolvedBy ? [[block.resolvedBy, "resolved_by"]] : []),
        ];
        for (const [target, relation] of relations) {
          insertEdge.run(block.blockId, target, relation);
          insertEdge.run(target, block.blockId, relation);
        }
        if (block.callId) {
          const peers = this.db.prepare("SELECT block_id FROM blocks WHERE call_id=? AND block_id<>?").all(block.callId, block.blockId);
          for (const peer of peers) {
            insertEdge.run(block.blockId, peer.block_id, "call_pair");
            insertEdge.run(peer.block_id, block.blockId, "call_pair");
          }
        }
        if (block.requiresEventClosure) {
          const peers = this.db.prepare("SELECT block_id FROM blocks WHERE logical_event_id=? AND block_id<>?").all(block.logicalEventId, block.blockId);
          for (const peer of peers) {
            insertEdge.run(block.blockId, peer.block_id, "forced_event_closure");
            insertEdge.run(peer.block_id, block.blockId, "forced_event_closure");
          }
        }
        const islandId = block.assemblyIslandId || block.dialogueBlockId;
        if (islandId && block.factCandidate) {
          const peers = this.db.prepare("SELECT block_id FROM blocks WHERE dialogue_block_id=? AND fact_candidate=1 AND block_id<>?").all(islandId, block.blockId);
          for (const peer of peers) {
            insertEdge.run(block.blockId, peer.block_id, "dialogue_block");
            insertEdge.run(peer.block_id, block.blockId, "dialogue_block");
          }
        }
      }
      this.db.prepare(`INSERT INTO sessions(session_id,session_file,last_seen_at) VALUES(?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET session_file=excluded.session_file,last_seen_at=excluded.last_seen_at`)
        .run(sessionId, sessionFile, new Date().toISOString());
      if (Array.isArray(activeEntries) || Array.isArray(activeEntryIds)) {
        this.db.prepare("DELETE FROM active_entries WHERE session_id=?").run(sessionId);
        const markActive = this.db.prepare("INSERT OR IGNORE INTO active_entries(session_id,entry_id) VALUES(?,?)");
        const ids = Array.isArray(activeEntryIds)
          ? activeEntryIds
          : activeEntries.filter((entry) => entry?.type === "message" && entry.id).map((entry) => entry.id);
        for (const id of ids) if (id) markActive.run(sessionId, id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      entries: messages.length,
      blocks: blocks.length,
      inserted,
      lastLoopId: loopId,
      lastLoopBlockIds: blocks.filter((block) => block.loopId === loopId && block.factCandidate).map((block) => block.blockId),
    };
  }

  searchBlocks(query, {
    limit = 24,
    excludeSessionId = null,
    excludeEntryIds = [],
    activeIdeaHash = null,
    activeStageHash = null,
  } = {}) {
    const hardLimit = Math.max(1, Math.min(100, Number(limit) || 24));
    const candidateLimit = hardLimit * 3;
    const excludedEntries = new Set((excludeEntryIds || []).filter(Boolean));
    const fetchLimit = candidateLimit + Math.min(256, excludedEntries.size * 2);
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const rows = new Map();
    const add = (items) => {
      for (const row of items) {
        if (excludedEntries.has(row.entry_id) || rows.has(row.block_id)) continue;
        rows.set(row.block_id, row);
      }
    };
    const match = terms.map(ftsPhrase).join(" OR ");
    try {
      if (activeStageHash) {
        add(this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order
          FROM blocks_fts JOIN blocks b ON b.block_id=blocks_fts.block_id
          JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
          WHERE blocks_fts MATCH ? AND b.fact_candidate=1 AND b.stage_hash=?
            AND (? IS NULL OR b.session_id<>?)
          ORDER BY bm25(blocks_fts),b.ledger_order DESC LIMIT ?`)
          .all(match, activeStageHash, excludeSessionId, excludeSessionId, hardLimit + excludedEntries.size));
      }
      if (activeIdeaHash) {
        add(this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order
          FROM blocks_fts JOIN blocks b ON b.block_id=blocks_fts.block_id
          JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
          WHERE blocks_fts MATCH ? AND b.fact_candidate=1 AND b.idea_hash=?
            AND (? IS NULL OR b.session_id<>?)
          ORDER BY bm25(blocks_fts),b.ledger_order DESC LIMIT ?`)
          .all(match, activeIdeaHash, excludeSessionId, excludeSessionId, hardLimit + excludedEntries.size));
      }
      add(this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order
        FROM blocks_fts JOIN blocks b ON b.block_id=blocks_fts.block_id
        JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
        WHERE blocks_fts MATCH ? AND b.fact_candidate=1
          AND (? IS NULL OR b.session_id<>?)
        ORDER BY bm25(blocks_fts),b.ledger_order DESC LIMIT ?`)
        .all(match, excludeSessionId, excludeSessionId, fetchLimit));
    } catch {
      // LIKE below remains a deterministic fallback if this SQLite build has
      // different FTS tokenization for the query language.
    }
    // LIKE is a compatibility fallback for SQLite builds/tokenizers where FTS
    // cannot answer the query. Once FTS has evidence, a second full scan adds
    // latency and distractors without increasing deterministic coverage.
    if (rows.size === 0) {
      const likeTerms = terms.slice(0, 6);
      const where = likeTerms.map(() => "LOWER(raw) LIKE ? ESCAPE '\\'").join(" OR ");
      const likeArgs = likeTerms.map((term) => likePattern(term));
      add(this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order FROM blocks b
        JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
        WHERE b.fact_candidate=1 AND (${where}) AND (? IS NULL OR b.session_id<>?)
        ORDER BY b.ledger_order DESC LIMIT ?`)
        .all(...likeArgs, excludeSessionId, excludeSessionId, fetchLimit));
    }

    const selected = new Map([...rows.values()].slice(0, candidateLimit).map((row) => [row.block_id, row]));
    const queue = [...selected.values()].map(hydrate);
    const seenCalls = new Set();
    const seenIslands = new Set();
    let relationSteps = 0;
    const addSelected = (row) => {
      if (!row || excludedEntries.has(row.entry_id) || selected.has(row.block_id)) return false;
      selected.set(row.block_id, row);
      queue.push(hydrate(row));
      return true;
    };
    while (queue.length) {
      const block = queue.shift();
      const islandId = block.assemblyIslandId || block.dialogueBlockId;
      if (islandId && !seenIslands.has(islandId)) {
        seenIslands.add(islandId);
        const islandRows = this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order FROM blocks b
          JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
          WHERE b.dialogue_block_id=? ORDER BY b.ledger_order`).all(islandId);
        for (const row of islandRows) addSelected(row);
      }
      if (relationSteps >= candidateLimit * 3) continue;
      relationSteps += 1;
      const relationIds = [...new Set([
        ...(block.dependsOn || []),
        ...(block.contradicts || []),
        ...(block.validates || []),
        ...(block.supersedes || []),
        block.resolvedBy,
      ].filter(Boolean))].filter((id) => !selected.has(id));
      if (relationIds.length) {
        const placeholders = relationIds.map(() => "?").join(",");
        for (const row of this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order FROM blocks b
          JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
          WHERE b.block_id IN (${placeholders})`).all(...relationIds)) {
          addSelected(row);
        }
      }
      if (block.callId && !seenCalls.has(block.callId)) {
        seenCalls.add(block.callId);
        for (const row of this.db.prepare(`SELECT b.block_id,b.entry_id,b.block_json,b.ledger_order FROM blocks b
          JOIN active_entries a ON a.session_id=b.session_id AND a.entry_id=b.entry_id
          WHERE b.call_id=? ORDER BY b.ledger_order`).all(block.callId)) {
          addSelected(row);
        }
      }
    }
    return [...selected.values()].map(hydrate).sort((left, right) => left.provenance.ledgerOrder - right.provenance.ledgerOrder);
  }

  countBlocks() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM blocks").get().n);
  }

  storageStats() {
    const pageCount = Number(this.db.prepare("PRAGMA page_count").get().page_count);
    const freePages = Number(this.db.prepare("PRAGMA freelist_count").get().freelist_count);
    const pageSize = Number(this.db.prepare("PRAGMA page_size").get().page_size);
    return Object.freeze({
      blocks: this.countBlocks(),
      pageCount,
      freePages,
      pageSize,
      physicalBytes: pageCount * pageSize,
      logicalBytes: Math.max(0, pageCount - freePages) * pageSize,
    });
  }

  touchBlocks(blockIds = [], at = new Date().toISOString()) {
    const ids = [...new Set(blockIds.filter(Boolean))];
    if (!ids.length) return 0;
    const touch = this.db.prepare("UPDATE blocks SET last_access_at=?,access_count=access_count+1 WHERE block_id=?");
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) changed += Number(touch.run(at, id).changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return changed;
  }

  pinBlock(blockId, reason = "user-pin") {
    const row = this.db.prepare("SELECT block_id FROM blocks WHERE block_id=?").get(blockId);
    if (!row) return false;
    this.db.prepare(`INSERT INTO retention_pins(block_id,reason,pinned_at) VALUES(?,?,?)
      ON CONFLICT(block_id) DO UPDATE SET reason=excluded.reason,pinned_at=excluded.pinned_at`)
      .run(blockId, String(reason), new Date().toISOString());
    return true;
  }

  unpinBlock(blockId) {
    return Number(this.db.prepare("DELETE FROM retention_pins WHERE block_id=?").run(blockId).changes) > 0;
  }

  planCleanup({
    softLogicalBytes = CONTEXT_POLICY.retention.softLogicalBytes,
    hardLogicalBytes = CONTEXT_POLICY.retention.hardLogicalBytes,
    minInactiveDays = CONTEXT_POLICY.retention.minInactiveDays,
    recentAccessDays = CONTEXT_POLICY.retention.recentAccessDays,
    keepRecentSessions = CONTEXT_POLICY.retention.keepRecentSessions,
    maxDeleteBlocks = CONTEXT_POLICY.retention.maxDeleteBlocksPerRun,
  } = {}) {
    const stats = this.storageStats();
    const overSoft = stats.logicalBytes > softLogicalBytes;
    if (!overSoft) return Object.freeze({ schema: 1, needed: false, stats, candidates: [], protectedCount: 0, targetBytes: 0 });
    const hardMode = stats.logicalBytes > hardLogicalBytes;
    const now = Date.now();
    const inactiveCutoff = new Date(now - minInactiveDays * 86400000).toISOString();
    const accessCutoff = new Date(now - recentAccessDays * 86400000).toISOString();
    const rows = this.db.prepare(`
      WITH RECURSIVE recent_sessions(session_id) AS (
        SELECT session_id FROM sessions ORDER BY last_seen_at DESC LIMIT ?
      ), roots(id) AS (
        SELECT block_id FROM retention_pins
        UNION SELECT block_id FROM continuation_frame_blocks
        UNION SELECT block_id FROM blocks WHERE unresolved=1
        UNION SELECT b.block_id FROM blocks b JOIN recent_sessions r ON r.session_id=b.session_id
        UNION SELECT block_id FROM blocks WHERE last_access_at IS NOT NULL AND last_access_at>=?
      ), protected(id) AS (
        SELECT id FROM roots
        UNION
        SELECT e.dst_block_id FROM block_edges e JOIN protected p ON p.id=e.src_block_id
      )
      SELECT b.block_id,b.kind,b.role,b.session_id,b.raw,b.recoverable_ref,
             b.ingested_at,b.last_access_at,b.entry_timestamp
      FROM blocks b
      WHERE NOT EXISTS(SELECT 1 FROM protected p WHERE p.id=b.block_id)
        AND b.recoverable_ref IS NOT NULL
        AND (?=1 OR COALESCE(b.last_access_at,b.ingested_at,b.entry_timestamp,'')<?)
      ORDER BY CASE
          WHEN b.fact_candidate=0 THEN 0
          WHEN b.kind LIKE 'assistant_%' THEN 1
          WHEN b.kind IN ('tool_result','bash_result') THEN 2
          WHEN b.kind='user_text' THEN 3
          ELSE 2 END,
        COALESCE(b.last_access_at,b.ingested_at,b.entry_timestamp,'') ASC,
        LENGTH(b.raw) DESC,
        b.ledger_order ASC
      LIMIT ?
    `).all(Math.max(0, keepRecentSessions), accessCutoff, hardMode ? 1 : 0, inactiveCutoff, Math.max(0, maxDeleteBlocks));
    const candidates = [];
    let plannedRawBytes = 0;
    const targetBytes = Math.max(0, stats.logicalBytes - softLogicalBytes);
    for (const row of rows) {
      const sourceFile = recoverableFile(row.recoverable_ref);
      if (!sourceFile) continue;
      const rawBytes = Buffer.byteLength(row.raw || "", "utf8");
      candidates.push(Object.freeze({
        blockId: row.block_id,
        kind: row.kind,
        sessionId: row.session_id,
        recoverableRef: row.recoverable_ref,
        sourceFile,
        rawBytes,
      }));
      plannedRawBytes += rawBytes;
      if (plannedRawBytes >= targetBytes) break;
    }
    const protectedCount = Number(this.db.prepare(`
      WITH RECURSIVE recent_sessions(session_id) AS (
        SELECT session_id FROM sessions ORDER BY last_seen_at DESC LIMIT ?
      ), roots(id) AS (
        SELECT block_id FROM retention_pins
        UNION SELECT block_id FROM continuation_frame_blocks
        UNION SELECT block_id FROM blocks WHERE unresolved=1
        UNION SELECT b.block_id FROM blocks b JOIN recent_sessions r ON r.session_id=b.session_id
        UNION SELECT block_id FROM blocks WHERE last_access_at IS NOT NULL AND last_access_at>=?
      ), protected(id) AS (
        SELECT id FROM roots UNION SELECT e.dst_block_id FROM block_edges e JOIN protected p ON p.id=e.src_block_id
      ) SELECT COUNT(*) AS n FROM protected
    `).get(Math.max(0, keepRecentSessions), accessCutoff).n);
    return Object.freeze({
      schema: 1,
      needed: true,
      hardMode,
      stats,
      targetBytes,
      plannedRawBytes,
      protectedCount,
      candidates,
      planDigest: digest(candidates.map((row) => row.blockId).join("|")),
    });
  }

  cleanup({ dryRun = true, authorized = false, ...options } = {}) {
    if (!dryRun && !authorized) throw new Error("Raw-cache cleanup requires explicit user authorization");
    const plan = this.planCleanup(options);
    if (!plan.needed) return Object.freeze({ ...plan, dryRun, deletedCount: 0, status: "below-soft-limit" });
    const startedAt = new Date().toISOString();
    const runId = digest(`${startedAt}\0${plan.planDigest}\0${dryRun}`).slice(0, 24);
    if (dryRun || !plan.candidates.length) {
      return Object.freeze({ ...plan, dryRun, runId, deletedCount: 0, status: dryRun ? "planned" : "protected-floor" });
    }
    const protectedSample = this.db.prepare(`SELECT block_id FROM retention_pins UNION SELECT block_id FROM blocks WHERE unresolved=1 LIMIT 256`).all().map((row) => row.block_id);
    const deleteFts = this.db.prepare("DELETE FROM blocks_fts WHERE block_id=?");
    const deleteEdges = this.db.prepare("DELETE FROM block_edges WHERE src_block_id=? OR dst_block_id=?");
    const deleteBlock = this.db.prepare("DELETE FROM blocks WHERE block_id=?");
    let deletedCount = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of plan.candidates) {
        deleteFts.run(candidate.blockId);
        deleteEdges.run(candidate.blockId, candidate.blockId);
        deletedCount += Number(deleteBlock.run(candidate.blockId).changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const deletedStillPresent = plan.candidates.reduce((sum, row) => sum + Number(Boolean(this.db.prepare("SELECT 1 FROM blocks WHERE block_id=?").get(row.blockId))), 0);
    const protectedMissing = protectedSample.reduce((sum, id) => sum + Number(!this.db.prepare("SELECT 1 FROM blocks WHERE block_id=?").get(id)), 0);
    if (deletedStillPresent || protectedMissing) throw new Error(`Cleanup verification failed: deletedStillPresent=${deletedStillPresent}, protectedMissing=${protectedMissing}`);
    const after = this.storageStats();
    const detail = { deletedStillPresent, protectedMissing, protectedSample: protectedSample.length };
    this.db.prepare(`INSERT INTO cleanup_runs(run_id,started_at,finished_at,dry_run,before_logical_bytes,after_logical_bytes,candidate_count,deleted_count,plan_digest,status,detail_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(runId, startedAt, new Date().toISOString(), 0, plan.stats.logicalBytes, after.logicalBytes, plan.candidates.length, deletedCount, plan.planDigest, "verified", JSON.stringify(detail));
    this.db.prepare(`DELETE FROM cleanup_runs WHERE run_id NOT IN (
      SELECT run_id FROM cleanup_runs ORDER BY started_at DESC LIMIT ?
    )`).run(CONTEXT_POLICY.retention.maxAuditRuns);
    return Object.freeze({ ...plan, dryRun: false, runId, deletedCount, after, verification: detail, status: "verified" });
  }

  cleanupIfDue(options = {}) {
    return Object.freeze({
      status: "automatic-cleanup-disabled",
      capacityReviewBytes: CONTEXT_POLICY.retention.capacityReviewBytes,
      options,
    });
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
