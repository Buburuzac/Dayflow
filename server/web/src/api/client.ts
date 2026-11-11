// Thin fetch wrapper for the Dayflow Sync Server. Same-origin, session cookie; no tokens in JS.

import { normalizeCategories, type Category } from '../lib/categories.ts'
import type {
  Invite,
  Member,
  MemberTimelineResponse,
  MeResponse,
  EmployeeMapEntry,
  OdooConnection,
  OdooConnectionInput,
  ProposalsResponse,
  OdooTestResult,
  Project,
  ProjectEntry,
  ProjectInput,
  ProjectMemberShare,
  ProjectReport,
  ShareLevel,
  StandupItem,
  StandupMember,
  StandupResponse,
  TimelineCard,
  TimelineResponse,
  TimesheetSubmitRequest,
  TimesheetSubmitResult,
  WorkspaceReport,
  WorkspaceRole,
  WorkspaceUsersResponse,
  TimelineViewsResponse,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Listener = () => void
const unauthListeners = new Set<Listener>()
/** Fires whenever any request comes back 401 (no or expired session). */
export function onUnauthorized(fn: Listener): () => void {
  unauthListeners.add(fn)
  return () => unauthListeners.delete(fn)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) {
    unauthListeners.forEach((fn) => fn())
    throw new ApiError(401, 'Not signed in')
  }
  const text = await res.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const o = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown }
    // server errors: { error: code, message, details? }
    const msg = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

const qs = (p: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => e[1] !== undefined)).toString()

/** Accepts either a bare array or `{ [key]: array }`. */
function list<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[key]
    if (Array.isArray(v)) return v as T[]
  }
  return []
}

function obj<T>(raw: unknown, key: string): T {
  if (raw && typeof raw === 'object' && key in (raw as object)) return (raw as Record<string, unknown>)[key] as T
  return raw as T
}

function normItem(x: unknown): StandupItem {
  if (typeof x === 'string') return { title: x, summary: null }
  const o = (x ?? {}) as Partial<StandupItem> & { text?: string }
  return { title: o.title ?? o.text ?? null, summary: o.summary ?? null, minutes: o.minutes }
}

function normProject(p: Project): Project {
  return {
    ...p,
    description: p.description ?? '',
    rules: p.rules ?? {},
    defaultShare: p.defaultShare ?? 'cards',
    archived: !!p.archived,
    color: p.color || '#F3854B',
    odoo: p.odoo ?? undefined,
  }
}

const enc = encodeURIComponent

export const api = {
  webAuthConfig: () => request<{ webClientId: string }>('GET', '/api/auth/google/config'),
  webSignIn: (credential: string) => request<{ ok: boolean }>('POST', '/api/auth/google/web', { credential }),
  me: () => request<MeResponse>('GET', '/api/me'),
  logout: () => request<void>('POST', '/api/auth/logout'),
  revokeDevice: (id: string) => request<void>('DELETE', `/api/devices/${enc(id)}`),

  async timeline(from: string, to: string): Promise<TimelineResponse & { categories: Category[] }> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const raw = await request<Partial<TimelineResponse> | TimelineCard[]>('GET', `/api/me/timeline?${qs({ from, to, timezone })}`)
    const cards = list<TimelineCard>(raw, 'cards').map((c) => ({ ...c, metadata: c.metadata ?? {}, projects: c.projects ?? [] }))
    const r = (Array.isArray(raw) ? {} : raw) as Partial<TimelineResponse>
    return { from, to, cards, devices: r.devices ?? [], categories: normalizeCategories(r.categories) }
  },

  async timelineViews(): Promise<TimelineViewsResponse['views']> {
    return list<TimelineViewsResponse['views'][number]>(await request<unknown>('GET', '/api/me/timeline-views'), 'views')
  },
  async workspaceUsers(workspaceId: string, from: string, to: string): Promise<WorkspaceUsersResponse> {
    const r = await request<Partial<WorkspaceUsersResponse>>('GET', `/api/workspaces/${enc(workspaceId)}/users?${qs({ from, to })}`)
    return { workspaceId, from, to, users: (r.users ?? []).map((u) => ({ ...u, devices: u.devices ?? [] })) }
  },
  async memberTimeline(workspaceId: string, userId: string, from: string, to: string): Promise<MemberTimelineResponse & { categories: Category[] }> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const r = await request<MemberTimelineResponse>('GET', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}/timeline?${qs({ from, to, timezone })}`)
    return {
      ...r,
      devices: r.devices ?? [],
      categories: normalizeCategories(r.categories),
      // cards shared as time only carry no category
      cards: (r.cards ?? []).map((c) => ({ ...c, category: c.category || 'Not shared', metadata: c.metadata ?? {}, projects: c.projects ?? [] })),
    }
  },

  async projects(workspaceId: string): Promise<Project[]> {
    const raw = await request<unknown>('GET', `/api/workspaces/${enc(workspaceId)}/projects?includeArchived=1`)
    return list<Project>(raw, 'projects').map(normProject)
  },
  async createProject(workspaceId: string, input: ProjectInput): Promise<Project> {
    return normProject(obj<Project>(await request<unknown>('POST', `/api/workspaces/${enc(workspaceId)}/projects`, input), 'project'))
  },
  async updateProject(workspaceId: string, id: string, patch: ProjectInput): Promise<Project> {
    return normProject(
      obj<Project>(await request<unknown>('PATCH', `/api/workspaces/${enc(workspaceId)}/projects/${enc(id)}`, patch), 'project'),
    )
  },

  async feed(projectId: string, from: string, to: string): Promise<ProjectEntry[]> {
    return list<ProjectEntry>(await request<unknown>('GET', `/api/projects/${enc(projectId)}/feed?${qs({ from, to })}`), 'entries')
  },
  async report(projectId: string, from: string, to: string): Promise<ProjectReport> {
    const r = await request<Partial<ProjectReport>>('GET', `/api/projects/${enc(projectId)}/report?${qs({ from, to })}`)
    return {
      projectId,
      from,
      to,
      totalMinutes: r.totalMinutes ?? 0,
      byMember: r.byMember ?? [],
      byDay: r.byDay ?? [],
      byMemberDay: r.byMemberDay ?? [],
    }
  },
  async workspaceReport(workspaceId: string, from: string, to: string): Promise<WorkspaceReport> {
    const r = await request<Partial<WorkspaceReport>>('GET', `/api/workspaces/${enc(workspaceId)}/report?${qs({ from, to })}`)
    return {
      workspaceId,
      from,
      to,
      totalMinutes: r.totalMinutes ?? 0,
      users: r.users ?? [],
      projects: r.projects ?? [],
      byUserProject: r.byUserProject ?? [],
      byUserDay: r.byUserDay ?? [],
      byDay: r.byDay ?? [],
    }
  },
  async standup(projectId: string, day: string): Promise<StandupResponse> {
    const raw = await request<unknown>('GET', `/api/projects/${enc(projectId)}/standup?${qs({ day })}`)
    const members = list<StandupMember>(raw, 'members').map((m) => ({
      ...m,
      done: (m.done ?? []).map(normItem),
      next: (m.next ?? []).map(normItem),
    }))
    return { projectId, day, members }
  },

  async projectMembers(projectId: string): Promise<ProjectMemberShare[]> {
    return list<ProjectMemberShare>(await request<unknown>('GET', `/api/projects/${enc(projectId)}/members`), 'members')
  },
  setProjectShare: (projectId: string, userId: string, shareLevel: ShareLevel | null) =>
    request<void>('PUT', `/api/projects/${enc(projectId)}/members/${enc(userId)}`, { shareLevel }),

  async members(workspaceId: string): Promise<Member[]> {
    return list<Member>(await request<unknown>('GET', `/api/workspaces/${enc(workspaceId)}/members`), 'members')
  },
  setRole: (workspaceId: string, userId: string, role: WorkspaceRole) =>
    request<void>('PATCH', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, { role }),
  removeMember: (workspaceId: string, userId: string) =>
    request<void>('DELETE', `/api/workspaces/${enc(workspaceId)}/members/${enc(userId)}`),
  async invites(workspaceId: string): Promise<Invite[]> {
    return list<Invite>(await request<unknown>('GET', `/api/workspaces/${enc(workspaceId)}/invites`), 'invites').filter(
      (i) => !i.status || i.status === 'pending',
    )
  },
  async createInvite(workspaceId: string, email: string, role: WorkspaceRole): Promise<{ url: string; invite?: Invite }> {
    const r = await request<{ url?: string; inviteUrl?: string; link?: string; invite?: Invite }>(
      'POST',
      `/api/workspaces/${enc(workspaceId)}/invites`,
      { email, role },
    )
    return { url: r.url ?? r.inviteUrl ?? r.link ?? r.invite?.url ?? '', invite: r.invite }
  },
  invite: (token: string) =>
    request<{ workspaceId: string; workspaceName: string; email: string; role: WorkspaceRole; expiresAt: number; accepted: boolean }>(
      'GET',
      `/api/invites/${enc(token)}`,
    ),
  acceptInvite: (token: string) =>
    request<{ workspaceId: string; workspaceName: string; role: WorkspaceRole }>('POST', `/api/invites/${enc(token)}/accept`, {}),
  revokeInvite: (workspaceId: string, inviteId: string) =>
    request<void>('DELETE', `/api/workspaces/${enc(workspaceId)}/invites/${enc(inviteId)}`),

  async proposals(workspaceId: string, from: string, to: string): Promise<ProposalsResponse> {
    const raw = await request<Partial<ProposalsResponse>>('GET', `/api/timesheets/proposals?${qs({ from, to, workspaceId })}`)
    return { odooConfigured: raw.odooConfigured ?? true, employeeMapped: raw.employeeMapped ?? true, proposals: list(raw, 'proposals') }
  },
  async submitTimesheets(body: TimesheetSubmitRequest): Promise<TimesheetSubmitResult> {
    const r = await request<Partial<TimesheetSubmitResult>>('POST', '/api/timesheets/submit', body)
    return { sent: r.sent ?? [], failed: r.failed ?? [] }
  },

  async odoo(workspaceId: string): Promise<OdooConnection | null> {
    try {
      const r = await request<(Partial<OdooConnection> & { configured?: boolean }) | null>('GET', `/api/workspaces/${enc(workspaceId)}/odoo`)
      if (!r || r.configured === false) return null
      return { url: r.url ?? '', db: r.db ?? '', login: r.login ?? '', hasApiKey: !!r.hasApiKey, fromEnv: !!r.fromEnv, employeeMap: r.employeeMap ?? {} }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
  saveOdoo: (workspaceId: string, input: OdooConnectionInput) =>
    request<void>('PUT', `/api/workspaces/${enc(workspaceId)}/odoo`, input),
  saveEmployeeMap: (workspaceId: string, map: Record<string, EmployeeMapEntry>) =>
    request<{ employeeMap: Record<string, EmployeeMapEntry> }>('PUT', `/api/workspaces/${enc(workspaceId)}/odoo/employee-map`, { map }),
  autoMapEmployees: (workspaceId: string) =>
    request<{ matched: number; employeeMap: Record<string, EmployeeMapEntry>; unmatched: string[] }>(
      'POST',
      `/api/workspaces/${enc(workspaceId)}/odoo/auto-map`,
      {},
    ),
  testOdoo: (workspaceId: string, input: Partial<OdooConnectionInput>) =>
    request<OdooTestResult>('POST', `/api/workspaces/${enc(workspaceId)}/odoo/test`, input),
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
