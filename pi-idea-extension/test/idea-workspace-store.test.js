import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IdeaWorkspaceStore } from "../src/idea-workspace-store.js";

test("multiple Ideas keep one main conversation and unlimited BTW conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-registry-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const ideaA = store.importConfirmedIdea({ content: "Idea A\n终点 A", workspace: join(root, "a") });
    const ideaB = store.importConfirmedIdea({ content: "Idea B\n终点 B", workspace: join(root, "b") });
    store.bindConversation({ ideaId: ideaA.ideaId, sessionId: "a-main", kind: "main", workspace: join(root, "a") });
    store.bindConversation({ ideaId: ideaA.ideaId, sessionId: "a-btw-1", kind: "btw", workspace: join(root, "a") });
    store.bindConversation({ ideaId: ideaA.ideaId, sessionId: "a-btw-2", kind: "btw", workspace: join(root, "shared") });
    store.bindConversation({ ideaId: ideaB.ideaId, sessionId: "b-main", kind: "main", workspace: join(root, "b") });
    assert.throws(() => store.bindConversation({ ideaId: ideaA.ideaId, sessionId: "a-main-2", kind: "main", workspace: join(root, "a") }), /already has a main/);
    const a = store.getIdea(ideaA.ideaId);
    assert.equal(a.conversations.filter((conversation) => conversation.kind === "main" && conversation.active).length, 1);
    assert.equal(a.conversations.filter((conversation) => conversation.kind === "btw").length, 2);
    assert.equal(a.workspaces.length, 2);
    assert.equal(store.listIdeas().length, 2);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Idea revisions require a proposal and preserve an exact reviewable diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-diff-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const first = store.importConfirmedIdea({ content: "目标\n路线 A", workspace: root });
    const proposal = store.proposeIdea({ ideaId: first.ideaId, content: "目标\n路线 B\n新增约束" });
    assert.match(proposal.diffText, /-路线 A/);
    assert.match(proposal.diffText, /\+路线 B/);
    assert.match(proposal.diffText, /\+新增约束/);
    assert.equal(store.getIdea(first.ideaId).version, 1);
    const second = store.confirmProposal(proposal.proposalId);
    assert.equal(second.version, 2);
    assert.equal(second.parentHash, first.hash);
    assert.equal(store.listVersions(first.ideaId).length, 2);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("user Todo edits stay pending until a main-loop model revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-todo-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const idea = store.importConfirmedIdea({ content: "研究目标", workspace: root });
    const todo = store.addTodo(idea.ideaId, { text: "先测试假设 A", source: "user-web" });
    assert.equal(todo.pendingModelReview, true);
    const edited = store.updateTodo(idea.ideaId, todo.todoId, { text: "先用最小配对实验测试假设 A" }, { actor: "user-web" });
    assert.equal(edited.pendingModelReview, true);
    assert.equal(edited.revision, 2);
    const corrected = store.updateTodo(idea.ideaId, todo.todoId, { text: "最小配对实验已执行", status: "done" }, { actor: "model-tool" });
    assert.equal(corrected.pendingModelReview, false);
    assert.equal(corrected.status, "done");
    assert.equal(corrected.revision, 3);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM idea_registry_todo_events").get().count, 3);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Idea management archives without deletion and reassigns attached workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-manage-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const idea = store.importConfirmedIdea({ content: "研究目标", workspace: join(root, "one") });
    store.addWorkspace(idea.ideaId, join(root, "two"));
    store.setDefaultWorkspace(idea.ideaId, join(root, "two"));
    assert.match(store.getIdea(idea.ideaId).workspaces.find((item) => item.isDefault).workspace, /two$/);
    store.removeWorkspace(idea.ideaId, join(root, "two"));
    assert.equal(store.getIdea(idea.ideaId).workspaces.length, 1);
    assert.equal(store.getIdea(idea.ideaId).workspaces[0].isDefault, true);
    assert.equal(store.setIdeaStatus(idea.ideaId, "archived"), true);
    assert.equal(store.listIdeas().length, 0);
    assert.equal(store.listIdeas({ includeArchived: true })[0].status, "archived");
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Idea title skips an empty scientific-object label", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-title-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const idea = store.importConfirmedIdea({ content: "科学对象：\n设计一个长期科研伙伴", workspace: root });
    assert.equal(idea.title, "设计一个长期科研伙伴");
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow and worker progress survives refresh with an append-only audit trail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-workflow-"));
  const databasePath = join(root, "registry.sqlite");
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath });
    const idea = store.importConfirmedIdea({ content: "长期研究目标", workspace: root });
    const started = store.upsertWorkflow(idea.ideaId, {
      runId: "worker-1",
      kind: "worker",
      label: "核验配对结果",
      status: "running",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      objective: "检查 manifest 和 result",
      progressCurrent: 1,
      progressTotal: 3,
    });
    assert.equal(started.status, "running");
    assert.equal(store.getIdea(idea.ideaId).workflows[0].runId, "worker-1");
    store.close();
    store = new IdeaWorkspaceStore({ databasePath });
    assert.equal(store.listWorkflows(idea.ideaId, { activeOnly: true }).length, 1);
    const completed = store.upsertWorkflow(idea.ideaId, {
      runId: "worker-1",
      status: "complete",
      progressCurrent: 3,
      detail: "三项证据均核验通过",
    });
    assert.equal(completed.finishedAt != null, true);
    assert.equal(store.listWorkflows(idea.ideaId, { activeOnly: true }).length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM idea_registry_workflow_events WHERE run_id='worker-1'").get().count, 2);
    assert.throws(() => store.upsertWorkflow(idea.ideaId, { runId: "bad-progress", progressCurrent: 4, progressTotal: 3 }), /exceed/);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry migrates legacy P0 into three layers and only user confirms frame suggestions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-research-state-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const idea = store.importConfirmedIdea({
      content: "科学对象：\n解决长期漂移\n\n终点标准：\n任务不偏\n\n当前路线 v1：\n先完成 CLI",
      workspace: root,
    });
    assert.equal(idea.migrationStatus, "deterministic-split");
    assert.match(idea.ideaKernel.content, /解决长期漂移/);
    assert.doesNotMatch(idea.ideaKernel.content, /先完成 CLI/);
    assert.equal(idea.researchFrame.content, "先完成 CLI");

    const updated = store.updateWorkingState(idea.ideaId, { nextAction: "修复 session 恢复" }, { actor: "model" });
    assert.equal(updated.workingState.nextAction, "修复 session 恢复");
    assert.throws(() => store.updateWorkingState(idea.ideaId, { phase: "complete" }, { actor: "model" }), /cannot update/);

    const proposal = store.proposeResearchFrame(idea.ideaId, "先完成 CLI，再验证组件内核", { actor: "model" });
    assert.equal(store.getIdea(idea.ideaId).researchFrame.content, "先完成 CLI");
    assert.throws(() => store.confirmResearchFrame(idea.ideaId, proposal.proposalId, { actor: "model" }), /Only the user/);
    const confirmed = store.confirmResearchFrame(idea.ideaId, proposal.proposalId, { actor: "user-test" });
    assert.equal(confirmed.researchFrame.version, 2);
    assert.equal(confirmed.researchFrame.parentHash, idea.researchFrame.hash);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM idea_registry_research_events WHERE idea_id=?").get(idea.ideaId).count, 4);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unpersisted empty Pi session can be rebound without changing conversation ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-idea-rebind-"));
  let store;
  try {
    store = new IdeaWorkspaceStore({ databasePath: join(root, "registry.sqlite") });
    const idea = store.importConfirmedIdea({ content: "研究目标", workspace: root });
    store.bindConversation({ ideaId: idea.ideaId, sessionId: "empty-main", sessionFile: join(root, "missing.jsonl"), kind: "main", workspace: root });
    store.bindConversation({ ideaId: idea.ideaId, sessionId: "transient", sessionFile: join(root, "new.jsonl"), kind: "btw", workspace: root });
    const rebound = store.rebindConversationSession("empty-main", { nextSessionId: "transient", sessionFile: join(root, "new.jsonl") });
    assert.equal(rebound.kind, "main");
    assert.equal(rebound.ideaId, idea.ideaId);
    assert.equal(store.conversation("empty-main"), null);
    assert.equal(store.getIdea(idea.ideaId).conversations.filter((row) => row.kind === "main" && row.active).length, 1);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
