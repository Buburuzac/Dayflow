import { useEffect, useState } from 'react'
import { api, errorText } from '../api/client.ts'
import type { EmployeeMapEntry, Member, OdooConnection, OdooTestResult } from '../api/types.ts'
import { useApp } from '../app-context.ts'
import { Avatar, Empty, ErrorBox, Loading } from '../components/ui.tsx'
import { useAsync } from '../lib/hooks.ts'

export function WorkspaceSettings() {
  const { workspace, isAdmin } = useApp()
  const wid = workspace?.id ?? ''
  const data = useAsync(async () => {
    const [odoo, members] = await Promise.all([api.odoo(wid), api.members(wid)])
    return { odoo, members }
  }, [wid])
  if (!workspace) return <Empty title="No workspace" />
  if (!isAdmin) return <Empty title="Admins only">Only workspace owners and admins can change workspace settings.</Empty>
  return (
    <div className="page scroll">
      <div className="page-head">
        <div>
          <h1>Workspace settings</h1>
          <div className="muted">{workspace.name}</div>
        </div>
      </div>
      {data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : !data.data ? <Loading /> : <OdooForm key={wid} wid={wid} initial={data.data.odoo} members={data.data.members} onSaved={data.reload} />}
    </div>
  )
}

interface Form {
  url: string
  db: string
  login: string
  apiKey: string
  employees: Record<string, string>
}

const toForm = (c: OdooConnection | null): Form => ({
  url: c?.url ?? '',
  db: c?.db ?? '',
  login: c?.login ?? '',
  apiKey: '',
  employees: Object.fromEntries(Object.entries(c?.employeeMap ?? {}).map(([k, v]) => [k, String(v.employeeId)])),
})

function OdooForm({ wid, initial, members, onSaved }: { wid: string; initial: OdooConnection | null; members: Member[]; onSaved: () => void }) {
  const [f, setF] = useState<Form>(() => toForm(initial))
  const [busy, setBusy] = useState<'save' | 'test' | 'auto' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [test, setTest] = useState<OdooTestResult | null>(null)
  useEffect(() => setF(toForm(initial)), [initial])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  /** Keeps names/user ids the server already knows for unchanged employee ids. */
  const employeeMap = (): Record<string, EmployeeMapEntry> =>
    Object.fromEntries(
      Object.entries(f.employees)
        .filter(([, v]) => /^\d+$/.test(v.trim()) && Number(v) > 0)
        .map(([k, v]) => {
          const old = initial?.employeeMap[k]
          return [k, old && old.employeeId === Number(v) ? old : { employeeId: Number(v) }]
        }),
    )
  const conn = () => ({ url: f.url.trim().replace(/\/+$/, ''), db: f.db.trim(), login: f.login.trim(), ...(f.apiKey ? { apiKey: f.apiKey } : {}) })
  const valid = /^https?:\/\/.+/i.test(f.url.trim()) && f.db.trim() && f.login.trim() && (f.apiKey || initial?.hasApiKey)

  const save = async () => {
    setBusy('save')
    setMsg(null)
    try {
      await api.saveOdoo(wid, conn())
      await api.saveEmployeeMap(wid, employeeMap())
      setMsg({ ok: true, text: 'Saved' })
      onSaved()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }
  const autoMap = async () => {
    setBusy('auto')
    setMsg(null)
    try {
      const r = await api.autoMapEmployees(wid)
      setF((x) => ({ ...x, employees: { ...x.employees, ...Object.fromEntries(Object.entries(r.employeeMap).map(([k, v]) => [k, String(v.employeeId)])) } }))
      setMsg({ ok: true, text: `Matched ${r.matched} by e-mail${r.unmatched.length ? `, ${r.unmatched.length} still unmapped` : ''}` })
      onSaved()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }
  const runTest = async () => {
    setBusy('test')
    setTest(null)
    try {
      setTest(await api.testOdoo(wid, conn()))
    } catch (e) {
      setTest({ ok: false, error: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Odoo connection</h2>
        <p className="muted small">Used to write timesheet lines (account.analytic.line) over XML-RPC. Use a dedicated user with an API key.</p>
        <div className="form grid-2">
          <label className="span-2">
            URL
            <input value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://odoo.example.com" />
          </label>
          <label>
            Database
            <input value={f.db} onChange={(e) => set('db', e.target.value)} />
          </label>
          <label>
            Login
            <input value={f.login} onChange={(e) => set('login', e.target.value)} autoComplete="off" />
          </label>
          <label className="span-2">
            API key <em>write-only{initial?.hasApiKey ? '; a key is stored, leave empty to keep it' : ''}</em>
            <input
              type="password"
              autoComplete="new-password"
              value={f.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder={initial?.hasApiKey ? '•••••••••••• (stored)' : 'Paste the API key'}
            />
          </label>
        </div>
        <div className="row wrap gap">
          <button className="btn ghost" disabled={!valid || !!busy} onClick={() => void runTest()}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {test && (
            <span className={`notice ${test.ok ? 'ok' : 'err'}`}>
              {test.ok ? `Connected${test.serverVersion ? ` · Odoo ${test.serverVersion}` : ''}${test.uid != null ? ` · uid ${test.uid}` : ''}` : `Failed: ${test.error ?? 'unknown error'}`}
            </span>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Employee mapping</h2>
        <div className="row between">
          <p className="muted small">Each member’s timesheet lines are written for this hr.employee id. Members without an id cannot submit.</p>
          <button className="btn ghost small" disabled={!initial || initial.fromEnv || !!busy} onClick={() => void autoMap()} title="Match members to hr.employee by work e-mail (read-only in Odoo)">
            {busy === 'auto' ? 'Matching…' : 'Match by e-mail'}
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>hr.employee id</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>
                  <div className="who">
                    <Avatar name={m.name || m.email} url={m.avatarUrl} size={26} />
                    <div>
                      <div>{m.name || m.email}</div>
                      <div className="muted small">{m.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <input
                    className="narrow"
                    inputMode="numeric"
                    value={f.employees[m.userId] ?? ''}
                    placeholder="—"
                    onChange={(e) => set('employees', { ...f.employees, [m.userId]: e.target.value.replace(/\D/g, '') })}
                  />
                  {initial?.employeeMap[m.userId]?.employeeName && <span className="muted small"> {initial.employeeMap[m.userId].employeeName}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="save-bar">
        {msg && <span className={`notice ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
        <button className="btn" disabled={!valid || !!busy} onClick={() => void save()}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )
}
