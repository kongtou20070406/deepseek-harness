# @deepseek-ai/dsh-model-execution-policy

[English](README.md) | 中文

面向指令遵从模型的全局精简执行策略。插件向每次模型请求贡献同一段稳定提示词，不增加分类器或按路由分支。

```yaml
- id: model-execution-policy
  name: '@deepseek-ai/dsh-model-execution-policy'
```

策略区分只读请求与实现请求，限定真正需要确认的少量动作，把用户对当前歧义的明确纠正视为最终答案，并区分资源观测与已测得干扰。它不会覆盖真实的平台拒绝，也不会授权超出用户请求范围的工作。

## 模型体验

### 共享执行策略

#### What the model sees

紧随 persona 的一段 `Execution policy`。每条规则只出现一次：解释最新用户意图；对范围内的 change／continue 请求直接行动；只为实质性用户选择或外部／破坏性扩张提问；在测得干扰前把警告视为观测；仍有范围内有效工作时继续推进。Sol、DeepSeek、Luna 与未来路由接收同一段落。

#### Token effect

每次模型请求增加一段短而固定的输入，不会增加辅助模型调用。

#### KV Cache effect

插件配置不变时，切换模型也保持该段前缀稳定。

## 已知限制与暂缓事项

- **提示词层适配** —— 模型行为仍有概率性；runtime sandbox、approval、工具和 Goal 执行各自保留权威。
- **共享措辞** —— 策略只编码 provider 无关的执行边界；模型家族特定调优仍由 adapter 负责。
