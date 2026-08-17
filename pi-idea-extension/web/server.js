import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IdeaWorkspaceStore } from "../src/idea-workspace-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const workspace = resolve(packageRoot, "..");
const publicRoot = join(here, "public");
const piCli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ideaExtension = join(packageRoot, "extensions", "idea.js");

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 43120,
    offline: false,
    noSession: false,
    open: false,
    thinking: process.env.PI_IDEA_THINKING || "max",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--host") options.host = argv[++index] || options.host;
    else if (value === "--port") options.port = Number(argv[++index] || options.port);
    else if (value === "--thinking") options.thinking = argv[++index] || options.thinking;
    else if (value === "--offline") options.offline = true;
    else if (value === "--no-session") options.noSession = true;
    else if (value === "--open") options.open = true;
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (!/^(off|minimal|low|medium|high|xhigh|max)$/.test(options.thinking)) {
    throw new Error(`Invalid thinking level: ${options.thinking}`);
  }
  return options;
}

class PiRpcBridge {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.sequence = 0;
    this.waiters = new Map();
    this.listeners = new Set();
    this.status = new Map();
    this.widgets = new Map();
    this.title = "Pi-Idea";
    this.stderr = "";
    this.closed = false;

    child.stdout.on("data", (chunk) => this.consume(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-12000);
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`Pi RPC exited (${code ?? signal ?? "unknown"})`);
      for (const waiter of this.waiters.values()) waiter.reject(error);
      this.waiters.clear();
      this.broadcast({ type: "pi_process_exit", code, signal, stderr: this.stderr.slice(-2000) });
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        this.broadcast({ type: "bridge_error", message: "Pi RPC emitted invalid JSON." });
        continue;
      }
      if (record.type === "response" && record.id && this.waiters.has(record.id)) {
        const waiter = this.waiters.get(record.id);
        this.waiters.delete(record.id);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
      this.captureUiProjection(record);
      this.broadcast(record);
    }
  }

  captureUiProjection(record) {
    if (record?.type !== "extension_ui_request") return;
    if (record.method === "setStatus") {
      if (record.statusText) this.status.set(record.statusKey, record.statusText);
      else this.status.delete(record.statusKey);
    } else if (record.method === "setWidget") {
      if (Array.isArray(record.widgetLines)) this.widgets.set(record.widgetKey, record.widgetLines);
      else this.widgets.delete(record.widgetKey);
    } else if (record.method === "setTitle" && record.title) {
      this.title = record.title;
    }
  }

  broadcast(record) {
    const payload = `data: ${JSON.stringify(record)}\n\n`;
    for (const response of this.listeners) response.write(payload);
  }

  subscribe(response) {
    this.listeners.add(response);
    response.write(`data: ${JSON.stringify({ type: "bridge_ready" })}\n\n`);
    return () => this.listeners.delete(response);
  }

  send(record) {
    if (this.closed || !this.child.stdin.writable) throw new Error("Pi RPC is not running.");
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  request(command, timeoutMs = 20000) {
    const id = `web-${++this.sequence}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Pi RPC timeout: ${command.type}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve: resolveRequest, reject, timer });
      try {
        this.send({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(error);
      }
    });
  }

  projection() {
    return {
      status: Object.fromEntries(this.status),
      widgets: Object.fromEntries(this.widgets),
      title: this.title,
    };
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end();
    this.child.kill();
  }
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sameOrigin(request, host, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://${host}:${port}` || (host === "127.0.0.1" && origin === `http://localhost:${port}`);
}

async function ideaDocument() {
  const path = join(workspace, "IDEA.md");
  try {
    const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { exists: true, content, modifiedAt: info.mtime.toISOString() };
  } catch {
    return { exists: false, content: "", modifiedAt: null };
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(pathname, response) {
  const files = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/app.js": "app.js",
  };
  const name = files[pathname];
  if (!name) return false;
  const path = join(publicRoot, name);
  response.writeHead(200, {
    "Content-Type": mime[extname(path)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(path).pipe(response);
  return true;
}

const options = parseArgs(process.argv.slice(2));
const piArgs = [
  piCli,
  "--mode", "rpc",
  "--approve",
  "--provider", "openai-codex",
  "--model", "gpt-5.6-sol",
  "--thinking", options.thinking,
  "--no-extensions",
  "--extension", ideaExtension,
];
if (options.offline) piArgs.push("--offline");
if (options.noSession) piArgs.push("--no-session");

const pi = spawn(process.execPath, piArgs, {
  cwd: workspace,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const bridge = new PiRpcBridge(pi);
const registry = new IdeaWorkspaceStore();

if (registry.countIdeas() === 0) {
  try {
    const current = await ideaDocument();
    if (current.exists && current.content.trim()) {
      registry.importConfirmedIdea({ content: current.content, workspace, source: "confirmed-idea-md-import" });
    }
  } catch {
    // A missing or invalid legacy IDEA.md leaves an empty registry for the UI.
  }
}

const allowedCommands = new Set([
  "abort",
  "new_session",
  "compact",
  "set_thinking_level",
  "cycle_thinking_level",
  "set_auto_compaction",
  "set_auto_retry",
]);

async function waitForSession(sessionId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await bridge.request({ type: "get_state" });
    if (latest.data?.sessionId === sessionId) return latest.data;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Pi session switch did not settle on ${sessionId}; observed ${latest?.data?.sessionId || "unknown"}.`);
}

async function activateConversation(conversation) {
  if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
    const switched = await bridge.request({ type: "switch_session", sessionPath: conversation.sessionFile }, 30000);
    if (!switched.success || switched.data?.cancelled) throw new Error(switched.error || "Conversation switch was cancelled.");
    await waitForSession(conversation.sessionId);
    return registry.conversation(conversation.sessionId);
  }
  // Pi intentionally does not write an empty session until its first assistant
  // message. Replacing such a session loses no dialogue and avoids fabricating a
  // model turn merely to force persistence.
  const created = await bridge.request({ type: "new_session" }, 30000);
  if (!created.success || created.data?.cancelled) throw new Error(created.error || "Replacement conversation was cancelled.");
  const state = await bridge.request({ type: "get_state" });
  const nextSessionId = state.data?.sessionId;
  if (!nextSessionId) throw new Error("Pi did not return a replacement session id.");
  const rebound = registry.rebindConversationSession(conversation.sessionId, {
    nextSessionId,
    sessionFile: state.data?.sessionFile || null,
  });
  const bound = await bridge.request({ type: "prompt", message: `/idea-bind ${rebound.ideaId} ${rebound.kind}` });
  if (!bound.success) throw new Error(bound.error || "Pi-Idea binding failed.");
  return registry.conversation(nextSessionId);
}

async function switchOrCreateConversation({ ideaId, kind = "btw", workspacePath = workspace } = {}) {
  const idea = registry.getIdea(ideaId);
  if (!idea) throw new Error("Idea not found.");
  if (kind === "main") {
    const existing = idea.conversations.find((conversation) => conversation.kind === "main" && conversation.active);
    if (existing) return activateConversation(existing);
  }
  const created = await bridge.request({ type: "new_session" }, 30000);
  if (!created.success || created.data?.cancelled) throw new Error(created.error || "New conversation was cancelled.");
  const state = await bridge.request({ type: "get_state" });
  const sessionId = state.data?.sessionId;
  if (!sessionId) throw new Error("Pi did not return a session id.");
  const conversation = registry.bindConversation({
    ideaId,
    sessionId,
    sessionFile: state.data?.sessionFile || null,
    workspace: workspacePath,
    kind,
  });
  const bound = await bridge.request({ type: "prompt", message: `/idea-bind ${ideaId} ${kind}` });
  if (!bound.success) throw new Error(bound.error || "Pi-Idea binding failed.");
  const reboundState = await bridge.request({ type: "get_state" });
  return registry.bindConversation({
    ideaId,
    sessionId,
    sessionFile: reboundState.data?.sessionFile || conversation.sessionFile,
    workspace: workspacePath,
    kind,
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${options.host}:${options.port}`}`);
    if (request.method === "GET" && serveStatic(url.pathname, response)) return;

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      const unsubscribe = bridge.subscribe(response);
      const heartbeat = setInterval(() => response.write(": ping\n\n"), 15000);
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      const [state, messages, stats, commands, idea] = await Promise.all([
        bridge.request({ type: "get_state" }),
        bridge.request({ type: "get_messages" }),
        bridge.request({ type: "get_session_stats" }),
        bridge.request({ type: "get_commands" }),
        ideaDocument(),
      ]);
      return json(response, 200, {
        state: state.data,
        messages: messages.data?.messages || [],
        stats: stats.data,
        commands: commands.data?.commands || [],
        idea,
        ui: bridge.projection(),
        workspace: {
          ideas: registry.listIdeas({ includeArchived: true }),
          activeConversation: registry.conversation(state.data?.sessionId),
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/workspace") {
      const state = await bridge.request({ type: "get_state" });
      return json(response, 200, {
        ideas: registry.listIdeas({ includeArchived: true }),
        activeConversation: registry.conversation(state.data?.sessionId),
      });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method || "GET") && !sameOrigin(request, options.host, server.address()?.port || options.port)) {
      return json(response, 403, { error: "Origin rejected." });
    }

    if (request.method === "POST" && url.pathname === "/api/prompt") {
      const body = await readJsonBody(request);
      const message = String(body.message || "").trim();
      if (!message) return json(response, 400, { error: "Message is required." });
      const command = { type: "prompt", message };
      if (body.streamingBehavior === "steer" || body.streamingBehavior === "followUp") {
        command.streamingBehavior = body.streamingBehavior;
      }
      const result = await bridge.request(command);
      return json(response, result.success ? 200 : 400, result);
    }

    if (request.method === "POST" && url.pathname === "/api/ideas/propose") {
      const body = await readJsonBody(request);
      const proposal = registry.proposeIdea({ ideaId: body.ideaId || null, title: body.title || null, content: body.content });
      return json(response, 200, proposal);
    }

    if (request.method === "POST" && url.pathname === "/api/ideas/confirm") {
      const body = await readJsonBody(request);
      const idea = registry.confirmProposal(body.proposalId);
      if (body.workspace) registry.addWorkspace(idea.ideaId, body.workspace, { isDefault: idea.workspaces.length === 0 });
      const activeState = await bridge.request({ type: "get_state" });
      const active = registry.conversation(activeState.data?.sessionId);
      if (active?.ideaId === idea.ideaId) await bridge.request({ type: "prompt", message: `/idea-bind ${idea.ideaId} ${active.kind}` });
      return json(response, 200, { idea: registry.getIdea(idea.ideaId) });
    }

    if (request.method === "POST" && url.pathname === "/api/ideas/reject") {
      const body = await readJsonBody(request);
      return json(response, 200, { rejected: registry.rejectProposal(body.proposalId) });
    }

    if (request.method === "POST" && url.pathname === "/api/ideas/status") {
      const body = await readJsonBody(request);
      if (!registry.setIdeaStatus(body.ideaId, body.status)) return json(response, 404, { error: "Idea not found." });
      return json(response, 200, { idea: registry.getIdea(body.ideaId) });
    }

    const ideaVersions = url.pathname.match(/^\/api\/ideas\/([^/]+)\/versions$/);
    if (request.method === "GET" && ideaVersions) {
      return json(response, 200, { versions: registry.listVersions(decodeURIComponent(ideaVersions[1])) });
    }

    const ideaDiff = url.pathname.match(/^\/api\/ideas\/([^/]+)\/versions\/(\d+)\/diff$/);
    if (request.method === "GET" && ideaDiff) {
      const diff = registry.versionDiff(decodeURIComponent(ideaDiff[1]), Number(ideaDiff[2]));
      return diff ? json(response, 200, diff) : json(response, 404, { error: "Version not found." });
    }

    const workspaceRoute = url.pathname.match(/^\/api\/ideas\/([^/]+)\/workspaces$/);
    if (request.method === "POST" && workspaceRoute) {
      const body = await readJsonBody(request);
      const workspaces = registry.addWorkspace(decodeURIComponent(workspaceRoute[1]), body.workspace, {
        label: body.label || null,
        isDefault: Boolean(body.isDefault),
      });
      return json(response, 200, { workspaces });
    }
    if (request.method === "PATCH" && workspaceRoute) {
      const body = await readJsonBody(request);
      const workspaces = registry.setDefaultWorkspace(decodeURIComponent(workspaceRoute[1]), body.workspace);
      return json(response, 200, { workspaces });
    }
    if (request.method === "DELETE" && workspaceRoute) {
      const body = await readJsonBody(request);
      const workspaces = registry.removeWorkspace(decodeURIComponent(workspaceRoute[1]), body.workspace);
      return json(response, 200, { workspaces });
    }

    const todosRoute = url.pathname.match(/^\/api\/ideas\/([^/]+)\/todos(?:\/([^/]+))?$/);
    if (todosRoute && request.method === "POST" && !todosRoute[2]) {
      const body = await readJsonBody(request);
      const todo = registry.addTodo(decodeURIComponent(todosRoute[1]), {
        text: body.text,
        status: body.status || "pending",
        source: "user-web",
        userSuggestion: body.userSuggestion || body.text,
      });
      return json(response, 200, { todo, todos: registry.listTodos(decodeURIComponent(todosRoute[1])) });
    }
    if (todosRoute && request.method === "PATCH" && todosRoute[2]) {
      const body = await readJsonBody(request);
      const ideaId = decodeURIComponent(todosRoute[1]);
      const todo = registry.updateTodo(ideaId, decodeURIComponent(todosRoute[2]), body, { actor: "user-web" });
      return json(response, 200, { todo, todos: registry.listTodos(ideaId) });
    }
    if (todosRoute && request.method === "DELETE" && todosRoute[2]) {
      const ideaId = decodeURIComponent(todosRoute[1]);
      const deleted = registry.deleteTodo(ideaId, decodeURIComponent(todosRoute[2]), { actor: "user-web" });
      return json(response, 200, { deleted, todos: registry.listTodos(ideaId) });
    }

    const workflowsRoute = url.pathname.match(/^\/api\/ideas\/([^/]+)\/workflows$/);
    if (workflowsRoute && request.method === "GET") {
      const ideaId = decodeURIComponent(workflowsRoute[1]);
      return json(response, 200, { workflows: registry.listWorkflows(ideaId) });
    }
    if (workflowsRoute && request.method === "POST") {
      const body = await readJsonBody(request);
      const ideaId = decodeURIComponent(workflowsRoute[1]);
      const workflow = registry.upsertWorkflow(ideaId, body, { actor: "web-rpc" });
      return json(response, 200, { workflow, workflows: registry.listWorkflows(ideaId) });
    }

    if (request.method === "POST" && url.pathname === "/api/conversations/open") {
      const body = await readJsonBody(request);
      const conversation = await switchOrCreateConversation({
        ideaId: body.ideaId,
        kind: body.kind === "main" ? "main" : "btw",
        workspacePath: body.workspace || workspace,
      });
      return json(response, 200, { conversation });
    }

    if (request.method === "POST" && url.pathname === "/api/conversations/switch") {
      const body = await readJsonBody(request);
      const conversation = registry.conversation(body.sessionId);
      if (!conversation) return json(response, 404, { error: "Conversation is unavailable." });
      const active = await activateConversation(conversation);
      return json(response, 200, { conversation: active });
    }

    if (request.method === "POST" && url.pathname === "/api/command") {
      const body = await readJsonBody(request);
      if (!allowedCommands.has(body.type)) return json(response, 400, { error: "Unsupported command." });
      const result = await bridge.request(body);
      return json(response, result.success ? 200 : 400, result);
    }

    if (request.method === "POST" && url.pathname === "/api/ui-response") {
      const body = await readJsonBody(request);
      if (!body.id) return json(response, 400, { error: "Dialog id is required." });
      bridge.send({ type: "extension_ui_response", ...body });
      return json(response, 200, { success: true });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, bridge.closed ? 503 : 200, { ok: !bridge.closed });
    }

    return json(response, 404, { error: "Not found." });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host}:${port}`;
  process.stdout.write(`PI_IDEA_WEB_READY ${url}\n`);
  if (options.open) {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
});

function shutdown() {
  server.close();
  bridge.close();
  registry.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export { PiRpcBridge, parseArgs };
