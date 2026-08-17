export const DEFAULT_WORKING_MESSAGE = "正在处理…";

export function workingMessageForTool(toolName) {
  const name = String(toolName ?? "").trim().toLowerCase();

  if (name === "luna_refresh_context") return "Luna 正在整理相关历史…";
  if (name === "idea_prepare_initialization" || name === "idea_propose_change") {
    return "正在整理 Idea 候选…";
  }
  if (name === "context_update_p1") return "正在更新阶段上下文…";
  if (/test|check|lint|verify|review/.test(name)) return "正在验证结果…";
  if (/grep|search|find|glob|query|web/.test(name)) return "正在查找相关信息…";
  if (/read|view|open|fetch/.test(name)) return "正在读取相关内容…";
  if (/edit|write|patch|apply|create/.test(name)) return "正在更新文件…";
  if (/bash|shell|exec|command|terminal/.test(name)) return "正在执行命令…";

  return "正在使用工具…";
}

export function workingIndicatorOptions(theme) {
  const paint = (color, value) => theme?.fg?.(color, value) ?? value;
  return {
    // A small Claude-like pulse, built only with Pi's stable public UI API.
    frames: [
      paint("dim", "·"),
      paint("muted", "✢"),
      paint("accent", "✳"),
      paint("accent", "✻"),
      paint("accent", "✳"),
      paint("muted", "✢"),
    ],
    intervalMs: 110,
  };
}

export function installWorkingVisual(ctx) {
  ctx?.ui?.setWorkingVisible?.(true);
  ctx?.ui?.setWorkingIndicator?.(workingIndicatorOptions(ctx?.ui?.theme));
  ctx?.ui?.setWorkingMessage?.(DEFAULT_WORKING_MESSAGE);
}

export function restoreWorkingVisual(ctx) {
  ctx?.ui?.setWorkingMessage?.();
  ctx?.ui?.setWorkingIndicator?.();
  ctx?.ui?.setWorkingVisible?.(true);
}
