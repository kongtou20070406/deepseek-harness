import {
  useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  ResearchInquiryEdge, ResearchInquiryNode, ResearchInquiryNodeKind, ResearchStateProjection,
} from '@deepseek-ai/dsh-research-context'
import {
  IconBranchOutline16, IconCloseOutline16, IconEditOutline16, IconLightOutline16,
  IconLinkOutline16, IconPlusOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { RootResearchCommandInjected } from './index.ts'
import css from './EvidenceBoard.module.css'

type Props = PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'research-context'>
  & RootResearchCommandInjected

type Point = { x: number; y: number }
type PositionMap = Record<string, Point>
type EdgeRelation = ResearchInquiryEdge['relation']

const CARD_WIDTH = 224
const CARD_HEIGHT = 124

const KINDS: readonly ResearchInquiryNodeKind[] = [
  'question', 'hypothesis', 'rival', 'assumption', 'claim', 'evidence-requirement',
  'evidence', 'counterevidence', 'decision', 'rejection',
]

const RELATIONS: readonly EdgeRelation[] = [
  'supports', 'challenges', 'depends-on', 'alternative-to', 'informs', 'supersedes', 'related',
]

const EMPTY_NODES: readonly ResearchInquiryNode[] = []
const EMPTY_EDGES: readonly ResearchInquiryEdge[] = []

function layoutKey(cwd: string | undefined, sessionId: string): string {
  return `pi-idea:evidence-board-layout:${cwd ?? sessionId}`
}

function readLayout(key: string): PositionMap {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: PositionMap = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const point = value as Record<string, unknown>
      if (typeof point.x === 'number' && Number.isFinite(point.x)
        && typeof point.y === 'number' && Number.isFinite(point.y)) {
        result[id] = { x: point.x, y: point.y }
      }
    }
    return result
  } catch {
    return {}
  }
}

function defaultPoint(index: number): Point {
  return { x: 42 + (index % 3) * 264, y: 94 + Math.floor(index / 3) * 158 }
}

function pointFor(positions: PositionMap, id: string, index: number): Point {
  return positions[id] ?? defaultPoint(index)
}

function cardCenter(point: Point): Point {
  return { x: point.x + CARD_WIDTH / 2, y: point.y + CARD_HEIGHT / 2 }
}

function shortText(value: string, max = 54): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function command(payload: Record<string, unknown>): string {
  return `/research board ${JSON.stringify(payload)}`
}

/** Root sidebar launcher and semantic/layout-isolated detective evidence board. */
export function EvidenceBoardLauncher({ wide, useSessions, runResearchCommand, t }: Props) {
  const selected = useSessions((sessions) => {
    const id = sessions.current
    if (id === undefined) return undefined
    const summary = sessions.byId[id]
    if (summary === undefined) return undefined
    return {
      id,
      cwd: summary.cwd,
      title: summary.displayTitle,
      state: summary.projectionValues?.researchState as ResearchStateProjection | undefined,
    }
  })
  const [open, setOpen] = useState(false)
  const [positions, setPositions] = useState<PositionMap>({})
  const positionsRef = useRef(positions)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const [kind, setKind] = useState<ResearchInquiryNodeKind>('question')
  const [text, setText] = useState('')
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [relation, setRelation] = useState<EdgeRelation>('supports')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const state = selected?.state
  const nodes = state?.inquiry?.nodes ?? EMPTY_NODES
  const edges = state?.inquiry?.edges ?? EMPTY_EDGES
  const key = selected === undefined ? undefined : layoutKey(selected.cwd, selected.id)

  useEffect(() => {
    if (key === undefined) return
    const next = readLayout(key)
    positionsRef.current = next
    setPositions(next)
  }, [key])

  useEffect(() => { positionsRef.current = positions }, [positions])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open])

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const active = dragging.current
      const rect = canvasRef.current?.getBoundingClientRect()
      if (active === null || rect === undefined) return
      const x = Math.max(12, Math.min(1_060 - CARD_WIDTH, event.clientX - rect.left - active.dx))
      const y = Math.max(72, Math.min(780 - CARD_HEIGHT, event.clientY - rect.top - active.dy))
      setPositions(previous => ({ ...previous, [active.id]: { x, y } }))
    }
    const onUp = (): void => {
      if (dragging.current === null) return
      dragging.current = null
      if (key !== undefined) window.localStorage.setItem(key, JSON.stringify(positionsRef.current))
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [key])

  const nodeIndex = useMemo(() => new Map(nodes.map((node, index) => [node.id, { node, index }])), [nodes])
  const visibleEdges = useMemo(() => edges.filter(edge => nodeIndex.has(edge.fromId) && nodeIndex.has(edge.toId)), [edges, nodeIndex])

  const execute = async (payload: Record<string, unknown>): Promise<boolean> => {
    if (selected === undefined) return false
    setBusy(true)
    setError(null)
    try {
      const failure = await runResearchCommand(selected.id, command(payload))
      setError(failure)
      return failure === null
    } finally {
      setBusy(false)
    }
  }

  const submitCard = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (text.trim().length === 0) return
    const ok = await execute({
      action: 'upsert-node',
      ...(editingId === undefined ? {} : { id: editingId }),
      kind,
      text: text.trim(),
      modelVisible: editingId === undefined ? false : nodes.find(node => node.id === editingId)?.modelVisible ?? false,
    })
    if (ok) {
      setEditingId(undefined)
      setText('')
      setKind('question')
    }
  }

  const submitEdge = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (fromId.length === 0 || toId.length === 0 || fromId === toId) return
    const ok = await execute({ action: 'upsert-edge', fromId, toId, relation, modelVisible: false })
    if (ok) {
      setFromId('')
      setToId('')
      setRelation('supports')
    }
  }

  const editNode = (node: ResearchInquiryNode): void => {
    setEditingId(node.id)
    setKind(node.kind)
    setText(node.text)
  }

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, id: string, index: number): void => {
    if (event.button !== 0) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const point = pointFor(positionsRef.current, id, index)
    dragging.current = {
      id,
      dx: event.clientX - rect.left - point.x,
      dy: event.clientY - rect.top - point.y,
    }
    event.preventDefault()
  }

  const frontier = state?.inquiry?.frontier
  const pendingLeap = state?.inquiry?.leap?.status === 'pending' ? state.inquiry.leap : undefined

  return (
    <>
      <Tooltip label={t('board.open')} side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={`${css.launcher} ${wide ? '' : css.launcherRail}`}
          aria-label={t('board.open')}
          onClick={() => { setOpen(true) }}
        >
          <IconBranchOutline16 size={wide ? 16 : 18} />
          {wide && <span>{t('board.title')}</span>}
          {wide && nodes.length > 0 && <span className={css.count}>{nodes.length}</span>}
        </button>
      </Tooltip>
      {open && (
        <div className={css.overlay} role="dialog" aria-modal="true" aria-label={t('board.title')}>
          <button type="button" className={css.mask} aria-label={t('close')} onClick={() => { setOpen(false) }} />
          <aside className={css.drawer}>
            <header className={css.header}>
              <div>
                <div className={css.eyebrow}>{t('board.project')}</div>
                <h2>{t('board.title')}</h2>
                <p>{selected?.title ?? t('board.noSession')}</p>
              </div>
              <button type="button" className={css.close} aria-label={t('close')} onClick={() => { setOpen(false) }}>
                <IconCloseOutline16 size={16} />
              </button>
            </header>

            {selected === undefined || state === undefined ? (
              <div className={css.blank}>
                <IconLightOutline16 size={24} />
                <strong>{t('board.noIdea')}</strong>
                <span>{t('board.noIdeaHint')}</span>
              </div>
            ) : (
              <div className={css.body}>
                <section className={css.boardArea}>
                  <div className={css.frontierBar}>
                    <span>{t('board.frontier')}</span>
                    <strong>{frontier === undefined ? t('board.frontierEmpty') : frontier.question}</strong>
                    {pendingLeap !== undefined && <em>{t('board.leapPending')}</em>}
                  </div>
                  <div className={css.viewport}>
                    <div ref={canvasRef} className={css.canvas} data-evidence-canvas>
                      <svg className={css.lines} width="1060" height="780" aria-hidden="true">
                        <defs>
                          <marker id="evidence-board-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                            <path d="M0,0 L8,4 L0,8 z" />
                          </marker>
                        </defs>
                        {visibleEdges.map((edge) => {
                          const from = nodeIndex.get(edge.fromId)
                          const to = nodeIndex.get(edge.toId)
                          if (from === undefined || to === undefined) return null
                          const a = cardCenter(pointFor(positions, edge.fromId, from.index))
                          const b = cardCenter(pointFor(positions, edge.toId, to.index))
                          return (
                            <g key={edge.id} className={edge.modelVisible ? css.semanticLine : css.privateLine}>
                              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#evidence-board-arrow)" />
                              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6}>{edge.label ?? t(`board.relation.${edge.relation}`)}</text>
                            </g>
                          )
                        })}
                      </svg>
                      {nodes.map((node, index) => {
                        const point = pointFor(positions, node.id, index)
                        return (
                          <article
                            key={node.id}
                            className={`${css.card} ${css[`kind_${node.kind}`] ?? ''}`}
                            style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
                            data-node-id={node.id}
                          >
                            <div className={css.cardHead} onPointerDown={(event) => { beginDrag(event, node.id, index) }}>
                              <span>{t(`board.kind.${node.kind}`)}</span>
                              <span className={css.origin}>{node.origin === 'model' ? 'AI' : t('board.you')}</span>
                            </div>
                            <p title={node.text}>{shortText(node.text, 90)}</p>
                            <footer>
                              <button
                                type="button"
                                className={node.modelVisible ? css.visible : css.private}
                                onPointerDown={(event) => { event.stopPropagation() }}
                                onClick={() => { void execute({ action: 'visibility', id: node.id, modelVisible: !node.modelVisible }) }}
                              >
                                {node.modelVisible ? t('board.aiVisible') : t('board.private')}
                              </button>
                              <button
                                type="button"
                                className={css.cardAction}
                                aria-label={t('board.edit')}
                                onPointerDown={(event) => { event.stopPropagation() }}
                                onClick={() => { editNode(node) }}
                              >
                                <IconEditOutline16 size={13} />
                              </button>
                            </footer>
                          </article>
                        )
                      })}
                      {nodes.length === 0 && <div className={css.canvasEmpty}>{t('board.empty')}</div>}
                    </div>
                  </div>
                  <div className={css.layoutNote}>{t('board.layoutLocal')}</div>
                </section>

                <aside className={css.inspector}>
                  <section>
                    <div className={css.formTitle}><IconPlusOutline16 size={14} />{editingId === undefined ? t('board.addCard') : t('board.editCard')}</div>
                    <form onSubmit={(event) => { void submitCard(event) }}>
                      <label>{t('board.cardType')}
                        <select value={kind} onChange={(event) => { setKind(event.target.value as ResearchInquiryNodeKind) }}>
                          {KINDS.map(value => <option key={value} value={value}>{t(`board.kind.${value}`)}</option>)}
                        </select>
                      </label>
                      <label>{t('board.cardText')}
                        <textarea value={text} rows={4} onChange={(event) => { setText(event.target.value) }} placeholder={t('board.cardPlaceholder')} />
                      </label>
                      <div className={css.formActions}>
                        {editingId !== undefined && (
                          <button type="button" onClick={() => { setEditingId(undefined); setText(''); setKind('question') }}>{t('board.cancel')}</button>
                        )}
                        <button type="submit" className={css.primary} disabled={busy || text.trim().length === 0}>{t('board.save')}</button>
                      </div>
                      <small>{t('board.cardPrivateHint')}</small>
                    </form>
                  </section>

                  <section>
                    <div className={css.formTitle}><IconLinkOutline16 size={14} />{t('board.addEdge')}</div>
                    <form onSubmit={(event) => { void submitEdge(event) }}>
                      <label>{t('board.from')}
                        <select value={fromId} onChange={(event) => { setFromId(event.target.value) }}>
                          <option value="">—</option>
                          {nodes.map(node => <option key={node.id} value={node.id}>{shortText(node.text)}</option>)}
                        </select>
                      </label>
                      <label>{t('board.relation')}
                        <select value={relation} onChange={(event) => { setRelation(event.target.value as EdgeRelation) }}>
                          {RELATIONS.map(value => <option key={value} value={value}>{t(`board.relation.${value}`)}</option>)}
                        </select>
                      </label>
                      <label>{t('board.to')}
                        <select value={toId} onChange={(event) => { setToId(event.target.value) }}>
                          <option value="">—</option>
                          {nodes.map(node => <option key={node.id} value={node.id}>{shortText(node.text)}</option>)}
                        </select>
                      </label>
                      <button type="submit" className={css.primary} disabled={busy || fromId.length === 0 || toId.length === 0 || fromId === toId}>{t('board.connect')}</button>
                      <small>{t('board.edgePrivateHint')}</small>
                    </form>
                  </section>
                  {error !== null && <div className={css.error}>{error}</div>}
                </aside>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  )
}
