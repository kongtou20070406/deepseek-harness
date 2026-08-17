# Pi-Idea 高速控制器与主循环审查

日期：2026-08-14
结论：三层研究状态和确定性高速控制器已经落地；上下文准备热路径通过 100 ms 死线。当前尚未自动发起下一次 Pi 模型调用，外层 self-run 调度仍是下一阶段。

## 1. 实际热路径

```text
当前用户消息
  -> SQLite 读取会话所属 Idea
  -> 读取 Idea Kernel / Research Frame / Working State
  -> O(1) 控制器判定 continue / verify-stop / ask-user / complete / discuss
  -> 本地索引选择相关历史，覆盖充分即停
  -> 生成一次性 Anchor + Evidence View + Manifest
  -> 调用主模型
```

热路径不调用模型、不做摘要、不等待后台切块、不调用 Obelisk，也没有多重 reviewer。

## 2. 三层权限

| 层 | 保存内容 | 模型权限 | 生效条件 |
|---|---|---|---|
| Idea Kernel | 科学对象、成功标准、不可替代边界 | 只读，可建议 diff | 用户确认新版本 |
| Research Frame | 当前路线、路线边界 | 只读，可提出候选 | 用户确认 Frame diff |
| Working State | 当前假设、证据缺口、下一动作、停止建议 | 可填写受限槽位 | 立即成为工作视图，但没有科学裁决权 |

模型不能写 `phase`、`acceptanceStatus` 或 `blockedReason`。因此它可以提出“下一步做什么”和“建议停”，但不能把建议伪装成完成、验收通过或 Harness 阻塞。

## 3. 高速控制器

控制器是纯函数，只读取 Working State：

| 条件 | 动作 |
|---|---|
| Harness 已确认 acceptance=passed | `complete` |
| Harness 已记录 blockedReason | `ask-user` |
| 模型提出 stopProposal | `verify-stop`，不直接停止 |
| 存在 nextAction | `continue` |
| 以上都没有 | `discuss` |

它没有模型判断、随机树、森林或二次审核。智能用于提出假设和动作；权限边界及状态转移由确定性代码保证。

## 4. 延迟证据

CPU、单进程、SQLite `:memory:`，3000 次稳态循环，每次包含：会话查询、Idea 与三层状态恢复、Todo/Workflow 状态读取、Anchor 生成。

| 指标 | 结果 |
|---|---:|
| mean | 0.099 ms |
| P50 | 0.079 ms |
| P95 | 0.125 ms |
| P99 | 0.211 ms |
| max | 2.702 ms |
| 硬死线 | 100 ms |

独立的 5000 历史块上下文装配基准：普通循环 P95 0.755 ms，`继续做` 场景 P95 1.374 ms，切块 P95 1.691 ms。两组证据都在 10 ms 工程目标以内。

## 5. 防翻车机制

只保留五个真正必要的硬约束：

1. Kernel 永远是第一段且逐字注入；
2. Frame 只有用户确认才生效；
3. 模型不能把 Working State 改成完成或验收通过；
4. 必需证据超过硬窗口时暴露 gap，不截断事实；
5. 所有实际注入保存 Kernel、Frame、Working State、Anchor 和证据来源哈希。

其余均为软策略：召回覆盖充分就停、可选证据可丢、模型可自由选择科研过程。

## 6. 已修复的真实故障

- 空 Pi 会话尚无 session 文件时，切换会产生新 session id，导致 Idea 主会话绑定漂移。现在会原子重绑同一逻辑会话，不制造假消息，也不调用模型。
- 初始化提示仍把“当前路线”写进旧 P0。现在候选只生成 Idea Kernel；路线随后单独提出 Research Frame。
- Manifest 只有旧 Idea hash。现在显式记录 Kernel / Frame / Working State 的版本和哈希。

## 7. 尚未完成

- `continue` 当前只作为控制决定注入模型上下文，尚未由外层 run loop 自动发起下一次 Pi 调用。
- `verify-stop` 目前定义了权限语义，但尚未连接具体的验收检查集合。
- DeepSeek Flash/Pro 路由和有限预算控制尚未接到这一控制器；它们不应进入本地准备热路径。
- Cordis 只保留为独立组件内核方向，尚未接管 Pi-Idea 权威状态。

下一步应只做一个最小纵向闭环：主模型提交 Working State -> 控制器决定 -> `continue` 自动触发下一轮；遇到 `ask-user`、硬上限或未经验证的 `verify-stop` 才停。不要在这之前引入更多 reviewer、模型摘要或 UI。

## 8. 验证状态

- 全量单元测试：106/106 通过；加入控制器后的定向测试：5/5 通过。
- Pi RPC smoke：扩展加载、命令注册和无模型 `/idea-propose` 通过。
- Web smoke：Idea/主会话/BTW 切换及空 session 重绑通过。
- 未修改 `IDEA.md`。
