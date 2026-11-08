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
