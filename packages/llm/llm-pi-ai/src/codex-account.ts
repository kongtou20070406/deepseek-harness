/** OpenAI membership login and Codex usage Remote owned by llm-pi-ai. */

import type { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import type { Models, OAuthCredential } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HarnessPiAiCredentialStore } from './codex-credentials.ts'
import type { CodexAccountStatus, CodexLoginStart, CodexLoginState, CodexUsageSnapshot } from './codex-types.ts'
import { queryCodexUsage } from './codex-usage.ts'

export type * from './codex-types.ts'

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 400)
}

/**
 * Build the narrow provider collection owned by the account lifecycle.
 * @param store - persistent Harness-backed pi-ai credential store.
 * @returns a model collection containing the OpenAI Codex provider.
 */
export function createOpenAICodexModels(store: HarnessPiAiCredentialStore): Models {
  const models = createModels({ credentials: store })
  models.setProvider(openaiCodexProvider())
  return models
}

/** Host service for the one persisted OpenAI Codex membership account. */
export class OpenAICodexAccount extends TypertRemoteService {
  private readonly models: Models
  private loginState: CodexLoginState = { state: 'idle' }
  private loginTask: Promise<void> | undefined
  private loginAbort: AbortController | undefined

  constructor(
    ctx: Context,
    private readonly store: HarnessPiAiCredentialStore,
    private readonly usageTimeoutMs: () => number,
  ) {
    super(ctx, 'openaiCodex')
    this.models = createOpenAICodexModels(store)
  }

  /** Abort and settle a live device login when the plugin unloads. */
  async close(): Promise<void> {
    this.loginAbort?.abort('llm-pi-ai disposed')
    await this.loginTask
  }

  /**
   * Return non-secret persisted and in-flight account state.
   * @returns the current authentication and device-login status.
   */
  @Remote('status')
  async status(): Promise<CodexAccountStatus> {
    return {
      authenticated: (await this.store.read('openai-codex'))?.type === 'oauth',
      login: this.loginState,
    }
  }

  /**
   * Start the provider's device-code flow and return once its user code exists.
   * @returns the verification URI, user code, and optional expiry.
   */
  @Remote('beginLogin')
  async beginLogin(): Promise<CodexLoginStart> {
    if (this.loginState.state === 'pending' && this.loginState.start !== undefined) return this.loginState.start
    if (this.loginTask !== undefined) await this.loginTask
    const controller = new AbortController()
    this.loginAbort = controller
    this.loginState = { state: 'pending' }
    let resolveStart!: (value: CodexLoginStart) => void
    let rejectStart!: (error: Error) => void
    const started = new Promise<CodexLoginStart>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    this.loginTask = this.models.login('openai-codex', 'oauth', {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === 'select') return 'device_code'
        throw new Error(`OpenAI device login requested unsupported prompt type "${prompt.type}"`)
      },
      notify: (event) => {
        if (event.type !== 'device_code') return
        const start: CodexLoginStart = {
          verificationUri: event.verificationUri,
          userCode: event.userCode,
          ...event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds },
        }
        this.loginState = { state: 'pending', start }
        resolveStart(start)
      },
    }).then(() => {
      this.loginState = { state: 'succeeded' }
    }).catch((error: unknown) => {
      const message = messageOf(error)
      this.loginState = { state: 'failed', message }
      rejectStart(new Error(message))
    }).finally(() => {
      this.loginAbort = undefined
      this.loginTask = undefined
    })
    return started
  }

  /**
   * Return the current device-login state without waiting for completion.
   * @returns the latest in-memory device-login projection.
   */
  @Remote('pollLogin')
  pollLogin(): CodexLoginState {
    return this.loginState
  }

  /**
   * Resolve or refresh the OAuth token and query the current subscription meters.
   * @param signal - optional caller cancellation in addition to the configured timeout.
   * @returns the bounded non-secret usage snapshot.
   */
  @Remote('usage')
  async usage(signal?: AbortSignal): Promise<CodexUsageSnapshot> {
    const stored = await this.store.read('openai-codex')
    return queryCodexUsage(
      this.models,
      stored?.type === 'oauth' ? stored as OAuthCredential : undefined,
      this.usageTimeoutMs(),
      signal,
    )
  }

  /**
   * Remove the persisted OAuth credential and reset the visible login state.
   * @returns the unauthenticated account projection after deletion.
   */
  @Remote('logout')
  async logout(): Promise<CodexAccountStatus> {
    this.loginAbort?.abort('OpenAI Codex logout')
    await this.loginTask
    await this.models.logout('openai-codex')
    this.loginState = { state: 'idle' }
    return this.status()
  }
}
