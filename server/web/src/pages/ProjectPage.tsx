import { useMemo, useState } from 'react'
import { api } from '../api/client.ts'
import type { Project, ProjectEntry, StandupItem } from '../api/types.ts'
import { useApp } from '../app-context.ts'
import { ChartCard, DayBars, DayStrip, HeatGrid, MemberBars } from '../components/charts.tsx'
import { initialRange, RangePicker, type RangeValue } from '../components/RangePicker.tsx'
import { Avatar, Empty, ErrorBox, Loading, ShareBadge, Tabs } from '../components/ui.tsx'
import { clock, dayLabel, daysInRange, logicalDay, minuteOfDay, rangeFor, shortDay, toMs } from '../lib/dates.ts'
import { fmtMinutes } from '../lib/format.ts'
import { navigate, useAsync } from '../lib/hooks.ts'
import { hourWindow } from '../lib/lanes.ts'
import { detailLines } from '../../../../windows/src/shared/detailed.ts'

type Tab = 'feed' | 'report' | 'standup'

export function ProjectPage({ id, tab }: { id: string; tab: Tab }) {
  const { projects, projectsLoading, isAdmin } = useApp()
  const [range, setRange] = useState<RangeValue>(() => initialRange('week'))
  const [standupDay, setStandupDay] = useState<RangeValue>(() => ({ mode: 'day', range: rangeFor('day', logicalDay()) }))
  const project = projects.find((p) => p.id === id)
  if (!project) return projectsLoading ? <Loading /> : <Empty title="Project not found">It may have been removed, or you are not a member of its workspace.</Empty>

  return (
    <div className="page scroll">
      <div className="project-head" style={{ ['--pc' as string]: project.color }}>
        <div className="ph-title">
          <button className="link-btn back" onClick={() => navigate('/projects')}>
            ‹ Projects
          </button>
          <h1>
            <i className="ph-dot" />
            {project.name}
            {project.archived && <span className="badge">Archived</span>}
          </h1>
          {project.description && <div className="muted">{project.description}</div>}
        </div>
        {isAdmin && (
          <button className="btn ghost" onClick={() => navigate(`/projects/${id}/settings`)}>
            Settings
          </button>
        )}
      </div>
      <div className="toolbar">
        <Tabs
          value={tab}
          options={[
            { id: 'feed', label: 'Feed' },
            { id: 'report', label: 'Report' },
            { id: 'standup', label: 'Standup' },
          ]}
          onChange={(t) => navigate(`/projects/${id}/${t}`)}
        />
        {tab === 'standup' ? <RangePicker value={standupDay} onChange={setStandupDay} modes={['day']} /> : <RangePicker value={range} onChange={setRange} />}
      </div>
      {tab === 'feed' && <Feed project={project} from={range.range.from} to={range.range.to} />}
      {tab === 'report' && <Report project={project} from={range.range.from} to={range.range.to} />}
      {tab === 'standup' && <Standup project={project} day={standupDay.range.from} />}
    </div>
  )
}

// ---- Feed ----

function Feed({ project, from, to }: { project: Project; from: string; to: string }) {
  const feed = useAsync(() => api.feed(project.id, from, to), [project.id, from, to])
  const grouped = useMemo(() => {
    const byDay = new Map<string, Map<string, ProjectEntry[]>>()
    for (const e of feed.data ?? []) {
      const day = entryDay(e)
      const m = byDay.get(day) ?? new Map<string, ProjectEntry[]>()
      const list = m.get(e.userId) ?? []
      list.push(e)
      m.set(e.userId, list)
      byDay.set(day, m)
    }
    return [...byDay].sort((a, b) => b[0].localeCompare(a[0]))
  }, [feed.data])

  if (feed.error) return <ErrorBox error={feed.error} onRetry={feed.reload} />
  if (!feed.data) return <Loading />
  if (!grouped.length) return <Empty title="No shared time">Nobody has confirmed time on {project.name} in this period.</Empty>
  return (
    <div className="feed">
      {grouped.map(([day, members]) => {
        const dayTotal = [...members.values()].flat().reduce((s, e) => s + e.minutes, 0)
        return (
          <section key={day} className="feed-day">
            <h2 className="feed-day-title">
              <span className="serif">{dayLabel(day)}</span>
              <span className="muted">{fmtMinutes(dayTotal)}</span>
            </h2>
            {[...members].map(([userId, entries]) => (
              <MemberEntries key={userId} day={day} entries={entries} color={project.color} />
            ))}
          </section>
        )
      })}
    </div>
  )
}

/** Card day from the server, else the logical day (4 AM boundary) of its start. */
function entryDay(e: ProjectEntry): string {
  return e.day ?? logicalDay(new Date(toMs(e.startTs)))
}

function MemberEntries({ day, entries, color }: { day: string; entries: ProjectEntry[]; color: string }) {
  const sorted = [...entries].sort((a, b) => a.startTs - b.startTs)
  const first = sorted[0]
  const total = sorted.reduce((s, e) => s + e.minutes, 0)
  const timeOnly = sorted.every((e) => e.shareLevel === 'time' || (e.title == null && e.summary == null && e.detailed == null))
  const segs = sorted.map((e) => ({ start: minuteOfDay(e.startTs, day), end: minuteOfDay(e.endTs, day), label: `${clock(e.startTs)}–${clock(e.endTs)} · ${fmtMinutes(e.minutes)}` }))
  return (
    <div className="member-block">
      <div className="mb-head">
        <Avatar name={first.userName} size={26} />
        <b>{first.userName}</b>
        <ShareBadge level={first.shareLevel} />
        <span className="mb-total">{fmtMinutes(total)}</span>
      </div>
      {timeOnly ? (
        <div className="mb-strip">
          <DayStrip segments={segs} window={hourWindow(segs, 10)} color={color} />
        </div>
      ) : (
        <ul className="entries">
          {sorted.map((e) => (
            <li key={e.cardId} className="entry" style={{ ['--pc' as string]: color }}>
              <div className="entry-time">
                {clock(e.startTs)}–{clock(e.endTs)}
                <span>{fmtMinutes(e.minutes)}</span>
              </div>
              <div className="entry-body">
                {e.title != null && <div className="entry-title">{e.title}</div>}
                {e.summary != null && <div className="entry-summary">{e.summary}</div>}
                {e.detailed != null && (
                  <details>
                    <summary>Details</summary>
                    <div className="detailed">{detailLines(e.detailed).map((line, i) => <div key={i}>{line.start ? <><strong>{line.start}–{line.end}</strong>: {line.text}</> : line.text}</div>)}</div>
                  </details>
                )}
                {e.title == null && e.summary == null && <div className="muted">Time only</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- Report ----

function Report({ project, from, to }: { project: Project; from: string; to: string }) {
  const rep = useAsync(() => api.report(project.id, from, to), [project.id, from, to])
  if (rep.error) return <ErrorBox error={rep.error} onRetry={rep.reload} />
  if (!rep.data) return <Loading />
  const r = rep.data
  const days = daysInRange(from, to)
  const byDay = new Map(r.byDay.map((d) => [d.day, d.minutes]))
  const cells = new Map(r.byMemberDay.map((c) => [`${c.userId}|${c.day}`, c.minutes]))
  const members = [...r.byMember].sort((a, b) => b.minutes - a.minutes)
  const activeDays = r.byDay.filter((d) => d.minutes > 0).length
  return (
    <div className="report">
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-v serif">{fmtMinutes(r.totalMinutes)}</span>
          <span className="muted">total</span>
        </div>
        <div className="kpi">
          <span className="kpi-v serif">{members.length}</span>
          <span className="muted">{members.length === 1 ? 'person' : 'people'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-v serif">{activeDays ? fmtMinutes(r.totalMinutes / activeDays) : '—'}</span>
          <span className="muted">per active day</span>
        </div>
      </div>
      {!r.totalMinutes ? (
        <Empty title="No time in this period" />
      ) : (
        <div className="report-grid">
          <ChartCard title="By member" extra={<span className="muted chart-note">share of the project</span>}>
            <MemberBars rows={members.map((m) => ({ id: m.userId, name: m.userName, minutes: m.minutes }))} color={project.color} total={r.totalMinutes} />
          </ChartCard>
          <ChartCard title="By day">
            <DayBars days={days.map((d) => ({ day: d, minutes: byDay.get(d) ?? 0 }))} color={project.color} />
          </ChartCard>
          <ChartCard title="Member × day" className="span-2" extra={<span className="muted chart-note">hours</span>}>
            <HeatGrid members={members.map((m) => ({ id: m.userId, name: m.userName }))} days={days} value={(u, d) => cells.get(`${u}|${d}`) ?? 0} color={project.color} />
          </ChartCard>
        </div>
      )}
    </div>
  )
}

// ---- Standup ----

function Standup({ project, day }: { project: Project; day: string }) {
  const st = useAsync(() => api.standup(project.id, day), [project.id, day])
  if (st.error) return <ErrorBox error={st.error} onRetry={st.reload} />
  if (!st.data) return <Loading />
  if (!st.data.members.length) return <Empty title="No standups">Nobody has a standup for {project.name} on {['Today', 'Yesterday'].includes(dayLabel(day)) ? dayLabel(day).toLowerCase() : dayLabel(day)}.</Empty>
  return (
    <div className="standup-grid">
      {st.data.members.map((m) => (
        <section key={m.userId} className="standup-card">
          <div className="mb-head">
            <Avatar name={m.userName} size={28} />
            <b>{m.userName}</b>
            <ShareBadge level={m.shareLevel} />
            {m.minutes != null && <span className="mb-total">{fmtMinutes(m.minutes)}</span>}
          </div>
          <StandupList
            title={m.sourceDay && m.sourceDay !== day ? `Done · ${shortDay(m.sourceDay)}` : 'Done'}
            items={m.done}
            timeOnly={m.shareLevel === 'time'}
            note={m.shareLevel === 'time' && m.sourceMinutes ? fmtMinutes(m.sourceMinutes) : undefined}
          />
          <StandupList title="Next" items={m.next} timeOnly={m.shareLevel === 'time'} />
          {m.hasStandup === false && <div className="muted small">No standup written — showing project cards.</div>}
        </section>
      ))}
    </div>
  )
}

function StandupList({ title, items, timeOnly, note }: { title: string; items: StandupItem[]; timeOnly: boolean; note?: string }) {
  return (
    <div className="su-list">
      <h3>{title}</h3>
      {!items.length ? (
        <div className="muted">{timeOnly ? `Shares time only${note ? ` · ${note} on this project` : ''}` : 'Nothing listed'}</div>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={i}>
              {it.title ?? <span className="muted">(hidden)</span>}
              {it.minutes != null && <span className="muted"> · {fmtMinutes(it.minutes)}</span>}
              {it.summary && <div className="muted">{it.summary}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
