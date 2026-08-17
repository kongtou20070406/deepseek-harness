function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  );
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safeDisplayText(value, maxLength = 160) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function parseHeaderWindow(headers, prefix, kind) {
  const usedPercent = finiteNumber(headers[`x-${prefix}-${kind}-used-percent`]);
  if (usedPercent === null) return null;
  return {
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes: finiteNumber(headers[`x-${prefix}-${kind}-window-minutes`]),
    resetsAt: finiteNumber(headers[`x-${prefix}-${kind}-reset-at`]),
  };
}

function parsePayloadWindow(value) {
  const window = recordValue(value);
  if (!window) return null;
  const usedPercent = finiteNumber(window.used_percent);
  if (usedPercent === null) return null;
  const seconds = finiteNumber(window.limit_window_seconds);
  return {
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes: seconds !== null && seconds > 0 ? Math.ceil(seconds / 60) : null,
    resetsAt: finiteNumber(window.reset_at),
  };
}

function parseHeaderCredits(headers) {
  const hasCredits = booleanValue(headers["x-codex-credits-has-credits"]);
  const unlimited = booleanValue(headers["x-codex-credits-unlimited"]);
  if (hasCredits === null || unlimited === null) return null;
  return {
    hasCredits,
    unlimited,
    balance: safeDisplayText(headers["x-codex-credits-balance"]) ?? null,
  };
}

function parsePayloadCredits(value) {
  const credits = recordValue(value);
  if (!credits) return null;
  const hasCredits = booleanValue(credits.has_credits);
  const unlimited = booleanValue(credits.unlimited);
  if (hasCredits === null) return null;
  const rawBalance = credits.balance;
  const balance = typeof rawBalance === "number" && Number.isFinite(rawBalance)
    ? String(rawBalance)
    : safeDisplayText(rawBalance);
  return { hasCredits, unlimited: unlimited ?? false, balance: balance ?? null };
}

function normalizeLimitId(value, fallback) {
  const text = safeDisplayText(value)?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return text || fallback;
}

function payloadLimit(id, name, value) {
  const rateLimit = recordValue(value);
  if (!rateLimit) return null;
  const primary = parsePayloadWindow(rateLimit.primary_window);
  const secondary = parsePayloadWindow(rateLimit.secondary_window);
  if (!primary && !secondary) return null;
  return { id, name, primary, secondary };
}

export function parseCodexBankHeaders(rawHeaders, observedAt = new Date().toISOString()) {
  const headers = normalizeHeaders(rawHeaders);
  const prefixes = new Set(["codex"]);
  for (const key of Object.keys(headers)) {
    const match = /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(key);
    if (match) prefixes.add(match[1]);
  }
  const credits = parseHeaderCredits(headers);
  const limits = [...prefixes].map((prefix) => ({
    id: normalizeLimitId(prefix, "codex"),
    name: safeDisplayText(headers[`x-${prefix}-limit-name`]),
    primary: parseHeaderWindow(headers, prefix, "primary"),
    secondary: parseHeaderWindow(headers, prefix, "secondary"),
  })).filter((limit) => limit.primary || limit.secondary || (limit.id === "codex" && credits));
  if (!limits.length && !credits) return null;
  return {
    limits,
    credits,
    resetCredits: null,
    planType: null,
    source: "response-headers",
    observedAt,
  };
}

export function parseCodexUsagePayload(rawPayload, observedAt = new Date().toISOString()) {
  const payload = recordValue(rawPayload);
  if (!payload) throw new Error("Codex usage 响应不是 JSON 对象");

  const limits = [];
  const primary = payloadLimit("codex", "Codex", payload.rate_limit);
  if (primary) limits.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const rawItem of additional) {
    const item = recordValue(rawItem);
    if (!item) continue;
    const rawId = safeDisplayText(item.metered_feature) ?? safeDisplayText(item.limit_name);
    if (!rawId) continue;
    const limit = payloadLimit(
      normalizeLimitId(rawId, `additional_${limits.length + 1}`),
      safeDisplayText(item.limit_name) ?? rawId,
      item.rate_limit,
    );
    if (limit) limits.push(limit);
  }

  const credits = parsePayloadCredits(payload.credits);
  const resetCreditsValue = recordValue(payload.rate_limit_reset_credits);
  const availableCount = finiteNumber(resetCreditsValue?.available_count);
  const resetCredits = availableCount !== null && Number.isSafeInteger(availableCount)
    ? { availableCount: Math.max(0, availableCount) }
    : null;
  const planType = safeDisplayText(payload.plan_type);

  if (!limits.length && !credits && !resetCredits) {
    throw new Error("Codex usage 响应没有可显示的额度数据");
  }
  return {
    limits,
    credits,
    resetCredits,
    planType,
    source: "usage-endpoint",
    observedAt,
  };
}

function normalizeKey(value) {
  const key = safeDisplayText(value)?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return key || null;
}

function normalizedModelKeys(model) {
  const keys = new Set();
  for (const value of [model?.id, model?.name]) {
    const key = normalizeKey(value);
    if (!key) continue;
    keys.add(key);
    const codexIndex = key.indexOf("codex");
    if (codexIndex >= 0) keys.add(key.slice(codexIndex));
  }
  return keys;
}

function keyContainsToken(key, token) {
  return key === token || key.startsWith(`${token}-`) || key.endsWith(`-${token}`) || key.includes(`-${token}-`);
}

function preferredLimit(bank, model) {
  const candidates = bank?.limits?.filter((limit) => limit.primary || limit.secondary) ?? [];
  if (!candidates.length) return null;
  if (model?.provider === "openai-codex") {
    const modelKeys = normalizedModelKeys(model);
    for (const limit of candidates) {
      const limitKeys = [limit.id, limit.name].map(normalizeKey).filter(Boolean);
      if (limitKeys.some((key) => modelKeys.has(key))) return limit;
    }
    const variants = [...modelKeys].map((key) => key.match(/(?:^|-)codex-(.+)$/)?.[1]).filter(Boolean);
    for (const variant of variants) {
      const matches = candidates.filter((limit) => {
        const key = normalizeKey(limit.id);
        return key && key !== "codex" && keyContainsToken(key, variant);
      });
      if (matches.length === 1) return matches[0];
    }
  }
  return candidates.find((limit) => limit.id === "codex") ?? candidates[0];
}

function percentLabel(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function windowLabel(minutes, fallback, { compact = false } = {}) {
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 10_080) return compact ? "wk" : "每周";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}周`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function compactLimitName(limit) {
  if (!limit || limit.id === "codex") return "";
  const label = safeDisplayText(limit.name ?? limit.id) ?? limit.id;
  return label.replace(/[_-]+/g, " ").replace(/^codex\s+/i, "").trim().toLowerCase();
}

export function formatCodexBankLabel(bank, model) {
  if (!bank) return "Codex —";
  const limit = preferredLimit(bank, model);
  const prefix = `Codex${compactLimitName(limit) ? ` ${compactLimitName(limit)}` : ""}`;
  const windows = [
    limit?.primary ? `${percentLabel(limit.primary.remainingPercent)} ${windowLabel(limit.primary.windowMinutes, "5h", { compact: true })}` : null,
    limit?.secondary ? `${percentLabel(limit.secondary.remainingPercent)} ${windowLabel(limit.secondary.windowMinutes, "wk", { compact: true })}` : null,
  ].filter(Boolean);
  if (windows.length) return `${prefix} ${windows.join(" / ")}`;
  if (bank.credits?.unlimited) return `${prefix} credits ∞`;
  if (bank.credits?.balance) return `${prefix} credits ${bank.credits.balance}`;
  return `${prefix} —`;
}

function resetLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "重置时间未知";
  return `重置 ${new Date(seconds * 1_000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function sourceLabel(source) {
  if (source === "usage-endpoint") return "Codex 官方 usage endpoint（当前 Pi 运行账户）";
  if (source === "response-headers") return "当前 Codex 模型响应头（降级来源）";
  return "未知";
}

export function formatCodexBankDetails(bank, model) {
  if (!bank) {
    return "尚未取得当前 Codex 订阅额度。运行 /usage 主动查询；模型响应结束后 Harness 也会尝试后台更新。";
  }
  const selected = preferredLimit(bank, model);
  const ordered = [selected, ...(bank.limits ?? []).filter((limit) => limit !== selected)].filter(Boolean);
  const lines = [
    "Codex 订阅 Usage",
    `- 来源：${sourceLabel(bank.source)}`,
    ...(bank.planType ? [`- Plan：${bank.planType}`] : []),
  ];
  for (const limit of ordered) {
    lines.push("", `${limit === selected ? "当前模型额度" : "其他额度"} · ${limit.name ?? limit.id}`);
    for (const [fallback, window] of [["5h", limit.primary], ["每周", limit.secondary]]) {
      if (!window) continue;
      lines.push(
        `- ${windowLabel(window.windowMinutes, fallback)}：剩余 ${percentLabel(window.remainingPercent)}`
        + `（已用 ${percentLabel(window.usedPercent)}；${resetLabel(window.resetsAt)}）`,
      );
    }
  }
  if (bank.credits) {
    const value = bank.credits.unlimited
      ? "无限"
      : bank.credits.balance ?? (bank.credits.hasCredits ? "有余额，数值未返回" : "无额外 credits");
    lines.push("", `- Credits：${value}`);
  }
  if (bank.resetCredits) lines.push(`- 可用 usage-limit resets：${bank.resetCredits.availableCount}`);
  lines.push(`- 数据更新时间：${new Date(bank.observedAt).toLocaleString("zh-CN")}`);
  return lines.join("\n");
}
