// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { EvidenceBoardLauncher } from '../src/client/EvidenceBoard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const researchState = {
  revision: 3,
  kernel: { version: 1, text: '研究证据优先。', confirmedAt: 1 },
  inquiry: {
    revision: 2,
    nodes: [
      {
        id: 'q1', kind: 'question', text: 'routing 是否真正必要？', status: 'active',
        origin: 'model', modelVisible: true, sourceSeqs: [4], createdAt: 2, updatedAt: 3,
      },
      {
        id: 'e1', kind: 'evidence', text: 'uniform routing 恢复了 held-source。', status: 'supported',
        origin: 'human', modelVisible: false, sourceSeqs: [8], createdAt: 3, updatedAt: 3,
      },
    ],
    edges: [{
      id: 'edge-1', fromId: 'e1', toId: 'q1', relation: 'informs', origin: 'model',
      modelVisible: true, createdAt: 3, updatedAt: 3,
    }],
    frontier: {
      question: 'routing 是否真正必要？', changesActionWhen: 'uniform 可补偿恢复',
      evidenceNeeded: 'held-source 配对结果', nodeIds: ['q1', 'e1'], updatedAt: 3,
    },
    updatedAt: 3,
  },
  updatedAt: 3,
}

function props(runResearchCommand = vi.fn(async () => null)) {
  const snapshot = {
    current: 'session-1',
    byId: {
      'session-1': {
        id: 'session-1', displayTitle: 'EqOp', cwd: 'D:\\EqOp',
        projectionValues: { researchState },
      },
    },
  }
  return {
    wide: true,
    useSessions: (select: (value: typeof snapshot) => unknown) => select(snapshot),
    runResearchCommand,
    t: makeTranslate(zh),
  } as unknown as Parameters<typeof EvidenceBoardLauncher>[0]
}

describe('EvidenceBoardLauncher', () => {
  it('renders AI suggestions and semantic links in a sidebar board', () => {
    render(<EvidenceBoardLauncher {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '打开侦探证据板' }))
    const dialog = screen.getByRole('dialog', { name: '侦探证据板' })
    expect(dialog.textContent).toContain('routing 是否真正必要？')
    expect(dialog.textContent).toContain('uniform routing 恢复了 held-source。')
    expect(dialog.textContent).toContain('影响决定')
    expect(dialog.textContent).toContain('AI')
    expect(dialog.textContent).toContain('你')
  })

  it('keeps dragging local but sends semantic visibility, card, and edge edits through /research', async () => {
    const run = vi.fn(async () => null)
    const view = render(<EvidenceBoardLauncher {...props(run)} />)
    fireEvent.click(screen.getByRole('button', { name: '打开侦探证据板' }))

    const card = view.container.querySelector<HTMLElement>('[data-node-id="q1"]')!
    fireEvent.pointerDown(within(card).getByText('问题'), { button: 0, clientX: 80, clientY: 120 })
    fireEvent.pointerMove(document, { clientX: 210, clientY: 260 })
    fireEvent.pointerUp(document)
    expect(run).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(1)

    fireEvent.click(within(card).getByRole('button', { name: '给 AI 看' }))
    expect(run).toHaveBeenLastCalledWith('session-1', expect.stringContaining('"action":"visibility"'))

    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '检查新的反例。' } })
    await waitFor(() => { expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(run).toHaveBeenLastCalledWith('session-1', expect.stringContaining('"action":"upsert-node"')) })

    fireEvent.change(screen.getByLabelText('从'), { target: { value: 'e1' } })
    fireEvent.change(screen.getByLabelText('关系'), { target: { value: 'challenges' } })
    fireEvent.change(screen.getByLabelText('到'), { target: { value: 'q1' } })
    await waitFor(() => { expect((screen.getByRole('button', { name: '连接' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => { expect(run).toHaveBeenLastCalledWith('session-1', expect.stringContaining('"action":"upsert-edge"')) })
  })
})
