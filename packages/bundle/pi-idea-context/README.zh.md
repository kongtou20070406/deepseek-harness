# @deepseek-ai/dsh-pi-idea-context

[English](README.md) | 中文

DeepSeek Harness 的 Pi-Idea 上下文 bundle，叠加在 `dsh-base` 之后、`dsh-web-app` 或 `dsh-headless` 之前。

每个 Session 拥有一份 append-only Idea。中性初始 Seed 会从本对话第一个明确目标中替换；后续反馈可慢速澄清、调整或转换。旧 Workspace Idea 只在旧 Session 首次打开时惰性复制一次，随后互相独立。`/idea` 是人工查看／修改入口；模型维护含义明确的版本，遇到实质歧义会自动持久化成只问一个问题的讨论。

Working State 更快变化。只有出现真实决定或带来源结果时才建立 Inquiry／证据标记。选择性组装器保留稳定 Idea 前缀，只恢复与当前任务相关的完整 loop；真实水位压力下才交给 DSH 原生压缩。

## Model Experience

### Pi-Idea 请求表面

#### What the model sees

有界 `<research-context>`：Session Idea、可选 Frame 与任务桥、可选稀疏 Idea Lens、被选中的完整历史 loop；再加一段稳定短策略和五个小状态工具，负责自发维护与自动讨论。Skill 目录常驻简短描述，正文只在命中后加载。

#### Token effect

热路径不调用模型摘要，也不增加第二个歧义分类模型。空证据字段和 Workspace 目录消耗零 token；稳定策略、工具 schema 与慢变 Idea 前缀提高缓存复用。

#### KV Cache effect

稳定策略与 Idea 文本构成可复用前缀；快速 Working State、讨论状态和本轮证据放在后缀，尽量缩小失效范围。

## Known Limitations and Deferred Work

- 语义歧义由主模型判断；Runtime 状态阻止未解决讨论被静默绕过。
- 证据标记用于召回，不证明科学闭合。
