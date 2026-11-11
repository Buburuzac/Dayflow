import { useState } from 'react'
import { api, errorText } from '../api/client.ts'
import type { DeviceInfo } from '../api/types.ts'
import { useApp } from '../app-context.ts'
import { Avatar, Modal } from '../components/ui.tsx'
import { relativeTime } from '../lib/format.ts'
import { useAsync } from '../lib/hooks.ts'
import { DeviceIcon } from './MyTime.tsx'

export function Account({ onSignedOut, onChanged }: { onSignedOut: () => void; onChanged: () => void }) {
  const { me } = useApp()
  const [revoking, setRevoking] = useState<DeviceInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const devices = [...me.devices].sort((a, b) => Number(a.revoked) - Number(b.revoked) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))

  return (
    <div className="page scroll">
      <div className="page-head">
        <h1>Account</h1>
      </div>
      <section className="panel profile">
        <Avatar name={me.user.name || me.user.email} url={me.user.avatarUrl} size={56} />
        <div>
          <div className="profile-name serif">{me.user.name || me.user.email}</div>
          <div className="muted">{me.user.email}</div>
          <div className="chip-row">
            {me.workspaces.map((w) => (
              <span key={w.id} className="badge">
                {w.name} · {w.role}
              </span>
            ))}
          </div>
        </div>
      </section>

      <TimelineViews />

      <section className="panel">
        <h2>Devices</h2>
        <p className="muted small">Every computer signed in to sync. Revoking a device signs it out; its cards already synced stay.</p>
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Platform</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className={d.revoked ? 'revoked' : ''}>
                <td>
                  <span className="row">
                    <DeviceIcon platform={d.platform} />
                    {d.name}
                    {d.current && <span className="badge">This session</span>}
                  </span>
                </td>
                <td className="muted">{d.platform}</td>
                <td className="muted">{d.revoked ? 'Revoked' : relativeTime(d.lastSeenAt)}</td>
                <td className="right">
                  {!d.revoked && (
                    <button className="link-btn danger" onClick={() => setRevoking(d)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {err && <div className="notice err">{err}</div>}
      </section>

      <section className="panel">
        <h2>Sign out</h2>
        <div className="row between">
          <span className="muted">Ends this browser session. To come back, open the dashboard from the Dayflow app again.</span>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              api
                .logout()
                .catch(() => undefined)
                .finally(onSignedOut)
            }}
          >
            Sign out
          </button>
        </div>
      </section>

      {revoking && (
        <Modal
          title="Revoke device?"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRevoking(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const d = revoking
                  setRevoking(null)
                  setErr(null)
                  api.revokeDevice(d.id).then(onChanged, (e) => setErr(errorText(e)))
                }}
              >
                Revoke
              </button>
            </>
          }
        >
          <p>
            <b>{revoking.name}</b> stops syncing immediately and has to sign in with Google again.
          </p>
        </Modal>
      )}
    </div>
  )
}

/** Who opened the caller's timeline (workspace admins and owners). */
function TimelineViews() {
  const views = useAsync(() => api.timelineViews(), [])
  if (!views.data?.length) return null
  return (
    <section className="panel">
      <h2>Who viewed your timeline</h2>
      <p className="muted small">
        Workspace admins and owners can open your timeline: project work at the level you share, everything else as time only. Personal and private cards never leave your computers.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Who</th>
            <th>Workspace</th>
            <th>Period</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {views.data.map((v, i) => (
            <tr key={i}>
              <td>
                {v.viewerName} <span className="muted small">{v.viewerEmail}</span>
              </td>
              <td className="muted">{v.workspaceName}</td>
              <td className="muted nowrap">{v.from === v.to ? v.from : `${v.from} – ${v.to}`}</td>
              <td className="muted nowrap">{relativeTime(v.viewedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
