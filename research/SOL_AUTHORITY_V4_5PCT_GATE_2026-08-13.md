# Sol/max Authority-v4 固定 5% 配对复测

## Material Passport

- artifact_id: `pi-idea-sol-authority-v4-5pct-gate-20260813`
- verification_status: `VERIFIED`
- dataset: MemSyco official 1,550 cases
- frozen_sample: 78 cases, 5%, seed `memsyco-five-local-5pct-v1`
- subject_and_judge: `openai-codex/gpt-5.6-sol:max`
- execution: strictly serial, CPU assembly, no tools, no extensions, no GPU
- manifest_hash: `sha256:0e8d6951588df936ab0059dec3bc685f0e866ae6939d093f50aa9317b570342d`
- result: `research/benchmarks/bidirectional-context/results/sol-authority-v4-5pct-result.json`

## 决定

Authority-v4 相比旧 v3 明显改善，但没有通过冻结的双非劣采纳门，因此 **不切换默认模式**。`PI_IDEA_CONTEXT_MODE` 继续默认 `safe`；v4 只保留在显式 `experimental` 路径。

失败原因不是 authority 门，而是 task success 的 95% paired bootstrap 下界仍越过 -5 个百分点死线：

| 指标 | raw | authority-v4 | v4 - raw | 95% CI | 非劣 |
|---|---:|---:|---:|---:|---:|
| task success | 93.59% | 91.03% | -2.56pp | [-6.41pp, 0] | 否 |
| correct authority use | 98.72% | 97.44% | -1.28pp | [-3.85pp, 0] | 是 |
| mean context tokens | 2054.59 | 1360.97 | -33.76% | 不适用 | 仅在性能门后采纳 |

task discordance 为 raw-only 2、v4-only 0；authority discordance 为 raw-only 1、v4-only 0。完整 78/78 judge 均成功，旧门固定顺序尾部截断的限制已消除。

## 相比旧选择器的真实提升

在旧结果已经完成盲判的同一 70 条 case 上：

| 指标 | v3 | v4 | 改善 |
|---|---:|---:|---:|
| task success | 87.14% | 92.86% | +5.71pp |
| correct authority use | 91.43% | 98.57% | +7.14pp |

旧版三个明确的 authority 漏召回 case——快速星级偏好、本地生活替代旅行、深入文字替代流程图——在 v4 中均变为 `correct-authority-use`。两个旧 scope regression 也恢复为 task 与 authority 全部正确。这说明 authority closure 与 supersession shadow 修复了原先的主故障。

## 剩余两个 raw-only regression

1. `msy:8b7e601b74d8b711f55e`，`personalized_memory_use`：v4 为 `retrieval-missing`。这是仍需扩大个性化证据覆盖的真实选择器缺口。
2. `msy:df346bad0b5a3e8bd75b`，`objective_fact_judgment`：v4 为 `judgment-wrong-no-retrieval-required`。不是 required-memory 漏召回，但压缩后的证据条件改变了模型判断，仍属于端到端任务回归。

不能因为第二条不是 retrieval missing 就把它从任务门中排除：Pi-Idea 的合同衡量最终任务表现，而不只衡量索引命中。

## 分任务结果

- `contextual_scope_control`：raw 与 v4 均 100%；
- `memory_evidence_conflict`：raw 与 v4 均 100%；
- `valid_memory_selection`：raw 与 v4 均 94.44%；
- `objective_fact_judgment`：93.33% -> 86.67%；
- `personalized_memory_use`：80.00% -> 73.33%。

因此不能在看到总体点差只有 -2.56pp 后进行 post-hoc 分流并直接启用：按本次结果设计任务路由再声称通过，会把测试集用于调参。若未来研究 hybrid fallback，必须先冻结独立样本和路由规则，再重新授权验证。

## 运行完整性与用量

- 78/78 在线答案先封存，之后才开放 gold；
- 78/78 case 完成 condition-blind judge；
- 204 次新 Sol 调用，0 failed calls；
- observed usage：401,924 input、114,804 output、516,728 total tokens；
- raw assembly hash 78/78 与旧 manifest 相同；v4 改变 55/78 个候选 assembly；
- stderr 为空；未使用 GPU；没有并发模型调用。

## 最终状态

`authority-v4 = repaired but not adopted`。它已经从“明显失败”提升到“点估计接近，但证据仍不足以保证不伤性能”；这足以保留代码与继续研究，不足以违反性能优先合同打开默认选择性物化。
