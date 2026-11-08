import { useEffect, useMemo, useState } from 'react'
import { api, errorText } from '../api/client.ts'
import type { Project, TimesheetSubmitResult } from '../api/types.ts'
import { useApp } from '../app-context.ts'
import { initialRange, RangePicker, type RangeValue } from '../components/RangePicker.tsx'
import { Empty, ErrorBox, Loading, Modal } from '../components/ui.tsx'
import { shortDay } from '../lib/dates.ts'
import { fmtHours, parseHours, stepHours } from '../lib/format.ts'
import { useAsync } from '../lib/hooks.ts'
import { buildSubmit, canSubmit, isDirty, rowKey, submittable, toRows, totalHours, type SheetRow } from '../lib/timesheets.ts'

export function Timesheets() {
  const { workspace, projects } = useApp()
  const [range, setRange] = useState<RangeValue>(() => initialRange('week'))
  const wid = workspace?.id ?? ''
  const prop = useAsync(
    () => (wid ? api.proposals(wid, range.range.from, range.range.to) : Promise.resolve({ odooConfigured: false, employeeMapped: false, proposals: [] })),
    [wid, range.range.from, range.range.to],
  )
  const [rows, setRows] = useState<SheetRow[]>([])
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setRows(toRows(prop.data?.proposals ?? [])), [prop.data])

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const update = (key: string, patch: Partial<SheetRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const toSend = submittable(rows)
  const days = useMemo(() => {
    const m = new Map<string, SheetRow[]>()
    for (const r of rows) m.set(r.proposal.day, [...(m.get(r.proposal.day) ?? []), r])
    return [...m]
  }, [rows])
  const selectable = rows.filter((r) => canSubmit(r.proposal) && r.hours > 0)
  const allSelected = selectable.length > 0 && selectable.every((r) => r.selected)

  if (!workspace) return <Empty title="No workspace">Timesheets need a workspace with an Odoo connection.</Empty>

  return (
    <div className="page scroll">
      <div className="page-head">
        <div>
          <h1>Timesheets</h1>
          <div className="muted">Confirmed project time, rounded to 0.25 h. Nothing is written to Odoo until you submit.</div>
        </div>
      </div>
      <div className="toolbar">
        <RangePicker value={range} onChange={setRange} />
      </div>
      {prop.error ? (
        <ErrorBox error={prop.error} onRetry={prop.reload} />
      ) : !prop.data ? (
        <Loading />
      ) : (
        <>
          {!prop.data.odooConfigured && <div className="notice warn">Odoo is not connected for {workspace.name} yet — an admin can set it up in Workspace settings. You can review lines, but not submit.</div>}
          {prop.data.odooConfigured && !prop.data.employeeMapped && (
            <div className="notice warn">Your account is not mapped to an Odoo employee yet. Ask an admin to map you in Workspace settings before submitting.</div>
          )}
        </>
      )}
      {!prop.data || prop.error ? null : !rows.length ? (
        <Empty title="Nothing to propose">No confirmed project time in this period. Confirm project chips in the desktop timeline first.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table sheet">
              <thead>
                <tr>
                  <th className="cb">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={(e) => setRows((rs) => rs.map((r) => (canSubmit(r.proposal) && r.hours > 0 ? { ...r, selected: e.target.checked } : r)))}
                    />
                  </th>
                  <th>Day</th>
                  <th>Project</th>
                  <th className="hours-col">Hours</th>
                  <th>Description</th>
                  <th>Odoo</th>
                </tr>
              </thead>
              <tbody>
                {days.map(([day, dayRows]) =>
                  dayRows.map((r, i) => (
                    <SheetRowView
                      key={r.key}
                      row={r}
                      project={byId.get(r.proposal.projectId)}
                      dayCell={i === 0 ? { label: shortDay(day), span: dayRows.length, total: totalHours(dayRows) } : null}
                      onChange={(p) => update(r.key, p)}
                    />
                  )),
                )}
              </tbody>
            </table>
          </div>
          <div className="save-bar sticky">
            <span className="muted">
              {toSend.length} of {rows.length} lines selected · {fmtHours(totalHours(toSend))}
            </span>
            <button className="btn ghost" onClick={() => setRows(toRows(prop.data?.proposals ?? []))} disabled={!rows.some(isDirty)}>
              Reset edits
            </button>
            <button className="btn" disabled={!toSend.length || !prop.data.odooConfigured || !prop.data.employeeMapped} onClick={() => setConfirming(true)}>
              Review &amp; submit…
            </button>
          </div>
        </>
      )}
      {confirming && (
        <SubmitModal
          rows={toSend}
          projects={byId}
          onClose={(sent) => {
            setConfirming(false)
            if (sent) prop.reload()
          }}
        />
      )}
    </div>
  )
}

function SheetRowView({ row, project, dayCell, onChange }: { row: SheetRow; project?: Project; dayCell: { label: string; span: number; total: number } | null; onChange: (p: Partial<SheetRow>) => void }) {
  const p = row.proposal
  const [draft, setDraft] = useState(String(row.hours))
  useEffect(() => setDraft(String(row.hours)), [row.hours])
  const mapped = canSubmit(p)
  const commit = () => {
    const h = parseHours(draft)
    if (h == null) setDraft(String(row.hours))
    else onChange({ hours: h, selected: h > 0 && mapped ? row.selected || h !== row.hours : false })
  }
  return (
    <tr className={`${row.selected ? 'sel' : ''} ${!mapped ? 'unmapped' : ''}`}>
      <td className="cb">
        <input type="checkbox" aria-label="Select line" disabled={!mapped || row.hours <= 0} checked={row.selected} onChange={(e) => onChange({ selected: e.target.checked })} />
      </td>
      {dayCell && (
        <td rowSpan={dayCell.span} className="day-cell">
          <b>{dayCell.label}</b>
          <div className="muted small">{fmtHours(dayCell.total)}</div>
        </td>
      )}
      <td>
        <div className="proj-cell">
          <i style={{ background: project?.color ?? '#bbb' }} />
          <div>
            <div>{project?.name ?? p.projectName ?? 'Unknown project'}</div>
            <div className="muted small">
              {p.cardIds.length} {p.cardIds.length === 1 ? 'card' : 'cards'} · proposed {fmtHours(p.hours)}
            </div>
          </div>
        </div>
      </td>
      <td className="hours-col">
        <div className="stepper">
          <button type="button" aria-label="Minus 15 minutes" onClick={() => onChange({ hours: stepHours(row.hours, -1) })} disabled={row.hours <= 0}>
            −
          </button>
          <input
            value={draft}
            inputMode="decimal"
            aria-label="Hours"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                onChange({ hours: stepHours(row.hours, 1) })
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                onChange({ hours: stepHours(row.hours, -1) })
              }
            }}
          />
          <button type="button" aria-label="Plus 15 minutes" onClick={() => onChange({ hours: stepHours(row.hours, 1) })}>
            +
          </button>
        </div>
      </td>
      <td className="desc-col">
        <textarea rows={2} value={row.description} onChange={(e) => onChange({ description: e.target.value })} />
      </td>
      <td className="odoo-col">
        {!mapped ? (
          <span className="status warn" title="Map this project to an Odoo project in Project settings">
            Not mapped
          </span>
        ) : p.existingOdooLineId != null ? (
          <span className="status existing" title="Submitting updates the existing line instead of creating a new one">
            Existing in Odoo #{p.existingOdooLineId}
          </span>
        ) : (
          <span className="status new">New</span>
        )}
        {mapped && (
          <div className="muted small">
            {project?.odoo?.projectName ?? `project ${p.odooProjectId}`}
            {p.odooTaskId != null ? ` / ${project?.odoo?.taskName ?? `task ${p.odooTaskId}`}` : ''}
          </div>
        )}
      </td>
    </tr>
  )
}

function SubmitModal({ rows, projects, onClose }: { rows: SheetRow[]; projects: Map<string, Project>; onClose: (sent: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TimesheetSubmitResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const payload = buildSubmit(rows)
  const outcome = (day: string, projectId: string) => {
    if (!result) return null
    const k = rowKey({ day, projectId })
    const s = result.sent.find((x) => rowKey(x) === k)
    if (s) return <span className="status ok">{s.updated ? 'Updated' : 'Created'} #{s.odooLineId}</span>
    const f = result.failed.find((x) => rowKey(x) === k)
    if (f) return <span className="status fail" title={f.error}>Failed: {f.error}</span>
    return <span className="status warn">No result</span>
  }
  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      setResult(await api.submitTimesheets(payload))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const total = payload.lines.reduce((s, l) => s + l.hours, 0)
  return (
    <Modal
      wide
      title={result ? 'Submitted to Odoo' : 'Write these lines to Odoo?'}
      onClose={() => !busy && onClose(!!result)}
      footer={
        result ? (
          <>
            <span className="muted">
              {result.sent.length} written, {result.failed.length} failed
            </span>
            <button className="btn" onClick={() => onClose(true)}>
              Done
            </button>
          </>
        ) : (
          <>
            <span className="muted">
              {payload.lines.length} lines · {fmtHours(total)}
            </span>
            <button className="btn ghost" disabled={busy} onClick={() => onClose(false)}>
              Cancel
            </button>
            <button className="btn" disabled={busy || !payload.lines.length} onClick={() => void submit()}>
              {busy ? 'Writing…' : `Write ${payload.lines.length} ${payload.lines.length === 1 ? 'line' : 'lines'}`}
            </button>
          </>
        )
      }
    >
      {!result && <p className="muted">Each line becomes one account.analytic.line for you in Odoo. Lines already in Odoo are updated, never duplicated.</p>}
      <div className="table-wrap">
        <table className="table confirm">
          <thead>
            <tr>
              <th>Date</th>
              <th>Odoo project / task</th>
              <th className="right">Hours</th>
              <th>Description</th>
              <th>{result ? 'Result' : 'Action'}</th>
            </tr>
          </thead>
          <tbody>
            {payload.lines.map((l) => {
              const row = rows.find((r) => r.key === rowKey(l))!
              const pr = projects.get(l.projectId)
              return (
                <tr key={rowKey(l)}>
                  <td className="nowrap">{l.day}</td>
                  <td>
                    <div>{pr?.odoo?.projectName ?? `project.project ${row.proposal.odooProjectId}`}</div>
                    {row.proposal.odooTaskId != null && <div className="muted small">{pr?.odoo?.taskName ?? `project.task ${row.proposal.odooTaskId}`}</div>}
                    <div className="muted small">Dayflow: {pr?.name ?? row.proposal.projectName ?? l.projectId}</div>
                  </td>
                  <td className="right nowrap">{fmtHours(l.hours)}</td>
                  <td className="pre">{l.description || <span className="muted">(empty)</span>}</td>
                  <td className="nowrap">
                    {result ? outcome(l.day, l.projectId) : row.proposal.existingOdooLineId != null ? `Update #${row.proposal.existingOdooLineId}` : 'Create'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {err && <div className="notice err">{err}</div>}
    </Modal>
  )
}
