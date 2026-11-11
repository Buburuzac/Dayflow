// Team report (workspace admins): every member's confirmed project time and each person's
// contribution to each project. Built from the team projection only — private cards, unconfirmed
// guesses and work outside projects are never in it.

import { useMemo, useState } from 'react'
import { api } from '../api/client.ts'
import type { WorkspaceReport } from '../api/types.ts'
import { canViewTimeline, useApp } from '../app-context.ts'
import { ChartCard, DayBars, HeatGrid, mix, ShareBar } from '../components/charts.tsx'
import { initialRange, RangePicker, type RangeValue } from '../components/RangePicker.tsx'
import { Avatar, Empty, ErrorBox, Loading, personColor } from '../components/ui.tsx'
import { daysInRange } from '../lib/dates.ts'
import { fmtMinutes, relativeTime } from '../lib/format.ts'
import { navigate, useAsync } from '../lib/hooks.ts'
import { contributionsByProject, downloadText, fmtPct, minutesByUserProject, reportCsv } from '../lib/report.ts'

const ACCENT = '#F3854B'

export function Team() {
  const { workspace, isAdmin } = useApp()
  const [range, setRange] = useState<RangeValue>(() => initialRange('week'))
  const { from, to } = range.range
  const rep = useAsync(() => (workspace && isAdmin ? api.workspaceReport(workspace.id, from, to) : Promise.resolve(null)), [workspace?.id, isAdmin, from, to])

  if (!workspace) return <Empty title="No workspace yet">Ask a workspace owner to invite you.</Empty>
  if (!isAdmin) return <Empty title="Admins only">The team report is available to workspace admins and owners. Project reports are under Projects.</Empty>

  return (
    <div className="page scroll">
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <div className="muted">{workspace.name} · confirmed project time of every member</div>
        </div>
        <button className="btn ghost" disabled={!rep.data} onClick={() => rep.data && downloadText(`dayflow-team-${from}_${to}.csv`, reportCsv(rep.data))}>
          Export CSV
        </button>
      </div>
      <div className="toolbar">
        <RangePicker value={range} onChange={setRange} />
      </div>
      {rep.error ? <ErrorBox error={rep.error} onRetry={rep.reload} /> : !rep.data ? <Loading /> : <TeamReport rep={rep.data} />}
      <p className="muted small team-note">
        Only work people confirmed for a project counts, at the level each person shares. Private cards, unconfirmed AI guesses and time outside projects are not included.
      </p>
    </div>
  )
}

function TeamReport({ rep }: { rep: WorkspaceReport }) {
  const { workspace } = useApp()
  const canOpen = (role: string) => canViewTimeline(workspace?.role, role)
  const days = daysInRange(rep.from, rep.to)
  const byUser = useMemo(() => minutesByUserProject(rep), [rep])
  const contrib = useMemo(() => contributionsByProject(rep), [rep])
  const projects = useMemo(() => new Map(rep.projects.map((p) => [p.projectId, p])), [rep])
  const cells = useMemo(() => new Map(rep.byUserDay.map((c) => [`${c.userId}|${c.day}`, c.minutes])), [rep])
  const byDay = new Map(rep.byDay.map((d) => [d.day, d.minutes]))
  const active = rep.users.filter((u) => u.minutes > 0)
  const personDays = active.reduce((s, u) => s + u.activeDays, 0)

  return (
    <div className="report">
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-v serif">{fmtMinutes(rep.totalMinutes)}</span>
          <span className="muted">project time</span>
        </div>
        <div className="kpi">
          <span className="kpi-v serif">
            {active.length}
            <span className="kpi-of"> / {rep.users.length}</span>
          </span>
          <span className="muted">people with time</span>
        </div>
        <div className="kpi">
          <span className="kpi-v serif">{rep.projects.length}</span>
          <span className="muted">{rep.projects.length === 1 ? 'project' : 'projects'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-v serif">{personDays ? fmtMinutes(rep.totalMinutes / personDays) : '—'}</span>
          <span className="muted">per person-day</span>
        </div>
      </div>

      <div className="report-grid">
        <ChartCard title="People" className="span-2">
          <div className="table-wrap">
            <table className="table team-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">Total</th>
                  <th className="bar-col">Projects</th>
                  <th className="num">Days</th>
                  <th className="num">Per day</th>
                  <th className="num" title="Timesheet hours sent to Odoo for days in this period">In Odoo</th>
                  <th title="Last time one of the person's devices synced">Last sync</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rep.users.map((u) => {
                  const parts = [...(byUser.get(u.userId) ?? new Map<string, number>())]
                    .sort((a, b) => b[1] - a[1])
                    .map(([pid, m]) => {
                      const p = projects.get(pid)
                      return { key: pid, color: p?.color || ACCENT, value: m, label: `${p?.name ?? '?'}: ${fmtMinutes(m)} (${fmtPct(m / (u.minutes || 1))})` }
                    })
                  return (
                    <tr key={u.userId} className={u.minutes ? '' : 'idle'}>
                      <td>
                        <div className="who">
                          <Avatar name={u.userName} url={u.avatarUrl} size={26} />
                          <div className="who-text">
                            {canOpen(u.role) ? (
                              <button className="link-btn person-link" onClick={() => navigate(`/users/${u.userId}`)} title="Open timeline">
                                {u.userName}
                              </button>
                            ) : (
                              <b>{u.userName}</b>
                            )}
                            <span className="muted small">
                              {u.email} · {u.role}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="num strong">{u.minutes ? fmtMinutes(u.minutes) : '—'}</td>
                      <td className="bar-col">
                        {parts.length ? (
                          <>
                            <ShareBar parts={parts} />
                            <div className="bar-legend muted small">
                              {parts.slice(0, 3).map((p) => (
                                <span key={p.key}>
                                  <i style={{ background: p.color }} />
                                  {projects.get(p.key)?.name} {fmtPct(p.value / (u.minutes || 1))}
                                </span>
                              ))}
                              {parts.length > 3 && <span>+{parts.length - 3}</span>}
                            </div>
                          </>
                        ) : (
                          <span className="muted small">No confirmed project time</span>
                        )}
                      </td>
                      <td className="num">{u.activeDays || '—'}</td>
                      <td className="num">{u.activeDays ? fmtMinutes(u.minutes / u.activeDays) : '—'}</td>
                      <td className="num">{u.odooHours ? `${u.odooHours} h` : '—'}</td>
                      <td className="muted small nowrap">{relativeTime(u.lastSeenAt)}</td>
                      <td>
                        <button className="btn ghost small" disabled={!canOpen(u.role)} title={canOpen(u.role) ? undefined : 'Only an owner can open an owner’s timeline'} onClick={() => navigate(`/users/${u.userId}`)}>
                          Timeline
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>

        {rep.totalMinutes > 0 && (
          <>
            <ChartCard title="Projects · who contributed" className="span-2">
              <div className="table-wrap">
                <table className="table team-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className="num">Total</th>
                      <th className="num">Of all</th>
                      <th className="bar-col">Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rep.projects.map((p) => {
                      const list = contrib.get(p.projectId) ?? []
                      return (
                        <tr key={p.projectId}>
                          <td>
                            <button className="link-btn project-link" style={{ ['--pc' as string]: p.color || ACCENT }} onClick={() => navigate(`/projects/${p.projectId}/report`)}>
                              <i className="ph-dot" />
                              {p.name}
                            </button>
                            {p.archived && <span className="badge">Archived</span>}
                          </td>
                          <td className="num strong">{fmtMinutes(p.minutes)}</td>
                          <td className="num">{fmtPct(p.minutes / rep.totalMinutes)}</td>
                          <td className="bar-col">
                            <ShareBar parts={list.map((c) => ({ key: c.userId, color: personColor(c.userName), value: c.minutes, label: `${c.userName}: ${fmtMinutes(c.minutes)} (${fmtPct(c.pct)})` }))} />
                            <div className="bar-legend muted small">
                              {list.map((c) => (
                                <span key={c.userId} title={fmtMinutes(c.minutes)}>
                                  <i style={{ background: personColor(c.userName) }} />
                                  {c.userName} {fmtPct(c.pct)}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            <ChartCard title="Person × project" className="span-2" extra={<span className="muted chart-note">hours · share of the project</span>}>
              <Matrix rep={rep} byUser={byUser} />
            </ChartCard>

            <ChartCard title="By day">
              <DayBars days={days.map((d) => ({ day: d, minutes: byDay.get(d) ?? 0 }))} color={ACCENT} />
            </ChartCard>
            <ChartCard title="Person × day" extra={<span className="muted chart-note">hours</span>}>
              <HeatGrid members={active.map((u) => ({ id: u.userId, name: u.userName }))} days={days} value={(u, d) => cells.get(`${u}|${d}`) ?? 0} color={ACCENT} />
            </ChartCard>
          </>
        )}
      </div>
    </div>
  )
}

/** People (rows) × projects (columns): hours and the person's share of each project. */
function Matrix({ rep, byUser }: { rep: WorkspaceReport; byUser: Map<string, Map<string, number>> }) {
  const { workspace } = useApp()
  const canOpen = (role: string) => canViewTimeline(workspace?.role, role)
  const people = rep.users.filter((u) => u.minutes > 0)
  const max = Math.max(1, ...rep.byUserProject.map((c) => c.minutes))
  return (
    <div className="table-wrap">
      <table className="table matrix">
        <thead>
          <tr>
            <th />
            {rep.projects.map((p) => (
              <th key={p.projectId} title={p.name}>
                <span className="mx-head" style={{ ['--pc' as string]: p.color || ACCENT }}>
                  <i className="ph-dot" />
                  {p.name}
                </span>
              </th>
            ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {people.map((u) => (
            <tr key={u.userId}>
              <th className="mx-person">
                {canOpen(u.role) ? (
                  <button className="link-btn person-link" onClick={() => navigate(`/users/${u.userId}`)}>
                    {u.userName}
                  </button>
                ) : (
                  u.userName
                )}
              </th>
              {rep.projects.map((p) => {
                const m = byUser.get(u.userId)?.get(p.projectId) ?? 0
                const t = m > 0 ? 0.12 + 0.88 * Math.pow(m / max, 0.75) : 0
                return (
                  <td
                    key={p.projectId}
                    className="mx-cell"
                    style={m > 0 ? { background: mix('#FFF1E8', p.color || ACCENT, t), color: t > 0.55 ? '#fff' : undefined } : undefined}
                    title={m > 0 ? `${u.userName} · ${p.name}: ${fmtMinutes(m)}, ${fmtPct(m / p.minutes)} of the project` : undefined}
                  >
                    {m > 0 ? (
                      <>
                        <b>{(m / 60).toFixed(1)}</b>
                        <span>{fmtPct(m / p.minutes)}</span>
                      </>
                    ) : (
                      <span className="muted">·</span>
                    )}
                  </td>
                )
              })}
              <td className="num strong">{fmtMinutes(u.minutes)}</td>
            </tr>
          ))}
          <tr className="mx-total">
            <th className="mx-person">Total</th>
            {rep.projects.map((p) => (
              <td key={p.projectId} className="num strong">
                {fmtMinutes(p.minutes)}
              </td>
            ))}
            <td className="num strong">{fmtMinutes(rep.totalMinutes)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
