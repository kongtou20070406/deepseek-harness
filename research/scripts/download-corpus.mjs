import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "..", "corpus");

const papers = [
  ["2025_EMNLP_Findings_Context_Length_Alone_Hurts.pdf", "https://aclanthology.org/2025.findings-emnlp.1264.pdf"],
  ["2024_ACL_LongLLMLingua.pdf", "https://aclanthology.org/2024.acl-long.91.pdf"],
  ["2026_ACL_Context_Interference.pdf", "https://aclanthology.org/2026.acl-long.160.pdf"],
  ["2026_ACL_Memory_Management_Impacts_Agents.pdf", "https://aclanthology.org/2026.acl-long.27.pdf"],
  ["2026_ACL_LightMem.pdf", "https://aclanthology.org/2026.acl-long.588.pdf"],
  ["2026_ACL_APEX_MEM.pdf", "https://aclanthology.org/2026.acl-long.749.pdf"],
  ["2026_ACL_SAGE_Skill_Library.pdf", "https://aclanthology.org/2026.acl-long.69.pdf"],
  ["2025_ICML_Agent_Workflow_Memory.pdf", "https://raw.githubusercontent.com/mlresearch/v267/main/assets/wang25bx/wang25bx.pdf"],
  ["2025_ICML_MINIONS.pdf", "https://raw.githubusercontent.com/mlresearch/v267/main/assets/narayan25a/narayan25a.pdf"],
  ["2025_ICML_Unified_Routing_Cascading.pdf", "https://raw.githubusercontent.com/mlresearch/v267/main/assets/dekoninck25a/dekoninck25a.pdf"],
  ["2025_ICML_AutoML_Agent.pdf", "https://raw.githubusercontent.com/mlresearch/v267/main/assets/trirat25a/trirat25a.pdf"],
  ["2026_ICML_Context_Folding.pdf", "https://openreview.net/pdf?id=lNRgWoGfYg"],
  ["2026_ICML_Subtask_Level_Memory.pdf", "https://openreview.net/pdf?id=2CoRS45Ucj"],
  ["2026_ICML_XSkill.pdf", "https://openreview.net/pdf?id=AjP1yvCyoG"],
  ["2025_NeurIPS_Multi_Agent_Failures.pdf", "https://proceedings.neurips.cc/paper_files/paper/2025/file/b1041e52d3be19f0a9bc491657488e4a-Paper-Datasets_and_Benchmarks_Track.pdf"],
  ["2024_ICLR_ToolEmu.pdf", "https://proceedings.iclr.cc/paper_files/paper/2024/file/7274ed909a312d4d869cc328ad1c5f04-Paper-Conference.pdf"],
  ["2025_ICLR_Agent_Oriented_Planning.pdf", "https://proceedings.iclr.cc/paper_files/paper/2025/file/31610e68fe41a62e460e044216a10766-Paper-Conference.pdf"],
  ["2025_ICLR_AgentSquare.pdf", "https://proceedings.iclr.cc/paper_files/paper/2025/file/0ae94013da7cd459402fd77874e09ee3-Paper-Conference.pdf"],
  ["2025_ICLR_tau_bench.pdf", "https://proceedings.iclr.cc/paper_files/paper/2025/file/1b126cc38b8638e07bef37e7b2bb72bf-Paper-Conference.pdf"],
  ["2024_NeurIPS_SWE_agent.pdf", "https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf"],
  ["2024_NeurIPS_AgentDojo.pdf", "https://proceedings.neurips.cc/paper_files/paper/2024/file/97091a5177d8dc64b1da8bf3e1f6fb54-Paper-Datasets_and_Benchmarks_Track.pdf"],
];

await mkdir(corpus, { recursive: true });

for (const [name, url] of papers) {
  const target = join(corpus, name);
  try {
    const current = await readFile(target);
    if (current.subarray(0, 5).toString("ascii") === "%PDF-") {
      process.stdout.write(`cached     ${name} ${(await stat(target)).size}\n`);
      continue;
    }
  } catch {
    // Missing files are downloaded below.
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
      headers: { "user-agent": "Pi-Idea-Harness-Research/0.1" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error(`not a PDF (${response.headers.get("content-type") ?? "unknown"})`);
    }
    await writeFile(target, bytes);
    process.stdout.write(`downloaded ${name} ${bytes.length}\n`);
  } catch (error) {
    process.stderr.write(`failed     ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
