const ALLOWED_FEATURES = new Set([
  "exactReference",
  "lexicalNormalized",
  "overlap",
  "authorityWeight",
  "contextCompatibility",
  "heatNormalized",
  "recency",
  "tokenCost",
  "userAuthority",
  "toolAuthority",
  "authorityUpdate",
  "authorityPreference",
  "authorityScope",
]);

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite`);
  return result;
}

function validateNode(node, treeIndex, nodeIndex, nodeCount) {
  if (Object.hasOwn(node, "value")) return Object.freeze({ value: finite(node.value, `trees[${treeIndex}].nodes[${nodeIndex}].value`) });
  if (!ALLOWED_FEATURES.has(node.feature)) throw new Error(`Unsupported forest feature ${JSON.stringify(node.feature)}`);
  const left = Number(node.left);
  const right = Number(node.right);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 || left >= nodeCount || right >= nodeCount) {
    throw new Error(`Invalid child index at trees[${treeIndex}].nodes[${nodeIndex}]`);
  }
  return Object.freeze({ feature: node.feature, threshold: finite(node.threshold, "threshold"), left, right });
}

function compileTree(tree, treeIndex) {
  if (!Array.isArray(tree?.nodes) || tree.nodes.length === 0 || tree.nodes.length > 2047) {
    throw new Error(`trees[${treeIndex}] must contain 1..2047 nodes`);
  }
  const nodes = tree.nodes.map((node, index) => validateNode(node || {}, treeIndex, index, tree.nodes.length));
  return Object.freeze({ nodes });
}

function treeScore(tree, features) {
  let index = 0;
  for (let depth = 0; depth < 64; depth += 1) {
    const node = tree.nodes[index];
    if (Object.hasOwn(node, "value")) return node.value;
    const value = Number(features[node.feature]);
    index = (Number.isFinite(value) ? value : 0) <= node.threshold ? node.left : node.right;
  }
  throw new Error("Forest tree exceeded the maximum depth");
}

/** Compile an already-trained numeric decision forest for synchronous CPU
 * inference. It cannot inspect raw text, delete evidence, or override hard
 * authority closure; the context compiler uses its score only for soft roots. */
export function createCandidateForestReranker(model) {
  if (model?.schema !== 1) throw new Error("Candidate forest schema must be 1");
  if (!Array.isArray(model.trees) || model.trees.length === 0 || model.trees.length > 256) {
    throw new Error("Candidate forest must contain 1..256 trees");
  }
  const trees = model.trees.map(compileTree);
  const baseScore = finite(model.baseScore || 0, "baseScore");
  const learningRate = finite(model.learningRate ?? 1, "learningRate");
  const modelId = String(model.modelId || "anonymous-forest-v1").slice(0, 160);
  return Object.freeze({
    modelId,
    score(features = {}) {
      const total = trees.reduce((sum, tree) => sum + treeScore(tree, features), 0);
      return Math.tanh(baseScore + learningRate * total / trees.length);
    },
  });
}

export const CANDIDATE_FOREST_FEATURES = Object.freeze([...ALLOWED_FEATURES]);
