# Agent Note：Workspace 多 Idea 与按 Session 选择
状态：已实现

[English](2026-08-16-workspace-ideas-and-per-session-selection.md) | 中文

## 问题

一个 Workspace 可以包含多个相互独立的 Idea 目标，而每个对话可能需要继续当前目标、切换到另一个目标，或停止组装 Idea 上下文。单一 Workspace 权威状态无法在不混合对话研究记录的情况下保存这些选择。

## 决策

**在每个 Workspace 权威记录内保存 Idea 目录。** 记录按稳定 `ideaId` 保存每个目标的一份 `ResearchStateProjection` 和供选择器显示的标题。没有 `ideas` 字段的旧记录继续读取为 `idea-default`，后续持久变更时再写入目录。

**用 Session 事件持久化对话选择。** `research/idea-selection` 携带所选 `ideaId`、当前目录快照；`null` 表示关闭 Idea。科研组装器提供 `ideaId`、`lastIdeaId`、`listIdeas`、`selectIdea` 和 `createIdea`；生成请求前，所选状态会镜像到 Session。`null` 选择复用现有按 Session 的关闭控制，因此 compaction 不会追加科研视图。

**把 research 命令作为持久用户路径。** `/research idea <id>` 选择已有目标，`/research idea create <title>` 新建并选择目标，`/research idea off` 与 `/research off` 关闭，`/research on` 恢复最近一次非空目标。IdeaDock 显示目录选择器，只保留“推进”和“探究地图”视图；已移除的支持证据和上下文记录标签不再属于紧凑表面。

**按目标隔离权威。** revision 检查和状态提交都针对 Session 当前选择的 Idea；Workspace 兼容用的 `state` 字段镜像首个目标，以便读取旧记录。一个 Idea 的提案或 Working State 变化不会出现在同 Workspace 的另一个 Idea 中。

## 考虑过的替代方案

**继续一 Workspace 一 Idea，并创建更多 Workspace。** 拒绝：同一代码库的多个对话需要共享项目边界，同时保持相互独立的研究目标；拆分 Workspace 会重复路径所有权和导航。

**只把选择保存到浏览器状态。** 拒绝：恢复对话、另一个客户端以及模型可见组装都需要同一个持久 Session 事实。追加事件还使关闭状态可以回放。

**把所有 Idea 放入每次请求，让模型自行选择。** 拒绝：这违反所选目标契约，增加上下文成本，并允许无关权威影响当前对话。

## 后果

Idea 记录共享 Workspace 存储行，但各自拥有独立 revision 和提案流。Session log 保存紧凑目录快照，因此 projection 可以渲染选择器，而不需要第二份仅存在浏览器的状态源。关闭 Idea 会通过现有 enabled projection 隐藏 dock，并阻止科研上下文组装；重新打开时恢复最近选择的目标。Idea 创建仍通过命令完成，不在紧凑 dock 中增加第二个创建表单。

research 命令现在把合法的可见性与目标选择形式作为一等命令处理，并用回归测试阻止它们落入通用 Usage 错误。
