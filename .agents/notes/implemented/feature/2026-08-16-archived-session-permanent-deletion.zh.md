# Agent Note: Permanent deletion of archived sessions

Status: implemented

[English](2026-08-16-archived-session-permanent-deletion.md) | 中文

## Problem

归档会把一个会话从所有分组视图中隐藏起来，但会无限期保留其持久化日志和工作区账目槽位（[归档说明](../feature/2026-07-31-session-archive-global-set.md)）。已经认定某个会话永久结束的用户没有任何回收其存储的途径：归档行只提供“恢复”，因此每个已归档会话都会一直残留在磁盘上而无法移除。产品缺口在于一种**经过确认的永久删除**——同时移除持久化日志、工作区成员槽位和归档集位，并且绝不会误伤一个仍在线的或未归档的会话。

## Decision

**永久删除是一等公民的持久化原语，贯通 Workspace 注册表、RPC 接缝与客户端，并且以归档集为门槛：只有已归档且非在线的会话才能被删除。**

- 持久化：`SessionPersistence` 新增抽象方法 `delete(id, signal?)`；每个 `PersistenceBackend` 都必须实现 `deleteStored(id, signal?)`。协调器的 `delete` 先等待退役，拒绝仍绑定在线会话的 id（`cannot delete ... while it is live`），在按 id 串行的链上执行（使进行中的 append 无法与删除竞争），随后调用必选的后端原语并为该 id 丢弃内存状态与准备缓存。后端不能再通过省略原语而伪装删除成功。
  - JSONL 后端：`deleteStored` 跨项目目录解析物理日志（cwd 可能未知），删除日志文件，然后尽力删除现已为空的会话目录。
  - SQLite 后端：`deleteStored` 用一条语句删除 `sessions` 行；`events` 行通过既有的 `ON DELETE CASCADE` 级联删除，绝不逐行删除。
  - 删除一个已不存在的 id 是无操作（no-op）。
- Workspace 注册表：`ctx.workspaceRegistry.deleteSession(id)` 在 `enqueueOperation` 上执行。它在线的 id 抛 `WorkspaceSessionLiveError`，未归档的 id 抛 `WorkspaceSessionNotArchivedError`，然后调用 `sessionPersistence.delete`，通过每个 `WorkspaceEntity.detachSession` 写入路径移除成员关系（同步刷新实体快照），再从 header/path 索引中删除并重写归档集。持久化删除在任何持久化注册表簿记变更之前提交；两层均提交后，注册表发出 `workspace/session-deleted`。
- RPC：新增一元方法 `workspace.deleteSession({sessionId}) → {archivedSessionIds}`。在线与未归档的 id 分别映射到新的错误码 `session-live` 与 `session-not-archived`（details 为 `{ sessionId }`），并加入 `RpcErrorDetailsMap` 与 `rpcErrorSchema`。
- Host 与客户端投影：每条 Host stream 都把 `workspace/session-deleted` 转换为既有的 `host/session-removed` 帧，使所有已连接客户端从 Sessions 投影中移除该冷会话。`IWorkspaces.deleteSession`、`WorkspaceManager.deleteSession` 与 `WorkspacesService.deleteSession` 转发该一元调用并安装 Host 返回的最新归档集。
- UI：归档区每行的操作集在“恢复”旁新增“永久删除”，在派发前弹出确认对话框，其文案明确说明删除不可撤销（“此操作无法撤销” / “This cannot be undone”）。

## Alternatives considered

**直接从持久化服务删除，绕开归档门槛。** 否决：一个裸的 `sessionPersistence.delete` 若没有归档/在线守卫，会允许对在线或近期打开的会话执行意外的破坏性调用；归档集才是用户已经表达过的唯一持久化确认。

**采用带保留窗口的软“先归档再清除”两步。** 否决：归档集本身已是软步骤；再加一层延迟会重新引入该特性要消除的存储增长，且没有任何产品负责人来承担保留策略。

**在 SQLite 中逐行删除 events，而不是依赖 `ON DELETE CASCADE`。** 否决：级联已是 `events` 表既定的引用完整性机制；重复实现有分歧风险，且无行为收益地增加代码。

## Consequences

永久删除最终把归档与存储回收耦合起来：用户必须先归档（可逆、非破坏性的动作）再删除（不可逆的动作），且 UI 在派发前重申不可逆性。持久化契约要求每个后端提供真实的 delete 原语，两个一等公民后端都已实现。归档说明中“尚无查看或删除界面”的缺口针对删除这一侧被关闭：恢复仍是归档视图中唯一非破坏性的动作。线上接口是发布前的直接编辑（无兼容层），与归档说明的姿态一致。
