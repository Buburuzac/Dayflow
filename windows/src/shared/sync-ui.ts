// Types the sync:* / projects:* IPC channels return to the renderer (desktop-only; the wire
// contract with the server is sync-types.ts).

import type { DeviceInfo, OdooMapping, ProjectRules, ShareLevel, TimesheetProposal, UserInfo, WorkspaceInfo } from './sync-types.ts'

export const DEFAULT_SYNC_SERVER_URL = 'http://192.168.0.90:8790'

export interface SyncStatus {
  serverUrl: string
  signedIn: boolean
  user: UserInfo | null
  deviceId: string
  deviceName: string
  workspaces: WorkspaceInfo[]
  lastSyncAt: number | null
  lastPushAt: number | null
  lastPullAt: number | null
  pending: number
  lastError: string | null
  syncing: boolean
  streamConnected: boolean
}

export interface AuthConfigStatus {
  /** Server reachable and answered /api/auth/google/config */
  reachable: boolean
  googleConfigured: boolean
  devAuth: boolean
  error: string | null
}

export interface ProjectView {
  id: string
  workspaceId: string
  name: string
  color: string
  icon?: string
  description: string
  rules: ProjectRules
  defaultShare: ShareLevel
  odoo: OdooMapping
  archived: boolean
  /** The signed-in user's override (null = project default) */
  myShare: ShareLevel | null
}

export interface ProjectDraft {
  id?: string
  workspaceId: string
  name: string
  color: string
  icon?: string
  description: string
  rules: ProjectRules
  defaultShare: ShareLevel
  odoo: OdooMapping
  archived?: boolean
}

export interface TimesheetProposalsView {
  proposals: TimesheetProposal[]
  odooConfigured: boolean
  employeeMapped: boolean
}

export interface MeView {
  user: UserInfo
  devices: DeviceInfo[]
  workspaces: WorkspaceInfo[]
}
