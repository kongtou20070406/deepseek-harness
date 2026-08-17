// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexUsageMeter } from '../src/client/CodexUsageMeter.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t: Parameters<typeof CodexUsageMeter>[0]['t'] = key => zh[key]

function actions(authenticated = true) {
  return {
    status: vi.fn(() => Promise.resolve({ authenticated, login: { state: 'idle' as const } })),
    usage: vi.fn(() => Promise.resolve({
      planType: 'pro',
      limits: [{
        id: 'codex',
        name: 'Codex',
        primary: { usedPercent: 12, windowMinutes: 300 },
        secondary: { usedPercent: 41, windowMinutes: 10_080 },
      }],
      observedAt: '2026-08-15T00:00:00.000Z',
    })),
  }
}

describe('CodexUsageMeter', () => {
  it('stays absent for a disconnected account', async () => {
    const account = actions(false)
    const view = render(<CodexUsageMeter actions={account} t={t} />)
    await waitFor(() => { expect(account.status).toHaveBeenCalledOnce() })
    expect(account.usage).not.toHaveBeenCalled()
    expect(view.container.firstChild).toBeNull()
  })

  it('shows a context-style ring for the tightest quota and expands exact details', async () => {
    const account = actions()
    render(<CodexUsageMeter actions={account} t={t} />)
    const trigger = await screen.findByRole('button', { name: /Codex 订阅用量/ })
    expect(trigger.getAttribute('data-codex-usage-percent')).toBe('41')
    expect(trigger.textContent).toBe('C')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Codex 订阅用量' }).textContent)
      .toContain('Codex88% 5h / 59% 7d')
    expect(screen.getByText('pro')).toBeTruthy()
  })

  it('refreshes in place from the expanded panel', async () => {
    const account = actions()
    render(<CodexUsageMeter actions={account} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: /Codex 订阅用量/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新用量' })) })
    expect(account.usage).toHaveBeenCalledTimes(2)
  })
})
