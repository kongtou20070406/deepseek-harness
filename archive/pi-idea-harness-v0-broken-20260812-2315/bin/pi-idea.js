#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { findIdeaSpace } from "../src/paths.js";
import { IdeaStateStore } from "../src/state-store.js";

const argumentsFromUser = process.argv.slice(2);
let requestedRoot = process.cwd();
if (argumentsFromUser[0] && !argumentsFromUser[0].startsWith("-")) {
  const candidate = resolve(argumentsFromUser[0]);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    requestedRoot = candidate;
    argumentsFromUser.shift();
  }
}

const ideaRoot = findIdeaSpace(requestedRoot) ?? requestedRoot;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessExtension = resolve(packageRoot, "extensions/idea-harness.js");
let mainSessionFile = null;
let store = null;
try {
  const discovered = findIdeaSpace(ideaRoot);
  if (discovered) {
    store = new IdeaStateStore(discovered);
    if (store.isInitialized()) {
      const candidate = store.getMainSession()?.sessionFile;
      if (candidate && existsSync(candidate)) mainSessionFile = candidate;
    }
  }
} finally {
  store?.close();
}

const piCli = process.env.PI_CLI?.trim();
const piBinary = piCli ? process.execPath : process.env.PI_BIN?.trim() || "pi";
const piArguments = [
  ...(piCli ? [piCli] : []),
  // The installed local package is the normal path. Avoid loading the same
  // extension again via --extension: duplicate factories make /reload
  // ambiguous and can register duplicate commands/renderers. Keep an explicit
  // fallback only for portable, uninstalled runs.
  ...(process.env.PI_IDEA_EXPLICIT_EXTENSION === "1" ? ["--extension", harnessExtension] : []),
  "--idea",
  ...(mainSessionFile ? ["--session", mainSessionFile] : []),
  ...argumentsFromUser,
];
const needsShell = !piCli && process.platform === "win32" && !/\.(?:exe|com)$/i.test(piBinary);
const child = spawn(piBinary, piArguments, {
  cwd: ideaRoot,
  stdio: "inherit",
  shell: needsShell,
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(`无法启动 Pi：${error.message}`);
  console.error("请安装 @earendil-works/pi-coding-agent，或通过 PI_BIN 指定可执行文件。");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Pi 因信号 ${signal} 退出`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 0;
  }
});
