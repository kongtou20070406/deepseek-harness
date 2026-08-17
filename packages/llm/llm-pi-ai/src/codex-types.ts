/** Client-safe OpenAI Codex account and subscription-usage vocabulary. */

/** One Codex rate-limit window returned by the account endpoint. */
export interface CodexUsageWindow {
  readonly usedPercent: number
  readonly windowMinutes?: number
  readonly resetsAt?: number
}

/** One named Codex limit with its short and long windows. */
export interface CodexUsageLimit {
  readonly id: string
  readonly name: string
  readonly primary?: CodexUsageWindow
  readonly secondary?: CodexUsageWindow
}

/** Non-secret Codex subscription usage shown to the user. */
export interface CodexUsageSnapshot {
  readonly limits: readonly CodexUsageLimit[]
  readonly planType?: string
  readonly credits?: {
    readonly hasCredits: boolean
    readonly unlimited: boolean
    readonly balance?: string
  }
  readonly observedAt: string
}

/** Current persisted OpenAI membership-login state. */
export interface CodexAccountStatus {
  readonly authenticated: boolean
  readonly login: CodexLoginState
}

/** Device-code values the browser needs to complete membership login. */
export interface CodexLoginStart {
  readonly verificationUri: string
  readonly userCode: string
  readonly expiresInSeconds?: number
}

/** Current state of the one account login operation. */
export type CodexLoginState =
  | { readonly state: 'idle' }
  | { readonly state: 'pending'; readonly start?: CodexLoginStart }
  | { readonly state: 'succeeded' }
  | { readonly state: 'failed'; readonly message: string }
