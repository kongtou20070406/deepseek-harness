import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const cliCandidates = [
  // Current project-local Pi restoration (0.84.1).
  join(workspace, "pi-idea-extension", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  // Historical benchmark checkout retained for backward compatibility.
  join(workspace, ".tools", "pi-cli", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
];
const cli = cliCandidates.find((candidate) => existsSync(candidate)) || cliCandidates[0];
const tempDir = join(here, ".tmp");

function assistantFrom(records) {
  const messages = [];
  for (const record of records) {
    if (record?.type === "message_end" && record.message?.role === "assistant") messages.push(record.message);
    if (record?.type === "agent_end" && Array.isArray(record.messages)) {
      messages.push(...record.messages.filter((message) => message?.role === "assistant"));
    }
  }
  return messages.at(-1) || null;
}

function assistantText(message) {
  return (message?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function rpcArgs(mode, {
  model = "gpt-5.6-luna",
  reasoningEffort = "low",
  systemPrompt = "You are a benchmark subject. Follow the user task exactly. Do not use tools. Return only the requested compact answer.",
} = {}) {
  return [
    cli,
    "--mode", mode,
    "--provider", "openai-codex",
    "--model", model,
    "--thinking", reasoningEffort,
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--offline",
    "--system-prompt", systemPrompt,
  ];
}

/** Readiness check only. It never prints or returns a credential and never
 * starts a model request. */
export function parsePiAuthCheck(stdout, provider, exitCode) {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout || "").trim()); } catch { /* malformed output is not readiness */ }
  return Object.freeze({
    provider,
    ready: exitCode === 0 && parsed?.status === "ready" && parsed?.provider === provider,
    exitCode,
    status: parsed?.status || "invalid-output",
    authType: parsed?.authType || null,
  });
}

export async function checkPiProviderAuth(provider = "openai-codex", { timeoutMs = 30_000 } = {}) {
  const child = spawn(process.execPath, [cli, "auth", "check", "--provider", provider, "--no-refresh", "--json"], {
    cwd: workspace,
    windowsHide: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(homedir(), ".pi", "agent") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  clearTimeout(timer);
  return parsePiAuthCheck(stdout, provider, code);
}

export async function completeLuna(prompt, {
  maxTokens = 500,
  reasoningEffort = "low",
  timeoutMs = 120_000,
} = {}) {
  await mkdir(tempDir, { recursive: true });
  const promptPath = join(tempDir, `${randomUUID()}.txt`);
  await writeFile(promptPath, String(prompt), "utf8");
  const started = performance.now();
  try {
    const args = [
      ...rpcArgs("json", { reasoningEffort }),
      "-p",
      `@${promptPath}`,
    ];
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(homedir(), ".pi", "agent") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const exitCode = await new Promise((resolveExit, reject) => {
      child.on("error", reject);
      child.on("close", resolveExit);
    });
    clearTimeout(timer);
    const records = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const message = assistantFrom(records);
    if (!message) throw new Error(`Pi JSON mode returned no assistant message (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || `Model ${message.stopReason}`);
    }
    const text = assistantText(message);
    return {
      text,
      usage: message.usage,
      stopReason: message.stopReason,
      responseModel: message.responseModel || message.model,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await unlink(promptPath).catch(() => {});
  }
}

/**
 * A warm Pi RPC process for latency experiments. Each call starts a fresh
 * ephemeral session, so process/model-registry setup is reused without leaking
 * messages between benchmark cases.
 */
export class PiRpcClient {
  constructor({
    timeoutMs = 120_000,
    model = "gpt-5.6-luna",
    reasoningEffort = "low",
    deadlineAt = null,
    systemPrompt,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.deadlineAt = deadlineAt == null ? null : Number(deadlineAt);
    this.sequence = 0;
    this.buffer = "";
    this.stderr = "";
    this.responses = new Map();
    this.active = null;
    this.closedError = null;
    const started = performance.now();
    this.child = spawn(process.execPath, rpcArgs("rpc", { model, reasoningEffort, systemPrompt }), {
      cwd: workspace,
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(homedir(), ".pi", "agent") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.started = new Promise((resolveStarted, rejectStarted) => {
      this.child.once("spawn", () => resolveStarted(Math.round(performance.now() - started)));
      this.child.once("error", rejectStarted);
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.consume();
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.child.on("close", (code) => {
      const error = new Error(`${this.model} RPC exited (${code}): ${this.stderr.slice(-500)}`);
      this.closedError = error;
      for (const waiter of this.responses.values()) waiter.reject(error);
      this.responses.clear();
      this.active?.reject(error);
      this.active = null;
    });
  }

  consume() {
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "response" && record.id && this.responses.has(record.id)) {
        const waiter = this.responses.get(record.id);
        this.responses.delete(record.id);
        waiter.resolve(record);
      }
      if (!this.active) continue;
      if (record.type === "message_update" && !this.active.firstTokenMs) {
        const event = record.assistantMessageEvent;
        if ((event?.type === "text_delta" || event?.type === "thinking_delta") && event.delta) {
          this.active.firstTokenMs = Math.round(performance.now() - this.active.started);
        }
      }
      if (record.type === "agent_end") {
        const message = assistantFrom([record]);
        const active = this.active;
        this.active = null;
        if (!message) active.reject(new Error(`${this.model} RPC returned no assistant message`));
        else active.resolve({
          text: assistantText(message),
          usage: message.usage,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage || null,
          responseModel: message.responseModel || message.model,
          firstTokenMs: active.firstTokenMs,
          ms: Math.round(performance.now() - active.started),
        });
      }
    }
  }

  request(command) {
    if (this.closedError || this.child.exitCode !== null || this.child.stdin.destroyed) {
      return Promise.reject(this.closedError || new Error(`${this.model} RPC is closed`));
    }
    const id = `pi-rpc-${++this.sequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        rejectRequest(new Error(`${this.model} RPC timeout for ${command.type}`));
      }, this.remainingTimeout());
      this.responses.set(id, {
        resolve: (record) => { clearTimeout(timer); resolveRequest(record); },
        reject: (error) => { clearTimeout(timer); rejectRequest(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  async complete(prompt) {
    this.assertBeforeDeadline();
    if (this.active) throw new Error("PiRpcClient permits only one active completion");
    const initMs = await this.started;
    const reset = await this.request({ type: "new_session" });
    if (!reset.success) throw new Error(reset.error || `${this.model} RPC could not reset session`);
    const completion = new Promise((resolveCompletion, rejectCompletion) => {
      const timer = setTimeout(() => {
        const deadlineReached = this.deadlineAt != null && Date.now() >= this.deadlineAt;
        this.active = null;
        if (deadlineReached) this.close();
        rejectCompletion(new Error(deadlineReached
          ? `${this.model} hard deadline reached`
          : `${this.model} RPC completion timeout`));
      }, this.remainingTimeout());
      this.active = {
        started: performance.now(),
        firstTokenMs: null,
        resolve: (value) => { clearTimeout(timer); resolveCompletion(value); },
        reject: (error) => { clearTimeout(timer); rejectCompletion(error); },
      };
    });
    const accepted = await this.request({ type: "prompt", message: String(prompt) });
    if (!accepted.success) {
      const error = new Error(accepted.error || `${this.model} RPC prompt rejected`);
      this.active?.reject(error);
      this.active = null;
      return await completion;
    }
    return { ...(await completion), initMs };
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }

  assertBeforeDeadline() {
    if (this.deadlineAt != null && Date.now() >= this.deadlineAt) {
      throw new Error(`${this.model} hard deadline reached`);
    }
  }

  remainingTimeout() {
    if (this.deadlineAt == null) return this.timeoutMs;
    return Math.max(1, Math.min(this.timeoutMs, this.deadlineAt - Date.now()));
  }
}

// Backward-compatible name for production/background Luna callers.
export class LunaRpcClient extends PiRpcClient {}
