# Agent Note: Compose OpenAI membership login and Codex usage through pi-ai

Status: implemented

English | [中文](2026-08-15-openai-membership-codex-usage.zh.md)

## Problem

The pi-ai adapter shipped the `openai-codex` provider but DSH offered no way to complete its OAuth-only authentication. The Models page therefore could not use a ChatGPT subscription or show the account's Codex rate windows. Importing a CLI auth file would create a second, platform-specific authority and would not fit Cordis lifecycle ownership.

## Decision

`@deepseek-ai/dsh-llm-pi-ai` owns a pi-ai `CredentialStore` adapter and an `openaiCodex` Typert Remote. Full bundles persist the one OAuth credential through the existing DSH credentials service; bare plugin compositions use the same contract with in-memory storage. The account Remote and `PiAiAdapter` share that store, so login, token refresh, logout, and model requests observe one authority.

The Remote exposes device-code start/poll, non-secret status, logout, and a bounded usage projection. The Models client renders those operations as one account card. It receives no access or refresh token. Usage parsing accepts only displayable rate windows and credits, clamps percentages, bounds text and response size, rejects redirects, and reports incompatible responses as unavailable rather than zero.

The usage query is explicitly a compatibility boundary: ChatGPT's Codex usage endpoint is not treated as a stable public API. Its failure does not disable `openai-codex` model requests or the rest of the Models page.

## Alternatives considered

**Read the Codex CLI authentication cache.** Rejected because its path and format are external implementation details, it creates cross-process ownership ambiguity, and a DSH logout would not own the credential it appeared to manage.

**Add OAuth to the generic settings schema.** Rejected because OAuth is an interactive provider lifecycle, not editable configuration, and token fields must not enter the redacted settings document or browser form.

**Hide `openai-codex` until a credential already exists.** Rejected because it makes the only route that needs interactive setup impossible to discover or activate from the product.

## Consequences

OpenAI membership login is now a normal reversible plugin capability, and a completed login immediately enables the existing pi-ai provider. The extra mutable state is limited to one abortable login controller; credentials remain the authority. Bare compositions remain valid but lose persistence across process restart. Codex usage can regress independently if the compatibility endpoint changes, so the card fails visibly while model authentication continues to work.
