# Agent Note: 保持 Windows 工作区选择器可见

Status: implemented

[English](2026-08-15-visible-windows-directory-picker.md) | 中文

## Problem

Windows 原生目录选择 worker 使用了 Node 的 `windowsHide` 选项启动。它创建的第一个顶层窗口正是 `IFileOpenDialog`，因此 Windows 把隐藏启动状态应用到了选择器本身：`host.pickDirectory` 一直等待，但用户看不到窗口或错误。

## Decision

Win32 对话框 worker 不再使用 `windowsHide`。它仍然不接收 stdin，并继续使用现有 IPC 通道，但第一个 GUI 窗口保持可见且可操作。spawn 边界回归测试会拒绝重新引入隐藏窗口选项。

## Alternatives considered

**让所有 Windows 部署都改用浏览器目录选择器。** 拒绝，因为原生 provider 的其他部分可用，而且它本来就是本机 loopback 场景的目标交互；远程或信息不明确的部署已经会选择 browse provider。

**增加第二套 PowerShell 选择器回退。** 拒绝，因为这会增加另一种机制，却没有修复已打包 `IFileOpenDialog` 路径中的缺陷。

## Consequences

Windows 本机工作区选择会重新打开可见的 OS 选择器。若未来改变 stdio 约定，worker 可能短暂出现普通控制台；当前继承／IPC 设置不会创建控制台窗口，并保持 GUI 是第一个可见表面。
