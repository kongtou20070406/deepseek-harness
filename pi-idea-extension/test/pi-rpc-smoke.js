import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const workspace = resolve(packageRoot, "..");
const node = process.execPath;
const cli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const extension = join(packageRoot, "extensions", "idea.js");

const child = spawn(node, [
  cli,
  "--mode", "rpc",
  "--no-session",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--extension", extension,
], {
  cwd: workspace,
  env: { ...process.env, PI_CODING_AGENT_DIR: join(workspace, ".harness", "pi-runtime") },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const records = [];
const waiters = new Map();

function consume() {
  while (true) {
    const index = stdout.indexOf("\n");
    if (index < 0) return;
    const line = stdout.slice(0, index).replace(/\r$/, "");
    stdout = stdout.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line);
    records.push(record);
    if (record.type === "response" && record.id && waiters.has(record.id)) {
      waiters.get(record.id)(record);
      waiters.delete(record.id);
    }
  }
}

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  consume();
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

let sequence = 0;
function request(command) {
  const id = `smoke-${++sequence}`;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`RPC timeout for ${command.type}\n${stderr}`));
    }, 15000);
    waiters.set(id, (record) => {
      clearTimeout(timer);
      resolveRequest(record);
    });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
}

try {
  const commandResponse = await request({ type: "get_commands" });
  assert.equal(commandResponse.success, true, commandResponse.error);
  const names = commandResponse.data.commands.map((item) => item.name);
  for (const name of ["idea-start", "idea-propose", "idea-confirm", "idea-state-set", "idea-state-unset", "idea-state", "idea-manifest", "idea-trace", "idea-toolbox"]) {
    assert.ok(names.includes(name), `missing /${name}`);
  }

  const proposalResponse = await request({ type: "prompt", message: "/idea-propose 自由格式科研对象与终点" });
  assert.equal(proposalResponse.success, true, proposalResponse.error);
  assert.equal(records.some((item) => item.type === "extension_error"), false);
  process.stdout.write("Pi RPC smoke passed: extension loaded, commands registered, and /idea-propose executed without a model call.\n");
} finally {
  child.stdin.end();
  child.kill();
}
