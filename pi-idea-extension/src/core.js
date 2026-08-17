import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import { decideControlAction, emptyWorkingState, makeAuthorityLayer, splitLegacyIdea, workingStateText } from "./research-state.js";

export const STATE_TYPE = "pi-idea-state-v1";

export function sha256(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

// Conservative for mixed CJK/Latin text. This is a ceiling check, not billing.
export function estimateTokens(text) {
  const value = String(text || "");
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = value.length - cjk;
  return Math.ceil(cjk * 1.15 + rest / 3.2);
}

export function emptyState() {
  return {
    schema: 1,
    enabled: false,
    paused: false,
    ideaId: null,
    conversationKind: "main",
    workspaces: [],
    idea: null,
    ideaKernel: null,
    researchFrame: null,
    workingState: emptyWorkingState(),
    pendingFrameProposal: null,
    stage: "",
    proposal: null,
    pendingDescription: null,
    narrowState: [],
    todos: [],
    skills: [],
  };
}

function normalizedStateKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 80 || /[\r\n<>]/.test(key)) throw new Error("State key must be 1-80 characters without line breaks or angle brackets.");
  return key;
}

export function makeConfirmedStateFact({ key, value, previous = null, source = "user" } = {}) {
  const normalizedKey = normalizedStateKey(key);
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue || normalizedValue.length > 4000) throw new Error("State value must be 1-4000 characters.");
  const confirmedAt = new Date().toISOString();
  const contentHash = sha256(`${normalizedKey}\0${normalizedValue}`);
  return Object.freeze({
    schema: 1,
    key: normalizedKey,
    value: normalizedValue,
    version: (previous?.version || 0) + 1,
    hash: contentHash,
    parentHash: previous?.hash || null,
    source,
    confirmedAt,
  });
}

export function narrowStateText(narrowState = []) {
  return [...(Array.isArray(narrowState) ? narrowState : [])]
    .filter((fact) => fact?.key && fact?.value)
    .sort((left, right) => String(left.key).localeCompare(String(right.key), "en"))
    .map((fact) => `${fact.key}=${fact.value}`)
    .join("\n");
}

export function applyEvent(state, event) {
  const next = structuredClone(state || emptyState());
  if (!event || event.schema !== 1) return next;

  switch (event.op) {
    case "initialization-requested":
      next.pendingDescription = event.description;
      break;
    case "proposal-created":
      next.proposal = event.proposal;
      break;
    case "idea-confirmed":
      next.idea = event.idea;
      if (event.ideaKernel) next.ideaKernel = event.ideaKernel;
      if (event.researchFrame !== undefined) next.researchFrame = event.researchFrame;
      if (event.workingState) next.workingState = event.workingState;
      if (!next.ideaKernel && event.idea?.content) {
        const migrated = splitLegacyIdea(event.idea.content);
        next.ideaKernel = makeAuthorityLayer(migrated.kernelContent, {
          version: event.idea.version,
          parentHash: event.idea.parentHash,
          source: "legacy-p0-deterministic-migration",
          confirmedAt: event.idea.confirmedAt,
        });
        next.researchFrame = migrated.frameContent ? makeAuthorityLayer(migrated.frameContent, {
          source: "legacy-p0-deterministic-migration",
          confirmedAt: event.idea.confirmedAt,
        }) : null;
      }
      if (event.ideaId) next.ideaId = event.ideaId;
      next.enabled = true;
      next.paused = false;
      next.proposal = null;
      next.pendingDescription = null;
      break;
    case "workspace-bound":
      next.ideaId = event.ideaId || next.ideaId;
      next.conversationKind = event.conversationKind === "btw" ? "btw" : "main";
      next.workspaces = Array.isArray(event.workspaces) ? event.workspaces : [];
      if (event.idea) next.idea = event.idea;
      if (event.ideaKernel) next.ideaKernel = event.ideaKernel;
      if (event.researchFrame !== undefined) next.researchFrame = event.researchFrame;
      if (event.workingState) next.workingState = event.workingState;
      if (event.pendingFrameProposal !== undefined) next.pendingFrameProposal = event.pendingFrameProposal;
      if (typeof event.stage === "string") next.stage = event.stage;
      if (Array.isArray(event.narrowState)) next.narrowState = event.narrowState;
      if (Array.isArray(event.skills)) next.skills = event.skills;
      if (Array.isArray(event.todos)) next.todos = event.todos;
      next.enabled = Boolean(next.idea);
      next.paused = false;
      break;
    case "working-state-updated":
      if (event.workingState) next.workingState = event.workingState;
      break;
    case "frame-proposal-created":
      next.pendingFrameProposal = event.proposal || null;
      break;
    case "frame-confirmed":
      if (event.researchFrame) next.researchFrame = event.researchFrame;
      next.pendingFrameProposal = null;
      break;
    case "todo-snapshot":
      next.todos = Array.isArray(event.todos) ? event.todos : [];
      break;
    case "stage-set":
      next.stage = event.stage || "";
      break;
    case "state-fact-set": {
      const fact = event.fact;
      if (!fact?.key || !fact?.value) break;
      if (!Array.isArray(next.narrowState)) next.narrowState = [];
      const index = next.narrowState.findIndex((item) => item.key === fact.key);
      if (index >= 0) next.narrowState[index] = fact;
      else next.narrowState.push(fact);
      break;
    }
    case "state-fact-unset":
      next.narrowState = (Array.isArray(next.narrowState) ? next.narrowState : []).filter((fact) => fact.key !== event.key);
      break;
    case "paused":
      next.paused = true;
      break;
    case "resumed":
      if (next.idea) {
        next.enabled = true;
        next.paused = false;
      }
      break;
    case "disabled":
      next.enabled = false;
      next.paused = false;
      break;
    case "skill-candidate":
      if (event.skill?.id && !next.skills.some((item) => item.id === event.skill.id)) {
        next.skills.push(event.skill);
      }
      break;
    case "skill-promoted": {
      const skill = next.skills.find((item) => item.id === event.id);
      if (skill) {
        skill.status = "active";
        skill.promotedAt = event.at;
      }
      break;
    }
    case "skill-quarantined": {
      const skill = next.skills.find((item) => item.id === event.id);
      if (skill) {
        skill.status = "quarantined";
        skill.quarantinedAt = event.at;
      }
      break;
    }
  }
  return next;
}

export function replay(entries) {
  let state = emptyState();
  for (const entry of entries || []) {
    if (entry?.type === "custom" && entry?.customType === STATE_TYPE) {
      state = applyEvent(state, entry.data);
    }
  }
  return state;
}

export function makeProposal(content, source = "user") {
  const value = String(content || "").trim();
  return {
    id: randomUUID(),
    content: value,
    hash: sha256(value),
    source,
    createdAt: new Date().toISOString(),
  };
}

export function confirmProposal(proposal, previousIdea = null) {
  if (!proposal?.content) throw new Error("No proposal to confirm.");
  return {
    version: (previousIdea?.version || 0) + 1,
    content: proposal.content,
    hash: proposal.hash || sha256(proposal.content),
    parentHash: previousIdea?.hash || null,
    confirmedAt: new Date().toISOString(),
  };
}

export function budgetFor({ idea = "", ideaKernel = null, researchFrame = null, workingState = null, stage = "", narrowState = [], contextWindow = 272000, systemPrompt = "" } = {}) {
  const kernelText = ideaKernel?.content || idea;
  const frameText = researchFrame?.content || "";
  const workText = workingState ? workingStateText(workingState) : "";
  const p0Tokens = estimateTokens(kernelText);
  const frameTokens = estimateTokens(frameText);
  const workingTokens = estimateTokens(workText);
  const p1Tokens = estimateTokens(stage);
  const stateTokens = estimateTokens(narrowStateText(narrowState));
  const systemTokens = estimateTokens(systemPrompt);
  const effective = Math.max(16000, contextWindow - 8192 - systemTokens - 4096);
  const combinedLimit = Math.floor(effective * 0.05);
  return {
    p0Tokens,
    p1Tokens,
    stateTokens,
    frameTokens,
    workingTokens,
    combined: p0Tokens + frameTokens + workingTokens + p1Tokens + stateTokens,
    p0Limit: Math.min(1200, Math.floor(effective * 0.02)),
    p1Limit: Math.min(4000, Math.max(0, combinedLimit - p0Tokens - frameTokens - workingTokens - stateTokens)),
    stateLimit: Math.min(2000, Math.max(0, combinedLimit - p0Tokens - frameTokens - workingTokens - p1Tokens)),
    combinedLimit,
    effective,
    ok: p0Tokens <= Math.min(1200, Math.floor(effective * 0.02))
      && p1Tokens <= Math.min(4000, Math.max(0, combinedLimit - p0Tokens - frameTokens - workingTokens - stateTokens))
      && stateTokens <= Math.min(2000, Math.max(0, combinedLimit - p0Tokens - frameTokens - workingTokens - p1Tokens))
      && p0Tokens + frameTokens + workingTokens + p1Tokens + stateTokens <= combinedLimit,
  };
}

const IMPLEMENTATION_PATTERNS = [
  /\b(build|implement|change|edit|write|fix|refactor|install|configure|debug|patch|code)\b/i,
  /(实现|开发|修改|修复|安装|配置|调试|重构|写代码|改代码|补丁|跑测试)/,
];

export function classifyTask(prompt) {
  const value = String(prompt || "");
  return IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(value)) ? "implementation" : "discussion";
}

export const AUTONOMY_RULE = `<task_control>
在当前任务、权限和验收标准内自主完成工作并处理普通错误；不要逐步请求批准。若需要改变 Scientific Idea、阶段目标、权限范围，或将发生不可恢复风险，停止并归还控制。工程工作不等于科研进展。
</task_control>`;

export const MINIMAL_EXECUTION_RULE = `<minimal_execution>
只做达到当前验收标准所需的最小改动，达标后停止。依次优先复用现有实现、标准库或原生能力、已安装依赖，最后才写最小新代码。不增加未被验收标准、已复现失败或仓库约束证明必要的抽象、配置、依赖、兼容层、fallback、脚手架或顺手重构。修复根因，不删减信任边界验证、防止数据丢失的处理和明确安全要求。必须扩展范围时，先报告证据与最小扩张，等待确认。
</minimal_execution>`;

export const RESPONSE_RULE = `<response_style>
先给结果，只保留必要证据、实质风险和下一步；没有实际需要时，不使用多级标题、表格、重复总结或过程复述。
</response_style>`;

export const IDEA_TOOLBOX = Object.freeze([
  {
    id: "worker-handoff",
    title: "廉价 Worker 最小任务包",
    patterns: [/(子线程|工作线程|worker|subagent|便宜模型|廉价模型|委派|派活)/i],
    instruction: "委派时只给目标、非目标、必要证据、约束、完成条件和 Idea 哈希；Worker 只返回结构化结果与证据引用，不判断科研方向。",
  },
  {
    id: "background-completion",
    title: "后台任务完成交还",
    patterns: [/(后台任务|background|长时间运行|轮询|监控|等待完成)/i],
    instruction: "后台执行必须有明确完成条件、硬上限与停止原因；执行期间不让昂贵主模型轮询，结束后只交还结果摘要、证据、失败和未决冲突。",
  },
  {
    id: "evidence-brief",
    title: "证据简报",
    patterns: [/(实验结果|新证据|证据整理|对比实验|日志分析|结果汇总)/i],
    instruction: "先区分观测、解释和猜测；只保留会改变当前判断的结果，附来源与支持/反对关系，不把摘要升级为权威 Idea。",
  },
  {
    id: "bounded-plan",
    title: "临时计划视图",
    patterns: [/(制定计划|列个计划|下一阶段|任务清单|todo|复盘|检查点)/i],
    instruction: "计划与清单只是当前阶段的临时执行视图：并行项只能追加，冲突必须显式暴露；完成、删除或重排任务都不能自动改变 Idea。",
  },
  {
    id: "context-audit",
    title: "上下文装配审计",
    patterns: [/(上下文组装|上下文装配|压缩|摘要|manifest|记忆检索|context)/i],
    instruction: "审计 Idea Kernel 是否逐字位于最前、Research Frame 是否来自用户确认、Working State 是否越权决定科研方向、证据是否有来源、派生视图是否可重建、预算是否通过；不改写 Kernel 或 Frame。",
  },
]);

export function selectToolboxItem(prompt) {
  const value = String(prompt || "");
  return IDEA_TOOLBOX.find((item) => item.patterns.some((pattern) => pattern.test(value))) || null;
}

function relevantSkills(skills, prompt) {
  const haystack = String(prompt || "").toLowerCase();
  return (skills || [])
    .filter((skill) => skill.status === "active")
    .filter((skill) => {
      const triggers = Array.isArray(skill.triggers) ? skill.triggers : [];
      return triggers.length === 0 || triggers.some((trigger) => haystack.includes(String(trigger).toLowerCase()));
    })
    .slice(0, 3);
}

export function buildAnchor(state, prompt) {
  if (!state?.enabled || state.paused || !(state.ideaKernel?.content || state.idea?.content)) return null;
  const kernel = state.ideaKernel || makeAuthorityLayer(splitLegacyIdea(state.idea.content).kernelContent, {
    version: state.idea.version,
    parentHash: state.idea.parentHash,
    confirmedAt: state.idea.confirmedAt,
  });
  const parts = [kernel.content];
  parts.push(`\n<verified_research_state authority="user-confirmed" kernel-hash="${kernel.hash}" kernel-version="${kernel.version}">`);
  if (state.researchFrame?.content) {
    parts.push(`\n<research_frame authority="user-confirmed" hash="${state.researchFrame.hash}" version="${state.researchFrame.version}">\n${state.researchFrame.content}\n</research_frame>`);
  }
  const work = workingStateText(state.workingState);
  if (work) parts.push(`\n<working_state authority="model-fillable-not-decisive">\n${work}\n</working_state>`);
  const control = decideControlAction(state.workingState);
  parts.push(`\n<loop_controller action="${control.action}" reason="${control.reason}">控制器只读取状态；continue 可推进下一动作，verify-stop 只核验停止建议，complete 只接受 Harness 已确认的验收通过。</loop_controller>`);
  if (state.stage) parts.push(`\n<current_stage>\n${state.stage}\n</current_stage>`);
  const confirmedState = narrowStateText(state.narrowState);
  if (confirmedState) parts.push(`\n<confirmed_narrow_state>\n${confirmedState}\n</confirmed_narrow_state>`);
  const openTodos = (Array.isArray(state.todos) ? state.todos : []).filter((todo) => todo?.status !== "done" && todo?.text);
  if (openTodos.length) {
    const todoText = openTodos.map((todo) => {
      const review = todo.pendingModelReview ? " user-edited=\"true\"" : "";
      const suggestion = todo.userSuggestion && todo.userSuggestion !== todo.text ? `\n  用户建议：${todo.userSuggestion}` : "";
      return `- [${todo.status || "pending"}] id=${todo.todoId}${review} ${todo.text}${suggestion}`;
    }).join("\n");
    parts.push(`\n<working_todos authority="user-editable" update_tool="idea_todo">\n${todoText}\n用户编辑项必须在本轮实践中核对；可接受、改写、标记阻塞或完成，但不得为了迎合清单而偏离 Scientific Idea。\n</working_todos>`);
  }
  const conversationKind = state.conversationKind === "btw" ? "btw" : "main";
  parts.push(`\n<conversation_role kind="${conversationKind}">`);
  parts.push(conversationKind === "main"
    ? "这是该 Idea 唯一主对话，可推进执行并维护 Todo；Idea 本身仍只能经用户确认修改。"
    : "这是 BTW 支线，只能讨论、调查、追加证据或提出建议；不得接管主路线、确认 Idea 修改或覆盖主对话状态。");
  parts.push("</conversation_role>");
  parts.push("\n</verified_research_state>");
  parts.push(`\n${AUTONOMY_RULE}`);
  if (classifyTask(prompt) === "implementation") parts.push(`\n${MINIMAL_EXECUTION_RULE}`);

  const toolboxItem = selectToolboxItem(prompt);
  if (toolboxItem) {
    parts.push(`\n<idea_toolbox id="${toolboxItem.id}">\n${toolboxItem.instruction}\n</idea_toolbox>`);
  }

  const selected = relevantSkills(state.skills, prompt);
  if (selected.length) {
    const compact = selected.map((skill) => `- ${skill.lesson}`).join("\n");
    parts.push(`\n<verified_execution_lessons>\n${compact}\n</verified_execution_lessons>`);
  }
  parts.push(`\n${RESPONSE_RULE}`);
  return {
    content: parts.join(""),
    selectedSkillIds: selected.map((skill) => skill.id),
    selectedToolboxId: toolboxItem?.id || null,
  };
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("\\\\"));
}

function shellWritesIdea(command) {
  const value = String(command || "");
  if (!/(^|[\\/\s"'])IDEA\.md([\s"']|$)/i.test(value)) return false;
  return /(?:>|\b(?:set-content|add-content|out-file|remove-item|move-item|copy-item|del|erase|rm|mv|cp)\b)/i.test(value);
}

function highRiskShell(command) {
  const value = String(command || "").trim();
  const patterns = [
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i,
    /\bremove-item\b[^\r\n;|]*-recurse\b[^\r\n;|]*(?:\$HOME|~|[A-Za-z]:\\(?:\s|$))/i,
    /\b(?:format(?:\.com)?|diskpart|clear-disk|initialize-disk)\b/i,
    /\b(?:shutdown(?:\.exe)?\s+\/(?:s|r)|stop-computer|restart-computer)\b/i,
    /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--\s+\.|restore\s+\.)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * A deliberately small deterministic boundary gate. It detects only high-confidence
 * irreversible actions and scope expansion; ordinary work remains autonomous.
 */
export function toolBoundaryDecision({ toolName, input = {}, cwd, ideaEnabled = false, approvedRoots = [] }) {
  const name = String(toolName || "").toLowerCase();
  if (name === "bash") {
    const command = String(input.command || "");
    if (ideaEnabled && shellWritesIdea(command)) {
      return { action: "block", code: "idea-authority", message: "IDEA.md 只能通过 Idea 提案与用户确认改变。" };
    }
    if (highRiskShell(command)) {
      return { action: "confirm", code: "irreversible-shell", message: "该命令可能造成不可恢复的系统或文件变更。" };
    }
    return { action: "allow" };
  }

  if (name !== "write" && name !== "edit") return { action: "allow" };
  const rawPath = input.path || input.file_path || input.filePath;
  if (!rawPath || !cwd) return { action: "allow" };
  const target = resolve(cwd, String(rawPath));
  if (ideaEnabled && basename(target).toLowerCase() === "idea.md") {
    return { action: "block", code: "idea-authority", target, message: "IDEA.md 只能通过 Idea 提案与用户确认改变。" };
  }
  if (!isInside(cwd, target) && !approvedRoots.some((root) => isInside(root, target))) {
    return {
      action: "confirm",
      code: "outside-workspace-write",
      target,
      approvalRoot: dirname(target),
      message: "写入目标位于当前工作区之外。",
    };
  }
  return { action: "allow", target };
}

export function extractIdeaCandidate(text) {
  const value = String(text || "");
  const match = value.match(/\[\[IDEA_CANDIDATE\]\]([\s\S]*?)\[\[\/IDEA_CANDIDATE\]\]/);
  if (!match) return null;
  return {
    candidate: match[1].trim(),
    visible: value.replace(match[0], `候选 Idea：\n\n${match[1].trim()}`).trim(),
  };
}

export function extractSkillCandidates(text) {
  const skills = [];
  const cleaned = String(text || "").replace(/\[\[SKILL_CANDIDATE\]\]([\s\S]*?)\[\[\/SKILL_CANDIDATE\]\]/g, (_all, body) => {
    try {
      const parsed = JSON.parse(body.trim());
      if (parsed.lesson && parsed.evidence) {
        skills.push({
          id: randomUUID(),
          status: "candidate",
          lesson: String(parsed.lesson).slice(0, 800),
          triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String).slice(0, 8) : [],
          evidence: String(parsed.evidence).slice(0, 800),
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // Invalid model-emitted candidates are ignored; they never affect execution.
    }
    return "";
  });
  return { cleaned: cleaned.trim(), skills };
}
