# Agent Note: Workspace Ideas and per-session selection

Status: implemented

English | [中文](2026-08-16-workspace-ideas-and-per-session-selection.zh.md)

## Problem

A Workspace can contain several independent Idea targets, while each conversation may need to continue one target, switch to another, or stop assembling Idea context. A single Workspace authority state cannot preserve those choices without mixing research records between conversations.

## Decision

**Store an Idea catalog inside each Workspace authority record.** The record keeps one `ResearchStateProjection` per stable `ideaId` and a title for the selector. Legacy records without `ideas` continue to read as the default `idea-default` target and gain the catalog when a later mutation persists the record.

**Persist the conversation choice as a Session event.** `research/idea-selection` carries the selected `ideaId`, the current catalog snapshot, and `null` for a closed Idea view. The research assembler exposes `ideaId`, `lastIdeaId`, `listIdeas`, `selectIdea`, and `createIdea`; the selected state is mirrored into the Session before request assembly. A null selection disables Idea context through the existing per-Session control, so compaction does not append a research view.

**Use the research command as the durable user path.** `/research idea <id>` selects an existing target, `/research idea create <title>` adds and selects a target, `/research idea off` and `/research off` close it, and `/research on` restores the last non-null target. The IdeaDock renders the catalog selector and retains only the progress and inquiry views; the removed evidence and context tabs are not part of the compact surface.

**Keep authority isolated by target.** Revision checks and state commits address the Session's selected Idea, while the Workspace's compatibility `state` field mirrors the first target for legacy records. A proposal or Working State change in one Idea is not visible in another Idea in the same Workspace.

## Alternatives considered

**Keep one Idea per Workspace and create more Workspaces.** Rejected because conversations about one codebase need a shared project boundary while retaining independent research targets; separate Workspaces duplicate path ownership and navigation.

**Keep the choice only in browser state.** Rejected because a resumed conversation, another client, and model-visible assembly need one durable Session fact. The append-only event also makes the null closed state replayable.

**Put every Idea into every request and let the model choose.** Rejected because it violates the selected-target contract, increases context cost, and lets unrelated authority influence a conversation.

## Consequences

Idea records share the Workspace storage row but have independent revisions and proposal streams. Session logs contain a compact catalog snapshot so projections can render a selector without a second client-only state source. Closing Idea hides the dock through the existing enabled projection and prevents research context assembly; reopening restores the last selected target. Idea creation remains command-driven rather than adding a second creation form to the compact dock.

The research command now treats valid visibility and selection forms as first-class commands, with regression coverage preventing them from falling through to the generic Usage error.
