import type { ResearchContextProjection } from '@deepseek-ai/dsh-research-context'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchContextLocaleKey } from './locales.ts'
import css from './ResearchContextDetails.module.css'

type Props = PropsRuntime<'conversation.context.details'> & PropsLocale<'research-context'>

function formatTokens(value: number): string {
  if (value < 1_000) return `~${value}`
  return `~${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
}

const ROWS = [
  ['kernelTokens', 'kernel'],
  ['frameTokens', 'frame'],
  ['workingTokens', 'working'],
  ['goalTokens', 'goal'],
  ['historyTokens', 'history'],
  ['locatorTokens', 'locators'],
  ['lensTokens', 'context.lens'],
] as const satisfies readonly [keyof ResearchContextProjection['components'], ResearchContextLocaleKey][]

/** Render the latest logged research assembly inside DSH's ContextMeter panel. */
export function ResearchContextDetails({ useProjection, t }: Props) {
  const view = useProjection('researchContext')
  const inherited = useProjection('researchContextInheritance')
  const history = useProjection('researchContextHistory')
  const enabled = useProjection('researchContextEnabled')
  if (enabled === false || (view == null && inherited == null)) return null
  if (inherited != null) {
    return (
      <section className={css.section} aria-label={t('workerTitle')}>
        <div className={css.title}>{t('workerTitle')}</div>
        <dl className={css.rows}>
          <div className={css.row}>
            <dt>{t('inheritedTotal')}</dt>
            <dd>{formatTokens(inherited.estimatedTokens)}</dd>
          </div>
        </dl>
        <div className={css.meta}>
          {t('workerLoops', {
            parent: String(inherited.parentSelectedTurns.length),
            worker: String(inherited.workerSelectedTurns.length),
            omitted: String(inherited.workerOmittedTurns.length),
          })}
          {' · '}
          {t('latency', { milliseconds: (inherited.assemblyMicros / 1_000).toFixed(2) })}
        </div>
        {history != null && history.length > 1 && (
          <details className={css.meta}>
            <summary>{t('manifestHistory', { count: String(history.length) })}</summary>
            {history.toReversed().slice(0, 8).map(item => (
              <div key={item.eventSeq}>#{item.eventSeq} · {item.kind === 'assembly' ? t('assembly') : t('inheritance')} · {formatTokens(item.estimatedTokens)}</div>
            ))}
          </details>
        )}
      </section>
    )
  }
  if (view == null) return null
  return (
    <section className={css.section} aria-label={t('title')}>
      <div className={css.title}>{t('title')}</div>
      <dl className={css.rows}>
        {ROWS.map(([key, label]) => {
          const value = view.components[key]
          if (value === undefined || value <= 0) return null
          return (
            <div className={css.row} key={key}>
              <dt>{t(label)}</dt>
              <dd>{formatTokens(value)}</dd>
            </div>
          )
        })}
      </dl>
      <div className={css.meta}>
        {t('loops', { selected: String(view.selectedTurns.length), omitted: String(view.omittedTurnCount) })}
        {' · '}
        {t(`lens.${view.ideaLens ?? 'execute'}`)}
        {' · '}
        {t('latency', { milliseconds: (view.assemblyMicros / 1_000).toFixed(2) })}
      </div>
      {history != null && history.length > 1 && (
        <details className={css.meta}>
          <summary>{t('manifestHistory', { count: String(history.length) })}</summary>
          {history.toReversed().slice(0, 8).map(item => (
            <div key={item.eventSeq}>#{item.eventSeq} · {item.kind === 'assembly' ? t('assembly') : t('inheritance')} · {formatTokens(item.estimatedTokens)}</div>
          ))}
        </details>
      )}
    </section>
  )
}
