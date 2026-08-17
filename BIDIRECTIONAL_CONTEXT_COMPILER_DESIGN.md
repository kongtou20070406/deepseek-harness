# Pi Idea 双向上下文编译器方案

状态：待用户确认的设计草案，尚未接入生产路径
版本：0.1
目标：让同一个用户回合中的每次模型调用，都获得完成下一步所需的最小充分上下文；上下文选择权属于 Pi 外部本地程序，不属于任何模型。

## 1. 问题定义

长时间科研任务不能靠“最近若干轮 + 一份越来越长的摘要”维持。真正的问题是：

1. 每次 Agent loop 的下一步不同，所需上下文也不同；
2. 正向猜中所有有用证据很难，漏掉一条决定性证据会使方向偏移；
3. 很多过程噪声、重复结果和已被覆盖的状态却可以由结构关系证明不再需要；
4. 即使内容很少使用，也可能是罕见但关键的反证，不能按低热度删除；
5. 模型不能同时充当上下文消费者和上下文裁判。

因此，本方案不把上下文组装定义为单纯的 top-k 检索，而定义为一个增量、确定性、双向的编译过程：

```text
上一 loop 的工作集
+ 当前分支新增的原子事件块
+ 正向高置信召回
- 负向高置信回收
+ 调用、文件、冲突和时间依赖闭包
= 下一 loop 的候选工作集
→ 在预算内渲染为模型上下文
```

优化目标严格采用字典序：

1. 最大化任务成功率；
2. 成功率统计相当时，最小化注入 tokens；
3. 前两项相当时，最小化本地组装延迟与 P95。

任何明显损害正确率的省 token 方法都淘汰。四个本地条件先比较任务成功率，只有统计相当时才比较 tokens 和 P95。

## 2. 不变量

1. P0 每次主模型调用都逐字位于最前；P0 不参与检索、摘要、GC 或热度计算。
2. Pi 当前分支的原始 SessionEntry 是事实源；标签、摘要、关键词、embedding、热度和 Manifest 都是可重建派生物。
3. 上下文组装完全由外部本地程序完成。任何模型都不能发出 `keep/drop/next_context` 指令。
4. 模型生成的别名、cue、标签和分类特征不进入召回、KEEP、DROP、排序、权威或冲突解决路径。
5. 注入为科学判断依据的内容必须是逐字 raw slice，并独立携带来源和时间。摘要只能导航，不能替代证据。
6. “本轮省略”不等于物理删除。原始块始终可恢复；物理清理只针对可重建缓存。
7. KEEP 胜过 DROP。任何块一旦成为保护根或依赖闭包成员，就不能被删除证书移出本轮上下文。
8. 低相似度、低热度、年代久远和模型自评都不能构成删除证明。
9. 同一原始事件、编译器版本、索引快照和预算必须产生相同的 Context Manifest 与输出哈希。
10. 编译关键路径不调用模型、不产生递归 Agent loop。

## 3. 原子事件块

当前按 user turn 打包的方式会混合用户文本、助手中间判断、工具参数、工具结果和最终回复。新编译器先按 Pi SessionEntry 与 content part 切成不可变事件块，再构建关系。

### 3.1 最小字段

```text
block_id
entry_id / parent_entry_id
session_id / active_path_hash
kind / role / source
message_time / entry_time / source_order
raw_ref / raw_hash / token_count
call_id / operation_id / run_id
path / symbol / artifact_id / revision_id / evidence_id
state_key / state_version
stop_reason / is_error / exit_code / truncated
depends_on[] / supersedes[] / contradicts[] / validates[]
```

`block_id` 由 session、entry、content part、fragment、kind 和逐字 raw hash 确定。分支身份来自 entry 的 parent chain；不伪造不存在的 `message.branchId`。

### 3.2 块类型

| 类型 | 默认事实资格 | 说明 |
|---|---:|---|
| `user_text` | 是 | 用户请求、纠正和确认；权限另行记录 |
| `assistant_intermediate` | 否 | `stopReason=toolUse` 的中间文字，只作历史判断 |
| `assistant_final` | 有限 | `stopReason=stop` 的公开结论，不替代原始证据 |
| `assistant_truncated` | 否 | `length`，不是完整结论 |
| `assistant_incomplete` | 否 | `error/aborted` |
| `assistant_thinking` | 否 | 不进入事实检索 |
| `tool_call` | 否 | 说明执行了什么，与 result 通过 call ID 配对 |
| `tool_result` | 是 | 原始结果、错误、文件内容或测试证据 |
| `bash_command` | 否 | 命令、参数、cwd 与环境 |
| `bash_result` | 是 | stdout、stderr、exit code，按语义继续细分 |
| `custom_derived` | 否 | 标签、摘要、索引和提示 |
| `compaction_derived` | 否 | Pi 压缩产物，不替代 raw history |

### 3.3 语义切分

不能先按固定 token 或标点盲切：

- 普通文本按 Markdown fence、段落、连续列表和表格切；超硬上限才按行或句二次切；
- `read` 按路径、行范围和文件 revision 切；
- `edit/write` 按 diff hunk、受影响 symbol 和执行结果切；
- `grep/find/ls` 将 query 与每个文件结果分开；
- 测试输出按命令、配置、测试项、失败栈和汇总切；
- 实验输出按 dataset、config、version、metric、artifact 和时间切；
- tool call/result 分块但用 call ID 配对；并行工具绝不靠相邻顺序配对；
- 日期、来源和权限复制到每一个事实片段，不能落在相邻片段中。

流式 update 不建立长期块，只保留最终 `message_end/tool_result`；这本身就是可验证的覆盖关系。

## 4. 三态判定

编译器不要求为每个块算一个真假难辨的“相关性总分”，而是先给出三态：

### KEEP

高置信必须保留，或属于必须保留块的依赖闭包。

### DROP

存在确定性删除证书，能证明它在当前 loop 已被覆盖、重复、解决或可精确恢复。

### UNKNOWN

既无法证明必须使用，也无法证明没用。默认不误删；只有上下文超预算时才按确定性顺序延期注入。

实现顺序不是立即删除：

```text
先在完整图上生成 DROP 候选证书
→ 再建立 KEEP roots 和依赖闭包
→ 最后统一裁决

reachable/protected  => KEEP
否则有删除证书     => DROP
否则                => UNKNOWN
```

这保证 KEEP 永远可以覆盖 DROP。

## 5. 负向高置信回收

V1 只删除有结构证明的内容：

1. **UI noise**：spinner、进度条、token 速度、TUI redraw 等非语义事件；
2. **thinking/stream**：隐藏 reasoning 和已被定稿 message 覆盖的流式快照；
3. **exact duplicate**：同 event ID，或相同 source/span/hash 的重复入库；不同时间的相同文字不视为重复；
4. **derived duplicate**：原始块已保留时，对应标签、摘要和旧 schema 派生副本不进入证据包；
5. **explicit supersession**：只有存在同一 `state_key`、明确 version 或 `supersedes_id`，且新版本已经提交，旧状态才可被回收；
6. **covered read**：同一路径和范围、同一 revision/hash 的旧读取已被更新的完整读取覆盖；部分读取不能覆盖完整读取；
7. **absorbed diff**：旧 diff 已被后续成功写入，并有读回或测试证明当前文件状态吸收了它；失败 edit 不能回收；
8. **resolved attempt**：同一 operation 的旧失败已有链接的成功重试与验收结果；根因、修复和最终结果仍保留；
9. **repeated passed log**：同 revision/config 下重复的通过日志，只保留精简结果；当前出现相关回归时重新激活；
10. **rehydratable payload**：巨大文件或工具结果已经按 hash 保存且可精确回读时，正文可从热工作集移除，只保留指针和必要片段。

以下理由永远不足以 DROP：语义相似度低、BM25 分低、embedding 距离远、三天没用、热度低或模型说下一步不需要。

每次删除生成证书：

```text
block_id / raw_hash
rule_id / rule_version / scope
deterministic_preconditions
dominated_or_superseded_by
root_check / dependency_closure_hash
recoverable_uri / raw_span
source / authority / event_time
```

证书不复制正文；连续同类块按范围合并。

## 6. 正向高置信召回

GC 后，编译器从 Hot、Warm、Cold 三层索引召回可能真正服务当前 loop 的 raw blocks。

### 6.1 强 KEEP 信号

- 当前用户精确提到 path、symbol、error ID、run ID、experiment ID、artifact ID 或 evidence ID；
- 上一个 loop 新产生的 tool result、diff、错误或实验结果；
- 当前未解决目标、约束、冲突和授权；
- 当前活跃文件、测试、实验和 state key 的最新权威版本；
- provider 协议要求的最近 tool call/result 链；
- 已选块的调用、文件、冲突、版本或验证依赖。

### 6.2 候选召回信号

- 本地精确标识符倒排；
- SQLite FTS5/BM25 的词项结果；
- 时间、版本、来源、冲突和实体关系；
- 可选 embedding 只作低优先候选，不单独触发 KEEP。

每次 loop 开始时固定一个本地 `index_snapshot_id`；外部程序只在该冻结快照上执行确定性规则。增量尚未提交时沿用上一个完整快照，不等待，也不让异步写入改变同一条件。

### 6.3 多信号融合

只有以下情况可以把可选块提升为高置信候选：

- 一个强结构信号；或
- 两个相互独立的本地弱信号一致，例如 BM25 命中 + 当前文件关系、BM25 + 同一 state key，或路径命中 + diff/test 依赖。
- 当词法匹配相近时，原始 tool result 与用户明确约束/偏好高于 assistant 的复述或建议；来源权威只能参与正向排序和 UNKNOWN 装包，不能单独触发 DROP。

纯热度、纯向量相似度、纯摘要匹配或任何模型生成标签都不能独立提升为 KEEP。

## 7. 依赖闭包

正向召回不是结束。编译器在有限图上用 BFS 求固定点，每个节点和边最多访问一次：

- result ↔ producing call 与必要参数；
- error ↔ command/config/revision/source/diff；
- diff ↔ affected file/symbol ↔ validation result；
- experiment metric ↔ dataset/config/version/time/artifact；
- conflict ↔ 双方证据；
- supersession ↔ 最新状态及理解更新所需的前态；
- user correction ↔ 被纠正的对象；
- 当前未完成的并行 tool batch ↔ 全部对应 result。

命中冲突一侧时，另一侧不能被隐藏。依赖关系不清时，保留显式连接分量，而不是拆碎后猜测。

## 8. Hot / Warm / Cold

热度只决定索引层级和 UNKNOWN 的预算排序，不决定事实、方向或删除。

### Hot

内存索引：当前 roots、上一工作集、最近使用的 active artifacts 和未解决状态。

### Warm

SQLite FTS/BM25：近期或偶尔使用的完整 block metadata 与 raw pointers。

### Cold

原始 Pi 会话、artifact store 或 Obelisk 可恢复记录；只保留稀疏目录、state key、时间、hash 和位置。

三天只作为“允许降级”的最早时间，不是删除期限。用户确认、未解决冲突、否决路线的反面证据和当前路线依赖即使低热也受保护。

避免“越选越热”的自强化循环，分别记录：

- `exposure_count`：被注入次数，只作审计，不增加长期热度；
- `explicit_reference_count`：后续用户或事件明确再次引用；
- `rehydration_count`：从冷层实际恢复并再次使用。

初版热度只由后两者和确定性时间衰减产生：

```text
heat = log1p(explicit_reference_count)
     + log1p(rehydration_count)
     + exp(-age / tau)
```

Heat 只能调整 UNKNOWN 的顺序；KEEP 不受热度影响，DROP 也不能因高热复活，除非成为新 root 或依赖。

## 9. 每次 loop 的完整时序

Pi 的 `context` 事件在每次 LLM 调用前触发，包括同一用户任务中每次工具结果之后的下一次调用。因此无需 fork Pi。

### 9.1 loop 开始前：摄取新增事件

1. 读取当前 active branch 的 SessionEntry parent chain；
2. 根据上次 cursor 只处理新增 delta，不全量重扫；
3. 切成 typed immutable blocks，计算 raw hash；
4. 更新 call、file、revision、test、experiment、conflict 和 supersession 边；
5. 更新本地倒排与层级索引；
6. 固定本 loop 的 `index_snapshot_id`。

### 9.2 外部状态机识别 phase

状态机只观察客观事件，不读取模型的上下文建议。优先级示例：

```text
failed test / error
> fresh experiment result
> edit or write completed
> read or search completed
> plain response
```

它使用 tool type、结构化 args、result status、path、diff、test、error 和 artifact IDs。相同事件状态必须得到相同 phase。

### 9.3 建立 roots

固定 roots：逐字 P0、P1、当前用户请求、系统/开发不变量。P0 只直接注入，不进入检索图。

动态 roots：

- 上一 loop 尚未解决的约束、冲突、错误和授权；
- 最新 tool batch 及其协议闭包；
- fresh result；
- active file/error/experiment；
- 当前 phase 的完成条件；
- 当前 prompt 显式引用的对象。

### 9.4 双向更新工作集

1. 在完整图上生成所有高置信 DROP 证书，但暂不移除；
2. 从 roots 和正向高置信索引产生 KEEP seeds；
3. 对 KEEP seeds 做依赖、冲突和时间闭包；
4. 统一裁决 KEEP/DROP/UNKNOWN；
5. 将上一工作集中仍为 KEEP/UNKNOWN 的块增量继承；
6. 从 Hot/Warm/Cold 拉回新命中的冷块；
7. 记录每个块的 retain/drop/defer 原因。

### 9.5 预算装包

先装入 P0/P1、当前请求、provider 必需 tail 和全部 KEEP closure。

- 若 GC 后的 KEEP + UNKNOWN 全部能放下，则保留全部 UNKNOWN，不做多余猜测；
- 若仍超预算，才对 UNKNOWN 做保守正向分配；
- 外部 phase 模板给出本 loop 需要覆盖的信息槽；候选按“新增槽覆盖 / token、依赖距离、信号一致性、层级、热度、时间、稳定 ID”确定性排序；
- 槽位覆盖充分后停止，不因为还有预算就继续填噪声；
- budget omission 标为 `DEFER/UNKNOWN`，绝不能伪称 irrelevant 或 DROP；
- 若不可缩减的 KEEP closure 本身超预算，停止调用并报告冲突，绝不截断 P0、用户约束或冲突证据。

### 9.6 渲染给模型

语义顺序：

```text
1. 逐字 P0
2. P1 / 当前阶段边界
3. 当前用户请求与本 loop 目标
4. 决定性原始证据、冲突和时间关系
5. 当前操作所需文件、diff、错误、测试或实验材料
6. provider 合法性要求的最新原生 tool call/result tail
```

旧证据可以重排为带来源的 custom evidence packet；尚在进行的 tool call/result 必须保持 Pi/provider 所要求的原生合法顺序。

### 9.7 调用结束后

1. Pi 正常持久化 assistant message、tool call 和 tool result；
2. 扩展只记录新的 cursor、trace 和完成状态，不让模型回写上下文控制指令；
3. 本地索引立即增量更新；
4. 本地派生索引可在后台增量维护，绝不阻塞下一 loop；
5. 下一次 `context` 事件重新从 9.1 开始，因此同一用户任务内每个 loop 都可以获得不同上下文。

## 10. 不同 phase 的最小上下文

### 初次理解任务

P0、当前请求、当前阶段、相关历史约束/冲突和少量决定性证据。没有理由携带旧工具日志。

### read/search 之后

当前请求、读取的 path/symbol、相关结果片段、用户约束和未解决目标。同 revision 的旧完整读取可被结构性 GC。

### edit/write 之后

当前请求、diff hunk、受影响 symbol/API、未解决错误、约束与待运行验证。旧 read 若已被当前 revision 和 diff 覆盖则移出工作集。

### failed test / diagnose

测试命令、config/revision、失败项、关键 stack、产生该状态的 diff/source、相关用户约束。通过项的大段日志 DROP。

### passed test

revision/config、精简通过结果、对应 diff 与目标。重复 stdout、spinner 和已解决重试 DROP。

### experiment result

P0/P1 边界、dataset/config/version/time/metric/artifact、支持与反面证据、未解决冲突。安装日志和无关环境输出 DROP。

### 给用户最终回复

P0、当前请求、结论所需原始依据和未决问题；除非构成论据，不携带工具 plumbing。

## 11. Manifest

每次模型调用保存一个可复现 Manifest：

```text
compiler_version
input_event_digest
session_id / leaf_id / path_hash / turn_index
phase / index_snapshot_id
roots[]
retained[{block_id,state,tier,reasons,via_edges}]
dropped[{block_id,rule_id,proof,dominator,recoverable_ref}]
deferred[{block_id,state=UNKNOWN,reason=budget,rank_tuple}]
budget / tokens_by_class
output_hash / assembly_ms
```

Manifest 只存 ID、hash、枚举原因和范围，不复制正文；使用增量日志、周期 checkpoint 和有界 LRU，避免存储膨胀。

模型输入只携带短证据 ID、必要来源/时间和逐字正文；完整 block ID、raw hash 与证明链只保存在外部 Manifest，避免为审计字段反复支付模型 token。

## 12. 复杂度和性能边界

采用增量索引后：

- 新事件解析：`O(delta bytes)`；
- hash、call ID、state key 和 artifact map：均摊 `O(1)/block`；
- 活跃依赖闭包：`O(V_live + E_live)`；
- 倒排查询：`O(query postings)`；
- optional 分配：`O(k log k)`，可用固定 bucket 进一步降低；
- 删除证书：`O(omitted ranges)`。

禁止每 loop 全历史重扫、全块两两相似度、同步模型标注和递归调用。

工程 SLA：

- 单块增量建索引 P95 < 1 秒；
- 每 loop 本地组装 P95 < 2 秒；
- 常规目标 < 250 ms；
- 在线模型索引调用为 0；
- 内存、posting、Manifest 和派生缓存均有硬上限。

## 13. Benchmark 微调与验收

新方案先在 benchmark-local 原型中实现，不直接接生产。

### 13.1 消融条件

| 条件 | 结构 GC | 正向选择 | Heat |
|---|---:|---:|---:|
| 当前 Positive-only 基线 | 否 | 本地 | 否 |
| GC-only | 是 | 固定时间顺序装包 | 否 |
| Bidirectional | 是 | 本地 | 否 |
| Bidirectional + Heat | 是 | 本地 | 是 |

另保留 Pi native/full-history 作为参考，不作为生产目标。

### 13.2 Benchmark 分工

- MemSyco：记忆是否拥有正确决策权，诊断旧偏好、冲突和来源权限；
- GaRAGe：选中的证据是否真正改变判断，而非只主题相似；
- CAME：多个目标和相似实体交错时是否维持当前任务；
- LongMemEval：时间、更新、拒答与跨会话事实；
- MemoryArena：最终环境 Task Success，作为产品主裁决；
- 后续 Mem2Act/真实 Pi 轨迹：工具选择、参数和长时实现任务。

### 13.3 防止调参污染

1. 按完整 session/narrative 切 dev 与 holdout；
2. 只在 dev 调 parser、rule IDs、阈值、phase slots 和 heat 公式；
3. gold 永不进入在线 blockizer、GC、索引或 answer prompt；
4. 所有索引特征都由在线可见的本地原始块确定性生成；
5. 条件名对后验裁判隐藏；
6. 冻结规则后只运行一次 holdout，不根据 holdout 继续改；
7. 至少 60 个配对样本再形成正式结论，报告 paired bootstrap/McNemar 区间。

### 13.4 失败归因

主指标仍是 Task Success。另记录：

1. `false-drop`：必要证据被 GC 证书删除；
2. `missed-recall`：块仍存在，但正向分配器没有注入；
3. `closure-break`：证据存在，但调用、前提、多跳或冲突另一侧缺失；
4. `conflict-authority`：来源或冲突判断错误；
5. `temporal`：时间与事实分离，或 supersession 顺序错误；
6. `context-interference`：正确材料存在，但过长噪声使任务失败；
7. `model-reasoning`：最小充分证据完整，模型仍判断错；
8. `protocol/compiler`：tool pair 或消息格式损坏。

诊断时依次回插：被 DROP 的 gold support、未注入但幸存的 support、缺失依赖。任务在哪一步恢复，就把失败归到对应层，而不是盲目调相关性权重。

## 14. 当前基线与实施顺序

当前旧编译器已经具备：逐字 P0、本地逐字 passage、基础 event lineage、loopSignals 接口和 32/32 回归通过。旧代码仍含 Luna 增强轨道，但它不属于本方案，后续由纯本地编译器替换。

但尚未具备本方案的关键能力：

- hook 映射消息时丢失真实 SessionEntry id/parent/timestamp；
- 生产 hook 没有填入真实 loop signals；
- 最近 active turn 仍整回合保留，工具噪声不能按事件 GC；
- 每次 context 和 agent settled 仍会重扫完整历史；
- 当前 fold unit 仍会把多类事件打入 4.8k–7.2k 大块；
- 尚无增量 Working Set、DROP certificate、依赖闭包和 Hot/Warm/Cold 层级。

如果本方案确认，实施顺序是：

1. typed immutable blocks + 真实 SessionEntry provenance；
2. shadow Manifest：先记录 KEEP/DROP/UNKNOWN，不改变模型输入；
3. 只启用零争议 structural DROP；
4. 增量 Working Set、roots 和依赖闭包；
5. 超预算时启用本地正向 UNKNOWN 分配；
6. 加 Heat，做消融；
7. 只有四组公开 holdout 通过任务成功率门槛后才进入生产。

## 15. 研究依据与取舍

- [LongLLMLingua（ACL 2024）](https://aclanthology.org/2024.acl-long.91/) 与 [LLMLingua-2（Findings ACL 2024）](https://aclanthology.org/2024.findings-acl.57/) 支持“提高关键信息密度可以同时改善质量、token 和延迟”，但其学习式 token 删除不进入 P0/证据删除路径。
- [RECOMP（ICLR 2024）](https://proceedings.iclr.cc/paper_files/paper/2024/hash/bda88ed2892f5e61c9a9bf215c566913-Abstract-Conference.html) 支持“没有可靠证据时不给噪声上下文”，但训练式摘要只作对照。
- [Lost in the Middle（TACL 2024）](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/Lost-in-the-Middle-How-Language-Models-Use-Long) 支持短而正确往往优于长而嘈杂。
- [Lost in Decomposition（Findings ACL 2026）](https://aclanthology.org/2026.findings-acl.2097/) 提醒依赖密集内容被拆散会损害性能，因此必须做 dependency closure。
- [Context Folding（ICML 2026）](https://openreview.net/forum?id=lNRgWoGfYg) 支持完成子轨迹后折叠过程，但本方案不采用“模型自主管理上下文”，只借鉴已完成过程与结果分离。
- [Anthropic Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) 与 [Semantic Kernel history reducer](https://learn.microsoft.com/en-us/python/api/semantic-kernel/semantic_kernel.contents.history_reducer.chat_history_reducer_utils) 支持清理旧 tool result 与保持 call/result 配对；本方案额外加入版本、依赖与冲突保护。
- [Kafka log compaction](https://kafka.apache.org/documentation/#compaction)、[Git GC](https://git-scm.com/docs/git-gc) 和 [LLVM ADCE](https://releases.llvm.org/16.0.0/docs/Passes.html#adce-aggressive-dead-code-elimination) 分别提供显式 keyed supersession、roots/reachability/grace 与从 roots 证明 live 的工程抽象；它们是设计类比，不是 Agent 性能论文。

本方案明确不采用模型内部 KV cache pruning 作为 Pi 输入压缩：它不能减少黑盒 API 输入 tokens，也缺少逐块 provenance。
