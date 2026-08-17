import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const workspace = resolve(packageRoot, "..");
const runtime = await mkdtemp(join(tmpdir(), "pi-idea-web-"));

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolvePort(address.port));
    });
  });
}

const port = await freePort();
const child = spawn(process.execPath, [join(packageRoot, "web", "server.js"), "--port", String(port), "--offline"], {
  cwd: workspace,
  env: { ...process.env, PI_CODING_AGENT_DIR: runtime },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

async function waitReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (stdout.includes("PI_IDEA_WEB_READY")) return;
    if (child.exitCode != null) throw new Error(`Web server exited early.\n${stderr}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(`Web server startup timeout.\n${stderr}`);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${payload.error || response.status}`);
  return payload;
}

try {
  await waitReady();
  assert.equal((await request("/api/health")).ok, true);
  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.state.model.id, "gpt-5.6-sol");
  assert.equal(bootstrap.state.thinkingLevel, "max");

  const proposal = await request("/api/ideas/propose", { method: "POST", body: { content: "科学对象：\nWeb smoke Idea" } });
  assert.match(proposal.diffText, /Web smoke Idea/);
  const confirmed = await request("/api/ideas/confirm", { method: "POST", body: { proposalId: proposal.proposalId } });
  const ideaId = confirmed.idea.ideaId;
  const todo = await request(`/api/ideas/${ideaId}/todos`, { method: "POST", body: { text: "验证 Web 闭环" } });
  assert.equal(todo.todo.pendingModelReview, true);
  const main = await request("/api/conversations/open", { method: "POST", body: { ideaId, kind: "main", workspace: runtime } });
  assert.equal(main.conversation.kind, "main");
  const btw = await request("/api/conversations/open", { method: "POST", body: { ideaId, kind: "btw", workspace: runtime } });
  assert.equal(btw.conversation.kind, "btw");
  const conversationState = (await request("/api/workspace")).ideas.find((idea) => idea.ideaId === ideaId);
  assert.equal(conversationState.conversations.filter((row) => row.kind === "main" && row.active).length, 1);
  assert.equal(conversationState.conversations.filter((row) => row.kind === "btw").length, 1);
  const switched = await request("/api/conversations/switch", { method: "POST", body: { sessionId: main.conversation.sessionId } });
  assert.equal(switched.conversation.kind, "main");
  assert.equal((await request("/api/workspace")).activeConversation.kind, "main");
  await request(`/api/ideas/${ideaId}/workspaces`, { method: "POST", body: { workspace: join(runtime, "secondary") } });
  await request(`/api/ideas/${ideaId}/workspaces`, { method: "PATCH", body: { workspace: join(runtime, "secondary") } });
  const workflow = await request(`/api/ideas/${ideaId}/workflows`, {
    method: "POST",
    body: { runId: "web-worker", kind: "worker", label: "Web worker", status: "running", progressCurrent: 1, progressTotal: 2 },
  });
  assert.equal(workflow.workflow.status, "running");
  const workflowList = await request(`/api/ideas/${ideaId}/workflows`);
  assert.equal(workflowList.workflows[0].runId, "web-worker");
  const archived = await request("/api/ideas/status", { method: "POST", body: { ideaId, status: "archived" } });
  assert.equal(archived.idea.status, "archived");
  const all = await request("/api/workspace");
  assert.ok(all.ideas.some((idea) => idea.ideaId === ideaId && idea.status === "archived"));
  process.stdout.write("Pi-Idea Web smoke passed: RPC bootstrap and Idea/Todo/workspace/Workflow/archive APIs are live.\n");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  await rm(runtime, { recursive: true, force: true });
}
