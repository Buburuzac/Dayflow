import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SettingsWithSecrets } from '../../../shared/types.ts'
import type { WeeklyAccessState, WeeklyDashboardSnapshot, WeeklyPageData } from '../../../shared/weekly-types.ts'
import { WEEKLY_RECORDED_MINUTES_GATE } from '../../../shared/weekly-types.ts'
import { DonutCard } from './weekly/Donut.tsx'
import { ContextCard } from './weekly/ContextChart.tsx'
import { WorkflowCard } from './weekly/Workflow.tsx'
import { HeatmapCard } from './weekly/Heatmap.tsx'
import { TreemapCard } from './weekly/Treemap.tsx'
import { SankeyCard } from './weekly/Sankey.tsx'
import { AccessLocked, DataGate } from './weekly/Locked.tsx'
import { useWidth } from './weekly/util.ts'
import './weekly.css'

const DESIGN_WIDTH = 958
const MAX_WIDTH = 1500

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(y, m - 1, d + delta, 12)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

export function weekTitle(weekStartDay: string): string {
  const [y, m, d] = weekStartDay.split('-').map(Number)
  const f = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'long', day: 'numeric' })
  return `${f.format(new Date(y, m - 1, d, 12))} – ${f.format(new Date(y, m - 1, d + 6, 12))}`
}

function layout(panelWidth: number) {
  const pad = Math.min(56, Math.max(24, panelWidth * 0.03))
  const raw = Math.max(1, panelWidth - 2 * pad)
  const content = Math.min(MAX_WIDTH, raw)
  const sideBySide = raw >= DESIGN_WIDTH
  const donut = sideBySide ? Math.min(620, Math.max(461, Math.floor((content - 27) * 0.44))) : content
  const context = sideBySide ? Math.max(1, content - 27 - donut) : content
  return { pad, content, sideBySide, donut, context }
}

function Dashboard({
  snapshot,
  width,
  loading,
  weekKey,
  title,
}: {
  snapshot: WeeklyDashboardSnapshot
  width: number
  loading: boolean
  weekKey: string
  title: string
}) {
  const L = layout(width)
  const ex = (graphic: string, watermark?: 'left') => (title ? { weekTitle: title, graphic, watermark } : undefined)
  return (
    <div className="wk-sections" style={{ width: L.content }}>
      <div className={`wk-top-row ${L.sideBySide ? 'side' : 'stack'}`}>
        <DonutCard data={snapshot.donut} width={L.donut} loading={loading} exportInfo={ex('weekly-distribution')} />
        <ContextCard data={snapshot.contextCharts} width={L.context} exportInfo={ex('context-charts')} />
      </div>
      <WorkflowCard data={snapshot.workflow} width={L.content} exportInfo={ex('weekly-workflow')} />
      <HeatmapCard data={snapshot.heatmap} width={L.content} exportInfo={ex('focus-heatmap')} />
      <TreemapCard data={snapshot.treemap} width={L.content} exportInfo={ex('focus-breakdown')} />
      <SankeyCard model={snapshot.sankeyModel} width={L.content} weekKey={weekKey} exportInfo={ex('weekly-breakdown', 'left')} />
    </div>
  )
}

export function WeeklyView({ settings }: { settings: SettingsWithSecrets }) {
  const [rootRef, panelWidth] = useWidth<HTMLDivElement>()
  const [access, setAccess] = useState<WeeklyAccessState | null>(null)
  const [previewLocked, setPreviewLocked] = useState(false)
  const [week, setWeek] = useState<string | null>(null)
  const [data, setData] = useState<WeeklyPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showGated, setShowGated] = useState(false)
  const [preview, setPreview] = useState<WeeklyDashboardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  // Access state: on appear, every 30 s and when the window gets focus.
  const loadAccess = useCallback(() => {
    void window.dayflow
      .call<WeeklyAccessState>('weekly:access')
      .then(setAccess)
      .catch((e: unknown) => setError(String(e)))
  }, [])
  useEffect(() => {
    loadAccess()
    const t = setInterval(loadAccess, 30_000)
    window.addEventListener('focus', loadAccess)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', loadAccess)
    }
  }, [loadAccess])

  const unlocked = !!access?.unlocked || previewLocked

  // Default week: newest week with >= 15 h, else newest with data, else this week.
  useEffect(() => {
    if (!unlocked || week) return
    void window.dayflow
      .call<string>('weekly:defaultWeek')
      .then((w) => setWeek((cur) => cur ?? w))
      .catch((e: unknown) => setError(String(e)))
  }, [unlocked, week])

  // Fixture data for the blurred locked preview.
  useEffect(() => {
    if (access && !access.unlocked && !preview) {
      void window.dayflow.call<WeeklyDashboardSnapshot>('weekly:preview').then(setPreview)
    }
  }, [access, preview])

  const load = useCallback(() => {
    if (!week) return
    const gen = ++generation.current
    setLoading(true)
    void window.dayflow
      .call<WeeklyPageData>('weekly:snapshot', week)
      .then((d) => {
        if (gen !== generation.current) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => gen === generation.current && setError(String(e)))
      .finally(() => gen === generation.current && setLoading(false))
  }, [week])

  // Reload on week change, category change, focus and card changes.
  const categoriesKey = JSON.stringify(settings.categories)
  useEffect(() => {
    if (!unlocked) return
    load()
    const off = window.dayflow.onCardsChanged(load)
    window.addEventListener('focus', load)
    return () => {
      off()
      window.removeEventListener('focus', load)
    }
  }, [load, unlocked, categoriesKey])

  useEffect(() => setShowGated(false), [week])

  const L = layout(panelWidth || DESIGN_WIDTH + 112)
  const title = week ? weekTitle(week) : ''
  // Sections keep showing the last snapshot while the next week loads (only the donut shows a spinner).
  const current = data && data.weekStartDay === week ? data : null
  const stale = data !== null && current === null
  const canForward = current?.canNavigateForward ?? false

  let body: ReactNode = null
  if (!access) {
    body = null
  } else if (!unlocked) {
    body = (
      <AccessLocked
        access={access}
        width={panelWidth}
        preview={preview ? <Dashboard snapshot={preview} width={DESIGN_WIDTH + 112} loading={false} weekKey="preview" title="" /> : null}
        onView={loadAccess}
        onShowAnyway={() => setPreviewLocked(true)}
      />
    )
  } else {
    const gated = current !== null && current.recordedMinutes < WEEKLY_RECORDED_MINUTES_GATE && !showGated
    body = (
      <div className="wk-page" style={{ paddingLeft: L.pad, paddingRight: L.pad }}>
        <header className="wk-header">
          <button className="wk-nav" onClick={() => week && setWeek(shiftDay(week, -7))} title="Previous week" aria-label="Previous week">
            <Chevron dir="left" />
          </button>
          <h1 className="wk-week-title">{title}</h1>
          <button
            className="wk-nav"
            disabled={!canForward}
            onClick={() => week && canForward && setWeek(shiftDay(week, 7))}
            title="Next week"
            aria-label="Next week"
          >
            <Chevron dir="right" />
          </button>
        </header>
        {previewLocked && !access.unlocked && (
          <div className="wk-preview-note">
            Preview — Weekly normally unlocks after 30 hours of recorded data ({access.recordedText}).{' '}
            <button className="wk-link" onClick={() => setPreviewLocked(false)}>
              Back
            </button>
          </div>
        )}
        {error && <div className="wk-error">{error}</div>}
        {gated ? (
          <div style={{ width: L.content }}>
            <DataGate recordedMinutes={current.recordedMinutes} onShowAnyway={() => setShowGated(true)} />
          </div>
        ) : data ? (
          <Dashboard snapshot={data.snapshot} width={panelWidth} loading={loading || stale} weekKey={data.weekStartDay} title={title} />
        ) : (
          <div className="wk-loading">
            <div className="wk-spinner" />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="weekly" ref={rootRef}>
      {body}
    </div>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {dir === 'left' ? <path d="M14.5 6 8.5 12l6 6" /> : <path d="m9.5 6 6 6-6 6" />}
    </svg>
  )
}
