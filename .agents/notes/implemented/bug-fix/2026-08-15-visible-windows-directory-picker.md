# Agent Note: Keep the Windows workspace picker visible

Status: implemented

English | [中文](2026-08-15-visible-windows-directory-picker.zh.md)

## Problem

The Windows native directory-picker worker was spawned with Node's `windowsHide` option. Its first top-level window is the `IFileOpenDialog`, so Windows applied the hidden startup state to the chooser itself: `host.pickDirectory` stayed pending while the user saw no window or error.

## Decision

The Win32 dialog worker starts without `windowsHide`. It still inherits no console stream for stdin and uses the existing IPC channel, but the first GUI window remains visible and selectable. A spawn-boundary regression test rejects reintroducing the hidden-window option.

## Alternatives considered

**Switch every Windows deployment to the browse picker.** Rejected because the native provider is otherwise functional and is the intended local-loopback interaction; remote or ambiguous deployments already select the browse provider.

**Add a second PowerShell picker fallback.** Rejected because it adds another mechanism without fixing the defect in the packaged `IFileOpenDialog` path.

## Consequences

Local Windows workspace selection opens a visible OS chooser again. The worker can briefly expose an ordinary console only if its stdio contract later changes; the current inherited/IPC setup creates no console window and keeps the GUI as the first visible surface.
