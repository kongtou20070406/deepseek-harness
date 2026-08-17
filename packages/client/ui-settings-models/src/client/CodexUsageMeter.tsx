/** Compact OpenAI Codex subscription meter for the composer tool row. */

import { useEffect, useRef, useState } from 'react'
import type { CodexUsageSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OpenAICodexActions } from './OpenAICodexCard.tsx'
import type { en } from './locales.ts'
import styles from './CodexUsageMeter.module.css'

const REFRESH_MS = 5 * 60 * 1_000
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
type CodexUsageLimit = CodexUsageSnapshot['limits'][number]

export interface CodexUsageMeterProps {
  actions: Pick<OpenAICodexActions, 'status' | 'usage'>
  t: (key: keyof typeof en) => string
}

function remaining(usedPercent: number): number {
  return Math.max(0, Math.round(100 - usedPercent))
}

function windowLabel(minutes: number | undefined): string {
  if (minutes === 10_080) return '7d'
  if (minutes !== undefined && minutes % 60 === 0) return `${String(minutes / 60)}h`
  return minutes === undefined ? '' : `${String(minutes)}m`
}

function full(limit: CodexUsageLimit): string {
  const values = [limit.primary, limit.secondary]
    .filter(window => window !== undefined)
    .map((window) => {
      const label = windowLabel(window.windowMinutes)
      return `${String(remaining(window.usedPercent))}%${label === '' ? '' : ` ${label}`}`
    })
  return `${limit.name} · ${values.join(' / ')}`
}

/** Render only for a persisted, authenticated membership account. */
export function CodexUsageMeter({ actions, t }: CodexUsageMeterProps) {
  const [usage, setUsage] = useState<CodexUsageSnapshot>()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  const refresh = (): void => {
    setRefreshing(true)
    void actions.usage().then(setUsage, () => { setUsage(undefined) }).finally(() => { setRefreshing(false) })
  }

  useEffect(() => {
    let live = true
    void actions.status().then((account) => {
      if (!live || !account.authenticated) return
      void actions.usage().then((value) => { if (live) setUsage(value) }, () => {})
    }, () => {})
    const timer = window.setInterval(() => {
      void actions.status().then((account) => {
        if (live && account.authenticated) refresh()
      }, () => {})
    }, REFRESH_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [actions])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const primary = usage?.limits.find(limit => limit.id === 'codex') ?? usage?.limits[0]
  if (usage === undefined || primary === undefined) return null
  const windows = [primary.primary, primary.secondary].filter(window => window !== undefined)
  if (windows.length === 0) return null
  // Match the context ring's occupancy semantics: more consumed quota means a
  // fuller ring. The tightest active window is the one worth seeing at a glance;
  // the panel keeps every window exact.
  const usedPercent = Math.min(100, Math.max(...windows.map(window => window.usedPercent)))

  return (
    <span ref={rootRef} className={styles.root}>
      <Tooltip label={full(primary)} side="top" delayMs={300} disabled={open}>
        <button
          type="button"
          className={styles.trigger}
          aria-label={t('codexUsageAria') + '：' + full(primary)}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-codex-usage-percent={String(Math.round(usedPercent))}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={styles.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={styles.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * usedPercent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
          <span className={styles.mark} aria-hidden>C</span>
        </button>
      </Tooltip>
      {open && (
        <div className={styles.panel} role="dialog" aria-label={t('codexUsageAria')}>
          <div className={styles.header}>
            <strong>{t('codexUsageTitle')}</strong>
            {usage.planType === undefined ? null : <span>{usage.planType}</span>}
          </div>
          <div className={styles.limits}>
            {usage.limits.map(limit => (
              <div key={limit.id} className={styles.limit}>
                <span>{limit.name}</span>
                <span>{full(limit).slice(limit.name.length + 3)}</span>
              </div>
            ))}
          </div>
          <button type="button" className={styles.refresh} disabled={refreshing} onClick={refresh}>
            {refreshing ? t('codexRefreshing') : t('codexRefresh')}
          </button>
        </div>
      )}
    </span>
  )
}
