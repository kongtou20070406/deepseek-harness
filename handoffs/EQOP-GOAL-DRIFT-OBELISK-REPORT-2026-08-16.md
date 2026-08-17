# EqOp 目标转换与长对话漂移：Obelisk 证据报告

状态：已用本机 Obelisk 索引核对；日期：2026-08-16；用途：为 Pi-Idea／DSH 上下文组装提供真实科研场景，而不是把历史叙事当成新权威。

## 直接结论

EqOp 的长期 Mission 是“完成 EqOp，并以可辩护的科学与资源证据使其成立”。“找到最终编译器”是当前科学瓶颈；DH9、MSF9、routing、某个实验队列、monitor 与 Harness 工程分别只是候选路线或执行状态。历史里确实发生过用户主动调整科学问题，但更多所谓“目标转换”其实是层级坍缩：模型把当时最具体、最近、工具输出最多的路线逐步抬成项目目标，用户只能开新对话恢复 Mission → bottleneck → route → action 的层级。

必须区分三类变化：

1. 用户确认的 Mission／Research Frame 变化：科学对象或成功标准真的改变，需要精确提案与确认。
2. 同一 Mission 下的路线变化：例如从 Semantic／F-RICH 转向“让状态方程立住”，或把 DH9 从候选亲本降回训练脚手架；它应替换 Working State，而不是改写 Mission。
3. 未经授权的目标漂移：候选、实验队列、Goal、monitor、CPU fixture 或局部工程闭环因为近期反复出现，被模型当成最终科学目标。

## 可追溯证据

### 1. 用户明确因输入负担要求开新主对话

旧 Session `codex:019f69f9-2fc9-7790-bc63-88f66e14cc05` 有 18,142 条消息。用户先在 `:062297`／`:062298` 问“输入token为什么这么多？”，37 秒后在 `:062316` 明确说“把信息汇总一下我去开个新的主对话”。该 Session 的累计 request input 约 3.711B tokens；这是多轮请求的累计工作量，不是单次上下文窗口。

紧接着的新 Session `codex:019f7d2b-4181-72b1-8a20-e0584d53caa7` 在开场 `:000010` 用很窄的合同重新声明“总目标”、固定方程／路线边界、证据顺序和禁止偷换项。它仍主要使用 `gpt-5.6-sol`，因此改善不是换模型，而是清除了旧表面、重新显式化目标层级。该 Session 约 4,006 条消息、累计输入约 43.28M tokens。

### 2. 用户发现旧路线和旧数据限制判断，主动做科学重构

在 `codex:019f7d2b-4181-72b1-8a20-e0584d53caa7:009099`，用户把问题重新收束为“我只给你一个目标，把状态方程立住”。随后新 Session `codex:019f82e2-ac6d-77b0-a546-6dda41320740` 的 `:000010` 以同一句话开场，`:000152` 明确说“从最初的状态方程入手……之前的路走偏了，可能本身没那么复杂”，`:000172` 又说“之前的数据限制了你的判断力……围绕当前状态方程实现一个兑现其能力的算子”。这是合法的路线／Frame 重构，不是简单遗忘历史；用户要保留失败教训，但不要保留旧路线的控制权。

### 3. 重构后仍反复需要人工纠偏

长 Session `codex:019f8393-f471-7230-8a8c-3036440cae2a` 有 19,590 条消息。用户在 `:000484` 要求把目标写入 AGENTS 以“防止中途偏离方向”，在 `:002616` 要求每次选实验检查是否偏离主线，在 `:013514` 强调“只要和目前主线相关的证据”，并在 `:017842` 直接指出“你刚刚有点偏离这个主线了”。同一 Session 尾部反复注入的 `<codex_internal_context source="goal">` 还被 Obelisk 作为普通 user 文本索引，说明控制面元数据若没有独立 authority 类型，也会被检索器误当成用户目标。

### 4. 任务对齐编译器路线因因果故事变得不透明而被终止

Session `codex:019fbbcb-be59-7920-804f-3577a3e72d25` 以“构造任务对齐的 Compiler”为主线，累计 26,014 条消息、约 1.102B request input。到 `:081074`，用户质疑“H.bias 是什么”“整个做的实验原理有问题”，要求先做“大梳理”和关键数据位置总结；随后在 `:082224` 直接“终止了吧”。这里不是模型忘了一个名词，而是长期实现与实验分支把“为什么这一条计算原则推进 EqOp”淹没了。

### 5. 新对话重新恢复了“候选不是终点”的科学层级

较短的新 Session `codex:019fdc43-1ebc-79a1-928c-228ad1ac072b:000010` 重新从理想编译器的科学定义出发，而不是从旧实验队列续跑。之后 `codex:01a008de-4ef4-7491-bf83-782d24c37dea:000011` 明确探索非 DH9 高分编译器；`:002176` 直接说“DH9 是训练脚手架而非终点公式……我需要找行的人”。这与旧 Session 把 DH9／统一亲本逐步固化为目标形成鲜明差异。

### 6. 当前对话再次暴露了同一种层级坍缩

在本轮 Pi-Idea 交接 Session `codex:019ff9e4-fe0d-7e70-a37a-e7074d33fd78:020515`，用户纠正“MSF9 不是当前目标，当前目标是找编译器”；随后 `:020687` 再次纠正“不对，核心是完成 EQOP”。这证明即使已经有 Kernel／Frame，只要把当前 bottleneck 压得过窄或把 Working State 常驻拼入检索，系统仍会把“当前要解决什么”误写成“项目为何存在”。

## 为什么旧对话没有继续，而选择新对话

新对话的价值不是“失忆”，而是一次负向重置：旧 Working State、Goal、recent loops、工具输出和局部流程默认失去控制权；用户只把 Mission、当前瓶颈、已证伪路线与必要证据重新带入。这样做有四个效果：

- 恢复目标层级，而不是继续沿最后一个实验队列自洽。
- 降低近期与细节偏置；同一个 Sol 在新 Session 中表现更清楚，说明主要差别来自上下文控制面。
- 强迫用户和模型重新写出一份窄合同，暴露“我们到底在证明什么”。
- 只迁移失败教训和证据地址，不迁移旧路线的默认权威。

旧对话的典型形态是：数千到数万消息、巨量工具结果、多个中间命名和实验治理状态，最后由最近的 Goal／monitor／fixture 决定注意力。新对话的典型形态是：一段短 Mission、当前科学瓶颈、禁止偷换项、证据门槛以及少量待办；路线重新变成可证伪、可替换对象。

## 漂移机制

1. **目标层级坍缩**：Mission、bottleneck、hypothesis、action 没有独立类型，最具体的一层吞掉上层。
2. **近期与体积偏置**：工具输出、实验脚本和最近 loop 比一句长期目标更长、更重复，词法检索和模型注意都会偏向它们。
3. **滚动压缩的路线惯性**：摘要倾向保留“正在做什么”，却弱化“为什么做、什么不能被它替代”。
4. **Goal 权威泄漏**：执行 Goal 被反复注入后，看起来像用户确认的科学目标；内部 Goal 元数据还可能被历史索引误分类。
5. **项目级 Working State 污染新 Session**：若新会话首问仍自动加载旧 Working State／Goal，新对话就失去负向重置价值。
6. **过程治理取代科学判断**：monitor、资源占用、形式闭环或工具建设成为停止／继续的主导依据，甚至覆盖用户对实验有效性的明确判断。

## 已落地的 Harness 修复

`@deepseek-ai/dsh-research-context` 现在在插件内、无模型地选择三种 focus mode：

- `continue`：仅对短续接语恢复 Working State、Goal、evidence roots 与 recent loops。
- `task`：检索只使用当前直接用户请求；旧 route／Goal 可以显示，但显式标为 provisional／execution lease，且不扩展 query。
- `reframe`：强重构语义和新 Session 首个明确请求不暴露旧 route／Goal，不使用 roots 或 mandatory recent；“不是当前目标／核心是……”会从检索 query 中去掉被否定路线。

模型可见顺序固定为：逐字 Kernel → objective ladder → confirmed Frame → 可选 provisional Working State → 可选 execution-lease Goal → 命中证据。`focusMode` 进入 durable assembly manifest、history projection 与 worker inheritance，保证“为什么卸载或恢复路线”可回放。

## 验证与边界

- 22 个 package 回归测试全部通过；包含“继续做”、普通明确任务、纯否定 MSF9、EqOp 强重构、新 Session clean focus、未完成旧 turn、manifest/history 与 worker inheritance。
- package TypeScript build 通过。
- 76-event 多 MB CPU fixture：cold 287.314 ms、immediate warm 21.913 ms、异步预热后 1.271 ms。常态满足 0.1 s 热路径；真正冷加载仍在 0.5 s 门内，但尚未达到 0.1 s。
- 选择器仍是词法／模糊／别名／可替换同步 provider，不声称已解决所有跨术语语义召回。
- Obelisk 中累计 input token 是多轮请求总量，不是唯一文本量或单次窗口占用；`codex_internal_context` 的 user 分类也证明索引元数据仍需更严格的来源类型。
- 本报告证明了真实漂移机制和确定性防护，不等于已经用数周成对科研任务证明最终科学表现优于原生滚动压缩。
