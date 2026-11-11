import { useEffect, useState } from 'react'
import { api, errorText } from '../api/client.ts'
import type { Member, Project, ProjectInput, ShareLevel, WorkspaceRole } from '../api/types.ts'
import { useApp } from '../app-context.ts'
import { Avatar, ChipInput, CopyField, Empty, ErrorBox, Loading, Modal, SHARE_HINT, SHARE_LABEL } from '../components/ui.tsx'
import { toMs } from '../lib/dates.ts'
import { navigate, useAsync } from '../lib/hooks.ts'
import { ColorPicker } from './Projects.tsx'

const SHARES: ShareLevel[] = ['time', 'cards', 'detailed']
export const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer']

const fmtDate = (v: number | string) =>
  new Date(typeof v === 'string' ? Date.parse(v) : toMs(v)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

const numOrUndef =(s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Math.trunc(Number(s)))

export function ProjectSettings({ id }: { id: string }) {
  const { projects, projectsLoading, isAdmin } = useApp()
  const project = projects.find((p) => p.id === id)
  if (!project) return projectsLoading ? <Loading /> : <Empty title="Project not found" />
  if (!isAdmin) return <Empty title="Admins only">Only workspace owners and admins can change project settings.</Empty>
  return (
    <div className="page scroll">
      <div className="project-head" style={{ ['--pc' as string]: project.color }}>
        <div className="ph-title">
          <button className="link-btn back" onClick={() => navigate(`/projects/${id}/feed`)}>
            ‹ {project.name}
          </button>
          <h1>Project settings</h1>
        </div>
      </div>
      <ProjectForm key={project.id} project={project} />
      <MembersPanel project={project} />
    </div>
  )
}

function ProjectForm({ project }: { project: Project }) {
  const { workspace, reloadProjects } = useApp()
  const [f, setF] = useState(() => toForm(project))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => setF(toForm(project)), [project])
  const dirty = JSON.stringify(f) !== JSON.stringify(toForm(project))
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const setRule = (k: keyof Form['rules'], v: string[]) => setF((x) => ({ ...x, rules: { ...x.rules, [k]: v } }))

  const save = async (patch: ProjectInput, okText: string) => {
    if (!workspace) return
    setSaving(true)
    setMsg(null)
    try {
      await api.updateProject(workspace.id, project.id, patch)
      reloadProjects()
      setMsg({ ok: true, text: okText })
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <section className="panel">
        <h2>General</h2>
        <div className="form">
          <label>
            Name
            <input value={f.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <div className="field">
            <span className="label">Colour</span>
            <ColorPicker value={f.color} onChange={(c) => set('color', c)} />
          </div>
          <label>Icon (optional emoji)
            <input maxLength={16} value={f.icon} onChange={(e) => set('icon', e.target.value)} placeholder="📁" />
          </label>
          <label>
            Description <em>also given to the AI so it can suggest this project for cards</em>
            <textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </label>
          <div className="field">
            <span className="label">Default share level</span>
            <div className="share-options">
              {SHARES.map((s) => (
                <button key={s} type="button" className={`provider ${f.defaultShare === s ? 'active' : ''}`} onClick={() => set('defaultShare', s)}>
                  <b>{SHARE_LABEL[s]}</b>
                  <span>{SHARE_HINT[s]}</span>
                </button>
              ))}
            </div>
            <small>Members can be given a different level below. Private cards are never shared.</small>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Assignment rules</h2>
        <p className="muted small">Cards matching any rule are assigned to this project automatically and count as confirmed.</p>
        <div className="form">
          <label>
            Apps <em>process names, e.g. Code, rider64</em>
            <ChipInput value={f.rules.apps} onChange={(v) => setRule('apps', v)} placeholder="Add an app and press Enter" />
          </label>
          <label>
            Domains <em>e.g. odoo.velesagro.pl</em>
            <ChipInput value={f.rules.domains} onChange={(v) => setRule('domains', v)} placeholder="Add a domain" />
          </label>
          <label>
            Title keywords
            <ChipInput value={f.rules.titleKeywords} onChange={(v) => setRule('titleKeywords', v)} placeholder="Add a keyword" />
          </label>
          <label>
            Repositories <em>e.g. velesagro/odoo-addons</em>
            <ChipInput value={f.rules.repos} onChange={(v) => setRule('repos', v)} placeholder="Add a repo" />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Odoo mapping</h2>
        <p className="muted small">Timesheet lines for this project are written to this Odoo project and task.</p>
        <div className="form grid-2">
          <label>
            Project id <em>project.project</em>
            <input inputMode="numeric" value={f.odooProjectId} onChange={(e) => set('odooProjectId', e.target.value.replace(/\D/g, ''))} placeholder="e.g. 42" />
          </label>
          <label>
            Project name
            <input value={f.odooProjectName} onChange={(e) => set('odooProjectName', e.target.value)} />
          </label>
          <label>
            Task id <em>project.task, optional</em>
            <input inputMode="numeric" value={f.odooTaskId} onChange={(e) => set('odooTaskId', e.target.value.replace(/\D/g, ''))} />
          </label>
          <label>
            Task name
            <input value={f.odooTaskName} onChange={(e) => set('odooTaskName', e.target.value)} />
          </label>
        </div>
      </section>

      <div className="save-bar">
        {msg && <span className={`notice ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
        <button className="btn ghost" disabled={!dirty || saving} onClick={() => setF(toForm(project))}>
          Discard
        </button>
        <button className="btn" disabled={!dirty || saving || !f.name.trim()} onClick={() => void save(fromForm(f), 'Saved')}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <section className="panel danger-zone">
        <h2>{project.archived ? 'Archived' : 'Archive'}</h2>
        <div className="row between">
          <span className="muted">
            {project.archived
              ? 'This project is hidden from assignment. Its history and reports are kept.'
              : 'Archived projects stop receiving new cards and are hidden from the project list. History is kept.'}
          </span>
          <button className={`btn ${project.archived ? 'ghost' : 'danger'}`} disabled={saving} onClick={() => void save({ archived: !project.archived }, project.archived ? 'Restored' : 'Archived')}>
            {project.archived ? 'Restore project' : 'Archive project'}
          </button>
        </div>
      </section>
    </>
  )
}

interface Form {
  name: string
  color: string
  icon: string
  description: string
  defaultShare: ShareLevel
  rules: { apps: string[]; domains: string[]; titleKeywords: string[]; repos: string[] }
  odooProjectId: string
  odooProjectName: string
  odooTaskId: string
  odooTaskName: string
}

function toForm(p: Project): Form {
  return {
    name: p.name,
    color: p.color,
    icon: p.icon ?? '',
    description: p.description ?? '',
    defaultShare: p.defaultShare,
    rules: { apps: p.rules.apps ?? [], domains: p.rules.domains ?? [], titleKeywords: p.rules.titleKeywords ?? [], repos: p.rules.repos ?? [] },
    odooProjectId: p.odoo?.projectId != null ? String(p.odoo.projectId) : '',
    odooProjectName: p.odoo?.projectName ?? '',
    odooTaskId: p.odoo?.taskId != null ? String(p.odoo.taskId) : '',
    odooTaskName: p.odoo?.taskName ?? '',
  }
}

function fromForm(f: Form): ProjectInput {
  return {
    name: f.name.trim(),
    color: f.color,
    icon: f.icon,
    description: f.description,
    defaultShare: f.defaultShare,
    rules: f.rules,
    // null clears the mapping; the server validates positive integer ids
    odoo:
      numOrUndef(f.odooProjectId) == null && numOrUndef(f.odooTaskId) == null
        ? null
        : {
            projectId: numOrUndef(f.odooProjectId),
            projectName: f.odooProjectName.trim() || undefined,
            taskId: numOrUndef(f.odooTaskId),
            taskName: f.odooTaskName.trim() || undefined,
          },
  }
}

// ---- Members & invites ----

function MembersPanel({ project }: { project: Project }) {
  const { workspace, me } = useApp()
  const wid = workspace?.id ?? ''
  const data = useAsync(async () => {
    const [members, shares, invites] = await Promise.all([api.members(wid), api.projectMembers(project.id).catch(() => []), api.invites(wid).catch(() => [])])
    return { members, shares: new Map(shares.map((s) => [s.userId, s.shareLevel])), invites }
  }, [wid, project.id])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [link, setLink] = useState<{ email: string; url: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)
  const isOwner = workspace?.role === 'owner'

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null)
    setBusy(true)
    try {
      await fn()
      data.reload()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>Members &amp; invites</h2>
      <p className="muted small">Roles apply to the whole workspace “{workspace?.name}”. The share level applies to this project only.</p>
      <form
        className="invite-row"
        onSubmit={(e) => {
          e.preventDefault()
          const em = email.trim()
          if (!em) return
          void run(async () => {
            const r = await api.createInvite(wid, em, role)
            setLink({ email: em, url: r.url })
            setEmail('')
          })
        }}
      >
        <input type="email" required placeholder="colleague@velesagro.pl" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
          {ROLES.filter((r) => r !== 'owner' || isOwner).map((r) => (
            <option key={r} value={r}>
              {r[0].toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy}>
          Invite
        </button>
      </form>
      {link && (
        <div className="invite-link">
          <div className="small">
            Invite link for <b>{link.email}</b> — send it yourself; it works once.
          </div>
          {link.url ? <CopyField value={link.url} /> : <div className="notice err">The server did not return a link.</div>}
        </div>
      )}
      {err && <div className="notice err">{err}</div>}
      {data.error ? (
        <ErrorBox error={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <Loading />
      ) : (
        <>
          <table className="table members">
            <thead>
              <tr>
                <th>Member</th>
                <th>Workspace role</th>
                <th>Shares on this project</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.data.members.map((m) => {
                const self = m.userId === me.user.id
                const lockRole = self || (m.role === 'owner' && !isOwner)
                const share = data.data!.shares.get(m.userId) ?? null
                return (
                  <tr key={m.userId}>
                    <td>
                      <div className="who">
                        <Avatar name={m.name || m.email} url={m.avatarUrl} size={26} />
                        <div>
                          <div>
                            {m.name || m.email}
                            {self && <span className="muted"> (you)</span>}
                          </div>
                          <div className="muted small">{m.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select value={m.role} disabled={lockRole || busy} onChange={(e) => void run(() => api.setRole(wid, m.userId, e.target.value as WorkspaceRole))}>
                        {ROLES.filter((r) => r !== 'owner' || isOwner || m.role === 'owner').map((r) => (
                          <option key={r} value={r}>
                            {r[0].toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={share ?? ''}
                        disabled={busy}
                        onChange={(e) => void run(() => api.setProjectShare(project.id, m.userId, (e.target.value || null) as ShareLevel | null))}
                      >
                        <option value="">Project default ({SHARE_LABEL[project.defaultShare]})</option>
                        {SHARES.map((s) => (
                          <option key={s} value={s}>
                            {SHARE_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="right">
                      {!lockRole && (
                        <button className="link-btn danger" disabled={busy} onClick={() => setRemoving(m)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.data.invites.length > 0 && (
            <>
              <h3 className="sub">Pending invites</h3>
              <table className="table">
                <tbody>
                  {data.data.invites.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td>
                      <td>{i.role}</td>
                      <td className="muted">{i.expiresAt ? `expires ${fmtDate(i.expiresAt)}` : ''}</td>
                      <td className="right">
                        <button className="link-btn danger" disabled={busy} onClick={() => void run(() => api.revokeInvite(wid, i.id))}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {removing && (
        <Modal
          title="Remove member?"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const m = removing
                  setRemoving(null)
                  void run(() => api.removeMember(wid, m.userId))
                }}
              >
                Remove
              </button>
            </>
          }
        >
          <p>
            <b>{removing.name || removing.email}</b> loses access to every project in {workspace?.name}. Time they already shared stays in reports.
          </p>
        </Modal>
      )}
    </section>
  )
}
