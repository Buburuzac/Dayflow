import type { Queryable } from './db'
import { forbidden, notFound } from './http'
import type { WorkspaceRole } from './shared'

const RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

export function roleAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  return role != null && RANK[role] >= RANK[min]
}

export async function workspaceRole(db: Queryable, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const r = await db.query<{ role: WorkspaceRole }>(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [
    workspaceId,
    userId,
  ])
  return r.rows[0]?.role ?? null
}

/** Throws 404 for non-members (no existence leak) and 403 when the role is too low. */
export async function requireWorkspaceRole(
  db: Queryable,
  workspaceId: string,
  userId: string,
  min: WorkspaceRole,
): Promise<WorkspaceRole> {
  const role = await workspaceRole(db, workspaceId, userId)
  if (!role) throw notFound('workspace not found')
  if (!roleAtLeast(role, min)) throw forbidden(`requires ${min} role`)
  return role
}

export interface ProjectAccess {
  projectId: string
  workspaceId: string
  role: WorkspaceRole
  deleted: boolean
}

export async function requireProjectRole(
  db: Queryable,
  projectId: string,
  userId: string,
  min: WorkspaceRole,
): Promise<ProjectAccess> {
  const r = await db.query(
    `SELECT p.workspace_id, p.deleted, m.role FROM projects p
       LEFT JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.id = $1`,
    [projectId, userId],
  )
  const row = r.rows[0]
  if (!row || !row.role || row.deleted) throw notFound('project not found')
  if (!roleAtLeast(row.role, min)) throw forbidden(`requires ${min} role`)
  return { projectId, workspaceId: row.workspace_id, role: row.role, deleted: row.deleted }
}

/**
 * Adds a member and re-stamps the workspace's projects so the new member's devices pull them
 * even though their cursors are already past the original server_seq.
 */
export async function addMembership(tx: Queryable, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await tx.query(
    `INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role],
  )
  await touchWorkspace(tx, workspaceId)
}

export async function touchWorkspace(tx: Queryable, workspaceId: string): Promise<void> {
  await tx.query(`UPDATE projects SET server_seq = nextval('sync_seq') WHERE workspace_id = $1`, [workspaceId])
  await tx.query(
    `UPDATE project_members SET server_seq = nextval('sync_seq')
      WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = $1)`,
    [workspaceId],
  )
}

export async function workspaceMemberIds(db: Queryable, workspaceId: string): Promise<string[]> {
  const r = await db.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE workspace_id = $1`, [workspaceId])
  return r.rows.map((x) => x.user_id)
}
