// A member's timeline for workspace admins: every synced card, one lane per device, cut by the
// server to what the member shares (project cards at their share level, everything else time only).

import { api } from '../api/client.ts'
import type { DeviceInfo } from '../api/types.ts'
import { canViewTimeline, useApp } from '../app-context.ts'
import { Avatar, Empty } from '../components/ui.tsx'
import { relativeTime } from '../lib/format.ts'
import { navigate, useAsync } from '../lib/hooks.ts'
import { DeviceIcon, TimelineView } from './MyTime.tsx'

export function MemberTimeline({ userId, device }: { userId: string; device?: string | null }) {
  const { workspace, isAdmin, me } = useApp()
  const members = useAsync(() => (workspace && isAdmin ? api.members(workspace.id) : Promise.resolve([])), [workspace?.id, isAdmin])
  if (!workspace) return <Empty title="No workspace yet">Ask a workspace owner to invite you.</Empty>
  if (!isAdmin) return <Empty title="Admins only">Member timelines are available to workspace admins and owners.</Empty>
  const wsId = workspace.id
  const list = (members.data ?? []).filter((m) => m.userId === userId || canViewTimeline(workspace.role, m.role))
  const person = list.find((m) => m.userId === userId)

  return (
    <TimelineView
      key={device ?? ''}
      initialDevice={device ?? undefined}
      deps={[wsId, userId]}
      load={async (from, to) => {
        const r = await api.memberTimeline(wsId, userId, from, to)
        return { cards: r.cards, devices: r.devices, categories: r.categories }
      }}
      emptyText={(mode) => `Nothing synced from this person's devices for this ${mode}.`}
      head={(data) => (
        <div className="member-head">
          <button className="link-btn back" onClick={() => navigate('/users')}>
            ‹ Users
          </button>
          <div className="row between wrap">
            <div className="who">
              <Avatar name={person?.name || person?.email || '?'} url={person?.avatarUrl} size={34} />
              <div className="who-text">
                <h1 className="member-name">{person ? person.name || person.email : members.loading ? '…' : 'Member'}</h1>
                {person && (
                  <span className="muted small">
                    {person.email} · {person.role}
                    {person.userId === me.user.id ? ' · you' : ''}
                  </span>
                )}
              </div>
            </div>
            {list.length > 1 && (
              <select className="member-select" value={userId} onChange={(e) => navigate(`/users/${e.target.value}`)} aria-label="Person">
                {list.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
            )}
          </div>
          <DeviceList devices={data?.devices ?? []} />
          <div className="muted small">
            Work confirmed for this workspace&rsquo;s projects is shown at the level the person shares; everything else is shown as time only. Personal and private cards never leave their computers, and work for other workspaces is not shown. The person sees on their Account page that you opened their timeline.
          </div>
        </div>
      )}
    />
  )
}

/** The member's devices with their last sync. */
function DeviceList({ devices }: { devices: DeviceInfo[] }) {
  if (!devices.length) return null
  return (
    <div className="device-list">
      {devices.map((d) => (
        <span key={d.id} className={`device-chip ${d.revoked ? 'revoked' : ''}`} title={d.revoked ? 'Revoked' : undefined}>
          <DeviceIcon platform={d.platform} />
          {d.name}
          <span className="muted">· {d.revoked ? 'revoked' : `synced ${relativeTime(d.lastSeenAt)}`}</span>
        </span>
      ))}
    </div>
  )
}
