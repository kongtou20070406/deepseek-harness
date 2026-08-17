/** OpenAI membership login and Codex subscription-usage card. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CodexAccountStatus, CodexLoginState, CodexLoginStart, CodexUsageSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Host actions injected by the Models plugin apply closure. */
export interface OpenAICodexActions {
  status: () => Promise<CodexAccountStatus>
  beginLogin: () => Promise<CodexLoginStart>
  pollLogin: () => Promise<CodexLoginState>
  usage: () => Promise<CodexUsageSnapshot>
  logout: () => Promise<CodexAccountStatus>
}

interface Props {
  actions: OpenAICodexActions
  t: (key: keyof typeof en) => string
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === 10_080) return '7d'
  if (minutes !== undefined && minutes % 60 === 0) return `${String(minutes / 60)}h`
  return fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render the account card; all persistence and provider I/O stay on Host. */
export function OpenAICodexCard({ actions, t }: Props): ReactNode {
  const [account, setAccount] = useState<CodexAccountStatus>()
  const [usage, setUsage] = useState<CodexUsageSnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refreshUsage = (): void => {
    setBusy(true)
    setError(undefined)
    void actions.usage().then(setUsage, (errorValue) => { setError(errorMessage(errorValue)) }).finally(() => { setBusy(false) })
  }

  useEffect(() => {
    let live = true
    void actions.status().then((value) => {
      if (!live) return
      setAccount(value)
      if (value.authenticated) refreshUsage()
    }, (errorValue) => { if (live) setError(errorMessage(errorValue)) })
    return () => { live = false }
  }, [actions])

  useEffect(() => {
    if (account?.login.state !== 'pending') return
    const timer = window.setInterval(() => {
      void actions.pollLogin().then((login) => {
        setAccount(previous => previous === undefined ? previous : { ...previous, login })
        if (login.state === 'succeeded') {
          setAccount({ authenticated: true, login })
          refreshUsage()
        }
      }, (errorValue) => { setError(errorMessage(errorValue)) })
    }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [account?.login.state, actions])

  const login = (): void => {
    setBusy(true)
    setError(undefined)
    void actions.beginLogin().then((start) => {
      setAccount({ authenticated: false, login: { state: 'pending', start } })
      window.open(start.verificationUri, '_blank', 'noopener,noreferrer')
    }, (errorValue) => { setError(errorMessage(errorValue)) }).finally(() => { setBusy(false) })
  }

  const logout = (): void => {
    if (!window.confirm(t('codexLogoutConfirm'))) return
    setBusy(true)
    setError(undefined)
    void actions.logout().then((next) => {
      setAccount(next)
      setUsage(undefined)
    }, (errorValue) => { setError(errorMessage(errorValue)) }).finally(() => { setBusy(false) })
  }

  const start = account?.login.state === 'pending' ? account.login.start : undefined
  return (
    <section className={styles['codexCard']} aria-labelledby="openai-codex-title">
      <div className={styles['codexHead']}>
        <div>
          <h3 id="openai-codex-title" className={styles['codexTitle']}>{t('codexTitle')}</h3>
          <p className={styles['codexIntro']}>{t('codexIntro')}</p>
        </div>
        <span className={account?.authenticated ? styles['codexConnected'] : styles['codexDisconnected']}>
          {account?.authenticated ? t('codexConnected') : t('codexDisconnected')}
        </span>
      </div>
      {start === undefined
        ? null
        : (
          <div className={styles['codexCode']} role="status">
            <span>{t('codexDeviceCode')}</span>
            <strong>{start.userCode}</strong>
            <a href={start.verificationUri} target="_blank" rel="noreferrer">{t('codexOpenLogin')}</a>
          </div>
        )}
      {usage === undefined
        ? null
        : (
          <div className={styles['codexUsage']}>
            {usage.planType === undefined ? null : <span>{`Plan · ${usage.planType}`}</span>}
            {usage.limits.map(limit => (
              <span key={limit.id}>
                {`${limit.name} · ${limit.primary === undefined ? '—' : `${String(Math.max(0, 100 - limit.primary.usedPercent))}% ${windowLabel(limit.primary.windowMinutes, '5h')}`}`}
                {limit.secondary === undefined ? '' : ` / ${String(Math.max(0, 100 - limit.secondary.usedPercent))}% ${windowLabel(limit.secondary.windowMinutes, '7d')}`}
              </span>
            ))}
          </div>
        )}
      {error === undefined ? null : <p className={styles['error']} role="alert">{error}</p>}
      <div className={styles['codexActions']}>
        {account?.authenticated
          ? (
            <>
              <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={refreshUsage}>
                {busy ? t('codexRefreshing') : t('codexRefresh')}
              </button>
              <button type="button" className={styles['dangerButton']} disabled={busy} onClick={logout}>
                {t('codexLogout')}
              </button>
            </>
          )
          : (
            <button type="button" className={styles['primaryButton']} disabled={busy || account?.login.state === 'pending'} onClick={login}>
              {account?.login.state === 'pending' ? t('codexWaiting') : busy ? t('codexStarting') : t('codexLogin')}
            </button>
          )}
      </div>
    </section>
  )
}
