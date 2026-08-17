import { randomUUID } from "node:crypto";

import { canonicalJson } from "./state-store.js";
import { sha256 } from "./idea-document.js";

const CJK_OR_DENSE_SYMBOL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;

// The marker is deliberately appended after P0/P1 so the confirmed P0 remains
// the byte-identical prefix. It lets us replace an older packet without
// depending on any user-facing P0 headings or wording.
export const CONTEXT_PACKET_MARKER = "\n\n<!-- pi-idea-harness:context-packet -->";

export class ContextBudgetError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ContextBudgetError";
    this.code = "PROTECTED_CONTEXT_OVER_BUDGET";
    this.details = details;
  }
}

export function estimateTextTokens(text) {
  if (!text) return 0;
  let dense = 0;
  let other = 0;
  for (const character of String(text)) {
    if (CJK_OR_DENSE_SYMBOL.test(character)) dense += 1;
    else other += 1;
  }
  return dense + Math.ceil(other / 4);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block?.type === "text") return block.text ?? "";
    if (block?.type === "thinking") return block.thinking ?? "";
    if (block?.type === "toolCall") return `${block.name ?? ""}${safeStringify(block.arguments ?? {})}`;
    if (block?.type === "image") return "x".repeat(4800);
    return "";
  }).join("");
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;
  if (message.role === "bashExecution") {
    return estimateTextTokens(`${message.command ?? ""}${message.output ?? ""}`);
  }
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return estimateTextTokens(message.summary ?? message.content ?? "");
  }
  return estimateTextTokens(textFromContent(message.content));
}

export function estimateMessagesTokens(messages) {
  return Array.isArray(messages) ? messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) : 0;
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, child) => {
      if (typeof child === "function") return `[function:${child.name || "anonymous"}]`;
      if (typeof child === "bigint") return child.toString();
      if (child && typeof child === "object") {
        if (seen.has(child)) return "[circular]";
        seen.add(child);
      }
      return child;
    }) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function isPreviousHarnessPacket(message) {
  return message?.role === "user" && message?.timestamp === 0 && typeof message.content === "string"
    && (
      message.content.endsWith(CONTEXT_PACKET_MARKER)
      // Compatibility with packets emitted by the original structured-P0 V0.
      || message.content.startsWith("科学对象：\n")
    );
}

function makePacketId(fingerprint) {
  return `ctx-${sha256(fingerprint).slice("sha256:".length, "sha256:".length + 16)}`;
}

export class ContextCompiler {
  constructor(store) {
    this.store = store;
    this.generation = 0;
    this.lastFingerprint = null;
    this.lastPacketId = null;
    this.lastInvalidationReason = "startup";
  }

  invalidate(reason = "substantive-event") {
    this.generation += 1;
    this.lastFingerprint = null;
    this.lastPacketId = null;
    this.lastInvalidationReason = reason;
  }

  emergencyProtectedMessage() {
    const current = this.store.getCurrentIdea();
    if (!current) return null;
    return { role: "user", content: current.content, timestamp: 0 };
  }

  compile({
    messages = [],
    contextWindow = 128_000,
    modelMaxTokens = 16_384,
    outputReserveTokens,
    systemPrompt = "",
    toolDefinitions = [],
    safetyMarginTokens = 4_096,
  } = {}) {
    this.store.assertIntegrity();
    const idea = this.store.getCurrentIdea();
    const p1 = this.store.getCurrentP1();
    const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 128_000;
    const defaultOutputReserve = Math.min(
      16_384,
      Number.isFinite(modelMaxTokens) && modelMaxTokens > 0 ? Math.floor(modelMaxTokens) : 16_384,
    );
    const outputReserve = Number.isFinite(outputReserveTokens) && outputReserveTokens >= 0
      ? Math.floor(outputReserveTokens)
      : defaultOutputReserve;
    const systemTokens = estimateTextTokens(systemPrompt);
    const toolTokens = estimateTextTokens(safeStringify(toolDefinitions));
    const safetyMargin = Number.isFinite(safetyMarginTokens) && safetyMarginTokens >= 0
      ? Math.floor(safetyMarginTokens)
      : 4_096;
    const effectiveInput = Math.max(0, normalizedWindow - outputReserve - systemTokens - toolTokens - safetyMargin);

    const p0Tokens = estimateTextTokens(idea.content);
    const p1Segment = p1.content ? `\n当前阶段最小工作集（P1）：\n${p1.content}` : "";
    const p1Tokens = estimateTextTokens(p1Segment);
    const p0Ceiling = Math.min(1_200, Math.floor(effectiveInput * 0.02));
    const combinedCeiling = Math.floor(effectiveInput * 0.05);
    const p1Ceiling = Math.max(0, Math.min(4_000, combinedCeiling - p0Tokens));
    const budgetDetails = {
      contextWindow: normalizedWindow,
      outputReserve,
      systemTokens,
      toolTokens,
      safetyMargin,
      effectiveInput,
      p0Ceiling,
      p1Ceiling,
      combinedCeiling,
      actualP0: p0Tokens,
      actualP1: p1Tokens,
    };

    if (p0Tokens > p0Ceiling) {
      throw new ContextBudgetError(
        `P0 为 ${p0Tokens} tokens，超过当前硬上限 ${p0Ceiling}；没有自动压缩`,
        budgetDetails,
      );
    }
    if (p1Tokens > p1Ceiling || p0Tokens + p1Tokens > combinedCeiling) {
      throw new ContextBudgetError(
        `P0+P1 为 ${p0Tokens + p1Tokens} tokens，超过当前 1/20 上限 ${combinedCeiling}；没有自动截断`,
        budgetDetails,
      );
    }

    const protectedContent = `${idea.content}${p1Segment}`;
    const controlTokens = estimateTextTokens(CONTEXT_PACKET_MARKER);
    const packetContent = `${protectedContent}${CONTEXT_PACKET_MARKER}`;
    const packetHash = sha256(packetContent);
    const fingerprint = canonicalJson({
      generation: this.generation,
      ideaHash: idea.hash,
      p1Hash: p1.hash,
      packetHash,
      budget: budgetDetails,
    });
    const reused = fingerprint === this.lastFingerprint;
    const packetId = reused && this.lastPacketId ? this.lastPacketId : makePacketId(fingerprint);
    this.lastFingerprint = fingerprint;
    this.lastPacketId = packetId;

    const withoutOldPacket = messages.filter((message) => !isPreviousHarnessPacket(message));
    // Pi's native compaction entry is now the only history summary source.
    // Luna snapshots may remain in the state store for audit, but are never
    // injected or allowed to replace session history.
    const dynamicMessages = withoutOldPacket;
    const packetMessage = { role: "user", content: packetContent, timestamp: 0 };
    const injectedMessages = [packetMessage, ...dynamicMessages];
    const dynamicTokens = estimateMessagesTokens(dynamicMessages);
    const invocationId = randomUUID();
    const createdAt = new Date().toISOString();
    const manifest = {
      invocationId,
      packetId,
      reused,
      invalidationReason: reused ? null : this.lastInvalidationReason,
      ideaId: this.store.getIdeaId(),
      ideaVersion: idea.version,
      ideaHash: idea.hash,
      p0Hash: idea.hash,
      p1Version: p1.version,
      p1Hash: p1.hash,
      packetHash,
      actualContextHash: sha256(canonicalJson(injectedMessages)),
      tokens: {
        p0: p0Tokens,
        p1: p1Tokens,
        luna: 0,
        control: controlTokens,
        dynamic: dynamicTokens,
        protectedTotal: p0Tokens + p1Tokens,
        packetTotal: p0Tokens + p1Tokens + controlTokens,
        dynamicBeforeLuna: dynamicTokens,
        removedByLuna: 0,
      },
      budget: budgetDetails,
      sources: [
        { tier: "P0", source: "IDEA.md", hash: idea.hash, tokens: p0Tokens, reason: "protected_exact" },
        ...(p1.content
          ? [{ tier: "P1", source: ".harness/P1.md", hash: p1.hash, tokens: p1Tokens, reason: "protected_stage_set" }]
          : []),
        {
          tier: "control",
          source: "pi-idea-harness:packet-marker",
          hash: sha256(CONTEXT_PACKET_MARKER),
          tokens: controlTokens,
          reason: "deduplicate_previous_packet",
        },
        {
          tier: "P2-P4",
          source: "pi:active-session-branch",
          hash: sha256(canonicalJson(dynamicMessages)),
          tokens: dynamicTokens,
          reason: "native_pi_context_with_recursive_compaction",
        },
      ],
      excluded: [
        { source: "luna:snapshots", reason: "disabled_in_favor_of_pi_native_compaction" },
        {
          source: "retrieved-history/obelisk",
          reason: "not_enabled_in_v0.1",
        },
      ],
      createdAt,
    };
    this.store.saveContextManifest(manifest);
    return { messages: injectedMessages, manifest, packetMessage };
  }
}
