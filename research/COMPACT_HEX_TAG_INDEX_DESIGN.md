# Compact Hex Tag Index

状态：原型已验证延迟，尚未进入生产

## 目的

让上下文组装器不再在每个 loop 扫描全部 claim/passage 文本。标签只服务检索，不服务阅读；主模型最终只收到逐字 P0、选中的 grounded claim 与必要 raw excerpt。

## 通道

| 通道 | 内容 | 查询来源 | 作用 |
|---|---|---|---|
| `L` | raw/claim 的词项、字符 n-gram、局部 bigram | prompt/P1/P0 的只读特征 | 字面召回 |
| `C` | Luna 生成的未来 retrieval cues | prompt 的同类文本特征 | 跨措辞、偏好与隐含约束 |
| `E` | 实体、文件、变量、版本、数字标识符 | prompt 中的标识符 | 精确对象召回 |
| `T` | session date、event date、相对时间类别 | prompt/question date | 时间覆盖与更新 |
| `A` | authority、status、confirmed/candidate/superseded | query plan 的过滤/先验 | 防止旧值或提案压过确认事实 |
| `R` | adjacent、supports、contradicts、supersedes、same-entity | 命中后的扩展规则 | 组合完整证据链 |

标签格式在日志中可显示为 `C:19d2e4f3a01b7c55`；SQLite 中应存 8-byte BLOB 与 1-byte channel，而不是 18 字符文本。

## 写入

```text
raw stable block
  -> deterministic passage split + provenance
  -> L/E/T/A/R codes immediately committed
  -> block is searchable (<1s hard SLA)
  -> optional Luna claims/cues arrive later
  -> quote verification
  -> C and derived E/A/R codes added in one small transaction
```

每个 block 的 local generation 与 Luna enhancement 是两个独立事务。Luna 失败不会撤销本地索引，也不会让主 Agent 等待。

建议上限：每个 passage 最多 64 个 `L`、48 个 `C`、16 个 `E`、8 个 `T`、12 个 `R` codes。高频 code 只保留 document frequency，不无限扩展 query；routine/tool noise 在写入前过滤。

## 查询

1. 只对当前 prompt、P1 与逐字 P0 的只读副本提取 query codes；P0 本体不进入索引存储。
2. 按 `(channel, code)` 直接取 posting lists。
3. 使用 `weight(channel) × log(1 + N/df)` 累加；不反解标签文本。
4. 对 top 30–50 应用 authority/time/update filters。
5. 可选小于 0.5B 的本地 reranker；硬超时后使用原排序。
6. 覆盖不足才沿 `R` 扩展；最后按 2.5k→5k→7.5k token 梯度打包。
7. 返回 raw passage IDs/claim IDs；组装器从事实源读取逐字 quote 和独立日期字段。

查询必须是有界工作，而不是把全文扫描换成 posting 扫描：

- query labels 按 document frequency 从低到高处理；
- 仅在索引至少有 32 个文档时跳过覆盖率高于 20% 的公共标签；
- 每轮最多访问 50,000 个 posting，达到上限后使用已经得到的 rare-first 候选；
- 每个 stable block 的 `L/C/E/T/R` 标签数分别受固定上限约束；
- 当前 P0、P1 和 prompt 的编码结果按各自哈希缓存，P0/P1 未变时只增量编码 prompt。

这让标签层直接承担 candidate generation；组装器不再为每个 loop 拼接、分词并打分所有历史 claim。

## 热、温、冷三层与 Obelisk 回源

索引是派生缓存，不应无限保留所有细粒度 posting：

| 层级 | 保留内容 | 正常 loop 是否访问 |
|---|---|---|
| Hot | 当前路线、近期命中、活跃约束/冲突的 claim-level posting | 是 |
| Warm | block id、时间范围、source locator、少量 coarse codes、authority/status 位 | 仅在 Hot 覆盖不足时 |
| Cold | Obelisk 中的原始 session/message/tool evidence | 否，按需回源 |

从 Hot 淘汰只删除可重建 posting 和 Luna cue，不删除原始事件、P0、用户确认或 provenance。以下记录默认 pin 住，不因年龄单独淘汰：当前路线相关事实、尚未解决冲突、仍生效的用户约束、最近被引用的证据。过期候选、已 superseded 的派生标签、长期零命中且无 pin 的块优先降温。

Hot 的默认淘汰策略采用按时间分代的 LFU，而不是纯年龄或纯 LRU：

- 一个 epoch 默认 72 小时；新 stable block 在首个 72 小时内完整保留；
- 只统计 claim/raw excerpt **实际进入发送给主模型的 Context Manifest** 的次数；仅作为候选、预取或后台检查不计数；
- 同一规范化 query hash 在短窗口内对同一 block 最多计一次，防止 Agent/tool loop 轮询虚增热度；
- epoch 切换采用 lazy rollover，只在 block 被访问或进入分批 GC 时更新计数，不做全表定时重写；
- 首个 72 小时到期后，最近周期注入次数不超过 1、且没有 pin 的 block 从 Hot 降为 Warm；达到 2 次则继续留在 Hot；
- 后续每 72 小时 lazy rollover；上一周期次数只以衰减权重参与判断，避免早期热门块永久占据 Hot；
- Obelisk 回源成功后升温并开启新的 72 小时保护期，给予一次 admission hit，避免立即被下一轮 GC 淘汰；
- GC 只在启动、空闲或超过索引空间预算时按固定 batch 执行，不运行常驻递归任务。

最小状态可放入独立派生表：`source_unit, tier, born_epoch, current_epoch, current_hits, previous_hits, last_injected_at, pin_flags`。删除/重建这张表不能改变 Idea 或事实源。

Warm 目录必须保留；若彻底不留 locator，组装器无法区分“历史中没有证据”和“证据已被淘汰”。目录只需支持是否回源的粗判断，不把摘要注入模型。

Obelisk 仅在以下情况触发，不能成为每轮依赖：

1. 问题显式要求“以前、上次、旧版本、原文、怎么修过”；
2. Hot/Warm 没有达到最低覆盖或仅命中高频弱标签；
3. 命中证据存在时间、状态或数值冲突，需要追溯 parent/context/raw；
4. 用户显式要求查历史。

回源结果先经过来源与时间校验，再作为本轮临时证据；重复命中的 block 可提升到 Warm/Hot。Obelisk 失败不循环重试，也不阻塞普通不依赖历史的 loop。

## SQLite 草案

```sql
CREATE TABLE doc (
  doc_id INTEGER PRIMARY KEY,
  source_unit BLOB NOT NULL,
  raw_hash BLOB NOT NULL,
  quote_hash BLOB NOT NULL,
  quote TEXT NOT NULL,
  memory_session TEXT,
  memory_date TEXT,
  authority INTEGER NOT NULL,
  status INTEGER NOT NULL
);

CREATE TABLE posting (
  channel INTEGER NOT NULL,
  code BLOB NOT NULL,
  doc_id INTEGER NOT NULL,
  PRIMARY KEY (channel, code, doc_id)
) WITHOUT ROWID;

CREATE INDEX posting_doc ON posting(doc_id);
```

`quote` 在生产可改成 raw event 的 offset/length，避免复制原文；前提是 raw event 文件不可变且 offset 校验可靠。V0 可先保留短 quote，降低实现风险。

## 安全与可恢复性

- 64-bit collision 只会带来额外候选，不能产生权威事实；注入前仍校验 source/raw/quote hash。
- `index_version + tokenizer_version + cue_prompt_hash` 写入 manifest；版本变化从 raw events 重建。
- `posting`、Luna cues、DF 与缓存都是派生物，可删除重建；P0 与 raw events 不是。
- 不存凭据，不把 Idea 内容写进索引候选；P0 每轮只作为 query enrichment。
- 删除/更新不原地改事实：新 event 标记 superseded，后台 GC 只清理不可达派生 posting。

## 原型结果

在 LongMemEval-S 分层 60 题、约 16,160 个 Luna grounded claims（按 case 分开建索引）上：

- fully indexed cases：60/60；
- 单 block 建码：median 0.81 ms，P95 1.28 ms，max 18.98 ms；
- top-8 查询：median 0.19 ms，P95 0.33 ms，max 0.44 ms；
- 每题 posting visits：median 109，P95 291.2，max 344；
- 每题实际候选：median 65，P95 130.5，max 161；
- 最大单 case：295 documents、约 11,261 labels、18,713 postings；
- hex evidence-session recall：75.7%；当前文本选择器：70.9%；
- any-evidence hit：86.7%；当前文本选择器：85.0%；
- preference evidence recall：5/6；当前文本选择器：5/6。

因此延迟、每轮工作量和当前规模下的召回通过原型门，但准确率尚未通过生产门。下一次实验必须加入真正的 Luna `C` cues，并以最终任务成功率而不是 evidence recall 决定是否采用。Hot/Warm 淘汰阈值也必须在长时任务 benchmark 上验证；不能只凭年龄启用。
