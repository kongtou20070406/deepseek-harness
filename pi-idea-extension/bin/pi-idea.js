#!/usr/bin/env node
import { IdeaWorkspaceStore } from "../src/idea-workspace-store.js";
import { workingStateText } from "../src/research-state.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const input = args.filter((arg) => arg !== "--json");
const [group = "idea", action = "list", id, ...rest] = input;
const store = new IdeaWorkspaceStore();

function output(value) {
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : value}\n`);
}

function requireIdea(ideaId) {
  const idea = store.getIdea(ideaId);
  if (!idea) throw new Error(`Idea not found: ${ideaId || "(missing id)"}`);
  return idea;
}

try {
  if (group === "idea" && action === "list") {
    const ideas = store.listIdeas({ includeArchived: true });
    output(json ? ideas : ideas.map((idea) => `${idea.ideaId}  [${idea.status}]  ${idea.title}`).join("\n") || "No Ideas.");
  } else if (group === "idea" && action === "show") {
    const idea = requireIdea(id);
    output(json ? idea : [
      `Idea ${idea.ideaId} · ${idea.title}`,
      `Kernel v${idea.ideaKernel.version}\n${idea.ideaKernel.content}`,
      `Frame v${idea.researchFrame?.version || 0}\n${idea.researchFrame?.content || "(empty)"}`,
      `Working r${idea.workingState.revision}\n${workingStateText(idea.workingState)}`,
    ].join("\n\n"));
  } else if (group === "working" && action === "show") {
    const idea = requireIdea(id);
    output(json ? idea.workingState : workingStateText(idea.workingState));
  } else if (group === "working" && action === "set") {
    const field = rest.shift();
    const value = rest.join(" ").trim();
    if (!field || !value) throw new Error("Usage: pi-idea working set <idea-id> <field> <value>");
    const research = store.updateWorkingState(id, { [field]: value }, { actor: "user-cli" });
    output(json ? research.workingState : workingStateText(research.workingState));
  } else if (group === "frame" && action === "show") {
    const idea = requireIdea(id);
    output(json ? { frame: idea.researchFrame, pending: idea.pendingFrameProposal } : [
      idea.researchFrame?.content || "(empty)",
      idea.pendingFrameProposal ? `\nPending ${idea.pendingFrameProposal.proposalId}\n${idea.pendingFrameProposal.content}` : "",
    ].join(""));
  } else if (group === "frame" && action === "propose") {
    requireIdea(id);
    const content = rest.join(" ").trim();
    if (!content) throw new Error("Usage: pi-idea frame propose <idea-id> <content>");
    const proposal = store.proposeResearchFrame(id, content, { actor: "user-cli" });
    output(json ? proposal : `Frame proposal ${proposal.proposalId}\n${proposal.content}`);
  } else if (group === "frame" && action === "confirm") {
    requireIdea(id);
    const proposalId = rest[0];
    if (!proposalId) throw new Error("Usage: pi-idea frame confirm <idea-id> <proposal-id>");
    const research = store.confirmResearchFrame(id, proposalId, { actor: "user-cli" });
    output(json ? research.researchFrame : `Confirmed Frame v${research.researchFrame.version}\n${research.researchFrame.content}`);
  } else if (group === "doctor") {
    output(json ? { ok: true, databasePath: store.databasePath, ideas: store.countIdeas() }
      : `OK · ${store.countIdeas()} Ideas · ${store.databasePath}`);
  } else {
    throw new Error("Commands: idea list|show, working show|set, frame show|propose|confirm, doctor [--json]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
