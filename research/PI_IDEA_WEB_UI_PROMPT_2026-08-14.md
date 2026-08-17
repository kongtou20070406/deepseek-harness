# Pi-Idea Web UI 实现提示词

下面这份提示词可直接交给设计/前端模型，用于继续迭代 Pi-Idea 页面。它约束的是产品结果，不允许模型用视觉花活改变科研权威机制。

```text
为 Pi-Idea 设计并实现一个本地优先的科研伙伴 Web 控制面。它服务长期、多周研究，不是通用 IDE，也不是项目管理 SaaS。

产品真相：
1. 用户可管理多个 Scientific Idea；每个 Idea 同时只有一个主对话，可以有多个 BTW 支线。
2. Idea 是用户确认的科研权威。任何修改必须经过“候选 → 精确 diff → 用户确认 → 新不可变版本”；界面不能直接覆写 Idea。
3. Todo 是可编辑工作状态，不是权威 Idea。用户修改 Todo 后标记“下一次主 loop 待实践校正”，模型应结合实际工作接受、修正、阻塞或完成，而不是盲从。
4. Idea 可关联多个工作区并选择默认工作区；关联不代表扩大文件访问权限。
5. 页面必须显示主代理当前开启了多少工具/worker、正在做什么、最近结果和失败；只呈现可观察事件，不虚构百分比。
6. 提供一个“侦探白板”视图，帮助用户看清当前研究做过什么、有哪些未决线索。白板只从确认 Idea、Todo、会话、工作区、证据/工具事件派生；它不生成摘要、不显示隐藏思维链、不自动改写任何状态、不进入主对话或 worker 的模型上下文、不消耗输入 token。

信息架构：
- 左栏：Pi-Idea 标识、新 Idea、Idea 列表、版本/Todo/main 状态、新 BTW、Idea/上下文/Workflow/Manifest 快捷入口。
- 中栏：默认显示真实 Pi 对话流和 composer；可切换到侦探白板。白板分为“科学方向 P0、当前推进 Todo、对话与线索、工作线程”四区。
- 右栏：当前 Idea/版本/最后确认时间、查看全文/进入主对话/归档、Todo 编辑、工作区管理、上下文水位与 usage、运行活动、可追溯详情。
- 响应式：窄屏左栏缩窄，右栏变抽屉；手机上导航与检查器按需打开，不能把主对话挤成细缝。

视觉方向：Research Instrument / Detective Board。
- 安静、精确、可信，像实验台与案件白板的结合。
- 深色基线；琥珀色只表示用户确认权威或选中态；青色表示证据；绿色成功；60% 黄色预警；85% 红色死线。
- 使用清晰排版、细分隔线、紧凑密度和少量圆角。不要渐变、霓虹、巨型标题、满屏 KPI 卡、装饰性图表、AI 通用 dashboard 风格。
- 工具调用可以折叠；diff 必须保留等宽排版和正负行辨识。

关键交互：
- 选择 Idea 不应偷偷切换会话；“进入主对话”才显式恢复它。
- 点击已有主对话或 BTW 节点可恢复对应 Pi session。
- 创建/修改 Idea 必须先展示完整精确 diff，并明确只有用户确认才生效。
- Todo 编辑后立即显示待实践校正标记；模型处理后才清除。
- 归档不删除任何历史。解除工作区不删除文件。
- SSE 实时更新消息、工具状态、usage 与 extension UI 请求；断线要明确显示。
- 所有空状态都诚实：没有 worker 就显示空闲，未知 usage 就显示未知。

验收标准：
- 页面操作真实调用本地 Pi RPC，而不是静态 mock。
- P0 仍在每次主调用输入最前方逐字注入；网页和白板没有修改 P0 的旁路。
- 一个 Idea 无法出现两个 active main conversation。
- 白板内容从数据库和事件流重建，搜索代码可证明它没有被放进 context assembler。
- 桌面 1440×900、窄屏 1024×768 和手机 390×844 均可操作；键盘焦点、对比度、错误状态可见。
```

参考信息架构：

- Anthropic autonomous coding quickstart: https://github.com/anthropics/claude-quickstarts/blob/main/autonomous-coding/prompts/app_spec.txt
- cdesktop: https://github.com/cdesktop-ai/cdesktop
- Kanna: https://github.com/jakemor/kanna
- Walnut: https://openwalnut.dev/
