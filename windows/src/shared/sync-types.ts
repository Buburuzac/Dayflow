// Contract shared by the desktop client, the Dayflow Sync Server and its web dashboard.
// See docs/sync-server-design.md. Keep this file dependency-free (types + tiny pure helpers).

export type SyncEntity =
  | 'card'
  | 'card_project'
  | 'observation'
  | 'standup'
  | 'day_goal'
  | 'user_doc'
  | 'project'
  | 'project_member'

export type ShareLevel = 'time' | 'cards' | 'detailed'
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'
export type AssignmentSource = 'manual' | 'rule' | 'llm'

export interface SyncChange {
  entity: SyncEntity
  /** uuid, or a composite key for standup/day_goal (`<userId>:<day>`) and user_doc (`<userId>:<kind>`) */
  id: string
  deviceId: string
  /** Hybrid logical clock: `<unix ms, 13 digits>-<counter, 4 hex>-<deviceId>`; ordered by string compare. */
  hlc: string
  deleted?: boolean
  data?: Record<string, unknown>
  /** Cards only: per-field HLC for user-editable fields (title, category, subcategory, deleted). */
  fieldHlc?: Record<string, string>
}

export interface PushRequest {
  changes: SyncChange[]
}
export interface PushResponse {
  accepted: number
  rejected: { id: string; reason: string }[]
  serverTime: number
}
export interface PullResponse {
  changes: SyncChange[]
  cursor: number
  more: boolean
}

// ---- Entity payloads (SyncChange.data) ----

export interface CardData {
  userId: string
  startTs: number
  endTs: number
  day: string
  title: string
  summary: string
  detailedSummary: string
  category: string
  subcategory: string
  /** distractions, appSites, private?, windowApps? (process names seen in the card's frames) */
  metadata: Record<string, unknown>
  isError: boolean
  /** (appended by the desktop client) Device that generated the card and owns its analysis fields.
   *  Differs from SyncChange.deviceId when a user edits another device's card. Absent = SyncChange.deviceId. */
  originDeviceId?: string
}

export interface CardProjectData {
  cardId: string
  projectId: string
  /** 0..1, shares of one card sum to ≤ 1 */
  share: number
  source: AssignmentSource
  confidence: number
  confirmed: boolean
}

export interface ObservationData {
  userId: string
  startTs: number
  endTs: number
  text: string
}

export interface ProjectRules {
  apps?: string[]
  domains?: string[]
  titleKeywords?: string[]
  repos?: string[]
}

export interface OdooMapping {
  projectId?: number
  taskId?: number
  projectName?: string
  taskName?: string
}

export interface ProjectData {
  workspaceId: string
  name: string
  color: string
  icon?: string
  description: string
  rules: ProjectRules
  defaultShare: ShareLevel
  odoo?: OdooMapping
  archived: boolean
}

export interface ProjectMemberData {
  projectId: string
  userId: string
  /** null = use the project's defaultShare */
  shareLevel: ShareLevel | null
}

// ---- Auth / account ----

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  lastSeenAt: number | null
  revoked: boolean
  current?: boolean
}

export interface UserInfo {
  id: string
  email: string
  name: string
  avatarUrl: string | null
}

export interface WorkspaceInfo {
  id: string
  name: string
  role: WorkspaceRole
}

export interface MeResponse {
  user: UserInfo
  devices: DeviceInfo[]
  workspaces: WorkspaceInfo[]
}

export interface GoogleExchangeRequest {
  code: string
  codeVerifier: string
  redirectUri: string
  device: { name: string; platform: string; /** (appended) client-generated id the server may adopt */ id?: string }
}

export interface AuthResponse {
  deviceToken: string
  user: UserInfo
  device: DeviceInfo
}

// ---- Team views ----

export interface ProjectEntry {
  cardId: string
  projectId: string
  userId: string
  userName: string
  startTs: number
  endTs: number
  minutes: number
  shareLevel: ShareLevel
  title: string | null
  summary: string | null
  detailed: string | null
  /** (appended by the sync server) card day, YYYY-MM-DD */
  day?: string
  /** (appended by the sync server) card category; 'cards' level and above, else null */
  category?: string | null
  /** (appended by the sync server) metadata.distractions; 'detailed' level only, else null */
  distractions?: unknown[] | null
}

export interface ProjectReport {
  projectId: string
  from: string
  to: string
  totalMinutes: number
  byMember: { userId: string; userName: string; minutes: number }[]
  byDay: { day: string; minutes: number }[]
  byMemberDay: { userId: string; day: string; minutes: number }[]
  /** (appended by the sync server) '(not shared)' collects entries at 'time' level */
  byCategory?: { category: string; minutes: number }[]
}

/**
 * (sync server) GET /api/workspaces/:id/report — every member's confirmed project time across the
 * workspace. Built from the same team projection as ProjectReport: private cards, unconfirmed
 * guesses and work outside projects never appear.
 */
export interface WorkspaceReport {
  workspaceId: string
  from: string
  to: string
  totalMinutes: number
  /** every current member, including those without time in the range */
  users: {
    userId: string
    userName: string
    email: string
    avatarUrl: string | null
    role: WorkspaceRole
    minutes: number
    activeDays: number
    projectCount: number
    /** hours of timesheet lines sent to Odoo for days in the range */
    odooHours: number
    /** latest last_seen_at of the user's non-revoked devices, ms; null = never synced */
    lastSeenAt: number | null
  }[]
  /** projects with time in the range */
  projects: { projectId: string; name: string; color: string; archived: boolean; minutes: number; userCount: number }[]
  byUserProject: { userId: string; projectId: string; minutes: number }[]
  byUserDay: { userId: string; day: string; minutes: number }[]
  byDay: { day: string; minutes: number }[]
}

// ---- Odoo timesheets ----

export interface TimesheetProposal {
  userId: string
  day: string
  projectId: string
  odooProjectId: number | null
  odooTaskId: number | null
  /** rounded to 0.25 h */
  hours: number
  description: string
  cardIds: string[]
  /** set when a line was already sent for this user/day/project/task */
  existingOdooLineId: number | null
  /** (appended by the sync server) unrounded confirmed minutes */
  minutes?: number
  /** (appended by the sync server) Dayflow project name */
  projectName?: string
}

export interface TimesheetSubmitRequest {
  lines: Pick<TimesheetProposal, 'day' | 'projectId' | 'hours' | 'description' | 'cardIds'>[]
}

export interface TimesheetSubmitResult {
  sent: { day: string; projectId: string; odooLineId: number; updated: boolean }[]
  failed: { day: string; projectId: string; error: string }[]
}

// ---- Appended by the desktop client ----

/** SyncChange.data for entity 'standup' (id `<userId>:<day>`); payload = the client's StandupDraft JSON. */
export interface StandupData {
  userId: string
  day: string
  payload: unknown
}

/** SyncChange.data for entity 'day_goal' (id `<userId>:<day>`); payload = the client's DayGoalPlan. */
export interface DayGoalData {
  userId: string
  day: string
  payload: unknown
}

/** SyncChange.data for entity 'user_doc' (id `<userId>:<kind>`); 'categories' payload = Category[]. */
export interface UserDocData {
  userId: string
  kind: string
  payload: unknown
}

/** GET /api/auth/google/config */
export interface GoogleConfigResponse {
  /** empty when the server has no Google client configured yet */
  clientId: string
  /** true only when the server runs with DEV_AUTH=1 */
  devAuth?: boolean
}

/** POST /api/auth/dev (DEV_AUTH=1 only) → AuthResponse */
export interface DevAuthRequest {
  email: string
  deviceName: string
  platform?: string
  /** client-generated id the server may adopt */
  deviceId?: string
}

/** POST /api/auth/web-link */
export interface WebLinkResponse {
  url: string
}

/** Composite SyncChange.id for 'card_project' and 'project_member' rows. */
export function cardProjectId(cardId: string, projectId: string): string {
  return `${cardId}:${projectId}`
}
export function projectMemberId(projectId: string, userId: string): string {
  return `${projectId}:${userId}`
}

// ---- Appended by the sync server ----

/** GET /api/me/timeline?from&to — the caller's merged cards from all devices. */
export interface TimelineCard {
  id: string
  /** generating device (lane) */
  deviceId: string
  day: string
  startTs: number
  endTs: number
  title: string
  summary: string
  detailedSummary: string
  category: string
  subcategory: string
  metadata: Record<string, unknown>
  isError: boolean
  projects: {
    projectId: string
    projectName: string
    color: string
    icon?: string
    share: number
    source: AssignmentSource
    confidence: number
    confirmed: boolean
  }[]
}
export interface TimelineResponse {
  from: string
  to: string
  devices: DeviceInfo[]
  cards: TimelineCard[]
  /** payload of the caller's user_doc 'categories' (null when never synced) */
  categories?: unknown
}

/**
 * (sync server) GET /api/workspaces/:id/users — workspace admins: every member with their devices and
 * time for the range. trackedMinutes counts every synced card (private, deleted and error cards excluded;
 * personal cards never reach the server; work confirmed only for other workspaces' projects excluded); projectMinutes is the confirmed project time of the team
 * projection. Revoked devices are listed only when they have time in the range.
 */
export interface WorkspaceUsersResponse {
  workspaceId: string
  from: string
  to: string
  users: {
    userId: string
    userName: string
    email: string
    avatarUrl: string | null
    role: WorkspaceRole
    /** the caller's role is below this member's (an admin looking at an owner): no own time, no timeline */
    restricted: boolean
    /** null when restricted */
    trackedMinutes: number | null
    projectMinutes: number
    /** null when restricted */
    activeDays: number | null
    lastSeenAt: number | null
    /** minutes: null when restricted */
    devices: (DeviceInfo & { minutes: number | null })[]
  }[]
}

/** (sync server) GET /api/me/timeline-views — who opened the caller's timeline (latest 100). */
export interface TimelineViewsResponse {
  views: { viewerName: string; viewerEmail: string; workspaceName: string; from: string; to: string; viewedAt: number }[]
}

/**
 * (sync server) GET /api/workspaces/:id/members/:userId/timeline — a member's cards from all of their
 * devices, as a workspace admin may see them. Each card carries `shareLevel`: the lowest share level
 * among its confirmed projects in this workspace (content is cut to it), or null for work outside
 * those projects (time only, title "Out of scope"). Private, deleted and error cards, and work confirmed only
 * for projects of other workspaces, are left out. Admins may not open an owner's timeline; every view by
 * someone else is logged (GET /api/me/timeline-views).
 */
export interface MemberTimelineResponse extends TimelineResponse {
  user: { userId: string; userName: string; email: string; avatarUrl: string | null; role: WorkspaceRole }
  cards: (TimelineCard & { shareLevel: ShareLevel | null })[]
}

/** GET /api/projects/:id/feed?from&to */
export interface ProjectFeedResponse {
  projectId: string
  from: string
  to: string
  entries: ProjectEntry[]
}

/** GET /api/projects/:id/standup?day= */
export interface ProjectStandupMember {
  userId: string
  userName: string
  shareLevel: ShareLevel
  /** day the standup's "done" part describes (usually the previous work day) */
  sourceDay: string
  /** project minutes on `day` and on `sourceDay` */
  minutes: number
  sourceMinutes: number
  /** standup bullets related to the project; empty at 'time' level */
  done: string[]
  next: string[]
  hasStandup: boolean
}
export interface ProjectStandupResponse {
  projectId: string
  day: string
  members: ProjectStandupMember[]
}

// ---- HLC helpers (pure) ----

export function formatHlc(ms: number, counter: number, deviceId: string): string {
  return `${String(Math.max(0, Math.floor(ms))).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${deviceId}`
}

export function parseHlc(hlc: string): { ms: number; counter: number; deviceId: string } | null {
  const m = /^(\d{13})-([0-9a-f]{4})-(.+)$/.exec(hlc)
  if (!m) return null
  return { ms: Number(m[1]), counter: parseInt(m[2], 16), deviceId: m[3] }
}

/** Hybrid logical clock: monotonic per device, advanced by observed remote clocks. */
export class Hlc {
  private ms = 0
  private counter = 0
  private readonly deviceId: string
  private readonly now: () => number

  constructor(deviceId: string, now: () => number = Date.now) {
    this.deviceId = deviceId
    this.now = now
  }

  tick(): string {
    const t = this.now()
    if (t > this.ms) {
      this.ms = t
      this.counter = 0
    } else {
      this.counter++
    }
    return formatHlc(this.ms, this.counter, this.deviceId)
  }

  /** Call with every HLC received from the server so local clocks never fall behind. */
  observe(remote: string): void {
    const r = parseHlc(remote)
    if (!r) return
    const t = this.now()
    const max = Math.max(t, this.ms, r.ms)
    if (max === this.ms && max === r.ms) this.counter = Math.max(this.counter, r.counter) + 1
    else if (max === this.ms) this.counter++
    else if (max === r.ms) this.counter = r.counter + 1
    else this.counter = 0
    this.ms = max
  }
}
