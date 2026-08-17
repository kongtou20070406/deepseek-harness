import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import ideaHarnessExtension from "../extensions/idea-harness.js";
import { IdeaStateStore } from "../src/state-store.js";
import { sampleIdea } from "./helpers.js";

function mockPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const shortcuts = new Map();
  const entries = [];
  const sentUserMessages = [];
  let sessionName;
  let thinkingLevel = "medium";
  const flags = new Map([["idea", true]]);
  return {
    handlers,
    commands,
    tools,
    shortcuts,
    entries,
    sentUserMessages,
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerShortcut(shortcut, options) {
      shortcuts.set(shortcut, options);
    },
    registerFlag(name, options) {
      if (!flags.has(name)) flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
    setFlag(name, value) {
      flags.set(name, value);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(content) {
      sentUserMessages.push(content);
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(value) {
      sessionName = value;
    },
    getAllTools() {
      return [...tools.values()];
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level) {
      thinkingLevel = level;
    },
  };
}

function prepareLocalIdeaRoot(root) {
  // An active Idea may exist above the OS temp directory (for example when a
  // user's home directory is itself an Idea Space). Seed the test root with
  // an uninitialized local store so upward discovery deterministically stops
  // here without weakening the production ancestor-discovery semantics.
  const store = new IdeaStateStore(root);
  store.close();
}

function mockContext(
  root,
  {
    rawIdea = "我想做一个长期科研辅助 Harness，不能因压缩改变核心方向。",
    sessionEntries = [],
    lunaResponse = null,
    contextUsage = { contextWindow: 128_000, tokens: 0, percent: 0 },
    sessionId = "session-main",
    sessionFile = join(root, "session-main.jsonl"),
    mode = "rpc",
  } = {},
) {
  const statuses = new Map();
  const widgets = new Map();
  const notifications = [];
  let editorText = "";
  let proposalPanelStage = "panel";
  let toolsExpanded = true;
  let workingMessage = null;
  let workingVisible = null;
  let workingIndicator = null;
  let footerFactory = null;
  let lunaCompleteOptions = null;
  let switchedSessionFile = null;
  const compactCalls = [];
  const lunaModel = {
    provider: "openai-codex",
    id: "gpt-5.6-luna",
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
  const context = {
    mode,
    cwd: root,
    hasUI: true,
    model: { contextWindow: 128_000, maxTokens: 16_384 },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getEntries: () => sessionEntries,
      getBranch: () => sessionEntries,
      buildContextEntries: () => sessionEntries,
      getLeafId: () => sessionEntries.at(-1)?.id ?? null,
    },
    modelRegistry: {
      find(provider, id) {
        return provider === lunaModel.provider && id === lunaModel.id ? lunaModel : undefined;
      },
      getAll: () => [lunaModel],
      hasConfiguredAuth: () => true,
      async complete(_model, _context, options) {
        lunaCompleteOptions = options;
        const content = lunaResponse ?? JSON.stringify({ selected: [], conflicts: [], excluded: [] });
        return {
          role: "assistant",
          content: [{ type: "text", text: content }],
          provider: lunaModel.provider,
          model: lunaModel.id,
          usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 240, cost: { total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    },
    ui: {
      setStatus(key, value) {
        statuses.set(key, value);
      },
      setFooter(value) {
        footerFactory = value ?? null;
      },
      setWidget(key, value) {
        widgets.set(key, value);
      },
      setToolsExpanded(value) {
        toolsExpanded = value;
      },
      setWorkingMessage(value) {
        workingMessage = value ?? null;
      },
      setWorkingVisible(value) {
        workingVisible = value;
      },
      setWorkingIndicator(value) {
        workingIndicator = value ?? null;
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      async editor(title, prefill) {
        if (title.startsWith("直接告诉 AI")) return rawIdea;
        return prefill;
      },
      async select(title, options) {
        if (title.startsWith("Idea 初始化候选待确认")) return "确认并冻结为 P0";
        if (title.startsWith("思考等级")) return options.find((item) => item.endsWith("high"));
        if (title.startsWith("Idea ") && options.some((item) => item.startsWith("审查待确认修改"))) {
          if (proposalPanelStage === "panel") {
            proposalPanelStage = "proposal";
            return options.find((item) => item.startsWith("审查待确认修改"));
          }
          return "关闭";
        }
        if (title.startsWith("Idea 变更提案") && proposalPanelStage === "proposal") {
          proposalPanelStage = "done";
          return "确认修改";
        }
        return options.at(-1);
      },
      async confirm() {
        return true;
      },
      setEditorText(value) {
        editorText = value;
      },
    },
    getContextUsage: () => contextUsage,
    getSystemPrompt: () => "You are Pi.",
    abort() {
      context.aborted = true;
    },
    compact(options) {
      compactCalls.push(options);
    },
    async switchSession(file) {
      switchedSessionFile = file;
    },
    statuses,
    widgets,
    notifications,
    get editorText() {
      return editorText;
    },
    get toolsExpanded() {
      return toolsExpanded;
    },
    get workingMessage() {
      return workingMessage;
    },
    get workingVisible() {
      return workingVisible;
    },
    get workingIndicator() {
      return workingIndicator;
    },
    get footerFactory() {
      return footerFactory;
    },
    get lunaCompleteOptions() {
      return lunaCompleteOptions;
    },
    get compactCalls() {
      return compactCalls;
    },
    get switchedSessionFile() {
      return switchedSessionFile;
    },
  };
  return context;
}

test("Pi extension uses AI-organized initialization, visible UI, /think, and user-only commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-"));
  prepareLocalIdeaRoot(root);
  const pi = mockPi();
  const ctx = mockContext(root);
  ideaHarnessExtension(pi);
  try {
    for (const command of ["idea-init", "idea", "context", "luna", "think", "guide", "usage", "idea-main", "idea-takeover"]) {
      assert.ok(pi.commands.has(command), `missing command ${command}`);
    }
    assert.ok(pi.tools.has("idea_prepare_initialization"));
    assert.ok(pi.tools.has("idea_propose_change"));
    assert.equal(pi.tools.has("luna_refresh_context"), false);
    assert.equal(pi.tools.has("idea_commit_change"), false);
    assert.ok(pi.shortcuts.has("alt+t"));

    await pi.commands.get("idea-init").handler("", ctx);
    assert.equal(existsSync(join(root, "IDEA.md")), false);
    assert.equal(pi.sentUserMessages.length, 1);
    assert.match(pi.sentUserMessages[0], /不要求任何固定标题或格式/);
    assert.match(ctx.widgets.get("idea-harness-entry")[0], /未初始化/);

    await pi.tools.get("idea_prepare_initialization").execute(
      "tool-init",
      { candidate_content: sampleIdea(), rationale: "忠实整理原始目标" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(existsSync(join(root, "IDEA.md")), false);
    assert.match(ctx.widgets.get("idea-harness-entry")[0], /未初始化/);

    await pi.commands.get("idea").handler("", ctx);
    const before = readFileSync(join(root, "IDEA.md"), "utf8");
    assert.equal(before, sampleIdea());
    assert.match(ctx.widgets.get("idea-harness-entry")[0], /^◆ Idea/);
    assert.doesNotMatch(ctx.widgets.get("idea-harness-entry")[0], /Idea v1/);

    const nextCandidate = `${before}\n\n新的可证伪条件：去除局部门控后收益应消失。`;
    const proposalResult = await pi.tools.get("idea_propose_change").execute(
      "tool-1",
      {
        candidate_content: nextCandidate,
        route_changed: true,
        rationale: "让机制具备直接可验证的消融预测",
        evidence_refs: ["experiment:pilot-1"],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(proposalResult.content[0].text, /权威 IDEA\.md 没有改变/);
    assert.equal(readFileSync(join(root, "IDEA.md"), "utf8"), before);

    await pi.commands.get("idea").handler("", ctx);
    const after = readFileSync(join(root, "IDEA.md"), "utf8");
    assert.equal(after, nextCandidate);
    const verificationStore = new IdeaStateStore(root);
    try {
      assert.equal(verificationStore.getCurrentIdea().routeVersion, 2);
    } finally {
      verificationStore.close();
    }

    await pi.commands.get("think").handler("", ctx);
    assert.equal(pi.getThinkingLevel(), "high");
    assert.match(ctx.widgets.get("idea-harness-entry")[0], /思考 high/);

    const contextHandler = pi.handlers.get("context")[0];
    const injected = await contextHandler(
      { type: "context", messages: [{ role: "user", content: "运行消融", timestamp: 2 }] },
      ctx,
    );
    assert.equal(injected.messages[0].content.slice(0, after.length), after);
    const manifestStore = new IdeaStateStore(root);
    try {
      const manifest = manifestStore.getLatestContextManifest();
      assert.ok(manifest.tokens.dynamic > 0);
      assert.ok(manifest.sources.some((source) => source.source === "pi:active-session-branch"));
      assert.equal(manifest.tokens.luna, 0);
    } finally {
      manifestStore.close();
    }

    const toolCallHandler = pi.handlers.get("tool_call")[0];
    const blocked = await toolCallHandler(
      { type: "tool_call", toolName: "write", input: { path: join(root, "IDEA.md") } },
      ctx,
    );
    assert.equal(blocked.block, true);
  } finally {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TUI startup installs the two-row Harness footer with context composition", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-footer-"));
  prepareLocalIdeaRoot(root);
  const seeded = new IdeaStateStore(root);
  seeded.initializeIdeaFromContent(sampleIdea(), { actor: "test:user" });
  seeded.updateP1("当前阶段：真实对话评测", { actor: "test:main" });
  seeded.close();

  const pi = mockPi();
  const ctx = mockContext(root, { mode: "tui" });
  ctx.ui.theme = { fg: (_color, value) => value };
  ideaHarnessExtension(pi);
  try {
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(typeof ctx.footerFactory, "function");

    const footer = ctx.footerFactory(
      { requestRender() {} },
      ctx.ui.theme,
      { onBranchChange: () => () => {} },
    );
    assert.match(footer.render(180)[0], /◆ Idea/);
    assert.match(footer.render(180)[1], /CTX —/);

    await pi.handlers.get("context")[0](
      { type: "context", messages: [{ role: "user", content: "评估长期记忆", timestamp: 2 }] },
      ctx,
    );
    const lines = footer.render(180);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /CTX .*Idea .*阶段 .*对话 .*系统 .*工具/);
  } finally {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi native compaction is scheduled early and indexed as semantic research blocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-native-compaction-"));
  prepareLocalIdeaRoot(root);
  const seeded = new IdeaStateStore(root);
  seeded.initializeIdeaFromContent(sampleIdea(), { actor: "test:user" });
  seeded.close();

  const pi = mockPi();
  const ctx = mockContext(root, {
    contextUsage: { contextWindow: 128_000, tokens: 60_000, percent: 46.875 },
  });
  ideaHarnessExtension(pi);
  try {
    const sessionStart = pi.handlers.get("session_start")[0];
    await sessionStart({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(ctx.toolsExpanded, false);
    assert.equal(ctx.workingVisible, true);
    assert.equal(ctx.workingMessage, "正在处理…");
    assert.equal(ctx.workingIndicator.frames.length, 6);

    await pi.handlers.get("agent_settled")[0]({ type: "agent_settled" }, ctx);
    await pi.handlers.get("agent_settled")[0]({ type: "agent_settled" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.compactCalls.length, 1);
    assert.match(ctx.compactCalls[0].customInstructions, /\[FINDINGS\]/);
    assert.match(ctx.compactCalls[0].customInstructions, /\[OPERATIONS\]/);

    const before = pi.handlers.get("session_before_compact")[0];
    await before({ type: "session_before_compact", reason: "manual", willRetry: false, preparation: { tokensBefore: 60_000 } }, ctx);
    const summary = [
      "## Progress",
      "### [FINDINGS]", "去掉门控后收益消失。",
      "### [HYPOTHESES]", "收益来自局部交互。",
      "### [CONFLICTS]", "尚缺跨数据集验证。",
      "### [OPERATIONS]", "运行 artifacts/ablation.json。",
      "### [DECISIONS]", "暂不扩展通用工具。",
      "### [OPEN_LOOP]", "复现实验并检查方差。",
    ].join("\n");
    const compact = pi.handlers.get("session_compact")[0];
    await compact({
      type: "session_compact",
      reason: "manual",
      fromExtension: false,
      compactionEntry: { id: "cmp-1", summary, tokensBefore: 60_000, timestamp: Date.now() },
    }, ctx);
    const verificationStore = new IdeaStateStore(root);
    try {
      const set = verificationStore.getLatestNativeCompactionSet("session-main");
      assert.equal(set.blocks.length, 6);
      assert.deepEqual(set.blocks.map((block) => block.kind), [
        "FINDINGS", "HYPOTHESES", "CONFLICTS", "OPERATIONS", "DECISIONS", "OPEN_LOOP",
      ]);
    } finally {
      verificationStore.close();
    }
  } finally {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Idea startup resumes the registered Idea main conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-auto-main-"));
  prepareLocalIdeaRoot(root);
  const mainFile = join(root, "registered-main.jsonl");
  writeFileSync(mainFile, "", "utf8");
  const seeded = new IdeaStateStore(root);
  seeded.initializeIdeaFromContent(sampleIdea(), { actor: "test:user" });
  seeded.setMainSession("registered-main", mainFile, "test:user");
  seeded.close();
  const pi = mockPi();
  const ctx = mockContext(root, {
    sessionId: "fresh-unrequested-session",
    sessionFile: join(root, "fresh.jsonl"),
    mode: "tui",
  });
  ideaHarnessExtension(pi);
  try {
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(ctx.switchedSessionFile, mainFile);
  } finally {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary pi conversation stays unbound even when cwd is inside an Idea Space", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-ordinary-"));
  prepareLocalIdeaRoot(root);
  const seeded = new IdeaStateStore(root);
  seeded.initializeIdeaFromContent(sampleIdea(), { actor: "test:user" });
  seeded.close();
  const pi = mockPi();
  pi.setFlag("idea", false);
  const ctx = mockContext(root);
  ideaHarnessExtension(pi);
  try {
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(ctx.switchedSessionFile, null);
    const result = await pi.handlers.get("context")[0]({
      type: "context",
      messages: [{ role: "user", content: "这是普通对话", timestamp: 1 }],
    }, ctx);
    assert.equal(result, undefined);
  } finally {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization accepts formerly reserved markers as ordinary free-form text", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-freeform-"));
  prepareLocalIdeaRoot(root);
  const pi = mockPi();
  const rawIdea = "科学对象：可以这样写\n  核心机制：也可以保留旧标题\n甚至完全不写标题也可以";
  const ctx = mockContext(root, { rawIdea });
  ideaHarnessExtension(pi);
  try {
    await pi.commands.get("idea-init").handler("", ctx);
    const draftStore = new IdeaStateStore(root);
    try {
      assert.equal(draftStore.getInitializationDraft().rawContent, rawIdea);
      assert.equal(draftStore.isInitialized(), false);
    } finally {
      draftStore.close();
    }
  } finally {
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    rmSync(root, { recursive: true, force: true });
  }
});
