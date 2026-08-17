const $ = (selector) => document.querySelector(selector);

const app = {
  state: null,
  stats: null,
  messages: [],
  ideas: [],
  activeConversation: null,
  selectedIdeaId: null,
  activeTools: new Map(),
  recentWorkers: [],
  busy: false,
  liveText: "",
  refreshTimer: null,
  view: "chat",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markdown(text) {
  const escaped = escapeHtml(text);
  const blocks = escaped.split(/```/);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return `<pre><code>${block.replace(/^\w+\n/, "")}</code></pre>`;
    return block
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
      .join("");
  }).join("");
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function textOfToolResult(message) {
  return textOfContent(message?.content);
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return String(number);
}

function timeAgo(value) {
  if (!value) return "—";
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return "—";
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function workflowStatus(status) {
  return ({ running: "运行中", waiting: "等待", blocked: "阻塞", complete: "完成", failed: "失败", cancelled: "已取消" })[status] || status || "未知";
}

function workflowProgress(row) {
  if (row?.progressTotal == null) return "";
  return `${row.progressCurrent || 0}/${row.progressTotal}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function selectedIdea() {
  return app.ideas.find((idea) => idea.ideaId === app.selectedIdeaId) || null;
}

function setConnected(connected, label = null) {
  $("#connection-dot").classList.toggle("connected", connected);
  $("#connection-label").textContent = label || (connected ? "Pi 已连接" : "Pi 连接中断");
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  $("#toast-stack").append(node);
  setTimeout(() => node.remove(), type === "error" ? 8000 : 4800);
}

function renderMessages() {
  const list = $("#message-list");
  list.querySelectorAll(".message,.tool-message").forEach((node) => node.remove());
  const visible = app.messages.filter((message) => ["user", "assistant", "toolResult", "bashExecution"].includes(message?.role));
  $("#empty-state").hidden = visible.length > 0;
  for (const message of visible) {
    if (message.role === "toolResult" || message.role === "bashExecution") {
      const block = document.createElement("div");
      block.className = "tool-message";
      const name = message.toolName || (message.role === "bashExecution" ? "shell" : "tool");
      const output = message.output || textOfToolResult(message);
      block.innerHTML = `<details><summary>${escapeHtml(name)} ${message.isError ? "· error" : "· result"}</summary><pre>${escapeHtml(output)}</pre></details>`;
      list.append(block);
      continue;
    }
    const text = textOfContent(message.content);
    if (!text && message.role === "assistant") continue;
    const block = document.createElement("article");
    block.className = `message ${message.role}`;
    block.innerHTML = `<div class="message-role">${message.role === "user" ? "空投" : "Pi · Sol"}</div><div class="message-content">${markdown(text)}</div>`;
    list.append(block);
  }
  if (app.liveText) renderLiveAssistant();
}

function renderLiveAssistant() {
  let node = $("#live-assistant");
  if (!node) {
    node = document.createElement("article");
    node.id = "live-assistant";
    node.className = "message assistant";
    node.innerHTML = '<div class="message-role">Pi · Sol</div><div class="message-content streaming-caret"></div>';
    $("#message-list").append(node);
  }
  node.querySelector(".message-content").innerHTML = markdown(app.liveText);
  node.querySelector(".message-content").classList.add("streaming-caret");
  $("#message-list").scrollTop = $("#message-list").scrollHeight;
}

function renderIdeas() {
  $("#idea-count").textContent = String(app.ideas.length);
  const list = $("#idea-list");
  list.replaceChildren();
  for (const idea of app.ideas) {
    const main = idea.conversations.find((item) => item.kind === "main" && item.active);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `idea-row${idea.ideaId === app.selectedIdeaId ? " active" : ""}${idea.status === "archived" ? " archived" : ""}`;
    button.innerHTML = `<span class="idea-row-title">${escapeHtml(idea.title)}</span><span class="idea-row-meta"><span>v${idea.version}</span><span>${idea.todos.filter((todo) => todo.status !== "done").length} todo</span>${main ? '<span class="main-dot">● main</span>' : ""}${idea.status === "archived" ? "<span>已归档</span>" : ""}</span>`;
    button.addEventListener("click", () => {
      app.selectedIdeaId = idea.ideaId;
      renderIdeas();
      renderIdeaPanels();
      $(".rail").classList.remove("open");
    });
    list.append(button);
  }
}

function renderIdeaPanels() {
  const idea = selectedIdea();
  if (!idea) {
    $("#idea-title").textContent = "尚未创建 Idea";
    $("#idea-modified").textContent = "—";
    $("#todo-list").innerHTML = '<div class="quiet">当前没有 Todo</div>';
    $("#workspace-list").innerHTML = '<div class="quiet">尚未关联工作区</div>';
    renderBoard();
    return;
  }
  $("#idea-title").textContent = idea.title;
  $("#idea-modified").textContent = `v${idea.version} · ${timeAgo(idea.confirmedAt)}`;
  $("#toggle-archive").textContent = idea.status === "archived" ? "恢复" : "归档";
  renderTodos(idea);
  const workspaces = $("#workspace-list");
  workspaces.replaceChildren();
  for (const item of idea.workspaces) {
    const node = document.createElement("div");
    node.className = "workspace-item";
    node.innerHTML = `<span class="workspace-name">${escapeHtml(item.label || item.workspace)}</span><span class="workspace-actions"><button type="button" class="workspace-default${item.isDefault ? " active" : ""}" title="设为默认">${item.isDefault ? "默认" : "设为默认"}</button><button type="button" class="workspace-remove" title="解除关联">×</button></span>`;
    node.title = item.workspace;
    node.querySelector(".workspace-default").addEventListener("click", async () => {
      if (item.isDefault) return;
      await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/workspaces`, { method: "PATCH", body: JSON.stringify({ workspace: item.workspace }) });
      await refreshWorkspace();
    });
    node.querySelector(".workspace-remove").addEventListener("click", async () => {
      if (!await askConfirm("解除工作区", `解除 ${item.workspace} 与此 Idea 的关联？这不会删除任何文件。`)) return;
      await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/workspaces`, { method: "DELETE", body: JSON.stringify({ workspace: item.workspace }) });
      await refreshWorkspace();
    });
    workspaces.append(node);
  }
  if (!idea.workspaces.length) workspaces.innerHTML = '<div class="quiet">尚未关联工作区</div>';
  renderBoard();
  renderWorkers();
}

function renderTodos(idea) {
  const list = $("#todo-list");
  list.replaceChildren();
  for (const todo of idea.todos) {
    const node = document.createElement("div");
    node.className = "todo-item";
    const checkbox = document.createElement("input");
    checkbox.className = "todo-check";
    checkbox.type = "checkbox";
    checkbox.checked = todo.status === "done";
    checkbox.addEventListener("change", () => updateTodo(idea.ideaId, todo.todoId, { status: checkbox.checked ? "done" : "pending" }));
    const text = document.createElement("div");
    text.className = "todo-text";
    text.innerHTML = `${escapeHtml(todo.text)}${todo.pendingModelReview ? '<span class="todo-review">下一 loop 待实践校正</span>' : ""}`;
    text.title = "点击编辑";
    text.addEventListener("click", async () => {
      const value = await askText("编辑 Todo 建议", "模型会在下一次主 loop 中结合实践修正，而不是盲从。", todo.text, false);
      if (value && value !== todo.text) await updateTodo(idea.ideaId, todo.todoId, { text: value, userSuggestion: value });
    });
    const remove = document.createElement("button");
    remove.className = "todo-delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "删除";
    remove.addEventListener("click", async () => {
      if (await askConfirm("删除 Todo", `删除“${todo.text}”？审计事件仍会保留。`)) {
        await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/todos/${encodeURIComponent(todo.todoId)}`, { method: "DELETE" });
        await refreshWorkspace();
      }
    });
    node.append(checkbox, text, remove);
    list.append(node);
  }
  if (!idea.todos.length) list.innerHTML = '<div class="quiet">当前没有 Todo</div>';
}

async function updateTodo(ideaId, todoId, patch) {
  try {
    await api(`/api/ideas/${encodeURIComponent(ideaId)}/todos/${encodeURIComponent(todoId)}`, { method: "PATCH", body: JSON.stringify(patch) });
    await refreshWorkspace();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderStats() {
  const state = app.state || {};
  const stats = app.stats || {};
  const model = state.model;
  $("#model-name").textContent = model ? `${model.provider}/${model.id}` : "未选择模型";
  $("#thinking-level").textContent = state.thinkingLevel || "—";
  $("#session-title").textContent = state.sessionName || (app.activeConversation?.kind === "btw" ? "BTW 对话" : "Pi-Idea Research");
  const usage = stats.contextUsage || {};
  const percent = Math.max(0, Math.min(100, Number(usage.percent || 0)));
  $("#context-percent").textContent = `${Math.round(percent)}%`;
  $("#context-fill").style.width = `${percent}%`;
  $("#context-fill").className = `meter-fill${percent >= 85 ? " bad" : percent >= 60 ? " warn" : ""}`;
  $("#context-tokens").textContent = `${formatNumber(usage.tokens)} / ${formatNumber(usage.contextWindow || model?.contextWindow || 272000)}`;
  $("#context-hint").textContent = percent ? `上下文 ${Math.round(percent)}%` : "上下文等待首轮使用";
  $("#input-tokens").textContent = formatNumber(stats.tokens?.input);
  $("#output-tokens").textContent = formatNumber(stats.tokens?.output);
  $("#cache-tokens").textContent = formatNumber(stats.tokens?.cacheRead);
  $("#tool-count").textContent = formatNumber(stats.toolCalls);
  setBusy(Boolean(state.isStreaming));
}

function setBusy(value) {
  app.busy = value;
  $("#send").hidden = value;
  $("#stop").hidden = !value;
  $("#mode-hint").textContent = value ? "运行中 · 新消息将排入 follow-up" : (app.activeConversation?.kind === "btw" ? "BTW 支线" : "主对话");
}

function renderWorkers() {
  const running = [...app.activeTools.values()];
  const workflows = selectedIdea()?.workflows || [];
  const activeWorkflows = workflows.filter((row) => ["running", "waiting", "blocked"].includes(row.status));
  $("#activity-count").textContent = String(running.length + activeWorkflows.length);
  const list = $("#activity-list");
  list.replaceChildren();
  for (const row of workflows.slice(0, 8)) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `activity-item workflow-activity status-${row.status}`;
    const progress = workflowProgress(row);
    node.innerHTML = `<div class="activity-name">${escapeHtml(row.kind === "workflow" ? "Workflow" : "Worker")} · ${escapeHtml(row.label)}</div><div class="activity-meta">${escapeHtml(workflowStatus(row.status))}${progress ? ` · ${escapeHtml(progress)}` : ""} · ${escapeHtml(row.model || "unknown")}:${escapeHtml(row.reasoningEffort || "unknown")}</div>`;
    node.addEventListener("click", () => showDetail(`${row.kind === "workflow" ? "Workflow" : "Worker"} · ${row.label}`, JSON.stringify(row, null, 2)));
    list.append(node);
  }
  for (const worker of running) {
    const node = document.createElement("div");
    node.className = "activity-item";
    node.innerHTML = `<div class="activity-name">${escapeHtml(worker.name)}</div><div class="activity-meta">运行中 · ${escapeHtml(worker.summary || "等待进度")}</div>`;
    list.append(node);
  }
  if (!running.length && !workflows.length) list.innerHTML = '<div class="quiet">当前没有工具或 Workflow 记录</div>';
  const brief = running.map((worker) => `${worker.name}: ${worker.summary || "running"}`).join(" · ");
  $("#running-tools").hidden = !brief;
  $("#running-tools").textContent = brief;
  renderBoardWorkers();
}

function renderBoardWorkers() {
  const target = $("#board-workers");
  if (!target) return;
  const workflows = selectedIdea()?.workflows || [];
  const workers = [...app.activeTools.values(), ...app.recentWorkers.slice(0, 6)];
  target.replaceChildren();
  for (const row of workflows.slice(0, 12)) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `board-node workflow-node status-${row.status}`;
    const progress = workflowProgress(row);
    node.innerHTML = `<div class="board-node-title">${escapeHtml(row.kind === "workflow" ? "Workflow" : "Worker")} · ${escapeHtml(row.label)}</div><div class="board-node-meta">${escapeHtml(workflowStatus(row.status))}${progress ? ` · ${escapeHtml(progress)}` : ""} · ${timeAgo(row.updatedAt)}</div>`;
    node.addEventListener("click", () => showDetail(row.label, JSON.stringify(row, null, 2)));
    target.append(node);
  }
  for (const worker of workers) {
    const node = document.createElement("div");
    node.className = "board-node";
    node.innerHTML = `<div class="board-node-title">${escapeHtml(worker.name)}</div><div class="board-node-meta">${worker.status === "done" ? "完成" : worker.status === "error" ? "失败" : "运行中"} · ${escapeHtml(worker.summary || "等待事件")}</div>`;
    target.append(node);
  }
  if (!workers.length && !workflows.length) target.innerHTML = '<div class="quiet">没有 Workflow 或 worker 记录</div>';
}

function renderBoard() {
  const idea = selectedIdea();
  $("#board-title").textContent = "推进白板";
  $("#board-subtitle").textContent = idea
    ? `${idea.title} · 只帮助你梳理线索，不会进入模型上下文。`
    : "只帮助你理解研究进展；整张图不会进入模型上下文。";
  $("#board-goal").textContent = idea?.content || "尚未选择 Idea";
  const todos = $("#board-todos");
  todos.replaceChildren();
  for (const todo of idea?.todos || []) {
    const node = document.createElement("div");
    node.className = `board-node${todo.pendingModelReview ? " pending-review" : ""}`;
    node.innerHTML = `<div class="board-node-title">${escapeHtml(todo.text)}</div><div class="board-node-meta">${escapeHtml(todo.status)} · rev ${todo.revision}${todo.pendingModelReview ? " · 待实践校正" : ""}</div>`;
    todos.append(node);
  }
  if (!idea?.todos.length) todos.innerHTML = '<div class="quiet">尚无推进 Todo</div>';
  const conversations = $("#board-conversations");
  conversations.replaceChildren();
  for (const item of idea?.conversations || []) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `board-node${item.kind === "main" ? " main-conversation" : ""}`;
    node.innerHTML = `<div class="board-node-title">${item.kind === "main" ? "主对话" : "BTW"} · ${escapeHtml(item.title)}</div><div class="board-node-meta">${escapeHtml(item.workspace)} · ${timeAgo(item.lastSeenAt)}</div>`;
    node.addEventListener("click", () => switchConversation(item));
    conversations.append(node);
  }
  if (!idea?.conversations.length) conversations.innerHTML = '<div class="quiet">尚未建立对话</div>';
  renderBoardWorkers();
}

function showDetail(title, content) {
  $("#detail-title").textContent = title;
  $("#detail-content").textContent = content || "—";
  if (window.innerWidth <= 1120) $("#inspector").classList.add("open");
}

function modalBase(title, message = "") {
  $("#modal-title").textContent = title;
  $("#modal-message").textContent = message;
  $("#modal-control").replaceChildren();
  $("#modal").hidden = false;
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modal-control").replaceChildren();
  $("#modal-form").onsubmit = null;
  $("#modal-cancel").onclick = null;
}

function askText(title, message, value = "", multiline = true) {
  return new Promise((resolve) => {
    modalBase(title, message);
    const input = document.createElement(multiline ? "textarea" : "input");
    input.value = value;
    $("#modal-control").append(input);
    input.focus();
    $("#modal-form").onsubmit = (event) => { event.preventDefault(); const result = input.value.trim(); closeModal(); resolve(result || null); };
    $("#modal-cancel").onclick = () => { closeModal(); resolve(null); };
  });
}

function askConfirm(title, message, content = null) {
  return new Promise((resolve) => {
    modalBase(title, message);
    if (content != null) {
      const pre = document.createElement("pre");
      pre.textContent = content;
      $("#modal-control").append(pre);
    }
    $("#modal-form").onsubmit = (event) => { event.preventDefault(); closeModal(); resolve(true); };
    $("#modal-cancel").onclick = () => { closeModal(); resolve(false); };
  });
}

function askSelect(title, message, options) {
  return new Promise((resolve) => {
    modalBase(title, message);
    const select = document.createElement("select");
    for (const option of options) select.add(new Option(option, option));
    $("#modal-control").append(select);
    select.focus();
    $("#modal-form").onsubmit = (event) => { event.preventDefault(); const result = select.value; closeModal(); resolve(result); };
    $("#modal-cancel").onclick = () => { closeModal(); resolve(null); };
  });
}

async function refreshWorkspace() {
  const data = await api("/api/workspace");
  app.ideas = data.ideas || [];
  app.activeConversation = data.activeConversation || null;
  if (!app.selectedIdeaId || !app.ideas.some((idea) => idea.ideaId === app.selectedIdeaId)) {
    app.selectedIdeaId = app.activeConversation?.ideaId || app.ideas[0]?.ideaId || null;
  }
  renderIdeas();
  renderIdeaPanels();
}

async function refreshBootstrap({ messages = true } = {}) {
  const data = await api("/api/bootstrap");
  app.state = data.state;
  app.stats = data.stats;
  if (messages) app.messages = data.messages || [];
  app.ideas = data.workspace?.ideas || [];
  app.activeConversation = data.workspace?.activeConversation || null;
  if (!app.selectedIdeaId) app.selectedIdeaId = app.activeConversation?.ideaId || app.ideas[0]?.ideaId || null;
  renderStats();
  renderIdeas();
  renderIdeaPanels();
  if (messages) renderMessages();
}

function scheduleRefresh() {
  clearTimeout(app.refreshTimer);
  app.refreshTimer = setTimeout(() => refreshBootstrap().catch((error) => toast(error.message, "error")), 120);
}

async function handleExtensionUi(event) {
  if (event.method === "notify") {
    toast(event.message, event.notifyType || "info");
    showDetail("Pi-Idea", event.message);
    return;
  }
  if (["setStatus", "setWidget", "setTitle", "set_editor_text"].includes(event.method)) return;
  let response = { id: event.id };
  if (event.method === "confirm") {
    const confirmed = await askConfirm(event.title || "需要确认", event.message || "");
    response.confirmed = confirmed;
  } else if (event.method === "select") {
    const value = await askSelect(event.title || "请选择", event.message || "", event.options || []);
    if (value == null) response.cancelled = true; else response.value = value;
  } else if (event.method === "input" || event.method === "editor") {
    const value = await askText(event.title || "请输入", event.placeholder || "", event.prefill || "", event.method === "editor");
    if (value == null) response.cancelled = true; else response.value = value;
  }
  await api("/api/ui-response", { method: "POST", body: JSON.stringify(response) });
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.onopen = () => setConnected(true);
  events.onerror = () => setConnected(false);
  events.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "bridge_ready") return setConnected(true);
    if (event.type === "agent_start") setBusy(true);
    if (event.type === "agent_settled") {
      setBusy(false);
      app.liveText = "";
      scheduleRefresh();
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_start" && !app.liveText) app.liveText = "";
      if (delta?.type === "text_delta") {
        app.liveText += delta.delta || "";
        renderLiveAssistant();
      }
    }
    if (event.type === "message_end") {
      app.liveText = "";
      scheduleRefresh();
    }
    if (event.type === "tool_execution_start") {
      app.activeTools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, summary: summarizeArgs(event.args), status: "running" });
      renderWorkers();
    }
    if (event.type === "tool_execution_update") {
      const item = app.activeTools.get(event.toolCallId);
      if (item) item.summary = summarizeResult(event.partialResult) || item.summary;
      renderWorkers();
    }
    if (event.type === "tool_execution_end") {
      const item = app.activeTools.get(event.toolCallId) || { name: event.toolName };
      item.status = event.isError ? "error" : "done";
      item.summary = summarizeResult(event.result) || item.summary;
      app.activeTools.delete(event.toolCallId);
      app.recentWorkers.unshift(item);
      app.recentWorkers = app.recentWorkers.slice(0, 8);
      renderWorkers();
    }
    if (event.type === "extension_ui_request") handleExtensionUi(event).catch((error) => toast(error.message, "error"));
    if (event.type === "extension_error" || event.type === "bridge_error" || event.type === "pi_process_exit") {
      toast(event.error || event.message || "Pi process stopped.", "error");
    }
  };
}

function summarizeArgs(args) {
  if (!args) return "";
  const value = args.task || args.prompt || args.command || args.path || args.file_path || JSON.stringify(args);
  return String(value).replace(/\s+/g, " ").slice(0, 110);
}

function summarizeResult(result) {
  const text = textOfContent(result?.content);
  return text.replace(/\s+/g, " ").slice(0, 110);
}

async function createIdea() {
  const content = await askText("创建 Idea", "自然语言即可。保存前会先显示精确 diff，由你确认后才成为权威版本。", "", true);
  if (!content) return;
  try {
    const proposal = await api("/api/ideas/propose", { method: "POST", body: JSON.stringify({ content }) });
    if (!await askConfirm("确认新 Idea", "以下是从空版本到 v1 的精确 diff。", proposal.diffText)) {
      await api("/api/ideas/reject", { method: "POST", body: JSON.stringify({ proposalId: proposal.proposalId }) });
      return;
    }
    const confirmed = await api("/api/ideas/confirm", { method: "POST", body: JSON.stringify({ proposalId: proposal.proposalId }) });
    app.selectedIdeaId = confirmed.idea.ideaId;
    await refreshWorkspace();
    toast("Idea v1 已确认。", "info");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function editIdea() {
  const idea = selectedIdea();
  if (!idea) return;
  const content = await askText("提出 Idea 修改", "修改不会直接生效。下一步会显示相对当前版本的精确 diff。", idea.content, true);
  if (!content || content === idea.content) return;
  try {
    const proposal = await api("/api/ideas/propose", { method: "POST", body: JSON.stringify({ ideaId: idea.ideaId, title: idea.title, content }) });
    if (!await askConfirm(`确认 Idea v${idea.version + 1}`, "只有你确认后才会成为新的不可变版本。", proposal.diffText)) {
      await api("/api/ideas/reject", { method: "POST", body: JSON.stringify({ proposalId: proposal.proposalId }) });
      return;
    }
    await api("/api/ideas/confirm", { method: "POST", body: JSON.stringify({ proposalId: proposal.proposalId }) });
    await refreshWorkspace();
    toast(`Idea v${idea.version + 1} 已确认。`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function showDiffs() {
  const idea = selectedIdea();
  if (!idea) return;
  try {
    const { versions } = await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/versions`);
    const chunks = [];
    for (const version of versions) {
      const diff = await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/versions/${version.version}/diff`);
      chunks.push(`=== v${version.version} · ${version.confirmedAt} · ${version.source} ===\n${diff.diffText}`);
    }
    await askConfirm(`${idea.title} · 版本历史`, "关闭即可；此视图不会进入模型上下文。", chunks.join("\n\n"));
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openConversation(kind) {
  const idea = selectedIdea();
  if (!idea) return toast("请先选择一个 Idea。", "warning");
  try {
    await api("/api/conversations/open", { method: "POST", body: JSON.stringify({ ideaId: idea.ideaId, kind, workspace: idea.workspaces.find((item) => item.isDefault)?.workspace }) });
    await refreshBootstrap();
    switchView("chat");
    toast(kind === "main" ? "已进入唯一主对话。" : "已创建 BTW 支线；它不会取得主控制权。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function switchConversation(conversation) {
  try {
    await api("/api/conversations/switch", { method: "POST", body: JSON.stringify({ sessionId: conversation.sessionId }) });
    await refreshBootstrap();
    switchView("chat");
    toast(`已切换到${conversation.kind === "main" ? "主对话" : " BTW 支线"}。`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function switchView(view) {
  app.view = view;
  $("#chat-tab").classList.toggle("active", view === "chat");
  $("#board-tab").classList.toggle("active", view === "board");
  $("#message-list").hidden = view !== "chat";
  $(".composer-wrap").hidden = view !== "chat";
  $("#board-view").hidden = view !== "board";
  if (view === "board") renderBoard();
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#prompt");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  input.style.height = "auto";
  try {
    await api("/api/prompt", { method: "POST", body: JSON.stringify({ message, streamingBehavior: app.busy ? "followUp" : undefined }) });
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#prompt").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
});

$("#stop").addEventListener("click", () => api("/api/command", { method: "POST", body: JSON.stringify({ type: "abort" }) }).catch((error) => toast(error.message, "error")));
$("#new-idea").addEventListener("click", createIdea);
$("#new-session").addEventListener("click", () => openConversation("btw"));
$("#open-main").addEventListener("click", () => openConversation("main"));
$("#edit-idea").addEventListener("click", editIdea);
$("#show-diffs").addEventListener("click", showDiffs);
$("#show-idea").addEventListener("click", () => { const idea = selectedIdea(); if (idea) showDetail(`${idea.title} · v${idea.version}`, idea.content); });
$("#toggle-archive").addEventListener("click", async () => {
  const idea = selectedIdea();
  if (!idea) return;
  const status = idea.status === "archived" ? "active" : "archived";
  const action = status === "archived" ? "归档" : "恢复";
  if (!await askConfirm(`${action} Idea`, `${action}“${idea.title}”？历史、版本、Todo 与对话都会保留。`)) return;
  try {
    await api("/api/ideas/status", { method: "POST", body: JSON.stringify({ ideaId: idea.ideaId, status }) });
    await refreshWorkspace();
    toast(`Idea 已${action}。`);
  } catch (error) { toast(error.message, "error"); }
});
$("#add-todo").addEventListener("click", async () => {
  const idea = selectedIdea();
  if (!idea) return;
  const text = await askText("添加 Todo 建议", "它会在下一次主 loop 中被模型结合实践校正。", "", false);
  if (!text) return;
  try {
    await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/todos`, { method: "POST", body: JSON.stringify({ text }) });
    await refreshWorkspace();
  } catch (error) { toast(error.message, "error"); }
});
$("#add-workspace").addEventListener("click", async () => {
  const idea = selectedIdea();
  if (!idea) return;
  const path = await askText("关联工作区", "关联只建立 Idea 归属，不自动扩大 Pi 的文件权限。请输入绝对路径。", "", false);
  if (!path) return;
  try {
    await api(`/api/ideas/${encodeURIComponent(idea.ideaId)}/workspaces`, { method: "POST", body: JSON.stringify({ workspace: path, isDefault: idea.workspaces.length === 0 }) });
    await refreshWorkspace();
  } catch (error) { toast(error.message, "error"); }
});

document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", async () => {
  try { await api("/api/prompt", { method: "POST", body: JSON.stringify({ message: button.dataset.command }) }); }
  catch (error) { toast(error.message, "error"); }
}));
$("#chat-tab").addEventListener("click", () => switchView("chat"));
$("#board-tab").addEventListener("click", () => switchView("board"));
$("#toggle-inspector").addEventListener("click", () => $("#inspector").classList.toggle("open"));
$("#toggle-rail").addEventListener("click", () => $(".rail").classList.toggle("open"));
$("#close-inspector").addEventListener("click", () => $("#inspector").classList.remove("open"));
$("#theme-toggle").addEventListener("click", () => document.documentElement.classList.toggle("light"));
$("#clear-detail").addEventListener("click", () => showDetail("Idea 摘要", "选择左侧项目查看可追溯详情。"));
$("#thinking-level").addEventListener("click", async () => {
  try {
    await api("/api/command", { method: "POST", body: JSON.stringify({ type: "cycle_thinking_level" }) });
    await refreshBootstrap({ messages: false });
  } catch (error) { toast(error.message, "error"); }
});
$("#modal").addEventListener("click", (event) => { if (event.target === $("#modal")) $("#modal-cancel").click(); });

connectEvents();
const requestedView = new URLSearchParams(window.location.search).get("view");
if (requestedView === "board") switchView("board");
refreshBootstrap().catch((error) => { setConnected(false, "Pi 启动失败"); toast(error.message, "error"); });
