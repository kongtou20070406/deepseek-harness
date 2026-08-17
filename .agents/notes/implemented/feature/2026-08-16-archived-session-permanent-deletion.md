# Agent Note: Permanent deletion of archived sessions

Status: implemented

English | [中文](2026-08-16-archived-session-permanent-deletion.zh.md)

## Problem

Archiving hides a session from every grouping surface but keeps its durable log and workspace accounting slot indefinitely ([archive note](../feature/2026-07-31-session-archive-global-set.md)). A user who has decided a session is done forever had no way to reclaim its storage: the archive row offered only "Restore", so every archived session remained on disk with no removal path. The product gap is a **confirmed permanent deletion** that removes the durable log, the workspace membership slot, and the archive-set bit, while never running against a live or unarchived session by accident.

## Decision

**Permanent deletion is a first-class persistence primitive threaded through the Workspace registry, the RPC seam, and the client, and it is gated on the archive set: only an archived, non-live session can be deleted.**

- Persistence: `SessionPersistence` gains an abstract `delete(id, signal?)`; every `PersistenceBackend` must implement `deleteStored(id, signal?)`. The coordinator's `delete` waits for retirement, rejects a still-live id (`cannot delete ... while it is live`), runs on the per-id chain (so an in-flight append cannot race removal), then calls the required backend primitive and drops the in-memory state and preparation cache for the id. A backend can no longer report successful deletion by silently omitting the primitive.
  - JSONL backend: `deleteStored` resolves the physical log across project directories (cwd may be unknown), removes the log file, then best-effort removes the now-empty session directory.
  - SQLite backend: `deleteStored` deletes the `sessions` row in one statement; the `events` rows follow via the existing `ON DELETE CASCADE`, never deleted individually.
  - Deleting an already-absent id is a no-op.
- Workspace registry: `ctx.workspaceRegistry.deleteSession(id)` rides `enqueueOperation`. It rejects a live id (`WorkspaceSessionLiveError`) and an unarchived id (`WorkspaceSessionNotArchivedError`), then calls `sessionPersistence.delete`, removes membership through each `WorkspaceEntity.detachSession` write path (refreshing the entity snapshot), drops the id from the header/path index, and rewrites the archive set. Persistence deletion commits before any durable registry bookkeeping changes. Once both layers commit, the registry emits `workspace/session-deleted`.
- RPC: new unary `workspace.deleteSession({sessionId}) → {archivedSessionIds}`. Live and unarchived ids map to the new error codes `session-live` and `session-not-archived` (details `{ sessionId }`), added to `RpcErrorDetailsMap` and `rpcErrorSchema`.
- Host and client projection: every Host stream translates `workspace/session-deleted` into the existing `host/session-removed` frame, so all connected clients remove the cold session from their Sessions projection. `IWorkspaces.deleteSession`, `WorkspaceManager.deleteSession`, and `WorkspacesService.deleteSession` forward the unary and install the Host's updated archive set.
- UI: the archive section's per-row action set gains "Delete permanently" beside "Restore", opening a confirmation dialog whose copy states the deletion is irreversible ("此操作无法撤销" / "This cannot be undone") before dispatching.

## Alternatives considered

**Deleting directly from the persistence service, bypassing the archive gate.** Rejected: a bare `sessionPersistence.delete` with no archive/liveness guard would allow an accidental destructive call against a live or recently-open session; the archive set is the one durable confirmation a user has already expressed.

**A soft "archive-then-purge" two-step with a retention window.** Rejected: the archive set already is the soft step; adding a second deferral layer re-imposes storage growth the feature exists to remove, with no product owner for a retention policy.

**Deleting events row-by-row in SQLite instead of relying on `ON DELETE CASCADE`.** Rejected: the cascade is already the declared referential-integrity mechanism for the `events` table; duplicating it risks divergence and adds code with no behavioral gain.

## Consequences

Permanent deletion finally couples archive to storage reclamation: a user must archive (a reversible, non-destructive act) before deleting (an irreversible act), and the UI re-states irreversibility before dispatch. The persistence contract requires a real delete primitive from every backend; both first-party backends implement it. The archive note's "no viewing or deletion surface" gap is closed for deletion specifically: restore remains the only non-destructive action from the archive view. The wire surface is a pre-release direct edit (no compatibility layer), matching the archive note's posture.
