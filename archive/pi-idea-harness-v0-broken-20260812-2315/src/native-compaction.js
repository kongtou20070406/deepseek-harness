export const NATIVE_COMPACTION_FRACTION = 0.4;
export const NATIVE_COMPACTION_MIN_TOKENS = 32_000;
export const NATIVE_COMPACTION_MIN_HEADROOM = 48_000;
export const NATIVE_COMPACTION_COOLDOWN_MS = 5 * 60_000;
export const NATIVE_COMPACTION_REARM_TOKENS = 8_000;
export const NATIVE_COMPACTION_INDEX_LIMIT = 8;
export const NATIVE_COMPACTION_PARSE_MAX_CHARACTERS = 200_000;

export const RESEARCH_COMPACTION_INSTRUCTIONS = [
  "Preserve Pi's native structured compaction format and file-operation tracking.",
  "Inside the summary, always emit these exact third-level headings in this order: ### [FINDINGS], ### [HYPOTHESES], ### [CONFLICTS], ### [OPERATIONS], ### [DECISIONS], and ### [OPEN_LOOP]. They are independently auditable research-memory blocks.",
  "Keep the complete summary under 4500 tokens. Prefer source pointers and reproducible state over narrative detail.",
  "On recursive compaction, update blocks independently: merge duplicate findings, retire superseded operational detail, retain negative evidence and unresolved contradictions, and never turn a hypothesis into a finding without explicit evidence.",
  "Compress obsolete command output and incidental engineering detail aggressively, but retain filenames, artifact paths, configuration values, and failure signatures needed to reproduce or audit results.",
  "Do not infer, rewrite, or promote any Scientific Idea, P0, P1, route, hypothesis, or model suggestion to authoritative state. The Harness injects authoritative P0/P1 separately on every call.",
  "Distinguish facts, hypotheses, rejected routes, and unresolved claims. Preserve contradictions instead of reconciling them silently.",
].join("\n");

const BLOCK_KINDS = new Set(["FINDINGS", "HYPOTHESES", "CONFLICTS", "OPERATIONS", "DECISIONS", "OPEN_LOOP"]);

function lightweightTokenEstimate(text) {
  let dense = 0;
  let other = 0;
  for (const character of String(text ?? "")) {
    if (/[^\u0000-\u00ff]/u.test(character)) dense += 1;
    else other += 1;
  }
  return dense + Math.ceil(other / 4);
}

function stableHash(text) {
  return `sha256:${createHash("sha256").update(String(text ?? ""), "utf8").digest("hex")}`;
}

export function parseNativeCompactionBlocks(summary) {
  const text = String(summary ?? "").slice(0, NATIVE_COMPACTION_PARSE_MAX_CHARACTERS).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks = [];
  let active = null;
  const flush = () => {
    if (!active) return;
    const content = active.lines.join("\n").trim();
    blocks.push({
      kind: active.kind,
      title: active.kind,
      hash: stableHash(content),
      tokens: lightweightTokenEstimate(content),
      characters: content.length,
      empty: content.length === 0,
    });
    active = null;
  };
  for (const line of lines) {
    const match = line.match(/^###\s+\[([A-Z_]+)\]\s*$/u);
    if (match && BLOCK_KINDS.has(match[1])) {
      flush();
      active = { kind: match[1], lines: [] };
      continue;
    }
    if (active) active.lines.push(line);
  }
  flush();
  if (blocks.length) return blocks;
  return text.trim()
    ? [{
        kind: "LEGACY_SUMMARY",
        title: "LEGACY_SUMMARY",
        hash: stableHash(text.trim()),
        tokens: lightweightTokenEstimate(text.trim()),
        characters: text.trim().length,
        empty: false,
      }]
    : [];
}

export function nativeCompactionDecision(
  usage,
  {
    fraction = NATIVE_COMPACTION_FRACTION,
    minimumTokens = NATIVE_COMPACTION_MIN_TOKENS,
    minimumHeadroom = NATIVE_COMPACTION_MIN_HEADROOM,
  } = {},
) {
  const tokens = Number(usage?.tokens);
  const contextWindow = Number(usage?.contextWindow);
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { shouldCompact: false, tokens: null, contextWindow: null, threshold: null, reason: "usage_unavailable" };
  }
  const proportional = Math.floor(contextWindow * fraction);
  const headroomBound = Math.max(minimumTokens, contextWindow - minimumHeadroom);
  const threshold = Math.max(minimumTokens, Math.min(proportional, headroomBound));
  return {
    shouldCompact: tokens >= threshold,
    tokens,
    contextWindow,
    threshold,
    reason: tokens >= threshold ? "soft_threshold" : "below_soft_threshold",
  };
}

export function hasExplicitSessionIntent(argv = process.argv.slice(2)) {
  const exactFlags = new Set(["--resume", "-r", "--continue", "-c", "--fork", "--no-session"]);
  return argv.some((arg) => (
    exactFlags.has(arg)
    || arg === "--session"
    || arg === "--session-id"
    || arg.startsWith("--session=")
    || arg.startsWith("--session-id=")
  ));
}
import { createHash } from "node:crypto";
