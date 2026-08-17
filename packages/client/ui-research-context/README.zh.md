# @deepseek-ai/dsh-client-ui-research-context

[English](README.md) | 中文

把 Pi-Idea 上下文组装明细放进 DSH 现有 ContextMeter 的浏览器渲染器。它不再注册常驻输入区状态条，也不再注册侧栏“侦探证据板”入口；用户通过 `/idea` 查看或修改当前 Session 的 Idea。

原控制台和证据板组件暂时保留源码兼容，以便未来由命令按需打开，但不会占用当前界面。

## Model Experience

### 按需上下文明细

#### What the model sees

无。组件只读取 Session projection，不创建模型消息。

#### Token effect

零模型 token。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- ContextMeter 只显示有界的近期 Manifest；完整时间线属于 append-only Session log。
- 可视化侦探板目前没有入口，但语义数据仍保留。
