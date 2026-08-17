// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { IdeaDock } from '../src/client/IdeaDock.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const state = {
  revision: 4,
  kernel: {
    version: 2,
    text: '研究长期上下文组装。',
    confirmedAt: 10,
    evolution: { scope: 'adjust', basis: '根据真实长对话反馈调整；保留任务表现优先。' },
  },
  frame: { version: 1, text: '优先保持任务表现。', confirmedAt: 11 },
  working: {
    revision: 3,
    currentTask: '修复工作区并接入 Idea UI',
    unresolved: ['需要真实科研长跑验证'],
    nextAction: '完成浏览器验收',
    evidenceRoots: [4, 8],
    updatedAt: 12,
  },
  inquiry: {
    revision: 2,
    nodes: [{
      id: 'need-matched', kind: 'evidence-requirement', text: '完成 matched baseline 配对。',
      status: 'active', origin: 'model', modelVisible: true, sourceSeqs: [7],
      evidenceClass: 'matched-baseline', createdAt: 11, updatedAt: 12,
    }],
    edges: [],
    frontier: {
      question: '选择器是否保持任务成功率？', changesActionWhen: '困难任务回归消失',
      evidenceNeeded: '配对困难任务结果', nodeIds: ['need-matched'], updatedAt: 12,
    },
    updatedAt: 12,
  },
  updatedAt: 12,
}

function props(
  researchState: typeof state | null = state,
  runResearchCommand = vi.fn(async () => null),
  enabled = true,
  ideas = [{ ideaId: 'idea-default', title: '默认目标', revision: 4 }],
  selectedIdeaId: string | null = 'idea-default',
) {
  return {
    useProjection: (key: string) => {
      if (key === 'researchState') return researchState
      if (key === 'researchContextEnabled') return enabled
      if (key === 'researchIdeas') return ideas
      if (key === 'researchIdeaId') return selectedIdeaId
      return undefined
    },
    runResearchCommand,
    t: makeTranslate(zh),
  } as unknown as Parameters<typeof IdeaDock>[0]
}

describe('IdeaDock', () => {
  it('shows only the active progress and inquiry views', () => {
    render(<IdeaDock {...props()} />)
    expect(screen.getByText('AI 推进中')).toBeTruthy()
    expect(screen.getByText('完成浏览器验收')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '推进' }))
    const dialog = screen.getByRole('dialog', { name: 'Idea 管理' })
    expect(dialog.textContent).toContain('研究长期上下文组装。')
    expect(dialog.textContent).toContain('调整追逐目标')
    expect(dialog.textContent).toContain('修复工作区并接入 Idea UI')

    fireEvent.click(within(dialog).getByRole('button', { name: '探究地图' }))
    expect(dialog.textContent).toContain('完成 matched baseline 配对。')

    expect(within(dialog).queryByRole('button', { name: 'Idea 支持证据' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '上下文记录' })).toBeNull()
  })

  it('lets the human resolve a leap while showing autonomous evidence work continues', async () => {
    const run = vi.fn(async () => null)
    const leapState = {
      ...state,
      inquiry: {
        ...state.inquiry,
        leap: {
          id: 'research-leap-12345678-abcd', trigger: 'high-lock-in-choice',
          question: '是否更换科学对象？', whyHuman: '这会改变论文主张。', candidates: ['保留对象'],
          blockedAction: '改写 Idea Seed', evidenceFrontierActions: ['补齐 matched baseline'], evidenceNodeIds: ['need-matched'],
          status: 'pending', proposedAt: 13,
        },
      },
    }
    render(<IdeaDock {...props(leapState as typeof state, run)} />)
    expect(screen.getByText('跃迁待定 · 证据继续推进')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '推进' }))
    expect(screen.getByText('补齐 matched baseline')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保留对象' }))
    expect(run).toHaveBeenCalledWith('/research leap accept research-leap-12345678-abcd 1')
  })

  it('keeps the Idea entry visible before an authority projection exists', () => {
    const view = render(<IdeaDock {...props(null)} />)
    expect(view.container.textContent).toContain('Idea 未启用')
    expect(view.container.textContent).toContain('/research')
    expect(view.container.querySelector('[data-idea-inactive]')).toBeTruthy()
  })

  it('switches between Idea targets', () => {
    const run = vi.fn(async () => null)
    const ideas = [
      { ideaId: 'idea-default', title: '默认目标', revision: 4 },
      { ideaId: 'idea-second', title: '第二目标', revision: 1 },
    ]
    render(<IdeaDock {...props(state, run, true, ideas)} />)
    fireEvent.change(screen.getByRole('combobox', { name: '选择 Idea' }), { target: { value: 'idea-second' } })
    expect(run).toHaveBeenCalledWith('/research idea idea-second')
  })

  it('makes the close option reachable when a legacy session has no selected id', () => {
    const run = vi.fn(async () => null)
    render(<IdeaDock {...props(state, run, true, [{ ideaId: 'idea-default', title: '默认目标', revision: 4 }], null)} />)
    const select = screen.getByRole('combobox', { name: '选择 Idea' }) as HTMLSelectElement
    expect(select.value).toBe('idea-default')
    fireEvent.change(select, { target: { value: '' } })
    expect(run).toHaveBeenCalledWith('/research off')
  })

  it('selects an Idea target and closes the dock when disabled', () => {
    const run = vi.fn(async () => null)
    render(<IdeaDock {...props(state, run)} />)
    fireEvent.change(screen.getByRole('combobox', { name: '选择 Idea' }), { target: { value: '' } })
    expect(run).toHaveBeenCalledWith('/research off')

    cleanup()
    const hidden = render(<IdeaDock {...props(state, run, false)} />)
    expect(hidden.container.textContent).toBe('')
  })
})
