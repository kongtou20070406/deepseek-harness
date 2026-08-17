const SEGMENT_DEFINITIONS = [
  { key: "p0", label: "Idea", shortLabel: "I", color: "accent" },
  { key: "p1", label: "阶段", shortLabel: "P1", color: "warning" },
  { key: "luna", label: "Luna", shortLabel: "L", color: "success" },
  { key: "dynamic", label: "对话", shortLabel: "D", color: "thinkingHigh" },
  { key: "system", label: "系统", shortLabel: "S", color: "mdLink" },
  { key: "tools", label: "工具", shortLabel: "T", color: "error" },
];

function tokenValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export function formatTokenCount(value) {
  const tokens = tokenValue(value);
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

export function formatRelativeTime(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知";
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function buildContextComposition(manifest) {
  if (!manifest) return null;
  const tokens = manifest.tokens ?? {};
  const budget = manifest.budget ?? {};
  const values = {
    p0: tokenValue(tokens.p0),
    p1: tokenValue(tokens.p1),
    luna: tokenValue(tokens.luna),
    dynamic: tokenValue(tokens.dynamic),
    // The packet marker is protocol/control overhead and is more useful to the
    // user when grouped with system context than exposed as a seventh sliver.
    system: tokenValue(budget.systemTokens) + tokenValue(tokens.control),
    tools: tokenValue(budget.toolTokens),
  };
  const segments = SEGMENT_DEFINITIONS.map((definition) => ({
    ...definition,
    tokens: values[definition.key],
  }));
  const used = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const contextWindow = tokenValue(budget.contextWindow);
  const reserved = tokenValue(budget.outputReserve) + tokenValue(budget.safetyMargin);
  const free = Math.max(0, contextWindow - used - reserved);
  return {
    segments,
    used,
    contextWindow,
    reserved,
    free,
    percent: contextWindow > 0 ? (used / contextWindow) * 100 : 0,
  };
}

export function allocateContextBar(composition, width = 28) {
  const columns = Math.max(1, Math.floor(width));
  const positive = (composition?.segments ?? []).filter((segment) => segment.tokens > 0);
  const contextWindow = tokenValue(composition?.contextWindow);
  const used = tokenValue(composition?.used);
  const proportionalColumns = contextWindow > 0
    ? Math.round(columns * Math.min(1, used / contextWindow))
    : used > 0
      ? columns
      : 0;
  const usedColumns = used > 0 ? Math.max(1, proportionalColumns) : 0;

  if (!positive.length || usedColumns === 0) {
    return { segments: [], usedColumns: 0, emptyColumns: columns, columns };
  }
  if (positive.length >= usedColumns) {
    const segments = positive.slice(0, usedColumns).map((segment) => ({ ...segment, columns: 1 }));
    return {
      segments,
      usedColumns,
      emptyColumns: columns - usedColumns,
      columns,
    };
  }

  const remaining = usedColumns - positive.length;
  const total = positive.reduce((sum, segment) => sum + segment.tokens, 0);
  const allocations = positive.map((segment, index) => {
    const exact = total > 0 ? (segment.tokens / total) * remaining : 0;
    return {
      ...segment,
      columns: 1 + Math.floor(exact),
      remainder: exact - Math.floor(exact),
      index,
    };
  });
  let assigned = allocations.reduce((sum, segment) => sum + segment.columns, 0);
  for (const segment of [...allocations].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (assigned >= usedColumns) break;
    segment.columns += 1;
    assigned += 1;
  }
  return {
    segments: allocations.map(({ remainder: _remainder, index: _index, ...segment }) => segment),
    usedColumns: assigned,
    emptyColumns: columns - assigned,
    columns,
  };
}
