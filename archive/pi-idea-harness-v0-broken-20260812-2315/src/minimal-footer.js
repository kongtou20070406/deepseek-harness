import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function contextLabel(percent) {
  if (percent === null) return "ctx —";
  const remaining = Math.max(0, 100 - percent);
  const digits = remaining > 0 && remaining < 10 ? 1 : 0;
  return `ctx ${remaining.toFixed(digits)}% left`;
}

function fitSides(left, right, width) {
  const columns = Math.max(1, Math.floor(Number(width) || 1));
  if (visibleWidth(right) >= columns) return truncateToWidth(right, columns, "");
  const gap = Math.max(1, columns - visibleWidth(left) - visibleWidth(right));
  if (visibleWidth(left) + gap + visibleWidth(right) <= columns) {
    return `${left}${" ".repeat(gap)}${right}`;
  }
  const leftWidth = Math.max(0, columns - visibleWidth(right) - 1);
  const fittedLeft = truncateToWidth(left, leftWidth, "");
  return `${fittedLeft}${fittedLeft ? " " : ""}${right}`;
}

/** Claude-like single-row footer: live state only; cumulative stats stay in /session. */
export function renderMinimalFooter(view, theme, width) {
  const paint = (color, value) => theme?.fg?.(color, value) ?? value;
  const leftParts = [
    `${paint("accent", "◆")} Idea`,
    view.lunaLabel ? paint(view.lunaLabel.includes("!") ? "warning" : "muted", view.lunaLabel) : null,
    paint("muted", "? /guide"),
    view.codexLabel ? paint(view.codexAvailable ? "success" : "dim", view.codexLabel) : null,
    view.roleLabel ? paint("warning", view.roleLabel) : null,
    view.pending > 0 ? paint("warning", `待确认 ${view.pending}`) : null,
  ].filter(Boolean);
  const left = leftParts.join(paint("dim", " · "));

  const percent = finitePercent(view.contextPercent);
  const contextColor = percent !== null && percent >= 85 ? "error" : percent !== null && percent >= 70 ? "warning" : "muted";
  const rightParts = [
    paint(contextColor, contextLabel(percent)),
    view.modelId ? paint("muted", view.modelId) : null,
    view.thinking ? paint("muted", view.thinking) : null,
  ].filter(Boolean);
  return [fitSides(left, rightParts.join(paint("dim", " · ")), width)];
}
