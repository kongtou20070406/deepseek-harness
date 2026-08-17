import { homedir } from "node:os";

import { truncateToWidth } from "@earendil-works/pi-tui";

function compactWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortenPath(value) {
  const path = String(value ?? "");
  const home = homedir();
  return path && path.toLowerCase().startsWith(home.toLowerCase()) ? `~${path.slice(home.length)}` : path;
}

function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

function firstResultLine(result) {
  return compactWhitespace(resultText(result).split("\n")[0] ?? "") || "工具执行失败";
}

function lineComponent(buildLine) {
  return {
    render(width) {
      const line = buildLine();
      if (!line) return [];
      return [truncateToWidth(line, Math.max(1, width), "…")];
    },
    invalidate() {},
  };
}

function resultComponent(buildLines) {
  return {
    render(width) {
      return buildLines().map((line) => truncateToWidth(line, Math.max(1, width), ""));
    },
    invalidate() {},
  };
}

function rowState(context) {
  if (!context.state || typeof context.state !== "object") context.state = {};
  return context.state;
}

function expandedResultLines(result, theme, { maxLines = 2_000 } = {}) {
  const text = resultText(result);
  if (!text) {
    const hasImage = result?.content?.some?.((item) => item?.type === "image");
    return hasImage ? [theme.fg("success", "  ↳ image loaded")] : [];
  }
  const lines = text.split("\n").slice(0, maxLines);
  return lines.map((line) => theme.fg("toolOutput", `  ${line}`));
}

/**
 * Public-API renderer contract:
 * - pending: one self-shell line, no large background card;
 * - successful + collapsed: zero transcript lines;
 * - failed: one compact error line remains;
 * - expanded (Ctrl+O): call and full built-in-truncated result return.
 */
export function transientToolRenderers({ title, describeArgs = () => "", expandedLines } = {}) {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = rowState(context);
      return lineComponent(() => {
        const expanded = context.expanded === true;
        if (state.completed && !state.error && !expanded) return "";
        const icon = state.error ? "✗" : state.completed ? "✓" : "✳";
        const color = state.error ? "error" : state.completed ? "success" : "accent";
        const detail = compactWhitespace(describeArgs(args, context));
        return ` ${theme.fg(color, icon)} ${theme.fg("toolTitle", title || "Tool")}${detail ? ` ${theme.fg("muted", detail)}` : ""}`;
      });
    },
    renderResult(result, options, theme, context) {
      const state = rowState(context);
      const isPartial = options?.isPartial === true;
      const isError = options?.isError === true || context.isError === true;
      if (!isPartial) {
        state.completed = true;
        state.error = isError;
        context.invalidate?.();
      }
      return resultComponent(() => {
        if (isPartial) return [];
        if (isError) return [theme.fg("error", `   ↳ ${firstResultLine(result)}`)];
        if (context.expanded !== true) return [];
        return expandedLines
          ? expandedLines(result, theme, context)
          : expandedResultLines(result, theme);
      });
    },
  };
}

export const TRANSIENT_TOOL_PRESENTATION = {
  read: {
    title: "Read",
    describeArgs: (args) => {
      const range = args.offset !== undefined || args.limit !== undefined
        ? `:${args.offset ?? 1}${args.limit !== undefined ? `-${(args.offset ?? 1) + args.limit - 1}` : ""}`
        : "";
      return `${shortenPath(args.path)}${range}`;
    },
  },
  bash: {
    title: "Bash",
    describeArgs: (args) => compactWhitespace(args.command) || "…",
  },
  edit: {
    title: "Edit",
    describeArgs: (args) => shortenPath(args.path),
    expandedLines: (result, theme) => {
      const diff = typeof result?.details?.diff === "string" ? result.details.diff : resultText(result);
      return diff.split("\n").map((line) => {
        const color = line.startsWith("+") && !line.startsWith("+++")
          ? "toolDiffAdded"
          : line.startsWith("-") && !line.startsWith("---")
            ? "toolDiffRemoved"
            : "toolDiffContext";
        return theme.fg(color, `  ${line}`);
      });
    },
  },
  write: {
    title: "Write",
    describeArgs: (args) => shortenPath(args.path),
  },
  find: {
    title: "Find",
    describeArgs: (args) => `${args.pattern ?? "*"} · ${shortenPath(args.path ?? ".")}`,
  },
  grep: {
    title: "Search",
    describeArgs: (args) => `/${args.pattern ?? ""}/ · ${shortenPath(args.path ?? ".")}`,
  },
  ls: {
    title: "List",
    describeArgs: (args) => shortenPath(args.path ?? "."),
  },
};
