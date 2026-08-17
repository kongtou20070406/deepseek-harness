import { sha256, estimateTokens } from "./core.js";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (part?.type === "text") return [part.text || ""];
    if (part?.type === "toolCall") return [`TOOL ${part.name || "unknown"} ${JSON.stringify(part.arguments || {})}`];
    if (part?.type === "thinking") return [];
    return [];
  }).join("\n");
}

const FACT_EVENT_TYPES = new Set(["user", "assistant_public", "final", "tool_result"]);

function eventTypeFor(message) {
  const explicit = String(message?.eventType || message?.type || "").toLowerCase();
  if (["user", "assistant_public", "reasoning_summary", "tool_call", "tool_result", "final", "derived_summary", "tag"].includes(explicit)) return explicit;
  const role = String(message?.role || "unknown");
  if (role === "user") return "user";
  if (role === "toolResult" || role === "bashExecution") return "tool_result";
  if (role === "custom") return /tag/i.test(String(message?.customType || "")) ? "tag" : "derived_summary";
  if (role === "assistant") return /^(stop|length|end_turn|completed)$/i.test(String(message?.stopReason || "")) ? "final" : "assistant_public";
  return "derived_summary";
}

function messageEvents(message, messageIndex) {
  const base = {
    role: String(message?.role || "unknown"),
    parentId: message?.parentId || null,
    sessionId: message?.sessionId || message?.session || null,
    branchId: message?.branchId || message?.branch || null,
    timestamp: message?.timestamp ?? null,
    messageIndex,
  };
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    return message.content.flatMap((part, partIndex) => {
      const raw = part?.type === "text" ? String(part.text || "")
        : part?.type === "thinking" ? String(part.thinking || part.text || "")
          : part?.type === "toolCall" ? JSON.stringify(part.arguments || {}) : "";
      if (!raw) return [];
      const eventType = part.type === "thinking" ? "reasoning_summary"
        : part.type === "toolCall" ? "tool_call"
          : (/^(stop|length|end_turn|completed)$/i.test(String(message?.stopReason || "")) ? "final" : "assistant_public");
      return [{
        ...base,
        eventType,
        callId: part?.id || part?.toolCallId || null,
        source: part?.type === "toolCall" ? String(part.name || "tool") : "assistant",
        raw,
        rawHash: sha256(raw),
        partIndex,
        factCandidate: FACT_EVENT_TYPES.has(eventType),
      }];
    });
  }
  const raw = serializeMessage(message);
  if (!raw.trim()) return [];
  const eventType = eventTypeFor(message);
  return [{
    ...base,
    eventType,
    callId: message?.toolCallId || message?.callId || null,
    source: message?.toolName || message?.source || base.role,
    raw,
    rawHash: sha256(raw),
    partIndex: 0,
    factCandidate: FACT_EVENT_TYPES.has(eventType),
  }];
}

export function serializeMessage(message) {
  const role = String(message?.role || "unknown");
  if (role === "toolResult") {
    return `TOOL_RESULT ${message.toolName || "unknown"}\n${contentText(message.content)}`;
  }
  if (role === "bashExecution") return `BASH\n${message.command || ""}\n${message.output || ""}`;
  return `${role.toUpperCase()}\n${contentText(message?.content)}`;
}

export function groupTurns(messages) {
  const blocks = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const text = current.map(serializeMessage).filter(Boolean).join("\n\n");
    if (text.trim()) {
      blocks.push({
        id: sha256(text),
        messages: current,
        text,
        tokens: estimateTokens(text),
        events: current.flatMap(messageEvents),
      });
    }
    current = [];
  };

  for (const message of messages || []) {
    if (message?.role === "custom" && message?.customType === "idea-anchor-v1") continue;
    if (message?.role === "user" && current.length) flush();
    current.push(message);
  }
  flush();
  return blocks;
}

/** Pack stable turns into immutable fold units. A unit is always summarized from raw
 * messages, never from another summary. */
export function makeFoldUnits(blocks, { minTokens = 4800, maxTokens = 7200 } = {}) {
  const units = [];
  let pending = [];
  let tokens = 0;
  const flush = () => {
    if (!pending.length) return;
    const text = pending.map((block) => block.text).join("\n\n--- TURN ---\n\n");
    units.push({
      id: sha256(pending.map((block) => block.id).join("|")),
      blockIds: pending.map((block) => block.id),
      messages: pending.flatMap((block) => block.messages),
      events: pending.flatMap((block) => block.events || []),
      text,
      tokens,
      stable: tokens >= minTokens,
    });
    pending = [];
    tokens = 0;
  };

  for (const block of blocks) {
    if (pending.length && tokens + block.tokens > maxTokens) flush();
    pending.push(block);
    tokens += block.tokens;
    if (tokens >= minTokens) flush();
  }
  flush();
  return units;
}

function terms(text) {
  const value = String(text || "").toLowerCase();
  const latin = value.match(/[a-z0-9_./:-]{2,}/g) || [];
  const cjkRuns = value.match(/[\u3400-\u9fff]{2,}/g) || [];
  const cjk = cjkRuns.flatMap((run) => {
    const result = [];
    for (let i = 0; i < run.length - 1; i += 1) result.push(run.slice(i, i + 2));
    return result;
  });
  return new Set([...latin, ...cjk]);
}

const CLAIM_KINDS = new Set(["decision", "constraint", "observation", "conflict", "rejection", "proposal", "result", "failure", "unresolved", "other"]);
const CLAIM_AUTHORITIES = new Set(["user", "experiment", "tool", "model", "unknown"]);
const CLAIM_STATUSES = new Set(["active", "rejected", "superseded", "unresolved", "candidate", "unknown"]);
const LINK_TYPES = new Set(["supports", "contradicts", "supersedes", "about_version"]);
const ROUTINE_CLAIM = /(例行检查|未产生新的(?:方向性结论|实验结果|用户决定)|没有新的方向性结论|(?:未发现|没有发现).*(?:改变|会改变).*新证据|未改变.*(?:目标|约束|路线)|结果与上次相同|无新增(?:事项|记录))/i;
const ROUTINE_PASSAGE = /(例行检查|阶段记录.*继续核对|普通格式检查|重复路径|中间产物|缓存索引正常|不构成科学证据|没有新的方向性结论|没有发现会改变当前假设|没有产生新的实验结果或用户决定|结果与上次相同|枚举工作区文件|记录结束：?\s*LOG_|只影响.*不改变.*科学判断|与当前.*无关|不是研究对象的机制证据|没有测量目标任务)/i;
const DURABLE_PASSAGE = /(用户.{0,12}(?:确认|明确|要求|否决|禁止|授权|权威|批准)|实验|测试|观测|复现|复算|结果|失败|错误|冲突|反例|根因|证明|证据|尚未|未解决|只能|不得|不能|禁止|上限|参数|配置|假设|机制|性能|精度|等价|范围|权威|作废|冻结|批准|对应|映射|别名|归一化|NaN|消失|恢复|降低|增加|user.{0,16}(?:confirm|approve|reject|forbid)|experiment|test|result|observ|fail|error|conflict|counterexample|root cause|must|only|rejected|supersed|revok|remain|unapproved|validation split|dataset split)/i;
const QUERY_GLOSSARY = [
  [/(?:随机)?种子|seed/i, "seed 随机种子"],
  [/数据切分|验证集|validation split|dataset split/i, "数据切分 验证集 validation split dataset split"],
  [/批准|授权|approved|authorized|unapproved/i, "批准 授权 未批准 approved authorized unapproved"],
  [/旧运行|历史运行|old run|run\s+[a-z0-9_-]+/i, "旧运行 历史运行 old run"],
  [/边界|boundary/i, "边界 boundary"],
  [/遮罩|mask/i, "遮罩 mask"],
  [/复现|reproduc/i, "复现 reproducibility reproducible"],
  [/精度|precision|float|bf16/i, "精度 precision float bf16"],
  [/稳定|stability|nan/i, "稳定 stability NaN"],
  [/配置|config/i, "配置 config"],
  [/根因|root cause/i, "根因 root cause"],
];

function normalizeLoopSignals(value = {}) {
  const list = (input, limit = 12) => [...new Set((Array.isArray(input) ? input : (input == null ? [] : [input]))
    .map((item) => String(item).trim().slice(0, 120)).filter(Boolean))].slice(0, limit);
  return {
    phase: String(value?.phase || "").trim().slice(0, 80),
    lastEventType: String(value?.lastEventType || "").trim().slice(0, 80),
    lastToolType: String(value?.lastToolType || "").trim().slice(0, 80),
    freshEvidenceIds: list(value?.freshEvidenceIds),
    freshResultStatus: list(value?.freshResultStatus, 6),
    previousRequestedAction: String(value?.previousRequestedAction || "").trim().slice(0, 240),
  };
}

function retrievalQuery(prompt, stage, loopSignals) {
  const signals = normalizeLoopSignals(loopSignals);
  return [
    prompt,
    stage,
    signals.phase,
    signals.lastEventType,
    signals.lastToolType,
    signals.freshEvidenceIds.join(" "),
    signals.freshResultStatus.join(" "),
    signals.previousRequestedAction,
  ].filter(Boolean).join("\n");
}

function selectionAudit(passages) {
  const count = (field) => passages.reduce((result, item) => {
    const key = item[field] || "unknown";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  return { candidateSources: count("candidateSource"), selectionReasons: count("selectionReason") };
}

function exactRawQuote(raw, proposed) {
  const source = String(raw || "");
  const quote = String(proposed || "").trim();
  if (!quote) return null;
  const direct = source.indexOf(quote);
  if (direct >= 0) return source.slice(direct, direct + quote.length);
  const compactQuote = quote.replace(/\s+/gu, "");
  if (!compactQuote) return null;
  let compactRaw = "";
  const positions = [];
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/u.test(source[index])) continue;
    positions.push(index);
    compactRaw += source[index];
  }
  const compactIndex = compactRaw.indexOf(compactQuote);
  if (compactIndex < 0) return null;
  const start = positions[compactIndex];
  const end = positions[compactIndex + compactQuote.length - 1] + 1;
  return source.slice(start, end);
}

function groundedEventQuote(unit, proposed) {
  for (const event of unit?.events || []) {
    if (!event.factCandidate) continue;
    const quote = exactRawQuote(event.raw, proposed);
    if (quote) return { quote, event };
  }
  // Compatibility for callers constructing legacy units by hand. Normal fold
  // units always carry events, so production never indexes reasoning/derived or
  // tool-call text through this branch.
  if (!Array.isArray(unit?.events)) {
    const quote = exactRawQuote(unit?.text, proposed);
    if (quote) return { quote, event: null };
  }
  return null;
}

function memoryProvenance(raw, quote) {
  const source = String(raw || "");
  const position = Math.max(0, source.indexOf(String(quote || "")));
  const prefix = source.slice(0, position);
  const matches = [...prefix.matchAll(/\[memory_session\s+id=([^\s\]]+)\s+date=(.*?)\s+turn=\d+\]/g)];
  const last = matches.at(-1);
  return last ? { memorySessionId: last[1], memoryDate: last[2].trim() } : { memorySessionId: null, memoryDate: null };
}

function jsonObject(text) {
  const value = String(text || "").trim();
  try { return JSON.parse(value); } catch { /* try fenced/model-prefixed output */ }
  const candidate = value.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

export function isRoutineEvidence(claim) {
  return ROUTINE_CLAIM.test(`${claim?.claim || ""}\n${claim?.quote || ""}`);
}

function retrievalLabels(value, { limit, length = 120 }) {
  const rows = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return [...new Set(rows.map((item) => String(item).trim().slice(0, length)).filter(Boolean))].slice(0, limit);
}

/** Validate model-generated labels against their immutable raw source. Invalid
 * quotes are discarded, so a label can never become an ungrounded fact. */
export function parseEvidenceTags(text, unit, { ideaHash = null, stageHash = null } = {}) {
  const parsed = jsonObject(text);
  const incoming = Array.isArray(parsed?.claims) ? parsed.claims.slice(0, 12) : [];
  const claims = [];
  let rejected = 0;
  for (const item of incoming) {
    const claim = String(item?.claim || "").trim().slice(0, 600);
    const grounded = groundedEventQuote(unit, item?.quote);
    const quote = grounded?.quote || null;
    if (!claim || !quote) {
      rejected += 1;
      continue;
    }
    const kind = CLAIM_KINDS.has(item.kind) ? item.kind : "other";
    const authority = CLAIM_AUTHORITIES.has(item.authority) ? item.authority : "unknown";
    const status = CLAIM_STATUSES.has(item.status) ? item.status : "unknown";
    const entities = Array.isArray(item.entities)
      ? [...new Set(item.entities.map((value) => String(value).trim()).filter(Boolean))].slice(0, 12)
      : [];
    // Cues are retrieval-only derived metadata. They need not be verbatim and
    // are never injected as facts; online indexes may retain only their opaque
    // feature hashes. The grounded quote remains the authority boundary.
    const retrievalCues = retrievalLabels(item.retrievalCues, { limit: 8, length: 180 });
    // Contextual-intent labels are retrieval-only. They describe where a fact
    // is useful, not whether it is true, and therefore never enter the evidence
    // text shown to the answer model.
    const thematicScopes = retrievalLabels(item.thematicScopes ?? item.thematicScope, { limit: 4 });
    const eventTypes = retrievalLabels(item.eventTypes ?? item.eventType, { limit: 6, length: 80 });
    const entityRoles = retrievalLabels(item.entityRoles, { limit: 12 });
    const links = Array.isArray(item.links)
      ? item.links.flatMap((link) => LINK_TYPES.has(link?.type) && link?.target
        ? [{ type: link.type, target: String(link.target).slice(0, 160) }]
        : []).slice(0, 12)
      : [];
    const evidenceId = typeof item.evidenceId === "string"
      && unit.text.includes(`[EVIDENCE id=${item.evidenceId}]`)
      ? item.evidenceId
      : null;
    const claimId = sha256(`${unit.id}\0${quote}\0${claim}`);
    const provenance = memoryProvenance(unit.text, quote);
    claims.push({
      claimId,
      evidenceId,
      sourceUnitId: unit.id,
      sourceBlockIds: unit.blockIds,
      sourceEventType: grounded?.event?.eventType || null,
      sourceEventRawHash: grounded?.event?.rawHash || null,
      sourceParentId: grounded?.event?.parentId || null,
      sourceCallId: grounded?.event?.callId || null,
      sourceSessionId: grounded?.event?.sessionId || null,
      sourceBranchId: grounded?.event?.branchId || null,
      sourceTimestamp: grounded?.event?.timestamp ?? null,
      source: grounded?.event?.source || null,
      rawHash: sha256(unit.text),
      quoteHash: sha256(quote),
      claim,
      quote,
      ...provenance,
      kind,
      authority,
      status,
      entities,
      retrievalCues,
      thematicScopes,
      eventTypes,
      entityRoles,
      links,
      ideaHash,
      stageHash,
      tokens: estimateTokens(`${claim}\n${quote}\n${entities.join(" ")}`),
    });
  }
  return { claims, rejected, valid: Boolean(parsed && Array.isArray(parsed.claims)) };
}

export function evidenceTagPrompt(unit, { ideaHash = "none", stageHash = "none" } = {}) {
  return `你是后台证据索引器，不回答科研问题，也不决定路线。只从已完成的原始工作块抽取会影响未来工作的事实。\n\n` +
    `规则：\n` +
    `- 只收录会影响未来任务或回答的具体信息：用户决定、约束、否决、事实与偏好、助理曾提供的信息、时间关系、实验观测/结果、失败、未解决冲突、权限和待决事项；删除寒暄、重复日志及“没有新结论”类过程记录。\n` +
    `- quote 必须逐字来自 raw_block；claim 可以简洁转述，但不得补充原文没有的判断。\n` +
    `- 不得修改 Scientific Idea，不得自动解决冲突或把模型建议升级为用户确认。\n` +
    `- kind 只能是 decision|constraint|observation|conflict|rejection|proposal|result|failure|unresolved|other。\n` +
    `- authority 只能是 user|experiment|tool|model|unknown；status 只能是 active|rejected|superseded|unresolved|candidate|unknown。\n` +
    `- links 可选，只能使用 supports|contradicts|supersedes|about_version，并以原文标识符或简短对象为 target。\n` +
    `- retrievalCues 是仅用于检索的未来触发表达，不是事实，也不会注入主模型。为偏好、隐含约束、别名或跨措辞需求给出 0–8 条简短 cue；尽量使用未来用户可能真正说出的不同词汇，不要复述 claim。\n` +
    `- thematicScopes/eventTypes/entityRoles 同样仅用于检索：分别指出该事实服务的目标或阶段、发生的动作类型、实体在该任务中的角色。保持短小、领域自然；不确定就给空数组，不得用这些字段断言真伪。\n` +
    `- 最多 12 条；没有可复用事实时输出空数组。\n` +
    `只输出 JSON：{"claims":[{"evidenceId":null,"claim":"...","quote":"...","kind":"observation","authority":"experiment","status":"active","entities":["..."],"retrievalCues":["future query phrasing"],"thematicScopes":["goal or stage"],"eventTypes":["decision or revision"],"entityRoles":["metric","configuration"],"links":[{"type":"supports","target":"..."}]}]}。\n\n` +
    `Idea identity: ${ideaHash}\nStage identity: ${stageHash}\nRaw block: ${unit.id}\n\n<raw_block>\n${unit.text}\n</raw_block>`;
}

export function relevanceScores(candidates, query) {
  const queryTerms = terms(query);
  if (!queryTerms.size) return candidates.map(() => 0);
  const docs = candidates.map((item) => terms(`${item.summary || ""}\n${item.text || ""}`));
  const documentFrequency = new Map();
  for (const doc of docs) {
    for (const term of doc) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  return docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      if (!doc.has(term)) continue;
      score += Math.log(1 + candidates.length / (documentFrequency.get(term) || 1));
    }
    return score;
  });
}

function localRawPassages(candidates) {
  const passages = [];
  const seen = new Set();
  for (const unit of candidates) {
    const events = (unit.events || []).filter((event) => event.factCandidate);
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      const serialized = event.raw;
      const role = event.role;
      const segments = serialized.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/gu) || [];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const quote = segment.trim();
        // Index every non-routine raw clause. DURABLE_PASSAGE is a ranking
        // signal, not a gate: an unfamiliar scientific term or plain factual
        // sentence must remain retrievable without matching a hand-built list.
        if (quote.length < 8 || ROUTINE_PASSAGE.test(quote)) continue;
        for (let offset = 0; offset < quote.length; offset += 480) {
          const rawQuote = quote.slice(offset, offset + 560).trim();
          if (rawQuote.length < 8 || seen.has(rawQuote)) continue;
          seen.add(rawQuote);
          const provenance = memoryProvenance(serialized, rawQuote);
          const evidenceId = rawQuote.match(/\[EVIDENCE\s+id=([^\]\s]+)\]/i)?.[1] || null;
          passages.push({
            passageId: sha256(`${unit.id}\0${role}\0${rawQuote}`),
            evidenceId,
            sourceUnitId: unit.id,
            sourceBlockIds: unit.blockIds,
            rawHash: sha256(unit.text),
            quoteHash: sha256(rawQuote),
            quote: rawQuote,
            ...provenance,
            role,
            eventType: event.eventType,
            parentId: event.parentId,
            callId: event.callId,
            sessionId: event.sessionId,
            branchId: event.branchId,
            timestamp: event.timestamp,
            source: event.source,
            eventRawHash: event.rawHash,
            evidenceClass: event.eventType === "user" ? "user-raw"
              : event.eventType === "tool_result" ? "tool-raw"
                : "assistant-historical",
            messageKey: `${unit.id}:${event.messageIndex}:${event.partIndex}`,
            segmentIndex,
            unit,
            order: passages.length,
            tokens: estimateTokens(rawQuote),
          });
        }
      }
    }
  }
  return passages;
}

function localPassageScores(passages, { stage, prompt, loopSignals }) {
  // P0 is an immutable prompt anchor, not retrieval material. Selection may
  // depend only on the current user request and the explicitly selected stage.
  const rawQuery = retrievalQuery(prompt, stage, loopSignals);
  const glossary = QUERY_GLOSSARY.filter(([pattern]) => pattern.test(rawQuery)).map(([, expansion]) => expansion).join(" ");
  const queryParts = [
    [terms(`${prompt}\n${glossary}`), 4],
    [terms(stage), 2],
  ];
  const docs = passages.map((passage) => terms(passage.quote));
  const documentFrequency = new Map();
  for (const doc of docs) for (const term of doc) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  const exactNeedles = rawQuery.match(/[A-Za-z][A-Za-z0-9_.-]{2,}|\d+(?:\.\d+)?%?/g) || [];
  return passages.map((passage, index) => {
    let score = 0;
    for (const [queryTerms, weight] of queryParts) {
      for (const term of queryTerms) {
        if (!docs[index].has(term)) continue;
        score += weight * Math.log(1 + passages.length / (documentFrequency.get(term) || 1));
      }
    }
    for (const needle of exactNeedles) if (passage.quote.toLowerCase().includes(needle.toLowerCase())) score += 3;
    if (/(用户.{0,8}(?:确认|明确|要求|否决|禁止|授权)|最后确认)/i.test(passage.quote)) score += 3;
    if (/(权威|作废|唯一批准|user.{0,16}(?:approved|confirmed)|revok|supersed)/i.test(passage.quote)) score += 2;
    if (/(冲突|反例|否定|失败|根因|复现|证明|尚未|未解决)/i.test(passage.quote)) score += 1.5;
    if (DURABLE_PASSAGE.test(passage.quote)) score += 0.75;
    if (/(草案|候选|旧配置|未获确认|从未被用户确认|过期)/i.test(passage.quote)) score -= 0.5;
    // Assistant text is retained as historical judgment for dialogue-memory
    // tasks, never promoted to user/tool evidence. Prefer primary raw sources
    // whenever retrieval scores are otherwise close.
    if (passage.evidenceClass === "assistant-historical") score *= 0.7;
    score += passages.length ? (index / passages.length) * 0.15 : 0;
    return score;
  });
}

function localEvidenceMessage(passages) {
  if (!passages.length) return null;
  const body = passages.map((item) => {
    const id = item.evidenceId || item.passageId;
    const temporal = item.memorySessionId
      ? ` memory_session=${item.memorySessionId} memory_date=${JSON.stringify(item.memoryDate || "")}`
      : "";
    return `[local_evidence id=${id} source=${item.sourceUnitId} role=${item.role} evidence_class=${item.evidenceClass || "unknown"}${temporal} quote_hash=${item.quoteHash}]\n${item.quote}`;
  }).join("\n\n");
  return {
    role: "custom",
    customType: "idea-local-evidence-v1",
    content: `<local_evidence_index authority="raw-excerpt" count="${passages.length}">\n${body}\n</local_evidence_index>`,
    display: false,
    timestamp: 0,
  };
}

function compileLocalEvidenceIndex({ candidates, prompt, stage, loopSignals, activeMessages, activeTokens, turns, retrievalBudget, maxRetrievedUnits }) {
  const passages = localRawPassages(candidates);
  const scores = localPassageScores(passages, { stage, prompt, loopSignals });
  const ranked = passages.map((passage, index) => ({ ...passage, score: scores[index] }))
    .filter((passage) => passage.score > 0)
    .sort((a, b) => b.score - a.score || b.order - a.order);
  const maxScore = ranked[0]?.score || 0;
  const selectedPassages = [];
  const coveredUnits = new Set();
  let used = 0;
  let dedupedPassageCount = 0;
  const hardLimit = Math.max(4, Math.min(10, maxRetrievedUnits));
  const seedLimit = Math.max(3, hardLimit - 2);
  for (const passage of ranked) {
    if (selectedPassages.length >= seedLimit) break;
    // Sparse local passages are cheap. A permissive floor preserves a second
    // constraint/contradiction whose vocabulary may differ from the question;
    // the hard item/token caps still bound context size.
    if (maxScore > 0 && passage.score < maxScore * 0.05) continue;
    if (quoteAlreadyCovered(passage, selectedPassages)) {
      dedupedPassageCount += 1;
      continue;
    }
    if (used + passage.tokens > retrievalBudget) continue;
    selectedPassages.push({ ...passage, selectionSource: "local", candidateSource: "local-lexical", selectionReason: "query-score" });
    coveredUnits.add(passage.sourceUnitId);
    used += passage.tokens;
  }
  // Expand only along deterministic local relations: adjacent clauses from the
  // same raw message, then shared rare identifiers (e.g. an alias such as G3).
  // This recovers multi-clause and alias→result evidence without a model call.
  const identifierStop = new Set(["user", "assistant", "tool", "result", "current", "stage", "test", "run", "only"]);
  const anchors = new Set(selectedPassages.flatMap((passage) => passage.quote.match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) || [])
    .map((value) => value.toLowerCase()).filter((value) => !identifierStop.has(value) && value.length <= 48));
  const expansions = passages.map((passage) => {
    if (selectedPassages.some((item) => item.passageId === passage.passageId)) return null;
    const adjacent = selectedPassages.some((item) => item.messageKey === passage.messageKey && Math.abs(item.segmentIndex - passage.segmentIndex) <= 1);
    const identifiers = (passage.quote.match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) || []).map((value) => value.toLowerCase());
    const linked = identifiers.some((value) => anchors.has(value));
    if (!adjacent && !linked) return null;
    return { ...passage, score: (adjacent ? 2 : 0) + (linked ? 1 : 0) };
  }).filter(Boolean).sort((a, b) => b.score - a.score || b.order - a.order);
  for (const passage of expansions) {
    if (selectedPassages.length >= hardLimit || used + passage.tokens > retrievalBudget) break;
    if (quoteAlreadyCovered(passage, selectedPassages)) {
      dedupedPassageCount += 1;
      continue;
    }
    selectedPassages.push({
      ...passage,
      selectionSource: "local",
      candidateSource: "local-relation",
      selectionReason: passage.score >= 3 ? "adjacent-and-shared-identifier" : passage.score >= 2 ? "adjacent-clause" : "shared-identifier",
    });
    coveredUnits.add(passage.sourceUnitId);
    used += passage.tokens;
  }
  selectedPassages.sort((a, b) => a.order - b.order);
  const assembled = localEvidenceMessage(selectedPassages);
  const rawTokens = turns.reduce((sum, turn) => sum + turn.tokens, 0);
  return {
    messages: [assembled, ...activeMessages].filter(Boolean),
    coldUnits: candidates,
    selected: candidates.filter((unit) => coveredUnits.has(unit.id)),
    selectedPassages,
    selectedClaims: [],
    omitted: candidates.filter((unit) => !coveredUnits.has(unit.id)),
    metrics: {
      mode: "local-raw-passage-index",
      rawTokens,
      compiledTokens: activeTokens + used,
      liveTokens: activeTokens,
      retrievedTokens: used,
      localTokens: used,
      enhancementTokens: 0,
      dedupedPassageCount,
      ...selectionAudit(selectedPassages),
      retrievalSignals: normalizeLoopSignals(loopSignals),
      retrievalQueryHash: sha256(retrievalQuery(prompt, stage, loopSignals)),
      indexedPassageCount: passages.length,
      selectedPassageCount: selectedPassages.length,
      pendingIndexCount: 0,
      indexComplete: true,
      selectionScore: maxScore,
      rawFallbackCount: 0,
      compressionRatio: rawTokens ? (activeTokens + used) / rawTokens : 1,
    },
  };
}

function foldedMessage(items) {
  if (!items.length) return null;
  const body = items.map((item) => {
    const text = item.injectText || item.summary || item.text;
    const mode = item.injectMode || (item.summary ? "summary" : "raw-fallback");
    return `[derived block=${item.id} mode=${mode} raw_hashes=${item.blockIds.join(",")}]\n${text}`;
  }).join("\n\n");
  return {
    role: "custom",
    customType: "idea-folded-context-v1",
    content: `<folded_context authority="derived" count="${items.length}">\n${body}\n</folded_context>`,
    display: false,
    timestamp: 0,
  };
}

function normalizedQuote(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function quoteAlreadyCovered(candidate, selected) {
  const candidateText = normalizedQuote(candidate?.quote);
  if (!candidateText) return false;
  return selected.some((item) => {
    if (candidate.quoteHash && item.quoteHash === candidate.quoteHash) return true;
    const selectedText = normalizedQuote(item?.quote);
    // This is deliberately exact textual coverage, not semantic/fuzzy
    // deduplication. Labels may rank evidence but may not rewrite or merge it.
    return Boolean(selectedText && (selectedText.includes(candidateText) || candidateText.includes(selectedText)));
  });
}

function claimPassage(claim) {
  return {
    passageId: claim.claimId || sha256(`${claim.sourceUnitId}\0${claim.quote}`),
    evidenceId: claim.evidenceId || null,
    sourceUnitId: claim.sourceUnitId,
    sourceBlockIds: claim.sourceBlockIds || claim.unit?.blockIds || [],
    rawHash: claim.rawHash || sha256(claim.unit?.text || ""),
    quoteHash: claim.quoteHash || sha256(claim.quote),
    quote: claim.quote,
    memorySessionId: claim.memorySessionId || null,
    memoryDate: claim.memoryDate || null,
    eventType: claim.sourceEventType || null,
    eventRawHash: claim.sourceEventRawHash || null,
    parentId: claim.sourceParentId || null,
    callId: claim.sourceCallId || null,
    sessionId: claim.sourceSessionId || null,
    branchId: claim.sourceBranchId || null,
    timestamp: claim.sourceTimestamp ?? null,
    source: claim.source || null,
    evidenceClass: claim.sourceEventType === "user" ? "user-raw"
      : claim.sourceEventType === "tool_result" ? "tool-raw"
        : "assistant-historical",
    unit: claim.unit,
    order: claim.unit?.index ?? 0,
    tokens: estimateTokens(claim.quote),
    selectionSource: "luna",
    candidateSource: "luna-label",
    selectionReason: "label-rank-grounded-quote",
    rankScore: claim.score || 0,
  };
}

function evidenceMessage(passages, rawUnits) {
  if (!passages.length && !rawUnits.length) return null;
  const evidence = passages.map((item) => {
    const id = item.evidenceId || item.passageId;
    const temporal = item.memorySessionId
      ? ` memory_session=${item.memorySessionId} memory_date=${JSON.stringify(item.memoryDate || "")}`
      : "";
    // Only immutable raw excerpts cross the answer-model boundary. Model-made
    // claims, classifications, authorities, statuses, cues and scopes remain in
    // selectedClaims for internal audit/ranking and never appear in this text.
    return `[evidence_quote id=${id} source=${item.sourceUnitId} evidence_class=${item.evidenceClass || "unknown"}${temporal} quote_hash=${item.quoteHash}]\n${item.quote}`;
  });
  const raw = rawUnits.map((unit) => `[raw block=${unit.id} mode=${unit.injectMode || "raw-fallback"} raw_hashes=${unit.blockIds.join(",")}]\n${unit.text}`);
  return {
    role: "custom",
    customType: "idea-evidence-context-v1",
    content: `<assembled_evidence authority="raw-excerpt" quotes="${passages.length}" raw_blocks="${rawUnits.length}">\n${[...evidence, ...raw].join("\n\n")}\n</assembled_evidence>`,
    display: false,
    timestamp: 0,
  };
}

function compileEvidenceIndex({ candidates, prompt, stage, loopSignals, activeMessages, activeTokens, turns, retrievalBudget, maxRetrievedUnits, strictEvidenceIndex, excludedPassages = [] }) {
  const indexedClaims = candidates.flatMap((unit) => {
    const record = unit.record;
    if (!Array.isArray(record?.claims)) return [];
    return record.claims.filter((claim) => !isRoutineEvidence(claim)).flatMap((claim) => {
      // Re-ground cached/legacy records on every compile. Old schemas may omit
      // hashes or provenance, but a non-verbatim quote is never eligible.
      const eventGrounding = groundedEventQuote(unit, claim?.quote);
      const quote = eventGrounding?.quote;
      if (!quote) return [];
      const provenance = memoryProvenance(unit.text, quote);
      const grounded = {
        ...claim,
        claim: String(claim?.claim || ""),
        quote,
        claimId: claim?.claimId || sha256(`${unit.id}\0${quote}\0${claim?.claim || ""}`),
        sourceUnitId: unit.id,
        sourceBlockIds: unit.blockIds,
        sourceEventType: eventGrounding.event?.eventType || claim?.sourceEventType || null,
        sourceEventRawHash: eventGrounding.event?.rawHash || claim?.sourceEventRawHash || null,
        sourceParentId: eventGrounding.event?.parentId || claim?.sourceParentId || null,
        sourceCallId: eventGrounding.event?.callId || claim?.sourceCallId || null,
        sourceSessionId: eventGrounding.event?.sessionId || claim?.sourceSessionId || null,
        sourceBranchId: eventGrounding.event?.branchId || claim?.sourceBranchId || null,
        sourceTimestamp: eventGrounding.event?.timestamp ?? claim?.sourceTimestamp ?? null,
        source: eventGrounding.event?.source || claim?.source || null,
        rawHash: sha256(unit.text),
        quoteHash: sha256(quote),
        memorySessionId: claim?.memorySessionId || provenance.memorySessionId,
        memoryDate: claim?.memoryDate || provenance.memoryDate,
        unit,
      };
      grounded.summary = `${grounded.claim}\n${grounded.kind || ""}\n${grounded.authority || ""}\n${grounded.status || ""}\n${(grounded.entities || []).join(" ")}\n${(grounded.retrievalCues || []).join(" ")}\n${(grounded.thematicScopes || []).join(" ")}\n${(grounded.eventTypes || []).join(" ")}\n${(grounded.entityRoles || []).join(" ")}\n${grounded.quote}`;
      return [grounded];
    });
  });
  const query = retrievalQuery(prompt, stage, loopSignals);
  const scores = relevanceScores(indexedClaims, query);
  const ranked = indexedClaims.map((claim, index) => ({ ...claim, score: scores[index] }))
    .sort((a, b) => b.score - a.score || String(a.claimId).localeCompare(String(b.claimId)));
  const maxScore = ranked[0]?.score || 0;
  const selectedClaims = [];
  const selectedPassages = [];
  const selectedRaw = [];
  let used = 0;
  let rawUsed = 0;
  let enhancementUsed = 0;
  let dedupedPassageCount = 0;

  // In strict mode an unindexed stable block is never injected through this
  // label path. The dual-track caller immediately uses local raw retrieval
  // instead; it never waits for the background index.
  if (!strictEvidenceIndex) {
    for (const unit of [...candidates].reverse()) {
      if (Array.isArray(unit.record?.claims) || selectedRaw.length >= maxRetrievedUnits) continue;
      if (used + unit.tokens > retrievalBudget) continue;
      selectedRaw.push({ ...unit, injectMode: "raw-pending" });
      used += unit.tokens;
      rawUsed += unit.tokens;
    }
  }

  const maxClaims = Math.max(3, Math.min(12, maxRetrievedUnits));
  for (const claim of ranked) {
    if (selectedClaims.length >= maxClaims) break;
    if (claim.score <= 0) continue;
    const passage = claimPassage(claim);
    if (quoteAlreadyCovered(passage, [...excludedPassages, ...selectedPassages])) {
      dedupedPassageCount += 1;
      continue;
    }
    const cost = passage.tokens;
    if (used + cost > retrievalBudget) continue;
    selectedClaims.push(claim);
    selectedPassages.push(passage);
    used += cost;
    enhancementUsed += cost;
  }

  // A completed index with no lexical hit means no old evidence was selected.
  // Strict production mode does not hide uncertainty by injecting arbitrary raw
  // blocks. A selected label always yields its grounded verbatim quote.
  if (!strictEvidenceIndex && maxScore <= 0) {
    for (const unit of [...candidates].reverse().slice(0, 2)) {
      if (selectedRaw.some((item) => item.id === unit.id)) continue;
      if (used + unit.tokens > retrievalBudget) continue;
      selectedRaw.push({ ...unit, injectMode: "raw-low-confidence" });
      used += unit.tokens;
      rawUsed += unit.tokens;
    }
  }

  const chronological = selectedClaims.map((claim, index) => ({ claim, passage: selectedPassages[index] }))
    .sort((a, b) => a.claim.unit.index - b.claim.unit.index);
  selectedClaims.splice(0, selectedClaims.length, ...chronological.map((item) => item.claim));
  selectedPassages.splice(0, selectedPassages.length, ...chronological.map((item) => item.passage));
  selectedRaw.sort((a, b) => a.index - b.index);
  const assembled = evidenceMessage(selectedPassages, selectedRaw);
  const compiledMessages = [assembled, ...activeMessages].filter(Boolean);
  const rawTokens = turns.reduce((sum, turn) => sum + turn.tokens, 0);
  const liveTokens = activeTokens;
  const selectedUnitIds = new Set([...selectedRaw.map((unit) => unit.id), ...selectedClaims.map((claim) => claim.sourceUnitId)]);
  const pendingIndexCount = candidates.filter((unit) => !Array.isArray(unit.record?.claims)).length;
  return {
    messages: compiledMessages,
    coldUnits: candidates,
    selected: candidates.filter((unit) => selectedUnitIds.has(unit.id)),
    selectedClaims,
    selectedPassages,
    omitted: candidates.filter((unit) => !selectedUnitIds.has(unit.id)),
    metrics: {
      mode: "typed-evidence-index",
      rawTokens,
      compiledTokens: liveTokens + used,
      liveTokens,
      retrievedTokens: used,
      localTokens: rawUsed,
      enhancementTokens: enhancementUsed,
      dedupedPassageCount,
      ...selectionAudit(selectedPassages),
      retrievalSignals: normalizeLoopSignals(loopSignals),
      retrievalQueryHash: sha256(query),
      selectedClaimCount: selectedClaims.length,
      selectedPassageCount: selectedPassages.length,
      rawFallbackCount: selectedRaw.length,
      pendingIndexCount,
      indexComplete: pendingIndexCount === 0,
      selectionScore: maxScore,
      compressionRatio: rawTokens ? (liveTokens + used) / rawTokens : 1,
    },
  };
}

/**
 * Compile an active context every loop. Selection is deterministic and bounded;
 * expensive summaries are prepared outside this function and reused by hash.
 */
export function compileContext({
  messages,
  idea = "",
  prompt = "",
  stage = "",
  loopSignals = {},
  summaries = new Map(),
  liveTurns = 4,
  retrievalBudget = 12000,
  maxRetrievedUnits = 8,
  foldMinTokens = 4800,
  foldMaxTokens = 7200,
  strictEvidenceIndex = false,
  localEvidenceIndex = false,
  excludedPassages = [],
} = {}) {
  const turns = groupTurns(messages);
  if (turns.length <= liveTurns) {
    const rawTokens = turns.reduce((sum, turn) => sum + turn.tokens, 0);
    return {
      messages: turns.flatMap((turn) => turn.messages),
      coldUnits: [],
      selected: [],
      selectedClaims: [],
      selectedPassages: [],
      omitted: [],
      metrics: {
        mode: "live-only",
        rawTokens,
        compiledTokens: rawTokens,
        liveTokens: rawTokens,
        retrievedTokens: 0,
        localTokens: 0,
        enhancementTokens: 0,
        dedupedPassageCount: 0,
        retrievalSignals: normalizeLoopSignals(loopSignals),
        retrievalQueryHash: sha256(retrievalQuery(prompt, stage, loopSignals)),
      },
    };
  }

  const split = turns.length - liveTurns;
  const coldTurns = turns.slice(0, split);
  const live = turns.slice(split);
  const packedUnits = makeFoldUnits(coldTurns, { minTokens: foldMinTokens, maxTokens: foldMaxTokens });
  // A trailing unit below the stable threshold can still change as the dialogue
  // grows. Keep it in active context and never spend Luna tokens indexing an
  // identity that will immediately be replaced.
  const coldUnits = packedUnits.filter((unit) => unit.stable);
  const activePrefix = packedUnits.filter((unit) => !unit.stable).flatMap((unit) => unit.messages);
  const activeMessages = [...activePrefix, ...live.flatMap((turn) => turn.messages)];
  const activeTokens = packedUnits.filter((unit) => !unit.stable).reduce((sum, unit) => sum + unit.tokens, 0)
    + live.reduce((sum, turn) => sum + turn.tokens, 0);
  const candidates = coldUnits.map((unit, index) => ({
    ...unit,
    record: summaries.get(unit.id) || null,
    summary: summaries.get(unit.id)?.summary || "",
    summaryTokens: summaries.get(unit.id)?.tokens || 0,
    index,
  }));
  const hasEvidenceIndex = candidates.some((unit) => Array.isArray(unit.record?.claims));
  const preferRaw = /(原文|逐字|精确|核验|复核|证据链|raw|verbatim|exact)/i.test(String(prompt || ""));
  if (localEvidenceIndex) {
    return compileLocalEvidenceIndex({
      candidates,
      prompt,
      stage,
      loopSignals,
      activeMessages,
      activeTokens,
      turns,
      retrievalBudget,
      maxRetrievedUnits,
    });
  }
  if (hasEvidenceIndex || strictEvidenceIndex) {
    return compileEvidenceIndex({
      candidates,
      prompt,
      stage,
      loopSignals,
      activeMessages,
      activeTokens,
      turns,
      retrievalBudget,
      maxRetrievedUnits,
      strictEvidenceIndex,
      excludedPassages,
    });
  }
  // P0 remains outside folding and retrieval. It is injected independently as
  // the immutable first-message anchor; changing it cannot perturb selection.
  const query = retrievalQuery(prompt, stage, loopSignals);
  const scores = relevanceScores(candidates, query);
  const ranked = candidates.map((item, index) => ({ ...item, score: scores[index] }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const maxScore = ranked[0]?.score || 0;

  const selected = [];
  let used = 0;
  // Never create a transient blind spot while Luna is still folding a block.
  // Keep the newest unsummarized raw units within the same hard retrieval budget.
  for (const item of [...candidates].reverse()) {
    if (item.summary || selected.length >= maxRetrievedUnits) continue;
    if (used + item.tokens > retrievalBudget) continue;
    selected.push({ ...item, injectText: item.text, injectMode: "raw-pending" });
    used += item.tokens;
  }
  for (const item of ranked) {
    if (selected.length >= maxRetrievedUnits) break;
    if (selected.some((existing) => existing.id === item.id)) continue;
    if (maxScore > 0) {
      if (item.score <= 0 || item.score < maxScore * 0.5) continue;
      if (selected.filter((existing) => existing.score > 0).length >= 3) continue;
    }
    const injectRaw = preferRaw && item.score > 0;
    const injectText = injectRaw ? item.text : (item.summary || item.text);
    const cost = injectRaw ? item.tokens : (item.summary ? item.summaryTokens || estimateTokens(item.summary) : item.tokens);
    if (used + cost > retrievalBudget) continue;
    // With no lexical hit, retain only the two most recent cold units for continuity.
    if (maxScore <= 0 && item.index < candidates.length - 2) continue;
    selected.push({ ...item, injectText, injectMode: injectRaw ? "raw-verified" : (item.summary ? "summary" : "raw-fallback") });
    used += cost;
  }
  selected.sort((a, b) => a.index - b.index);
  const folded = foldedMessage(selected);
  const compiledMessages = [folded, ...activeMessages].filter(Boolean);
  const rawTokens = turns.reduce((sum, turn) => sum + turn.tokens, 0);
  const liveTokens = activeTokens;
  return {
    messages: compiledMessages,
    coldUnits,
    selected,
    selectedClaims: [],
    selectedPassages: [],
    omitted: candidates.filter((candidate) => !selected.some((item) => item.id === candidate.id)),
    metrics: {
      rawTokens,
      compiledTokens: liveTokens + used,
      liveTokens,
      retrievedTokens: used,
      retrievalSignals: normalizeLoopSignals(loopSignals),
      retrievalQueryHash: sha256(query),
      compressionRatio: rawTokens ? (liveTokens + used) / rawTokens : 1,
    },
  };
}

/**
 * Select the production context path without ever waiting for a model-backed
 * index. A fully prepared grounded evidence index wins; any missing stable
 * unit switches the current loop to the deterministic raw-passage compiler.
 * The caller may schedule the returned pending units in the background.
 */
export function compileDualTrackContext(options = {}) {
  const retrievalBudget = Math.max(0, options.retrievalBudget ?? 12000);
  // The deterministic local selector always receives its original complete
  // budget and item limits. Enhancement is strictly additive and can consume
  // only budget that the local baseline did not use.
  const local = compileContext({
    ...options,
    retrievalBudget,
    strictEvidenceIndex: false,
    localEvidenceIndex: true,
  });
  const localTokens = local.metrics?.retrievedTokens || 0;
  const remainingBudget = Math.max(0, retrievalBudget - localTokens);
  const enhanced = compileContext({
    ...options,
    retrievalBudget: remainingBudget,
    strictEvidenceIndex: true,
    localEvidenceIndex: false,
    excludedPassages: local.selectedPassages || [],
  });
  const pendingIndexCount = enhanced.metrics?.pendingIndexCount || 0;
  if (!enhanced.coldUnits.length) {
    return {
      compiled: local,
      track: "live-only",
      enhancedReady: true,
      pendingIndexCount: 0,
      pendingUnits: [],
    };
  }
  if (pendingIndexCount === 0) {
    // Labels only recover additional raw quotes across vocabulary mismatch.
    // They cannot evict, rewrite or duplicate anything selected locally.
    const isDerived = (message) => message?.customType === "idea-evidence-context-v1" || message?.customType === "idea-local-evidence-v1";
    const derived = [...local.messages.filter(isDerived), ...enhanced.messages.filter(isDerived)];
    const active = local.messages.filter((message) => !isDerived(message));
    const selectedIds = new Set([...enhanced.selected, ...local.selected].map((unit) => unit.id));
    const enhancementTokens = enhanced.metrics?.enhancementTokens || 0;
    const selectedPassages = [...(local.selectedPassages || []), ...(enhanced.selectedPassages || [])];
    const fused = {
      messages: [...derived, ...active],
      coldUnits: enhanced.coldUnits,
      selected: enhanced.coldUnits.filter((unit) => selectedIds.has(unit.id)),
      selectedClaims: enhanced.selectedClaims || [],
      selectedPassages,
      omitted: enhanced.coldUnits.filter((unit) => !selectedIds.has(unit.id)),
      metrics: {
        ...enhanced.metrics,
        mode: "local-first-luna-supplement",
        compiledTokens: (local.metrics?.liveTokens || 0) + localTokens + enhancementTokens,
        retrievedTokens: localTokens + enhancementTokens,
        localTokens,
        enhancementTokens,
        dedupedPassageCount: enhanced.metrics?.dedupedPassageCount || 0,
        ...selectionAudit(selectedPassages),
        rankFusion: "local-first-supplement-v1",
        selectedClaimCount: enhanced.selectedClaims?.length || 0,
        selectedPassageCount: selectedPassages.length,
        selectedLocalPassageCount: local.selectedPassages?.length || 0,
        selectedEnhancementPassageCount: enhanced.selectedPassages?.length || 0,
        indexedPassageCount: local.metrics?.indexedPassageCount || 0,
        localSelectionScore: local.metrics?.selectionScore || 0,
        enhancementSelectionScore: enhanced.metrics?.selectionScore || 0,
        pendingIndexCount: 0,
        indexComplete: true,
      },
    };
    return {
      compiled: fused,
      track: "luna-enhanced",
      enhancedReady: true,
      pendingIndexCount: 0,
      pendingUnits: [],
    };
  }
  const pendingUnits = enhanced.coldUnits.filter((unit) => !Array.isArray(unit.record?.claims));
  return {
    compiled: local,
    track: "local-fallback",
    enhancedReady: false,
    pendingIndexCount,
    pendingUnits,
  };
}

export function summaryPrompt(unit, ideaHash) {
  return `你是长任务上下文折叠器。只压缩下面这个已经完成的原始工作块；不得判断或修改 Scientific Idea。\n\n` +
    `要求：\n` +
    `- 保留会影响后续工作的事实、用户决定、实验结果及其限定条件、失败、冲突、文件/命令结果和未决事项。\n` +
    `- 明确区分观测、解释与猜测；保留关键专名、数值、标识符和检索词。\n` +
    `- 删除寒暄、重复叙述、完整工具日志和已经被结果取代的操作细节。\n` +
    `- 不添加建议，不把摘要写成权威结论。输出不超过 500 中文字。\n\n` +
    `Idea identity: ${ideaHash || "none"}\nRaw block: ${unit.id}\n\n<raw_block>\n${unit.text}\n</raw_block>`;
}
