import { describe, expect, it } from 'vitest'
import { parseCodexUsagePayload } from '../src/codex-usage.ts'

describe('Codex usage payload', () => {
  it('projects bounded plan, primary, weekly, additional, and credit fields', () => {
    expect(parseCodexUsagePayload({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 123 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
      },
      additional_rate_limits: [{
        metered_feature: 'code_review',
        limit_name: 'Code review',
        rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 60 } },
      }],
      credits: { has_credits: true, unlimited: false, balance: 12.5 },
    }, '2026-08-15T00:00:00.000Z')).toEqual({
      planType: 'plus',
      limits: [
        {
          id: 'codex',
          name: 'Codex',
          primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 123 },
          secondary: { usedPercent: 40, windowMinutes: 10_080 },
        },
        {
          id: 'code_review',
          name: 'Code review',
          primary: { usedPercent: 100, windowMinutes: 1 },
        },
      ],
      credits: { hasCredits: true, unlimited: false, balance: '12.5' },
      observedAt: '2026-08-15T00:00:00.000Z',
    })
  })

  it('refuses an unrelated or malformed response instead of displaying fake zero usage', () => {
    expect(() => parseCodexUsagePayload({ plan_type: 'plus' }, 'now'))
      .toThrow('no displayable limits')
    expect(() => parseCodexUsagePayload([], 'now')).toThrow('not an object')
  })
})
