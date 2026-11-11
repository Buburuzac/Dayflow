import { useEffect, useMemo, useState } from 'react'
import type { ProjectEntry, ProjectReport, ShareLevel, TimesheetProposal, TimesheetSubmitResult, WorkspaceInfo } from '../../../shared/sync-types.ts'
import type { ProjectDraft, ProjectView, SyncStatus, TimesheetProposalsView } from '../../../shared/sync-ui.ts'
import { ipcErrorMessage } from '../Settings.tsx'
import { clock24, currentDay, shiftDay } from '../dates.ts'
import { detailLines } from '../../../shared/detailed.ts'
import { useProjects, useSyncStatus } from './Sync.tsx'
import './sync.css'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

export const SHARE_LABELS: Record<ShareLevel, string> = {
  time: 'Time only',
  cards: 'Time + titles & summaries',
  detailed: 'Everything (detailed summaries, distractions)',
}

type Sub = 'projects' | 'activity' | 'timesheets'

/** Monday of the week containing `day` (YYYY-MM-DD). */
function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const dow = (new Date(y, m - 1, d, 12).getDay() + 6) % 7
  return shiftDay(day, -dow)
}

const hm = (minutes: number) => {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
const clock = clock24

type Range = 'today' | 'week' | 'month' | 'custom'
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/** Longest range the team views ask for (the grid gets one column per day). */
const MAX_RANGE_DAYS = 93

/** Every day from `from` to `to` inclusive (YYYY-MM-DD), capped at MAX_RANGE_DAYS. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < MAX_RANGE_DAYS; d = shiftDay(d, 1)) out.push(d)
  return out
}

const weekdayShort = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toLocaleDateString([], { weekday: 'short' })
}

/** Member × day minutes grid (ProjectReport.byMemberDay); a column per day of the range. */
function MemberDayGrid({ report, from, to }: { report: ProjectReport; from: string; to: string }) {
  const days = daysBetween(from, to)
  const cells = new Map<string, number>()
  for (const c of report.byMemberDay ?? []) cells.set(`${c.userId}|${c.day}`, (cells.get(`${c.userId}|${c.day}`) ?? 0) + c.minutes)
  const dayTotals = new Map((report.byDay ?? []).map((d) => [d.day, d.minutes]))
  const max = Math.max(1, ...[...cells.values()])
  if (!report.byMember.length) return null
  return (
    <div className="member-day">
      <table>
        <thead>
          <tr>
            <th />
            {days.map((d) => (
              <th key={d} title={d}>
                <span className="muted">{weekdayShort(d)}</span>
                <br />
                {d.slice(8)}
              </th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {report.byMember.map((m) => (
            <tr key={m.userId}>
              <th className="member">{m.userName}</th>
              {days.map((d) => {
                const v = cells.get(`${m.userId}|${d}`) ?? 0
                return (
                  <td key={d} title={`${m.userName}, ${d}: ${hm(v)}`} style={v ? { background: `rgba(185, 132, 255, ${0.15 + 0.6 * (v / max)})` } : undefined}>
                    {v ? hm(v) : ''}
                  </td>
                )
              })}
              <td className="total">{hm(m.minutes)}</td>
            </tr>
          ))}
          <tr className="totals">
            <th className="member">All</th>
            {days.map((d) => (
              <td key={d}>{dayTotals.get(d) ? hm(dayTotals.get(d)!) : ''}</td>
            ))}
            <td className="total">{hm(report.totalMinutes)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function TeamView() {
  const [status] = useSyncStatus()
  const [sub, setSub] = useState<Sub>('projects')
  const projects = useProjects()

  if (!status) return null
  return (
    <div className="team">
      <header className="team-header">
        <h1>Team</h1>
        <div className="seg">
          {(['projects', 'activity', 'timesheets'] as Sub[]).map((s) => (
            <button key={s} className={sub === s ? 'active' : ''} onClick={() => setSub(s)}>
              {s === 'projects' ? 'Projects' : s === 'activity' ? 'Activity' : 'Timesheets'}
            </button>
          ))}
        </div>
      </header>
      {!status.signedIn ? (
        <div className="empty">
          <div className="empty-title">Not connected to a team</div>
          <p>Sign in under Settings → Sync & team to see your workspace's projects, the team's activity and timesheets.</p>
        </div>
      ) : sub === 'projects' ? (
        <ProjectsPanel status={status} projects={projects} />
      ) : sub === 'activity' ? (
        <ActivityPanel projects={projects} />
      ) : (
        <TimesheetsPanel status={status} projects={projects} />
      )}
    </div>
  )
}

// ---- Projects ----

const adminOf = (ws: WorkspaceInfo[]) => ws.filter((w) => w.role === 'owner' || w.role === 'admin')

function ProjectsPanel({ status, projects }: { status: SyncStatus; projects: ProjectView[] }) {
  const [editing, setEditing] = useState<ProjectDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const admin = adminOf(status.workspaces)
  const wsName = (id: string) => status.workspaces.find((w) => w.id === id)?.name ?? ''
  const canEdit = (p: ProjectView) => admin.some((w) => w.id === p.workspaceId)

  const setMyShare = (p: ProjectView, v: string) =>
    call('projects:setMyShare', p.id, v === '' ? null : v).catch((err: unknown) => setError(ipcErrorMessage(err)))

  return (
    <div className="team-body">
      {error && <div className="notice err">{error}</div>}
      {admin.length > 0 && !editing && (
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              setEditing({
                workspaceId: admin[0].id,
                name: '',
                color: '#7BC47F',
                description: '',
                rules: {},
                defaultShare: 'cards',
                odoo: {},
              })
            }
          >
            New project
          </button>
        </div>
      )}
      {editing && (
        <section className="panel">
          <ProjectEditor
            draft={editing}
            workspaces={admin}
            onCancel={() => setEditing(null)}
            onSaved={() => setEditing(null)}
          />
        </section>
      )}
      {projects.length === 0 && !editing && (
        <p className="muted">
          No projects yet. {admin.length ? 'Create one to start tracking time per project.' : 'A workspace admin can create them.'}
        </p>
      )}
      <div className="project-list">
        {projects.map((p) => (
          <section key={p.id} className={`panel project-row ${p.archived ? 'archived' : ''}`}>
            <div className="project-head">
              <span className="swatch big" style={{ background: p.color }}>{p.icon}</span>
              <div className="project-title">
                <b>{p.name}</b>
                {p.archived && <span className="badge">archived</span>}
                <div className="muted small">
                  {wsName(p.workspaceId)}
                  {p.odoo.projectName || p.odoo.projectId
                    ? ` · Odoo: ${p.odoo.projectName ?? `#${p.odoo.projectId}`}${p.odoo.taskName || p.odoo.taskId ? ` / ${p.odoo.taskName ?? `#${p.odoo.taskId}`}` : ''}`
                    : ''}
                </div>
              </div>
              {canEdit(p) && (
                <button className="btn ghost" onClick={() => setEditing({ ...p })}>
                  Edit
                </button>
              )}
            </div>
            {p.description && <p className="project-desc">{p.description}</p>}
            <RulesSummary p={p} />
            <div className="form">
              <label>
                What the team sees of my time on this project
                <select value={p.myShare ?? ''} onChange={(e) => void setMyShare(p, e.target.value)}>
                  <option value="">Project default — {SHARE_LABELS[p.defaultShare]}</option>
                  {(Object.keys(SHARE_LABELS) as ShareLevel[]).map((s) => (
                    <option key={s} value={s}>
                      {SHARE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function RulesSummary({ p }: { p: ProjectView }) {
  const parts: [string, string[] | undefined][] = [
    ['Apps', p.rules.apps],
    ['Domains', p.rules.domains],
    ['Title keywords', p.rules.titleKeywords],
    ['Repos', p.rules.repos],
  ]
  const shown = parts.filter(([, v]) => v && v.length)
  if (!shown.length) return <p className="muted small">No rules — cards are assigned by the AI or by hand.</p>
  return (
    <div className="rules">
      {shown.map(([k, v]) => (
        <span key={k} className="muted small">
          {k}: {v!.join(', ')}
        </span>
      ))}
    </div>
  )
}

const listText = (v?: string[]) => (v ?? []).join(', ')
const textList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

function ProjectEditor({
  draft,
  workspaces,
  onCancel,
  onSaved,
}: {
  draft: ProjectDraft
  workspaces: WorkspaceInfo[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [d, setD] = useState(draft)
  const [rules, setRules] = useState({
    apps: listText(draft.rules.apps),
    domains: listText(draft.rules.domains),
    titleKeywords: listText(draft.rules.titleKeywords),
    repos: listText(draft.rules.repos),
  })
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => setD((x) => ({ ...x, [k]: v }))
  const setOdoo = (k: 'projectId' | 'taskId' | 'projectName' | 'taskName', v: string) =>
    setD((x) => ({
      ...x,
      odoo: { ...x.odoo, [k]: k.endsWith('Id') ? (v.trim() ? Number(v) : undefined) : v || undefined },
    }))

  const save = async () => {
    setError(null)
    try {
      await call('projects:save', {
        ...d,
        rules: {
          apps: textList(rules.apps),
          domains: textList(rules.domains),
          titleKeywords: textList(rules.titleKeywords),
          repos: textList(rules.repos),
        },
      })
      onSaved()
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  return (
    <div className="form project-editor">
      <h2>{d.id ? `Edit ${draft.name}` : 'New project'}</h2>
      <div className="row">
        <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} />
        <input style={{ width: 56 }} aria-label="Project icon" title="Optional emoji icon" placeholder="Icon" maxLength={16} value={d.icon ?? ''} onChange={(e) => set('icon', e.target.value)} />
        <input className="grow" placeholder="Project name" value={d.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      {!d.id && workspaces.length > 1 && (
        <label>
          Workspace
          <select value={d.workspaceId} onChange={(e) => set('workspaceId', e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Description
        <input value={d.description} placeholder="What belongs to this project? (helps the AI assign cards)" onChange={(e) => set('description', e.target.value)} />
      </label>
      <fieldset>
        <legend>Rules — a card matching any of these is assigned automatically</legend>
        <label>
          Apps (process names)
          <input value={rules.apps} placeholder="Code, idea64, EXCEL" onChange={(e) => setRules((r) => ({ ...r, apps: e.target.value }))} />
        </label>
        <label>
          Domains
          <input value={rules.domains} placeholder="erp.velesagro.pl, github.com/acme" onChange={(e) => setRules((r) => ({ ...r, domains: e.target.value }))} />
        </label>
        <label>
          Title keywords
          <input value={rules.titleKeywords} placeholder="Dayflow, invoice" onChange={(e) => setRules((r) => ({ ...r, titleKeywords: e.target.value }))} />
        </label>
        <label>
          Repositories
          <input value={rules.repos} placeholder="acme/dayflow" onChange={(e) => setRules((r) => ({ ...r, repos: e.target.value }))} />
        </label>
        <small>Comma-separated. Matched against window titles, the card's apps/sites, title and summary.</small>
      </fieldset>
      <label>
        Default share level for members
        <select value={d.defaultShare} onChange={(e) => set('defaultShare', e.target.value as ShareLevel)}>
          {(Object.keys(SHARE_LABELS) as ShareLevel[]).map((s) => (
            <option key={s} value={s}>
              {SHARE_LABELS[s]}
            </option>
          ))}
        </select>
        <small>Each member can override this for themselves.</small>
      </label>
      <fieldset>
        <legend>Odoo timesheets</legend>
        <div className="grid2">
          <label>
            Project id
            <input inputMode="numeric" value={d.odoo.projectId ?? ''} onChange={(e) => setOdoo('projectId', e.target.value.replace(/\D/g, ''))} />
          </label>
          <label>
            Project name
            <input value={d.odoo.projectName ?? ''} onChange={(e) => setOdoo('projectName', e.target.value)} />
          </label>
          <label>
            Task id
            <input inputMode="numeric" value={d.odoo.taskId ?? ''} onChange={(e) => setOdoo('taskId', e.target.value.replace(/\D/g, ''))} />
          </label>
          <label>
            Task name
            <input value={d.odoo.taskName ?? ''} onChange={(e) => setOdoo('taskName', e.target.value)} />
          </label>
        </div>
      </fieldset>
      {d.id && (
        <label className="check">
          <input type="checkbox" checked={!!d.archived} onChange={(e) => set('archived', e.target.checked)} />
          Archived (no new assignments)
        </label>
      )}
      {error && <div className="notice err">{error}</div>}
      <div className="row">
        <button className="btn" disabled={!d.name.trim()} onClick={() => void save()}>
          Save project
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---- Activity (feed + totals) ----

function ActivityPanel({ projects }: { projects: ProjectView[] }) {
  const active = projects.filter((p) => !p.archived)
  const [projectId, setProjectId] = useState<string>('')
  const [range, setRange] = useState<Range>('today')
  const today = currentDay()
  const [customFrom, setCustomFrom] = useState(shiftDay(today, -13))
  const [customTo, setCustomTo] = useState(today)
  const [feed, setFeed] = useState<ProjectEntry[] | null>(null)
  const [report, setReport] = useState<ProjectReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pid = projectId || active[0]?.id || ''
  const from =
    range === 'today' ? today : range === 'week' ? weekStart(today) : range === 'month' ? `${today.slice(0, 8)}01` : customFrom
  const to = range === 'custom' ? customTo : today
  const rangeError =
    !DAY_RE.test(from) || !DAY_RE.test(to)
      ? 'Pick both dates.'
      : from > to
        ? 'The start date is after the end date.'
        : shiftDay(from, MAX_RANGE_DAYS - 1) < to
          ? `Pick at most ${MAX_RANGE_DAYS} days.`
          : null

  useEffect(() => {
    if (!pid || rangeError) return
    let cancelled = false
    setError(null)
    setFeed(null)
    setReport(null)
    Promise.all([call<ProjectEntry[]>('sync:feed', pid, from, to), call<ProjectReport>('sync:report', pid, from, to)])
      .then(([f, r]) => {
        if (cancelled) return
        setFeed(f)
        setReport(r)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(ipcErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [pid, from, to, rangeError])

  if (!active.length) return <p className="team-body muted">No projects yet.</p>
  const byDay = new Map<string, ProjectEntry[]>()
  for (const e of feed ?? []) {
    const day = (e as ProjectEntry & { day?: string }).day ?? new Date(e.startTs * 1000).toISOString().slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), e])
  }
  return (
    <div className="team-body">
      <div className="row">
        <select value={pid} onChange={(e) => setProjectId(e.target.value)}>
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="seg small">
          <button className={range === 'today' ? 'active' : ''} onClick={() => setRange('today')}>
            Today
          </button>
          <button className={range === 'week' ? 'active' : ''} onClick={() => setRange('week')}>
            This week
          </button>
          <button className={range === 'month' ? 'active' : ''} onClick={() => setRange('month')}>
            This month
          </button>
          <button className={range === 'custom' ? 'active' : ''} onClick={() => setRange('custom')}>
            Custom
          </button>
        </div>
        {range === 'custom' && (
          <>
            <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
            <span className="muted">to</span>
            <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} />
          </>
        )}
      </div>
      {rangeError && <div className="notice err">{rangeError}</div>}
      {error && <div className="notice err">{error}</div>}
      {report && (
        <section className="panel">
          <h2>{hm(report.totalMinutes)} in total</h2>
          <div className="totals-grid">
            {report.byMember.map((m) => (
              <div key={m.userId} className="total-row">
                <span>{m.userName}</span>
                <span className="bar">
                  <span style={{ width: `${report.totalMinutes ? (m.minutes / report.totalMinutes) * 100 : 0}%` }} />
                </span>
                <b>{hm(m.minutes)}</b>
              </div>
            ))}
          </div>
          {from !== to && report.byMember.length > 0 && <MemberDayGrid report={report} from={from} to={to} />}
          {(report.byCategory?.length ?? 0) > 0 && (
            <>
              <h3 className="sub">By category</h3>
              <div className="totals-grid">
                {report.byCategory!.map((c) => (
                  <div key={c.category} className="total-row">
                    <span className={c.category.startsWith('(') ? 'muted' : ''}>{c.category}</span>
                    <span className="bar">
                      <span style={{ width: `${report.totalMinutes ? (c.minutes / report.totalMinutes) * 100 : 0}%` }} />
                    </span>
                    <b>{hm(c.minutes)}</b>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      {feed && feed.length === 0 && <p className="muted">Nothing shared on this project yet.</p>}
      {[...byDay.entries()].map(([day, entries]) => (
        <section key={day} className="panel feed">
          <h3 className="sub">{day}</h3>
          {entries.map((e) => (
            <div key={`${e.cardId}:${e.userId}`} className="feed-row">
              <span className="feed-time">
                {clock(e.startTs)} – {clock(e.endTs)}
              </span>
              <span className="feed-user">{e.userName}</span>
              <span className="feed-text">
                {e.title ? <b>{e.title}</b> : <span className="muted">{hm(e.minutes)} of work</span>}
                {e.summary && <div className="muted">{e.summary}</div>}
                {e.detailed && <div className="detailed">{detailLines(e.detailed).map((line, i) => <div key={i}>{line.start ? <><strong>{line.start}–{line.end}</strong>: {line.text}</> : line.text}</div>)}</div>}
              </span>
              <span className="feed-min">{hm(e.minutes)}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

// ---- Timesheets ----

interface Line extends TimesheetProposal {
  include: boolean
}

function TimesheetsPanel({ status, projects }: { status: SyncStatus; projects: ProjectView[] }) {
  const today = currentDay()
  const [from, setFrom] = useState(weekStart(today))
  const [to, setTo] = useState(today)
  const [workspaceId, setWorkspaceId] = useState(status.workspaces[0]?.id ?? '')
  const [view, setView] = useState<TimesheetProposalsView | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TimesheetSubmitResult | null>(null)
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  const load = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const v = await call<TimesheetProposalsView>('sync:timesheetProposals', from, to, workspaceId)
      setView(v)
      setLines(v.proposals.map((p) => ({ ...p, include: p.hours > 0 })))
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const patch = (i: number, p: Partial<Line>) => setLines((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const chosen = lines.filter((l) => l.include && l.hours > 0)
  const total = chosen.reduce((s, l) => s + l.hours, 0)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await call<TimesheetSubmitResult | null>('sync:timesheetSubmit', {
        lines: chosen.map((l) => ({ day: l.day, projectId: l.projectId, hours: l.hours, description: l.description, cardIds: l.cardIds })),
      })
      if (r) {
        setResult(r)
        await load()
      }
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="team-body">
      <p className="muted">
        Proposed from your confirmed project time, rounded to 15 minutes. Review and edit, then submit — nothing is written
        to Odoo until you confirm.
      </p>
      <div className="row wrap">
        {status.workspaces.length > 1 && (
          <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {status.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <span>–</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        <button className="btn ghost" disabled={busy || !workspaceId} onClick={() => void load()}>
          {busy ? 'Loading…' : 'Load proposals'}
        </button>
      </div>
      {error && <div className="notice err">{error}</div>}
      {view && !view.odooConfigured && <div className="notice warn">Odoo is not configured for this workspace yet — ask an admin.</div>}
      {view && view.odooConfigured && !view.employeeMapped && (
        <div className="notice warn">Your account is not mapped to an Odoo employee yet — ask an admin.</div>
      )}
      {view && lines.length === 0 && <p className="muted">No confirmed project time in this range.</p>}
      {lines.length > 0 && (
        <section className="panel wide">
          <table className="sync-table timesheet">
            <thead>
              <tr>
                <th />
                <th>Day</th>
                <th>Project → Odoo</th>
                <th>Hours</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const p = byId.get(l.projectId)
                return (
                  <tr key={`${l.day}:${l.projectId}`} className={l.include ? '' : 'excluded'}>
                    <td>
                      <input type="checkbox" checked={l.include} onChange={(e) => patch(i, { include: e.target.checked })} />
                    </td>
                    <td className="nowrap">{l.day}</td>
                    <td>
                      <span className="swatch" style={{ background: p?.color ?? '#ccc' }} /> {p?.name ?? l.projectId}
                      <div className="muted small">
                        {l.odooProjectId ? `${p?.odoo.projectName ?? 'project'} #${l.odooProjectId}` : 'no Odoo project mapped'}
                        {l.odooTaskId ? ` / ${p?.odoo.taskName ?? 'task'} #${l.odooTaskId}` : ''}
                        {l.existingOdooLineId ? ` · updates line #${l.existingOdooLineId}` : ''}
                      </div>
                    </td>
                    <td>
                      <input
                        className="hours"
                        type="number"
                        min={0}
                        max={24}
                        step={0.25}
                        value={l.hours}
                        onChange={(e) => patch(i, { hours: Math.max(0, Math.min(24, Number(e.target.value) || 0)) })}
                      />
                    </td>
                    <td>
                      <textarea rows={2} value={l.description} onChange={(e) => patch(i, { description: e.target.value })} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="row end">
            <span className="muted">
              {chosen.length} line{chosen.length === 1 ? '' : 's'} · {total.toFixed(2)} h
            </span>
            <button className="btn" disabled={busy || chosen.length === 0 || (view?.odooConfigured === false)} onClick={() => void submit()}>
              Submit to Odoo…
            </button>
          </div>
        </section>
      )}
      {result && (
        <div className={result.failed.length ? 'notice err' : 'notice ok'}>
          {result.sent.length} line{result.sent.length === 1 ? '' : 's'} written to Odoo
          {result.sent.some((s) => s.updated) ? ` (${result.sent.filter((s) => s.updated).length} updated)` : ''}.
          {result.failed.map((f) => (
            <div key={`${f.day}:${f.projectId}`}>
              {f.day} {byId.get(f.projectId)?.name ?? f.projectId}: {f.error}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
