# @deepseek-ai/dsh-research-context-controls

[English](README.md) | 中文

每个 Session 一份持久 Idea 的精简控制层。`/idea` 查看；`/idea set <文本>` 与 `/idea frame <文本>` 整体替换 Seed 或 Frame。反馈含义明确时，顶层模型可用 `update_research_idea` 自发维护同一状态。

实质歧义会自动转讨论：当两种合理解释会改变研究对象、成功判据、禁止偷换项或高锁定动作时，稳定策略要求模型调用 `manage_idea_discussion`。讨论状态会持久化，只暂停冲突动作；下一次用户明确回答解决讨论前，Runtime 拒绝模型改写 Idea。

探究与证据层可为空，禁止预建空占位。真实证据只保存短标记和原始事件定位。

## Model Experience

### Session Idea 控制

#### What the model sees

一段稳定短策略和五个小工具：状态读取、Idea 更新、Working State 更新、稀疏 Inquiry 更新、Idea 讨论管理。`/research` 仅保留高级与旧版兼容命令。

#### Token effect

不调用第二个分类模型。主模型执行短触发规则；Skill 正文只在命中后加载；只有真实状态变化才产生工具结果 token。

#### KV Cache effect

稳定策略和 schema 保持请求前缀。Seed／Frame 更新只改变该 Session 后续的 Idea 前缀。

## Known Limitations and Deferred Work

- 语义歧义由当前主模型判断；Runtime 负责判断后的持久化与更新顺序约束。
- 证据标记只帮助召回，不判断科学闭合。
