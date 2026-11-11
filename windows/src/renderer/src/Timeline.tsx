import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppStatus, BatchInfo, ScreenshotInfo, SettingsWithSecrets, TimelineCard } from '../../shared/types.ts'
import type { ProjectView } from '../../shared/sync-ui.ts'
import { CardSyncSection, ProjectCluster } from './features/CardProjects.tsx'
import { clockText24, detailLines } from '../../shared/detailed.ts'
import { initialDetailProjects, projectRecords } from '../../shared/detail-projects.ts'
import { useProjects } from './features/Sync.tsx'
import { DayGoalHeader } from './features/DayGoals.tsx'
import { ipcErrorMessage } from './Settings.tsx'
import { ReviewPromptButton } from './features/Review.tsx'
import { TimelapseButton } from './features/Timelapse.tsx'
import { clock24, currentDay, dayLabel, dayStart, fmtDuration, shiftDay } from './dates.ts'
import { crossDeviceOverlapIds } from './timeline-layout.ts'

const PX_PER_MIN = 2.2

export function TimelineView({
  settings,
  status,
  onReview,
}: {
  settings: SettingsWithSecrets
  status: AppStatus | null
  onReview: (day: string) => void
}) {
  const [day, setDay] = useState(currentDay)
  const [cards, setCards] = useState<TimelineCard[]>([])
  const [batches, setBatches] = useState<BatchInfo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [projectFilter, setProjectFilter] = useState<string>('')
  const projects = useProjects()
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void window.dayflow.getCards(day).then(setCards)
    void window.dayflow.getBatches(day).then(setBatches)
  }, [day])

  useEffect(() => {
    load()
    return window.dayflow.onCardsChanged(load)
  }, [load])

  const colors = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of settings.categories) m.set(c.name, c.color)
    m.set('System', '#E5A08B')
    // Time-only blocks synced from the user's other devices (sync/scope.ts).
    m.set('Out of scope', '#C9C4BE')
    return m
  }, [settings.categories])

  // Project filter: '' = all, '-' = cards without a project, otherwise a project id.
  const visibleCards =
    projectFilter === ''
      ? cards
      : cards.filter((c) =>
          projectFilter === '-' ? !c.isError && !(c.projects ?? []).length : (c.projects ?? []).some((p) => p.projectId === projectFilter),
        )
  // Full width when only one device has a card at this time; split only actual overlaps.
  const splitCards = crossDeviceOverlapIds(visibleCards)
  const selectedCard = visibleCards.find((c) => c.id === selected) ?? null

  // Range of hours to draw: from the first card (or 8 AM) to the last card (or now).
  const base = dayStart(day)
  const firstMin = visibleCards.length ? Math.floor((visibleCards[0].startTs - base) / 60) : 4 * 60
  const lastMin = visibleCards.length
    ? Math.ceil((Math.max(...visibleCards.map((c) => c.endTs)) - base) / 60)
    : Math.min(24 * 60, Math.max(8 * 60, Math.ceil((Date.now() / 1000 - base) / 60)))
  const startHour = Math.max(0, Math.floor(firstMin / 60) - 0)
  const endHour = Math.min(24, Math.ceil(lastMin / 60) + 1)
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    setSelected(null)
  }, [day])

  const totals = useMemo(() => {
    const t = new Map<string, number>()
    for (const c of visibleCards) {
      if (c.isError) continue
      t.set(c.category, (t.get(c.category) ?? 0) + (c.endTs - c.startTs))
    }
    return [...t.entries()].sort((a, b) => b[1] - a[1])
  }, [visibleCards])

  const processing = batches.filter((b) => b.status === 'processing' || b.status === 'pending').length
  const isToday = day === currentDay()

  return (
    <div className="timeline">
      <header className="tl-header">
        <div className="date-nav">
          <button className="icon-btn" onClick={() => setDay((d) => shiftDay(d, -1))} title="Previous day">
            ‹
          </button>
          <h1>{dayLabel(day)}</h1>
          <button className="icon-btn" disabled={isToday} onClick={() => setDay((d) => shiftDay(d, 1))} title="Next day">
            ›
          </button>
          {!isToday && (
            <button className="link-btn" onClick={() => setDay(currentDay())}>
              Today
            </button>
          )}
        </div>
        <div className="tl-actions">
          {projects.length > 0 && (
            <select className="project-filter" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} title="Filter by project">
              <option value="">All projects</option>
              {projects.map((p: ProjectView) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="-">No project</option>
            </select>
          )}
          <ReviewPromptButton day={day} onOpen={() => onReview(day)} />
          {(processing > 0 || (status?.batchesProcessing ?? 0) > 0) && <span className="badge">Analyzing…</span>}
          {status && status.batchesFailed > 0 && (
            <button className="btn ghost" onClick={() => void window.dayflow.analyzeNow()}>
              Retry {status.batchesFailed} failed
            </button>
          )}
          <button className="btn ghost" onClick={() => void window.dayflow.analyzeNow()} title="Process captured screenshots now">
            Analyze now
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              if (confirm(`Regenerate all cards for ${dayLabel(day)}? Existing cards for this day will be replaced.`)) {
                window.dayflow.reprocessDay(day).catch((err: unknown) => alert(ipcErrorMessage(err)))
              }
            }}
          >
            Reprocess day
          </button>
          <button className="btn ghost" onClick={() => void window.dayflow.exportMarkdown(day, day)}>
            Export
          </button>
        </div>
      </header>

      {totals.length > 0 && (
        <div className="totals">
          {totals.map(([cat, secs]) => (
            <span key={cat} className="total-chip">
              <span className="swatch" style={{ background: colors.get(cat) ?? '#ccc' }} />
              {cat} <b>{fmtDuration(secs)}</b>
            </span>
          ))}
        </div>
      )}

      <DayGoalHeader day={day} settings={settings} />

      <div className="tl-body">
        <div className="tl-scroll" ref={scrollRef}>
          {visibleCards.length === 0 ? (
            <EmptyState isToday={isToday} status={status} />
          ) : (
            <div className="grid" style={{ height: hours.length * 60 * PX_PER_MIN }}>
              {hours.map((h) => (
                <div key={h} className="hour" style={{ top: (h - startHour) * 60 * PX_PER_MIN }}>
                  <span>{hourLabel(h)}</span>
                </div>
              ))}
              {visibleCards.map((c) => {
                const top = ((c.startTs - base) / 60 - startHour * 60) * PX_PER_MIN
                const height = Math.max(22, ((c.endTs - c.startTs) / 60) * PX_PER_MIN - 3)
                const color = colors.get(c.category) ?? '#ccc'
                const favicon = height > 30 ? c.appSites?.primary : undefined
                const hasFavicon = !!favicon
                const hasProjects = !!c.projects?.length
                const lane = splitCards.has(c.id) ? (c.remote ? 'lane-remote' : 'lane-local') : ''
                return (
                  <div
                    key={c.id}
                    className={`card ${c.isError ? 'error' : ''} ${selected === c.id ? 'selected' : ''} ${height < 60 ? 'compact' : ''} ${lane} ${hasProjects ? 'has-projects' : ''} ${hasFavicon ? 'has-favicon' : ''}`}
                    style={{ top, height, ['--cat' as string]: color }}
                    onClick={() => setSelected(c.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelected(c.id) }}
                  >
                    <ProjectCluster card={c} onOpen={() => setSelected(c.id)} />
                    <span className="card-title">
                      {c.remote && (
                        <span className="remote-mark" title="From another of your devices">
                          ⇄{' '}
                        </span>
                      )}
                      {c.private && (
                        <span className="private-mark" title="Private: stays on this PC, never synced or shared">
                          private
                        </span>
                      )}
                      {c.title}
                    </span>
                    <span className="card-time">
                      {clock24(c.startTs)} – {clock24(c.endTs)}
                    </span>
                    {height > 120 && c.summary && <span className="card-summary">{c.summary}</span>}
                    {favicon && <Favicon domain={favicon} />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <aside className="detail">
          {selectedCard ? (
            <CardDetail
              key={selectedCard.id}
              card={selectedCard}
              color={colors.get(selectedCard.category) ?? '#ccc'}
              categories={settings.categories.map((c) => c.name)}
            />
          ) : (
            <div className="detail-empty">Select a card to see what happened.</div>
          )}
        </aside>
      </div>
    </div>
  )
}

function hourLabel(h: number): string {
  // Hours are relative to the 4 AM day start.
  const real = (h + 4) % 24
  return `${String(real).padStart(2, '0')}:00`
}

function Favicon({ domain }: { domain: string }) {
  // Offline-friendly: show the domain's initial instead of fetching favicons.
  const letter = domain.replace(/^www\./, '')[0]?.toUpperCase() ?? '?'
  return (
    <span className="favicon" title={domain}>
      {letter}
    </span>
  )
}

function EmptyState({ isToday, status }: { isToday: boolean; status: AppStatus | null }) {
  return (
    <div className="empty">
      <div className="empty-title">{isToday ? 'Your day will show up here' : 'Nothing recorded this day'}</div>
      {isToday && (
        <p>
          Dayflow takes a screenshot every few seconds and, every 15 minutes, asks your AI provider to turn them into
          timeline cards. The first cards appear about 15–20 minutes after recording starts.
          {status && status.pendingScreenshots > 0 && (
            <>
              <br />
              <b>{status.pendingScreenshots}</b> screenshots are waiting for the next batch.
            </>
          )}
        </p>
      )}
    </div>
  )
}

function CardDetail({ card, color, categories }: { card: TimelineCard; color: string; categories: string[] }) {
  const [shots, setShots] = useState<ScreenshotInfo[]>([])
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    void window.dayflow.getCardScreenshots(card.id).then((s) => {
      setShots(s)
      setIdx(0)
    })
  }, [card.id])

  useEffect(() => {
    if (!playing || shots.length === 0) return
    const t = setInterval(() => setIdx((i) => (i + 1) % shots.length), 250)
    return () => clearInterval(t)
  }, [playing, shots.length])

  const shot = shots[idx]
  return (
    <div className="detail-inner">
      <div className="detail-meta">
        <span className="cat-chip" style={{ ['--cat' as string]: color }}>
          <select
            value={card.category}
            onChange={(e) => void window.dayflow.updateCardCategory(card.id, e.target.value)}
            disabled={card.isError}
          >
            {(categories.includes(card.category) ? categories : [card.category, ...categories]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </span>
        <span className="detail-time">
          {clock24(card.startTs)} – {clock24(card.endTs)} · {fmtDuration(card.endTs - card.startTs)}
        </span>
      </div>
      <EditableTitle card={card} />
      {shots.length > 0 && (
        <div className="viewer">
          <img src={window.dayflow.imageUrl(shot.filePath)} alt="" onClick={() => setPlaying((p) => !p)} />
          <div className="viewer-bar">
            <button className="icon-btn small" onClick={() => setPlaying((p) => !p)} title={playing ? 'Pause' : 'Play timelapse'}>
              {playing ? '❚❚' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={shots.length - 1}
              value={idx}
              onChange={(e) => {
                setPlaying(false)
                setIdx(Number(e.target.value))
              }}
            />
            <span className="viewer-time">
              {clock24(shot.capturedAt)}
            </span>
          </div>
        </div>
      )}
      {!card.isError && !card.remote && <TimelapseButton cardId={card.id} />}
      {card.remote && <p className="muted small">From another of your devices — screenshots stay on that PC.</p>}
      {!card.isError && <CardSyncSection card={card} />}
      {(card.projects ?? []).length > 0 && <section className="detail-project-breakdown"><h3>Project time</h3>
        {(card.projects ?? []).map((p) => <div key={p.projectId} className="row"><span className="project-mark" style={{ ['--proj' as string]: p.color }}>{p.icon}</span><span>{p.name}{p.confirmed ? '' : ' ?'}</span><b>{Math.round(p.share * 100)}%</b></div>)}
      </section>}
      {card.summary && <p className="summary">{card.summary}</p>}
      {card.distractions.length > 0 && (
        <section>
          <h3>Distractions</h3>
          <ul className="distractions">
            {card.distractions.map((d, i) => (
              <li key={i}>
                <span className="detail-time">
                  {clockText24(d.startTime) ?? d.startTime} – {clockText24(d.endTime) ?? d.endTime}
                </span>{' '}
                <b>{d.title}</b>
                {d.summary && <div>{d.summary}</div>}
                <DetailProjectPicker card={card} rowKey={`distraction:${i}`} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {card.detailedSummary && (
        <section>
          <h3>Detailed summary</h3>
          <div className="detailed-lines">{detailLines(card.detailedSummary).map((line, i) => <div key={i} className="detailed-line"><div>{line.start ? <><strong>{line.start}–{line.end}</strong>: {line.text}</> : line.text}</div><DetailProjectPicker card={card} rowKey={`detail:${i}`} /></div>)}</div>
        </section>
      )}
      {(card.appSites?.primary || card.appSites?.secondary) && (
        <div className="sites">
          {[card.appSites?.primary, card.appSites?.secondary].filter(Boolean).map((s) => (
            <span key={s!} className="site-chip">
              {s}
            </span>
          ))}
        </div>
      )}
      <div className="detail-footer">
        <button
          className="link-btn danger"
          onClick={() => {
            if (confirm('Delete this card?')) void window.dayflow.deleteCard(card.id)
          }}
        >
          Delete card
        </button>
      </div>
    </div>
  )
}

function DetailProjectPicker({ card, rowKey }: { card: TimelineCard; rowKey: string }) {
  const projects = useProjects()
  if (!projectRecords(card).some((r) => r.key === rowKey)) return null
  const refs = initialDetailProjects(card)[rowKey] ?? []
  const act = (projectId: string, action: 'add' | 'remove' | 'confirm') => void window.dayflow.call('projects:editDetail', card.id, rowKey, projectId, action).catch((e: unknown) => alert(ipcErrorMessage(e)))
  return <div className="detail-project-picker">
    {refs.map((p) => { const project = projects.find((x) => x.id === p.projectId); return <span key={p.projectId} className={`proj-chip ${p.confirmed ? '' : 'unconfirmed'}`} style={{ ['--proj' as string]: project?.color ?? '#999' }}>
      {project?.icon} {project?.name ?? 'Project'}{!p.confirmed && <button className="detail-project-action" title="Confirm project" onClick={() => act(p.projectId, 'confirm')}>?</button>}
      <button className="detail-project-action" title="Remove project from this entry" onClick={() => act(p.projectId, 'remove')}>×</button>
    </span> })}
    {projects.some((p) => !p.archived && !refs.some((r) => r.projectId === p.id)) && <select aria-label="Add project to this entry" value="" onChange={(e) => act(e.target.value, 'add')}><option value="">＋ Project</option>{projects.filter((p) => !p.archived && !refs.some((r) => r.projectId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}</select>}
  </div>
}

function EditableTitle({ card }: { card: TimelineCard }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(card.title)
  if (!editing || card.isError) {
    return (
      <h2 className="editable" title={card.isError ? undefined : 'Click to edit'} onClick={() => !card.isError && setEditing(true)}>
        {card.title}
      </h2>
    )
  }
  const commit = () => {
    setEditing(false)
    const v = value.trim()
    if (v && v !== card.title) void window.dayflow.updateCardTitle(card.id, v)
    else setValue(card.title)
  }
  return (
    <textarea
      className="title-edit"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setValue(card.title)
          setEditing(false)
        }
      }}
    />
  )
}
