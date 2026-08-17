import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fitTuiLine(line, width) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const text = String(line ?? "");
  return visibleWidth(text) <= safeWidth
    ? text
    : truncateToWidth(text, safeWidth, "");
}

export function fitTuiLines(lines, width) {
  return lines.map((line) => fitTuiLine(line, width));
}

export { visibleWidth };
