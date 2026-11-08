import { useState } from 'react'
import { api, errorText } from '../api/client.ts'
import { DayflowMark, ErrorBox, Loading } from '../components/ui.tsx'
import { useAsync } from '../lib/hooks.ts'

/** /invite/<token> (the server's SPA fallback serves index.html there). */
export function InvitePage({ token, email, onDone }: { token: string; email: string; onDone: (workspaceId?: string) => void }) {
  const inv = useAsync(() => api.invite(token), [token])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const d = inv.data
  const wrongEmail = d && d.email.toLowerCase() !== email.toLowerCase()
  return (
    <div className="center-page">
      <div className="onb-card">
        <div className="logo-row">
          <DayflowMark size={28} />
          <span className="logo">Dayflow</span>
        </div>
        {inv.error ? (
          <>
            <h1>Invite not available</h1>
            <ErrorBox error={inv.error} />
          </>
        ) : !d ? (
          <Loading />
        ) : (
          <>
            <h1>Join {d.workspaceName}</h1>
            <p>
              You were invited as <b>{d.role}</b> ({d.email}).
            </p>
            {d.accepted && <div className="notice ok">This invite was already accepted.</div>}
            {wrongEmail && (
              <div className="notice warn">
                You are signed in as {email}. This invite is for {d.email}; sign in with that Google account in the Dayflow app.
              </div>
            )}
            {err && <div className="notice err">{err}</div>}
            <div className="row end-row">
              <button className="btn ghost" onClick={() => onDone()}>
                {d.accepted ? 'Open dashboard' : 'Not now'}
              </button>
              {!d.accepted && (
                <button
                  className="btn"
                  disabled={busy || !!wrongEmail}
                  onClick={() => {
                    setBusy(true)
                    setErr(null)
                    api.acceptInvite(token).then(
                      (r) => onDone(r.workspaceId),
                      (e) => {
                        setErr(errorText(e))
                        setBusy(false)
                      },
                    )
                  }}
                >
                  Accept invite
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
