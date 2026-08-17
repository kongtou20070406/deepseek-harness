import fs from "node:fs";

const inputPath = new URL("../paper-search-2026-08-13.txt", import.meta.url);
const outputPath = new URL("../../allinone.md", import.meta.url);
const text = fs.readFileSync(inputPath, "utf8").replace(/\u001b\[[0-9;]*m/g, "");

const marker = text.indexOf("per-source hits:");
if (marker < 0) throw new Error("paper-search summary marker not found");
const body = text.slice(marker);
const summary = body.match(/per-source hits:[^\r\n]+[\s\S]*?unique papers:[^\r\n]+/u)?.[0] ?? "";
const errors = text.slice(0, marker).split(/\r?\n/u).filter((line) => /Error|HTTP 429|HTTP 504/u.test(line));

const blockPattern = /^  \[(\d+)\] \(score (\d+)\)(?: \[survey\])? (.+)\r?\n([\s\S]*?)(?=\r?\n  \[\d+\] \(score|\r?\nTotal:)/gmu;
const papers = [...body.matchAll(blockPattern)].map((match) => {
  const block = match[4];
  const authors = block.match(/^      Authors: (.+)$/mu)?.[1]?.trim() ?? "";
  const facts = block.match(/^      Year: (.*?)  Citations: (.*?)  Venue: (.*)$/mu);
  const sources = block.match(/^      Sources: (.+)$/mu)?.[1]?.trim() ?? "";
  const url = block.match(/^      URL: (.+)$/mu)?.[1]?.trim() ?? "";
  if (!facts || !url) throw new Error(`malformed paper block ${match[1]}`);
  return {
    rank: Number(match[1]),
    score: Number(match[2]),
    title: match[3].trim(),
    authors,
    year: facts[1].trim(),
    citations: facts[2].trim(),
    venue: facts[3].trim(),
    sources,
    url,
  };
});
if (papers.length !== 111) throw new Error(`expected 111 papers, parsed ${papers.length}`);

const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const rows = papers.map((paper) =>
  `| ${paper.rank} | ${paper.score} | [${escapeCell(paper.title)}](${paper.url}) | ${escapeCell(paper.authors)} | ${paper.year} | ${paper.citations} | ${escapeCell(paper.venue)} | ${escapeCell(paper.sources)} |`,
).join("\n");

const errorRows = [...new Set(errors)].map((line) => `- ${line}`).join("\n");

const document = `# Pi-Idea 上下文组装论文检索总表（2026-08-13）

## 结论先行

检索结果不支持继续把 Pi-Idea 做成一个更激进的 top-k 删除器。更有证据的路线是：把 raw 作为不可变账本，把模型输入视为一次性的、可逆的证据视图；先给最小的原文证据岛，再依据 authority、时序有效性、冲突和覆盖风险逐级展开。压缩率进入约束函数，但任务成功和来源权威始终优先。

对实现最有直接约束力的工作是：ACON 的失败驱动压缩策略优化，RaMem 的回忆条件与有效性排序，ECoRAG 的最小证据集和充分性递增，LongLLMLingua 的问题感知预算与重排，HiAgent 的子目标层次，Context Length Alone Hurts 的长度因果证据，以及 LongHorizon-Harness 的显式状态/执行轨迹分离。MM-Mem 的多分辨率思想可借鉴，但其生成式 gist 不适合 Pi-Idea 的热路径。

## 对 Pi-Idea 的可执行归纳

1. **表示**：每次 loop 保留一个 dialogue 原文块和可选的 tool-evidence 原文块；另建确定性 locator，不生成语义摘要。
2. **来源通道**：把用户确认/约束、已验证工具证据、助手历史提议分开渲染，防止把用户偏好或旧提议误当事实。
3. **检索**：查询相关性只是一个信号；更高权重给 authority、有效时间、当前 goal/subgoal、显式引用、冲突与未决状态。
4. **组装**：使用证据阶梯。L0 为最小原文证据；风险上升时加入完整用户证据脊柱、同 loop 邻域、冲突候选；仍不能证明覆盖则回退 raw。
5. **顺序**：先放目标与来源规则，再放 governing evidence，最后放当前问题；避免 lost-in-the-middle，并让模型先“看证据再求解”。
6. **维护**：raw 不删；索引允许局部重建、失效和压实。旧状态以 superseded 标注，不把删除当遗忘。
7. **优化目标**：先最大化任务成功和 authority 正确率；满足非退化门后才最小化输入 token；最后才优化 CPU 延迟。

## 重点论文与采用边界

| 工作 | 可靠事实/机制 | Pi-Idea 采用 | 明确不采用 |
|---|---|---|---|
| ACON (2025/2026) | 用 raw 成功而 compressed 失败的配对轨迹产生失败反馈，再优化压缩规则；目标含任务奖励与上下文成本 | 离线、失败驱动地优化确定性组装策略 | 在线调用模型总结历史 |
| RaMem (2026) | 先锚定时间、会话、参与者等回忆条件，再做有效性排序，并保留内容召回回退 | session/时间/authority 坐标与 validity-aware fallback | 无依据地硬套上下文过滤条件 |
| ECoRAG (2025) | 从最小证据集开始，不充分则继续取证 | 确定性的覆盖证明和逐级展开 | 每轮额外调用 LLM 反思器 |
| LongLLMLingua (2024) | 问题感知预算、粗到细压缩和文档重排 | 分区预算和证据排序 | 破坏原文可追溯性的 token 级裁剪 |
| HiAgent (2025) | 以 subgoal 组织 working memory | goal/subgoal/loop 层次与邻域恢复 | 把旧子目标压成生成式摘要 |
| Context Length Alone Hurts (2025) | 即使检索完美，长度本身也可显著降低任务表现 | 软线 60%、死线 85%，短证据优先 | 认为只要窗口放得下就都塞进去 |
| LongHorizon-Harness (2026) | 显式外部任务状态；Manage-Execute-Audit；仅验证事件更新状态 | 状态与轨迹分离、verified state | 为当前模块强制引入三级模型 loop |
| MM-Mem (2026) | 多分辨率记忆与不确定时向下钻取 | 可逆的多层证据梯度 | 生成式 gist 作为唯一长期记忆 |
| Memora (2026) | 过时/无效记忆会损害智能体，评测需惩罚 obsolete reuse | supersession 和有效性权重 | 仅以 recall 衡量长期记忆 |
| Memory-R2 (2026) | 记忆操作会改变中间状态，适合从相同状态做局部配对重跑 | 冻结状态下的 matched rerollout | 把不同状态的整条轨迹粗暴归因给选择器 |

## 检索覆盖与失败

${summary}

这是一份高召回检索台账，不等同于 111 篇都被全文精读。设计主张只依赖已核验的核心论文；低分或跨领域结果保留用于追溯，不参与方案投票。

${errorRows}

## 全部 111 条去重结果

| # | 相关分 | 题目 | 作者（截断） | 年份 | 引用 | Venue | 来源/标识 |
|---:|---:|---|---|---:|---:|---|---|
${rows}
`;

fs.writeFileSync(outputPath, document, "utf8");
console.log(`Wrote ${papers.length} papers to ${outputPath.pathname}`);
