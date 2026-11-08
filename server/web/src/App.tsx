import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, onUnauthorized } from './api/client.ts'
import type { MeResponse } from './api/types.ts'
import { AppContext, isAdminRole, type AppState } from './app-context.ts'
import { DayflowMark, ErrorBox, Loading } from './components/ui.tsx'
import { navigate, useAsync, useRoute } from './lib/hooks.ts'
import { Account } from './pages/Account.tsx'
import { InvitePage } from './pages/InvitePage.tsx'
import { MyTime } from './pages/MyTime.tsx'
import { ProjectPage } from './pages/ProjectPage.tsx'
import { Projects } from './pages/Projects.tsx'
import { ProjectSettings } from './pages/ProjectSettings.tsx'
import { Timesheets } from './pages/Timesheets.tsx'
import { WorkspaceSettings } from './pages/WorkspaceSettings.tsx'

const WS_KEY = 'dayflow.workspace'
const inviteToken = /^\/invite\/([^/?#]+)/.exec(window.location.pathname)?.[1] ?? null

export function App() {
  const [signedOut, setSignedOut] = useState(false)
  const [inviteHandled, setInviteHandled] = useState(false)
  const me = useAsync(() => api.me(), [])
  useEffect(() => onUnauthorized(() => setSignedOut(true)), [])

  if (signedOut || (me.error instanceof ApiError && me.error.status === 401)) return <NoSession invite={!!inviteToken} />
  if (me.error)
    return (
      <div className="center-page">
        <div className="onb-card">
          <ErrorBox error={me.error} onRetry={me.reload} />
        </div>
      </div>
    )
  if (!me.data) return <Loading label="Connecting to Dayflow…" />
  if (inviteToken && !inviteHandled)
    return (
      <InvitePage
        token={decodeURIComponent(inviteToken)}
        email={me.data.user.email}
        onDone={(workspaceId) => {
          if (workspaceId) localStorage.setItem(WS_KEY, workspaceId)
          window.history.replaceState(null, '', '/')
          setInviteHandled(true)
          me.reload()
        }}
      />
    )
  return <Shell me={me.data} reloadMe={me.reload} onSignedOut={() => setSignedOut(true)} />
}

export function NoSession({ invite }: { invite?: boolean }) {
  return (
    <div className="center-page">
      <div className="onb-card nosession">
        <div className="logo-row">
          <DayflowMark size={28} />
          <span className="logo">Dayflow</span>
        </div>
        <h1>Open the dashboard from the Dayflow app</h1>
        <p>
          The web dashboard signs you in through the desktop app — there is no separate password. In Dayflow, go to{' '}
          <b>Settings → Sync &amp; team → Open web dashboard</b>.
        </p>
        {invite && <p>You opened a workspace invite. Sign in from the app first, then open the invite link again.</p>}
        <p className="muted small">Sign-in links work once and expire after a minute; a session lasts 12 hours.</p>
      </div>
    </div>
  )
}

function Shell({ me, reloadMe, onSignedOut }: { me: MeResponse; reloadMe: () => void; onSignedOut: () => void }) {
  const [wsId, setWsId] = useState<string | null>(() => localStorage.getItem(WS_KEY))
  const workspace = me.workspaces.find((w) => w.id === wsId) ?? me.workspaces[0] ?? null
  const projects = useAsync(() => (workspace ? api.projects(workspace.id) : Promise.resolve([])), [workspace?.id])
  const route = useRoute()

  const state = useMemo<AppState>(
    () => ({
      me,
      workspace,
      setWorkspaceId: (id) => {
        localStorage.setItem(WS_KEY, id)
        setWsId(id)
        navigate('/')
      },
      projects: projects.data ?? [],
      projectsLoading: projects.loading,
      reloadProjects: projects.reload,
      isAdmin: isAdminRole(workspace?.role),
    }),
    [me, workspace, projects.data, projects.loading, projects.reload],
  )

  const [section = '', id, sub] = route.parts
  let page: ReactNode
  if (section === 'projects' && id) page = sub === 'settings' ? <ProjectSettings id={id} /> : <ProjectPage id={id} tab={sub === 'report' || sub === 'standup' ? sub : 'feed'} />
  else if (section === 'projects') page = <Projects />
  else if (section === 'timesheets') page = <Timesheets />
  else if (section === 'workspace') page = <WorkspaceSettings />
  else if (section === 'account') page = <Account onSignedOut={onSignedOut} onChanged={reloadMe} />
  else page = <MyTime />

  const nav: { id: string; label: string; icon: ReactNode; show?: boolean }[] = [
    { id: '', label: 'My time', icon: <IconClock /> },
    { id: 'projects', label: 'Projects', icon: <IconFolder /> },
    { id: 'timesheets', label: 'Timesheets', icon: <IconSheet /> },
    { id: 'workspace', label: 'Workspace', icon: <IconGear />, show: state.isAdmin },
    { id: 'account', label: 'Account', icon: <IconUser /> },
  ]

  return (
    <AppContext.Provider value={state}>
      <div className="shell">
        <nav className="sidebar">
          <div className="logo">
            <DayflowMark size={20} /> Dayflow
          </div>
          {nav
            .filter((n) => n.show !== false)
            .map((n) => (
              <button key={n.id} className={`nav ${section === n.id ? 'active' : ''}`} onClick={() => navigate(`/${n.id}`)}>
                <span className="nav-icon">{n.icon}</span>
                <span className="nav-label">{n.label}</span>
              </button>
            ))}
          <div className="sidebar-spacer" />
          {me.workspaces.length > 1 ? (
            <select className="ws-select" value={workspace?.id} onChange={(e) => state.setWorkspaceId(e.target.value)} aria-label="Workspace">
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : workspace ? (
            <div className="ws-name" title={`Your role: ${workspace.role}`}>
              {workspace.name}
            </div>
          ) : null}
          <div className="me-name muted">{me.user.name || me.user.email}</div>
        </nav>
        <main className="content">{page}</main>
      </div>
    </AppContext.Provider>
  )
}

const ico = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const IconClock = () => (
  <svg {...ico}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.3 1.5" />
  </svg>
)
const IconFolder = () => (
  <svg {...ico}>
    <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.6c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
  </svg>
)
const IconSheet = () => (
  <svg {...ico}>
    <rect x="2" y="2" width="12" height="12" rx="1.6" />
    <path d="M2 6h12M6 6v8" />
  </svg>
)
const IconGear = () => (
  <svg {...ico}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3" />
  </svg>
)
const IconUser = () => (
  <svg {...ico}>
    <circle cx="8" cy="5.6" r="2.8" />
    <path d="M2.6 14c.6-2.6 2.8-4.1 5.4-4.1s4.8 1.5 5.4 4.1" />
  </svg>
)
