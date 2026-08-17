import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function addUsage(target, usage) {
  if (!usage) return;
  target.input += finite(usage.input);
  target.output += finite(usage.output);
  target.cacheRead += finite(usage.cacheRead);
  target.cacheWrite += finite(usage.cacheWrite);
  target.cost += finite(usage.cost?.total ?? usage.cost);
}

export function observedSessionUsage(entries = []) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 };
  for (const entry of entries) {
    if (entry?.type === "message") addUsage(totals, entry.message?.usage);
    else addUsage(totals, entry?.usage);
  }
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return Object.freeze(totals);
}

export function compactTokens(value) {
  const number = Math.max(0, finite(value));
  if (number < 1_000) return `${Math.round(number)}`;
  if (number < 1_000_000) return `${(number / 1_000).toFixed(number < 10_000 ? 1 : 0)}k`;
  return `${(number / 1_000_000).toFixed(number < 10_000_000 ? 1 : 0)}m`;
}

export function relativeAge(value, now = Date.now()) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "未确认";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function contextGauge(percent, blocks = 12) {
  if (percent == null || !Number.isFinite(Number(percent))) return `[${"·".repeat(blocks)}] ?`;
  const value = Math.max(0, Math.min(100, Number(percent)));
  const filled = Math.max(0, Math.min(blocks, Math.round(value / 100 * blocks)));
  return `[${"■".repeat(filled)}${"·".repeat(blocks - filled)}] ${Math.round(value)}%`;
}

export function contextModeLabel(mode) {
  return String(mode) === "safe" ? "安全回退" : "证据组装";
}

export function workflowStatusLabel(status) {
  return ({ running: "运行", waiting: "等待", blocked: "阻塞", complete: "完成", failed: "失败", cancelled: "取消" })[status] || String(status || "未知");
}

export class WorkflowRunRegistry {
  constructor() {
    this.runs = new Map();
  }

  clear() {
    this.runs.clear();
  }

  upsert(value = {}) {
    const taskId = String(value.taskId || "").trim();
    if (!taskId) throw new Error("Workflow run requires taskId");
    const previous = this.runs.get(taskId) || {};
    const next = Object.freeze({
      taskId,
      label: String(value.label ?? previous.label ?? taskId),
      status: String(value.status ?? previous.status ?? "running"),
      model: String(value.model ?? previous.model ?? "gpt-5.6-luna"),
      reasoningEffort: String(value.reasoningEffort ?? previous.reasoningEffort ?? "low"),
      objective: String(value.objective ?? previous.objective ?? ""),
      cardHash: value.cardHash ?? previous.cardHash ?? null,
      startedAt: value.startedAt ?? previous.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      detail: String(value.detail ?? previous.detail ?? ""),
    });
    this.runs.set(taskId, next);
    return next;
  }

  snapshot() {
    const rows = [...this.runs.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const active = rows.filter((row) => ["running", "waiting", "blocked"].includes(row.status));
    return Object.freeze({ rows: Object.freeze(rows), active: Object.freeze(active), activeCount: active.length });
  }
}

function usageColor(percent) {
  if (percent == null) return "dim";
  if (percent >= 85) return "error";
  if (percent >= 60) return "warning";
  return "success";
}

function modelLabel(modelId, thinkingLevel) {
  const id = String(modelId || "").toLowerCase();
  const family = id.includes("sol") ? "Sol" : id.includes("luna") ? "Luna" : (modelId || "模型");
  return `${family} ${thinkingLevel || "?"}`;
}

function contextLabel(context, detailed = true) {
  const percent = context?.percent == null || !Number.isFinite(Number(context.percent))
    ? "?"
    : `${Math.round(Number(context.percent))}%`;
  const tokens = finite(context?.tokens);
  const window = finite(context?.contextWindow);
  if (!detailed || tokens <= 0 || window <= 0) return `上下文 ${percent}`;
  return `上下文 ${percent} ${compactTokens(tokens)}/${compactTokens(window)}`;
}

function renderSegments(theme, segments) {
  const separator = theme.fg("dim", " · ");
  return segments.map((segment) => theme.fg(segment.color, segment.text)).join(separator);
}

export function researchFooterLine({ state, mode, context, usage, workflows, activeTools, modelId, thinkingLevel, width, theme }) {
  const ideaEnabled = Boolean(state?.idea);
  const hasUsage = finite(usage?.input) + finite(usage?.output) + finite(usage?.cacheRead) > 0;
  const workText = [
    workflows?.activeCount ? `Workflow ${workflows.activeCount}` : "",
    activeTools?.length ? `工具 ${activeTools.length}` : "",
  ].filter(Boolean).join(" · ");

  const segments = [
    {
      key: "idea",
      color: ideaEnabled ? "accent" : "dim",
      text: ideaEnabled
        ? `◆ Idea v${state.idea.version} · ${relativeAge(state.idea.confirmedAt)}`
        : "◇ Pi-Idea · /idea-start",
    },
    ...(ideaEnabled ? [{ key: "mode", color: "muted", text: contextModeLabel(mode) }] : []),
    { key: "model", color: "muted", text: modelLabel(modelId, thinkingLevel) },
    { key: "context", color: usageColor(context?.percent), text: contextLabel(context, true) },
    ...(workText ? [{ key: "work", color: "warning", text: workText }] : []),
    ...(hasUsage ? [{
      key: "usage",
      color: "dim",
      text: `会话 ↑${compactTokens(usage.input)} ↓${compactTokens(usage.output)} ↺${compactTokens(usage.cacheRead)}`,
    }] : []),
  ];

  const fits = () => visibleWidth(renderSegments(theme, segments)) <= width;
  if (!fits()) {
    const usageIndex = segments.findIndex((segment) => segment.key === "usage");
    if (usageIndex >= 0) segments.splice(usageIndex, 1);
  }
  if (!fits()) {
    const contextSegment = segments.find((segment) => segment.key === "context");
    if (contextSegment) contextSegment.text = contextLabel(context, false);
  }
  if (!fits()) {
    const modeIndex = segments.findIndex((segment) => segment.key === "mode");
    if (modeIndex >= 0) segments.splice(modeIndex, 1);
  }
  if (!fits()) {
    const ideaSegment = segments.find((segment) => segment.key === "idea");
    if (ideaSegment) ideaSegment.text = ideaEnabled ? `◆ Idea v${state.idea.version}` : "◇ Pi-Idea";
  }
  return truncateToWidth(renderSegments(theme, segments), width);
}

export function researchFooter({ ctx, footerData, getState, getMode, getActiveTools, getWorkflows }) {
  return (tui, theme) => {
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
    const timer = setInterval(() => tui.requestRender(), 15_000);
    timer.unref?.();
    return {
      dispose() {
        clearInterval(timer);
        unsubscribe?.();
      },
      invalidate() {},
      render(width) {
        const state = getState();
        const context = ctx.getContextUsage?.();
        const usage = observedSessionUsage(ctx.sessionManager.getBranch?.() || []);
        const workflows = getWorkflows();
        const activeTools = getActiveTools();
        return [researchFooterLine({
          state,
          mode: getMode(),
          context,
          usage,
          workflows,
          activeTools,
          modelId: ctx.model?.id,
          thinkingLevel: ctx.thinkingLevel,
          width,
          theme,
        })];
      },
    };
  };
}

export function researchDashboardText({ state, context, usage, mode, workflows, activeTools, manifest }) {
  const idea = state?.idea;
  const tokens = manifest?.contextCompiler?.tokens || {};
  const watermark = manifest?.contextCompiler?.watermarks || {};
  return [
    "PI-IDEA 研究控制台",
    "",
    `Idea       ${idea ? `v${idea.version} · ${relativeAge(idea.confirmedAt)} · ${idea.hash.slice(0, 12)}` : "未启用"}`,
    `阶段       ${state?.stage || "（空）"}`,
    `模式       ${contextModeLabel(mode)}`,
    `上下文     ${contextGauge(context?.percent)} ${context?.tokens == null ? "" : `${compactTokens(context.tokens)}/${compactTokens(context.contextWindow)}`}`,
    `水位       soft ${watermark.softLimit ? compactTokens(watermark.softLimit) : "?"} · hard ${watermark.hardLimit ? compactTokens(watermark.hardLimit) : "?"}`,
    `组装       system ${compactTokens(tokens.system)} · tools ${compactTokens(tokens.toolSchemaReserve)} · anchor ${compactTokens(tokens.anchor)} · live ${compactTokens(tokens.live ?? tokens.nativeMessages)} · evidence ${compactTokens(tokens.evidence)}`,
    `用量       会话可观测 ↑${compactTokens(usage.input)} ↓${compactTokens(usage.output)} ↺${compactTokens(usage.cacheRead)} · 总计 ${compactTokens(usage.total)}`,
    `运行       ${workflows.activeCount} 个 Workflow · ${activeTools.length} 个工具`,
    "",
    "注：用量是 Pi 会话的本地可观测值，不是 Codex 账户剩余额度。",
  ].join("\n");
}
