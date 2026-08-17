# 小于 0.5B 的本地模型如何服务上下文组装

更新：2026-08-13

## 决策

不先训练通用小语言模型。第一轮使用成熟的 encoder/cross-encoder INT8 模型，只重排本地 FTS 召回的 30–50 个候选；若它不能在相同 Luna 回答模型下提高任务成功率，就不进入生产。

本地模型不是上下文事实源，也不生成最终上下文。它只输出候选顺序或可缓存 retrieval cues。原文、时间、authority 与 P0 仍由确定性代码控制。

## 为什么不是 0.5B 生成模型

我们的在线任务是判别式的：给定 query 与 passage，判断相关性。cross-encoder 直接为文本对评分，通常比让小型生成模型读 prompt、生成 JSON 更快、更稳定，也更容易量化。生成模型只在离线 cue 生成可能有价值，但这一位置已有 Luna，暂时不需要增加第二个生成器。

## 成熟候选

| 候选 | 参数 | 语言/长度 | 量化形态 | 许可证 | 角色 |
|---|---:|---|---|---|---|
| Jina Reranker v2 multilingual | 278M | 多语言，1024 tokens | 官方 ONNX INT8 约 280 MB | CC-BY-NC-4.0 | 质量上界实验 |
| GTE multilingual reranker base | 306M | 75+ 语言，8192 tokens | ONNX INT8 约 341 MB | Apache-2.0 | 首选可发布方案 |
| bge-reranker-base | XLM-R base 级 | 中英，512 tokens | Q4 GGUF 约 247 MB | MIT | 中英成熟对照 |
| mMARCO mMiniLMv2-L12-H384 | 118M | 15 语言 | ONNX/OpenVINO INT8 | Apache-2.0 | 速度下界 |

来源：[Jina model card](https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual)、[GTE model card](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base)、[BGE model card](https://huggingface.co/BAAI/bge-reranker-base)、[mMARCO MiniLM model card](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)。

Jina 公布的统一对比中，278M 模型在多语言、长文、代码和工具检索指标上总体明显优于 118M mMiniLM；但这是模型作者报告，不等于我们的 LongMemEval 任务成功率。Jina 的非商用许可也意味着它即使胜出，也更适合作为研究上界，而不是默认发布依赖。

## Parameter Golf 能借什么

OpenAI Parameter Golf 要求整个模型与代码压缩后不超过 16 MB，在 8×H100 上十分钟内训练，以 FineWeb validation bits-per-byte 计分。它测的是语言模型的权重/训练效率，不是运行时上下文选择。[官方仓库](https://github.com/openai/parameter-golf)；[OpenAI 总结](https://openai.com/index/what-parameter-golf-taught-us/)

可借的原子：

- 质量阈值优先，再压缩参数、位宽和计算；
- QAT/混合位宽优于事后盲目压缩；
- bigram/hash 特征在极小预算下仍有价值；
- 所有冠军改动都要求可复现、多次运行和显著性，而不是看一次最好成绩。

对本项目的含义：先用 BM25F/字符 bigram/hash 做便宜召回，再让 0.1B–0.3B 判别器重排。若未来训练，目标应是一个很小的专用排序器，而不是 0.5B 聊天模型。

## 什么时候才训练

只有同时满足以下条件才训练：

1. 冻结的成熟 reranker 在 preference/科研任务上存在稳定、可归类的错误；
2. Luna retrieval cues + FTS/BM25F 仍无法补足；
3. 错误能构造成不泄漏答案的 query-positive-hard-negative triples；
4. 预先保留不可触碰的测试集，训练数据不含 LongMemEval 答案标签；
5. 训练后在任务成功率上显著增益，且查询 P95 仍小于 2 秒。

训练路线应是 teacher distillation 或 pairwise ranking 微调，然后 INT8；不要从零预训练。数据来自真实错误与 Luna 生成的 hard negatives，但必须由 raw provenance 验证正样本，避免模型学会摘要幻觉。

## 生产放置点

```text
query
  -> FTS5/BM25F + entity/time/authority channels (top 30-50)
  -> optional local reranker (hard timeout)
  -> deterministic coverage/adjacency expansion
  -> token budget packing with exact raw provenance
```

reranker 超时、未安装或崩溃时，直接使用第一阶段排序；不得等待 Luna、不得停止主 Agent。

## 验收

- CPU-only，模型常驻；冷启动单列，不计入热查询但必须可见；
- top 30 与 top 50 分别测 P50/P95、峰值内存和进程常驻内存；
- 总查询+组装 P95 <2 秒，目标 <250 ms；
- preference、temporal、knowledge-update 分类型报告任务成功率；
- 与无 reranker 条件做同题配对，回答模型和裁判固定；
- 量化版必须与 FP 版比较排序一致率和最终任务成功率，不能只报告模型大小。

当前下载试验因本机代理到 npm/Hugging Face 的 TLS handshake reset 未完成；没有关闭证书校验，也没有把未测模型接入生产。实验目录为 `research/benchmarks/local-reranker/`。
