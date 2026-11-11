// Users (workspace admins): every member with their computers and time for the period; a click opens
// the person's timeline (all machines or one).

import { useState } from 'react'
import { api } from '../api/client.ts'
import { canViewTimeline, useApp } from '../app-context.ts'
import { initialRange, RangePicker, type RangeValue } from '../components/RangePicker.tsx'
import { Avatar, Empty, ErrorBox, Loading } from '../components/ui.tsx'
import { fmtMinutes, relativeTime } from '../lib/format.ts'
import { navigate, useAsync } from '../lib/hooks.ts'
import { DeviceIcon } from './MyTime.tsx'

const OWNER_ONLY = 'Only an owner can see an owner’s own time and timeline'

export function Users() {
  const { workspace, isAdmin, me } = useApp()
  const [range, setRange] = useState<RangeValue>(() => initialRange('week'))
  const { from, to } = range.range
  const res = useAsync(() => (workspace && isAdmin ? api.workspaceUsers(workspace.id, from, to) : Promise.resolve(null)), [workspace?.id, isAdmin, from, to])
  const [q, setQ] = useState('')

  if (!workspace) return <Empty title="No workspace yet">Ask a workspace owner to invite you.</Empty>
  if (!isAdmin) return <Empty title="Admins only">The users list is available to workspace admins and owners.</Empty>

  const needle = q.trim().toLowerCase()
  const users = (res.data?.users ?? []).filter((u) => !needle || u.userName.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))

  return (
    <div className="page scroll">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="muted">{workspace.name} · people, their computers and timelines</div>
        </div>
        <input className="user-search" type="search" placeholder="Search name or e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="toolbar">
        <RangePicker value={range} onChange={setRange} />
      </div>
      {res.error ? (
        <ErrorBox error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading />
      ) : !users.length ? (
        <Empty title="Nobody found" />
      ) : (
        <div className="chart-card">
          <div className="table-wrap">
            <table className="table team-table users-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num" title="All synced time: project work and time-only “Out of scope” blocks">Tracked</th>
                  <th className="num" title="Confirmed project time (what goes to project reports)">Projects</th>
                  <th className="num">Days</th>
                  <th>Computers · time in period · last sync</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const open = canViewTimeline(workspace.role, u.role) && !u.restricted
                  const tracked = u.trackedMinutes ?? 0
                  return (
                  <tr key={u.userId} className={u.restricted || tracked ? '' : 'idle'}>
                    <td>
                      <div className="who">
                        <Avatar name={u.userName} url={u.avatarUrl} size={28} />
                        <div className="who-text">
                          {open ? (
                            <button className="link-btn person-link" onClick={() => navigate(`/users/${u.userId}`)}>
                              {u.userName}
                            </button>
                          ) : (
                            <b>{u.userName}</b>
                          )}
                          <span className="muted small">
                            {u.email} · {u.role}
                            {u.userId === me.user.id ? ' · you' : ''}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="num strong" title={u.restricted ? OWNER_ONLY : undefined}>
                      {u.restricted ? <span className="muted">hidden</span> : tracked ? fmtMinutes(tracked) : '—'}
                    </td>
                    <td className="num">
                      {u.projectMinutes ? fmtMinutes(u.projectMinutes) : '—'}
                      {tracked > 0 && u.projectMinutes > 0 && <div className="muted small">{Math.round((u.projectMinutes / tracked) * 100)}%</div>}
                    </td>
                    <td className="num">{u.activeDays || '—'}</td>
                    <td>
                      {u.devices.length ? (
                        <div className="device-list">
                          {u.devices.map((d) => (
                            <button
                              key={d.id}
                              className={`device-chip ${open ? 'clickable' : ''} ${d.revoked ? 'revoked' : ''}`}
                              disabled={!open}
                              onClick={() => navigate(`/users/${u.userId}?device=${d.id}`)}
                              title={open ? `Open the timeline of ${d.name}${d.revoked ? ' (revoked)' : ''}` : OWNER_ONLY}
                            >
                              <DeviceIcon platform={d.platform} />
                              {d.name}
                              <span className="muted">
                                {d.minutes != null && ` · ${d.minutes ? fmtMinutes(d.minutes) : '—'}`} · {d.revoked ? 'revoked' : relativeTime(d.lastSeenAt)}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="muted small">No computer connected yet</span>
                      )}
                    </td>
                    <td>
                      <button className="btn ghost small" disabled={!open} title={open ? undefined : OWNER_ONLY} onClick={() => navigate(`/users/${u.userId}`)}>
                        Timeline
                      </button>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="muted small team-note">
        Tracked time is everything a person&rsquo;s computers synced for this workspace: project work and time-only &ldquo;Out of scope&rdquo; blocks. Personal and private cards never leave their computers; work confirmed for other workspaces is not counted. Two computers recording at the same time both count. People see on their Account page who opened their timeline.
      </p>
    </div>
  )
}
