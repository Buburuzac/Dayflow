import { useState } from 'react'
import { api, errorText } from '../api/client.ts'
import { useApp } from '../app-context.ts'
import { Empty, ErrorBox, Loading, Modal, ShareBadge } from '../components/ui.tsx'
import { logicalDay, rangeFor, rangeLabel } from '../lib/dates.ts'
import { fmtMinutes } from '../lib/format.ts'
import { navigate, useAsync } from '../lib/hooks.ts'

export function Projects() {
  const { projects, projectsLoading, workspace, isAdmin, reloadProjects } = useApp()
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const week = rangeFor('week', logicalDay())
  const visible = projects.filter((p) => showArchived || !p.archived)
  const ids = visible.map((p) => p.id).join(',')
  const totals = useAsync(async () => {
    const entries = await Promise.all(
      visible.map((p) =>
        api.report(p.id, week.from, week.to).then(
          (r) => [p.id, r] as const,
          () => [p.id, null] as const,
        ),
      ),
    )
    return new Map(entries)
  }, [ids, week.from])

  if (!workspace) return <Empty title="No workspace yet">Ask a workspace owner to invite you.</Empty>

  return (
    <div className="page scroll">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="muted">
            {workspace.name} · this week ({rangeLabel('week', week)})
          </div>
        </div>
        <div className="row">
          {projects.some((p) => p.archived) && (
            <label className="check">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
          )}
          {isAdmin && (
            <button className="btn" onClick={() => setCreating(true)}>
              New project
            </button>
          )}
        </div>
      </div>
      {projectsLoading && !projects.length ? (
        <Loading />
      ) : !visible.length ? (
        <Empty title="No projects yet">{isAdmin ? 'Create the first project to start sharing time with your team.' : 'An admin has not created any projects yet.'}</Empty>
      ) : (
        <div className="project-grid">
          {visible.map((p) => {
            const r = totals.data?.get(p.id)
            return (
              <button key={p.id} className={`project-card ${p.archived ? 'archived' : ''}`} style={{ ['--pc' as string]: p.color }} onClick={() => navigate(`/projects/${p.id}/feed`)}>
                <div className="pc-top">
                  <span className="pc-name">{p.icon ? `${p.icon} ` : ''}{p.name}</span>
                  {p.archived && <span className="badge">Archived</span>}
                </div>
                <div className="pc-desc">{p.description || <span className="muted">No description</span>}</div>
                <div className="pc-stats">
                  <span className="pc-total serif">{r ? fmtMinutes(r.totalMinutes) : totals.loading ? '…' : '—'}</span>
                  <span className="muted">this week</span>
                  {r && r.byMember.length > 0 && <span className="muted">· {r.byMember.length} {r.byMember.length === 1 ? 'person' : 'people'}</span>}
                </div>
                <div className="pc-foot">
                  <ShareBadge level={p.defaultShare} />
                  {p.odoo?.projectName && <span className="odoo-tag">Odoo: {p.odoo.projectName}{p.odoo.taskName ? ` / ${p.odoo.taskName}` : ''}</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {totals.error != null && <ErrorBox error={totals.error} />}
      {creating && (
        <NewProject
          onClose={() => setCreating(false)}
          onCreate={async (name, color) => {
            const p = await api.createProject(workspace.id, { name, color, description: '', rules: {}, defaultShare: 'cards', archived: false })
            reloadProjects()
            navigate(`/projects/${p.id}/settings`)
          }}
        />
      )}
    </div>
  )
}

const COLORS = ['#F3854B', '#4276E9', '#4CB8A4', '#B984FF', '#E07AA8', '#E9B949', '#6AADFF', '#8A8A8A']

function NewProject({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, color: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={!name.trim() || busy}
            onClick={() => {
              setBusy(true)
              onCreate(name.trim(), color).catch((e) => {
                setErr(errorText(e))
                setBusy(false)
              })
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Odoo migration" />
        </label>
        <div className="field">
          <span className="label">Colour</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        {err && <div className="notice err">{err}</div>}
      </div>
    </Modal>
  )
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-row">
      {COLORS.map((c) => (
        <button key={c} type="button" className={`color-dot ${c.toLowerCase() === value.toLowerCase() ? 'active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#f3854b'} onChange={(e) => onChange(e.target.value)} aria-label="Custom colour" />
    </div>
  )
}
