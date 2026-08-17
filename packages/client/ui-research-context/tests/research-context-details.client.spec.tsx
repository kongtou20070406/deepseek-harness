// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ResearchContextDetails } from '../src/client/ResearchContextDetails.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('ResearchContextDetails', () => {
  it('renders the durable assembly projection in the native compact style', () => {
    const projection = {
      stateRevision: 4,
      turn: 3,
      selectedTurns: [1, 2],
      selectedLocators: ['turn:1:full', 'turn:2:full'],
      partialTurns: [],
      omittedTurnCount: 7,
      sourceSeqs: [2, 5, 9],
      estimatedTokens: 1_234,
      assemblyMicros: 8_700,
      components: {
        kernelTokens: 80,
        frameTokens: 120,
        workingTokens: 90,
        goalTokens: 40,
        historyTokens: 860,
        locatorTokens: 44,
        lensTokens: 72,
      },
      goalId: 'goal-research',
      ideaLens: 'paper',
    }
    const props = {
      useProjection: (key: string) => key === 'researchContext' ? projection : undefined,
      t: makeTranslate(zh),
    } as unknown as Parameters<typeof ResearchContextDetails>[0]
    const view = render(<ResearchContextDetails {...props} />)
    expect(view.getByRole('region', { name: '研究上下文组装' }).textContent).toContain('Idea 核心~80')
    expect(view.container.textContent).toContain('选中 2 个 loop · 省略 7 个')
    expect(view.container.textContent).toContain('本轮 Idea 视图~72')
    expect(view.container.textContent).toContain('论文')
    expect(view.container.textContent).toContain('8.70 ms')
  })

  it('stays absent before the first logged assembly', () => {
    const props = {
      useProjection: () => undefined,
      t: makeTranslate(zh),
    } as unknown as Parameters<typeof ResearchContextDetails>[0]
    const view = render(<ResearchContextDetails {...props} />)
    expect(view.container.textContent).toBe('')
  })

  it('hides stale assembly details when Idea is disabled', () => {
    const props = {
      useProjection: (key: string) => key === 'researchContextEnabled' ? false : { stateRevision: 4 },
      t: makeTranslate(zh),
    } as unknown as Parameters<typeof ResearchContextDetails>[0]
    const view = render(<ResearchContextDetails {...props} />)
    expect(view.container.textContent).toBe('')
  })

  it('renders parent-to-child inheritance in the same ContextMeter detail slot', () => {
    const inherited = {
      parentSessionId: 'parent',
      parentStateRevision: 3,
      parentSourceSeqs: [1, 2],
      parentSelectedTurns: [1, 4],
      workerSourceSeqs: [0, 8],
      workerSelectedTurns: [1],
      workerOmittedTurns: [2, 3],
      estimatedTokens: 2_400,
      assemblyMicros: 7_500,
      viewHash: 'abc',
    }
    const props = {
      useProjection: (key: string) => key === 'researchContextInheritance' ? inherited : undefined,
      t: makeTranslate(zh),
    } as unknown as Parameters<typeof ResearchContextDetails>[0]
    const view = render(<ResearchContextDetails {...props} />)
    expect(view.getByRole('region', { name: '子线程继承上下文' }).textContent).toContain('子线程组装视图~2.4k')
    expect(view.container.textContent).toContain('父级 2 个 loop · 本线程 1 个 · 省略 2 个')
    expect(view.container.textContent).toContain('7.50 ms')
  })
})
