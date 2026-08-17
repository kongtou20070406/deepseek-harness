# pi-idea-harness

`pi-idea-harness` 是一个建立在 `earendil-works/pi` 公共扩展 API 上的轻量科研对话层。Idea 仍是原生 Pi 对话，但额外绑定逐字 P0、短 P1、版本、控制权、Context Manifest 和原生语义块 compaction。

## 两种入口

```powershell
# 普通 Pi 对话：Harness 全局可用，但不注入 Idea
pi

# 进入某个 Idea：默认恢复该 Idea 登记的主对话
pi-idea "C:\path\to\IdeaSpace"
```

也可以运行 `pi --idea` 显式进入当前目录向上发现的 Idea。已绑定的 Idea session 即使通过 Pi 原生 `/resume` 恢复，也会根据 session 内 binding 自动激活 Harness。

当前本机全局配置已把此 package 登记到 `C:\Users\27363\.pi\agent\settings.json`。普通 `pi` 保留 Pi 默认 UI、会话与上下文；只有显式 Idea 对话启用两行研究 footer、P0/P1 注入和后台整理。`pi-idea` 不再重复用 `--extension` 加载同一 package，因此 Pi 原生 `/reload` 可以稳定重载当前源码；仅在未安装 package 的便携调试中设置 `PI_IDEA_EXPLICIT_EXTENSION=1`。

## 常用命令

- `/idea-init`：在当前目录以自然语言开始新 Idea；AI 整理候选，用户确认后才冻结 P0。
- `/idea`：查看权威 P0、待确认精确 diff 与版本历史。
- `/context`：查看本次实际输入 Manifest 与最近 Pi 原生语义块。
- `/context edit`：编辑短 P1 阶段工作集。
- `/idea-main`：返回该 Idea 登记的唯一主对话。
- `/idea-takeover`：经用户确认，让当前持久会话接管控制权。
- `/think` 或 `Alt+T`：快速选择思考等级；Pi 原生 `Shift+Tab` 仍可循环。
- `/usage`：只读查询当前 Pi Codex 订阅账户 Usage。
- `/guide`：查看保留的 Pi 原生能力、快捷键和 Harness 入口。
- `/luna`：显示当前状态；Luna 上下文快照已停用，未来只作为简单工作线程。

## 上下文与无感压缩

每次 LLM call（包括工具后的每个 loop）都重新组装：

```text
逐字 P0 + 受保护 P1 + Pi 原生 compaction summary + 最近 turns
```

P0 永远位于第一条用户消息最前方，不参与摘要。ContextCompiler 保存每次真实输入的来源、预算、token 与哈希。

当会话达到窗口约 40% 且 Pi 已完全 `agent_settled`，Harness 通过公共 `ctx.compact()` 非等待式触发 Pi 原生递归 compaction。摘要按六类块组织：`FINDINGS`、`HYPOTHESES`、`CONFLICTS`、`OPERATIONS`、`DECISIONS`、`OPEN_LOOP`。Luna 快照不再进入主上下文。

防资源爆炸边界：5 分钟 cooldown、至少新增 8k token 才 rearm、摘要目标小于 4500 token、块解析最多 20 万字符、每会话只保留最近 8 代块元数据，且不复制摘要正文。

详细说明见 [docs/CONTEXT_ASSEMBLY.md](docs/CONTEXT_ASSEMBLY.md)，论文依据见 [docs/MEMORY_RESEARCH.md](docs/MEMORY_RESEARCH.md)。

## 验证

```powershell
$node = 'C:\Users\27363\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test

$env:PI_CLI = 'C:\Users\27363\Documents\ChatGPT\Idea\.tools\pi-cli\node_modules\@earendil-works\pi-coding-agent\dist\cli.js'
& $node scripts\pi-rpc-smoke.js
```

默认测试和 RPC 冒烟不调用付费模型。真实后台 compaction 只有跨过软阈值后才使用当前 Pi 模型。

## 当前边界

已实现最小 Idea 闭环、唯一主会话、逐字注入、原生语义块 compaction、二级检查、两行上下文组成 footer、思考选择和 Usage。内置 Read/Bash/Edit/Write/Find/Grep/Ls 保留 Pi 原生执行与渲染，使用 Pi 原生 `Ctrl+O` 展开/折叠；Harness 不再覆盖其工具 UI。Luna 简单工作线程、Workflow、授权 Sol 审查、Obelisk sidecar、实验进度与 Windows 高危操作 guard 尚未完成。
