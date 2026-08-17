/** Bounded query and parser for the Codex subscription usage projection. */

import type { Models, OAuthCredential } from '@earendil-works/pi-ai'
import type { CodexUsageLimit, CodexUsageSnapshot, CodexUsageWindow } from './codex-types.ts'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const MAX_RESPONSE_BYTES = 64 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finite(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function cleanText(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return undefined
  return text.slice(0, max)
}

function windowOf(value: unknown): CodexUsageWindow | undefined {
  const source = record(value)
  const used = finite(source?.used_percent)
  if (source === undefined || used === undefined) return undefined
  const seconds = finite(source.limit_window_seconds)
  const reset = finite(source.reset_at)
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    ...seconds === undefined || seconds <= 0 ? {} : { windowMinutes: Math.ceil(seconds / 60) },
    ...reset === undefined ? {} : { resetsAt: reset },
  }
}

function limitOf(id: string, name: string, value: unknown): CodexUsageLimit | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  const primary = windowOf(source.primary_window)
  const secondary = windowOf(source.secondary_window)
  if (primary === undefined && secondary === undefined) return undefined
  return { id, name, ...primary === undefined ? {} : { primary }, ...secondary === undefined ? {} : { secondary } }
}

/**
 * Parse the non-secret fields used by the Web usage card.
 * @param value - untrusted JSON-compatible usage payload.
 * @param observedAt - ISO timestamp assigned by the caller.
 * @returns the validated display projection.
 */
export function parseCodexUsagePayload(value: unknown, observedAt: string): CodexUsageSnapshot {
  const payload = record(value)
  if (payload === undefined) throw new Error('Codex usage response is not an object')
  const limits: CodexUsageLimit[] = []
  const codex = limitOf('codex', 'Codex', payload.rate_limit)
  if (codex !== undefined) limits.push(codex)
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const itemValue of payload.additional_rate_limits) {
      const item = record(itemValue)
      const feature = cleanText(item?.metered_feature) ?? cleanText(item?.limit_name)
      if (item === undefined || feature === undefined) continue
      const id = feature.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      const limit = limitOf(id || `additional_${limits.length + 1}`, cleanText(item.limit_name) ?? feature, item.rate_limit)
      if (limit !== undefined) limits.push(limit)
    }
  }
  const rawCredits = record(payload.credits)
  const hasCredits = rawCredits?.has_credits
  const rawBalance = rawCredits?.balance
  const balance = typeof rawBalance === 'string' || typeof rawBalance === 'number'
    ? cleanText(String(rawBalance))
    : undefined
  const credits = typeof hasCredits === 'boolean'
    ? {
      hasCredits,
      unlimited: rawCredits?.unlimited === true,
      ...balance === undefined ? {} : { balance },
    }
    : undefined
  if (limits.length === 0 && credits === undefined) throw new Error('Codex usage response has no displayable limits')
  const planType = cleanText(payload.plan_type)
  return {
    limits,
    ...planType === undefined ? {} : { planType },
    ...credits === undefined ? {} : { credits },
    observedAt,
  }
}

async function boundedText(response: Response): Promise<string> {
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error('Codex usage response is too large')
  return new TextDecoder().decode(buffer)
}

/**
 * Resolve the current OAuth token and query the bounded ChatGPT usage compatibility endpoint.
 * @param models - pi-ai provider collection used to resolve or refresh authentication.
 * @param credential - stored OAuth metadata used for the optional account header.
 * @param timeoutMs - hard network timeout in milliseconds.
 * @param signal - optional caller cancellation.
 * @returns the validated non-secret usage snapshot.
 */
export async function queryCodexUsage(
  models: Models,
  credential: OAuthCredential | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CodexUsageSnapshot> {
  const resolved = await models.getAuth('openai-codex')
  const token = resolved?.auth.apiKey
  if (token === undefined) throw new Error('OpenAI 会员尚未登录')
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const accountId = typeof credential?.accountId === 'string' ? credential.accountId : undefined
  const response = await fetch(USAGE_URL, {
    method: 'GET',
    redirect: 'error',
    signal: combined,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'deepseek-harness-pi-idea',
      ...accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
    },
  })
  const body = await boundedText(response)
  if (!response.ok) throw new Error(`Codex usage 查询失败（HTTP ${response.status}）`)
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error('Codex usage 返回了无效 JSON')
  }
  return parseCodexUsagePayload(payload, new Date().toISOString())
}
