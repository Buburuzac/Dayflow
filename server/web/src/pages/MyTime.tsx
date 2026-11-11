import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../api/client.ts'
import type { DeviceInfo, Project, TimelineCard } from '../api/types.ts'
import { useApp } from '../app-context.ts'
import { ShareBar } from '../components/charts.tsx'
import { initialRange, RangePicker, type RangeValue } from '../components/RangePicker.tsx'
import { Empty, ErrorBox, Loading, ProjectChip, SHARE_LABEL } from '../components/ui.tsx'
import { categoryColor, type Category } from '../lib/categories.ts'
import { axisHour, clock, dayLabel, daysInRange, logicalDay, minuteOfDay, shortDay, toMs } from '../lib/dates.ts'
import { fmtMinutes } from '../lib/format.ts'
import { useAsync } from '../lib/hooks.ts'
import { groupByDevice, hourWindow, layoutLane } from '../lib/lanes.ts'
import { clockText24, detailLines } from '../../../../windows/src/shared/detailed.ts'

const PX_PER_MIN = 1.6

interface Positioned {
  id: string
  start: number
  end: number
  card: TimelineCard
}

const cardMinutes = (c: TimelineCard) => Math.max(0, (toMs(c.endTs) - toMs(c.startTs)) / 60000)

function ProjectFolderIcon() {
  return <span className="project-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.5h5l1.5 2h6.5v7h-13z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>
}

function EntryProjects({ card, rowKey, project }: { card: TimelineCard; rowKey: string; project: Lookup }) {
  const map = card.metadata?.detailProjects as Record<string, { projectId: string; confirmed: boolean }[]> | undefined
  const refs = map && Object.keys(map).length ? map[rowKey] ?? [] : card.projects
  if (!refs.length) return null
  return <div className="entry-projects">{refs.map((ref) => { const p = project(ref.projectId); return <ProjectChip key={ref.projectId} name={`${p.icon ? `${p.icon} ` : ''}${p.name}`} color={p.color} unconfirmed={!ref.confirmed} /> })}</div>
}

/** Workspace projects first, then the name/colour the timeline carries (projects from other workspaces). */
function useProjectLookup(projects: Project[], cards: TimelineCard[]) {
  return useMemo(() => {
    const m = new Map<string, { id: string; name: string; color: string; icon?: string }>()
    for (const c of cards) for (const p of c.projects) m.set(p.projectId, { id: p.projectId, name: p.projectName, color: p.color || '#BFB6AE', icon: p.icon })
    for (const p of projects) m.set(p.id, p)
    return (id: string) => m.get(id) ?? { id, name: 'Other project', color: '#BFB6AE' }
  }, [projects, cards])
}

export interface TimelineData {
  cards: TimelineCard[]
  devices: DeviceInfo[]
  categories: Category[]
  /** per-device palettes when cards come from several people (combined timeline) */
  deviceCategories?: Record<string, Category[]>
  selectionDevices?: { userId: string; device: DeviceInfo }[]
}

export function MyTime() {
  const { me } = useApp()
  return (
    <TimelineView
      load={(from, to) => api.timeline(from, to)}
      fallbackDevices={me.devices}
      emptyText={(mode) => `No cards from any of your devices for this ${mode}. Cards appear here once a device has synced.`}
    />
  )
}

/**
 * Day/week timeline with one lane per device. Also used for member and combined views; the server
 * applies workspace sharing rules before those cards reach this component.
 */
export function TimelineView({
  load,
  deps = [],
  head,
  fallbackDevices = [],
  emptyText,
  initialDevice,
  hideDeviceFilter = false,
  totalLabel = 'Total',
  excludeDevices = [],
}: {
  load: (from: string, to: string) => Promise<TimelineData>
  deps?: unknown[]
  /** shown above the range picker; may use the loaded data */
  head?: ReactNode | ((data: TimelineData | undefined) => ReactNode)
  fallbackDevices?: DeviceInfo[]
  emptyText: (mode: string) => string
  /** device lane to show first (e.g. opened from the Users list) */
  initialDevice?: string
  hideDeviceFilter?: boolean
  totalLabel?: string
  /** cards from these devices are hidden without reloading */
  excludeDevices?: string[]
}) {
  const { projects } = useApp()
  const [range, setRange] = useState<RangeValue>(() => initialRange('day'))
  const [selected, setSelected] = useState<string | null>(null)
  const [deviceFilter, setDeviceFilter] = useState<string>(initialDevice ?? 'all')
  const tl = useAsync(() => load(range.range.from, range.range.to), [range.range.from, range.range.to, ...deps])
  const depsKey = JSON.stringify(deps)
  const [lastDeps, setLastDeps] = useState(depsKey)
  if (depsKey !== lastDeps) {
    // another person: forget the selected card and device filter, keep the period
    setLastDeps(depsKey)
    setSelected(null)
    setDeviceFilter('all')
  }
  const excludeKey = excludeDevices.join(',')
  const allCards = useMemo(() => (tl.data?.cards ?? []).filter((c) => !c.isError && !excludeDevices.includes(c.deviceId)), [tl.data, excludeKey])
  const allDevices: DeviceInfo[] = tl.data?.devices?.length ? tl.data.devices : fallbackDevices
  // devices worth a filter button: live ones and any that have cards in this range
  const filterDevices = allDevices.filter((d) => !d.revoked || allCards.some((c) => c.deviceId === d.id))
  const filter = deviceFilter !== 'all' && filterDevices.some((d) => d.id === deviceFilter) ? deviceFilter : 'all'
  const cards = useMemo(() => (filter === 'all' ? allCards : allCards.filter((c) => c.deviceId === filter)), [allCards, filter])
  const devices = filter === 'all' ? allDevices : allDevices.filter((d) => d.id === filter)
  const project = useProjectLookup(projects, cards)
  const cats = tl.data?.categories ?? []
  const deviceCats = tl.data?.deviceCategories
  const cardColor = (c: TimelineCard) => categoryColor(c.category, deviceCats?.[c.deviceId] ?? cats)

  const totals = useMemo(() => {
    const byCat = new Map<string, number>()
    const byProject = new Map<string, { minutes: number; unconfirmed: number }>()
    let total = 0
    for (const c of cards) {
      const m = cardMinutes(c)
      total += m
      byCat.set(c.category, (byCat.get(c.category) ?? 0) + m)
      for (const p of c.projects) {
        const t = byProject.get(p.projectId) ?? { minutes: 0, unconfirmed: 0 }
        if (p.confirmed) t.minutes += m * p.share
        else t.unconfirmed += m * p.share
        byProject.set(p.projectId, t)
      }
    }
    return { total, byCat: [...byCat].sort((a, b) => b[1] - a[1]), byProject: [...byProject].sort((a, b) => b[1].minutes - a[1].minutes) }
  }, [cards])

  const sel = cards.find((c) => c.id === selected) ?? null

  return (
    <div className="page timeline-page">
      {typeof head === 'function' ? head(tl.data) : head}
      <div className="page-head">
        <RangePicker value={range} onChange={(v) => { setRange(v); setSelected(null) }} modes={['day', 'week']} />
        <span className="muted small" title="All device lanes use this browser's time zone">
          Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}
        </span>
        {!hideDeviceFilter && filterDevices.length > 1 && (
          <div className="seg device-filter" role="tablist" aria-label="Device">
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setDeviceFilter('all')}>
              All devices
            </button>
            {filterDevices.map((d) => (
              <button
                key={d.id}
                role="tab"
                aria-selected={filter === d.id}
                className={filter === d.id ? 'active' : ''}
                onClick={() => { setDeviceFilter(d.id); setSelected(null) }}
                title={d.revoked ? `${d.name} (revoked)` : d.name}
              >
                <DeviceIcon platform={d.platform} /> {d.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="totals">
        <span className="total-chip strong">{totalLabel} {fmtMinutes(totals.total)}</span>
        {totals.byCat.map(([name, m]) => (
          <span key={name} className="total-chip">
            <span className="swatch" style={{ background: categoryColor(name, cats) }} />
            {name} {fmtMinutes(m)}
          </span>
        ))}
        {totals.byProject.length > 0 && <span className="totals-sep" />}
        {totals.byProject.map(([id, t]) => {
          const p = project(id)
          return (
            <span key={id} className="total-chip" title={t.unconfirmed ? `${fmtMinutes(t.unconfirmed)} not confirmed yet` : undefined}>
              <span className="swatch round" style={{ background: p.color }} />
              {p.name} {fmtMinutes(t.minutes)}
              {t.unconfirmed > 0 && <span className="muted"> +{fmtMinutes(t.unconfirmed)}?</span>}
            </span>
          )
        })}
      </div>
      {totals.total > 0 && (
        <div className="totals-bar">
          <ShareBar parts={totals.byCat.map(([name, m]) => ({ key: name, color: categoryColor(name, cats), value: m, label: `${name}: ${fmtMinutes(m)}` }))} />
        </div>
      )}

      <div className="tl-body">
        <div className="tl-scroll">
          {tl.error ? (
            <div className="pad">
              <ErrorBox error={tl.error} onRetry={tl.reload} />
            </div>
          ) : !tl.data ? (
            <Loading />
          ) : !cards.length ? (
            <Empty title="Nothing recorded yet">{emptyText(range.mode)}</Empty>
          ) : range.mode === 'day' ? (
            <DayLanes day={range.range.from} cards={cards} devices={devices} color={cardColor} project={project} selected={selected} onSelect={setSelected} />
          ) : (
            <WeekLanes days={daysInRange(range.range.from, range.range.to)} cards={cards} devices={devices} color={cardColor} project={project} selected={selected} onSelect={setSelected} />
          )}
        </div>
        {sel && <CardDetail card={sel} color={cardColor} devices={allDevices} project={project} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}

type Lookup = (id: string) => { id: string; name: string; color: string; icon?: string }

function DayLanes({ day, cards, devices, color, project, selected, onSelect }: { day: string; cards: TimelineCard[]; devices: DeviceInfo[]; color: (card: TimelineCard) => string; project: Lookup; selected: string | null; onSelect: (id: string) => void }) {
  const items: (Positioned & { deviceId: string })[] = cards.map((c) => ({ id: c.id, start: minuteOfDay(c.startTs, day), end: minuteOfDay(c.endTs, day), card: c, deviceId: c.deviceId }))
  const [a, b] = hourWindow(items)
  const lanes = groupByDevice(items, devices)
  const hours = Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const height = (b - a) * 60 * PX_PER_MIN
  return (
    <div className="lanes day" style={{ minWidth: Math.max(420, lanes.length * 180) }}>
      <div className="lane-heads" style={{ marginLeft: 56 }}>
        {lanes.map((l) => (
          <div key={l.device.id} className="lane-head" title={l.device.name}>
            <DeviceIcon platform={devices.find((d) => d.id === l.device.id)?.platform} />
            {l.device.name}
            <span className="muted">{fmtMinutes(l.items.reduce((s, i) => s + (i.end - i.start), 0))}</span>
          </div>
        ))}
      </div>
      <div className="grid" style={{ height, marginLeft: 56 }}>
        {hours.map((h) => (
          <div key={h} className="hour" style={{ top: (h - a) * 60 * PX_PER_MIN, left: -56 }}>
            <span>{axisHour(h)}</span>
          </div>
        ))}
        <div className="lane-cols">
          {lanes.map((l) => (
            <div key={l.device.id} className="lane-col">
              {layoutLane(l.items).map(({ item, col, cols }) => {
                const c = item.card
                const top = (item.start - a * 60) * PX_PER_MIN
                const h = Math.max(20, (item.end - item.start) * PX_PER_MIN - 2)
                const compact = h < 44
                return (
                  <button
                    key={c.id}
                    className={`card ${compact ? 'compact' : ''} ${selected === c.id ? 'selected' : ''}`}
                    style={{ top, height: h, left: `calc(${(col / cols) * 100}% + 3px)`, width: `calc(${100 / cols}% - 6px)`, ['--cat' as string]: color(c) }}
                    onClick={() => onSelect(c.id)}
                  >
                    <span className="card-title">{c.title || 'Untitled'}</span>
                    {!compact && (
                      <span className="card-time">
                        {clock(c.startTs)} – {clock(c.endTs)}
                      </span>
                    )}
                    {c.projects.length > 0 && <span className="project-cluster" title={c.projects.map((p) => `${project(p.projectId).name}: ${Math.round(p.share * 100)}%${p.confirmed ? '' : ' · suggested'}`).join('\n')}><ProjectFolderIcon /></span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function WeekLanes({ days, cards, devices, color, project, selected, onSelect }: { days: string[]; cards: TimelineCard[]; devices: DeviceInfo[]; color: (card: TimelineCard) => string; project: Lookup; selected: string | null; onSelect: (id: string) => void }) {
  const all = cards.map((c) => {
    const day = logicalDay(new Date(toMs(c.startTs)))
    return { id: c.id, day, start: minuteOfDay(c.startTs, day), end: minuteOfDay(c.endTs, day), card: c, deviceId: c.deviceId }
  })
  const [a, b] = hourWindow(all, 10)
  const span = (b - a) * 60
  const pct = (m: number) => `${((Math.max(a * 60, Math.min(b * 60, m)) - a * 60) / span) * 100}%`
  const deviceOrder = groupByDevice(all, devices).map((l) => l.device)
  const hours = Array.from({ length: b - a + 1 }, (_, i) => a + i)
  return (
    <div className="lanes week">
      <div className="week-axis">
        <div className="week-day-label" />
        <div className="week-track axis">
          {hours.map((h) => (
            <span key={h} style={{ left: pct(h * 60) }}>
              {axisHour(h)}
            </span>
          ))}
        </div>
      </div>
      {days.map((day) => {
        const dayItems = all.filter((i) => i.day === day)
        const total = dayItems.reduce((s, i) => s + (i.end - i.start), 0)
        return (
          <div key={day} className="week-day">
            <div className="week-day-label">
              <b>{shortDay(day)}</b>
              <span className="muted">{total ? fmtMinutes(total) : '—'}</span>
            </div>
            <div className="week-day-lanes">
              {deviceOrder.map((d) => {
                const items = dayItems.filter((i) => i.deviceId === d.id)
                const placed = layoutLane(items)
                return (
                  <div key={d.id} className="week-track" title={d.name}>
                    {hours.map((h) => (
                      <i key={h} className="tick" style={{ left: pct(h * 60) }} />
                    ))}
                    {placed.map(({ item, col, cols }) => (
                      <button
                        key={item.id}
                        className={`wk-block ${selected === item.id ? 'selected' : ''}`}
                        style={{
                          left: pct(item.start),
                          width: `calc(${pct(item.end)} - ${pct(item.start)})`,
                          top: `${(col / cols) * 100}%`,
                          height: `${100 / cols}%`,
                          ['--cat' as string]: color(item.card),
                        }}
                        onClick={() => onSelect(item.id)}
                        title={`${item.card.title} · ${clock(item.card.startTs)}–${clock(item.card.endTs)}${item.card.projects.length ? `\n${item.card.projects.map((p) => `${project(p.projectId).name}: ${Math.round(p.share * 100)}%`).join('\n')}` : ''}`}
                      >
                        <span>{item.card.title}</span>
                        {item.card.projects.length > 0 && <ProjectFolderIcon />}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <div className="week-legend">
        {deviceOrder.map((d, i) => (
          <span key={d.id} className="muted">
            Lane {i + 1}: {d.name}
          </span>
        ))}
      </div>
    </div>
  )
}

function CardDetail({ card, color, devices, project, onClose }: { card: TimelineCard; color: (card: TimelineCard) => string; devices: DeviceInfo[]; project: Lookup; onClose: () => void }) {
  const device = devices.find((d) => d.id === card.deviceId)
  const md = card.metadata ?? {}
  const detailAssignments = md.detailProjects as Record<string, { projectId: string }[]> | undefined
  const ownBreakdown = detailAssignments && Object.keys(detailAssignments).length
    ? detailLines(card.detailedSummary).map((row, i) => {
        const refs = detailAssignments[`detail:${i}`] ?? []
        return { line: row.raw, scope: refs.length ? 'project' : 'out-of-scope', projects: refs.map((ref) => ref.projectId) }
      })
    : []
  const mixedOwnBreakdown = ownBreakdown.some((row) => row.scope === 'project') && ownBreakdown.some((row) => row.scope === 'out-of-scope')
  const summaryBreakdown = Array.isArray(md.summaryBreakdown)
    ? md.summaryBreakdown as { line: string; scope: string; projects: string[] }[]
    : mixedOwnBreakdown ? ownBreakdown : null
  const distractions = Array.isArray(md.distractions) ? (md.distractions as { title?: string; summary?: string; startTime?: string; endTime?: string }[]) : []
  const sites = (md.appSites ?? null) as { primary?: string | null; secondary?: string | null } | null
  return (
    <aside className="detail">
      <div className="detail-inner">
        <div className="row between">
          <div className="detail-meta">
            <span className="cat-pill" style={{ ['--cat' as string]: color(card) }}>
              {card.category}
              {card.subcategory ? ` · ${card.subcategory}` : ''}
            </span>
            <span className="detail-time">
              {dayLabel(logicalDay(new Date(toMs(card.startTs))))}, {clock(card.startTs)} – {clock(card.endTs)} · {fmtMinutes(cardMinutes(card))}
            </span>
          </div>
          <button className="icon-btn small" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
        <h2>{card.title}</h2>
        <div className="muted small-row">
          <DeviceIcon platform={device?.platform} /> {device?.name ?? 'Unknown device'}
          {md.private === true && <span className="badge">Private · never shared</span>}
        </div>
        {card.shareLevel !== undefined && (
          <div className="notice small share-note">
            {card.shareLevel === null
              ? 'Outside this workspace’s projects — only the time is shown.'
              : card.shareLevel === 'time'
                ? 'Shared as time only — title and summaries are hidden.'
                : `Shared at “${SHARE_LABEL[card.shareLevel]}” level.`}
          </div>
        )}
        {card.projects.length > 0 && (
          <>
            <h3>Projects</h3>
            <div className="chip-row">
              {card.projects.map((p) => {
                const pr = project(p.projectId)
                return (
                  <span key={p.projectId} className="chip-line">
                    <ProjectChip name={pr.name} color={pr.color} unconfirmed={!p.confirmed} />
                    <span className="muted">
                      {Math.round(p.share * 100)}% · {p.source === 'llm' ? `suggested (${Math.round(p.confidence * 100)}%)` : p.source}
                    </span>
                  </span>
                )
              })}
            </div>
          </>
        )}
        {(card.summary || summaryBreakdown) && (
          <>
            <h3>Summary</h3>
            {summaryBreakdown ? <div className="detailed-lines">{summaryBreakdown.map((row, i) => {
              const parsed = detailLines(row.line)[0]
              return <div key={i} className="detailed-line"><b>{row.scope === 'out-of-scope' ? 'Out of scope' : row.projects.map((id) => project(id).name).join(', ')}</b>: {parsed?.start ? <><strong>{parsed.start}–{parsed.end}</strong>: {parsed.text}</> : row.line}</div>
            })}</div> : <p className="summary">{card.summary}</p>}
          </>
        )}
        {card.detailedSummary && (
          <>
            <h3>Detailed summary</h3>
            <div className="detailed-lines">{detailLines(card.detailedSummary).map((line, i) => <div key={i} className="detailed-line"><div>{line.start ? <><strong>{line.start}–{line.end}</strong>: {line.text}</> : line.text}</div><EntryProjects card={card} rowKey={`detail:${i}`} project={project} /></div>)}</div>
          </>
        )}
        {distractions.length > 0 && (
          <>
            <h3>Distractions</h3>
            <ul className="distractions">
              {distractions.map((d, i) => (
                <li key={i}>
                  <b>{d.title}</b> {d.startTime && <span className="muted">{clockText24(d.startTime) ?? d.startTime}–{clockText24(d.endTime ?? '') ?? d.endTime}</span>}
                  {d.summary && <div className="muted">{d.summary}</div>}
                  <EntryProjects card={card} rowKey={`distraction:${i}`} project={project} />
                </li>
              ))}
            </ul>
          </>
        )}
        {sites && (sites.primary || sites.secondary) && (
          <div className="sites">
            {[sites.primary, sites.secondary].filter(Boolean).map((s) => (
              <span key={s!} className="site-chip">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

export function DeviceIcon({ platform }: { platform?: string }) {
  const p = (platform ?? '').toLowerCase()
  const laptop = p.includes('mac') || p.includes('darwin') || p.includes('laptop')
  return (
    <svg className="device-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      {laptop ? (
        <path d="M2.5 3.5h9v6h-9zM1 11h12" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M1.5 2.5h11v7h-11zM5 12h4M7 9.5V12" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}
