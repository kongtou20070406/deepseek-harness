# Pi-Idea DSH migration handoff

## Runtime

- Web UI: `http://127.0.0.1:3080/`
- Cold start: `Start-ScheduledTask -TaskName 'Pi-Idea DSH'`
- Direct foreground start: `pwsh -NoProfile -File "D:\Myfile\work space\pi-idea-dsh\scripts\start-pi-idea-dsh.ps1"`
- Hot use: keep the scheduled process running and reopen or refresh the Web UI. Sessions, workspaces, OAuth credentials, and research events are persisted outside the browser tab.

## Registered workspaces

- `pi-idea`: `D:\Myfile\work space\pi-idea`
- `equilibrium_operator_2027`: `D:\Myfile\work space\equilibrium_operator_2027`
- `pi-idea-dsh`: `D:\Myfile\work space\pi-idea-dsh`

## Imported research handoffs

- Pi-Idea self-bootstrap package: `D:\Myfile\work space\pi-idea\.dsh\handoffs\codex-pi-idea-self-bootstrap-2026-08-16.json`
- Pi-Idea Creation Mode Session: `session-0c6d44c9-f8ec-4eb4-8839-c9bf97f76128`
- EqOp package: `D:\Myfile\work space\equilibrium_operator_2027\.dsh\handoffs\codex-eqop-2026-08-15.json`
- EqOp PTC Session: `session-d87a6ace-a7d7-4562-8db7-f7d3ac5ed296`

An imported handoff is candidate evidence with source identity. It does not modify Idea Kernel or Research Frame authority.

## Product behavior added for this migration

- Idea authority is Workspace-scoped: one Workspace has one durable Idea record. Sessions under that Workspace share the record; another Workspace cannot read or mutate it through Session history.
- The current Pi-Idea and EqOp records are already independent. They temporarily display the same generic migration seed because it was copied from legacy per-Session state. Their real project-specific Kernel and Frame must be proposed and confirmed separately; handoff evidence is not promoted automatically.
- Creation Mode retains Cordis inspection and plugin experimentation while using the PTC code-dispatch tool surface and Pi-Idea research-context compaction.
- Codex OAuth is persisted through the DSH credential service. If DSH has no Codex credential, the product bundle may import Pi's local OAuth once and persist it; relaunching DSH does not require a new login while the refresh credential remains valid.
- The compact Codex usage ring is mounted beside the composer controls; activating it shows the five-hour and seven-day windows.
- Archived Sessions are hidden from active workspace groups but remain available through the sidebar archive view and can be restored without changing their append-only logs.

## Authority boundary

The files in this directory are migration evidence, not scientific authority. Only the normal Idea proposal, exact diff, and user-confirmation path may change Idea Kernel or Research Frame.
