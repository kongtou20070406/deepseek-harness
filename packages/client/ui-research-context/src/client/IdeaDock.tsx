import { useMemo, useState } from 'react'
import type { ResearchInquiryNode, ResearchStateProjection } from '@deepseek-ai/dsh-research-context'
import {
  IconBranchOutline16, IconLightOutline16, IconPlayOutline16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchCommandInjected } from './index.ts'
import type { ResearchContextLocaleKey } from './locales.ts'
import css from './IdeaDock.module.css'

type Props = PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'research-context'>
  & ResearchCommandInjected
type Panel = 'progress' | 'inquiry'

const PANELS = [
  ['progress', 'progress.open', IconLightOutline16],
  ['inquiry', 'inquiry.open', IconBranchOutline16],
] as const satisfies readonly [Panel, ResearchContextLocaleKey, typeof IconLightOutline16][]

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function ProgressPanel({ state, t, runResearchCommand }: {
  state: ResearchStateProjection
  t: Props['t']
  runResearchCommand: Props['runResearchCommand']
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const working = state.working
  const frontier = state.inquiry?.frontier
  const leap = state.inquiry?.leap?.status === 'pending' ? state.inquiry.leap : undefined

  const resolveLeap = async (line: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try { setError(await runResearchCommand(line)) } finally { setBusy(false) }
  }

  return (
    <div className={css.panel}>
      <section className={css.seedSection}>
        <div className={css.sectionHead}>
          <h3>{t('seed')}</h3><span>v{state.kernel.version}</span>
        </div>
        <p>{state.kernel.text}</p>
        {state.kernel.evolution !== undefined && (
          <details className={css.evolutionDetails}>
            <summary>{t(`evolution.${state.kernel.evolution.scope}`)}</summary>
            <p>{state.kernel.evolution.basis}</p>
          </details>
        )}
      </section>
      {frontier !== undefined && (
        <section className={css.frontierSection}>
          <div className={css.sectionHead}><h3>{t('frontier')}</h3><span>{t('frontier.one')}</span></div>
          <p>{frontier.question}</p>
          <dl className={css.frontierDetails}>
            <div><dt>{t('frontier.changes')}</dt><dd>{frontier.changesActionWhen}</dd></div>
            <div><dt>{t('frontier.evidence')}</dt><dd>{frontier.evidenceNeeded}</dd></div>
          </dl>
        </section>
      )}
      {working !== undefined && (
        <section className={css.section}>
          <div className={css.sectionHead}><h3>{t('working.currentTask')}</h3><span>r{working.revision}</span></div>
          <p>{working.currentTask}</p>
          <div className={css.nextAction}><IconPlayOutline16 size={12} /><span>{working.nextAction}</span></div>
          {working.unresolved.length > 0 && (
            <details className={css.unresolved}>
              <summary>{t('working.unresolved')} · {working.unresolved.length}</summary>
              <ul>{working.unresolved.map(item => <li key={item}>{item}</li>)}</ul>
            </details>
          )}
        </section>
      )}
      {leap !== undefined && (
        <section className={css.leapSection}>
          <div className={css.sectionHead}><h3>{t('leap.title')}</h3><span>{t('leap.nonBlocking')}</span></div>
          <p>{leap.question}</p>
          <div className={css.leapWhy}>{leap.whyHuman}</div>
          <div className={css.blockedAction}>{t('leap.blocked')}: {leap.blockedAction}</div>
          {leap.evidenceFrontierActions.length > 0 && (
            <div className={css.evidenceFrontier}>
              <strong>{t('leap.continues')}</strong>
              <ul>{leap.evidenceFrontierActions.map(action => <li key={action}>{action}</li>)}</ul>
            </div>
          )}
          <div className={css.leapActions}>
            {leap.candidates.map((candidate, index) => (
              <button
                type="button"
                key={candidate}
                disabled={busy}
                onClick={() => { void resolveLeap(`/research leap accept ${leap.id} ${index + 1}`) }}
              >
                {candidate}
              </button>
            ))}
            <button type="button" disabled={busy} className={css.reject} onClick={() => { void resolveLeap(`/research leap reject ${leap.id}`) }}>
              {t('leap.reject')}
            </button>
          </div>
          {error !== null && <div className={css.commandError}>{error}</div>}
        </section>
      )}
      {state.frame !== undefined && (
        <details className={css.frameDetails}>
          <summary>{t('frame')} · v{state.frame.version}</summary>
          <p>{state.frame.text}</p>
        </details>
      )}
      {state.proposal !== undefined && (
        <section className={css.proposal}>
          <div className={css.sectionHead}><h3>{t('proposal')}</h3><span>{t(state.proposal.target)}</span></div>
          <p>{state.proposal.text}</p>
          {state.proposal.evolution !== undefined && (
            <div className={css.proposalBasis}>
              <strong>{t(`evolution.${state.proposal.evolution.scope}`)}</strong>
              <span>{state.proposal.evolution.basis}</span>
            </div>
          )}
          <div className={css.hint}>{t('proposalHint')}</div>
        </section>
      )}
    </div>
  )
}

function InquiryPanel({ state, t }: { state: ResearchStateProjection; t: Props['t'] }) {
  const nodes = state.inquiry?.nodes ?? []
  const grouped = useMemo(() => {
    const active = nodes.filter(node => node.status === 'active' || node.status === 'challenged')
    const settled = nodes.filter(node => !active.includes(node))
    return { active, settled }
  }, [nodes])

  const renderNode = (node: ResearchInquiryNode) => (
    <article key={node.id} className={css.inquiryRow}>
      <span className={css.nodeKind}>{t(`board.kind.${node.kind}`)}</span>
      <p>{node.text}</p>
      <span className={node.modelVisible ? css.modelVisible : css.boardOnly}>
        {node.modelVisible ? t('board.aiVisible') : t('board.private')}
      </span>
    </article>
  )

  if (nodes.length === 0) return <div className={css.empty}>{t('inquiry.empty')}</div>
  return (
    <div className={css.panel}>
      <section>
        <div className={css.sectionHead}><h3>{t('inquiry.active')}</h3><span>{grouped.active.length}</span></div>
        <div className={css.inquiryList}>{grouped.active.map(renderNode)}</div>
      </section>
      {grouped.settled.length > 0 && (
        <details className={css.frameDetails}>
          <summary>{t('inquiry.settled')} · {grouped.settled.length}</summary>
          <div className={css.inquiryList}>{grouped.settled.map(renderNode)}</div>
        </details>
      )}
      <div className={css.hint}>{t('inquiry.boardHint')}</div>
    </div>
  )
}

/** Compact autonomous-research status strip and native human-on-the-loop console. */
export function IdeaDock({ useProjection, runResearchCommand, t }: Props) {
  const state = useProjection('researchState')
  const enabled = useProjection('researchContextEnabled')
  const ideas = useProjection('researchIdeas') ?? []
  const selectedIdeaId = useProjection('researchIdeaId') ?? null
  const activeIdeaId = selectedIdeaId ?? ideas[0]?.ideaId ?? ''
  const [panel, setPanel] = useState<Panel | null>(null)

  if (enabled === false) return null

  if (state == null) {
    return (
      <div className={css.dock} data-idea-dock data-idea-inactive>
        <div className={`${css.bar} ${css.inactive}`}>
          <span className={css.glyph}><IconLightOutline16 size={14} /></span>
          <span className={css.label}>{t('idea.inactive')}</span>
          <span className={css.summary}>{t('idea.inactiveHint')}</span>
        </div>
      </div>
    )
  }

  const pendingLeap = state.inquiry?.leap?.status === 'pending'
  const autonomy = pendingLeap ? 'leap' : state.working?.nextAction ? 'active' : 'parked'
  const summary = state.working?.nextAction || state.inquiry?.frontier?.question || oneLine(state.kernel.text)
  return (
    <>
      <div className={css.dock} data-idea-dock>
        <div className={css.bar}>
          <span className={css.glyph}><IconLightOutline16 size={14} /></span>
          <span className={`${css.autonomy} ${css[`autonomy_${autonomy}`]}`}>{t(`autonomy.${autonomy}`)}</span>
          <span className={css.summary}>{summary}</span>
          <button type="button" className={css.intervene} onClick={() => { setPanel(pendingLeap ? 'progress' : 'inquiry') }}>{t('intervene')}</button>
          <select
            className={css.ideaSelect}
            aria-label={t('idea.select')}
            value={activeIdeaId}
            onChange={(event) => { void runResearchCommand(event.currentTarget.value === '' ? '/research off' : '/research idea ' + event.currentTarget.value) }}
          >
            <option value="">{t('idea.close')}</option>
            {ideas.map(idea => <option key={idea.ideaId} value={idea.ideaId}>{idea.title}</option>)}
          </select>
          <div className={css.actions}>
            {PANELS.map(([id, label, Icon]) => (
              <Tooltip key={id} label={t(label)} side="bottom" delayMs={500}>
                <button type="button" className={css.iconBtn} aria-label={t(label)} onClick={() => { setPanel(id) }}>
                  <Icon size={14} />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      <Modal open={panel !== null} onClose={() => { setPanel(null) }} closeLabel={t('close')} title={t('idea.dialogTitle')} className={css.dialog ?? ''}>
        <nav className={css.tabs} aria-label={t('idea.sections')}>
          {PANELS.map(([id, label, Icon]) => (
            <button type="button" key={id} className={panel === id ? css.tabActive : css.tab} aria-pressed={panel === id} onClick={() => { setPanel(id) }}>
              <Icon size={14} />{t(label)}
            </button>
          ))}
        </nav>
        {panel === 'progress' && <ProgressPanel state={state} t={t} runResearchCommand={runResearchCommand} />}
        {panel === 'inquiry' && <InquiryPanel state={state} t={t} />}
      </Modal>
    </>
  )
}
