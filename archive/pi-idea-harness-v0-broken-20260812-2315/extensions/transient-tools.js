import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import {
  TRANSIENT_TOOL_PRESENTATION,
  transientToolRenderers,
} from "../src/transient-tools.js";

const TOOL_BUILDERS = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  find: createFindTool,
  grep: createGrepTool,
  ls: createLsTool,
};

const toolCache = new Map();

function toolsFor(cwd) {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = Object.fromEntries(
      Object.entries(TOOL_BUILDERS).map(([name, build]) => [name, build(cwd)]),
    );
    toolCache.set(cwd, tools);
  }
  return tools;
}

/**
 * A narrow public-API adaptation of Pi's own built-ins. Execution still
 * delegates to Pi's exported tool factories; only transcript rendering changes.
 */
export default function transientToolsExtension(pi) {
  const initial = toolsFor(process.cwd());
  for (const name of Object.keys(TOOL_BUILDERS)) {
    const original = initial[name];
    pi.registerTool({
      ...original,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return toolsFor(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate);
      },
      ...transientToolRenderers(TRANSIENT_TOOL_PRESENTATION[name]),
    });
  }

  pi.on("session_shutdown", async () => {
    toolCache.clear();
  });
}
