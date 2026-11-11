// Dashboard-side DTOs. Shared contract types come from windows/src/shared/sync-types.ts (single source);
// the types below describe response shapes the design doc leaves open (see README "API surface").

import type {
  OdooMapping,
  ProjectData,
  ProjectRules,
  ShareLevel,
  TimelineCard as SharedTimelineCard,
  TimelineResponse as SharedTimelineResponse,
  WorkspaceRole,
} from '../../../../windows/src/shared/sync-types.ts'
import type { Category } from '../lib/categories.ts'
import type { TimesheetProposal } from '../../../../windows/src/shared/sync-types.ts'

export type {
  CardData,
  CardProjectData,
  DeviceInfo,
  MeResponse,
  OdooMapping,
  ProjectData,
  ProjectEntry,
  ProjectReport,
  ProjectRules,
  ShareLevel,
  TimesheetProposal,
  TimesheetSubmitRequest,
  TimesheetSubmitResult,
  UserInfo,
  WorkspaceInfo,
  WorkspaceRole,
  ProjectFeedResponse,
  ProjectStandupResponse,
  WorkspaceReport,
  MemberTimelineResponse,
  WorkspaceUsersResponse,
  TimelineViewsResponse,
} from '../../../../windows/src/shared/sync-types.ts'

export interface Project extends ProjectData {
  id: string
}

export type ProjectInput = Partial<Omit<ProjectData, 'workspaceId' | 'odoo'>> & { rules?: ProjectRules; odoo?: OdooMapping | null }

/** GET /api/me/timeline — shared TimelineResponse plus the optional categories doc (not yet served). */
export type TimelineCard = SharedTimelineCard & {
  /** member timelines (admin view) only: level the card is shown at; null = outside projects, time only */
  shareLevel?: ShareLevel | null
}
export interface TimelineResponse extends SharedTimelineResponse {
  /** payload of user_doc 'categories' — requested from the server, defaults used until then */
  categories?: Category[] | null
}

export interface Member {
  userId: string
  email: string
  name: string
  avatarUrl: string | null
  role: WorkspaceRole
}

export interface Invite {
  id: string
  email: string
  role: WorkspaceRole
  expiresAt: number | string | null
  status?: 'pending' | 'accepted' | 'revoked' | 'expired'
  url?: string
}

export interface ProjectMemberShare {
  userId: string
  shareLevel: ShareLevel | null
}

export interface StandupItem {
  title: string | null
  summary: string | null
  minutes?: number
}

/** ProjectStandupMember with bullets normalised to items. */
export interface StandupMember {
  userId: string
  userName: string
  shareLevel: ShareLevel
  sourceDay?: string
  minutes?: number
  sourceMinutes?: number
  hasStandup?: boolean
  done: StandupItem[]
  next: StandupItem[]
}

export interface StandupResponse {
  projectId: string
  day: string
  members: StandupMember[]
}

export interface EmployeeMapEntry {
  employeeId: number
  odooUserId?: number | null
  employeeName?: string
}

/** GET /api/workspaces/:id/odoo (when configured) */
export interface OdooConnection {
  url: string
  db: string
  login: string
  /** true when an API key is stored; the key itself is never returned */
  hasApiKey: boolean
  /** connection comes from the server's ODOO_* env defaults */
  fromEnv?: boolean
  /** userId → hr.employee */
  employeeMap: Record<string, EmployeeMapEntry>
}

/** PUT /api/workspaces/:id/odoo */
export interface OdooConnectionInput {
  url: string
  db: string
  login: string
  /** omitted = keep the stored key */
  apiKey?: string
}

/** GET /api/timesheets/proposals */
export interface ProposalsResponse {
  odooConfigured: boolean
  employeeMapped: boolean
  proposals: TimesheetProposal[]
}

export interface OdooTestResult {
  ok: boolean
  error?: string
  serverVersion?: string
  uid?: number
}
