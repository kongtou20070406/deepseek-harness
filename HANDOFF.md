# Pi Idea Extension Handoff

更新：2026-08-13

## 当前结果

新的实现位于 `C:\Users\27363\Documents\ChatGPT\Idea\pi-idea-extension`，完全从零编写；旧的损坏实现只保存在 `archive\pi-idea-harness-v0-broken-20260812-2315`，未复用。

它不是独立产品，而是普通 Pi 对话的可选能力。未启用 Idea 时保持原生 Pi；任意普通对话都可以通过 `/idea-start` 变成长时间工作对话。

## 已安装环境

- Pi 0.84.1：`C:\Users\27363\Documents\ChatGPT\Idea\.tools\bin\pi.cmd`
- portable Node 24.18.0：`C:\Users\27363\Documents\ChatGPT\Idea\.tools\node-v24.18.0\node-v24.18.0-win-x64`
- 用户 Pi packages：本地 `pi-idea-extension`、`pi-diff-review`、`pi-markdown-preview`
- `PI_MARKDOWN_PREVIEW_REGISTER_EXPORT_TOOL=false`：Markdown 预览只保留用户命令，不给模型增加工具。
- 默认思考等级：`max`；使用 Pi 原生 `Shift+Tab` 切换，没有自定义 `/think`。

打开新终端后运行：

```powershell
pi
```

## 最短使用流程

```text
/idea-start 我想研究……最终希望……目前打算……
```

主模型会给出自由格式候选。随后：

```text
/idea-confirm
```

确认后，该对话每次模型调用都会逐字携带 P0。常用命令：

```text
/idea                  查看当前权威 Idea、哈希和阶段
/idea-stage ...        设置或清除当前阶段最小工作集
/idea-manifest         查看上一轮实际注入内容的结构清单
/idea-trace            按需检查隐藏的工具执行痕迹
/idea-pause            暂停 Idea 能力并恢复原生工具显示
/idea-resume           恢复
/idea-toolbox          只查看内置执行原子
/idea-skills           查看候选/已提升经验
```

Pi 使用体验扩展：

```text
/diff                  查看可读 diff
/view                  查看文件
/preview               终端 Markdown/LaTeX 预览
/preview-browser       浏览器预览
```

## 验证结果

- 扩展 29/29 单元测试在 2026-08-13 最近一次完整回归中通过；真实 Pi RPC smoke 同轮通过。公共 benchmark adapter/protocol 测试此前为 11/11，通过结果仍应在正式运行前重跑。
- Pi RPC smoke 通过：扩展可由真实 Pi 0.84.1 加载，Idea 命令完成注册，`/idea-propose` 无模型调用可执行。
- 已安装 package 列表验证通过。
- 最新 Luna 长上下文 pilot：8 条约 58.6k-token 的合成长轨迹；修正后的编译器决策 8/8，证据召回 87.5%，平均活跃上下文 4,740 tokens；完整历史也是 8/8，但平均 59,259 tokens。活跃上下文约减少 92.0%。
- 旧编译器只有 7/8，并把已经确认的 `KAPPA=0.37` 错成旧配置 `0.42`。根因是检索查询没有使用 P0；现已修复并加入回归测试。
- 最新 Luna 实验总账为 15,530,304 / 100,000,000 tokens。锁定的 LongMemEval 60 题运行曾在用户限时授权内使用 Sol/max 作回答与裁判，Luna/low 只生成标签；授权结束后已停止全部 Sol 进程，后续以 Luna 为主。
- 新增全 Luna 12 题配对 pilot：本地与 Luna cue 都是 11/12；Luna cue 平均上下文 8,023.6，对比本地 6,365.8，多约 26%，且没有改变任何题的成败。cue-only 路线已淘汰，不做 60 题扩跑。
- Oracle 延迟专项 pilot 在 8/8 正确不变时，将完整响应中位数从新进程的 7.07 秒降到常驻 RPC 的 2.58 秒，首 token 中位数 2.12 秒。仍观察到一次 14.18 秒远端长尾；因此采用中位 TTFT/P95，而不把均值当唯一指标。
- 程序索引 + Luna 后台结构化标签现已进入生产路径。基准为 24/24 正确、pass³ 100%、约 2,131 tokens、在线选择中位 0.22 ms、端到端中位 2.245 秒。
- 生产标签必须逐字回指原始块并通过 quote/hash 校验。未完成、Luna 不可用或失败时，Agent 当轮立即使用纯本地原文 passage 索引；Luna 只在后台补全，`indexWaitMs` 固定为 0，不会停止主 Agent。
- 实际生产编译器复验同样为 24/24、pass³ 100%、回答证据召回 100%；选择中位 0.94 ms、端到端中位 2.338 秒、P95 3.123 秒、上下文约 4,109 tokens。它保留 4 个 recent turns，因此没有机械追求 2,131-token 最小值。

重新验证：

```powershell
$taskNode = 'C:\Users\27363\Documents\ChatGPT\Idea\.tools\node-v24.18.0\node-v24.18.0-win-x64'
$env:Path = "$taskNode;$env:Path"
Set-Location 'C:\Users\27363\Documents\ChatGPT\Idea\pi-idea-extension'
npm test
npm run test:pi
```

## 文件地图

- `pi-idea-extension/extensions/idea.js`：Pi 命令、事件集成、后台 Luna、UI 和权限边界。
- `pi-idea-extension/src/core.js`：Idea 状态、预算、anchor、工具箱和确定性边界。
- `pi-idea-extension/src/context-compiler.js`：turn/block 分组、检索、折叠上下文与 Luna prompt。
- `pi-idea-extension/src/ring-log.js`：有界 JSONL。
- `CONTEXT_ASSEMBLY.md`：原则、真实实现和逐 loop 时序。
- `research/2026_LONG_CONTEXT_AGENT_MEMORY_RESEARCH.md`：论文证据与采用/否决决策。
- `research/LONG_CONTEXT_BENCHMARK_2026-08-13.md`：基准与限制。
- `research/HARNESS_PERFORMANCE_BENCHMARK_2026-08-13.md`：最新 7 条件、8 长轨迹的对照实验与实现决策。
- `research/SELECTOR_BENCHMARK_2026-08-13.md`：程序索引、在线 Luna、Full Raw、当前编译器和 Oracle 的延迟/正确率对照。
- `research/CONTEXT_JUDGMENT_BENCHMARK_PLAN.md`：MemoryArena 任务成功率主榜，以及 CAME、MemSyco、RECON 判断诊断矩阵。
- `research/benchmarks/longmemeval/`：LongMemEval-S 双轨任务成功率评测器、无标签泄漏测试、配对非劣统计和结果。

## 已知边界与下一步判断点

1. 完整 277 MB LongMemEval-S 已下载，500 题泄漏审计与分层 60 题配对运行已完成。结果为本地 44/60、Luna 46/60，95% CI 仍不足以宣布非劣、等价或赢家；两条路径 preference 均为 0/6。后续 12 题全 Luna pilot 已证明单纯增加 retrieval cue 不提高成功率且多用约 26% 上下文，因此不再沿 cue-only 扩跑。
2. 工具过程隐藏已在扩展层实现，仍需用户在真实交互中确认视觉/键盘体验。出现问题时先修渲染，不改上下文后端。
3. 全局摘要在小规模上下文同样达到 100% 召回；分块机制的选择基于长期增量与 provenance，不应宣称小任务质量碾压。
4. Worker/model handoff 尚未实现实际模型切换。当前只有经过约束的最小任务包原子；在具备真实 Pi 调用生命周期与成本数据前，不安装 subagent/background-task 框架。
5. 动态 Skill 只有 candidate/promote，没有自动 canary 或回滚评分。依据 ACL 2026 的经验传播风险，这一部分应继续保守。
6. 已并入生产：自由文本摘要已被 grounded structured claims 替代；在线使用确定性词项评分，Luna 不进入每 loop 的选择路径。typed links 目前只存储、不扩展，FTS5/BM25 尚未实现；只有真实 miss 证明必要时才增加。
7. 真实 miss 已经出现：preference 0/6；但 cue-only pilot 没有修复。下一版改测“证据是否有决策权”和“证据怎样改变后续动作”：MemoryArena（ICML 2026）作为产品 Task Success 主榜，CAME-Bench 作为 contextual intent 选择诊断，MemSyco-Bench 作为新旧记忆/客观证据权威诊断，RECON 作为冲突与级联失效诊断。contextual tags 只能产生候选，不能替主模型决定事实。
8. CAME、MemoryArena 和 MemSyco 官方数据/代码均已定位；当前本机到 GitHub/Hugging Face 的 TLS 连接报 `SSL_ERROR_SYSCALL`，不得通过关闭证书校验绕过。adapter 可继续开发，但正式分数必须等官方数据按哈希落盘后再跑。
9. 新索引的性能门已固定：单个新块本地可检索 P95 < 1 秒；每 loop 查询与上下文组装 P95 < 2 秒；工程目标均为 <250 ms。冷启动、增量写入和热查询必须分别报告。现有全扫描基线 P95 约 118–130 ms，任何新实现不得只提正确率而隐藏延迟退化。
