import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const workspace = resolve(here, "..", "..");
const node = process.execPath;
const cli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const child = spawn(node, [
  cli,
  "--mode", "rpc",
  "--no-session",
  "--offline",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--approve",
], {
  cwd: workspace,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: join(workspace, ".harness", "pi-runtime"),
    PI_MARKDOWN_PREVIEW_REGISTER_EXPORT_TOOL: "false",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let resolveResponse;
const response = new Promise((resolveRequest) => { resolveResponse = resolveRequest; });

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  while (stdout.includes("\n")) {
    const index = stdout.indexOf("\n");
    const line = stdout.slice(0, index).replace(/\r$/, "");
    stdout = stdout.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "response" && record.id === "installed-commands") resolveResponse(record);
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

const timeout = setTimeout(() => {
  child.kill();
  throw new Error(`Installed-package RPC timeout\n${stderr}`);
}, 15000);

try {
  child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "installed-commands" })}\n`);
  const record = await response;
  assert.equal(record.success, true, record.error);
  const names = new Set(record.data.commands.map((item) => item.name));
  for (const name of [
    "idea-start", "idea-propose", "idea-confirm", "idea-manifest", "idea-context",
    "idea-workflows", "idea-dashboard", "idea-trace", "idea-toolbox",
  ]) {
    assert.ok(names.has(name), `missing installed command /${name}`);
  }
  process.stdout.write("Installed Pi package smoke passed: project-local Idea extension loaded.\n");
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
}
