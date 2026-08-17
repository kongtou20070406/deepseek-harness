import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyWorkingStatePatch,
  createFrameProposal,
  emptyWorkingState,
  makeAuthorityLayer,
  splitLegacyIdea,
} from "./research-state.js";

function now() {
  return new Date().toISOString();
}

function hash(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

function canonicalWorkspace(path) {
  const normalized = resolve(String(path || ".")).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function titleFromContent(content) {
  const lines = String(content || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (const line of lines) {
    const candidate = line.replace(/^(?:#+\s*|科学对象[:：]\s*)/, "").trim();
    if (candidate) return candidate.slice(0, 80);
  }
  return "Untitled Idea";
}

export function lineDiff(before = "", after = "") {
  const left = String(before).replace(/\r\n/g, "\n").split("\n");
  const right = String(after).replace(/\r\n/g, "\n").split("\n");
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const output = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      output.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || dp[i][j + 1] >= dp[i + 1][j])) {
      output.push(`+${right[j]}`);
      j += 1;
    } else {
      output.push(`-${left[i]}`);
      i += 1;
    }
  }
  return output.join("\n");
}

export function defaultIdeaRegistryPath(dataDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
  return join(dataDir, "idea-extension", "registry.sqlite");
}

export class IdeaWorkspaceStore {
  constructor({ databasePath = defaultIdeaRegistryPath() } = {}) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idea_registry (
        idea_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','archived')),
        current_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idea_registry_versions (
        idea_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        parent_hash TEXT,
        source TEXT NOT NULL,
        note TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY(idea_id,version),
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE TABLE IF NOT EXISTS idea_registry_proposals (
        proposal_id TEXT PRIMARY KEY,
        idea_id TEXT,
        title TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        base_hash TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected','stale')),
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS idea_registry_workspaces (
        idea_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        label TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        PRIMARY KEY(idea_id,workspace),
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE TABLE IF NOT EXISTS idea_registry_conversations (
        session_id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('main','btw')),
        session_file TEXT,
        workspace TEXT NOT NULL,
        title TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idea_registry_one_main
        ON idea_registry_conversations(idea_id) WHERE kind='main' AND active=1;
      CREATE TABLE IF NOT EXISTS idea_registry_todos (
        todo_id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','blocked')),
        position INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        source TEXT NOT NULL,
        user_suggestion TEXT,
        pending_model_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE TABLE IF NOT EXISTS idea_registry_todo_events (
        event_id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        idea_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idea_registry_runtime_state (
        idea_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        narrow_state_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        research_state_json TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE TABLE IF NOT EXISTS idea_registry_workflows (
        run_id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        parent_run_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('workflow','worker')),
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','waiting','blocked','complete','failed','cancelled')),
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        objective TEXT NOT NULL,
        detail TEXT NOT NULL,
        progress_current INTEGER,
        progress_total INTEGER,
        card_hash TEXT,
        conversation_id TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE TABLE IF NOT EXISTS idea_registry_workflow_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        idea_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idea_registry_research_events (
        event_id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(idea_id) REFERENCES idea_registry(idea_id)
      );
      CREATE INDEX IF NOT EXISTS idea_registry_conversation_idea ON idea_registry_conversations(idea_id,last_seen_at);
      CREATE INDEX IF NOT EXISTS idea_registry_todo_idea ON idea_registry_todos(idea_id,status,position);
      CREATE INDEX IF NOT EXISTS idea_registry_workflow_idea ON idea_registry_workflows(idea_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS idea_registry_research_event_idea ON idea_registry_research_events(idea_id,created_at);
    `);
    const runtimeColumns = new Set(this.db.prepare("PRAGMA table_info(idea_registry_runtime_state)").all().map((row) => row.name));
    if (!runtimeColumns.has("research_state_json")) this.db.exec("ALTER TABLE idea_registry_runtime_state ADD COLUMN research_state_json TEXT;");
  }

  close() {
    this.db.close();
  }

  countIdeas() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM idea_registry").get()?.count || 0);
  }

  importConfirmedIdea({ content, title = null, workspace = ".", source = "confirmed-file-import" } = {}) {
    const value = String(content || "").trim();
    if (!value) throw new Error("Idea content is required.");
    const proposal = this.proposeIdea({ content: value, title: title || titleFromContent(value) });
    const idea = this.confirmProposal(proposal.proposalId, { source, note: "Imported an already confirmed Idea." });
    this.addWorkspace(idea.ideaId, workspace, { isDefault: true });
    return idea;
  }

  proposeIdea({ ideaId = null, content, title = null } = {}) {
    const value = String(content || "").trim();
    if (!value) throw new Error("Idea content is required.");
    const current = ideaId ? this.getIdea(ideaId) : null;
    if (ideaId && !current) throw new Error("Idea not found.");
    const proposalId = randomUUID();
    const createdAt = now();
    const proposedTitle = String(title || current?.title || titleFromContent(value)).trim().slice(0, 120) || titleFromContent(value);
    const before = current?.content || "";
    const diffText = lineDiff(before, value);
    this.db.prepare(`INSERT INTO idea_registry_proposals(
      proposal_id,idea_id,title,base_version,base_hash,content,content_hash,diff_text,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?, 'pending',?)`).run(
      proposalId,
      ideaId,
      proposedTitle,
      current?.version || 0,
      current?.hash || null,
      value,
      hash(value),
      diffText,
      createdAt,
    );
    return Object.freeze({ proposalId, ideaId, title: proposedTitle, baseVersion: current?.version || 0, content: value, contentHash: hash(value), diffText, createdAt });
  }

  confirmProposal(proposalId, { source = "user-web-confirmation", note = "Confirmed after exact diff review." } = {}) {
    const proposal = this.db.prepare("SELECT * FROM idea_registry_proposals WHERE proposal_id=?").get(proposalId);
    if (!proposal || proposal.status !== "pending") throw new Error("Pending proposal not found.");
    const current = proposal.idea_id ? this.getIdea(proposal.idea_id) : null;
    if (proposal.idea_id && (!current || current.version !== proposal.base_version || current.hash !== proposal.base_hash)) {
      this.db.prepare("UPDATE idea_registry_proposals SET status='stale',decided_at=? WHERE proposal_id=?").run(now(), proposalId);
      throw new Error("Idea changed after this diff was created; create a new proposal.");
    }
    const ideaId = proposal.idea_id || randomUUID();
    const version = (current?.version || 0) + 1;
    const confirmedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!current) {
        this.db.prepare("INSERT INTO idea_registry(idea_id,title,status,current_version,created_at,updated_at) VALUES(?,?, 'active',?,?,?)")
          .run(ideaId, proposal.title, version, confirmedAt, confirmedAt);
      } else {
        this.db.prepare("UPDATE idea_registry SET title=?,current_version=?,updated_at=? WHERE idea_id=?")
          .run(proposal.title, version, confirmedAt, ideaId);
      }
      this.db.prepare(`INSERT INTO idea_registry_versions(
        idea_id,version,content,content_hash,parent_hash,source,note,confirmed_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        ideaId, version, proposal.content, proposal.content_hash, current?.hash || null, source, note, confirmedAt,
      );
      this.db.prepare("UPDATE idea_registry_proposals SET status='confirmed',idea_id=?,decided_at=? WHERE proposal_id=?")
        .run(ideaId, confirmedAt, proposalId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getIdea(ideaId);
  }

  rejectProposal(proposalId) {
    const result = this.db.prepare("UPDATE idea_registry_proposals SET status='rejected',decided_at=? WHERE proposal_id=? AND status='pending'").run(now(), proposalId);
    return result.changes > 0;
  }

  getIdea(ideaId) {
    const row = this.db.prepare(`SELECT i.idea_id,i.title,i.status,i.current_version,v.content,v.content_hash,v.parent_hash,v.confirmed_at
      FROM idea_registry i JOIN idea_registry_versions v ON v.idea_id=i.idea_id AND v.version=i.current_version
      WHERE i.idea_id=?`).get(ideaId);
    if (!row) return null;
    const research = this.loadResearchState(row.idea_id, row.content, row.confirmed_at);
    return Object.freeze({
      ideaId: row.idea_id,
      title: row.title || titleFromContent(row.content),
      status: row.status,
      version: row.current_version,
      content: row.content,
      hash: row.content_hash,
      parentHash: row.parent_hash,
      confirmedAt: row.confirmed_at,
      ideaKernel: research.ideaKernel,
      researchFrame: research.researchFrame,
      workingState: research.workingState,
      pendingFrameProposal: research.pendingFrameProposal,
      migrationStatus: research.migrationStatus,
      workspaces: this.listWorkspaces(row.idea_id),
      conversations: this.listConversations(row.idea_id),
      todos: this.listTodos(row.idea_id),
      workflows: this.listWorkflows(row.idea_id),
    });
  }

  listIdeas({ includeArchived = false } = {}) {
    const rows = this.db.prepare(`SELECT idea_id FROM idea_registry ${includeArchived ? "" : "WHERE status='active'"} ORDER BY updated_at DESC`).all();
    return rows.map((row) => this.getIdea(row.idea_id));
  }

  listVersions(ideaId) {
    return this.db.prepare(`SELECT version,content,content_hash AS hash,parent_hash AS parentHash,source,note,confirmed_at AS confirmedAt
      FROM idea_registry_versions WHERE idea_id=? ORDER BY version DESC`).all(ideaId);
  }

  loadRuntimeState(ideaId) {
    const row = this.db.prepare("SELECT stage,narrow_state_json,skills_json,research_state_json,updated_at FROM idea_registry_runtime_state WHERE idea_id=?").get(ideaId);
    if (!row) return { stage: "", narrowState: [], skills: [], researchState: null, updatedAt: null };
    return {
      stage: row.stage,
      narrowState: JSON.parse(row.narrow_state_json),
      skills: JSON.parse(row.skills_json),
      researchState: row.research_state_json ? JSON.parse(row.research_state_json) : null,
      updatedAt: row.updated_at,
    };
  }

  saveRuntimeState(ideaId, { stage = "", narrowState = [], skills = [], researchState = undefined } = {}) {
    const updatedAt = now();
    const previous = this.loadRuntimeState(ideaId);
    const researchJson = JSON.stringify(researchState === undefined ? previous.researchState : researchState);
    this.db.prepare(`INSERT INTO idea_registry_runtime_state(idea_id,stage,narrow_state_json,skills_json,research_state_json,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(idea_id) DO UPDATE SET stage=excluded.stage,narrow_state_json=excluded.narrow_state_json,
      skills_json=excluded.skills_json,research_state_json=excluded.research_state_json,updated_at=excluded.updated_at`).run(
      ideaId, String(stage), JSON.stringify(narrowState || []), JSON.stringify(skills || []), researchJson, updatedAt,
    );
    return updatedAt;
  }

  loadResearchState(ideaId, legacyContent = null, confirmedAt = null) {
    const projected = this.loadRuntimeState(ideaId).researchState;
    if (projected?.ideaKernel && projected?.workingState) return projected;
    const content = legacyContent ?? this.db.prepare(`SELECT v.content,v.confirmed_at AS confirmedAt FROM idea_registry i
      JOIN idea_registry_versions v ON v.idea_id=i.idea_id AND v.version=i.current_version WHERE i.idea_id=?`).get(ideaId)?.content;
    if (!content) throw new Error("Idea not found.");
    const migrated = splitLegacyIdea(content);
    const at = confirmedAt || now();
    const state = {
      schema: 1,
      migrationStatus: migrated.status,
      legacyIdeaHash: migrated.legacyHash,
      ideaKernel: makeAuthorityLayer(migrated.kernelContent, { source: "legacy-p0-deterministic-migration", confirmedAt: at }),
      researchFrame: migrated.frameContent
        ? makeAuthorityLayer(migrated.frameContent, { source: "legacy-p0-deterministic-migration", confirmedAt: at })
        : null,
      workingState: emptyWorkingState(),
      pendingFrameProposal: null,
    };
    this.saveRuntimeState(ideaId, { ...this.loadRuntimeState(ideaId), researchState: state });
    this.recordResearchEvent(ideaId, "harness", "legacy-p0-migrated", null, state);
    return state;
  }

  updateWorkingState(ideaId, patch, { actor = "model" } = {}) {
    const current = this.loadResearchState(ideaId);
    const workingState = applyWorkingStatePatch(current.workingState, patch, { actor });
    const next = { ...current, workingState };
    const runtime = this.loadRuntimeState(ideaId);
    this.saveRuntimeState(ideaId, { ...runtime, researchState: next });
    this.recordResearchEvent(ideaId, actor, "working-state-updated", current, next);
    return next;
  }

  proposeResearchFrame(ideaId, content, { actor = "model" } = {}) {
    const current = this.loadResearchState(ideaId);
    const pendingFrameProposal = createFrameProposal({ ideaId, content, currentFrame: current.researchFrame, source: `${actor}-suggestion` });
    const next = { ...current, pendingFrameProposal };
    const runtime = this.loadRuntimeState(ideaId);
    this.saveRuntimeState(ideaId, { ...runtime, researchState: next });
    this.recordResearchEvent(ideaId, actor, "frame-proposal-created", current, next);
    return pendingFrameProposal;
  }

  confirmResearchFrame(ideaId, proposalId, { actor = "user" } = {}) {
    if (!String(actor).startsWith("user")) throw new Error("Only the user can confirm a Research Frame proposal.");
    const current = this.loadResearchState(ideaId);
    const proposal = current.pendingFrameProposal;
    if (!proposal || proposal.proposalId !== proposalId) throw new Error("Pending Research Frame proposal not found.");
    if ((current.researchFrame?.version || 0) !== proposal.baseVersion || (current.researchFrame?.hash || null) !== proposal.baseHash) {
      throw new Error("Research Frame changed after this proposal was created.");
    }
    const researchFrame = makeAuthorityLayer(proposal.content, {
      version: (current.researchFrame?.version || 0) + 1,
      parentHash: current.researchFrame?.hash || null,
      source: actor,
    });
    const next = { ...current, researchFrame, pendingFrameProposal: null };
    const runtime = this.loadRuntimeState(ideaId);
    this.saveRuntimeState(ideaId, { ...runtime, researchState: next });
    this.recordResearchEvent(ideaId, actor, "frame-confirmed", current, next);
    return next;
  }

  recordResearchEvent(ideaId, actor, operation, before, after) {
    this.db.prepare(`INSERT INTO idea_registry_research_events(event_id,idea_id,actor,operation,before_json,after_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), ideaId, String(actor), operation,
      before == null ? null : JSON.stringify(before), JSON.stringify(after), now());
  }

  versionDiff(ideaId, version) {
    const current = this.db.prepare("SELECT version,content FROM idea_registry_versions WHERE idea_id=? AND version=?").get(ideaId, version);
    if (!current) return null;
    const previous = this.db.prepare("SELECT content FROM idea_registry_versions WHERE idea_id=? AND version<? ORDER BY version DESC LIMIT 1").get(ideaId, version);
    return { ideaId, version, diffText: lineDiff(previous?.content || "", current.content) };
  }

  setIdeaStatus(ideaId, status) {
    if (status !== "active" && status !== "archived") throw new Error("Invalid Idea status.");
    const result = this.db.prepare("UPDATE idea_registry SET status=?,updated_at=? WHERE idea_id=?").run(status, now(), ideaId);
    return result.changes > 0;
  }

  addWorkspace(ideaId, workspace, { label = null, isDefault = false } = {}) {
    if (!this.getIdea(ideaId)) throw new Error("Idea not found.");
    const value = canonicalWorkspace(workspace);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (isDefault) this.db.prepare("UPDATE idea_registry_workspaces SET is_default=0 WHERE idea_id=?").run(ideaId);
      this.db.prepare(`INSERT INTO idea_registry_workspaces(idea_id,workspace,label,is_default,added_at) VALUES(?,?,?,?,?)
        ON CONFLICT(idea_id,workspace) DO UPDATE SET label=excluded.label,is_default=MAX(idea_registry_workspaces.is_default,excluded.is_default)`)
        .run(ideaId, value, String(label || value), isDefault ? 1 : 0, timestamp);
      const hasDefault = this.db.prepare("SELECT 1 FROM idea_registry_workspaces WHERE idea_id=? AND is_default=1").get(ideaId);
      if (!hasDefault) this.db.prepare("UPDATE idea_registry_workspaces SET is_default=1 WHERE idea_id=? AND workspace=?").run(ideaId, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listWorkspaces(ideaId);
  }

  listWorkspaces(ideaId) {
    return this.db.prepare(`SELECT workspace,label,is_default AS isDefault,added_at AS addedAt
      FROM idea_registry_workspaces WHERE idea_id=? ORDER BY is_default DESC,added_at`).all(ideaId)
      .map((row) => ({ ...row, isDefault: Boolean(row.isDefault) }));
  }

  setDefaultWorkspace(ideaId, workspace) {
    const value = canonicalWorkspace(workspace);
    const exists = this.db.prepare("SELECT 1 FROM idea_registry_workspaces WHERE idea_id=? AND workspace=?").get(ideaId, value);
    if (!exists) throw new Error("Workspace is not attached to this Idea.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE idea_registry_workspaces SET is_default=0 WHERE idea_id=?").run(ideaId);
      this.db.prepare("UPDATE idea_registry_workspaces SET is_default=1 WHERE idea_id=? AND workspace=?").run(ideaId, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listWorkspaces(ideaId);
  }

  removeWorkspace(ideaId, workspace) {
    const value = canonicalWorkspace(workspace);
    const current = this.db.prepare("SELECT is_default AS isDefault FROM idea_registry_workspaces WHERE idea_id=? AND workspace=?").get(ideaId, value);
    if (!current) return this.listWorkspaces(ideaId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM idea_registry_workspaces WHERE idea_id=? AND workspace=?").run(ideaId, value);
      if (current.isDefault) {
        const replacement = this.db.prepare("SELECT workspace FROM idea_registry_workspaces WHERE idea_id=? ORDER BY added_at LIMIT 1").get(ideaId);
        if (replacement) this.db.prepare("UPDATE idea_registry_workspaces SET is_default=1 WHERE idea_id=? AND workspace=?").run(ideaId, replacement.workspace);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listWorkspaces(ideaId);
  }

  bindConversation({ ideaId, sessionId, sessionFile = null, workspace = ".", kind = "btw", title = null, replaceMain = false } = {}) {
    const idea = this.getIdea(ideaId);
    if (!idea) throw new Error("Idea not found.");
    if (!sessionId) throw new Error("Session id is required.");
    if (kind !== "main" && kind !== "btw") throw new Error("Conversation kind must be main or btw.");
    const timestamp = now();
    const normalizedWorkspace = canonicalWorkspace(workspace);
    this.addWorkspace(ideaId, normalizedWorkspace, { isDefault: idea.workspaces.length === 0 });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (kind === "main") {
        const existing = this.db.prepare("SELECT session_id FROM idea_registry_conversations WHERE idea_id=? AND kind='main' AND active=1").get(ideaId);
        if (existing && existing.session_id !== sessionId && !replaceMain) throw new Error("This Idea already has a main conversation.");
        if (existing && existing.session_id !== sessionId) {
          this.db.prepare("UPDATE idea_registry_conversations SET active=0,last_seen_at=? WHERE session_id=?").run(timestamp, existing.session_id);
        }
      }
      this.db.prepare(`INSERT INTO idea_registry_conversations(
        session_id,idea_id,kind,session_file,workspace,title,active,created_at,last_seen_at
      ) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET
        idea_id=excluded.idea_id,kind=excluded.kind,session_file=excluded.session_file,workspace=excluded.workspace,
        title=excluded.title,active=1,last_seen_at=excluded.last_seen_at`).run(
        sessionId, ideaId, kind, sessionFile, normalizedWorkspace,
        String(title || (kind === "main" ? "主对话" : `BTW ${timestamp.slice(5, 16).replace("T", " ")}`)).slice(0, 120),
        timestamp, timestamp,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.conversation(sessionId);
  }

  conversation(sessionId) {
    const row = this.db.prepare(`SELECT session_id AS sessionId,idea_id AS ideaId,kind,session_file AS sessionFile,
      workspace,title,active,created_at AS createdAt,last_seen_at AS lastSeenAt
      FROM idea_registry_conversations WHERE session_id=?`).get(sessionId);
    return row ? { ...row, active: Boolean(row.active) } : null;
  }

  rebindConversationSession(sessionId, { nextSessionId, sessionFile = null } = {}) {
    const current = this.conversation(sessionId);
    if (!current) throw new Error("Conversation not found.");
    if (!nextSessionId) throw new Error("Replacement session id is required.");
    if (nextSessionId === sessionId) return current;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM idea_registry_conversations WHERE session_id=? AND idea_id=?").run(nextSessionId, current.ideaId);
      this.db.prepare("UPDATE idea_registry_conversations SET session_id=?,session_file=?,last_seen_at=? WHERE session_id=?")
        .run(nextSessionId, sessionFile, timestamp, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.conversation(nextSessionId);
  }

  listConversations(ideaId) {
    return this.db.prepare(`SELECT session_id AS sessionId,kind,session_file AS sessionFile,workspace,title,active,
      created_at AS createdAt,last_seen_at AS lastSeenAt FROM idea_registry_conversations
      WHERE idea_id=? ORDER BY kind='main' DESC,active DESC,last_seen_at DESC`).all(ideaId)
      .map((row) => ({ ...row, active: Boolean(row.active) }));
  }

  contextForSession(sessionId) {
    const conversation = this.conversation(sessionId);
    if (!conversation) return null;
    const idea = this.getIdea(conversation.ideaId);
    return idea ? Object.freeze({ idea, conversation }) : null;
  }

  workflow(runId) {
    const row = this.db.prepare(`SELECT run_id AS runId,idea_id AS ideaId,parent_run_id AS parentRunId,kind,label,status,
      model,reasoning_effort AS reasoningEffort,objective,detail,progress_current AS progressCurrent,
      progress_total AS progressTotal,card_hash AS cardHash,conversation_id AS conversationId,
      started_at AS startedAt,updated_at AS updatedAt,finished_at AS finishedAt
      FROM idea_registry_workflows WHERE run_id=?`).get(runId);
    return row || null;
  }

  listWorkflows(ideaId, { activeOnly = false, limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(`SELECT run_id AS runId,idea_id AS ideaId,parent_run_id AS parentRunId,kind,label,status,
      model,reasoning_effort AS reasoningEffort,objective,detail,progress_current AS progressCurrent,
      progress_total AS progressTotal,card_hash AS cardHash,conversation_id AS conversationId,
      started_at AS startedAt,updated_at AS updatedAt,finished_at AS finishedAt
      FROM idea_registry_workflows WHERE idea_id=? ${activeOnly ? "AND status IN ('running','waiting','blocked')" : ""}
      ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'waiting' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,updated_at DESC LIMIT ?`)
      .all(ideaId, bounded);
  }

  upsertWorkflow(ideaId, value = {}, { actor = "model-tool" } = {}) {
    if (!this.getIdea(ideaId)) throw new Error("Idea not found.");
    const runId = String(value.runId || randomUUID()).trim();
    const previous = this.workflow(runId);
    if (previous && previous.ideaId !== ideaId) throw new Error("Workflow belongs to another Idea.");
    const kind = String(value.kind ?? previous?.kind ?? "worker");
    const status = String(value.status ?? previous?.status ?? "running");
    if (!new Set(["workflow", "worker"]).has(kind)) throw new Error("Invalid workflow kind.");
    if (!new Set(["running", "waiting", "blocked", "complete", "failed", "cancelled"]).has(status)) throw new Error("Invalid workflow status.");
    const timestamp = now();
    const terminal = new Set(["complete", "failed", "cancelled"]).has(status);
    const next = {
      runId,
      ideaId,
      parentRunId: value.parentRunId ?? previous?.parentRunId ?? null,
      kind,
      label: String(value.label ?? previous?.label ?? runId).trim().slice(0, 240) || runId,
      status,
      model: String(value.model ?? previous?.model ?? "unknown").slice(0, 120),
      reasoningEffort: String(value.reasoningEffort ?? previous?.reasoningEffort ?? "unknown").slice(0, 40),
      objective: String(value.objective ?? previous?.objective ?? "").slice(0, 8000),
      detail: String(value.detail ?? previous?.detail ?? "").slice(0, 8000),
      progressCurrent: value.progressCurrent == null ? previous?.progressCurrent ?? null : Math.max(0, Math.trunc(Number(value.progressCurrent))),
      progressTotal: value.progressTotal == null ? previous?.progressTotal ?? null : Math.max(0, Math.trunc(Number(value.progressTotal))),
      cardHash: value.cardHash ?? previous?.cardHash ?? null,
      conversationId: value.conversationId ?? previous?.conversationId ?? null,
      startedAt: previous?.startedAt || value.startedAt || timestamp,
      updatedAt: timestamp,
      finishedAt: terminal ? (previous?.finishedAt || timestamp) : null,
    };
    if (next.progressCurrent != null && next.progressTotal != null && next.progressCurrent > next.progressTotal) {
      throw new Error("Workflow progress cannot exceed total.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO idea_registry_workflows(
        run_id,idea_id,parent_run_id,kind,label,status,model,reasoning_effort,objective,detail,
        progress_current,progress_total,card_hash,conversation_id,started_at,updated_at,finished_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
        parent_run_id=excluded.parent_run_id,kind=excluded.kind,label=excluded.label,status=excluded.status,
        model=excluded.model,reasoning_effort=excluded.reasoning_effort,objective=excluded.objective,detail=excluded.detail,
        progress_current=excluded.progress_current,progress_total=excluded.progress_total,card_hash=excluded.card_hash,
        conversation_id=excluded.conversation_id,updated_at=excluded.updated_at,finished_at=excluded.finished_at`).run(
        next.runId, next.ideaId, next.parentRunId, next.kind, next.label, next.status, next.model, next.reasoningEffort,
        next.objective, next.detail, next.progressCurrent, next.progressTotal, next.cardHash, next.conversationId,
        next.startedAt, next.updatedAt, next.finishedAt,
      );
      this.db.prepare(`INSERT INTO idea_registry_workflow_events(event_id,run_id,idea_id,actor,snapshot_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(randomUUID(), runId, ideaId, String(actor), JSON.stringify(next), timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workflow(runId);
  }

  listTodos(ideaId) {
    return this.db.prepare(`SELECT todo_id AS todoId,text,status,position,revision,source,user_suggestion AS userSuggestion,
      pending_model_review AS pendingModelReview,created_at AS createdAt,updated_at AS updatedAt
      FROM idea_registry_todos WHERE idea_id=? ORDER BY position,created_at`).all(ideaId)
      .map((row) => ({ ...row, pendingModelReview: Boolean(row.pendingModelReview) }));
  }

  addTodo(ideaId, { text, status = "pending", source = "user-web", userSuggestion = null } = {}) {
    if (!this.getIdea(ideaId)) throw new Error("Idea not found.");
    const value = String(text || "").trim();
    if (!value || value.length > 2000) throw new Error("Todo text must be 1-2000 characters.");
    const position = Number(this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS value FROM idea_registry_todos WHERE idea_id=?").get(ideaId)?.value || 0);
    const todoId = randomUUID();
    const timestamp = now();
    const row = {
      todoId,
      text: value,
      status,
      position,
      revision: 1,
      source,
      userSuggestion: userSuggestion == null ? value : String(userSuggestion),
      pendingModelReview: source.startsWith("user") || source === "web",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO idea_registry_todos(
      todo_id,idea_id,text,status,position,revision,source,user_suggestion,pending_model_review,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      todoId, ideaId, row.text, row.status, position, 1, source, row.userSuggestion, row.pendingModelReview ? 1 : 0, timestamp, timestamp,
    );
    this.recordTodoEvent(ideaId, todoId, source, "created", null, row);
    return row;
  }

  updateTodo(ideaId, todoId, patch = {}, { actor = "user-web" } = {}) {
    const current = this.listTodos(ideaId).find((todo) => todo.todoId === todoId);
    if (!current) throw new Error("Todo not found.");
    const next = {
      ...current,
      text: patch.text == null ? current.text : String(patch.text).trim(),
      status: patch.status == null ? current.status : String(patch.status),
      position: patch.position == null ? current.position : Number(patch.position),
      revision: current.revision + 1,
      source: actor,
      userSuggestion: actor.startsWith("user") ? String(patch.userSuggestion ?? patch.text ?? current.text) : current.userSuggestion,
      pendingModelReview: actor.startsWith("user") ? true : false,
      updatedAt: now(),
    };
    if (!next.text || next.text.length > 2000) throw new Error("Todo text must be 1-2000 characters.");
    if (!["pending", "in_progress", "done", "blocked"].includes(next.status)) throw new Error("Invalid Todo status.");
    this.db.prepare(`UPDATE idea_registry_todos SET text=?,status=?,position=?,revision=?,source=?,user_suggestion=?,
      pending_model_review=?,updated_at=? WHERE idea_id=? AND todo_id=?`).run(
      next.text, next.status, next.position, next.revision, next.source, next.userSuggestion,
      next.pendingModelReview ? 1 : 0, next.updatedAt, ideaId, todoId,
    );
    this.recordTodoEvent(ideaId, todoId, actor, "updated", current, next);
    return next;
  }

  deleteTodo(ideaId, todoId, { actor = "user-web" } = {}) {
    const current = this.listTodos(ideaId).find((todo) => todo.todoId === todoId);
    if (!current) return false;
    this.db.prepare("DELETE FROM idea_registry_todos WHERE idea_id=? AND todo_id=?").run(ideaId, todoId);
    this.recordTodoEvent(ideaId, todoId, actor, "deleted", current, null);
    return true;
  }

  recordTodoEvent(ideaId, todoId, actor, operation, before, after) {
    this.db.prepare(`INSERT INTO idea_registry_todo_events(
      event_id,todo_id,idea_id,actor,operation,before_json,after_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      randomUUID(), todoId, ideaId, actor, operation,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), now(),
    );
  }
}
