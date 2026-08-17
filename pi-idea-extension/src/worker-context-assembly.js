import { estimateTokens, sha256 } from "./core.js";

const FORBIDDEN_KINDS = new Set(["tool_call", "assistant_thinking", "bash_command"]);

function renderEvidence(block) {
  return `[ref=${block.blockId} kind=${block.kind} raw_hash=${block.rawHash}]\n${block.raw}`;
}

/** Build an isolated Workflow packet. A worker receives a frozen task card and
 * exact evidence islands only; it never inherits the main conversation. */
export function assembleWorkerContext({ taskCard, blocks = [], researchState = null } = {}) {
  if (!taskCard?.cardHash || !taskCard?.objective) throw new Error("A frozen Workflow task card is required");
  const byId = new Map(blocks.map((block) => [block.blockId, block]));
  const missing = taskCard.inputRefs.filter((ref) => !byId.has(ref));
  if (missing.length) return Object.freeze({ blocked: true, reason: "missing-required-input", missingRefs: Object.freeze(missing) });
  const selected = taskCard.inputRefs.map((ref) => byId.get(ref));
  const forbidden = selected.filter((block) => FORBIDDEN_KINDS.has(block.kind));
  if (forbidden.length) return Object.freeze({ blocked: true, reason: "forbidden-context-kind", forbiddenRefs: Object.freeze(forbidden.map((block) => block.blockId)) });
  const state = researchState ? {
    ideaHash: researchState.ideaHash || null,
    ideaVersion: researchState.ideaVersion ?? null,
    stageHash: researchState.stageHash || null,
  } : null;
  const content = [
    `<workflow_task_card authority="frozen" hash="${taskCard.cardHash}">\n${JSON.stringify(taskCard)}\n</workflow_task_card>`,
    state ? `<research_coordinate authority="user-confirmed">${JSON.stringify(state)}</research_coordinate>` : "",
    `<workflow_evidence authority="verbatim-raw">\n${selected.map(renderEvidence).join("\n\n")}\n</workflow_evidence>`,
    `<workflow_return_contract>${taskCard.returnContract.join(",")}</workflow_return_contract>`,
  ].filter(Boolean).join("\n\n");
  const tokens = estimateTokens(content);
  if (tokens > taskCard.limits.maxInputTokens) {
    return Object.freeze({ blocked: true, reason: "required-closure-over-budget", tokens, limit: taskCard.limits.maxInputTokens });
  }
  return Object.freeze({
    blocked: false,
    content,
    tokens,
    selectedRefs: Object.freeze([...taskCard.inputRefs]),
    manifest: Object.freeze({
      schema: 1,
      mode: "worker-isolated-task-card-v1",
      taskId: taskCard.taskId,
      cardHash: taskCard.cardHash,
      inputHash: sha256(content),
      selectedRefs: Object.freeze([...taskCard.inputRefs]),
      excludedKinds: Object.freeze([...FORBIDDEN_KINDS]),
      inheritedMainConversation: false,
      summaryUsed: false,
    }),
  });
}
