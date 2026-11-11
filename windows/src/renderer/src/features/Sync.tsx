import { useCallback, useEffect, useState } from 'react'
import type { DeviceInfo } from '../../../shared/sync-types.ts'
import type { AuthConfigStatus, MeView, ProjectView, SyncStatus } from '../../../shared/sync-ui.ts'
import { ipcErrorMessage } from '../Settings.tsx'
import './sync.css'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

export function useSyncStatus(): [SyncStatus | null, () => void] {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const refresh = useCallback(() => void call<SyncStatus>('sync:status').then(setStatus), [])
  useEffect(() => {
    refresh()
    return window.dayflow.on('sync:status', (s) => setStatus(s as SyncStatus))
  }, [refresh])
  return [status, refresh]
}

export function useProjects(): ProjectView[] {
  const [projects, setProjects] = useState<ProjectView[]>([])
  useEffect(() => {
    const load = () => void call<ProjectView[]>('projects:list').then(setProjects)
    load()
    return window.dayflow.on('projects:changed', load)
  }, [])
  return projects
}

export function ago(ms: number | null): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}

/** Settings → Sync & team */
export function SyncSettingsPanel() {
  const [status, refresh] = useSyncStatus()
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<AuthConfigStatus | null>(null)
  const [me, setMe] = useState<MeView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [devEmail, setDevEmail] = useState('')

  useEffect(() => {
    if (status && !url) setUrl(status.serverUrl)
  }, [status, url])

  const checkServer = useCallback(() => {
    setAuth(null)
    void call<AuthConfigStatus>('sync:authConfig').then(setAuth)
  }, [])

  useEffect(() => {
    if (!status) return
    if (status.signedIn) void call<MeView>('sync:me').then(setMe, () => setMe(null))
    else {
      setMe(null)
      checkServer()
    }
  }, [status?.signedIn, status?.serverUrl, checkServer]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(null)
      refresh()
    }
  }

  if (!status) return null

  const saveUrl = () =>
    run('url', async () => {
      await call('sync:setServerUrl', url)
      checkServer()
    })

  return (
    <div className="form sync-panel">
      <p className="muted">
        Sync your timeline between your computers and share project time with your team through a Dayflow Sync Server.
        Screenshots, the accessibility log and chat never leave this PC; cards marked private or in a never-upload category never leave it either.
      </p>
      <label>
        Server
        <div className="row">
          <input value={url} disabled={status.signedIn} onChange={(e) => setUrl(e.target.value)} />
          {!status.signedIn && url !== status.serverUrl && (
            <button className="btn ghost" onClick={() => void saveUrl()}>
              Save
            </button>
          )}
        </div>
      </label>

      {!status.signedIn ? (
        <>
          {!auth && <p className="muted">Checking the server…</p>}
          {auth && !auth.reachable && (
            <div className="notice err">
              Can't reach the server: {auth.error}{' '}
              <button className="link-btn" onClick={checkServer}>
                Retry
              </button>
            </div>
          )}
          {auth?.reachable && !auth.googleConfigured && (
            <div className="notice warn">
              Google sign-in isn't set up on this server yet (no OAuth client configured). Ask the server admin to set
              GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
            </div>
          )}
          <div className="row">
            <button
              className="btn"
              disabled={!auth?.googleConfigured || !!busy}
              onClick={() => void run('google', () => call('sync:signInGoogle'))}
            >
              {busy === 'google' ? 'Waiting for the browser…' : 'Sign in with Google'}
            </button>
            {busy === 'google' && (
              <button className="btn ghost" onClick={() => void call('sync:cancelSignIn')}>
                Cancel
              </button>
            )}
          </div>
          {auth?.devAuth && (
            <div className="row">
              <input placeholder="email for dev sign-in" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} />
              <button className="btn ghost" disabled={!!busy || !devEmail} onClick={() => void run('dev', () => call('sync:signInDev', devEmail))}>
                Dev sign-in
              </button>
              <small>Test servers only (DEV_AUTH=1).</small>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="sync-account">
            <div>
              <b>{status.user?.name || status.user?.email}</b>
              <div className="muted">{status.user?.email}</div>
            </div>
            <div className="row">
              <button className="btn ghost" disabled={!!busy} onClick={() => void run('dash', () => call('sync:openDashboard'))}>
                Open web dashboard
              </button>
              <button className="btn ghost" disabled={!!busy} onClick={() => void run('out', () => call('sync:signOut'))}>
                Sign out
              </button>
            </div>
          </div>
          <SyncStatusLine status={status} onSync={() => void run('sync', () => call('sync:syncNow'))} busy={busy === 'sync'} />
          {(me?.workspaces ?? status.workspaces).length > 0 && (
            <div>
              <h3 className="sub">Workspaces</h3>
              <div className="chips">
                {(me?.workspaces ?? status.workspaces).map((w) => (
                  <span key={w.id} className="site-chip">
                    {w.name} <span className="muted">· {w.role}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {me && (
            <DeviceList
              devices={me.devices}
              onRevoke={(d) => {
                if (!confirm(`Sign out "${d.name}"? It stops syncing until it signs in again.`)) return
                void run('revoke', async () => setMe(await call<MeView>('sync:revokeDevice', d.id)))
              }}
            />
          )}
        </>
      )}
      {error && <div className="notice err">{error}</div>}
    </div>
  )
}

export function SyncStatusLine({ status, onSync, busy }: { status: SyncStatus; onSync: () => void; busy: boolean }) {
  return (
    <div className="sync-status">
      <span className={`sync-dot ${status.lastError ? 'err' : status.syncing ? 'busy' : 'ok'}`} />
      <span>
        {status.syncing ? 'Syncing…' : `Last sync ${ago(status.lastSyncAt)}`}
        {' · '}
        {status.pending} pending change{status.pending === 1 ? '' : 's'}
        {' · '}
        {status.streamConnected ? 'live' : 'polling'}
      </span>
      <button className="link-btn" disabled={busy || status.syncing} onClick={onSync}>
        Sync now
      </button>
      {status.lastError && <div className="notice err sync-error">{status.lastError}</div>}
    </div>
  )
}

function DeviceList({ devices, onRevoke }: { devices: DeviceInfo[]; onRevoke: (d: DeviceInfo) => void }) {
  return (
    <div>
      <h3 className="sub">Devices</h3>
      <table className="sync-table">
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className={d.revoked ? 'revoked' : ''}>
              <td>
                <b>{d.name}</b> {d.current && <span className="badge">this PC</span>}
              </td>
              <td className="muted">{d.platform}</td>
              <td className="muted">{d.revoked ? 'signed out' : d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : ''}</td>
              <td className="right">
                {!d.revoked && (
                  <button className="link-btn danger" onClick={() => onRevoke(d)}>
                    {d.current ? 'Sign out' : 'Revoke'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
