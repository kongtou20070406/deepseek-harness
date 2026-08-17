import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  changedIdeaFields,
  formatLineDiff,
  normalizeIdeaDocument,
  renderIdeaDocument,
  sha256,
  validateCandidateAgainstBase,
} from "./idea-document.js";
import { ensureIdeaDirectories } from "./paths.js";
import { NATIVE_COMPACTION_INDEX_LIMIT } from "./native-compaction.js";

export class IdeaStateError extends Error {
  constructor(message, code = "IDEA_STATE_ERROR") {
    super(message);
    this.name = "IdeaStateError";
    this.code = code;
  }
}

export class IdeaIntegrityError extends IdeaStateError {
  constructor(message) {
    super(message, "IDEA_INTEGRITY_CONFLICT");
    this.name = "IdeaIntegrityError";
  }
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortedJsonValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortedJsonValue(value));
}

function parseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeEvidenceRefs(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function normalizeP1(content) {
  if (typeof content !== "string") throw new IdeaStateError("P1 必须是文本", "INVALID_P1");
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  return normalized ? `${normalized}\n` : "";
}

function ideaRow(row) {
  if (!row) return null;
  return {
    version: Number(row.version),
    parentVersion: row.parent_version === null ? null : Number(row.parent_version),
    content: row.content,
    hash: row.hash,
    author: row.author,
    reason: row.reason,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    createdAt: row.created_at,
  };
}

function proposalRow(row) {
  if (!row) return null;
  const affectedFields = parseJson(row.affected_fields_json, []);
  return {
    id: row.id,
    baseVersion: Number(row.base_version),
    baseHash: row.base_hash,
    revision: Number(row.revision),
    candidateContent: row.candidate_content,
    candidateHash: row.candidate_hash,
    rationale: row.rationale,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    affectedFields,
    routeChanged: affectedFields.some((field) => ["route", "routeMechanism", "routeBoundary"].includes(field)),
    status: row.status,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decisionActor: row.decision_actor,
  };
}

function lunaSnapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    parentId: row.parent_id,
    ideaVersion: Number(row.idea_version),
    ideaHash: row.idea_hash,
    routeVersion: Number(row.route_version),
    p1Version: Number(row.p1_version),
    sessionId: row.session_id,
    sourceLeafId: row.source_leaf_id,
    cutoffTimestamp: Number(row.cutoff_timestamp),
    trigger: row.trigger,
    task: row.task,
    constraints: parseJson(row.constraints_json, []),
    modelProvider: row.model_provider,
    modelId: row.model_id,
    candidateCount: Number(row.candidate_count),
    candidateTokens: Number(row.candidate_tokens),
    candidateHash: row.candidate_hash,
    selection: parseJson(row.selection_json, { selected: [], conflicts: [], excluded: [] }),
    packetContent: row.packet_content,
    packetHash: row.packet_hash,
    packetTokens: Number(row.packet_tokens),
    usage: parseJson(row.usage_json, null),
    diff: parseJson(row.diff_json, null),
    status: row.status,
    createdAt: row.created_at,
  };
}

function nativeCompactionSetRow(row) {
  if (!row) return null;
  return {
    compactionId: row.compaction_id,
    sessionId: row.session_id,
    reason: row.reason,
    summaryHash: row.summary_hash,
    tokensBefore: Number(row.tokens_before),
    blocks: parseJson(row.blocks_json, []),
    createdAt: row.created_at,
  };
}

export class IdeaStateStore {
  constructor(root) {
    this.paths = ensureIdeaDirectories(root);
    this.db = new DatabaseSync(this.paths.state);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.#createSchema();
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idea_versions (
        version INTEGER PRIMARY KEY,
        parent_version INTEGER,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        author TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(parent_version) REFERENCES idea_versions(version)
      );

      CREATE TABLE IF NOT EXISTS p1_versions (
        version INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idea_change_proposals (
        id TEXT PRIMARY KEY,
        base_version INTEGER NOT NULL,
        base_hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        candidate_content TEXT NOT NULL,
        candidate_hash TEXT NOT NULL,
        rationale TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        affected_fields_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected', 'stale')),
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        decision_actor TEXT,
        FOREIGN KEY(base_version) REFERENCES idea_versions(version)
      );

      CREATE TABLE IF NOT EXISTS proposal_revisions (
        proposal_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        candidate_content TEXT NOT NULL,
        candidate_hash TEXT NOT NULL,
        rationale TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        affected_fields_json TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(proposal_id, revision),
        FOREIGN KEY(proposal_id) REFERENCES idea_change_proposals(id)
      );

      CREATE TABLE IF NOT EXISTS context_manifests (
        invocation_id TEXT PRIMARY KEY,
        packet_id TEXT NOT NULL,
        idea_version INTEGER NOT NULL,
        idea_hash TEXT NOT NULL,
        p0_hash TEXT NOT NULL,
        p1_hash TEXT NOT NULL,
        packet_hash TEXT NOT NULL,
        actual_context_hash TEXT NOT NULL,
        p0_tokens INTEGER NOT NULL,
        p1_tokens INTEGER NOT NULL,
        dynamic_tokens INTEGER NOT NULL,
        effective_input_budget INTEGER NOT NULL,
        model_context_window INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS luna_snapshots (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        idea_version INTEGER NOT NULL,
        idea_hash TEXT NOT NULL,
        route_version INTEGER NOT NULL,
        p1_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        source_leaf_id TEXT,
        cutoff_timestamp INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        task TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        candidate_count INTEGER NOT NULL,
        candidate_tokens INTEGER NOT NULL,
        candidate_hash TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        packet_content TEXT NOT NULL,
        packet_hash TEXT NOT NULL,
        packet_tokens INTEGER NOT NULL,
        usage_json TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'disabled')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(parent_id) REFERENCES luna_snapshots(id),
        FOREIGN KEY(idea_version) REFERENCES idea_versions(version)
      );

      CREATE TABLE IF NOT EXISTS native_compaction_sets (
        compaction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        summary_hash TEXT NOT NULL,
        tokens_before INTEGER NOT NULL,
        blocks_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS main_session (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        session_id TEXT NOT NULL,
        session_file TEXT,
        assigned_at TEXT NOT NULL,
        assigned_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS controller_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        session_id TEXT NOT NULL,
        session_file TEXT,
        client_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS proposals_status_idx
        ON idea_change_proposals(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS manifests_created_idx
        ON context_manifests(created_at DESC);
      CREATE INDEX IF NOT EXISTS luna_snapshots_status_idx
        ON luna_snapshots(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS native_compaction_sets_session_idx
        ON native_compaction_sets(session_id, created_at DESC);
    `);
  }

  close() {
    this.db.close();
  }

  #transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  #deleteMeta(key) {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  isInitialized() {
    return Boolean(this.getCurrentIdea());
  }

  getIdeaId() {
    return this.getMeta("idea_id");
  }

  getCurrentRouteVersion(content) {
    const stored = Number(this.getMeta("route_version"));
    if (Number.isSafeInteger(stored) && stored > 0) {
      if (Number(this.getMeta("schema_version")) < 2) this.#setMeta("schema_version", "2");
      return stored;
    }

    // One-time compatibility migration for V0 documents that embedded vN in P0.
    const legacyContent = content ?? ideaRow(
      this.db.prepare("SELECT * FROM idea_versions ORDER BY version DESC LIMIT 1").get(),
    )?.content ?? "";
    const legacy = /^当前路线 v([1-9]\d*)：$/m.exec(legacyContent);
    const migrated = legacy ? Number(legacy[1]) : 1;
    this.#setMeta("route_version", migrated);
    this.#setMeta("schema_version", "2");
    return migrated;
  }

  getInitializationDraft() {
    const rawContent = this.getMeta("initialization_raw_content");
    if (rawContent === null) return null;
    const candidateContent = this.getMeta("initialization_candidate_content");
    return {
      rawContent,
      rawHash: sha256(rawContent),
      candidateContent,
      candidateHash: candidateContent === null ? null : sha256(candidateContent),
      rationale: this.getMeta("initialization_rationale") ?? "",
      updatedAt: this.getMeta("initialization_updated_at"),
    };
  }

  beginInitializationDraft(rawContent, { actor = "user" } = {}) {
    if (this.isInitialized()) {
      throw new IdeaStateError("Idea Space 已初始化，后续修改必须使用提案", "ALREADY_INITIALIZED");
    }
    const raw = normalizeIdeaDocument(rawContent);
    const updatedAt = new Date().toISOString();
    return this.#transaction(() => {
      this.#setMeta("initialization_raw_content", raw);
      this.#deleteMeta("initialization_candidate_content");
      this.#deleteMeta("initialization_rationale");
      this.#setMeta("initialization_updated_at", updatedAt);
      this.appendEvent("idea_initialization_started", actor, { rawHash: sha256(raw) });
      return this.getInitializationDraft();
    });
  }

  saveInitializationCandidate(candidateContent, { actor = "main", rationale = "AI organized initial Idea" } = {}) {
    if (this.isInitialized()) {
      throw new IdeaStateError("Idea Space 已初始化，不能再提交初始化候选", "ALREADY_INITIALIZED");
    }
    const draft = this.getInitializationDraft();
    if (!draft) throw new IdeaStateError("尚无原始 Idea 草稿；请先运行 /idea-init", "NO_INITIALIZATION_DRAFT");
    const candidate = normalizeIdeaDocument(candidateContent);
    const updatedAt = new Date().toISOString();
    return this.#transaction(() => {
      this.#setMeta("initialization_candidate_content", candidate);
      this.#setMeta("initialization_rationale", String(rationale ?? "").trim() || "AI organized initial Idea");
      this.#setMeta("initialization_updated_at", updatedAt);
      this.appendEvent("idea_initialization_candidate_saved", actor, {
        rawHash: draft.rawHash,
        candidateHash: sha256(candidate),
        rationale: String(rationale ?? "").trim(),
      });
      return this.getInitializationDraft();
    });
  }

  clearInitializationDraft({ actor = "user", reason = "initialization cancelled" } = {}) {
    const draft = this.getInitializationDraft();
    if (!draft) return null;
    return this.#transaction(() => {
      this.#deleteMeta("initialization_raw_content");
      this.#deleteMeta("initialization_candidate_content");
      this.#deleteMeta("initialization_rationale");
      this.#deleteMeta("initialization_updated_at");
      this.appendEvent("idea_initialization_cleared", actor, { rawHash: draft.rawHash, reason });
      return draft;
    });
  }

  initializeIdeaFromContent(content, { sourceText = content, actor = "user", reason = "initial idea" } = {}) {
    if (this.isInitialized()) {
      throw new IdeaStateError("Idea Space 已初始化，后续修改必须使用提案", "ALREADY_INITIALIZED");
    }

    const canonical = normalizeIdeaDocument(content);
    const source = typeof sourceText === "string" && sourceText.length > 0 ? sourceText : canonical;
    const createdAt = new Date().toISOString();
    const ideaId = randomUUID();
    const ideaHash = sha256(canonical);
    const sourceHash = sha256(source);

    return this.#transaction(() => {
      writeFileSync(this.paths.idea, canonical, "utf8");
      writeFileSync(this.paths.source, source, "utf8");
      writeFileSync(this.paths.p1, "", "utf8");
      this.db.prepare(`
        INSERT INTO idea_versions(
          version, parent_version, content, hash, author, reason, evidence_refs_json, created_at
        ) VALUES (1, NULL, ?, ?, ?, ?, '[]', ?)
      `).run(canonical, ideaHash, actor, reason, createdAt);
      this.db.prepare(`
        INSERT INTO p1_versions(version, content, hash, actor, reason, source_refs_json, created_at)
        VALUES (1, '', ?, ?, 'initial empty P1', '[]', ?)
      `).run(sha256(""), actor, createdAt);
      this.#setMeta("idea_id", ideaId);
      this.#setMeta("idea_source_hash", sourceHash);
      this.#setMeta("route_version", "1");
      this.#setMeta("schema_version", "2");
      this.#deleteMeta("initialization_raw_content");
      this.#deleteMeta("initialization_candidate_content");
      this.#deleteMeta("initialization_rationale");
      this.#deleteMeta("initialization_updated_at");
      this.appendEvent("idea_initialized", actor, {
        ideaId,
        ideaVersion: 1,
        routeVersion: 1,
        ideaHash,
        sourceHash,
      });
      return this.getCurrentIdea();
    });
  }

  initializeIdea(fields, options = {}) {
    return this.initializeIdeaFromContent(renderIdeaDocument(fields), options);
  }

  getCurrentIdea() {
    const current = ideaRow(this.db.prepare("SELECT * FROM idea_versions ORDER BY version DESC LIMIT 1").get());
    return current ? { ...current, routeVersion: this.getCurrentRouteVersion(current.content) } : null;
  }

  getIdeaVersion(version) {
    return ideaRow(this.db.prepare("SELECT * FROM idea_versions WHERE version = ?").get(version));
  }

  getIdeaHistory(limit = 20) {
    return this.db.prepare("SELECT * FROM idea_versions ORDER BY version DESC LIMIT ?").all(limit).map(ideaRow);
  }

  getCurrentP1() {
    const row = this.db.prepare("SELECT * FROM p1_versions ORDER BY version DESC LIMIT 1").get();
    if (!row) return { version: 0, content: "", hash: sha256("") };
    return {
      version: Number(row.version),
      content: row.content,
      hash: row.hash,
      actor: row.actor,
      reason: row.reason,
      sourceRefs: parseJson(row.source_refs_json, []),
      createdAt: row.created_at,
    };
  }

  updateP1(content, { actor = "main", reason = "P1 update", sourceRefs = [] } = {}) {
    if (!this.isInitialized()) throw new IdeaStateError("Idea Space 尚未初始化", "NOT_INITIALIZED");
    this.assertIntegrity();
    const normalized = normalizeP1(content);
    const current = this.getCurrentP1();
    if (normalized === current.content) return current;
    const nextVersion = current.version + 1;
    const hash = sha256(normalized);
    const createdAt = new Date().toISOString();
    const refs = normalizeEvidenceRefs(sourceRefs);
    const previousDisk = readFileSync(this.paths.p1, "utf8");

    try {
      return this.#transaction(() => {
        writeFileSync(this.paths.p1, normalized, "utf8");
        this.db.prepare(`
          INSERT INTO p1_versions(version, content, hash, actor, reason, source_refs_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(nextVersion, normalized, hash, actor, reason, canonicalJson(refs), createdAt);
        this.appendEvent("p1_updated", actor, {
          version: nextVersion,
          hash,
          reason,
          sourceRefs: refs,
        });
        return this.getCurrentP1();
      });
    } catch (error) {
      writeFileSync(this.paths.p1, previousDisk, "utf8");
      throw error;
    }
  }

  assertIntegrity() {
    const current = this.getCurrentIdea();
    if (!current) throw new IdeaIntegrityError("Idea Space 尚未初始化");
    if (!existsSync(this.paths.idea)) throw new IdeaIntegrityError("权威 IDEA.md 缺失");
    const diskIdea = readFileSync(this.paths.idea, "utf8");
    if (sha256(diskIdea) !== current.hash || diskIdea !== current.content) {
      throw new IdeaIntegrityError("IDEA.md 与已确认版本不一致；已停止模型调用，请通过 /idea 处理冲突");
    }

    const p1 = this.getCurrentP1();
    if (!existsSync(this.paths.p1)) throw new IdeaIntegrityError("受保护的 .harness/P1.md 缺失");
    const diskP1 = readFileSync(this.paths.p1, "utf8");
    if (sha256(diskP1) !== p1.hash || diskP1 !== p1.content) {
      throw new IdeaIntegrityError("P1.md 与已记录版本不一致；已停止模型调用，请通过 /context edit 处理冲突");
    }

    const expectedSourceHash = this.getMeta("idea_source_hash");
    if (!existsSync(this.paths.source) || sha256(readFileSync(this.paths.source, "utf8")) !== expectedSourceHash) {
      throw new IdeaIntegrityError("不可变 Idea Source 缺失或已改变");
    }
    return true;
  }

  createProposal({ candidateContent, routeChanged = true, rationale, evidenceRefs = [], actor = "main" }) {
    this.assertIntegrity();
    const current = this.getCurrentIdea();
    const built = validateCandidateAgainstBase(current.content, candidateContent);
    const affectedFields = [routeChanged ? "route" : "wording"];
    const id = randomUUID();
    const now = new Date().toISOString();
    const refs = normalizeEvidenceRefs(evidenceRefs);
    const candidateHash = sha256(built.candidate);

    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO idea_change_proposals(
          id, base_version, base_hash, revision, candidate_content, candidate_hash,
          rationale, evidence_refs_json, affected_fields_json, status, author, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        id,
        current.version,
        current.hash,
        built.candidate,
        candidateHash,
        String(rationale ?? "").trim() || "未提供理由",
        canonicalJson(refs),
        canonicalJson(affectedFields),
        actor,
        now,
        now,
      );
      this.#insertProposalRevision(id, 1, built.candidate, candidateHash, rationale, refs, affectedFields, actor, now);
      this.appendEvent("idea_change_proposed", actor, {
        proposalId: id,
        baseVersion: current.version,
        candidateHash,
        affectedFields,
        routeChanged: Boolean(routeChanged),
        rationale: String(rationale ?? "").trim(),
        evidenceRefs: refs,
      });
      return this.getProposal(id);
    });
  }

  #insertProposalRevision(id, revision, candidate, candidateHash, rationale, refs, fields, actor, createdAt) {
    this.db.prepare(`
      INSERT INTO proposal_revisions(
        proposal_id, revision, candidate_content, candidate_hash, rationale,
        evidence_refs_json, affected_fields_json, author, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      revision,
      candidate,
      candidateHash,
      String(rationale ?? "").trim() || "未提供理由",
      canonicalJson(refs),
      canonicalJson(fields),
      actor,
      createdAt,
    );
  }

  getProposal(id) {
    return proposalRow(this.db.prepare("SELECT * FROM idea_change_proposals WHERE id = ?").get(id));
  }

  listPendingProposals() {
    return this.db
      .prepare("SELECT * FROM idea_change_proposals WHERE status = 'pending' ORDER BY updated_at DESC")
      .all()
      .map(proposalRow);
  }

  updateProposal(id, { candidateContent, routeChanged, rationale, evidenceRefs, actor = "main" }) {
    this.assertIntegrity();
    const proposal = this.getProposal(id);
    if (!proposal) throw new IdeaStateError(`找不到提案 ${id}`, "PROPOSAL_NOT_FOUND");
    if (proposal.status !== "pending") throw new IdeaStateError(`提案 ${id} 已是 ${proposal.status}`, "PROPOSAL_NOT_PENDING");
    const base = this.getIdeaVersion(proposal.baseVersion);
    const current = this.getCurrentIdea();
    if (!base || current.version !== proposal.baseVersion || current.hash !== proposal.baseHash) {
      throw new IdeaStateError("提案基于旧 Idea 版本，必须重新讨论后创建提案", "STALE_PROPOSAL");
    }

    const built = validateCandidateAgainstBase(
      base.content,
      normalizeIdeaDocument(candidateContent ?? proposal.candidateContent),
    );
    const nextRouteChanged = routeChanged === undefined ? proposal.routeChanged : Boolean(routeChanged);
    const affectedFields = [nextRouteChanged ? "route" : "wording"];
    const nextRevision = proposal.revision + 1;
    const candidateHash = sha256(built.candidate);
    const nextRationale = String(rationale ?? proposal.rationale).trim() || proposal.rationale;
    const refs = evidenceRefs === undefined ? proposal.evidenceRefs : normalizeEvidenceRefs(evidenceRefs);
    const now = new Date().toISOString();

    return this.#transaction(() => {
      this.db.prepare(`
        UPDATE idea_change_proposals
        SET revision = ?, candidate_content = ?, candidate_hash = ?, rationale = ?,
            evidence_refs_json = ?, affected_fields_json = ?, author = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextRevision,
        built.candidate,
        candidateHash,
        nextRationale,
        canonicalJson(refs),
        canonicalJson(affectedFields),
        actor,
        now,
        id,
      );
      this.#insertProposalRevision(
        id,
        nextRevision,
        built.candidate,
        candidateHash,
        nextRationale,
        refs,
        affectedFields,
        actor,
        now,
      );
      this.appendEvent("idea_change_proposal_revised", actor, {
        proposalId: id,
        revision: nextRevision,
        candidateHash,
        affectedFields,
        routeChanged: nextRouteChanged,
      });
      return this.getProposal(id);
    });
  }

  proposalDiff(id) {
    const proposal = this.getProposal(id);
    if (!proposal) throw new IdeaStateError(`找不到提案 ${id}`, "PROPOSAL_NOT_FOUND");
    const base = this.getIdeaVersion(proposal.baseVersion);
    if (!base) throw new IdeaStateError("提案的基础版本缺失", "MISSING_BASE_VERSION");
    return formatLineDiff(base.content, proposal.candidateContent);
  }

  commitProposal(id, { actor = "user", reason } = {}) {
    this.assertIntegrity();
    const proposal = this.getProposal(id);
    if (!proposal) throw new IdeaStateError(`找不到提案 ${id}`, "PROPOSAL_NOT_FOUND");
    if (proposal.status !== "pending") throw new IdeaStateError(`提案 ${id} 已是 ${proposal.status}`, "PROPOSAL_NOT_PENDING");
    const current = this.getCurrentIdea();
    if (current.version !== proposal.baseVersion || current.hash !== proposal.baseHash) {
      throw new IdeaStateError("当前 Idea 已变化，该提案不能提交", "STALE_PROPOSAL");
    }

    const validated = validateCandidateAgainstBase(current.content, proposal.candidateContent);
    const nextVersion = current.version + 1;
    const nextRouteVersion = current.routeVersion + (proposal.routeChanged ? 1 : 0);
    const nextHash = sha256(validated.candidate);
    const now = new Date().toISOString();
    const commitReason = String(reason ?? proposal.rationale).trim() || proposal.rationale;
    const previousDisk = readFileSync(this.paths.idea, "utf8");

    try {
      return this.#transaction(() => {
        writeFileSync(this.paths.idea, validated.candidate, "utf8");
        this.db.prepare(`
          INSERT INTO idea_versions(
            version, parent_version, content, hash, author, reason, evidence_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nextVersion,
          current.version,
          validated.candidate,
          nextHash,
          actor,
          commitReason,
          canonicalJson(proposal.evidenceRefs),
          now,
        );
        this.#setMeta("route_version", nextRouteVersion);
        this.db.prepare(`
          UPDATE idea_change_proposals
          SET status = 'accepted', decided_at = ?, decision_actor = ?, updated_at = ?
          WHERE id = ?
        `).run(now, actor, now, id);
        this.db.prepare(`
          UPDATE idea_change_proposals
          SET status = 'stale', decided_at = ?, decision_actor = 'system:new-version', updated_at = ?
          WHERE status = 'pending' AND id <> ?
        `).run(now, now, id);
        this.appendEvent("idea_version_committed", actor, {
          proposalId: id,
          parentVersion: current.version,
          version: nextVersion,
          routeVersion: nextRouteVersion,
          hash: nextHash,
          affectedFields: proposal.affectedFields,
          routeChanged: proposal.routeChanged,
          reason: commitReason,
          evidenceRefs: proposal.evidenceRefs,
        });
        return this.getCurrentIdea();
      });
    } catch (error) {
      writeFileSync(this.paths.idea, previousDisk, "utf8");
      throw error;
    }
  }

  rejectProposal(id, { actor = "user", reason = "user rejected" } = {}) {
    const proposal = this.getProposal(id);
    if (!proposal) throw new IdeaStateError(`找不到提案 ${id}`, "PROPOSAL_NOT_FOUND");
    if (proposal.status !== "pending") return proposal;
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.db.prepare(`
        UPDATE idea_change_proposals
        SET status = 'rejected', decided_at = ?, decision_actor = ?, updated_at = ?
        WHERE id = ?
      `).run(now, actor, now, id);
      this.appendEvent("idea_change_proposal_rejected", actor, { proposalId: id, reason });
      return this.getProposal(id);
    });
  }

  saveContextManifest(manifest) {
    this.db.prepare(`
      INSERT INTO context_manifests(
        invocation_id, packet_id, idea_version, idea_hash, p0_hash, p1_hash,
        packet_hash, actual_context_hash, p0_tokens, p1_tokens, dynamic_tokens,
        effective_input_budget, model_context_window, manifest_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      manifest.invocationId,
      manifest.packetId,
      manifest.ideaVersion,
      manifest.ideaHash,
      manifest.p0Hash,
      manifest.p1Hash,
      manifest.packetHash,
      manifest.actualContextHash,
      manifest.tokens.p0,
      manifest.tokens.p1,
      manifest.tokens.dynamic,
      manifest.budget.effectiveInput,
      manifest.budget.contextWindow,
      canonicalJson(manifest),
      manifest.createdAt,
    );
  }

  getLatestContextManifest() {
    const row = this.db.prepare("SELECT manifest_json FROM context_manifests ORDER BY rowid DESC LIMIT 1").get();
    return row ? parseJson(row.manifest_json, null) : null;
  }

  saveNativeCompactionSet(compaction, { actor = "system:pi-compaction" } = {}) {
    if (!compaction?.compactionId || !compaction?.sessionId || !compaction?.summaryHash) {
      throw new IdeaStateError("Pi 原生压缩块登记缺少必要字段", "INVALID_NATIVE_COMPACTION_SET");
    }
    const blocks = Array.isArray(compaction.blocks) ? compaction.blocks : [];
    return this.#transaction(() => {
      const previous = this.getLatestNativeCompactionSet(compaction.sessionId);
      this.db.prepare(`
        INSERT INTO native_compaction_sets(
          compaction_id, session_id, reason, summary_hash, tokens_before, blocks_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(compaction_id) DO UPDATE SET
          reason = excluded.reason,
          summary_hash = excluded.summary_hash,
          tokens_before = excluded.tokens_before,
          blocks_json = excluded.blocks_json,
          created_at = excluded.created_at
      `).run(
        compaction.compactionId,
        compaction.sessionId,
        compaction.reason ?? "unknown",
        compaction.summaryHash,
        Number(compaction.tokensBefore) || 0,
        canonicalJson(blocks),
        compaction.createdAt ?? new Date().toISOString(),
      );
      // Rebuildable inspection cache: retain only a bounded recent inventory.
      // Summary text remains solely in Pi's append-only session JSONL.
      this.db.prepare(`
        DELETE FROM native_compaction_sets
        WHERE session_id = ? AND compaction_id NOT IN (
          SELECT compaction_id FROM native_compaction_sets
          WHERE session_id = ? ORDER BY rowid DESC LIMIT ?
        )
      `).run(compaction.sessionId, compaction.sessionId, NATIVE_COMPACTION_INDEX_LIMIT);
      const previousByKind = new Map((previous?.blocks ?? []).map((block) => [block.kind, block.hash]));
      const currentByKind = new Map(blocks.map((block) => [block.kind, block.hash]));
      const added = blocks.filter((block) => !previousByKind.has(block.kind)).map((block) => block.kind);
      const updated = blocks.filter((block) => previousByKind.has(block.kind) && previousByKind.get(block.kind) !== block.hash).map((block) => block.kind);
      const retired = [...previousByKind.keys()].filter((kind) => !currentByKind.has(kind));
      this.appendEvent("native_compaction_blocks_indexed", actor, {
        compactionId: compaction.compactionId,
        sessionId: compaction.sessionId,
        reason: compaction.reason ?? "unknown",
        summaryHash: compaction.summaryHash,
        tokensBefore: Number(compaction.tokensBefore) || 0,
        blockCount: blocks.length,
        added,
        updated,
        retired,
      });
      return this.getNativeCompactionSet(compaction.compactionId);
    });
  }

  getNativeCompactionSet(compactionId) {
    return nativeCompactionSetRow(
      this.db.prepare("SELECT * FROM native_compaction_sets WHERE compaction_id = ?").get(compactionId),
    );
  }

  getLatestNativeCompactionSet(sessionId = null) {
    const row = sessionId
      ? this.db.prepare("SELECT * FROM native_compaction_sets WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(sessionId)
      : this.db.prepare("SELECT * FROM native_compaction_sets ORDER BY rowid DESC LIMIT 1").get();
    return nativeCompactionSetRow(row);
  }

  listNativeCompactionSets(sessionId, limit = NATIVE_COMPACTION_INDEX_LIMIT) {
    return this.db.prepare(`
      SELECT * FROM native_compaction_sets
      WHERE session_id = ? ORDER BY rowid DESC LIMIT ?
    `).all(sessionId, Math.max(1, Math.min(Number(limit) || NATIVE_COMPACTION_INDEX_LIMIT, NATIVE_COMPACTION_INDEX_LIMIT)))
      .map(nativeCompactionSetRow);
  }

  saveLunaSnapshot(snapshot, { actor = "luna" } = {}) {
    this.assertIntegrity();
    const idea = this.getCurrentIdea();
    const p1 = this.getCurrentP1();
    if (snapshot.ideaVersion !== idea.version || snapshot.ideaHash !== idea.hash) {
      throw new IdeaStateError("Luna 完成时 Idea 已变化；该结果未激活", "LUNA_IDEA_CHANGED");
    }
    if (snapshot.routeVersion !== idea.routeVersion || snapshot.p1Version !== p1.version) {
      throw new IdeaStateError("Luna 完成时路线或 P1 已变化；该结果未激活", "LUNA_STAGE_CHANGED");
    }
    if (!snapshot.id || !snapshot.task || !snapshot.packetContent) {
      throw new IdeaStateError("Luna 快照缺少必要字段", "INVALID_LUNA_SNAPSHOT");
    }

    return this.#transaction(() => {
      const previous = this.getActiveLunaSnapshot();
      this.db.prepare("UPDATE luna_snapshots SET status = 'superseded' WHERE status = 'active'").run();
      this.db.prepare(`
        INSERT INTO luna_snapshots(
          id, parent_id, idea_version, idea_hash, route_version, p1_version,
          session_id, source_leaf_id, cutoff_timestamp, trigger, task,
          constraints_json, model_provider, model_id, candidate_count,
          candidate_tokens, candidate_hash, selection_json, packet_content,
          packet_hash, packet_tokens, usage_json, diff_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(
        snapshot.id,
        snapshot.parentId ?? previous?.id ?? null,
        snapshot.ideaVersion,
        snapshot.ideaHash,
        snapshot.routeVersion,
        snapshot.p1Version,
        snapshot.sessionId,
        snapshot.sourceLeafId ?? null,
        snapshot.cutoffTimestamp,
        snapshot.trigger,
        snapshot.task,
        canonicalJson(snapshot.constraints ?? []),
        snapshot.modelProvider,
        snapshot.modelId,
        snapshot.candidateCount,
        snapshot.candidateTokens,
        snapshot.candidateHash,
        canonicalJson(snapshot.selection),
        snapshot.packetContent,
        snapshot.packetHash,
        snapshot.packetTokens,
        canonicalJson(snapshot.usage ?? null),
        canonicalJson(snapshot.diff ?? null),
        snapshot.createdAt,
      );
      this.appendEvent("luna_snapshot_activated", actor, {
        snapshotId: snapshot.id,
        parentId: snapshot.parentId ?? previous?.id ?? null,
        ideaVersion: snapshot.ideaVersion,
        ideaHash: snapshot.ideaHash,
        routeVersion: snapshot.routeVersion,
        p1Version: snapshot.p1Version,
        taskHash: sha256(snapshot.task),
        candidateHash: snapshot.candidateHash,
        packetHash: snapshot.packetHash,
        selectedCount: snapshot.selection?.selected?.length ?? 0,
        conflictCount: snapshot.selection?.conflicts?.length ?? 0,
        trigger: snapshot.trigger,
      });
      return this.getActiveLunaSnapshot();
    });
  }

  getLunaSnapshot(id) {
    return lunaSnapshotRow(this.db.prepare("SELECT * FROM luna_snapshots WHERE id = ?").get(id));
  }

  getActiveLunaSnapshot() {
    return lunaSnapshotRow(
      this.db.prepare("SELECT * FROM luna_snapshots WHERE status = 'active' ORDER BY rowid DESC LIMIT 1").get(),
    );
  }

  getLatestLunaSnapshot() {
    return lunaSnapshotRow(this.db.prepare("SELECT * FROM luna_snapshots ORDER BY rowid DESC LIMIT 1").get());
  }

  listLunaSnapshots(limit = 20) {
    return this.db.prepare("SELECT * FROM luna_snapshots ORDER BY rowid DESC LIMIT ?").all(limit).map(lunaSnapshotRow);
  }

  getLunaContextState() {
    const active = this.getActiveLunaSnapshot();
    if (!active) return { active: null, applicable: null, staleReason: null };
    const idea = this.getCurrentIdea();
    const p1 = this.getCurrentP1();
    let staleReason = null;
    if (active.ideaHash !== idea.hash || active.ideaVersion !== idea.version) staleReason = "idea-version-changed";
    else if (active.routeVersion !== idea.routeVersion) staleReason = "route-version-changed";
    else if (active.p1Version !== p1.version) staleReason = "p1-version-changed";
    return { active, applicable: staleReason ? null : active, staleReason };
  }

  disableActiveLunaSnapshot({ actor = "user", reason = "user disabled Luna context" } = {}) {
    const active = this.getActiveLunaSnapshot();
    if (!active) return null;
    return this.#transaction(() => {
      this.db.prepare("UPDATE luna_snapshots SET status = 'disabled' WHERE id = ?").run(active.id);
      this.appendEvent("luna_snapshot_disabled", actor, {
        snapshotId: active.id,
        packetHash: active.packetHash,
        reason,
      });
      return this.getLunaSnapshot(active.id);
    });
  }

  appendEvent(type, actor, payload) {
    const previous = this.db.prepare("SELECT event_hash FROM events ORDER BY sequence DESC LIMIT 1").get();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const previousHash = previous?.event_hash ?? null;
    const payloadJson = canonicalJson(payload ?? {});
    const eventHash = sha256(canonicalJson({ id, type, actor, payload: parseJson(payloadJson, {}), previousHash, createdAt }));
    this.db.prepare(`
      INSERT INTO events(id, type, actor, payload_json, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, actor, payloadJson, previousHash, eventHash, createdAt);
    return { id, type, actor, payload, previousHash, eventHash, createdAt };
  }

  verifyEventChain() {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY sequence ASC").all();
    let previousHash = null;
    for (const row of rows) {
      if (row.previous_hash !== previousHash) return false;
      const expected = sha256(canonicalJson({
        id: row.id,
        type: row.type,
        actor: row.actor,
        payload: parseJson(row.payload_json, {}),
        previousHash,
        createdAt: row.created_at,
      }));
      if (row.event_hash !== expected) return false;
      previousHash = row.event_hash;
    }
    return true;
  }

  getMainSession() {
    const row = this.db.prepare("SELECT * FROM main_session WHERE singleton = 1").get();
    return row ? {
      sessionId: row.session_id,
      sessionFile: row.session_file,
      assignedAt: row.assigned_at,
      assignedBy: row.assigned_by,
    } : null;
  }

  ensureMainSession(sessionId, sessionFile, actor = "system:first-session") {
    if (!sessionId) return this.getMainSession();
    const existing = this.getMainSession();
    if (existing) return existing;
    return this.#transaction(() => {
      const raced = this.getMainSession();
      if (raced) return raced;
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO main_session(singleton, session_id, session_file, assigned_at, assigned_by)
        VALUES (1, ?, ?, ?, ?)
      `).run(sessionId, sessionFile ?? null, now, actor);
      this.appendEvent("main_session_assigned", actor, { sessionId, sessionFile: sessionFile ?? null });
      return this.getMainSession();
    });
  }

  setMainSession(sessionId, sessionFile, actor = "user:takeover") {
    if (!sessionId) throw new IdeaStateError("无持久会话不能成为主对话", "EPHEMERAL_SESSION");
    return this.#transaction(() => {
      const previous = this.getMainSession();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO main_session(singleton, session_id, session_file, assigned_at, assigned_by)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          session_id = excluded.session_id,
          session_file = excluded.session_file,
          assigned_at = excluded.assigned_at,
          assigned_by = excluded.assigned_by
      `).run(sessionId, sessionFile ?? null, now, actor);
      this.db.prepare("DELETE FROM controller_lease WHERE singleton = 1").run();
      this.appendEvent("main_session_taken_over", actor, {
        previousSessionId: previous?.sessionId ?? null,
        sessionId,
        sessionFile: sessionFile ?? null,
      });
      return this.getMainSession();
    });
  }

  acquireControllerLease({ sessionId, sessionFile, clientId, ttlMs = 45_000, force = false }) {
    const main = this.getMainSession();
    if (!main || main.sessionId !== sessionId) {
      return { acquired: false, reason: "not-main-session", main };
    }
    const now = Date.now();
    return this.#transaction(() => {
      const lease = this.db.prepare("SELECT * FROM controller_lease WHERE singleton = 1").get();
      const occupied = lease && Number(lease.expires_at) > now && lease.client_id !== clientId;
      if (occupied && !force) {
        return {
          acquired: false,
          reason: "lease-held",
          main,
          holder: { sessionId: lease.session_id, clientId: lease.client_id, expiresAt: Number(lease.expires_at) },
        };
      }
      const acquiredAt = lease?.client_id === clientId ? Number(lease.acquired_at) : now;
      this.db.prepare(`
        INSERT INTO controller_lease(
          singleton, session_id, session_file, client_id, acquired_at, heartbeat_at, expires_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          session_id = excluded.session_id,
          session_file = excluded.session_file,
          client_id = excluded.client_id,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at
      `).run(sessionId, sessionFile ?? null, clientId, acquiredAt, now, now + ttlMs);
      return { acquired: true, reason: force ? "forced" : "acquired", main, expiresAt: now + ttlMs };
    });
  }

  heartbeatController(clientId, ttlMs = 45_000) {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE controller_lease SET heartbeat_at = ?, expires_at = ?
      WHERE singleton = 1 AND client_id = ?
    `).run(now, now + ttlMs, clientId);
    return Number(result.changes) > 0;
  }

  releaseController(clientId) {
    this.db.prepare("DELETE FROM controller_lease WHERE singleton = 1 AND client_id = ?").run(clientId);
  }

  getControlState() {
    const main = this.getMainSession();
    const lease = this.db.prepare("SELECT * FROM controller_lease WHERE singleton = 1").get();
    return {
      main,
      lease: lease ? {
        sessionId: lease.session_id,
        sessionFile: lease.session_file,
        clientId: lease.client_id,
        acquiredAt: Number(lease.acquired_at),
        heartbeatAt: Number(lease.heartbeat_at),
        expiresAt: Number(lease.expires_at),
        active: Number(lease.expires_at) > Date.now(),
      } : null,
    };
  }

  describeProposal(id) {
    const proposal = this.getProposal(id);
    if (!proposal) throw new IdeaStateError(`找不到提案 ${id}`, "PROPOSAL_NOT_FOUND");
    const base = this.getIdeaVersion(proposal.baseVersion);
    return {
      ...proposal,
      diff: formatLineDiff(base.content, proposal.candidateContent),
      recalculatedFields: changedIdeaFields(base.content, proposal.candidateContent),
    };
  }
}
