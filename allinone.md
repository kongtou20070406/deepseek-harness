# Pi-Idea 上下文组装论文检索总表（2026-08-13）

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

per-source hits: arxiv=40, dblp=0, open_alex=40, openreview=0, semantic_scholar=10, crossref=40
unique papers: 111 (19 cross-source duplicate records merged)

这是一份高召回检索台账，不等同于 111 篇都被全文精读。设计主张只依赖已核验的核心论文；低分或跨领域结果保留用于追溯，不参与方案投票。

- [dblp] HTTP 429; retrying in 3s (attempt 2/4)
- [dblp] Error on query 'prompt compression long context retrieval': HTTPSConnectionPool(host='dblp.org', port=443): Max retries exceeded with url: /search/publ/api?q=prompt+compression+long+context+retrieval&format=json&h=10&f=0 (Caused by ProxyError('Unable to connect to proxy', RemoteDisconnected('Remote end closed connection without response')))
- [open_alex] HTTP 504; retrying in 3s (attempt 2/4)
- [openreview] Error on query 'long-horizon LLM agent memory context compression': openreview not installed. pip install openreview-py
- [openreview] Error on query 'LLM agent context engineering selective retrieval': openreview not installed. pip install openreview-py
- [openreview] Error on query 'agent memory consolidation forgetting long term': openreview not installed. pip install openreview-py
- [openreview] Error on query 'prompt compression long context retrieval': openreview not installed. pip install openreview-py
- [semantic_scholar] HTTP 429; retrying in 3s (attempt 2/4)
- [semantic_scholar] HTTP 429; retrying in 6s (attempt 3/4)
- [semantic_scholar] HTTP 429; retrying in 12s (attempt 4/4)
- [semantic_scholar] Error on query 'long-horizon LLM agent memory context compression': 429 Client Error:  for url: https://api.semanticscholar.org/graph/v1/paper/search?query=long-horizon+LLM+agent+memory+context+compression&offset=0&limit=10&fields=title%2Cauthors%2Cyear%2Cabstract%2CcitationCount%2Curl%2Cvenue%2CpublicationDate%2CexternalIds&year=2024-2026
- [semantic_scholar] Error on query 'agent memory consolidation forgetting long term': 429 Client Error:  for url: https://api.semanticscholar.org/graph/v1/paper/search?query=agent+memory+consolidation+forgetting+long+term&offset=0&limit=10&fields=title%2Cauthors%2Cyear%2Cabstract%2CcitationCount%2Curl%2Cvenue%2CpublicationDate%2CexternalIds&year=2024-2026
- [semantic_scholar] Error on query 'prompt compression long context retrieval': 429 Client Error:  for url: https://api.semanticscholar.org/graph/v1/paper/search?query=prompt+compression+long+context+retrieval&offset=0&limit=10&fields=title%2Cauthors%2Cyear%2Cabstract%2CcitationCount%2Curl%2Cvenue%2CpublicationDate%2CexternalIds&year=2024-2026

## 全部 111 条去重结果

| # | 相关分 | 题目 | 作者（截断） | 年份 | 引用 | Venue | 来源/标识 |
|---:|---:|---|---|---:|---:|---|---|
| 1 | 10 | [Beyond Retrieval vs Context: A Unified Evaluation Framework for External Information Management in LLM Agents](https://doi.org/10.2139/ssrn.6830898) | Alessio Rocchi | None | 0 |  | crossref  doi:10.2139/ssrn.6830898 |
| 2 | 8 | [Active Context Compression: Autonomous Memory Management in LLM Agents](https://openalex.org/W7124118353) | Nikhil Verma | 2026 | 0 | arXiv (Cornell University) | open_alex  doi:10.48550/arxiv.2601.07190 |
| 3 | 8 | [From Verbatim to Gist: Distilling Pyramidal Multimodal Memory via Semantic Information Bottleneck for Long-Horizon Video Agents](http://arxiv.org/abs/2603.01455v3) | Niu Lian, Yuting Wang, Hanshu Yao... | 2026 | 0 | arXiv | arxiv  arXiv:2603.01455 |
| 4 | 7 | [OCR-Memory: Optical Context Retrieval for Long-Horizon Agent Memory](http://arxiv.org/abs/2604.26622v1) | Jinze Li, Yang Zhang, Xin Yang... | 2026 | 0 | arXiv | arxiv,crossref  doi:10.18653/v1/2026.acl-long.474 arXiv:2604.26622 |
| 5 | 7 | [Context Collapse in Long-Horizon Agents: Benchmarking Hierarchical Memory against RAG and Summarization](https://doi.org/10.2139/ssrn.6976218) | Ebaad Raheem | None | 0 |  | crossref  doi:10.2139/ssrn.6976218 |
| 6 | 6 | [PAACE: A Plan-Aware Automated Agent Context Engineering Framework](https://www.semanticscholar.org/paper/44e2dfb31ee6c47d0f756795830c7e7e64f46a0c) | K. Yuksel | 2025 | 1 | arXiv.org | semantic_scholar  doi:10.48550/arXiv.2512.16970 arXiv:2512.16970 |
| 7 | 6 | [The UPS Theory (Balanced Memory): Why Infinite-Memory Agents Overload](https://doi.org/10.5281/zenodo.18143623) | Khan Alim ul haq | 2026 | 0 | Zenodo (CERN European Organization for Nuclear Research) | open_alex  doi:10.5281/zenodo.18143623 |
| 8 | 6 | [Active Dreaming Memory: Biologically-Inspired Episodic Consolidation for Lifelong Learning in Autonomous Agents](https://doi.org/10.5281/zenodo.17789622) | DUDEKULA, KASIM VALI | 2025 | 0 | Zenodo (CERN European Organization for Nuclear Research) | open_alex  doi:10.5281/zenodo.17789622 |
| 9 | 6 | [Oracle Agent Memory as an Enterprise Memory Substrate for Long-Horizon AI Agents](http://arxiv.org/abs/2607.13157v1) | Richmond Alake, Cesare Bernardis, Paul Cayet... | 2026 | 0 | arXiv | arxiv  arXiv:2607.13157 |
| 10 | 6 | [ACON: Optimizing Context Compression for Long-horizon LLM Agents](http://arxiv.org/abs/2510.00615v3) | Minki Kang, Wei-Ning Chen, Dongge Han... | 2025 | 0 | arXiv | arxiv  arXiv:2510.00615 |
| 11 | 6 | [Memory-R2: Fair Credit Assignment for Long-Horizon Memory-Augmented LLM Agents](http://arxiv.org/abs/2605.21768v1) | Sikuan Yan, Ahmed Bahloul, Ercong Nie... | 2026 | 0 | arXiv | arxiv  arXiv:2605.21768 |
| 12 | 6 | [Are We Ready For An Agent-Native Memory System?](http://arxiv.org/abs/2606.24775v1) | Wei Zhou, Xuanhe Zhou, Shaokun Han... | 2026 | 0 | arXiv | arxiv  arXiv:2606.24775 |
| 13 | 6 | [From Recall to Forgetting: Benchmarking Long-Term Memory for Personalized Agents](http://arxiv.org/abs/2604.20006v1) | Md Nayem Uddin, Kumar Shubham, Eduardo Blanco... | 2026 | 0 | arXiv | arxiv  arXiv:2604.20006 |
| 14 | 6 | [HierMem: Context Curation Over Context Scaling — Hierarchical Memory with Invariant Constraint Placement for Long-Horizon LLM Conversations](https://doi.org/10.21203/rs.3.rs-10055780/v1) | Yash Doke | None | 0 |  | crossref  doi:10.21203/rs.3.rs-10055780/v1 |
| 15 | 6 | [Layered Convergence in Autonomous Agent Memory: A Multi-Model Cognitive Architecture for Persistent Recall in Long-Running LLM Agents](https://doi.org/10.2139/ssrn.6616122) | Lance Harris | None | 0 |  | crossref  doi:10.2139/ssrn.6616122 |
| 16 | 5 | [HiAgent: Hierarchical Working Memory Management for Solving Long-Horizon Agent Tasks with Large Language Model](https://doi.org/10.18653/v1/2025.acl-long.1575) | Mengkang Hu, Tianxing Chen, Qiguang Chen... | 2025 | 10 |  | open_alex  doi:10.18653/v1/2025.acl-long.1575 |
| 17 | 5 | [Long Context Compression with Activation Beacon](https://doi.org/10.48550/arxiv.2401.03462) | Peitian Zhang, Zheng Liu, Shitao Xiao... | 2024 | 2 | arXiv (Cornell University) | open_alex  doi:10.48550/arxiv.2401.03462 |
| 18 | 5 | [Context Adaptive Memory-Efficient LLM Inference for Edge Multi-Agent Systems](https://doi.org/10.65109/knjy6871) | Hamza Mohammed, Hang Yin, Sai Chand Boyapati | 2025 | 0 |  | open_alex  doi:10.65109/knjy6871 |
| 19 | 5 | [ATACompressor: Adaptive Task-Aware Compression for Efficient Long-Context Processing in LLMs](https://doi.org/10.1145/3767695.3769499) | Xuancheng Li, Haitao Li, Yujia Zhou... | 2025 | 0 |  | open_alex  doi:10.1145/3767695.3769499 |
| 20 | 5 | [From Storage to Interpretation: User Perceptions, Practices, and Challenges with Long-term Memory in Agents](https://doi.org/10.1145/3765766.3765843) | Brennan Jones, Nazar Ponochevnyi, Kelsey Stemmler... | 2025 | 0 |  | open_alex  doi:10.1145/3765766.3765843 |
| 21 | 5 | [Memory Management and Contextual Consistency for Long-Running Low-Code Agents](https://doi.org/10.48550/arxiv.2509.25250) | Xu, Jiexi | 2025 | 0 | arXiv (Cornell University) | open_alex  doi:10.48550/arxiv.2509.25250 |
| 22 | 5 | [Seeing, Listening, Remembering, and Reasoning: A Multimodal Agent with Long-Term Memory](http://arxiv.org/abs/2508.09736v4) | Lin Long, Yichen He, Wentao Ye... | 2025 | 0 | arXiv | arxiv  arXiv:2508.09736 |
| 23 | 5 | [MemTrace: Probing What Final Accuracy Misses in Long-Term Memory](http://arxiv.org/abs/2606.17328v1) | Xianxuan Long, Zhikai Chen, Shenglai Zeng... | 2026 | 0 | arXiv | arxiv  arXiv:2606.17328 |
| 24 | 5 | [Cross-Family Speculative Prefill: Training-Free Long-Context Compression with Small Draft Models](http://arxiv.org/abs/2603.02631v3) | Shubhangi Upasani, Ravi Shanker Raju, Bo Li... | 2026 | 0 | arXiv | arxiv  arXiv:2603.02631 |
| 25 | 5 | [CA3-CA1 Network: How Memory Decay Shapes Consolidation and Forgetting](https://doi.org/10.21203/rs.3.rs-9584120/v1) | Lei Yang, Honghui Zhang, Zhongkui Sun | None | 0 |  | crossref  doi:10.21203/rs.3.rs-9584120/v1 |
| 26 | 5 | [Large-Scale Evaluation of MaxEntRAG-Flow: Incremental Evidence Structures for Real-Time Context Compression and Joint Probabilistic Graph Retrieval in Long-Context LLMs](https://doi.org/10.2139/ssrn.6970438) | Haranadh Gavara | None | 0 |  | crossref  doi:10.2139/ssrn.6970438 |
| 27 | 4 | [LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression](https://doi.org/10.18653/v1/2024.acl-long.91) | Huiqiang Jiang, Qianhui Wu, Xufang Luo... | 2024 | 83 | Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers) | open_alex,crossref  doi:10.18653/v1/2024.acl-long.91 |
| 28 | 4 | [OpenFOAMGPT: A retrieval-augmented large language model (LLM) agent for OpenFOAM-based computational fluid dynamics](https://www.semanticscholar.org/paper/454274b92a27bc5d97c1e80accc78095ae991cf0) | Sandeep Pandey, Ran Xu, Wenkang Wang... | 2025 | 71 | The Physics of Fluids | semantic_scholar  doi:10.1063/5.0257555 arXiv:2501.06327 |
| 29 | 4 | [Retrieval Augmented Generation or Long-Context LLMs? A Comprehensive Study and Hybrid Approach](https://doi.org/10.18653/v1/2024.emnlp-industry.66) | Zhuowan Li, Cheng Li, Mingyang Zhang... | 2024 | 36 |  | open_alex  doi:10.18653/v1/2024.emnlp-industry.66 |
| 30 | 4 | [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management](https://www.semanticscholar.org/paper/3b7c8c5e93e27be7d9456238afec00f229b7abc9) | Tobias Lindenbauer, I. Slinko, Ludwig Felder... | 2025 | 21 | arXiv.org | semantic_scholar  doi:10.48550/arXiv.2508.21433 arXiv:2508.21433 |
| 31 | 4 | [CRAKEN: Cybersecurity LLM Agent with Knowledge-Based Execution](https://www.semanticscholar.org/paper/77efd3cf71cfe7af70e2e1130286a96a67946f68) | Minghao Shao, Haoran Xi, Nanda Rani... | 2025 | 21 | arXiv.org | semantic_scholar  doi:10.48550/arXiv.2505.17107 arXiv:2505.17107 |
| 32 | 4 | [Extending Context Window of Large Language Models via Semantic Compression](https://doi.org/10.18653/v1/2024.findings-acl.306) | Weizhi Fei, Xueyan Niu, Pingyi Zhou... | 2024 | 16 |  | open_alex  doi:10.18653/v1/2024.findings-acl.306 |
| 33 | 4 | [LoCoBench-Agent: An Interactive Benchmark for LLM Agents in Long-Context Software Engineering](https://www.semanticscholar.org/paper/7e4d3b819547212190325d0771cafebcd009f241) | Jielin Qiu, Zuxin Liu, Zhiwei Liu... | 2025 | 15 | arXiv.org | semantic_scholar  doi:10.48550/arXiv.2511.13998 arXiv:2511.13998 |
| 34 | 4 | [Context Engineering for Multi-Agent LLM Code Assistants Using Elicit, NotebookLM, ChatGPT, and Claude Code](https://www.semanticscholar.org/paper/c8f9e5ccc18cf3cac782bdb6f05f025e776a7a8c) | Muhammad Haseeb Bhatti | 2025 | 9 | arXiv.org | semantic_scholar,arxiv  doi:10.48550/arXiv.2508.08322 arXiv:2508.08322 |
| 35 | 4 | [Forgetting Curve: A Reliable Method for Evaluating Memorization Capability for Long-Context Models](https://doi.org/10.18653/v1/2024.emnlp-main.269) | Xinyu Liu, Runsong Zhao, Pengcheng Huang... | 2024 | 5 |  | open_alex  doi:10.18653/v1/2024.emnlp-main.269 |
| 36 | 4 | [Perception Compressor: A Training-Free Prompt Compression Framework in Long Context Scenarios](https://doi.org/10.18653/v1/2025.findings-naacl.229) | Jiwei Tang, Jin Xu, Tingwei Lu... | 2025 | 5 | Findings of the Association for Computational Linguistics: NAACL 2025 | open_alex,crossref  doi:10.18653/v1/2025.findings-naacl.229 |
| 37 | 4 | [500xCompressor: Generalized Prompt Compression for Large Language Models](https://doi.org/10.18653/v1/2025.acl-long.1219) | Zongqian Li, Yixuan Su, Nigel Collier | 2025 | 5 |  | open_alex  doi:10.18653/v1/2025.acl-long.1219 |
| 38 | 4 | [ECoRAG: Evidentiality-guided Compression for Long Context RAG](https://doi.org/10.18653/v1/2025.findings-acl.1365) | Yeonseok Jeong, Jin-Su Kim, Dohyeon Lee... | 2025 | 3 |  | open_alex  doi:10.18653/v1/2025.findings-acl.1365 |
| 39 | 4 | [Retrieval Augmented Generation via Context Compression Techniques for Large Language Models](https://doi.org/10.31219/osf.io/ua6j5) | Pingli Jiang, Ruixuan Fan, Yating Yong | None | 2 |  | crossref  doi:10.31219/osf.io/ua6j5 |
| 40 | 4 | [An Efficient Context-Dependent Memory Framework for LLM-Centric Agents](https://doi.org/10.18653/v1/2025.naacl-industry.80) | Pengyu Gao, Jinming Zhao, Xinyue Chen... | 2025 | 1 |  | open_alex  doi:10.18653/v1/2025.naacl-industry.80 |
| 41 | 4 | [Memory Architectures in Long-Term AI Agents: Beyond Simple State Representation](https://doi.org/10.13140/rg.2.2.26486.51527) | Uchechukwu Ajuzieogu | 2025 | 1 |  | open_alex  doi:10.13140/rg.2.2.26486.51527 |
| 42 | 4 | [Forgetting in Robotic Episodic Long-Term Memory](https://doi.org/10.1109/icra57147.2024.10610299) | Joana Plewnia, Fabian Peller-Konrad, Tamim Asfour | 2024 | 1 | 2024 IEEE International Conference on Robotics and Automation (ICRA) | crossref  doi:10.1109/icra57147.2024.10610299 |
| 43 | 4 | [Efficient Prompt Compression with Evaluator Heads for Long-Context Transformer Inference](https://doi.org/10.52202/085713-5171) | Weizhi Fei, Xueyan Niu, Guoqing Xie... | 2025 | 0 | Advances in Neural Information Processing Systems 38 | open_alex,crossref  doi:10.52202/085713-5171 |
| 44 | 4 | [PolyKV: A Shared Asymmetrically-Compressed KV Cache Pool for Multi-Agent LLM Inference](http://arxiv.org/abs/2604.24971v1) | Ishan Patel, Ishan Joshi | 2026 | 0 | arXiv | arxiv  doi:10.5281/zenodo.19686729 arXiv:2604.24971 |
| 45 | 4 | [Agent Memory Below the Prompt: Persistent Q4 KV Cache for Multi-Agent LLM Inference on Edge Devices](http://arxiv.org/abs/2603.04428v1) | Yakov Pyotr Shkolnikov | 2026 | 0 | arXiv | arxiv  arXiv:2603.04428 |
| 46 | 4 | [Agents at Risk: How Users Unwittingly Undermine LLM Safety](http://arxiv.org/abs/2601.10758v3) | Fengchao Chen, Tingmin Wu, Van Nguyen... | 2026 | 0 | arXiv | arxiv  arXiv:2601.10758 |
| 47 | 4 | [From Naive RAG to Deep Agentic Retrieval: An Evolving Context Engineering Pipeline for Regulatory Compliance](http://arxiv.org/abs/2607.24791v1) | Mishca de Costa, Muhammad Saleh Anwar, Dave Mercier... | 2026 | 0 | arXiv | arxiv  arXiv:2607.24791 |
| 48 | 4 | [Agent Retrieval Bench: Evaluating Repository Context Retrieval for Coding Agents](http://arxiv.org/abs/2607.24882v1) | Bowen Qin, Yi Xie | 2026 | 0 | arXiv | arxiv  arXiv:2607.24882 |
| 49 | 4 | [A$^2$RD: Agentic Autoregressive Diffusion for Long Video Consistency](http://arxiv.org/abs/2605.06924v1) | Do Xuan Long, Yale Song, Min-Yen Kan... | 2026 | 0 | arXiv | arxiv  arXiv:2605.06924 |
| 50 | 4 | [Securing LLM-Agent Long-Term Memory Against Poisoning: Non-Malleable, Origin-Bound Authority with Machine-Checked Guarantees](http://arxiv.org/abs/2606.24322v1) | Yedidel Louck | 2026 | 0 | arXiv | arxiv  arXiv:2606.24322 |
| 51 | 4 | [SCM: Sleep-Consolidated Memory with Algorithmic Forgetting for Large Language Models](http://arxiv.org/abs/2604.20943v1) | Saish Sachin Shinde | 2026 | 0 | arXiv | arxiv  arXiv:2604.20943 |
| 52 | 4 | [Efficient Long Context Language Model Retrieval with Compression](http://arxiv.org/abs/2412.18232v2) | Minju Seo, Jinheon Baek, Seongyun Lee... | 2024 | 0 | arXiv | arxiv,crossref  doi:10.18653/v1/2025.acl-long.740 arXiv:2412.18232 |
| 53 | 4 | [SlimInfer: Accelerating Long-Context LLM Inference via Dynamic Token Pruning](http://arxiv.org/abs/2508.06447v2) | Lingkun Long, Rubing Yang, Yushi Huang... | 2025 | 0 | arXiv | arxiv  arXiv:2508.06447 |
| 54 | 4 | [M.A.K.S: Multidimensional Access Knowledge Scoring for Long-Horizon LLM Agent Memory Management](https://doi.org/10.64388/irev9i11-1718160) |  | 2026 | 0 | Iconic Research and Engineering Journals | crossref  doi:10.64388/irev9i11-1718160 |
| 55 | 4 | [Latent Governance in Long-Horizon LLM Systems: Memory Stability without a Persistent Compute Tax](https://doi.org/10.2139/ssrn.6054896) | Minsuk Kim | None | 0 |  | crossref  doi:10.2139/ssrn.6054896 |
| 56 | 4 | [Does Memory Credit Travel? Paired Factorial Audits of LLM-Agent Memory](https://doi.org/10.2139/ssrn.7160321) | Alessio Rocchi | None | 0 |  | crossref  doi:10.2139/ssrn.7160321 |
| 57 | 4 | [Context Compaction Provenance (CCP) Lab: Measuring Trust-Boundary Drift in LLM Agent Context Compaction](https://doi.org/10.2139/ssrn.6933161) | Michel Hjazeen | None | 0 |  | crossref  doi:10.2139/ssrn.6933161 |
| 58 | 4 | [CEMA Memory Fabric: Benchmarking Hierarchical Memory for Long-Context Multi-Agent Systems](https://doi.org/10.1109/siu71813.2026.11636617) | Alper Öner, Erdoğan Durukan | 2026 | 0 | 2026 34th Signal Processing and Communications Applications Conference (SIU) | crossref  doi:10.1109/siu71813.2026.11636617 |
| 59 | 4 | [Forgetting in long-term memory: Recognition does not induce the forgetting of similar objects](https://doi.org/10.1167/jov.24.10.1345) | Jamal Williams, Timothy Brady | 2024 | 0 | Journal of Vision | crossref  doi:10.1167/jov.24.10.1345 |
| 60 | 4 | [Accelerated long-term forgetting as an objective marker of subjective memory impairment in multiple sclerosis](https://doi.org/10.64898/2026.04.21.26351393) | Christina Jansen, Johannes Stalter, Sigrid Reuter... | None | 0 |  | crossref  doi:10.64898/2026.04.21.26351393 |
| 61 | 4 | [MeMAT: Multi-agent transformer with deep long-term memory, short-term memory, and persistent memory](https://doi.org/10.1016/j.neucom.2026.134438) | Gege Sun, Weiqiang Jin, Yu Zhang... | 2026 | 0 | Neurocomputing | crossref  doi:10.1016/j.neucom.2026.134438 |
| 62 | 4 | [Reviewer #2 (Public review): Brief disruption of activity in a subset of dopaminergic neurons during consolidation impairs long-term memory by fragmenting sleep](https://doi.org/10.7554/elife.104862.2.sa2) |  | 2026 | 0 |  | crossref  doi:10.7554/elife.104862.2.sa2 |
| 63 | 4 | [Reviewer #1 (Public review): Brief disruption of activity in a subset of dopaminergic neurons during consolidation impairs long-term memory by fragmenting sleep](https://doi.org/10.7554/elife.104862.2.sa3) |  | 2026 | 0 |  | crossref  doi:10.7554/elife.104862.2.sa3 |
| 64 | 4 | [Alleviating Contextual Misguidance: Response-Aware Prompt Compression for Long-Context Question Answering](https://doi.org/10.1109/taslpro.2026.3675784) | Haoyuan Wang, Zhen Wang, Wenmeng Zhou... | 2026 | 0 | IEEE Transactions on Audio, Speech and Language Processing | crossref  doi:10.1109/taslpro.2026.3675784 |
| 65 | 4 | [REAL: REtrieval-reAsoning and Logic-constructed Attention Behaviors for Long-Context KV Cache Compression](https://doi.org/10.18653/v1/2026.acl-long.1811) | Mengjie Li, Yuan Feng, Xike Xie... | 2026 | 0 | Proceedings of the 64th Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers) | crossref  doi:10.18653/v1/2026.acl-long.1811 |
| 66 | 3 | [OrcaLoca: An LLM Agent Framework for Software Issue Localization](https://www.semanticscholar.org/paper/4da39bbc36ec697bd9c6a3e8d2a54fbe563b70c3) | Zhongming Yu, Hejia Zhang, Yujie Zhao... | 2025 | 55 | International Conference on Machine Learning | semantic_scholar  doi:10.48550/arXiv.2502.00350 arXiv:2502.00350 |
| 67 | 3 | [Insights into LLM Long-Context Failures: When Transformers Know but Don’t Tell](https://doi.org/10.18653/v1/2024.findings-emnlp.447) | Muhan Gao, Taiming Lu, Kuai Yu... | 2024 | 9 |  | open_alex  doi:10.18653/v1/2024.findings-emnlp.447 |
| 68 | 3 | [Think-on-Graph 3.0: Efficient and Adaptive LLM Reasoning on Heterogeneous Graphs via Multi-Agent Dual-Evolving Context Retrieval](https://www.semanticscholar.org/paper/4abd0d21c427ed3224158a1d27e388d3c98da275) | Xiaojun Wu, Cehao Yang, Xueyuan Lin... | 2025 | 6 | arXiv.org | semantic_scholar,arxiv  doi:10.48550/arXiv.2509.21710 arXiv:2509.21710 |
| 69 | 3 | [On the Influence of Context Size and Model Choice in Retrieval-Augmented Generation Systems](https://doi.org/10.18653/v1/2025.findings-naacl.375) | Juraj Vladika, Florian Matthes | 2025 | 6 |  | open_alex  doi:10.18653/v1/2025.findings-naacl.375 |
| 70 | 3 | [In-Context Former: Lightning-fast Compressing Context for Large Language Model](https://doi.org/10.18653/v1/2024.findings-emnlp.138) | Xiangfeng Wang, Zaiyi Chen, Tong Xu... | 2024 | 5 |  | open_alex  doi:10.18653/v1/2024.findings-emnlp.138 |
| 71 | 3 | [A Multi-Agent LLM Framework for Multi-Domain Low-Resource In-Context NER via Knowledge Retrieval, Disambiguation and Reflective Analysis](https://www.semanticscholar.org/paper/f0b8c1e8ac68898cebc0d5fe43ddebd05b7fc6a2) | Wenxuan Mu, Jinzhong Ning, Di Zhao... | 2025 | 2 | AAAI Conference on Artificial Intelligence | semantic_scholar,crossref  doi:10.48550/arXiv.2511.19083 arXiv:2511.19083 |
| 72 | 3 | [NFVAgent: A Retrieval-Augmented LLM Agent for Resilient NFV Failure Recovery](https://www.semanticscholar.org/paper/15cb8cc90fa3e6789ff0e6e3c481171d365c3d7f) | Yeun Woo, Honguk Woo | 2025 | 1 | Conference on Network and Service Management | semantic_scholar  doi:10.23919/CNSM67658.2025.11297536 |
| 73 | 3 | [LCIRC: A Recurrent Compression Approach for Efficient Long-form Context and Query Dependent Modeling in LLMs](https://doi.org/10.18653/v1/2025.naacl-long.524) | Shihao An, Junyoung Sung, Wonpyo Park... | 2025 | 0 |  | open_alex  doi:10.18653/v1/2025.naacl-long.524 |
| 74 | 3 | [Integrate-and-Fire Compressor: Learning to Compress Context for LLMs Adaptively](https://doi.org/10.1109/icme59968.2025.11210203) | Yunlong Zhao, Xiyun Li, Ziyi Wang... | 2025 | 0 |  | open_alex  doi:10.1109/icme59968.2025.11210203 |
| 75 | 3 | [A dynamic model of context-based retrieval](https://doi.org/10.1016/j.jmp.2025.102957) | Madison D. Paron, James D. Paron, Michael J. Kahana | 2025 | 0 | Journal of Mathematical Psychology | open_alex  doi:10.1016/j.jmp.2025.102957 |
| 76 | 3 | [From Reading to Compressing: Exploring the Multi-document Reader for Prompt Compression](https://doi.org/10.48448/trke-1v52) | Association for Computational Linguistics 2024, Choi, Eunseong, Choi, Minjin... | 2024 | 0 | Underline Science Inc. | open_alex  doi:10.48448/trke-1v52 |
| 77 | 3 | [MRMMIA: Membership Inference Attacks on Memory in Chat Agents](http://arxiv.org/abs/2605.27825v1) | Kai Chen, Yan Pang, Tianhao Wang | 2026 | 0 | arXiv | arxiv  arXiv:2605.27825 |
| 78 | 3 | [LLandMark: A Multi-Agent Framework for Landmark-Aware Multimodal Interactive Video Retrieval](http://arxiv.org/abs/2603.02888v1) | Minh-Chi Phung, Thien-Bao Le, Cam-Tu Tran-Thi... | 2026 | 0 | arXiv | arxiv  arXiv:2603.02888 |
| 79 | 3 | [VideoRAG: Retrieval-Augmented Generation with Extreme Long-Context Videos](http://arxiv.org/abs/2502.01549v1) | Xubin Ren, Lingrui Xu, Long Xia... | 2025 | 0 | arXiv | arxiv  arXiv:2502.01549 |
| 80 | 3 | [mGTE: Generalized Long-Context Text Representation and Reranking Models for Multilingual Text Retrieval](http://arxiv.org/abs/2407.19669v2) | Xin Zhang, Yanzhao Zhang, Dingkun Long... | 2024 | 0 | arXiv | arxiv  arXiv:2407.19669 |
| 81 | 3 | [The Long Context Conundrum: Challenges and Innovations in Scaling LLM Memory](https://doi.org/10.63337/term.2025.53588) | Anjanava Biswas | 2025 | 0 | The Edge Review | crossref  doi:10.63337/term.2025.53588 |
| 82 | 3 | [Prompt Engineering: Few Shots, Chain of Thought, and Retrieval-Augmented Generation](https://doi.org/10.1145/3749421.3749427) |  | 2025 | 0 | Multi-LLM Agent Collaborative Intelligence | crossref  doi:10.1145/3749421.3749427 |
| 83 | 3 | [Indoor Lighting Intelligent Control Using Context-Aware-Based LLM Agent and Domain Knowledge Base](https://doi.org/10.33383/2025-068) | Yang Wang, Fukang Sun, Qiansheng Fang | 2026 | 0 | Light &amp; Engineering | crossref  doi:10.33383/2025-068 |
| 84 | 3 | [PromptCraft-RAG: Context-based Prompt Enhancement of Refining Query for Retrieval Augmented Generation](https://doi.org/10.54254/2755-2721/2025.tj23129) | Qinye Zhang | 2025 | 0 | Applied and Computational Engineering | crossref  doi:10.54254/2755-2721/2025.tj23129 |
| 85 | 3 | [CODEPROMPTZIP: Code-specific Prompt Compression for Retrieval-Augmented Generation in Coding Tasks with LMs](https://doi.org/10.18653/v1/2026.findings-acl.1384) | Pengfei He, Shaowei Wang, Tse-Hsun Chen | 2026 | 0 | Findings of the Association for Computational Linguistics: ACL 2026 | crossref  doi:10.18653/v1/2026.findings-acl.1384 |
| 86 | 2 | [RankRAG: Unifying Context Ranking with Retrieval-Augmented Generation in LLMs](https://doi.org/10.52202/079017-3850) | Yue Yu, Wei Ping, Zihan Liu... | 2024 | 22 |  | open_alex  doi:10.52202/079017-3850 |
| 87 | 2 | [Active forgetting and neuropsychiatric diseases](https://doi.org/10.1038/s41380-024-02521-9) | Jacob A. Berry, Dana C. Guhle, Ronald L. Davis | 2024 | 17 | Molecular Psychiatry | open_alex  doi:10.1038/s41380-024-02521-9 |
| 88 | 2 | [Context Length Alone Hurts LLM Performance Despite Perfect Retrieval](https://doi.org/10.18653/v1/2025.findings-emnlp.1264) | Yufeng Du, Minyang Tian, Srikanth Ronanki... | 2025 | 16 |  | open_alex  doi:10.18653/v1/2025.findings-emnlp.1264 |
| 89 | 2 | [BABILong: Testing the Limits of LLMs with Long Context Reasoning-in-a-Haystack](https://doi.org/10.52202/079017-3381) | Yuri Kuratov, Aydar Bulatov, Petr Anokhin... | 2024 | 6 |  | open_alex  doi:10.52202/079017-3381 |
| 90 | 2 | [RAGuard: A Novel Approach for In-Context Safe Retrieval Augmented Generation for LLMs](https://doi.org/10.1007/978-3-032-05073-1_13) | Connor Walker, Koorosh Aslansefat, Mohammed Naveed Akram... | 2025 | 2 | Lecture notes in computer science | open_alex  doi:10.1007/978-3-032-05073-1_13 |
| 91 | 2 | [In-Context Learning in LLMs to Improve Retrieval Models](https://doi.org/10.1145/3734947.3734957) | Nilanjan Sinhababu | 2024 | 1 |  | open_alex  doi:10.1145/3734947.3734957 |
| 92 | 2 | [Towards Reliable Agents: Benchmarking Customized LLM-Based Retrieval-Augmented Generation Frameworks with Deployment Validation](https://doi.org/10.18653/v1/2025.naacl-industry.53) | Kevin Wang, Karel Joshua Harjono, Ramon Lawrence | 2025 | 1 |  | open_alex  doi:10.18653/v1/2025.naacl-industry.53 |
| 93 | 2 | [Compressing Lengthy Context With UltraGist](https://doi.org/10.48550/arxiv.2405.16635) | Peitian Zhang, Zheng Liu, Shitao Xiao... | 2024 | 1 | arXiv (Cornell University) | open_alex  doi:10.48550/arxiv.2405.16635 |
| 94 | 2 | [Agent-as-a-Graph: Knowledge Graph-Based Tool and Agent Retrieval for LLM Multi-Agent Systems](https://doi.org/10.5220/0014473600004052) | Faheem Nizar, Elias Lumer, Anmol Gulati... | 2026 | 1 | Proceedings of the 18th International Conference on Agents and Artificial Intelligence | crossref  doi:10.5220/0014473600004052 |
| 95 | 2 | [Multi-agent systems for improved information retrieval - leveraging autonomous agents and LLM models](https://doi.org/10.1109/asew67777.2025.00062) | Aneta Poniszewska-Marańda, Maciej Kopa, Bożena Borowska | 2025 | 1 | 2025 40th IEEE/ACM International Conference on Automated Software Engineering Workshops (ASEW) | crossref  doi:10.1109/asew67777.2025.00062 |
| 96 | 2 | [Task Scheduling & Forgetting in Multi-Task Reinforcement Learning](https://openalex.org/W4415339057) | Marc Speckmann, Theresa Eimer | 2025 | 0 | arXiv (Cornell University) | open_alex |
| 97 | 2 | [LongCoT: Benchmarking Long-Horizon Chain-of-Thought Reasoning](http://arxiv.org/abs/2604.14140v1) | Sumeet Ramesh Motwani, Daniel Nichols, Charles London... | 2026 | 0 | arXiv | arxiv  arXiv:2604.14140 |
| 98 | 2 | [RoleRAG: Enhancing LLM Role-Playing via Graph Guided Retrieval](http://arxiv.org/abs/2505.18541v1) | Yongjie Wang, Jonathan Leung, Zhiqi Shen | 2025 | 0 | arXiv | arxiv  arXiv:2505.18541 |
| 99 | 2 | [A Plan Reuse Mechanism for LLM-Driven Agent](http://arxiv.org/abs/2512.21309v2) | Guopeng Li, Ruiqi Wu, Haisheng Tan | 2025 | 0 | arXiv | arxiv  arXiv:2512.21309 |
| 100 | 2 | [CFIR: Fast and Effective Long-Text To Image Retrieval for Large Corpora](http://arxiv.org/abs/2402.15276v3) | Zijun Long, Xuri Ge, Richard Mccreadie... | 2024 | 0 | arXiv | arxiv  arXiv:2402.15276 |
| 101 | 2 | [PCToolkit: A Unified Plug-and-Play Prompt Compression Toolkit of Large Language Models](http://arxiv.org/abs/2403.17411v1) | Jinyi Li, Yihuai Lan, Lei Wang... | 2024 | 0 | arXiv | arxiv  arXiv:2403.17411 |
| 102 | 2 | [Focus-dLLM: Accelerating Long-Context Diffusion LLM Inference via Confidence-Guided Context Focusing](http://arxiv.org/abs/2602.02159v1) | Lingkun Long, Yushi Huang, Shihao Bai... | 2026 | 0 | arXiv | arxiv  arXiv:2602.02159 |
| 103 | 2 | [Context-Aware LLM-Based Program Repair Enhanced by Historical Patch Retrieval](https://doi.org/10.2139/ssrn.5495910) | yang li, qin luo, Peng Wu | None | 0 |  | crossref  doi:10.2139/ssrn.5495910 |
| 104 | 2 | [Retrieval-Augmented Dashboards: Enabling Context-Aware Analytics through LLM Integration with BI Platforms](https://doi.org/10.52783/jisem.v10i60s.13128) | Mahesh Reddy Pathoori | 2025 | 0 | Journal of Information Systems Engineering and Management | crossref  doi:10.52783/jisem.v10i60s.13128 |
| 105 | 2 | [The Agent Perspective In LLM-Based Strategic Information Retrieval Ecosystems](https://doi.org/10.1145/3726302.3730125) | Tommy Mordo | 2025 | 0 | Proceedings of the 48th International ACM SIGIR Conference on Research and Development in Information Retrieval | crossref  doi:10.1145/3726302.3730125 |
| 106 | 1 | [Probing Ranking LLMs: A Mechanistic Analysis for Information Retrieval](https://doi.org/10.1145/3731120.3744603) | Tanya Chowdhury, Atharva Nijasure, James Allan | 2025 | 3 |  | open_alex  doi:10.1145/3731120.3744603 |
| 107 | 1 | [Focus Agent: LLM-Powered Virtual Focus Group](http://arxiv.org/abs/2409.01907v1) | Taiyu Zhang, Xuesong Zhang, Robbe Cools... | 2024 | 0 | arXiv | arxiv  doi:10.1145/3652988.3673918 arXiv:2409.01907 |
| 108 | 1 | [What Does a Software Engineer Look Like? Exploring Societal Stereotypes in LLMs](http://arxiv.org/abs/2501.03569v1) | Muneera Bano, Hashini Gunatilake, Rashina Hoda | 2025 | 0 | arXiv | arxiv  arXiv:2501.03569 |
| 109 | 1 | [Modified Levenberg-Marquardt Algorithm For Tensor CP Decomposition in Image Compression](http://arxiv.org/abs/2401.04670v1) | Ramin Goudarzi Karim, Dipak Dulal, Carmeliza Navasca | 2024 | 0 | arXiv | arxiv  doi:10.1109/DCC58796.2024.00080 arXiv:2401.04670 |
| 110 | 9 | [A Survey of Agent Memory in the Second Half: Towards Self-Evolving and Long-Horizon Agents](http://arxiv.org/abs/2602.06052v4) | Wei-Chieh Huang, Weizhi Zhang, Yueqing Liang... | 2026 | 0 | arXiv | arxiv  arXiv:2602.06052 |
| 111 | 3 | [Prompt Compression for Large Language Models: A Survey](https://doi.org/10.18653/v1/2025.naacl-long.368) | Zongqian Li, Yinhong Liu, Yixuan Su... | 2025 | 9 |  | open_alex  doi:10.18653/v1/2025.naacl-long.368 |

# 2026-08-16 DSH 插件交付与 Idea 注意力修正

## 最终设计

“把 Idea 放在每轮最前面”只保证文本出现，不保证模型有效注意，更不保证当前工程动作真的服务科学目标。因此交付版采用三层但不等权的结构：

1. **Idea Kernel**：只保存科学对象、成功证据、禁止偷换项；Pi-Idea bundle 独立限制为 256 token，超限显式失败，不截断。
2. **Task-Idea Bridge**：紧邻 Kernel，用一句任务绑定加未决证据、下一证据动作说明“本轮为什么可能改变 Kernel 判据”；明确基础设施工作本身不等于科研成功。
3. **Research Frame / Working State**：路线、工具、当前状态、evidence roots 与待办放在这里，可由模型维护或提议，但不能冒充用户确认的科学权威。

选择器仍按当前请求、Working State、Goal 与 evidence roots 召回完整 loop；只有单个 loop 自身超长时才恢复 dialogue／tool-evidence 子定位符，并强制带 parent bridge。常态不调用摘要模型；真实 overflow 或手动 `/compact` 才回退 DSH 原生滚动压缩。

## 真实运行证据

- 最终服务：`http://127.0.0.1:3080/`，2026-08-16 15:21 从旧 PID 59036 切到新 Node PID 60660；HTTP 200，stderr 为空，会话、模型和统计在重启后恢复。
- 当前用户登录自启动任务 `Pi-Idea DSH` 已实际注册：Interactive／Limited、隐藏窗口、无限执行时限、`IgnoreNew`，验证状态 Ready。
- 新产物真实 Manifest：约 8.9k token、选中 1 个 loop、遗漏 0 个，CPU 组装 1.48 ms。
- 76-event、多 MB 可复现 fixture：冷组装 275.322 ms、立即热组装 24.149 ms、后台分批预热后 1.729 ms。
- 创造模式保留 PTC Code Mode SDK，并额外开放 `tool-cordis`；DeepSeek V4 Pro 在同一对话中用 6 个模型 step、约 0.2 秒工具时间完成 `define → run → inspect → stop → undefine → inspect`，最终 `plugins: []`，无需重启。
- Pi-Idea bundle 的自动 Goal round 由独立 Cordis guard 硬限制为 32 个模型 step；普通 turn 不受此限制，guard 不注入提示词。
- DSH 官方 11 个工程 Skill 与 15 个可移植 Codex Skill 已进入按需 Skill catalog；Skill 未加载时不占 prompt token。
- 生产 build 成功；聚焦 context／Goal tests 与类型检查通过。文档门禁 27/28，唯一失败是 Windows `EPERM` 无法创建测试 symlink，提升权限重试仍相同。

## 文献对照后的边界

- LongHorizon-Harness 支持“模型外任务状态 + fresh bounded execution context”，但 Pi-Idea 不照搬其三级 MEA loop。
- HarnessBank 支持“模型提案、确定性代码归因”，因此模型可提议 Harness／Frame 变化，但不能自己判定收益或晋升科学权威。
- materials-science lifelong memory 支持把可检查事实与可执行 Skill 作为可迁移资产，而不是绑定某个代理实现。
- Cordis 的可逆 effect 与 reactive dependency 适合不中断对话的 Harness 自举；动态包仍是进程内实验，接受后必须回写所属源码插件与配置。

仍未证明：Kernel 排序和 bridge 能单独提高任务成功率，也未证明数周科研表现已经优于 DSH 滚动摘要。它们解决的是可追溯性、注意力竞争和可检验任务绑定；最终效果仍应以后续真实科研成对表现为准，不能拿压缩率代替。

# 2026-08-16 Idea 形成与管理：从固定合同改为可演化探究记录

## 结论先行

当前 `Object / Success evidence / Non-substitution` 模板适合做**目标漂移 lint**，不适合直接承担 Idea 的生成与长期表示。它过早把研究意图收敛成一份合同：能守住终点，却容易丢失研究者为什么关心问题、仍有哪些竞争解释、什么反证会改变路线，以及当前最值得消除的未知量。

建议保持现有运行时兼容，但把用户可见概念改为四部分：

1. **Idea Seed**：60–120 个汉字的用户确认稳定核；内部仍映射到当前 Kernel，以满足每次请求首部精确注入的不变量。
2. **Inquiry Map**：模型外、按证据演化的稀疏探究图；节点按需使用 Question、Hypothesis、Assumption、Rival、Evidence、Counterevidence、Decision、Rejection，不要求填满。
3. **Decision Frontier**：当前信息增益最高、且会改变研究动作的一个问题。
4. **Idea Lens**：每次请求临时生成的窄视图。执行任务取 Seed + 当前决定 + governing evidence；开放探索取 Seed + 未决问题 + rival/counterevidence；审计取 Seed + 成功判据 + 决策/拒绝来源。完整 Inquiry Map 不进入每轮上下文。

`Research Frame` 不再是一块长期累积的大文本，而成为从 Inquiry Map 生成的当前视图；`Working State` 继续保存可变执行状态。这样既保留 DSH/Pi-Idea 现有接口，也避免把一个初始措辞永久固化成模型的强先验。

## 为什么不是再设计一张更完整的表

设计理由研究长期强调记录问题、备选项、标准、论据与取舍；Truth Maintenance 则强调保存结论的依据，使新反证到来时能撤销依赖结论。但相关研究也明确指出，完整 QOC/论证结构会带来认知负担，而且不适合所有深度优先、逐步演化的设计过程。因此采用**外部稀疏图 + 按任务投影**，不采用每次对话都填满并注入的 argument canvas。

形成阶段与执行阶段也不能共用一个提示词：科学 Idea 生成研究普遍使用生成、批评、竞争、演化和人类反馈，而长时任务系统强调将经验证状态留在模型外。前者需要受控发散，后者需要稳定权威；把两者压成同一段 Kernel，必然使一边受损。

## 论文依据与采用边界

| 工作 | 可靠启示 | 对 Pi-Idea 的采用 | 不采用 |
|---|---|---|---|
| ResearchAgent (NAACL 2025) | 以文献与知识图谱支撑 Idea 生成，并由 reviewing agents 迭代改进 | Idea 候选需要批评、反证与来源 | 多代理意见自动晋升为用户权威 |
| IRIS (ACL 2025 Demo) | 人类可细粒度 steer；搜索、反馈和树搜索共同支持迭代形成 | 把用户纠正做成节点级 diff，而非重写整份 Idea | 每轮都跑昂贵搜索树 |
| AI co-scientist (2025) | Generate / Debate / Evolve 和排序可扩大假设空间；目标与评价标准由科学家给出 | 初始形成允许有限竞争解释，用户确认锚点 | 把内部 tournament 结果视为科学真值 |
| Can LLMs Generate Novel Research Ideas? (ICLR 2025) | LLM Idea 在专家盲评中更具新颖性，但可行性略弱，且存在自评和多样性问题 | 分离“产生候选”和“确认/选择” | 单次流畅输出等同于可靠 Idea |
| SciMON (ACL 2024) | 迭代新颖性检索可改善技术深度与新颖性 | 形成时允许证据驱动的候选修订 | 用新颖性替代价值、正确性和可证伪性 |
| NOVA / Chain of Ideas (2025) | 结构化文献关系、迭代规划和检索改善新颖性/多样性 | Inquiry Map 保留论文—问题—假设的来源关系 | 将整条文献链常驻每次请求 |
| LongHorizon-Harness (2026) | 显式任务状态位于执行轨迹之外，只由独立验证事实更新 | confirmed anchors 与 verified evidence 模型外持久化 | 把执行器自由文本直接写成权威 Idea |
| LongMemEval (ICLR 2025) | 长时记忆应分别评估索引、检索和阅读；会话分解与时间感知检索有效 | Idea 节点带来源、时间、supersession 和 parent decision | 只测“最终答对了”而不检查错误召回 |
| QOC / Design Rationale / TMS | 决策应保存问题、备选、标准、理由及依赖 | 以可追溯节点表达“为什么保留/拒绝” | 强制完整槽位和永久展开的论证图 |

本轮检索范围为 2024–2026 年 Idea generation、scientific agent、long-horizon memory 与 design rationale；聚合检索返回 65 条去重记录。覆盖缺口：OpenReview 连接器未安装；Semantic Scholar 两个查询在有界重试后返回 429；OpenAlex 一次 504 后恢复。因此这里的结论是高相关核心工作综合，不宣称系统综述或完整覆盖。

## 推荐的 Idea 形成流程

### A. Capture：保留原意，不立即归约

- 保存用户原话与来源位置。
- 抽取明确锚点，只允许三种初始权威：`CONFIRMED`（用户明说）、`OPEN`（会改变科学对象的真实歧义）、`PROVISIONAL`（模型解释）。
- 模型不得把 `CONFIRMED` 为了“更有创意”重新开放。

### B. Explore：仅在真实歧义处发散

- 最多提出 2–3 个真正互斥的 problem lens；没有实质歧义就不生成备选。
- 每个 lens 只回答：它试图解释什么、依赖什么假设、哪个观测最快推翻它。
- 这一步允许产生 leap，但没有任何权威写权限。

### C. Commit：只确认最小 Seed 与边界 diff

- 输出一个最小 `Idea Seed`，不含候选方法、工具、日程或完整指标表。
- 用户只确认：哪些锚点固定、哪些问题保持开放、什么不能冒充成功。
- 现有 Falsification / Decision / Freedom / Substitution 四测试在后台作为 lint 运行；只报告失败，不强迫输出采用固定文风。

### D. Evolve：证据改图，不重写历史

- 模型可追加 provisional question/hypothesis/evidence link，也可提议 Seed/Decision 变更。
- 新证据只会 support、challenge、retire 或 supersede 节点；不会覆盖原记录。
- Seed 与高层 Decision 仍须用户确认精确 diff。路线变化通常只更新 Frontier/Frame，不自动升级为 Idea 变化。

### E. Assemble：按任务选择 Lens

```text
当前请求
  -> 任务类型判别（execute / explore / audit / continue）
  -> 固定放入 Idea Seed
  -> 从 Inquiry Map 取 2–5 个相关节点及其来源
  -> 放入一个 Decision Frontier
  -> 加当前 Working State 与必要原文证据
  -> 覆盖充分即停；不足再回取 parent evidence/raw
```

热路径不需要模型生成摘要；节点更新和索引异步完成。正常 loop 只看一次性 Idea Lens，而不是完整 Idea 档案。

## 推荐生成提示词（原则版，不是固定填表）

> 你在帮助研究者澄清一个可长期演化的科学探究，不是在写一次性合同或项目计划。先区分研究者明确确认的锚点、会改变科学对象的真实歧义、以及你的暂定解释。只有存在实质歧义时才提出少量互斥理解；每种理解说明它解释什么、依赖什么、什么观测会推翻它。随后提出一个最小 Idea Seed：只保留长期科学对象、成功的大方向和最危险的目标替代。再指出当前最高信息增益的一个问题。候选方法、工具、指标细节和执行路线不得进入 Seed。你只能提出候选记录；不得重新开放用户已明确固定的边界，也不得替用户确认。

运行时可要求结构化 JSON 以便存储，但 JSON 字段应是可选的；“没有 rival/assumption”是合法输出。形式约束服务于可追溯存储，不能反过来塑造科学内容。

## DeepSeek V4 Flash High 同输入微测

测试在 DSH 的三个隔离会话中完成；相同原始 EqOp 意图、相同 Flash 模型、相同 High 推理等级，不调用工具。依次测试形成、下一科学动作、遇到 held-source 反转后的重构。它是 `N=1` 定性机制探针，且 DSH 系统上下文与自动压缩仍在，因此不能解释为统计性能评测。

| 形式 | 形成表现 | 下一动作 | 反证后的行为 | 主要问题 |
|---|---|---|---|---|
| 当前刚性 Kernel | 最紧凑、边界清楚 | 先做 DH9 多 seed × 多任务相对 DCT，未优先 matched MDTA | 提出 source-invariance / 接口规范化假说，仍判为 Frame 变化 | 守终点强，但成功合同占据注意力；首个动作遗漏最关键 matched 基线 |
| 完全开放 lenses | 最会暴露“编译器/通用/matched”的歧义 | 同任务多 seed 与同预算，MDTA 仅“成本允许则纳入” | 把固定状态方程改成待检验假设，并判为 Idea 变化 | 发散强但越过用户确认边界；输出最长、最慢 |
| 自适应 Idea Record | 正确区分 confirmed/open/provisional；只开真实歧义 | 固定任务，DH9 对 matched MDTA 与 DCT，≥3 seed 配对 | 把 held source 纳入选择协议，判为 Frame 变化 | 下一步最贴近真实瓶颈；机制 leap 相对保守 |

三组形成耗时约 23 s / 76 s / 32 s；三个会话的首字延迟约 0.6–1.4 s。可见长耗时主要来自模型继续生成，而不是首字等待。初始形成是低频动作，建议用 **Flash High**；普通 Idea 节点整理尽量确定性执行，不调用模型；只有用户要求重新理解、出现系统性反证或 Frontier 失效时才再次调用形成提示词。当前没有证据支持默认使用 Max。

## 决策

不再寻找一个同时最大化“守边界、选动作、产 leap”的万能 Idea 文本。稳定权威由 Idea Seed 承担；开放科学推理由 Inquiry Map 承担；每轮注意力由 Idea Lens 控制。这样即使探索提示词敢于产生跃迁，它也只能写 provisional 节点，不能擅自改 Seed；执行提示词则不必背负整套发散历史。

# 2026-08-16 Evidence-first Human-on-the-loop 实现修正

## 调度原则

Pi-Idea 不再使用“安全前沿”作为研究优先级。安全只做动作准入：一个动作不可恢复、超出授权或确有测得干扰时才排除；在全部可执行动作之间，控制器按**预期科学信息增益／是否改变下一决策**排序。资源存在、泛化警告、低置信度和保守 monitor 都不能自动压过能推进论文证据的实验。

每产生一份新数据，当前 loop 内最多做一次有界复盘，而且只有它改变以下至少一项时才更新 Inquiry Map 或 Decision Frontier：

1. 主假设或仍存活的竞争解释；
2. 下一项会改变决定的实验；
3. matched baseline、消融、泛化、资源、统计、复现或负面证据义务；
4. 某个机制／路线能否跨 source 或跨任务共享的诊断。

否则只记录可追溯来源并继续，不为每个测量启动独立 review loop。证据充分时，AI 可在同一 Idea Seed 下自主产生并检验新的 provisional 假设、机制解释或实验；这不是 leap。只有修改 Seed／确认边界、可复现地推翻共享研究路线，或作出会改变成功含义的高锁定选择，才提出人工 leap。

待决 leap 只暂停一个明确命名的动作，Goal 与其他证据前沿继续推进。若没有任何通过准入且能增加信息的动作，AI 可以停靠，并明确缺失证据或外部条件；不能为了显得自主而制造“安全忙碌”。

## 侦探证据板的人机边界

DSH 侧边栏增加按项目查看的侦探证据板：AI 预先生成卡片与建议语义边，研究者可拖动、编辑、添加卡片和关联，并显式选择哪些项目“给 AI 看”。实现把两类状态物理分开：

- `localStorage` 仅保存画布位置；拖动不会增加 Session event、revision、prompt 或 token。
- 卡片／边内容及 `modelVisible` 通过 `/research board <json>` 写入 append-only 研究状态；新人工项默认仅白板可见。
- 完整图不进模型。Idea Lens 最多选择五个与当前任务相关且允许读取的节点，扩展一跳语义邻居并保留 source seq。
- 当前 Inquiry Map 设 64 节点上限，优先淘汰旧模型节点；被淘汰内容仍保留在旧 `research/state-change` 事件中。人工节点与待决 Frontier／leap 证据受保护，超过上限时显式失败而不是静默删人工记录。

## 已完成机制验证

- research-context：26 项测试通过，包括任务专属 Lens、私有白板隔离、非阻塞 leap、人工决定不可被模型覆盖、当前图有界而 raw 事件仍保留。
- browser UI：10 项测试通过，包括 Cordis slot 可逆挂载、推进／探究／论文／上下文控制台，以及“拖动零命令、语义编辑才发 `/research`”的隔离断言。
- Host 与 Client TypeScript project-reference 构建通过；新增能力通过 DSH 插件依赖取得，没有修改 AgentLoop 或 Sidebar 核心。

这些测试证明机制与权限边界，不证明数周科研任务已经获得统计性能提升。后续 Flash 泛化测试只评估：目标是否保持、证据动作是否优先、非 leap 新想法是否能自主产生、真正跃迁是否只阻塞命名动作，以及无信息动作时能否正确停靠。

## 真实服务与 Flash 泛化验收

生产 Web 构建和 Cordis 运行时门禁通过后，DSH 在 `127.0.0.1:3080` 重新启动。浏览器真实验收完成：建立两张人工卡片、一条语义边，把一张卡从“仅白板”切换为“给 AI 看”，拖动卡片后重载页面，布局仍保留；语义状态依次形成 `r1` 到 `r4`，而拖动本身没有形成 revision。最近一次论文模式请求的 Idea Lens 约 164 token，CPU 组装耗时 1.40 ms。

DeepSeek V4 Flash High 串行测试覆盖五种异质场景：

1. 已测得不干扰的 Edge GPU 占用不会阻塞 matched 正式实验；
2. held-source 一致反转允许 AI 自主形成暂定捷径假设、选择判别实验并只复盘一次，不请求 leap；
3. 把跨任务目标偷换成单 benchmark 会触发人类意义裁决，但独立 matched 多 seed 复现继续；
4. 没有数据、算力、文献或未分析观测时正确停靠，不制造工作；
5. 论文正结果仍缺机制、统计、资源与失败边界时不宣称闭环。

第五例初测发现模型从未说明领域的“候选”中脑补了具体三臂消融。这不是格式问题，而是 Seed 对注意力的过度补全。控制器与 `research-state-discipline` Skill 因此补上反向约束：不得发明领域事实、机制或精确消融臂；缺失项必须保持为证据缺口；只要求一个动作时，只选择一个最高决策价值干预。复测后，模型不再脑补机制，只选择一个统计／资源／失败边界测量包。最终五类场景全部满足各自验收条件。

# 2026-08-16 修正：Idea 不是冻结合同，而是慢变的研究追求

前文中“Idea Seed 稳定核”的“稳定”不应再解释为永久不可修改。更准确的定义是：

- **Working State（快）**：当前执行备忘录，有意可丢弃。
- **Inquiry Map / Decision Frontier（快到中）**：跟随当前未知、竞争解释与会改变下一步的证据。
- **Research Frame（中）**：当前科学路线与瓶颈，证据改变路线时可调整。
- **Research Pursuit / Pursuit Seed（慢）**：当前真正在追逐的科学对象、成功含义和最危险的目标替代。

每个已确认的 Pursuit 版本仍然追加保留，不覆写历史；但当用户反馈或实践证据表明“我们其实应该追什么”发生了变化，当前有效版本可经一次人类确认后澄清、调整或转向。提案必须说明促成反馈以及仍然保留的承诺。没有固定冷却期或审批链；稳定性来自“先用最低充分层吸收反馈”，而不是把早期的不完整理解永久锁死。

这一修正也回应了真实人机关系：研究者可能开始时只知道大概方向，需要通过实验和模型反馈逐步理解自己想要什么。Pi-Idea 要防的是静默漂移和局部工程偷换，不是阻止研究追求在反馈中成熟。

最新 autoresearch 框架的可取共识也已纳入：可评分子任务使用“一次变更 → 运行 → 保留／回退”小环；不可评分的科学方向由慢追求、窄 Lens 和人在环上介入维持。默认不引入常驻 manager、auditor、DAG 或树搜索，因为它们会放大 token、延迟和相互冲突的保守信号。

性能快照也更新为本轮最终可复现本机值：76-event、多 MB fixture 的真冷组装 347.415 ms，立即热组装 31.255 ms，异步预热完成后的请求 1.225 ms。普通 loop 走最后一条快照路径；冷重建不是日常延迟目标。

## 真实自举闭环

在独立 `dsh-self-bootstrap-acceptance` Workspace 与新主对话中，DeepSeek 先后确认 Pursuit v2 和 Frame v2，再在同一 Session 修改真实 DSH 源码：把 `latestDirectUser` 与 `currentRequestText` 的两处 `toReversed()` 全数组克隆改为反向索引扫描。聚焦测试 29/29 通过，`rg` 核对残留为 0，结果回写为 `keep`。生产构建和 DSH 重启后，同一 Session、慢变量版本与证据根恢复；把 `next_action` 设为空字符串后，界面正确进入“已停靠”。

实战发现两个合同缺陷并完成回归修复：第二个待决权威提案曾会静默覆盖第一个，现在必须逐个确认；UI 把空 `next_action` 定义为停靠而后端曾拒绝空值，现在空值是合法终态。服务端与 Idea Dock 聚焦测试合计 32/32 通过。Flash High 在机械任务上出现显著过思考，说明降本增效不能依赖更长提示词或更高推理，而应优先依靠短合同、确定性状态机、按任务降推理等级和明确停止条件。
