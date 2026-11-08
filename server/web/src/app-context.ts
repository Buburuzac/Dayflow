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
