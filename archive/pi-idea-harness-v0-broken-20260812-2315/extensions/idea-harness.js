import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { ContextBudgetError, ContextCompiler, estimateTextTokens } from "../src/context-compiler.js";
import {
  formatCodexBankDetails,
  formatCodexBankLabel,
  parseCodexBankHeaders,
} from "../src/codex-bank.js";
import {
  isCodexUsageAbortError,
  queryCodexSubscriptionUsage,
} from "../src/codex-usage.js";
import {
  allocateContextBar,
  buildContextComposition,
  formatRelativeTime,
  formatTokenCount,
} from "../src/context-visualization.js";
import { findIdeaSpace, ideaPaths, isProtectedPath, resolveToolPath } from "../src/paths.js";
import { IdeaIntegrityError, IdeaStateError, IdeaStateStore } from "../src/state-store.js";
import { sha256 } from "../src/idea-document.js";
import {
  hasExplicitSessionIntent,
  NATIVE_COMPACTION_COOLDOWN_MS,
  NATIVE_COMPACTION_REARM_TOKENS,
  nativeCompactionDecision,
  parseNativeCompactionBlocks,
  RESEARCH_COMPACTION_INSTRUCTIONS,
} from "../src/native-compaction.js";
import {
  DEFAULT_WORKING_MESSAGE,
  installWorkingVisual,
  restoreWorkingVisual,
  workingMessageForTool,
} from "../src/working-visual.js";
import { fitTuiLines } from "../src/tui-layout.js";
import { transientToolRenderers } from "../src/transient-tools.js";

const STATUS_KEY = "idea-harness";
const WIDGET_KEY = "idea-harness-entry";
const CLIENT_ID = randomUUID();
const LEASE_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SPEED_REFRESH_MS = 250;
const CODEX_USAGE_CACHE_MS = 5 * 60_000;

function streamDelta(event) {
  const update = event?.assistantMessageEvent;
  if (update?.type !== "text_delta" && update?.type !== "thinking_delta") return "";
  return typeof update.delta === "string" ? update.delta : "";
}

function actualOutputTokens(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  for (const key of ["output", "outputTokens", "output_tokens"]) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function speedLabel(metrics) {
  if (metrics.active && !Number.isFinite(metrics.tokensPerSecond)) return "… tok/s";
  if (!Number.isFinite(metrics.tokensPerSecond)) return null;
  const digits = metrics.tokensPerSecond < 10 ? 1 : 0;
  return `${metrics.active ? "≈" : ""}${metrics.tokensPerSecond.toFixed(digits)} tok/s`;
}

const INITIALIZATION_PARAMETERS = {
  type: "object",
  properties: {
    candidate_content: {
      type: "string",
      description:
        "把用户原始想法整理成的完整 P0 候选。可以使用自然语言或 Markdown，但不得增加用户没有表达的目标。",
    },
    rationale: {
      type: "string",
      description: "说明如何压缩、澄清了原始想法，以及哪些不确定点被原样保留。",
    },
  },
  required: ["candidate_content", "rationale"],
  additionalProperties: false,
};

const PROPOSAL_PARAMETERS = {
  type: "object",
  properties: {
    proposal_id: {
      type: "string",
      description: "已有待确认提案的 ID。继续调整时传入；创建新提案时省略。",
    },
    candidate_content: {
      type: "string",
      description: "修改后的完整 P0 候选文本。P0 没有固定格式，必须保留未修改的核心含义。",
    },
    route_changed: {
      type: "boolean",
      description: "候选是否实质改变当前路线。仅整理措辞时为 false；路线、机制或边界变化时为 true。",
    },
    rationale: {
      type: "string",
      description: "为什么提出或调整这项变更。",
    },
    evidence_refs: {
      type: "array",
      items: { type: "string" },
      description: "支持该提案的证据引用，可为空。",
    },
  },
  required: ["candidate_content", "route_changed", "rationale"],
  additionalProperties: false,
};

const P1_PARAMETERS = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description: "完整替换后的短 P1；可为空字符串。不要放入 P0、聊天历史或详细报告。",
    },
    reason: {
      type: "string",
      description: "本次 P1 更新的原因。",
    },
    source_refs: {
      type: "array",
      items: { type: "string" },
      description: "P1 条目的来源引用，可为空。",
    },
  },
  required: ["content", "reason"],
  additionalProperties: false,
};

function sessionIdentity(ctx) {
  return {
    sessionId: ctx.sessionManager.getSessionId?.() ?? null,
    sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
  };
}

function actorFor(ctx, role) {
  const { sessionId } = sessionIdentity(ctx);
  return `${role}:${sessionId ?? "ephemeral"}`;
}

function shortId(value) {
  return String(value ?? "").slice(0, 8);
}

function isInside(directory, candidate) {
  const rel = relative(resolve(directory), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function protectedToolReason(event, ctx, root) {
  if (event.toolName === "write" || event.toolName === "edit") {
    const candidate = resolveToolPath(ctx.cwd, event.input?.path);
    const paths = ideaPaths(root);
    if (isProtectedPath(root, candidate) || (candidate && isInside(paths.harnessDir, candidate))) {
      return "受保护的 Idea 状态只能通过 /idea、/context 或专用提案工具修改";
    }
  }

  if (event.toolName === "bash") {
    const command = String(event.input?.command ?? "").toLowerCase();
    if (command.includes("idea.md") || command.includes(".harness")) {
      return "shell 命令显式引用了受保护的 Idea 状态；请使用 read、/idea 或专用工具";
    }
  }
  return null;
}

function formatManifest(manifest) {
  if (!manifest) return "还没有模型调用，因此尚无 Context Manifest。";
  return [
    `Context Packet ${manifest.packetId}`,
    `调用：${manifest.invocationId}`,
    `Idea：v${manifest.ideaVersion} · ${manifest.ideaHash}`,
    `P1：v${manifest.p1Version} · ${manifest.p1Hash}`,
    `复用：${manifest.reused ? "是" : "否"}`,
    `Tokens：P0 ${manifest.tokens.p0} + P1 ${manifest.tokens.p1} + Pi 摘要/对话 ${manifest.tokens.dynamic}`,
    `有效输入预算：${manifest.budget.effectiveInput}；P0/P1 上限 ${manifest.budget.combinedCeiling}`,
    `实际上下文哈希：${manifest.actualContextHash}`,
    "",
    "来源：",
    ...manifest.sources.map((source) => `- ${source.tier} ${source.source} · ${source.reason} · ${source.tokens} tokens`),
    "",
    "未纳入：",
    ...manifest.excluded.map((item) => `- ${item.source} · ${item.reason}`),
  ].join("\n");
}

function formatNativeCompactionSet(set) {
  if (!set) return "还没有 Pi 原生 compaction，因此尚无历史语义块。";
  return [
    `Pi 历史块 · ${set.reason} · 压缩前 ${set.tokensBefore} tokens`,
    `摘要：${set.summaryHash}`,
    ...set.blocks.map((block) => `- ${block.kind} · ${block.tokens} tokens · ${block.hash}`),
  ].join("\n");
}

async function showText(ctx, title, text) {
  if (!ctx.hasUI) {
    ctx.ui.notify(`${title}: ${text}`, "info");
    return;
  }
  await ctx.ui.select(`${title}\n\n${text}`, ["关闭"]);
}

function plainContextLine(composition, barWidth = 24) {
  if (!composition) return "CTX — · 发送一条消息后显示实际组成";
  const layout = allocateContextBar(composition, barWidth);
  const bar = `${"|".repeat(layout.usedColumns)}${" ".repeat(layout.emptyColumns)}`;
  const legend = composition.segments
    .map((segment) => `${segment.label} ${formatTokenCount(segment.tokens)}`)
    .join("  ");
  const percent = Math.round(composition.percent);
  return `CTX ${formatTokenCount(composition.used)}/${formatTokenCount(composition.contextWindow)} ${percent}%  [${bar}]  ${legend}  余 ${formatTokenCount(composition.free)}`;
}

function plainWidgetLines(view) {
  const top = [
    `◆ Idea ${view.ideaAge}确认`,
    view.stageLabel,
    view.lunaLabel,
    `思考 ${view.thinking}`,
    view.outputSpeed ? `输出 ${view.outputSpeed}` : null,
    view.bankLabel,
    view.roleLabel,
    view.pending > 0 ? `待确认 ${view.pending}` : null,
    "? /guide",
  ].filter(Boolean).join(" · ");
  return [top, plainContextLine(view.composition)];
}

function thinkingColor(level) {
  return {
    off: "thinkingOff",
    minimal: "thinkingMinimal",
    low: "thinkingLow",
    medium: "thinkingMedium",
    high: "thinkingHigh",
    xhigh: "thinkingXhigh",
    max: "thinkingMax",
  }[level] ?? "muted";
}

function styledWidgetLines(view, theme, width) {
  const separator = theme.fg("dim", " · ");
  const top = [
    theme.fg("accent", "◆") + ` Idea ${view.ideaAge}确认`,
    theme.fg("warning", view.stageLabel),
    view.lunaLabel.startsWith("Luna —") ? theme.fg("muted", view.lunaLabel) : theme.fg("success", view.lunaLabel),
    `思考 ${theme.fg(thinkingColor(view.thinking), view.thinking)}`,
    view.outputSpeed ? `输出 ${theme.fg("success", view.outputSpeed)}` : null,
    view.bankAvailable ? theme.fg("success", view.bankLabel) : theme.fg("muted", view.bankLabel),
    view.roleLabel ? theme.fg("warning", view.roleLabel) : null,
    view.pending > 0 ? theme.fg("warning", `待确认 ${view.pending}`) : null,
    theme.fg("muted", "? /guide"),
  ].filter(Boolean).join(separator);

  if (!view.composition) {
    return fitTuiLines([top, theme.fg("muted", "CTX — · 发送一条消息后显示实际组成")], width);
  }
  const barWidth = width >= 160 ? 32 : width >= 120 ? 24 : 18;
  const layout = allocateContextBar(view.composition, barWidth);
  const usedBar = layout.segments
    .map((segment) => theme.fg(segment.color, "|".repeat(segment.columns)))
    .join("");
  const bar = `${usedBar}${" ".repeat(layout.emptyColumns)}`;
  const useFullLabels = width >= 150;
  const legend = view.composition.segments.map((segment) => (
    `${theme.fg(segment.color, "|")}${useFullLabels ? segment.label : segment.shortLabel} ${formatTokenCount(segment.tokens)}`
  )).join("  ");
  const usage = `CTX ${formatTokenCount(view.composition.used)}/${formatTokenCount(view.composition.contextWindow)} ${Math.round(view.composition.percent)}%`;
  const line = [
    theme.fg("muted", usage),
    `${theme.fg("dim", "[")}${bar}${theme.fg("dim", "]")}`,
    legend,
    theme.fg("muted", `余 ${formatTokenCount(view.composition.free)}`),
  ].join("  ");
  // Pi intentionally crashes on an over-wide custom component line. This
  // final boundary uses Pi TUI's ANSI/CJK-aware width functions so terminal
  // resizes and changing labels can never escape the component's width.
  return fitTuiLines([top, line], width);
}

function setHarnessWidget(ctx, view) {
  if (ctx.mode !== "tui") {
    ctx.ui.setWidget(WIDGET_KEY, plainWidgetLines(view));
    return;
  }
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
    render: (width) => styledWidgetLines(view, theme, width),
    invalidate: () => {},
  }));
}

export default function ideaHarnessExtension(pi) {
  pi.registerFlag("idea", {
    description: "Enter the Idea conversation bound to the current Idea Space",
    type: "boolean",
    default: false,
  });
  let root = null;
  let store = null;
  let compiler = null;
  let lease = { acquired: false, reason: "unbound" };
  let heartbeat = null;
  let nativeCompactionRunning = false;
  let nativeCompactionQueued = false;
  let lastNativeCompactionScheduledAt = 0;
  let lastNativeCompactionTokenWatermark = null;
  let ideaModeActive = false;
  let codexBank = null;
  let codexUsageError = null;
  let codexUsageQuery = null;
  let codexUsageController = null;
  let codexUsageRefreshTimer = null;
  let footerRenderRequest = null;
  let outputMetrics = {
    active: false,
    firstTokenAt: null,
    lastTokenAt: null,
    lastRenderedAt: 0,
    streamedText: "",
    estimatedTokens: 0,
    tokensPerSecond: null,
  };

  function resetOutputMetrics({ active = false } = {}) {
    outputMetrics = {
      active,
      firstTokenAt: null,
      lastTokenAt: null,
      lastRenderedAt: 0,
      streamedText: "",
      estimatedTokens: 0,
      tokensPerSecond: null,
    };
  }

  function closeRuntime() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (codexUsageRefreshTimer) {
      clearTimeout(codexUsageRefreshTimer);
      codexUsageRefreshTimer = null;
    }
    codexUsageController?.abort();
    codexUsageController = null;
    codexUsageQuery = null;
    codexBank = null;
    codexUsageError = null;
    nativeCompactionRunning = false;
    nativeCompactionQueued = false;
    lastNativeCompactionScheduledAt = 0;
    lastNativeCompactionTokenWatermark = null;
    if (store) {
      try {
        store.releaseController(CLIENT_ID);
      } catch {
        // Best-effort cleanup; an expired lease is recoverable.
      }
      store.close();
    }
    root = null;
    store = null;
    compiler = null;
    lease = { acquired: false, reason: "unbound" };
    ideaModeActive = false;
  }

  function openRuntime(nextRoot) {
    const resolved = resolve(nextRoot);
    if (store && root === resolved) return store;
    closeRuntime();
    root = resolved;
    store = new IdeaStateStore(root);
    compiler = new ContextCompiler(store);
    return store;
  }

  function ensureRuntime(ctx, { createAtCwd = false } = {}) {
    if (store) return store;
    if (!ideaModeActive && !createAtCwd) return null;
    if (createAtCwd) ideaModeActive = true;
    const discovered = findIdeaSpace(ctx.cwd);
    if (discovered) return openRuntime(discovered);
    if (createAtCwd) return openRuntime(ctx.cwd);
    return null;
  }

  function acquireLease(ctx, { force = false } = {}) {
    if (!store?.isInitialized()) return { acquired: false, reason: "not-initialized" };
    const identity = sessionIdentity(ctx);
    if (!identity.sessionId) return { acquired: false, reason: "ephemeral-session" };
    store.ensureMainSession(identity.sessionId, identity.sessionFile);
    lease = store.acquireControllerLease({ ...identity, clientId: CLIENT_ID, ttlMs: LEASE_TTL_MS, force });
    return lease;
  }

  function isController(ctx) {
    return acquireLease(ctx).acquired;
  }

  function codexModelIdentity(model) {
    return model ? `${model.provider ?? ""}/${model.id ?? ""}` : "none";
  }

  function codexUsageIsFresh() {
    if (codexBank?.source !== "usage-endpoint") return false;
    const observedAt = Date.parse(codexBank.observedAt);
    return Number.isFinite(observedAt) && Date.now() - observedAt < CODEX_USAGE_CACHE_MS;
  }

  async function refreshCodexUsage(ctx, { force = false } = {}) {
    if (ctx.model?.provider !== "openai-codex") {
      throw new Error("当前选择的模型不是 OpenAI Codex；Usage 只读取当前 Pi Codex 订阅账户");
    }
    if (!force && codexUsageIsFresh()) return codexBank;
    if (codexUsageQuery) return codexUsageQuery;

    const modelIdentity = codexModelIdentity(ctx.model);
    const controller = new AbortController();
    codexUsageController = controller;
    codexUsageError = null;
    const operation = queryCodexSubscriptionUsage(ctx, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || codexModelIdentity(ctx.model) !== modelIdentity) return null;
        codexBank = result.bank;
        codexUsageError = null;
        updateStatus(ctx);
        return codexBank;
      })
      .catch((error) => {
        if (isCodexUsageAbortError(error)) return null;
        codexUsageError = error.message;
        updateStatus(ctx);
        throw error;
      })
      .finally(() => {
        if (codexUsageController === controller) codexUsageController = null;
        if (codexUsageQuery === operation) codexUsageQuery = null;
      });
    codexUsageQuery = operation;
    return operation;
  }

  function scheduleCodexUsageRefresh(ctx, delayMs = 350) {
    if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
    if (codexUsageRefreshTimer) clearTimeout(codexUsageRefreshTimer);
    codexUsageRefreshTimer = setTimeout(() => {
      codexUsageRefreshTimer = null;
      void refreshCodexUsage(ctx).catch(() => {
        // The top line remains usable with Codex — or verified response-header data.
        // /usage exposes the sanitized query error and an explicit retry path.
      });
    }, delayMs);
    codexUsageRefreshTimer.unref?.();
  }

  function currentHarnessView(ctx) {
    const initialized = Boolean(store?.isInitialized());
    const idea = initialized ? store.getCurrentIdea() : null;
    const p1 = initialized ? store.getCurrentP1() : null;
    const latest = initialized ? store.getLatestContextManifest() : null;
    const lunaLabel = nativeCompactionRunning || nativeCompactionQueued ? "整理 …" : "Luna —";
    return {
      ideaAge: idea?.createdAt ? formatRelativeTime(idea.createdAt) : "尚未",
      stageLabel: p1?.createdAt ? `阶段 ${formatRelativeTime(p1.createdAt)}` : "阶段 —",
      lunaLabel,
      thinking: pi.getThinkingLevel(),
      outputSpeed: speedLabel(outputMetrics),
      bankLabel: formatCodexBankLabel(codexBank, ctx.model),
      bankAvailable: Boolean(codexBank),
      roleLabel: !initialized ? "未初始化" : lease.acquired ? null : "旁支",
      pending: initialized ? store.listPendingProposals().length : 0,
      composition: buildContextComposition(latest),
    };
  }

  function installHarnessFooter(ctx) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      footerRenderRequest = () => tui.requestRender();
      return {
        dispose() {
          unsubscribe?.();
          footerRenderRequest = null;
        },
        invalidate() {},
        render(width) {
          return styledWidgetLines(currentHarnessView(ctx), theme, width);
        },
      };
    });
  }

  function restoreHarnessFooter(ctx) {
    footerRenderRequest = null;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  }

  function updateStatus(ctx) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (!store) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      footerRenderRequest?.();
      return;
    }
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      footerRenderRequest?.();
      return;
    }
    setHarnessWidget(ctx, currentHarnessView(ctx));
  }

  function scheduleNativeCompaction(ctx) {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized() || !isController(ctx) || typeof ctx.compact !== "function") return;
    if (nativeCompactionRunning || nativeCompactionQueued) return;
    const decision = nativeCompactionDecision(ctx.getContextUsage?.());
    if (!decision.shouldCompact) return;
    const now = Date.now();
    if (now - lastNativeCompactionScheduledAt < NATIVE_COMPACTION_COOLDOWN_MS) return;
    if (
      Number.isFinite(lastNativeCompactionTokenWatermark)
      && decision.tokens < lastNativeCompactionTokenWatermark + NATIVE_COMPACTION_REARM_TOKENS
    ) return;
    lastNativeCompactionScheduledAt = now;
    lastNativeCompactionTokenWatermark = decision.tokens;
    nativeCompactionQueued = true;
    runtime.appendEvent("native_compaction_scheduled", actorFor(ctx, "system"), decision);
    updateStatus(ctx);
    queueMicrotask(() => {
      if (!store || nativeCompactionRunning) {
        nativeCompactionQueued = false;
        return;
      }
      nativeCompactionQueued = false;
      nativeCompactionRunning = true;
      updateStatus(ctx);
      ctx.compact({
        customInstructions: RESEARCH_COMPACTION_INSTRUCTIONS,
        onComplete: () => {
          nativeCompactionRunning = false;
          updateStatus(ctx);
        },
        onError: (error) => {
          nativeCompactionRunning = false;
          lastNativeCompactionTokenWatermark = null;
          try {
            store?.appendEvent("native_compaction_failed", actorFor(ctx, "system"), {
              code: error?.code ?? "PI_COMPACTION_ERROR",
              message: error?.message ?? String(error),
              threshold: decision.threshold,
              tokens: decision.tokens,
            });
          } catch {
            // A concurrent session switch may have closed the Idea store.
          }
          updateStatus(ctx);
        },
      });
    });
  }

  function bindSession(ctx) {
    if (!store?.isInitialized()) return;
    const identity = sessionIdentity(ctx);
    store.ensureMainSession(identity.sessionId, identity.sessionFile);
    acquireLease(ctx);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      try {
        if (lease.acquired) store?.heartbeatController(CLIENT_ID, LEASE_TTL_MS);
      } catch {
        // The next foreground event will refresh or expose the lease state.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const current = store.getCurrentIdea();
    const entries = ctx.sessionManager.getEntries?.() ?? [];
    const latestBinding = [...entries].reverse().find(
      (entry) => entry.type === "custom" && entry.customType === "idea-harness-binding",
    );
    if (latestBinding?.data?.ideaHash !== current.hash) {
      pi.appendEntry("idea-harness-binding", {
        ideaId: store.getIdeaId(),
        ideaVersion: current.version,
        ideaHash: current.hash,
        role: lease.acquired ? "main" : "branch",
      });
    }
    if (lease.acquired && !pi.getSessionName()) {
      pi.setSessionName(`Idea ${shortId(store.getIdeaId())} · main`);
    }
    updateStatus(ctx);
  }

  async function initializeIdea(ctx) {
    const runtime = ensureRuntime(ctx, { createAtCwd: true });
    if (runtime.isInitialized()) {
      ctx.ui.notify("当前目录已经是 Idea Space；请用提案修改 Idea", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/idea-init 需要可交互界面", "error");
      return;
    }

    const existing = runtime.getInitializationDraft();
    const raw = await ctx.ui.editor(
      "直接告诉 AI 你的原始想法（无标题、字段、缩进要求）",
      existing?.rawContent ?? "",
    );
    if (raw === undefined) return;
    try {
      const draft = runtime.beginInitializationDraft(raw, { actor: actorFor(ctx, "user") });
      updateStatus(ctx);
      ctx.ui.notify("原始想法已保存，正在交给当前 AI 整理；整理结果不会自动生效。", "info");
      pi.sendUserMessage([
        "我们正在初始化这个 Idea Space。下面是用户刚刚提交的原始想法：",
        "",
        "<raw_idea_draft>",
        draft.rawContent,
        "</raw_idea_draft>",
        "",
        "请只做忠实的压缩、澄清和组织，不要增加新的研究目标，不要调用研究 Skill、搜索、代码或其他工具。",
        "候选应简洁说明研究/开发对象、可验证的达成标准、当前路线和不能偏离的边界；不要求任何固定标题或格式。",
        "如果存在会改变方向的歧义，先在主对话中向用户提问。确定后调用 idea_prepare_initialization 保存完整候选。",
        "候选不会自动成为 P0；用户还会通过 /idea 查看并确认。",
      ].join("\n"));
    } catch (error) {
      ctx.ui.notify(error.message, "error");
    }
  }

  async function reviewInitialization(ctx) {
    while (true) {
      const draft = store?.getInitializationDraft();
      if (!draft) {
        ctx.ui.notify("还没有初始化草稿；请先使用 /idea-init", "warning");
        return;
      }
      const hasCandidate = Boolean(draft.candidateContent);
      const actions = [
        ...(hasCandidate ? ["确认并冻结为 P0", "查看原始想法与候选", "手动调整候选"] : ["查看原始想法"]),
        "回主对话继续和 AI 调整",
        "重写原始想法",
        "放弃初始化",
        "返回",
      ];
      const title = hasCandidate
        ? `Idea 初始化候选待确认\n理由：${draft.rationale || "AI 未提供说明"}\n候选哈希：${draft.candidateHash}`
        : "原始想法已保存，AI 尚未提交整理候选";
      const action = await ctx.ui.select(title, actions);
      if (!action || action === "返回") return;

      if (action === "查看原始想法") {
        await showText(ctx, "原始 Idea 草稿", draft.rawContent);
        continue;
      }
      if (action === "查看原始想法与候选") {
        await showText(
          ctx,
          "初始化对照",
          [`【用户原始想法】`, draft.rawContent, "", "【AI 整理候选】", draft.candidateContent].join("\n"),
        );
        continue;
      }
      if (action === "手动调整候选") {
        const edited = await ctx.ui.editor("调整 P0 候选（没有格式要求，仍不会自动生效）", draft.candidateContent);
        if (edited !== undefined) {
          try {
            store.saveInitializationCandidate(edited, {
              actor: actorFor(ctx, "user"),
              rationale: "user manually adjusted initialization candidate",
            });
            updateStatus(ctx);
          } catch (error) {
            ctx.ui.notify(error.message, "error");
          }
        }
        continue;
      }
      if (action === "回主对话继续和 AI 调整") {
        ctx.ui.setEditorText(
          hasCandidate
            ? "请继续调整刚才的 P0 初始化候选。不要改变原始目标，我希望修改的是："
            : "请继续理解并整理我的 Idea 初始化草稿；如果有方向性歧义，请先问我。",
        );
        return;
      }
      if (action === "重写原始想法") {
        await initializeIdea(ctx);
        return;
      }
      if (action === "放弃初始化") {
        const confirmed = await ctx.ui.confirm("放弃初始化", "原始草稿和 AI 候选会从待处理状态删除。确定吗？");
        if (confirmed) {
          store.clearInitializationDraft({ actor: actorFor(ctx, "user") });
          updateStatus(ctx);
          ctx.ui.notify("已放弃本次 Idea 初始化", "info");
          return;
        }
        continue;
      }
      if (action === "确认并冻结为 P0") {
        const confirmed = await ctx.ui.confirm(
          "确认初始化 Idea",
          "确认后，AI 整理候选将逐字成为 P0；以后只能通过版本化提案修改。原始想法会作为不可变来源保留。",
        );
        if (!confirmed) continue;
        try {
          const current = store.initializeIdeaFromContent(draft.candidateContent, {
            sourceText: draft.rawContent,
            actor: actorFor(ctx, "user"),
            reason: draft.rationale || "user confirmed AI-organized initial Idea",
          });
          const identity = sessionIdentity(ctx);
          store.setMainSession(identity.sessionId, identity.sessionFile, actorFor(ctx, "user"));
          acquireLease(ctx, { force: true });
          compiler.invalidate("idea-initialized");
          bindSession(ctx);
          ctx.ui.notify(`Idea v${current.version} 已初始化；确认文本将从下一次模型调用开始逐字注入`, "info");
          return;
        } catch (error) {
          ctx.ui.notify(error.message, "error");
        }
      }
    }
  }

  async function reviewProposal(ctx, proposalId) {
    while (true) {
      const proposal = store.getProposal(proposalId);
      if (!proposal || proposal.status !== "pending") return;
      const description = store.describeProposal(proposalId);
      const controller = isController(ctx);
      const actions = [
        ...(controller ? ["确认修改"] : []),
        "回主对话继续调整",
        "手动调整提案",
        "放弃提案",
        "返回",
      ];
      const title = [
        `Idea 变更提案 ${shortId(proposal.id)} · revision ${proposal.revision}`,
        `基础：Idea v${proposal.baseVersion}`,
        `理由：${proposal.rationale}`,
        `类型：${proposal.routeChanged ? "路线实质变化（确认后路线版本递增）" : "仅整理表述（路线版本不变）"}`,
        controller ? "当前会话拥有提交权。" : "当前会话不是主控制对话，只能继续讨论或追加提案。",
        "",
        description.diff,
      ].join("\n");
      const action = await ctx.ui.select(title, actions);
      if (!action || action === "返回") return;

      if (action === "回主对话继续调整") {
        ctx.ui.setEditorText(
          `请继续调整 Idea 变更提案 ${proposal.id}（revision ${proposal.revision}，不要提交）。`
          + ` 调用 idea_propose_change 时传 proposal_id=${proposal.id}。我希望改成：`,
        );
        return;
      }

      if (action === "手动调整提案") {
        const edited = await ctx.ui.editor(`调整提案 ${shortId(proposal.id)}（仍不会提交）`, proposal.candidateContent);
        if (edited === undefined) continue;
        try {
          store.updateProposal(proposal.id, {
            candidateContent: edited,
            routeChanged: proposal.routeChanged,
            rationale: proposal.rationale,
            evidenceRefs: proposal.evidenceRefs,
            actor: actorFor(ctx, "user"),
          });
          compiler.invalidate("idea-proposal-revised");
          updateStatus(ctx);
        } catch (error) {
          ctx.ui.notify(error.message, "error");
        }
        continue;
      }

      if (action === "放弃提案") {
        const confirmed = await ctx.ui.confirm(
          "放弃 Idea 变更提案",
          "提案会保留在审计记录中，但不再可提交。确定放弃吗？",
        );
        if (!confirmed) continue;
        store.rejectProposal(proposal.id, { actor: actorFor(ctx, "user") });
        updateStatus(ctx);
        ctx.ui.notify("提案已放弃，权威 Idea 未改变", "info");
        return;
      }

      if (action === "确认修改") {
        if (!isController(ctx)) {
          ctx.ui.notify("提交权已不在当前窗口；请返回主对话或显式接管", "error");
          continue;
        }
        const confirmed = await ctx.ui.confirm(
          "确认生成新的 Idea 版本",
          `将把提案 ${shortId(proposal.id)} 提交为新的不可变版本。旧版本永久保留。是否确认？`,
        );
        if (!confirmed) continue;
        try {
          const committed = store.commitProposal(proposal.id, {
            actor: actorFor(ctx, "user"),
            reason: proposal.rationale,
          });
          compiler.invalidate("idea-version-committed");
          updateStatus(ctx);
          pi.appendEntry("idea-harness-binding", {
            ideaId: store.getIdeaId(),
            ideaVersion: committed.version,
            ideaHash: committed.hash,
            role: "main",
          });
          ctx.ui.notify(
            `已确认 Idea v${committed.version} · 路线 v${committed.routeVersion}；下一次调用将逐字注入新 P0`,
            "info",
          );
          return;
        } catch (error) {
          ctx.ui.notify(error.message, "error");
        }
      }
    }
  }

  async function openIdeaPanel(ctx) {
    const runtime = ensureRuntime(ctx);
    if (!runtime) {
      ctx.ui.notify("当前目录尚未绑定 Idea；使用 /idea-init", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/idea 二级面板需要可交互界面", "error");
      return;
    }
    if (!runtime.isInitialized()) {
      await reviewInitialization(ctx);
      return;
    }

    while (true) {
      acquireLease(ctx);
      updateStatus(ctx);
      const current = runtime.getCurrentIdea();
      const pending = runtime.listPendingProposals();
      const menu = [
        `查看当前 Idea v${current.version}`,
        ...(pending.length ? [`审查待确认修改（${pending.length}）`] : []),
        "查看版本历史",
        "关闭",
      ];
      const choice = await ctx.ui.select(
        `Idea ${shortId(runtime.getIdeaId())} · ${lease.acquired ? "主对话" : "旁支/只追加"}`,
        menu,
      );
      if (!choice || choice === "关闭") return;
      if (choice.startsWith("查看当前 Idea")) {
        await showText(ctx, `Idea v${current.version}`, current.content);
      } else if (choice.startsWith("审查待确认修改")) {
        let selected = pending[0];
        if (pending.length > 1) {
          const label = await ctx.ui.select(
            "选择提案",
            pending.map((item) => `${shortId(item.id)} · r${item.revision} · ${item.rationale}`),
          );
          selected = pending.find((item) => label?.startsWith(shortId(item.id)));
        }
        if (selected) await reviewProposal(ctx, selected.id);
      } else if (choice === "查看版本历史") {
        const history = runtime.getIdeaHistory();
        await showText(
          ctx,
          "Idea 版本历史",
          history.map((item) => `v${item.version} · ${item.hash}\n  ${item.createdAt} · ${item.author}\n  ${item.reason}`).join("\n\n"),
        );
      }
    }
  }

  async function openContextPanel(args, ctx) {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized()) {
      ctx.ui.notify("当前目录尚未绑定 Idea", "warning");
      return;
    }
    if (args.trim() === "edit") {
      if (!isController(ctx)) {
        ctx.ui.notify("只有活跃主对话可以提交 P1；请返回主对话或显式接管", "error");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/context edit 需要可交互界面", "error");
        return;
      }
      const p1 = runtime.getCurrentP1();
      const edited = await ctx.ui.editor("编辑当前阶段最小工作集 P1（可留空）", p1.content);
      if (edited === undefined) return;
      try {
        runtime.updateP1(edited, { actor: actorFor(ctx, "user"), reason: "user edited P1" });
        compiler.invalidate("p1-updated");
        updateStatus(ctx);
        ctx.ui.notify("P1 已更新；下一次模型调用会使用新 Context Packet", "info");
      } catch (error) {
        ctx.ui.notify(error.message, "error");
      }
      return;
    }
    await showText(
      ctx,
      "Context Inspector",
      `${formatManifest(runtime.getLatestContextManifest())}\n\n${formatNativeCompactionSet(runtime.getLatestNativeCompactionSet())}`,
    );
  }

  async function openLunaPanel(args, ctx) {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized()) {
      ctx.ui.notify("当前目录尚未绑定 Idea", "warning");
      return;
    }
    if (args.trim()) ctx.ui.notify("Luna 上下文快照已经停用，不再接受 refresh/off 参数", "warning");
    await showText(
      ctx,
      "Luna",
      "Luna 上下文快照已经停用。\n\n主对话历史现在只使用 Pi 原生递归 compaction；Luna 以后仅作为简单工作线程，不再拥有或替换主对话记忆。",
    );
  }

  async function openUsagePanel(args, ctx) {
    if (args.trim()) {
      ctx.ui.notify("/usage 不接受参数；在面板中选择刷新", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/usage 需要 TUI 或 RPC 交互界面", "error");
      return;
    }

    let force = true;
    while (true) {
      ctx.ui.setWorkingMessage?.("正在查询当前 Codex 订阅额度…");
      try {
        await refreshCodexUsage(ctx, { force });
      } catch {
        // The sanitized error is rendered below with a retry action.
      } finally {
        ctx.ui.setWorkingMessage?.(DEFAULT_WORKING_MESSAGE);
      }
      const text = [
        formatCodexBankDetails(codexBank, ctx.model),
        ...(codexUsageError ? ["", `最近查询错误：${codexUsageError}`] : []),
      ].join("\n");
      const retryLabel = codexBank ? "刷新当前 Usage" : "重试";
      const action = await ctx.ui.select(`当前 Pi 账户 · Codex Usage\n\n${text}`, [retryLabel, "关闭"]);
      if (!action || action === "关闭") return;
      force = true;
    }
  }

  async function openThinkingPanel(ctx) {
    if (!ctx.hasUI) {
      ctx.ui.notify("/think 需要可交互界面", "error");
      return;
    }
    const current = pi.getThinkingLevel();
    const labels = THINKING_LEVELS.map((level) => `${level === current ? "✓" : " "} ${level}`);
    const selected = await ctx.ui.select(`思考等级 · 当前 ${current}`, labels);
    if (!selected) return;
    const requested = selected.slice(2);
    pi.setThinkingLevel(requested);
    const actual = pi.getThinkingLevel();
    updateStatus(ctx);
    ctx.ui.notify(
      actual === requested ? `思考等级已切换为 ${actual}` : `模型不支持 ${requested}，已调整为 ${actual}`,
      "info",
    );
  }

  async function openGuidePanel(ctx) {
    const runtime = ensureRuntime(ctx);
    const idea = runtime?.isInitialized() ? runtime.getCurrentIdea() : null;
    const p1 = runtime?.isInitialized() ? runtime.getCurrentP1() : null;
    const text = [
      "【你当前保留的 Pi 原生能力】",
      "- 会话：/new 新建；/resume 恢复；/tree 查看分支树；/fork 从当前点分叉；/name 命名。",
      "- 文件引用：输入 @ 后用 Pi 原生模糊补全工作区文件；历史由 Pi 原生递归 compaction 管理。",
      "- 模型：Ctrl+L 打开模型选择；Ctrl+P 前向切换；Shift+Ctrl+P 反向切换。",
      "- 思考：Shift+Tab 循环等级；Ctrl+T 折叠/展开思考块。",
      "- 工具输出：Ctrl+O 折叠/展开；Harness 启动时默认折叠。",
      "- 消息：Enter 发送；Alt+Enter 排队追问；Alt+Up 取回队列；Esc 中断；Ctrl+X 复制回答。",
      "- 上下文与配置：/compact、/model、/scoped-models、/settings、/login、/reload、/export。",
      "- 完整动态命令：在输入框键入 /；完整快捷键：/hotkeys。",
      "",
      "【Idea Harness 增加的能力】",
      "- /idea：当前 P0、精确修改 diff、确认与版本历史（版本号只在这里显示）。",
      "- /context：查看本次真实注入 Manifest；/context edit 编辑短 P1。",
      "- /luna：查看 Luna 状态；Luna 上下文快照已停用，未来只承担简单工作线程。",
      "- /usage：用当前 Pi Codex 运行账户主动查询官方订阅额度，并可刷新。",
      "- /think 或 Alt+T：直接选择思考等级；Shift+Tab 仍是 Pi 原生快速循环。",
      "- /idea-main：回到主对话；/idea-takeover：显式接管控制权。",
      "",
      "【顶栏怎么读】",
      "- Idea/阶段显示最近确认或更新时间；版本细节不占主界面。",
      "- CTX 彩色条按本次调用实际组成：Idea、阶段、Pi 摘要/对话、系统、工具。每次发送都会重算。",
      "- Codex Usage 优先查询当前 Pi 运行账户的官方 usage endpoint；响应头仅作即时降级来源；— 表示尚无可验证数据。",
      "",
      ...(idea
        ? [
            `Idea 最近确认：${new Date(idea.createdAt).toLocaleString("zh-CN")}（v${idea.version}，路线 v${idea.routeVersion}）`,
            `阶段最近更新：${new Date(p1.createdAt).toLocaleString("zh-CN")}（P1 v${p1.version}${p1.content ? "" : "，当前为空"}）`,
          ]
        : ["当前目录尚未确认 Idea；使用 /idea-init 开始。"]),
      "",
      formatCodexBankDetails(codexBank, ctx.model),
      ...(codexUsageError ? ["", `最近 Usage 查询错误：${codexUsageError}`] : []),
    ].join("\n");
    await showText(ctx, "Pi + Idea Harness 使用指南", text);
  }

  pi.registerCommand("idea-init", {
    description: "初始化当前目录为受保护的 Idea Space",
    handler: async (_args, ctx) => initializeIdea(ctx),
  });

  pi.registerCommand("idea", {
    description: "打开 Idea、版本与待确认修改的二级面板",
    handler: async (_args, ctx) => openIdeaPanel(ctx),
  });

  pi.registerCommand("context", {
    description: "查看实际注入的 Context Manifest；使用 /context edit 编辑 P1",
    handler: async (args, ctx) => openContextPanel(args, ctx),
  });

  pi.registerCommand("luna", {
    description: "查看 Luna 状态（上下文快照已停用）",
    handler: async (args, ctx) => openLunaPanel(args, ctx),
  });

  pi.registerCommand("think", {
    description: "快速选择思考等级；Shift+Tab 可直接循环",
    handler: async (_args, ctx) => openThinkingPanel(ctx),
  });

  pi.registerCommand("guide", {
    description: "查看 Pi 原生功能、Harness 命令与顶栏含义",
    handler: async (_args, ctx) => openGuidePanel(ctx),
  });

  pi.registerCommand("usage", {
    description: "查看当前 Pi Codex 订阅账户的 Usage",
    handler: async (args, ctx) => openUsagePanel(args, ctx),
  });

  pi.registerShortcut("alt+t", {
    description: "打开 Harness 思考等级选择器",
    handler: async (ctx) => openThinkingPanel(ctx),
  });

  pi.registerCommand("idea-main", {
    description: "返回当前 Idea 登记的主对话",
    handler: async (_args, ctx) => {
      const runtime = ensureRuntime(ctx);
      if (!runtime?.isInitialized()) return ctx.ui.notify("当前目录尚未绑定 Idea", "warning");
      const main = runtime.getMainSession();
      const identity = sessionIdentity(ctx);
      if (!main?.sessionFile) return ctx.ui.notify("尚未记录可恢复的主对话文件", "warning");
      if (main.sessionId === identity.sessionId) return ctx.ui.notify("当前已是登记的主对话", "info");
      if (!existsSync(main.sessionFile)) return ctx.ui.notify("登记的主对话文件不存在，需显式接管", "error");
      await ctx.switchSession(main.sessionFile, {
        withSession: async (nextCtx) => nextCtx.ui.notify("已返回 Idea 主对话", "info"),
      });
    },
  });

  pi.registerCommand("idea-takeover", {
    description: "经用户明确确认后，让当前持久会话接管 Idea 主对话",
    handler: async (_args, ctx) => {
      const runtime = ensureRuntime(ctx);
      if (!runtime?.isInitialized()) return ctx.ui.notify("当前目录尚未绑定 Idea", "warning");
      const identity = sessionIdentity(ctx);
      if (!identity.sessionId) return ctx.ui.notify("临时会话不能接管 Idea", "error");
      const previous = runtime.getControlState();
      const confirmed = await ctx.ui.confirm(
        "接管 Idea 主对话",
        `当前主会话为 ${shortId(previous.main?.sessionId) || "未设置"}。接管会撤销旧控制租约，但不会删除任何对话。确认吗？`,
      );
      if (!confirmed) return;
      runtime.setMainSession(identity.sessionId, identity.sessionFile, actorFor(ctx, "user"));
      lease = runtime.acquireControllerLease({ ...identity, clientId: CLIENT_ID, ttlMs: LEASE_TTL_MS, force: true });
      updateStatus(ctx);
      ctx.ui.notify("当前会话已成为唯一主对话控制者", "info");
    },
  });

  pi.registerTool({
    name: "idea_prepare_initialization",
    label: "Idea · 整理",
    ...transientToolRenderers({ title: "Idea", describeArgs: () => "整理初始化候选" }),
    description:
      "During Idea Space initialization only, save a concise P0 candidate organized from the user's raw idea. "
      + "Never add goals, evidence, mechanisms, or constraints the user did not express. "
      + "This tool does not initialize or commit anything; the user must review and confirm through /idea.",
    promptSnippet: "Organize the raw initialization draft into a user-confirmed P0 candidate",
    promptGuidelines: [
      "Use only while an uninitialized Idea draft exists.",
      "Ask the user before resolving any ambiguity that could change scientific direction.",
      "Do not invoke research, coding, browsing, or workflow tools while organizing the initial candidate.",
      "The candidate may use any natural-language or Markdown structure; there are no required markers.",
    ],
    parameters: INITIALIZATION_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = ensureRuntime(ctx, { createAtCwd: true });
      const draft = runtime.saveInitializationCandidate(params.candidate_content, {
        actor: actorFor(ctx, "main"),
        rationale: params.rationale,
      });
      updateStatus(ctx);
      ctx.ui.notify("P0 初始化候选已保存，等待用户通过 /idea 检查和确认", "info");
      return {
        content: [{
          type: "text",
          text: [
            "P0 初始化候选已保存，但尚未成为权威 Idea。",
            "请让用户运行 /idea，对照原始想法后确认、继续调整或放弃。",
          ].join("\n"),
        }],
        details: { rawHash: draft.rawHash, candidateHash: draft.candidateHash, status: "pending-user-confirmation" },
      };
    },
  });

  pi.registerTool({
    name: "idea_propose_change",
    label: "Idea · 提案",
    ...transientToolRenderers({ title: "Idea", describeArgs: () => "准备变更提案" }),
    description:
      "Only after the user explicitly asks to modify the scientific Idea, create or revise a full-text pending proposal. "
      + "This tool never commits IDEA.md. Pass the complete candidate P0 and classify whether the route changed. "
      + "Pass proposal_id to revise an existing proposal. "
      + "The user must review the exact diff and confirm in /idea.",
    promptSnippet: "Create or revise an Idea change proposal; never commits the Idea",
    promptGuidelines: [
      "Never edit IDEA.md or .harness directly; use idea_propose_change only after an explicit user request.",
      "A proposal is not accepted state. Tell the user to review it in /idea.",
    ],
    parameters: PROPOSAL_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = ensureRuntime(ctx);
      if (!runtime?.isInitialized()) throw new IdeaStateError("当前目录尚未绑定 Idea", "NOT_INITIALIZED");
      const actor = actorFor(ctx, lease.acquired ? "main" : "branch");
      const proposal = params.proposal_id
        ? runtime.updateProposal(params.proposal_id, {
            candidateContent: params.candidate_content,
            routeChanged: params.route_changed,
            rationale: params.rationale,
            evidenceRefs: params.evidence_refs,
            actor,
          })
        : runtime.createProposal({
            candidateContent: params.candidate_content,
            routeChanged: params.route_changed,
            rationale: params.rationale,
            evidenceRefs: params.evidence_refs,
            actor,
          });
      compiler.invalidate("idea-proposal-changed");
      updateStatus(ctx);
      ctx.ui.notify(`Idea 提案 ${shortId(proposal.id)} r${proposal.revision} 待用户确认 · /idea`, "info");
      return {
        content: [{
          type: "text",
          text: [
            `已保存待确认提案 ${proposal.id}，revision ${proposal.revision}。`,
            "权威 IDEA.md 没有改变。请让用户通过 /idea 查看并确认，或继续讨论调整。",
            "",
            runtime.proposalDiff(proposal.id),
          ].join("\n"),
        }],
        details: {
          proposalId: proposal.id,
          revision: proposal.revision,
          status: proposal.status,
          baseVersion: proposal.baseVersion,
          candidateHash: proposal.candidateHash,
          affectedFields: proposal.affectedFields,
        },
      };
    },
  });

  pi.registerTool({
    name: "context_update_p1",
    label: "阶段 · 更新",
    ...transientToolRenderers({ title: "Stage", describeArgs: () => "更新 P1" }),
    description:
      "Replace the short current-stage P1 working set when substantive context changes. "
      + "Use only from the active main conversation. This does not modify P0 or the Idea route.",
    promptSnippet: "Update the short protected P1 stage context",
    parameters: P1_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = ensureRuntime(ctx);
      if (!runtime?.isInitialized()) throw new IdeaStateError("当前目录尚未绑定 Idea", "NOT_INITIALIZED");
      if (!isController(ctx)) throw new IdeaStateError("当前会话不是活跃主对话，不能更新 P1", "NOT_CONTROLLER");
      const p1 = runtime.updateP1(params.content, {
        actor: actorFor(ctx, "main"),
        reason: params.reason,
        sourceRefs: params.source_refs,
      });
      compiler.invalidate("p1-updated");
      updateStatus(ctx);
      return {
        content: [{ type: "text", text: `P1 已更新到 v${p1.version}（${p1.hash}）。P0 与 Idea 版本未改变。` }],
        details: { version: p1.version, hash: p1.hash },
      };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const boundSession = (ctx.sessionManager.getEntries?.() ?? []).some(
      (entry) => entry.type === "custom" && entry.customType === "idea-harness-binding",
    );
    ideaModeActive = Boolean(pi.getFlag("idea") || boundSession);
    if (!ideaModeActive) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    // Idea conversations use compact tools and the lightweight research footer;
    // ordinary Pi conversations retain Pi's untouched default UI.
    ctx.ui.setToolsExpanded?.(false);
    installWorkingVisual(ctx);
    const discovered = findIdeaSpace(ctx.cwd);
    if (!discovered) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    openRuntime(discovered);
    installHarnessFooter(ctx);
    if (store.isInitialized()) {
      const main = store.getMainSession();
      const identity = sessionIdentity(ctx);
      if (
        event.reason === "startup"
        && ctx.mode === "tui"
        && pi.getFlag("idea")
        && !hasExplicitSessionIntent()
        && main?.sessionFile
        && main.sessionId !== identity.sessionId
        && existsSync(main.sessionFile)
      ) {
        await ctx.switchSession(main.sessionFile);
        return;
      }
      bindSession(ctx);
    }
    else updateStatus(ctx);
    scheduleCodexUsageRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    restoreWorkingVisual(ctx);
    restoreHarnessFooter(ctx);
    closeRuntime();
  });

  pi.on("agent_start", async (_event, ctx) => {
    ctx.ui.setWorkingMessage?.("正在理解任务…");
    resetOutputMetrics({ active: true });
    updateStatus(ctx);
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    ctx.ui.setWorkingMessage?.("正在组织回答…");
    resetOutputMetrics({ active: true });
    updateStatus(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    ctx.ui.setWorkingMessage?.(workingMessageForTool(event.toolName));
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    ctx.ui.setWorkingMessage?.("正在继续处理…");
  });

  pi.on("message_update", async (event, ctx) => {
    const delta = streamDelta(event);
    if (!delta) return;
    const now = Date.now();
    outputMetrics.active = true;
    outputMetrics.firstTokenAt ??= now;
    outputMetrics.lastTokenAt = now;
    outputMetrics.streamedText += delta;
    outputMetrics.estimatedTokens = estimateTextTokens(outputMetrics.streamedText);
    const elapsedSeconds = (now - outputMetrics.firstTokenAt) / 1_000;
    outputMetrics.tokensPerSecond = elapsedSeconds >= 0.25
      ? outputMetrics.estimatedTokens / elapsedSeconds
      : null;
    if (now - outputMetrics.lastRenderedAt >= SPEED_REFRESH_MS) {
      outputMetrics.lastRenderedAt = now;
      updateStatus(ctx);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const now = Date.now();
    const tokens = actualOutputTokens(event.message) ?? outputMetrics.estimatedTokens;
    const first = outputMetrics.firstTokenAt;
    const last = outputMetrics.lastTokenAt ?? now;
    const elapsedSeconds = first === null ? 0 : Math.max((last - first) / 1_000, 0.25);
    outputMetrics.active = false;
    outputMetrics.tokensPerSecond = tokens > 0 && elapsedSeconds > 0 ? tokens / elapsedSeconds : null;
    updateStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    ctx.ui.setWorkingMessage?.(DEFAULT_WORKING_MESSAGE);
    outputMetrics.active = false;
    updateStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Unlike agent_end, settled fires only after Pi has no retry, overflow
    // recovery, queued follow-up, or automatic continuation left. This makes
    // compaction scheduling acyclic and keeps it off the active tool loop.
    scheduleNativeCompaction(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => updateStatus(ctx));

  pi.on("model_select", async (_event, ctx) => {
    codexUsageController?.abort();
    codexUsageController = null;
    codexUsageQuery = null;
    codexBank = null;
    codexUsageError = null;
    updateStatus(ctx);
    scheduleCodexUsageRefresh(ctx, 0);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    // Keep only verified Codex rate-window/credits fields, never complete
    // response headers. They give an immediate fallback while the read-only
    // current-account usage query runs independently of the model stream.
    const observed = parseCodexBankHeaders(event.headers);
    if (observed) {
      codexBank = observed;
      updateStatus(ctx);
    }
    if (ctx.model?.provider === "openai-codex") {
      void refreshCodexUsage(ctx).catch(() => {
        // /usage exposes the sanitized failure and retry action.
      });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = ensureRuntime(ctx);
    if (!runtime) return;
    if (!runtime.isInitialized()) {
      const draft = runtime.getInitializationDraft();
      if (!draft) return;
      const initializationGuard = [
        "# Idea Harness initialization boundary",
        "The Idea Space is not initialized yet. The text below is the user's raw intent, not an authoritative P0.",
        "Organize it faithfully; do not add goals or resolve direction-changing ambiguity without asking the user.",
        "Do not invoke research, browsing, coding, skills, or workflow tools for this organization step.",
        "When a candidate is ready, call idea_prepare_initialization. Only the user can confirm it through /idea.",
        "",
        "<raw_idea_draft>",
        draft.rawContent,
        "</raw_idea_draft>",
        ...(draft.candidateContent
          ? ["", "<current_candidate>", draft.candidateContent, "</current_candidate>"]
          : []),
      ].join("\n");
      return { systemPrompt: `${event.systemPrompt}\n\n${initializationGuard}` };
    }
    const controller = isController(ctx);
    const guard = [
      "# Scientific Idea Harness boundary",
      "The first user message in every model call begins with the exact protected P0 from IDEA.md.",
      "Treat it as the scientific object, end criterion, and active route—not as a summary or a suggestion.",
      "Never silently redefine it. Engineering and tool work are subordinate to advancing that scientific object.",
      "You may challenge it and create an Idea change proposal only after the user asks; you can never commit the proposal.",
      controller
        ? "This is the active main conversation. You may coordinate work and update P1 through the dedicated tool."
        : "This is not the active main controller. Append evidence or proposals only; do not claim canonical direction changes.",
      "Historical compression and recursive summaries are owned by Pi native compaction. Never create or request a competing Luna context snapshot.",
      "Treat native compaction summaries as non-authoritative historical memory: facts, hypotheses, conflicts, operations, decisions, and open loops must remain distinct.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${guard}` };
  });

  pi.on("context", async (event, ctx) => {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized()) return;
    try {
      const result = compiler.compile({
        messages: event.messages,
        contextWindow: ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 128_000,
        modelMaxTokens: ctx.model?.maxTokens ?? 16_384,
        systemPrompt: ctx.getSystemPrompt(),
        toolDefinitions: pi.getAllTools(),
      });
      if (!result.manifest.reused) {
        runtime.appendEvent("context_packet_compiled", actorFor(ctx, "system"), {
          packetId: result.manifest.packetId,
          ideaVersion: result.manifest.ideaVersion,
          ideaHash: result.manifest.ideaHash,
          p1Version: result.manifest.p1Version,
          nativeHistoryTokens: result.manifest.tokens.dynamic,
          packetHash: result.manifest.packetHash,
          reason: result.manifest.invalidationReason,
        });
      }
      updateStatus(ctx);
      return { messages: result.messages };
    } catch (error) {
      if (error instanceof ContextBudgetError || error instanceof IdeaIntegrityError) {
        runtime.appendEvent("context_call_blocked", actorFor(ctx, "system"), {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        });
        ctx.ui.setStatus(STATUS_KEY, `已阻止调用 · ${error.code}`);
        ctx.ui.notify(error.message, "error");
        ctx.abort();
        const emergency = compiler.emergencyProtectedMessage();
        return { messages: emergency ? [emergency] : [] };
      }
      throw error;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized()) return;
    compiler.invalidate(`before-compaction:${event.reason}`);
    runtime.appendEvent("pi_compaction_started", actorFor(ctx, "system"), {
      reason: event.reason,
      willRetry: event.willRetry,
      ideaVersion: runtime.getCurrentIdea().version,
      ideaHash: runtime.getCurrentIdea().hash,
      tokensBefore: event.preparation?.tokensBefore ?? null,
    });
    nativeCompactionQueued = false;
    nativeCompactionRunning = true;
    updateStatus(ctx);
  });

  pi.on("session_compact", async (event, ctx) => {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized()) return;
    compiler.invalidate(`after-compaction:${event.reason}`);
    nativeCompactionQueued = false;
    nativeCompactionRunning = false;
    const entry = event.compactionEntry;
    const blocks = parseNativeCompactionBlocks(entry?.summary);
    if (entry?.id && entry?.summary) {
      runtime.saveNativeCompactionSet({
        compactionId: entry.id,
        sessionId: sessionIdentity(ctx).sessionId ?? "ephemeral",
        reason: event.reason,
        summaryHash: sha256(entry.summary),
        tokensBefore: entry.tokensBefore ?? 0,
        blocks,
        createdAt: new Date(entry.timestamp ?? Date.now()).toISOString(),
      });
    }
    runtime.appendEvent("pi_compaction_completed", actorFor(ctx, "system"), {
      reason: event.reason,
      fromExtension: event.fromExtension,
      compactionId: entry?.id ?? null,
      blockCount: blocks.length,
      ideaVersion: runtime.getCurrentIdea().version,
      ideaHash: runtime.getCurrentIdea().hash,
    });
    updateStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const runtime = ensureRuntime(ctx);
    if (!runtime?.isInitialized()) return;
    const reason = protectedToolReason(event, ctx, root);
    if (reason) {
      runtime.appendEvent("protected_write_blocked", actorFor(ctx, "system"), {
        toolName: event.toolName,
        reason,
      });
      return { block: true, reason };
    }
  });
}
