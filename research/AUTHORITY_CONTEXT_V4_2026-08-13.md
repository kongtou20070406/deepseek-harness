# Pi-Idea Authority Context v4：选择器修复与 1% 难例诊断

日期：2026-08-13
状态：`IMPLEMENTED / DEV-TUNED DIAGNOSTIC / SAFE DEFAULT UNCHANGED`

## 结论

旧 LSC-EPC 在固定 5% Sol 配对门中失败，不是因为 locator、loop-island 或异步索引本身失效，而是选择器把“主题相关”近似成了“当前有效”。它会漏掉较早但仍然有效的用户偏好更新，也会同时物化已经被新决定覆盖的旧偏好，最终让 Sol 使用错误 authority。

v4 把问题改写为：**先恢复当前问题的权威状态闭包，再决定哪些完整原文岛需要物化；没有物化的内容仍保留 locator 和 raw provenance。**

默认产品模式仍是 `safe`。本轮 1% Luna-low 是定向开发诊断，不是 Sol 非劣采纳门，因此不能据此默认启用选择性上下文。

## 旧版失败的具体机制

固定 5% Sol 门的 70 个可评分配对中：

- task success：`94.29% -> 87.14%`，5 个 raw-only regression；
- authority use：`100% -> 91.43%`，6 个 raw-only regression；
- 没有 LSC-only regression 逆转上述损失。

主要错误分两类：

1. `valid_memory_selection` 漏召回：例如“以后只要快速星级”“不再想旅行、想留在本地”“不再要流程图、改成深入文字”，旧选择器没有把这些偏好变化识别成 authority update。
2. `scope_control` 关系缺失：当前问题只出现“现在怎么选”，而长期偏好在较早 loop；词面相关性不足时，选择器没有建立当前任务与全局偏好的 scope bridge。

这说明需要优化的不是“删多少”，而是：**哪条历史仍然拥有决定当前答案的权威。**

## 三态外部语义

v4 不把选择结果解释为物理删除：

| disposition | 含义 | raw ledger |
|---|---|---|
| `MATERIALIZED` | 本轮把完整 dialogue/tool-evidence island 放进模型输入 | 永久保留 |
| `LOCATOR_ONLY` | 本轮只保留可回取 locator、hash、坐标和原因，不放原文 | 永久保留 |
| `EXCLUDED` | 结构上不应进入模型，例如 tool call 参数或非可渲染事件 | 永久保留 |

Manifest 明确记录 `physicallyDeleted = 0`。只有用户明确授权清理时，raw 才能进入独立 cleanup 流程。

## v4 选择流程

1. 从当前用户问题、确认 Idea/state、continuation frame 和显式 locator 建立 hard roots。
2. 检测用户原文中的强更新、偏好与 scope 信号，建立 `authority-update` 和 `authority-scope-bridge` roots。
3. 对 hard roots 恢复完整 loop-island，并执行 provider/tool/continuation 必要依赖闭包。
4. 若较新的强更新与旧用户岛共享主题，则旧岛进入 `LOCATOR_ONLY`，记录 `shadowedBy`；不物理删除，也不阻止显式历史回取。
5. 只对剩余 soft candidates 做预算内物化；覆盖充分即停，证据不足则产生 gap 或有界 raw lookup。

authority 事件只投影必要的用户原文，不因为同 loop 的 assistant 长回复而自动拖入整个 verbose island；若工具证据或 provider transaction 要求闭包，则仍恢复必要完整块。

## 随机森林的位置

实现提供一个纯 JavaScript、同步、数值特征的 decision-forest reranker。它只能调整 soft candidates 的优先级，不能：

- 压制确认 Idea/state、用户明确点名证据或 authority roots；
- 越过依赖闭包与 hard-gap；
- 读取 raw 文本执行任意规则；
- 自动写入长期状态。

模型通过 `PI_IDEA_FOREST_MODEL` 显式加载；默认不加载，格式或边界校验失败时回退确定性排序。当前没有用 16 条难例训练森林，避免把测试集变成训练集。

## 唯一一次 1% Luna-low 难例诊断

样本为官方 1,550 条中的 16 条（1.032%），人为定向抽取难例：8 条 `valid_memory_selection`、8 条 `scope_control`，包含旧 Sol 门的 6 个 authority discordant。严格串行、CPU 组装、Luna low 回答与盲判；因此结果标记为 `dev-tuned`，置信区间不具推断资格。

| 指标 | raw | authority-v4 | 差异 |
|---|---:|---:|---:|
| task success | 75.00% | 81.25% | +6.25pp |
| answer accuracy | 81.25% | 81.25% | 0 |
| authority use | 81.25% | 93.75% | +12.50pp |
| mean input evidence tokens | 2417.13 | 1523.88 | -36.96% |
| retrieval missing | 1 | 0 | -1 |
| assembly P95 | 2.471 ms | 0.916 ms | -1.555 ms |

任务 paired 结果为 raw-only 2、v4-only 3；authority 为 raw-only 1、v4-only 3。`n=16` 太小且是难例定向样本，不能声称普遍提升或通过非劣门。

诊断后又加入了确定性的 supersession shadow：一个残余 case 已在 CPU replay 中从同时携带旧旅行偏好和新本地偏好，变为只物化新更新；这项后续改动没有再做模型测试。

另一个残余 case 的证据已充分且 authority 正确，但模型在“基础款椅子 / 可调高端椅子”的选择上仍被 judge 判错，属于答案决策或评测细粒度问题，不应通过继续删除证据来修补。

结果文件：`research/benchmarks/bidirectional-context/results/luna-hard-1pct-2026-08-13T13-16-25-283Z-1ab0e64f.json`。

## 全量 CPU 组装回放

最终 supersession shadow 加入后，对全部 1,550 条官方样本做零模型、CPU-only 回放：

- overflow：0；
- raw mean：2043.73 tokens；v4 mean：1395.48 tokens；减少 31.72%；
- v4 assembly：mean 0.348 ms，P50 0.315 ms，P95 0.598 ms，max 1.377 ms；
- 1,388 个 case 建立 relation；549 个 case 产生 shadow；2,261 个块降为 locator-only。

它只证明当前实现的组装速度、可重放性与压缩形态，不证明模型任务质量。

结果文件：`research/benchmarks/bidirectional-context/results/authority-v4-full-cpu-20260813.json`。

## 调用与预算记录

本轮只执行了用户授权的 1% Luna-low 测试，没有使用 GPU，也没有并发模型调用。可观测 provider usage 为 219,674 tokens。第一次沙箱内启动在任何模型输出前因 Pi `proper-lockfile` 对 `C:\Users\XU\.pi\agent\trust.json.lock` 创建目录返回 `EPERM`；共享账本仍保守计入 71,001 input tokens，因此账本总计为 290,675 tokens。另一次 Windows cache rename `EPERM` 通过原子写重试与 resume 恢复。

## 采纳决定

- `safe`：继续作为默认生产模式，完整保留 Pi 原生上下文并注入确认锚点。
- `experimental`：使用 authority-v4、三态 disposition 与可选 forest reranker，供后续正式 Sol 配对门验证。
- 不再基于本轮样本继续调参或做模型测试；任何默认启用都必须重新获得明确授权并通过冻结的 Sol 非劣合同。
