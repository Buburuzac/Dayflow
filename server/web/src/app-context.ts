import { createContext, useContext } from 'react'
import type { MeResponse, Project, WorkspaceInfo } from './api/types.ts'

export interface AppState {
  me: MeResponse
  workspace: WorkspaceInfo | null
  setWorkspaceId: (id: string) => void
  /** projects of the current workspace (including archived) */
  projects: Project[]
  projectsLoading: boolean
  reloadProjects: () => void
  isAdmin: boolean
}

export const AppContext = createContext<AppState | null>(null)

export function useApp(): AppState {
  const v = useContext(AppContext)
  if (!v) throw new Error('AppContext missing')
  return v
}

export const isAdminRole = (role: string | undefined) => role === 'owner' || role === 'admin'

const RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }
/** Admins open the timelines of admins, members and viewers; only owners open an owner's timeline. */
export const canViewTimeline = (callerRole: string | undefined, targetRole: string) =>
  isAdminRole(callerRole) && (RANK[callerRole ?? ''] ?? -1) >= (RANK[targetRole] ?? 99)
