import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderIdeaDocument } from "../src/idea-document.js";
import { IdeaStateStore } from "../src/state-store.js";

export function sampleIdea(overrides = {}) {
  return renderIdeaDocument({
    scientificObject: "验证新算子是否能更有效地表示局部结构",
    endCriteria: "在受控任务上得到可复现的性能改进，并给出简洁机制解释",
    routeMechanism: "通过显式局部交互减少无关信息传播",
    routeBoundary: "不把改 Harness 或堆叠工程技巧当成科学贡献；反例成立时否决路线",
    ...overrides,
  });
}

export function temporaryIdeaStore({ initialized = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-idea-harness-"));
  const store = new IdeaStateStore(root);
  if (initialized) store.initializeIdeaFromContent(sampleIdea(), { actor: "test:user" });
  return {
    root,
    store,
    cleanup() {
      try {
        store.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
