import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export const IDEA_FILE = "IDEA.md";
export const HARNESS_DIR = ".harness";
export const STATE_FILE = "state.sqlite";
export const IDEA_SOURCE_FILE = "IDEA_SOURCE.md";
export const P1_FILE = "P1.md";

export function ideaPaths(root) {
  const resolvedRoot = resolve(root);
  const harnessDir = join(resolvedRoot, HARNESS_DIR);
  return {
    root: resolvedRoot,
    idea: join(resolvedRoot, IDEA_FILE),
    harnessDir,
    state: join(harnessDir, STATE_FILE),
    source: join(harnessDir, IDEA_SOURCE_FILE),
    p1: join(harnessDir, P1_FILE),
    evidence: join(resolvedRoot, "evidence"),
    artifacts: join(resolvedRoot, "artifacts"),
  };
}

export function ensureIdeaDirectories(root) {
  const paths = ideaPaths(root);
  mkdirSync(paths.harnessDir, { recursive: true });
  mkdirSync(paths.evidence, { recursive: true });
  mkdirSync(paths.artifacts, { recursive: true });
  return paths;
}

export function findIdeaSpace(startPath) {
  let current = resolve(startPath);
  const volumeRoot = parse(current).root;
  while (true) {
    const paths = ideaPaths(current);
    if (existsSync(paths.idea) || existsSync(paths.state)) return current;
    if (current === volumeRoot) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizedForComparison(path) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(left, right) {
  return normalizedForComparison(left) === normalizedForComparison(right);
}

export function resolveToolPath(cwd, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return resolve(cwd, value);
}

export function protectedIdeaPaths(root) {
  const paths = ideaPaths(root);
  return [paths.idea, paths.state, paths.source, paths.p1];
}

export function isProtectedPath(root, candidate) {
  if (!candidate) return false;
  return protectedIdeaPaths(root).some((target) => samePath(target, candidate));
}
