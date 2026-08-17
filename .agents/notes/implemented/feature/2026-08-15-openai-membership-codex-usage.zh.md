# Agent Note: 通过 pi-ai 组合 OpenAI 会员登录与 Codex 用量

Status: implemented

[English](2026-08-15-openai-membership-codex-usage.md) | 中文

## Problem

pi-ai 适配器已经包含 `openai-codex` Provider，但 DSH 没有完成其纯 OAuth 认证的入口。因此 Models 页面既不能使用 ChatGPT 会员，也不能展示该账户的 Codex 限额窗口。直接导入 CLI 认证文件会产生第二个、依赖平台的权威来源，也不符合 Cordis 的生命周期所有权。

## Decision

`@deepseek-ai/dsh-llm-pi-ai` 拥有一个 pi-ai `CredentialStore` 适配器和一个 `openaiCodex` Typert Remote。完整 Bundle 通过既有 DSH 凭据服务持久化唯一 OAuth 凭据；裸插件组合使用同一合同的内存存储。账户 Remote 与 `PiAiAdapter` 共用该存储，因此登录、token 刷新、退出和模型请求观察同一个权威来源。

Remote 提供设备码启动／轮询、非敏感状态、退出和有界用量投影。Models 客户端把这些操作渲染为一张账户卡片，不接收 access token 或 refresh token。用量解析只接受可展示的限额窗口和 credits，钳制百分比、限制文本与响应大小、拒绝重定向，并把不兼容响应报告为不可用而不是零。

用量查询被明确视为兼容层边界：ChatGPT 的 Codex 用量端点不被当作稳定公开 API。它失败时不会禁用 `openai-codex` 模型请求，也不会拖垮 Models 页面其他部分。

## Alternatives considered

**读取 Codex CLI 认证缓存。** 拒绝，因为其路径和格式属于外部实现细节，会造成跨进程所有权歧义，而且 DSH 退出登录无法真正拥有它展示为可管理的凭据。

**把 OAuth 加入通用设置 schema。** 拒绝，因为 OAuth 是交互式 Provider 生命周期，不是可编辑配置；token 字段也不应进入脱敏设置文档或浏览器表单。

**在已有凭据之前隐藏 `openai-codex`。** 拒绝，因为这会让唯一需要交互式初始化的路由无法从产品中发现和启用。

## Consequences

OpenAI 会员登录现在是普通、可逆的插件能力，登录完成后立即启用既有 pi-ai Provider。新增可变状态只是一条可中止的登录控制器；凭据仍是权威来源。裸组合保持可用，但进程重启后不保留登录。若兼容端点变化，Codex 用量可能独立退化，因此卡片会明确失败，而模型认证继续工作。
