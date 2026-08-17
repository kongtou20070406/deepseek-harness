# 和空投一起修改 Pi Idea Harness

这不是一份把所有内部细节一次讲完的手册，而是后续共同开发的约定：每次只理解并修改一个最小闭环，先看到状态怎样流动，再碰实现。

## 我们每次怎么一起做

1. 先用一句话定义这次改变服务哪个科研问题。
2. 画出输入、状态、转移和输出；指出哪些状态绝不能被该模块修改。
3. 空投先选择一个真实使用场景和预期体验。
4. 我指出对应的 Pi 事件、Harness 文件和最小代码入口。
5. 我们一起改一小段；空投亲自运行命令并观察 UI/SQLite/Context Manifest 的变化。
6. 用一个反例测试确认它没有越权，然后再进入下一段。

## 当前代码地图

```text
extensions/idea-harness.js   Pi 事件、命令、工具与轻量 UI
src/state-store.js           Idea/P1/Luna/Manifest 的 SQLite 状态机
src/context-compiler.js      每次主模型调用前的上下文拼装与预算
src/luna-context.js          Luna 候选构造、来源校验、快照渲染
test/                        不调用付费模型的行为规格
```

## 第一节建议：亲手看见 Luna 改变上下文

目标不是先学完 JavaScript，而是看见一条完整信息流：

```text
/luna refresh <任务>
→ luna_refresh_context
→ gpt-5.6-luna 选择带 ID 历史
→ luna_snapshots 写入 SQLite
→ ContextCompiler 注入快照并裁掉旧历史
→ /context 显示减少的主模型 token
```

对应的第一个可亲手修改参数是 `src/luna-context.js` 中的：

- `LUNA_MAX_CANDIDATE_TOKENS`：Luna 最多读取多少候选历史；
- `LUNA_MAX_PACKET_TOKENS`：最多把多少 Luna 结果交给主模型；
- `LUNA_MAX_SELECTED_ITEMS`：最多选入几条来源。

修改其中一个值后运行：

```text
npm test
```

再在 Pi 中 `/reload`，用 `/luna refresh <真实任务>` 和 `/context` 观察行为。这会是后续手把手共同开发的起点。
