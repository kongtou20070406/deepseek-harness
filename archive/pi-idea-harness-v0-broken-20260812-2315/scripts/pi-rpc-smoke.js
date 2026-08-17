import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderIdeaDocument } from "../src/idea-document.js";
import { IdeaStateStore } from "../src/state-store.js";

const piCli = process.env.PI_CLI;
if (!piCli || !existsSync(piCli)) {
  throw new Error("设置 PI_CLI 为 @earendil-works/pi-coding-agent/dist/cli.js 的绝对路径");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensions = [
  resolve(scriptDir, "../extensions/idea-harness.js"),
];
const ideaRoot = mkdtempSync(join(tmpdir(), "pi-idea-rpc-smoke-"));
const sessionDir = join(ideaRoot, ".smoke-sessions");
const useGlobalPackage = process.env.PI_SMOKE_GLOBAL === "1";
const verifyCodexUsage = process.env.PI_SMOKE_USAGE === "1";
const ideaContent = renderIdeaDocument({
  scientificObject: "验证上下文压缩后科学对象是否仍保持不变",
  endCriteria: "十次压缩和恢复后 P0 内容与哈希完全一致",
  routeMechanism: "从会话外部逐字注入受保护的 Idea 前缀",
  routeBoundary: "不把摘要或检索结果当作权威 Idea",
});

const seedStore = new IdeaStateStore(ideaRoot);
try {
  seedStore.initializeIdeaFromContent(ideaContent, { actor: "smoke:user" });
} finally {
  seedStore.close();
}

const child = spawn(process.execPath, [
  piCli,
  "--mode",
  "rpc",
  "--session-dir",
  sessionDir,
  "--idea",
  ...(useGlobalPackage ? [] : extensions.flatMap((extension) => ["--extension", extension])),
  ...(verifyCodexUsage ? ["--provider", "openai-codex", "--model", "gpt-5.4"] : []),
], {
  cwd: ideaRoot,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
let commandsVerified = false;
let widgetVerified = false;
let usagePromptSent = false;
let usageVerified = !verifyCodexUsage;
let usageCommandCompleted = !verifyCodexUsage;
let finished = false;

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const completion = new Promise((resolveCompletion, rejectCompletion) => {
  const timeout = setTimeout(() => rejectCompletion(new Error(`Pi RPC smoke test timed out\n${stderr}`)), 20_000);
  timeout.unref?.();

  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (error) rejectCompletion(error);
    else resolveCompletion();
  }

  function finishWhenReady() {
    if (commandsVerified && widgetVerified && verifyCodexUsage && !usagePromptSent) {
      usagePromptSent = true;
      send({ id: "usage", type: "prompt", message: "/usage" });
      return;
    }
    if (commandsVerified && widgetVerified && usageVerified && usageCommandCompleted) {
      // On Windows, Pi 0.84.1 can trip a libuv double-close assertion when
      // stdin reaches EOF immediately after an RPC dialog command. The live
      // optional probe has already completed at this point, so resolve and
      // let the outer finally terminate the child instead of testing that
      // unrelated shutdown path here.
      if (verifyCodexUsage) finish();
      else child.stdin.end();
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        finish(new Error(`Pi RPC emitted non-JSON output: ${line}`));
        return;
      }

      if (event.type === "extension_ui_request") {
        if (event.method === "setWidget" && event.widgetLines?.some((line) => line.includes("Idea") && line.includes("/guide"))) {
          widgetVerified = true;
          finishWhenReady();
        } else if (event.method === "confirm") {
          send({ type: "extension_ui_response", id: event.id, confirmed: true });
        } else if (event.method === "select") {
          if (verifyCodexUsage && event.title?.startsWith("当前 Pi 账户 · Codex Usage")) {
            if (!event.title.includes("来源：Codex 官方 usage endpoint")) {
              finish(new Error(`Codex Usage smoke did not reach the official current-account endpoint:\n${event.title}`));
              return;
            }
            if (event.title.includes("最近查询错误：")) {
              finish(new Error(`Codex Usage smoke returned an error:\n${event.title}`));
              return;
            }
            usageVerified = true;
            send({ type: "extension_ui_response", id: event.id, value: "关闭" });
            finishWhenReady();
          } else {
            send({ type: "extension_ui_response", id: event.id, value: "粘贴完整 P0（推荐）" });
          }
        } else if (event.method === "input") {
          send({ type: "extension_ui_response", id: event.id, cancelled: true });
        }
      }

      if (event.type === "response" && event.id === "commands") {
        const names = new Set(event.data?.commands?.map((command) => command.name));
        for (const expected of ["idea-init", "idea", "context", "luna", "think", "guide", "usage", "idea-main", "idea-takeover"]) {
          assert.equal(names.has(expected), true, `missing command ${expected}`);
        }
        commandsVerified = true;
        finishWhenReady();
      } else if (event.type === "response" && event.id === "usage") {
        if (!event.success) {
          finish(new Error(`Codex Usage command failed: ${event.error ?? "unknown RPC error"}`));
          return;
        }
        usageCommandCompleted = true;
        finishWhenReady();
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", finish);
  child.on("exit", (code) => {
    if (code !== 0) finish(new Error(`Pi exited with ${code}\n${stderr}`));
    else if (!commandsVerified || !widgetVerified || !usageVerified || !usageCommandCompleted) finish(new Error("Pi exited before smoke assertions completed"));
    else finish();
  });
});

try {
  send({ id: "commands", type: "get_commands" });
  await completion;
  const store = new IdeaStateStore(ideaRoot);
  try {
    assert.equal(store.isInitialized(), true);
    assert.equal(store.getCurrentIdea().content, ideaContent);
    assert.ok(store.getMainSession()?.sessionId);
    assert.equal(store.verifyEventChain(), true);
  } finally {
    store.close();
  }
  console.log(
    `Pi RPC smoke passed: ${useGlobalPackage ? "global package" : "explicit extension"}, Idea/Usage commands, visible widget, main-session binding${verifyCodexUsage ? ", live Codex Usage query" : ""}.`,
  );
} finally {
  if (!child.killed && child.exitCode === null) {
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
    ]);
  }
  rmSync(ideaRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
