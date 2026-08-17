import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { IdeaIntegrityError } from "../src/state-store.js";
import { sha256 } from "../src/idea-document.js";
import { temporaryIdeaStore } from "./helpers.js";

test("proposal revisions never change the authoritative Idea before confirmation", () => {
  const fixture = temporaryIdeaStore();
  try {
    const initial = fixture.store.getCurrentIdea();
    const proposal = fixture.store.createProposal({
      candidateContent: `${initial.content}\n\n当前路线补充：用可验证的局部门控限制消息传播。`,
      routeChanged: true,
      rationale: "隔离机制变量",
      actor: "test:main",
    });
    assert.equal(fixture.store.getCurrentIdea().hash, initial.hash);
    assert.equal(readFileSync(fixture.store.paths.idea, "utf8"), initial.content);

    const revised = fixture.store.updateProposal(proposal.id, {
      candidateContent: `${initial.content}\n\n当前路线补充：用可验证的局部门控限制消息传播。\n否决条件：若去除门控后性能不变。`,
      routeChanged: true,
      rationale: "加入可证伪边界",
      actor: "test:main",
    });
    assert.equal(revised.revision, 2);
    assert.equal(fixture.store.getCurrentIdea().version, 1);

    const committed = fixture.store.commitProposal(proposal.id, { actor: "test:user" });
    assert.equal(committed.version, 2);
    assert.equal(committed.routeVersion, 2);
    assert.equal(fixture.store.getIdeaVersion(1).content, initial.content);
    assert.equal(readFileSync(fixture.store.paths.idea, "utf8"), committed.content);
    assert.equal(fixture.store.getProposal(proposal.id).status, "accepted");
    assert.equal(fixture.store.verifyEventChain(), true);
  } finally {
    fixture.cleanup();
  }
});

test("committing one proposal makes concurrent pending proposals stale instead of overwriting", () => {
  const fixture = temporaryIdeaStore();
  try {
    const initial = fixture.store.getCurrentIdea();
    const first = fixture.store.createProposal({
      candidateContent: `${initial.content}\n\n表述补充：在两个任务上获得可复现改进。`,
      routeChanged: false,
      rationale: "更严格终点",
    });
    const second = fixture.store.createProposal({
      candidateContent: "研究局部结构表示的归纳偏置，并采用另一条机制路线。",
      routeChanged: true,
      rationale: "另一候选表述",
    });
    const committed = fixture.store.commitProposal(first.id, { actor: "test:user" });
    assert.equal(committed.routeVersion, 1);
    assert.equal(fixture.store.getProposal(second.id).status, "stale");
  } finally {
    fixture.cleanup();
  }
});

test("AI-organized initialization remains pending until explicit user confirmation", () => {
  const fixture = temporaryIdeaStore({ initialized: false });
  try {
    const raw = "我想做一个不因压缩而改变研究方向的轻量工具。";
    fixture.store.beginInitializationDraft(raw, { actor: "test:user" });
    fixture.store.saveInitializationCandidate("目标：保护长期科研 Idea。\n边界：不做通用 Agent 平台。", {
      actor: "test:main",
      rationale: "压缩并保留原意",
    });

    assert.equal(fixture.store.isInitialized(), false);
    assert.equal(fixture.store.getInitializationDraft().rawContent, raw);
    const pending = fixture.store.getInitializationDraft();
    const committed = fixture.store.initializeIdeaFromContent(pending.candidateContent, {
      sourceText: pending.rawContent,
      actor: "test:user",
    });
    assert.equal(committed.version, 1);
    assert.equal(committed.routeVersion, 1);
    assert.equal(fixture.store.getInitializationDraft(), null);
  } finally {
    fixture.cleanup();
  }
});

test("legacy structured P0 migrates route metadata without changing one byte", () => {
  const fixture = temporaryIdeaStore({ initialized: false });
  try {
    const legacy = "科学对象：\n旧实验对象\n终点标准：\n复现实验\n当前路线 v3：\n  核心机制：\n局部门控";
    fixture.store.initializeIdeaFromContent(legacy, { actor: "test:user" });
    const before = fixture.store.getCurrentIdea();
    fixture.store.db.prepare("DELETE FROM meta WHERE key = ?").run("route_version");
    fixture.store.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("1", "schema_version");

    const migrated = fixture.store.getCurrentIdea();
    assert.equal(migrated.routeVersion, 3);
    assert.equal(migrated.content, legacy);
    assert.equal(migrated.hash, before.hash);
    assert.equal(readFileSync(fixture.store.paths.idea, "utf8"), legacy);
    assert.equal(fixture.store.getMeta("schema_version"), "2");
  } finally {
    fixture.cleanup();
  }
});

test("out-of-band changes are detected instead of silently adopted", () => {
  const fixture = temporaryIdeaStore();
  try {
    const original = readFileSync(fixture.store.paths.idea, "utf8");
    writeFileSync(fixture.store.paths.idea, `${original}\n偷偷改写`, "utf8");
    assert.throws(() => fixture.store.assertIntegrity(), IdeaIntegrityError);
    writeFileSync(fixture.store.paths.idea, original, "utf8");
    assert.equal(fixture.store.assertIntegrity(), true);
  } finally {
    fixture.cleanup();
  }
});

test("one main session and one live controller lease are enforced", () => {
  const fixture = temporaryIdeaStore();
  try {
    fixture.store.ensureMainSession("main-session", "main.jsonl", "test");
    const first = fixture.store.acquireControllerLease({
      sessionId: "main-session",
      sessionFile: "main.jsonl",
      clientId: "client-a",
    });
    assert.equal(first.acquired, true);
    const competing = fixture.store.acquireControllerLease({
      sessionId: "main-session",
      sessionFile: "main.jsonl",
      clientId: "client-b",
    });
    assert.equal(competing.acquired, false);
    assert.equal(competing.reason, "lease-held");
    const branch = fixture.store.acquireControllerLease({
      sessionId: "branch-session",
      sessionFile: "branch.jsonl",
      clientId: "client-c",
    });
    assert.equal(branch.reason, "not-main-session");
  } finally {
    fixture.cleanup();
  }
});

test("Luna snapshots are derived, version-bound, and never modify P0", () => {
  const fixture = temporaryIdeaStore();
  try {
    const idea = fixture.store.getCurrentIdea();
    const p1 = fixture.store.getCurrentP1();
    const before = readFileSync(fixture.store.paths.idea, "utf8");
    const packetContent = "[Luna task context snapshot]\n选择的证据\n[/Luna task context snapshot]";
    const saved = fixture.store.saveLunaSnapshot({
      id: "luna-state-1",
      parentId: null,
      ideaVersion: idea.version,
      ideaHash: idea.hash,
      routeVersion: idea.routeVersion,
      p1Version: p1.version,
      sessionId: "main-session",
      sourceLeafId: "leaf-1",
      cutoffTimestamp: 1_000,
      trigger: "task_switch",
      task: "验证机制",
      constraints: ["不改 P0"],
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-luna",
      candidateCount: 4,
      candidateTokens: 100,
      candidateHash: sha256("candidates"),
      selection: { selected: [], conflicts: [], excluded: [], unselectedCount: 4 },
      packetContent,
      packetHash: sha256(packetContent),
      packetTokens: 20,
      usage: { input: 100, output: 20 },
      diff: { added: [], removed: [], retained: [], taskChanged: false },
      createdAt: new Date(1_000).toISOString(),
    }, { actor: "test:luna" });

    assert.equal(saved.status, "active");
    assert.equal(fixture.store.getLunaContextState().applicable.id, "luna-state-1");
    assert.equal(readFileSync(fixture.store.paths.idea, "utf8"), before);
    fixture.store.updateP1("新阶段", { actor: "test:main" });
    const stale = fixture.store.getLunaContextState();
    assert.equal(stale.applicable, null);
    assert.equal(stale.staleReason, "p1-version-changed");
    assert.equal(fixture.store.getCurrentIdea().hash, idea.hash);
  } finally {
    fixture.cleanup();
  }
});
