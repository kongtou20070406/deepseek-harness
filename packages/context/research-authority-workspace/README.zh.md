# @deepseek-ai/dsh-research-authority-workspace

[English](README.md) | 中文

已退役 Workspace Idea 目录的只读兼容桥。旧 Session 若还没有 `research/state-change`，本插件会读取它原来选择的 Workspace Idea，并让 `ctx.researchContext` 追加一次 `migrate-session-idea` 快照；此后不再查询旧目录，也绝不回写。

新旧 Idea 都改为 Session 所有。同一 Workspace 下修改一个对话，不会影响另一个对话。

## Model Experience

### 旧状态惰性迁移

#### What the model sees

不增加额外内容；复制后的 Idea 进入普通 Session 科研视图。

#### Token effect

常态为零。只有尚未迁移的旧 Session 会追加一次持久状态事件。

#### KV Cache effect

除该 Session 自己的稳定 Idea 前缀外无额外影响。

## Known Limitations and Deferred Work

- 旧目录保留在磁盘用于恢复，但不再可编辑，也不再拥有权威。
- 找不到旧记录的 Session 使用 bundle 的中性初始 Seed。
