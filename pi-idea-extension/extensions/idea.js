import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, uuidv7 } from "@earendil-works/pi-ai";
import {
  STATE_TYPE,
  IDEA_TOOLBOX,
  applyEvent,
  budgetFor,
  buildAnchor,
  confirmProposal,
  emptyState,
  estimateTokens,
  extractIdeaCandidate,
  extractSkillCandidates,
  makeConfirmedStateFact,
  makeProposal,
  narrowStateText,
  replay,
  sha256,
  toolBoundaryDecision,
} from "../src/core.js";
import { RingLog } from "../src/ring-log.js";
import { evidenceTagPrompt, parseEvidenceTags } from "../src/context-compiler.js";
import {
  attachSessionEntryProvenance,
  compileBaselineSafeContext,
  compileProductionContext,
  contextAdoptionMode,
} from "../src/production-context-assembly.js";
import { ProjectMemoryStore } from "../src/project-memory-store.js";
import { WorkerProjectIndex } from "../src/worker-project-index.js";
import { createCandidateForestReranker } from "../src/candidate-forest-reranker.js";
import { IdeaWorkspaceStore, lineDiff } from "../src/idea-workspace-store.js";
import { workingStateText } from "../src/research-state.js";
import {
  WorkflowRunRegistry,
  contextModeLabel,
  observedSessionUsage,
  researchDashboardText,
  researchFooter,
  workflowStatusLabel,
} from "../src/research-console-ui.js";

const INIT_INSTRUCTION = `请忠实整理用户的科研想法。候选只保留长期稳定的 Idea Kernel：科学对象、成功标准，以及明确禁止被局部工程替代的边界；不要把当前路线、计划、TODO 或临时假设写入候选。不要强制固定标题、字段名、顺序或标点，也不要补充用户没有表达的方向；有实质歧义就提问。若可以形成候选，只输出一次：[[IDEA_CANDIDATE]]候选全文[[/IDEA_CANDIDATE]]。候选不会自动生效，用户将在界面确认；当前路线随后作为 Research Frame 单独提出并由用户确认。`;

function sessionKey(ctx) {
  const raw = ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.() || "ephemeral";
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 24);
}

function agentDataDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadOptionalCandidateForest(path = process.env.PI_IDEA_FOREST_MODEL) {
  const requested = String(path || "").trim();
  if (!requested) return Object.freeze({ reranker: null, status: "disabled", path: null, error: null });
  try {
    if (!existsSync(requested)) throw new Error("model file does not exist");
    const reranker = createCandidateForestReranker(JSON.parse(readFileSync(requested, "utf8")));
    return Object.freeze({ reranker, status: "loaded", path: requested, error: null });
  } catch (error) {
    return Object.freeze({ reranker: null, status: "invalid-fallback", path: requested, error: String(error?.message || error).slice(0, 300) });
  }
}

function textOfResult(result) {
  return (result?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 2000);
}

function textOfAssistant(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function replaceAssistantText(message, text) {
  let replaced = false;
  const content = (message.content || []).flatMap((part) => {
    if (part?.type !== "text") return [part];
    if (replaced) return [];
    replaced = true;
    return [{ ...part, text }];
  });
  if (!replaced && text) content.push({ type: "text", text });
  return { ...message, content };
}

function createBuiltIns(cwd) {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
  };
}

function branchMessagesWithProvenance(ctx, fallback = [], initialState = null) {
  const branch = ctx?.sessionManager?.getBranch?.() || [];
  const hasStateEvents = branch.some((entry) => entry?.type === "custom" && entry?.customType === STATE_TYPE);
  const messages = attachSessionEntryProvenance(branch, {
    sessionId: ctx?.sessionManager?.getSessionId?.() || "unknown-session",
    initialState: hasStateEvents ? null : initialState,
  });
  return messages.length ? messages : fallback;
}

function recentLiveEntryIds(messages, turns = 4) {
  const source = Array.isArray(messages) ? messages : [];
  let users = 0;
  let start = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index]?.role === "user") users += 1;
    if (users > turns) {
      start = index + 1;
      break;
    }
  }
  return source.slice(start).map((message) => message.entryId).filter(Boolean);
}

function isContinuationCue(prompt) {
  const value = String(prompt || "").trim();
  if (!value || value.length > 80) return false;
  return /^(?:(?:继续|接着)(?:做|推进)?(?:当前(?:节点|任务|工作))?|按刚才(?:的)?继续|continue|keep going|go on)[。.!！\s]*$/i.test(value);
}

function mergeBlocks(...groups) {
  const blocks = new Map();
  for (const group of groups) for (const block of group || []) if (block?.blockId && !blocks.has(block.blockId)) blocks.set(block.blockId, block);
  return [...blocks.values()].sort((left, right) => (left.provenance?.ledgerOrder || 0) - (right.provenance?.ledgerOrder || 0));
}

export default function ideaExtension(pi) {
  const optionalForest = loadOptionalCandidateForest();
  let state = null;
  let currentPrompt = "";
  let manifestLog = null;
  let traceLog = null;
  let evidenceLog = null;
  let projectMemory = null;
  let sessionEntryCursor = 0;
  let restoredFromProject = false;
  let evidenceCache = new Map();
  let indexQueue = Promise.resolve();
  let pendingIndexing = new Set();
  let indexFailures = new Map();
  let toolCount = 0;
  const activeTools = new Map();
  const workflowRuns = new WorkflowRunRegistry();
  let silentToolsRegistered = false;
  const approvedExternalRoots = new Set();
  let projectIndexQueue = null;
  let lastAssemblyEvidenceIds = [];
  let ideaRegistry = null;
  let sessionBinding = null;

  function appendState(event) {
    const complete = { schema: 1, at: new Date().toISOString(), ...event };
    pi.appendEntry(STATE_TYPE, complete);
    state = applyEvent(state, complete);
    try { if (state?.idea) projectMemory?.saveCapsule(state); } catch { /* session state remains authoritative */ }
    try {
      if (state?.ideaId) ideaRegistry?.saveRuntimeState(state.ideaId, state);
    } catch { /* registry is a durable projection; the session event remains authoritative for this turn */ }
    return complete;
  }

  function stateFromCapsule(capsule) {
    return {
      ...emptyState(),
      enabled: Boolean(capsule?.enabled),
      paused: Boolean(capsule?.paused),
      ideaId: capsule?.ideaId || null,
      conversationKind: capsule?.conversationKind === "btw" ? "btw" : "main",
      workspaces: Array.isArray(capsule?.workspaces) ? capsule.workspaces : [],
      idea: capsule?.idea || null,
      ideaKernel: capsule?.ideaKernel || null,
      researchFrame: capsule?.researchFrame || null,
      workingState: capsule?.workingState || emptyState().workingState,
      pendingFrameProposal: capsule?.pendingFrameProposal || null,
      stage: String(capsule?.stage || ""),
      narrowState: Array.isArray(capsule?.narrowState) ? capsule.narrowState : [],
      todos: Array.isArray(capsule?.todos) ? capsule.todos : [],
      skills: Array.isArray(capsule?.skills) ? capsule.skills : [],
    };
  }

  function stateFromRegistry(bound, fallback = state) {
    const runtime = ideaRegistry?.loadRuntimeState(bound.idea.ideaId) || {};
    return {
      ...emptyState(),
      enabled: true,
      paused: false,
      ideaId: bound.idea.ideaId,
      conversationKind: bound.conversation.kind,
      workspaces: bound.idea.workspaces,
      idea: {
        version: bound.idea.version,
        content: bound.idea.content,
        hash: bound.idea.hash,
        parentHash: bound.idea.parentHash,
        confirmedAt: bound.idea.confirmedAt,
      },
      ideaKernel: bound.idea.ideaKernel,
      researchFrame: bound.idea.researchFrame,
      workingState: bound.idea.workingState,
      pendingFrameProposal: bound.idea.pendingFrameProposal,
      stage: runtime.stage ?? fallback?.stage ?? "",
      narrowState: runtime.narrowState ?? fallback?.narrowState ?? [],
      todos: bound.idea.todos,
      skills: runtime.skills ?? fallback?.skills ?? [],
    };
  }

  function refreshRegistryContext(ctx, { append = false } = {}) {
    if (!ideaRegistry) return null;
    const sessionId = ctx.sessionManager.getSessionId?.();
    if (!sessionId) return null;
    const bound = ideaRegistry.contextForSession(sessionId);
    if (!bound) return null;
    sessionBinding = bound.conversation;
    const next = stateFromRegistry(bound, state);
    const changed = state?.ideaId !== next.ideaId
      || state?.idea?.hash !== next.idea?.hash
      || state?.ideaKernel?.hash !== next.ideaKernel?.hash
      || state?.researchFrame?.hash !== next.researchFrame?.hash
      || state?.workingState?.hash !== next.workingState?.hash
      || state?.conversationKind !== next.conversationKind
      || JSON.stringify(state?.todos || []) !== JSON.stringify(next.todos || []);
    state = next;
    if (append && changed) {
      pi.appendEntry(STATE_TYPE, {
        schema: 1,
        at: new Date().toISOString(),
        op: "workspace-bound",
        ideaId: state.ideaId,
        conversationKind: state.conversationKind,
        workspaces: state.workspaces,
        idea: state.idea,
        ideaKernel: state.ideaKernel,
        researchFrame: state.researchFrame,
        workingState: state.workingState,
        pendingFrameProposal: state.pendingFrameProposal,
        stage: state.stage,
        narrowState: state.narrowState,
        todos: state.todos,
        skills: state.skills,
      });
    }
    return bound;
  }

  function workflowSnapshot() {
    if (ideaRegistry && state?.ideaId) {
      const rows = ideaRegistry.listWorkflows(state.ideaId);
      const active = rows.filter((row) => ["running", "waiting", "blocked"].includes(row.status));
      return Object.freeze({ rows: Object.freeze(rows), active: Object.freeze(active), activeCount: active.length });
    }
    return workflowRuns.snapshot();
  }

  function scheduleProjectEntries(ctx) {
    if (!projectMemory || !projectIndexQueue) return Object.freeze({
      schema: 1,
      mode: "worker-thread-deterministic-cpu",
      pendingEntries: 0,
      completedEntries: 0,
      completedBlocks: 0,
      lastCompletedAt: null,
      lastError: projectMemory ? "index-worker-unavailable" : null,
    });
    const entries = ctx.sessionManager.getEntries?.() || [];
    const delta = entries.slice(Math.min(sessionEntryCursor, entries.length));
    sessionEntryCursor = entries.length;
    return projectIndexQueue.schedule(delta, {
      sessionId: ctx.sessionManager.getSessionId?.() || "unknown-session",
      sessionFile: ctx.sessionManager.getSessionFile?.() || null,
      activeEntries: ctx.sessionManager.getBranch?.() || [],
      initialState: state,
    });
  }

  function syncStatus(ctx) {
    if (!ctx?.ui?.setStatus) return;
    if (!state?.enabled || state.paused || !state.idea) {
      ctx.ui.setStatus("idea", "");
      return;
    }
    const when = new Date(state.idea.confirmedAt).toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    ctx.ui.setStatus("idea", `◆ Idea · 更新 ${when}`);
  }

  function relativeToolAge(value) {
    const started = Date.parse(String(value || ""));
    if (!Number.isFinite(started)) return "?";
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
  }

  async function showIdea(ctx) {
    const lines = state?.idea
      ? [
        "Idea Kernel：", state.ideaKernel?.content || state.idea.content,
        "", "Research Frame：", state.researchFrame?.content || "（等待用户定义）",
        "", "Working State：", workingStateText(state.workingState),
        "", `Kernel hash：${state.ideaKernel?.hash || state.idea.hash}`,
        `确认：${state.ideaKernel?.confirmedAt || state.idea.confirmedAt}`,
      ].join("\n")
      : "当前对话尚未启用 Idea 保持。使用 /idea-start。";
    await ctx.ui.select(lines, ["关闭"]);
  }

  async function showContext(ctx) {
    const last = manifestLog?.tail(1)?.[0] || null;
    const compiler = last?.contextCompiler || null;
    const usage = ctx.getContextUsage?.();
    const text = compiler
      ? [
        `模式：${contextModeLabel(contextAdoptionMode())}`,
        `上下文：${usage?.tokens ?? "?"}/${usage?.contextWindow ?? ctx.model?.contextWindow ?? "?"} (${usage?.percent == null ? "?" : `${Math.round(usage.percent)}%`})`,
        `token 分解：${JSON.stringify(compiler.tokens || {})}`,
        `水位：${JSON.stringify(compiler.watermarks || {})}`,
        `选入：${(last.selectedBlockIds || []).length}`,
        `排除：${(last.droppedBlockIds || []).length}`,
        `暂缓：${(last.deferredBlockIds || []).length}`,
        `策略：${compiler.selectionPolicy || compiler.assembly?.selectionPolicy || "unknown"}`,
      ].join("\n")
      : "尚无上下文组装记录。";
    await ctx.ui.select(text, ["关闭"]);
  }

  async function showWorkflows(ctx) {
    const workflows = workflowSnapshot();
    const tools = [...activeTools.values()];
    const rows = [
      ...workflows.rows.map((row) => `流 ${workflowStatusLabel(row.status).padEnd(4)} ${row.model}:${row.reasoningEffort} · ${row.label}`),
      ...tools.map((row) => `工 运行   ${row.tool} · ${relativeToolAge(row.startedAt)}`),
    ];
    const selected = await ctx.ui.select("工具 / Workflow", rows.length ? [...rows, "关闭"] : ["当前没有运行中的工具线程", "关闭"]);
    const workflowIndex = rows.indexOf(selected);
    if (workflowIndex >= 0 && workflowIndex < workflows.rows.length) {
      await ctx.ui.select(JSON.stringify(workflows.rows[workflowIndex], null, 2), ["关闭"]);
    }
  }

  function registerSilentTools(ctx) {
    if (silentToolsRegistered) return;
    const tools = createBuiltIns(ctx.cwd);
    for (const [name, original] of Object.entries(tools)) {
      pi.registerTool({
        name,
        label: original.label || name,
        description: original.description,
        parameters: original.parameters,
        renderShell: "self",
        async execute(toolCallId, params, signal, onUpdate, toolCtx) {
          const current = createBuiltIns(toolCtx.cwd)[name];
          return current.execute(toolCallId, params, signal, onUpdate);
        },
        renderCall() { return new Text("", 0, 0); },
        renderResult() { return new Text("", 0, 0); },
      });
    }
    silentToolsRegistered = true;
  }

  function restoreNativeTools(ctx) {
    if (!silentToolsRegistered) return;
    for (const original of Object.values(createBuiltIns(ctx.cwd))) pi.registerTool(original);
    silentToolsRegistered = false;
  }

  function validateBudget(ctx, idea = state?.idea?.content || "", stage = state?.stage || "", narrowState = state?.narrowState || []) {
    return budgetFor({
      idea,
      ideaKernel: state?.ideaKernel,
      researchFrame: state?.researchFrame,
      workingState: state?.workingState,
      stage,
      narrowState,
      contextWindow: ctx.model?.contextWindow || 272000,
      systemPrompt: ctx.getSystemPrompt?.() || "",
    });
  }

  function scheduleEvidenceIndex(units, ctx, { forceRetry = false } = {}) {
    if (!state?.idea || state.paused) return { scheduled: 0, promise: indexQueue };
    const model = ctx.modelRegistry.find("openai-codex", "gpt-5.6-luna");
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return { scheduled: 0, promise: indexQueue };
    // A queued index may finish after the user switches sessions. Capture the
    // session-owned stores now so its result can never leak into the new session.
    const targetLog = evidenceLog;
    const targetCache = evidenceCache;
    const targetFailures = indexFailures;
    const targetPending = pendingIndexing;
    const ideaHash = state.idea.hash;
    const stageHash = sha256(state.stage || "");
    const work = units
      .filter((unit) => {
        const failure = targetFailures.get(unit.id);
        return unit.stable
          && !targetCache.has(unit.id)
          && !targetPending.has(unit.id)
          && (!failure || (failure.attempts < 3 && (forceRetry || Date.now() >= failure.nextAt)));
      })
      .slice(0, Math.max(0, 8 - targetPending.size));
    for (const unit of work) {
      targetPending.add(unit.id);
      indexQueue = indexQueue.then(async () => {
        const started = Date.now();
        try {
          const response = await ctx.modelRegistry.complete(
            model,
            {
              messages: [{
                role: "user",
                content: [{ type: "text", text: evidenceTagPrompt(unit, { ideaHash, stageHash }) }],
                timestamp: Date.now(),
              }],
            },
            {
              maxTokens: 1000,
              reasoningEffort: "low",
              cacheRetention: "none",
              sessionId: uuidv7(),
              signal: AbortSignal.timeout(90000),
            },
          );
          const raw = (response.content || [])
            .filter((part) => part?.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          const tokens = estimateTokens(raw);
          if (!raw || tokens > 900) throw new Error(`invalid evidence index size: ${tokens}`);
          const parsed = parseEvidenceTags(raw, unit, { ideaHash, stageHash });
          if (!parsed.valid) throw new Error("invalid evidence index JSON");
          const record = {
            schema: 4,
            at: new Date().toISOString(),
            id: unit.id,
            blockIds: unit.blockIds,
            rawHash: sha256(unit.text),
            rawTokens: unit.tokens,
            claims: parsed.claims,
            rejectedClaims: parsed.rejected,
            tokens,
            model: `${model.provider}/${model.id}`,
            ms: Date.now() - started,
          };
          targetCache.set(unit.id, record);
          targetFailures.delete(unit.id);
          targetLog?.append(record);
        } catch (error) {
          const prior = targetFailures.get(unit.id);
          const attempts = (prior?.attempts || 0) + 1;
          const delays = [5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
          const nextAt = Date.now() + delays[Math.min(attempts - 1, delays.length - 1)];
          const failure = {
            schema: 1,
            at: new Date().toISOString(),
            id: unit.id,
            error: error instanceof Error ? error.message : String(error),
            ms: Date.now() - started,
            attempts,
            nextAt,
          };
          targetFailures.set(unit.id, failure);
          targetLog?.append(failure);
        } finally {
          targetPending.delete(unit.id);
        }
      });
    }
    return { scheduled: work.length, promise: indexQueue };
  }

  pi.registerTool({
    name: "idea_todo",
    label: "Idea Todo",
    description: "Inspect or revise the active Idea todo list after practical work. User-edited items must be checked against evidence and the Scientific Idea, not blindly obeyed.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update")]),
      todoId: Type.Optional(Type.String({ description: "Todo id for update" })),
      text: Type.Optional(Type.String({ description: "New or revised todo text" })),
      status: Type.Optional(Type.Union([
        Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("blocked"),
      ])),
    }),
    async execute(_toolCallId, params) {
      if (!ideaRegistry || !state?.ideaId) {
        return { content: [{ type: "text", text: "No Idea workspace is bound to this conversation." }], details: { error: "unbound" } };
      }
      if (params.action !== "list" && state.conversationKind !== "main") {
        return { content: [{ type: "text", text: "BTW conversations may inspect Todos but cannot mutate the main execution state." }], details: { error: "btw-read-only" } };
      }
      try {
        if (params.action === "add") {
          if (!params.text) throw new Error("text is required for add");
          ideaRegistry.addTodo(state.ideaId, { text: params.text, status: params.status || "pending", source: "model-tool" });
        } else if (params.action === "update") {
          if (!params.todoId) throw new Error("todoId is required for update");
          ideaRegistry.updateTodo(state.ideaId, params.todoId, { text: params.text, status: params.status }, { actor: "model-tool" });
        }
        const todos = ideaRegistry.listTodos(state.ideaId);
        state.todos = todos;
        appendState({ op: "todo-snapshot", todos });
        const text = todos.length
          ? todos.map((todo) => `[${todo.status}] ${todo.todoId.slice(0, 8)} ${todo.text}${todo.pendingModelReview ? " · user review pending" : ""}`).join("\n")
          : "Todo list is empty.";
        return { content: [{ type: "text", text }], details: { action: params.action, todos } };
      } catch (error) {
        return { content: [{ type: "text", text: `Todo update failed: ${error instanceof Error ? error.message : String(error)}` }], details: { error: String(error) } };
      }
    },
  });

  pi.registerTool({
    name: "idea_research_state",
    label: "Idea Research State",
    description: "Inspect or fill the model-owned Working State, or suggest a Research Frame diff. Suggestions never confirm or replace the user-owned frame.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("show"), Type.Literal("update_working"), Type.Literal("suggest_frame")]),
      activeHypothesis: Type.Optional(Type.String()),
      activeRoute: Type.Optional(Type.String()),
      evidenceGap: Type.Optional(Type.String()),
      nextAction: Type.Optional(Type.String()),
      expectedInformation: Type.Optional(Type.String()),
      continueReason: Type.Optional(Type.String()),
      stopProposal: Type.Optional(Type.String()),
      conflicts: Type.Optional(Type.Array(Type.String())),
      frameContent: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (!ideaRegistry || !state?.ideaId) return { content: [{ type: "text", text: "No Idea is bound." }], details: { error: "unbound" } };
      if (params.action !== "show" && state.conversationKind !== "main") {
        return { content: [{ type: "text", text: "BTW conversations may only inspect Research State." }], details: { error: "btw-read-only" } };
      }
      try {
        if (params.action === "update_working") {
          const patch = Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== "action" && key !== "frameContent" && value !== undefined));
          const research = ideaRegistry.updateWorkingState(state.ideaId, patch, { actor: "model" });
          state.workingState = research.workingState;
          appendState({ op: "working-state-updated", workingState: state.workingState });
        } else if (params.action === "suggest_frame") {
          if (!params.frameContent) throw new Error("frameContent is required.");
          const proposal = ideaRegistry.proposeResearchFrame(state.ideaId, params.frameContent, { actor: "model" });
          state.pendingFrameProposal = proposal;
          appendState({ op: "frame-proposal-created", proposal });
        }
        const text = [
          `Idea Kernel\n${state.ideaKernel?.content || state.idea?.content || ""}`,
          `Research Frame\n${state.researchFrame?.content || "（空）"}`,
          `Working State\n${workingStateText(state.workingState)}`,
          state.pendingFrameProposal ? `Pending Frame Proposal ${state.pendingFrameProposal.proposalId}` : "",
        ].filter(Boolean).join("\n\n");
        return { content: [{ type: "text", text }], details: { workingState: state.workingState, pendingFrameProposal: state.pendingFrameProposal } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { error: String(error) } };
      }
    },
  });

  pi.registerTool({
    name: "idea_workflow_status",
    label: "Idea Workflow Status",
    description: "List or update observable Workflow/worker progress for the active Idea. Use it when delegated work starts, waits, blocks, completes, fails, or reports bounded progress. It never changes the Scientific Idea.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("update")]),
      runId: Type.Optional(Type.String({ description: "Stable run id; omit on first update to create one" })),
      parentRunId: Type.Optional(Type.String()),
      kind: Type.Optional(Type.Union([Type.Literal("workflow"), Type.Literal("worker")])),
      label: Type.Optional(Type.String()),
      status: Type.Optional(Type.Union([
        Type.Literal("running"), Type.Literal("waiting"), Type.Literal("blocked"),
        Type.Literal("complete"), Type.Literal("failed"), Type.Literal("cancelled"),
      ])),
      model: Type.Optional(Type.String()),
      reasoningEffort: Type.Optional(Type.String()),
      objective: Type.Optional(Type.String()),
      detail: Type.Optional(Type.String()),
      progressCurrent: Type.Optional(Type.Integer({ minimum: 0 })),
      progressTotal: Type.Optional(Type.Integer({ minimum: 0 })),
      cardHash: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (!ideaRegistry || !state?.ideaId) {
        return { content: [{ type: "text", text: "No Idea workspace is bound to this conversation." }], details: { error: "unbound" } };
      }
      if (params.action === "update" && state.conversationKind !== "main") {
        return { content: [{ type: "text", text: "BTW conversations may inspect Workflow progress but cannot mutate the main execution state." }], details: { error: "btw-read-only" } };
      }
      try {
        let updated = null;
        if (params.action === "update") {
          updated = ideaRegistry.upsertWorkflow(state.ideaId, {
            ...params,
            conversationId: sessionBinding?.sessionId || null,
          }, { actor: "model-tool" });
          workflowRuns.upsert({
            taskId: updated.runId,
            label: updated.label,
            status: updated.status,
            model: updated.model,
            reasoningEffort: updated.reasoningEffort,
            objective: updated.objective,
            cardHash: updated.cardHash,
            startedAt: updated.startedAt,
            detail: updated.detail,
          });
        }
        const workflows = ideaRegistry.listWorkflows(state.ideaId);
        const text = workflows.length
          ? workflows.map((row) => {
            const progress = row.progressTotal == null ? "" : ` · ${row.progressCurrent || 0}/${row.progressTotal}`;
            return `[${row.status}] ${row.runId.slice(0, 8)} ${row.kind} ${row.label}${progress}${row.detail ? ` · ${row.detail}` : ""}`;
          }).join("\n")
          : "Workflow list is empty.";
        return { content: [{ type: "text", text }], details: { action: params.action, updated, workflows } };
      } catch (error) {
        return { content: [{ type: "text", text: `Workflow update failed: ${error instanceof Error ? error.message : String(error)}` }], details: { error: String(error) } };
      }
    },
  });

  pi.registerCommand("idea-start", {
    description: "用自然语言为当前普通对话提出一个 Idea 候选",
    handler: async (args, ctx) => {
      const description = String(args || "").trim() || await ctx.ui.input("描述你的想法", "自然语言即可，不需要固定格式");
      if (!description) return;
      appendState({ op: "initialization-requested", description });
      pi.sendMessage({
        customType: "idea-initialization",
        content: `${INIT_INSTRUCTION}\n\n用户原始描述：\n${description}`,
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });

  pi.registerCommand("idea-propose", {
    description: "直接设置一个待确认 Idea 候选，不会立即生效",
    handler: async (args, ctx) => {
      const content = String(args || "").trim() || await ctx.ui.input("Idea 候选", "自由格式");
      if (!content) return;
      const proposal = makeProposal(content, "user");
      const budget = validateBudget(ctx, proposal.content, state?.stage || "");
      if (budget.p0Tokens > budget.p0Limit) {
        ctx.ui.notify(`候选过长：约 ${budget.p0Tokens}/${budget.p0Limit} tokens`, "warning");
        return;
      }
      appendState({ op: "proposal-created", proposal });
      ctx.ui.notify("Idea 候选已保存，使用 /idea-confirm 查看并确认。", "info");
    },
  });

  pi.registerCommand("idea-confirm", {
    description: "查看精确候选并由用户确认成为新的权威 Idea",
    handler: async (_args, ctx) => {
      if (!state?.proposal?.content) {
        ctx.ui.notify("当前没有待确认的 Idea 候选。", "warning");
        return;
      }
      const exactDiff = lineDiff(state.idea?.content || "", state.proposal.content);
      const choice = await ctx.ui.select(`确认 Idea 修改（精确 diff）\n\n${exactDiff}`, ["确认生效", "继续调整", "放弃"]);
      if (choice !== "确认生效") return;
      const budget = validateBudget(ctx, state.proposal.content, state.stage);
      if (!budget.ok) {
        ctx.ui.notify(`P0/P1 预算未通过：${budget.combined}/${budget.combinedLimit}`, "error");
        return;
      }
      let idea = confirmProposal(state.proposal, state.idea);
      let ideaId = state.ideaId || null;
      if (ideaRegistry) {
        const proposal = ideaRegistry.proposeIdea({ ideaId, content: state.proposal.content });
        const confirmed = ideaRegistry.confirmProposal(proposal.proposalId, { source: "user-pi-confirmation" });
        ideaId = confirmed.ideaId;
        idea = {
          version: confirmed.version,
          content: confirmed.content,
          hash: confirmed.hash,
          parentHash: confirmed.parentHash,
          confirmedAt: confirmed.confirmedAt,
        };
        const sessionId = ctx.sessionManager.getSessionId?.();
        if (sessionId && !ideaRegistry.conversation(sessionId)) {
          sessionBinding = ideaRegistry.bindConversation({
            ideaId,
            sessionId,
            sessionFile: ctx.sessionManager.getSessionFile?.() || null,
            workspace: ctx.cwd,
            kind: "main",
          });
        }
      }
      appendState({ op: "idea-confirmed", ideaId, idea });
      registerSilentTools(ctx);
      syncStatus(ctx);
      ctx.ui.notify("Idea 保持已在当前对话启用。", "info");
    },
  });

  pi.registerCommand("idea", {
    description: "查看当前 Idea、阶段和候选状态",
    handler: async (_args, ctx) => showIdea(ctx),
  });

  pi.registerCommand("idea-bind", {
    description: "将当前会话绑定到已有 Idea；网页工作台使用：/idea-bind <idea-id> <main|btw>",
    handler: async (args, ctx) => {
      if (!ideaRegistry) return ctx.ui.notify("Idea registry 未启用。", "error");
      const [ideaId, requestedKind = "btw"] = String(args || "").trim().split(/\s+/);
      if (!ideaId) return ctx.ui.notify("请提供 Idea id。", "warning");
      const kind = requestedKind === "main" ? "main" : "btw";
      try {
        sessionBinding = ideaRegistry.bindConversation({
          ideaId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          sessionFile: ctx.sessionManager.getSessionFile?.() || null,
          workspace: ctx.cwd,
          kind,
        });
        const bound = refreshRegistryContext(ctx, { append: true });
        if (!bound) throw new Error("Binding could not be restored.");
        registerSilentTools(ctx);
        syncStatus(ctx);
        ctx.ui.notify(`已绑定 ${bound.idea.title} · ${kind === "main" ? "主对话" : "BTW"}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("idea-stage", {
    description: "设置当前阶段最小工作集；为空则清除",
    handler: async (args, ctx) => {
      if (!state?.idea) return ctx.ui.notify("请先确认 Idea。", "warning");
      const stage = String(args || "").trim();
      const budget = validateBudget(ctx, state.idea.content, stage);
      if (!budget.ok) return ctx.ui.notify(`P0/P1 预算未通过：${budget.combined}/${budget.combinedLimit}`, "error");
      appendState({ op: "stage-set", stage });
      ctx.ui.notify(stage ? "当前阶段已更新。" : "当前阶段已清除。", "info");
    },
  });

  pi.registerCommand("idea-frame", {
    description: "查看当前 Research Frame 和待确认建议",
    handler: async (_args, ctx) => {
      const text = [
        state?.researchFrame?.content || "当前 Research Frame 为空。",
        state?.pendingFrameProposal ? `\n待确认建议 ${state.pendingFrameProposal.proposalId}\n\n${state.pendingFrameProposal.content}` : "",
      ].join("");
      await ctx.ui.select(text, ["关闭"]);
    },
  });

  pi.registerCommand("idea-frame-confirm", {
    description: "由用户确认当前 Research Frame 建议",
    handler: async (_args, ctx) => {
      const proposal = state?.pendingFrameProposal;
      if (!ideaRegistry || !state?.ideaId || !proposal) return ctx.ui.notify("当前没有待确认的 Research Frame 建议。", "warning");
      const diff = lineDiff(state.researchFrame?.content || "", proposal.content);
      const choice = await ctx.ui.select(`确认 Research Frame 修改（精确 diff）\n\n${diff}`, ["确认生效", "取消"]);
      if (choice !== "确认生效") return;
      const research = ideaRegistry.confirmResearchFrame(state.ideaId, proposal.proposalId, { actor: "user-pi-confirmation" });
      state.researchFrame = research.researchFrame;
      state.pendingFrameProposal = null;
      appendState({ op: "frame-confirmed", researchFrame: state.researchFrame });
      ctx.ui.notify("Research Frame 已生成新的用户确认版本。", "info");
    },
  });

  pi.registerCommand("idea-working", {
    description: "查看模型可填充但无决策权的 Working State",
    handler: async (_args, ctx) => ctx.ui.select(workingStateText(state?.workingState), ["关闭"]),
  });

  pi.registerCommand("idea-state-set", {
    description: "显式确认一个窄状态项：/idea-state-set key=value",
    handler: async (args, ctx) => {
      if (!state?.idea) return ctx.ui.notify("请先确认 Idea。", "warning");
      let input = String(args || "").trim();
      if (!input) input = String(await ctx.ui.input("确认窄状态", "key=value；仅放当前决策、约束或已验证状态") || "").trim();
      const separator = input.indexOf("=");
      if (separator <= 0 || separator === input.length - 1) return ctx.ui.notify("格式必须是 key=value。", "warning");
      const key = input.slice(0, separator).trim();
      const value = input.slice(separator + 1).trim();
      const existing = (state.narrowState || []).find((fact) => fact.key === key) || null;
      let fact;
      try { fact = makeConfirmedStateFact({ key, value, previous: existing, source: "user-command" }); }
      catch (error) { return ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
      const nextNarrowState = [...(state.narrowState || []).filter((item) => item.key !== fact.key), fact];
      const budget = validateBudget(ctx, state.idea.content, state.stage, nextNarrowState);
      if (!budget.ok) return ctx.ui.notify(`窄状态超预算：${budget.stateTokens}/${budget.stateLimit} tokens`, "error");
      appendState({ op: "state-fact-set", fact });
      ctx.ui.notify(`${fact.key} 已由用户确认并写入窄状态 v${fact.version}。`, "info");
    },
  });

  pi.registerCommand("idea-state-unset", {
    description: "显式移除一个当前窄状态项；raw 历史不删除",
    handler: async (args, ctx) => {
      const key = String(args || "").trim();
      if (!key || !(state?.narrowState || []).some((fact) => fact.key === key)) return ctx.ui.notify("请提供现有窄状态 key。", "warning");
      appendState({ op: "state-fact-unset", key });
      ctx.ui.notify(`${key} 已从当前视图移除；原始事件仍永久保留。`, "info");
    },
  });

  pi.registerCommand("idea-state", {
    description: "查看用户确认的当前窄状态",
    handler: async (_args, ctx) => {
      await ctx.ui.select(narrowStateText(state?.narrowState) || "当前窄状态为空。", ["关闭"]);
    },
  });

  pi.registerCommand("idea-pause", {
    description: "暂停当前对话的 Idea 注入，不删除状态",
    handler: async (_args, ctx) => {
      appendState({ op: "paused" });
      restoreNativeTools(ctx);
      syncStatus(ctx);
      ctx.ui.notify("Idea 保持已暂停。", "info");
    },
  });

  pi.registerCommand("idea-resume", {
    description: "恢复当前对话的 Idea 注入",
    handler: async (_args, ctx) => {
      if (!state?.idea) return ctx.ui.notify("当前对话没有已确认 Idea。", "warning");
      appendState({ op: "resumed" });
      registerSilentTools(ctx);
      syncStatus(ctx);
      ctx.ui.notify("Idea 保持已恢复。", "info");
    },
  });

  pi.registerCommand("idea-manifest", {
    description: "查看最近一次实际上下文注入清单",
    handler: async (_args, ctx) => {
      const last = manifestLog?.tail(1)?.[0];
      await ctx.ui.select(last ? JSON.stringify(last, null, 2) : "尚无注入记录。", ["关闭"]);
    },
  });

  pi.registerCommand("idea-context", {
    description: "查看本轮上下文用量、水位和组装选择",
    handler: async (_args, ctx) => showContext(ctx),
  });

  pi.registerCommand("idea-workflows", {
    description: "查看当前工具执行与 Workflow 线程",
    handler: async (_args, ctx) => showWorkflows(ctx),
  });

  pi.registerCommand("idea-dashboard", {
    description: "打开 Pi-Idea 研究控制台",
    handler: async (_args, ctx) => {
      while (true) {
        const last = manifestLog?.tail(1)?.[0] || null;
        const text = researchDashboardText({
          state,
          context: ctx.getContextUsage?.(),
          usage: observedSessionUsage(ctx.sessionManager.getBranch?.() || []),
          mode: contextAdoptionMode(),
          workflows: workflowSnapshot(),
          activeTools: [...activeTools.values()],
          manifest: last,
        });
        const action = await ctx.ui.select(text, ["刷新", "当前 Idea", "上下文", "工具 / Workflow", "关闭"]);
        if (!action || action === "关闭") break;
        if (action === "当前 Idea") await showIdea(ctx);
        if (action === "上下文") await showContext(ctx);
        if (action === "工具 / Workflow") await showWorkflows(ctx);
      }
    },
  });

  pi.registerCommand("idea-trace", {
    description: "查看主对话之外保存的最近执行痕迹",
    handler: async (_args, ctx) => {
      const rows = traceLog?.tail(20) || [];
      const options = rows.length
        ? rows.map((row) => `${row.ok ? "✓" : "×"} ${row.tool} · ${row.ms ?? "…"}ms · ${row.at}`)
        : ["没有记录"];
      const selected = await ctx.ui.select("最近执行痕迹", [...options, "关闭"]);
      const index = options.indexOf(selected);
      if (index >= 0 && rows[index]) await ctx.ui.select(JSON.stringify(rows[index], null, 2), ["关闭"]);
    },
  });

  pi.registerCommand("idea-skills", {
    description: "查看候选/已验证执行经验",
    handler: async (_args, ctx) => {
      const items = state?.skills || [];
      const text = items.length
        ? items.map((skill) => `${skill.id.slice(0, 8)} [${skill.status}] ${skill.lesson}`).join("\n\n")
        : "尚无执行经验候选。";
      await ctx.ui.select(text, ["关闭"]);
    },
  });

  pi.registerCommand("idea-toolbox", {
    description: "查看 Idea 内置的按需工具箱；不会安装外部 Agent 框架",
    handler: async (_args, ctx) => {
      const text = IDEA_TOOLBOX.map((item) => `${item.title}\n${item.instruction}`).join("\n\n");
      await ctx.ui.select(text, ["关闭"]);
    },
  });

  pi.registerCommand("idea-skill-promote", {
    description: "由用户将候选执行经验提升为可检索 Skill",
    handler: async (args, ctx) => {
      const prefix = String(args || "").trim();
      const matches = (state?.skills || []).filter((skill) => skill.id.startsWith(prefix) && skill.status === "candidate");
      if (matches.length !== 1) return ctx.ui.notify("请提供唯一候选 ID 前缀。", "warning");
      appendState({ op: "skill-promoted", id: matches[0].id });
      ctx.ui.notify("执行经验已提升；它仍不能修改 Idea 或科研方向。", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    approvedExternalRoots.clear();
    currentPrompt = "";
    lastAssemblyEvidenceIds = [];
    toolCount = 0;
    activeTools.clear();
    workflowRuns.clear();
    // Detach this session from any still-finishing queue owned by the previous
    // session. Queued jobs already captured their own stores and pending set.
    indexQueue = Promise.resolve();
    pendingIndexing = new Set();
    await projectIndexQueue?.close?.();
    projectIndexQueue = null;
    ideaRegistry?.close();
    ideaRegistry = null;
    sessionBinding = null;
    projectMemory?.close();
    projectMemory = null;
    restoredFromProject = false;
    const allEntries = ctx.sessionManager.getEntries?.() || [];
    state = replay(ctx.sessionManager.getBranch?.() || allEntries);
    try {
      projectMemory = new ProjectMemoryStore({ dataDir: agentDataDir(), cwd: ctx.cwd });
      projectIndexQueue = new WorkerProjectIndex({ databasePath: projectMemory.databasePath, cwd: ctx.cwd });
      const capsule = projectMemory.loadCapsule();
      if (!state.idea && capsule?.idea) {
        state = stateFromCapsule(capsule);
        restoredFromProject = true;
      }
      const hasSessionStateEvents = allEntries.some((entry) => entry?.type === "custom" && entry?.customType === STATE_TYPE);
      projectIndexQueue.schedule(allEntries, {
        sessionId: ctx.sessionManager.getSessionId?.() || "unknown-session",
        sessionFile: ctx.sessionManager.getSessionFile?.() || null,
        activeEntries: ctx.sessionManager.getBranch?.() || [],
        initialState: hasSessionStateEvents ? null : state,
      });
      sessionEntryCursor = allEntries.length;
      if (state.idea && !restoredFromProject) {
        const sessionTime = Date.parse(state.idea.confirmedAt || "") || 0;
        const capsuleTime = Date.parse(capsule?.idea?.confirmedAt || "") || 0;
        if (!capsule?.idea || sessionTime >= capsuleTime) projectMemory.saveCapsule(state);
      }
    } catch (error) {
      projectMemory?.close();
      projectMemory = null;
      await projectIndexQueue?.close?.();
      projectIndexQueue = null;
      ctx.ui?.notify?.(`项目长期记忆未启用：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    try {
      ideaRegistry = new IdeaWorkspaceStore();
      const sessionId = ctx.sessionManager.getSessionId?.() || "unknown-session";
      let bound = ideaRegistry.contextForSession(sessionId);
      if (!bound && state?.idea) {
        let registered = ideaRegistry.listIdeas({ includeArchived: true }).find((item) => item.hash === state.idea.hash) || null;
        if (!registered) {
          registered = ideaRegistry.importConfirmedIdea({
            content: state.idea.content,
            workspace: ctx.cwd,
            source: "legacy-session-confirmed-import",
          });
        }
        const hasMain = registered.conversations.some((conversation) => conversation.kind === "main" && conversation.active);
        sessionBinding = ideaRegistry.bindConversation({
          ideaId: registered.ideaId,
          sessionId,
          sessionFile: ctx.sessionManager.getSessionFile?.() || null,
          workspace: ctx.cwd,
          kind: hasMain ? "btw" : "main",
        });
        bound = ideaRegistry.contextForSession(sessionId);
      }
      if (bound) refreshRegistryContext(ctx, { append: true });
    } catch (error) {
      ideaRegistry?.close();
      ideaRegistry = null;
      ctx.ui?.notify?.(`多 Idea registry 未启用：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    const base = join(agentDataDir(), "idea-extension", sessionKey(ctx));
    manifestLog = new RingLog(join(base, "manifests.jsonl"));
    traceLog = new RingLog(join(base, "tools.jsonl"));
    evidenceLog = new RingLog(join(base, "evidence-index.jsonl"), { maxBytes: 4 * 1024 * 1024, keepLines: 600 });
    const evidenceRows = evidenceLog.tail(600);
    evidenceCache = new Map(evidenceRows.filter((row) => row.schema >= 4 && Array.isArray(row.claims)).map((row) => [row.id, row]));
    indexFailures = new Map();
    for (const row of evidenceRows) {
      if (row.schema >= 4 && Array.isArray(row.claims)) indexFailures.delete(row.id);
      else if (row.error) indexFailures.set(row.id, row);
    }
    if (restoredFromProject) {
      pi.appendEntry("pi-idea-project-link-v1", {
        schema: 1,
        projectId: projectMemory?.projectId || null,
        ideaHash: state.idea?.hash || null,
        ideaVersion: state.idea?.version || null,
        at: new Date().toISOString(),
      });
    }
    sessionEntryCursor = (ctx.sessionManager.getEntries?.() || []).length;
    if (state.enabled && !state.paused) registerSilentTools(ctx);
    else restoreNativeTools(ctx);
    syncStatus(ctx);
    if (ctx.mode === "tui" && ctx.ui?.setFooter) {
      ctx.ui.setFooter((tui, theme, footerData) => researchFooter({
        ctx,
        footerData,
        getState: () => state,
        getMode: () => contextAdoptionMode(),
        getActiveTools: () => [...activeTools.values()],
        getWorkflows: () => workflowSnapshot(),
      })(tui, theme));
    }
  });

  pi.on("input", async (event, ctx) => {
    refreshRegistryContext(ctx, { append: true });
    if (!state?.enabled || state.paused || !state.idea) return { action: "continue" };
    const budget = validateBudget(ctx);
    if (!budget.ok) {
      ctx.ui.notify(`Idea/阶段超预算，调用已停止：${budget.combined}/${budget.combinedLimit}`, "error");
      return { action: "handled" };
    }
    const contextWindow = ctx.model?.contextWindow || 272000;
    const hardLimit = Math.floor(contextWindow * 0.85);
    const anchor = buildAnchor(state, String(event.text || ""));
    const minimumInput = estimateTokens(ctx.getSystemPrompt?.() || "")
      + estimateTokens(anchor?.content || "")
      + estimateTokens(event.text || "");
    if (minimumInput > hardLimit) {
      ctx.ui.notify(`当前输入本身超过 85% 安全死线，调用已停止：${minimumInput}/${hardLimit}`, "error");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    currentPrompt = String(event?.prompt || "");
  });

  pi.on("context", async (event, ctx) => {
    refreshRegistryContext(ctx, { append: true });
    const anchor = buildAnchor(state, currentPrompt);
    if (!anchor) return;
    const contextWindow = ctx.model?.contextWindow || 272000;
    const ingestion = scheduleProjectEntries(ctx);
    const sourceMessages = branchMessagesWithProvenance(ctx, event.messages, state);
    const adoptionMode = contextAdoptionMode();
    const message = {
      role: "custom",
      customType: "idea-anchor-v1",
      content: anchor.content,
      display: false,
      timestamp: 0,
    };
    if (adoptionMode === "safe") {
      const assembled = compileBaselineSafeContext({
        messages: sourceMessages,
        anchorMessage: message,
        systemPrompt: ctx.getSystemPrompt?.() || "",
        contextWindow,
      });
      manifestLog.append({
        at: new Date().toISOString(),
        ideaHash: state.idea.hash,
        ideaVersion: state.idea.version,
        kernelHash: state.ideaKernel?.hash || null,
        kernelVersion: state.ideaKernel?.version || null,
        frameHash: state.researchFrame?.hash || null,
        frameVersion: state.researchFrame?.version || null,
        workingStateHash: sha256(JSON.stringify(state.workingState || {})),
        workingStateRevision: state.workingState?.revision || 0,
        stageHash: sha256(state.stage || ""),
        anchorHash: sha256(anchor.content),
        anchorTokens: estimateTokens(anchor.content),
        contextTrack: "baseline-safe-native-context",
        projectId: projectMemory?.projectId || null,
        projectIngestion: ingestion,
        contextCompiler: assembled.manifest,
        selectedBlockIds: [],
        droppedBlockIds: [],
        deferredBlockIds: [],
      });
      return { messages: assembled.messages };
    }
    const excludedLiveEntryIds = recentLiveEntryIds(sourceMessages, 4);
    let memoryBlocks = [];
    let continuationFrame = null;
    let continuationBlocks = [];
    let explicitRootIds = [];
    let memorySearchError = ingestion.lastError;
    try {
      memoryBlocks = projectMemory?.searchBlocks(`${state.stage || ""}\n${currentPrompt}`, {
        excludeSessionId: null,
        excludeEntryIds: excludedLiveEntryIds,
        limit: 24,
        activeIdeaHash: state.idea?.hash || null,
        activeStageHash: state.stage ? sha256(state.stage) : null,
      }) || [];
      if (isContinuationCue(currentPrompt)) {
        continuationFrame = projectMemory?.loadContinuationFrame({
          ideaHash: state.idea?.hash || null,
          stageHash: state.stage ? sha256(state.stage) : null,
        }) || null;
        if (continuationFrame) {
          continuationBlocks = projectMemory.loadBlocksByIds(continuationFrame.allBlockIds, {
            excludeEntryIds: excludedLiveEntryIds,
          });
          explicitRootIds = continuationBlocks.map((block) => block.blockId);
          memoryBlocks = mergeBlocks(memoryBlocks, continuationBlocks);
        }
      }
    } catch (error) {
      memorySearchError = error instanceof Error ? error.message : String(error);
    }
    const assembled = compileProductionContext({
      messages: sourceMessages,
      memoryBlocks,
      anchorMessage: message,
      prompt: currentPrompt,
      stage: state.stage || "",
      systemPrompt: ctx.getSystemPrompt?.() || "",
      contextWindow,
      maxOutputTokens: ctx.model?.maxTokens || 32000,
      liveTurns: 4,
      condition: "evidence-ladder",
      activeContext: {
        ideaHash: state.idea?.hash || null,
        stageHash: state.stage ? sha256(state.stage) : null,
      },
      coldMessagesIndexed: true,
      indexSnapshot: ingestion,
      explicitRootIds,
      candidateReranker: optionalForest.reranker,
    });
    if (assembled.hardOverflow) {
      ctx.ui?.notify?.("历史依赖超过本轮安全水位；已显式标记缺口，未注入残缺证据。", "warning");
    }
    const assemblyManifest = assembled.manifest.assembly || {};
    const retainedBlockIds = (assemblyManifest.retained || []).map((item) => item.blockId);
    lastAssemblyEvidenceIds = retainedBlockIds;
    if (retainedBlockIds.length) {
      projectIndexQueue?.touchBlocks(retainedBlockIds);
    }
    const manifest = {
      at: new Date().toISOString(),
      ideaHash: state.idea.hash,
      ideaVersion: state.idea.version,
      kernelHash: state.ideaKernel?.hash || null,
      kernelVersion: state.ideaKernel?.version || null,
      frameHash: state.researchFrame?.hash || null,
      frameVersion: state.researchFrame?.version || null,
      workingStateHash: sha256(JSON.stringify(state.workingState || {})),
      workingStateRevision: state.workingState?.revision || 0,
      stageHash: sha256(state.stage || ""),
      anchorHash: sha256(anchor.content),
      anchorTokens: estimateTokens(anchor.content),
      selectedSkillIds: anchor.selectedSkillIds,
      selectedToolboxId: anchor.selectedToolboxId,
      messageCountBefore: sourceMessages.length,
      messageCountAfter: assembled.messages.length,
      contextCompiler: assembled.manifest,
      candidateForest: { status: optionalForest.status, modelId: optionalForest.reranker?.modelId || null, error: optionalForest.error },
      contextTrack: memoryBlocks.length ? "lsc-epc-project-memory" : "lsc-epc-local",
      projectId: projectMemory?.projectId || null,
      restoredFromProject,
      projectIngestion: ingestion,
      projectMemoryCandidateCount: memoryBlocks.length,
      continuation: {
        cue: isContinuationCue(currentPrompt),
        restored: Boolean(continuationFrame),
        loopId: continuationFrame?.loopId || null,
        candidateBlocks: continuationBlocks.length,
        rootedBlocks: explicitRootIds.length,
      },
      excludedLiveEntryCount: excludedLiveEntryIds.length,
      projectMemoryError: memorySearchError,
      enhancedIndexReady: false,
      backgroundIndexScheduled: 0,
      selectedBlockIds: (assemblyManifest.retained || []).map((item) => item.blockId),
      droppedBlockIds: (assemblyManifest.dropped || []).map((item) => item.blockId),
      deferredBlockIds: (assemblyManifest.deferred || []).map((item) => item.blockId),
      pendingIndexCount: 0,
      indexWaitMs: 0,
      position: 0,
    };
    manifestLog.append(manifest);
    return { messages: assembled.messages };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const original = textOfAssistant(event.message);
    let visible = original;
    const ideaCandidate = extractIdeaCandidate(visible);
    if (ideaCandidate) {
      const proposal = makeProposal(ideaCandidate.candidate, "model");
      const budget = validateBudget(ctx, proposal.content, state?.stage || "");
      if (budget.p0Tokens <= budget.p0Limit) appendState({ op: "proposal-created", proposal });
      visible = ideaCandidate.visible;
    }
    const learned = extractSkillCandidates(visible);
    for (const skill of learned.skills) appendState({ op: "skill-candidate", skill });
    visible = learned.cleaned;
    if (visible !== original) return { message: replaceAssistantText(event.message, visible) };
  });

  pi.on("tool_call", async (event, ctx) => {
    const decision = toolBoundaryDecision({
      toolName: event.toolName,
      input: event.input,
      cwd: ctx.cwd,
      ideaEnabled: Boolean(state?.enabled && !state.paused && state.idea),
      approvedRoots: [...approvedExternalRoots],
    });
    if (decision.action === "allow") return;
    if (decision.action === "block") return { block: true, reason: decision.message };

    const detail = decision.target ? `\n\n${decision.target}` : "";
    const allowed = await ctx.ui.confirm("需要边界确认", `${decision.message}${detail}\n\n仅在你确认后执行。`);
    if (!allowed) return { block: true, reason: "用户未授权这次越界或不可恢复操作。" };
    if (decision.approvalRoot) approvedExternalRoots.add(decision.approvalRoot);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!state?.enabled || state.paused) return;
    toolCount += 1;
    activeTools.set(event.toolCallId, { id: event.toolCallId, tool: event.toolName, startedAt: new Date().toISOString() });
    ctx.ui.setStatus("idea-work", `working · ${toolCount}`);
    traceLog.append({
      type: "start",
      at: new Date().toISOString(),
      id: event.toolCallId,
      tool: event.toolName,
      args: JSON.stringify(event.args || {}).slice(0, 1200),
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!state?.enabled || state.paused) return;
    const starts = traceLog.tail(30);
    const start = [...starts].reverse().find((row) => row.type === "start" && row.id === event.toolCallId);
    const ended = Date.now();
    traceLog.append({
      type: "end",
      at: new Date(ended).toISOString(),
      id: event.toolCallId,
      tool: event.toolName,
      ok: !event.isError,
      ms: start ? ended - Date.parse(start.at) : null,
      result: textOfResult(event.result),
    });
    activeTools.delete(event.toolCallId);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    toolCount = 0;
    activeTools.clear();
    ctx.ui.setStatus("idea-work", "");
    const ingestion = scheduleProjectEntries(ctx);
    if (state?.idea && projectIndexQueue) {
      projectIndexQueue.updateContinuationFrame({
        sessionId: ctx.sessionManager.getSessionId?.() || "unknown-session",
        ideaHash: state.idea.hash,
        stageHash: state.stage ? sha256(state.stage) : null,
        supportingBlockIds: lastAssemblyEvidenceIds,
      });
    }
    if (ingestion.lastError) {
      manifestLog?.append({
        at: new Date().toISOString(),
        type: "project-memory-ingest-error",
        error: ingestion.lastError,
      });
    }
    try { if (state?.idea) projectMemory?.saveCapsule(state); } catch { /* raw session remains intact */ }
    // EPC's default path is model-free. Optional Luna navigation cues may be
    // re-enabled only as bounded retrieval hints; they are not summaries or
    // evidence and never run on the critical path.
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    scheduleProjectEntries(ctx);
    await projectIndexQueue?.drain?.();
    try { if (state?.idea) projectMemory?.saveCapsule(state); } catch { /* best effort on shutdown */ }
    projectMemory?.close();
    projectMemory = null;
    await projectIndexQueue?.close?.();
    projectIndexQueue = null;
    ideaRegistry?.close();
    ideaRegistry = null;
  });
}
