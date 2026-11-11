import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { addMembership, requireProjectRole, requireWorkspaceRole, roleAtLeast, workspaceRole } from '../access'
import { authenticate } from '../auth/auth'
import type { Auth, Ctx } from '../context'
import { randomToken, sha256 } from '../crypto'
import { withSeqTx, type Queryable } from '../db'
import { badRequest, conflict, forbidden, HttpError, IdParam, notFound, parse, Uuid } from '../http'
import type { WorkspaceRole } from '../shared'
import { addProjectUser, newEffects, processEffects, writeProject, writeProjectMember } from '../sync/engine'
import { ServerClock } from '../sync/hlc'
import { publishEffects } from '../sync/notify'
import { recomputeProjection } from '../sync/projection'
import { OdooMappingZ, ProjectDataZ, ProjectRulesZ, RoleZ, ShareLevelZ } from '../sync/schemas'

const INVITE_TTL_MS = 7 * 86_400_000

const ProjectCreateZ = z.object({
  id: Uuid.optional(),
  name: z.string().trim().min(1).max(200),
  color: z.string().max(32).default(''),
  icon: z.string().max(16).default(''),
  description: z.string().max(5_000).default(''),
  rules: ProjectRulesZ.default({}),
  defaultShare: ShareLevelZ.default('time'),
  odoo: OdooMappingZ.nullish(),
  archived: z.boolean().default(false),
})
const ProjectPatchZ = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  color: z.string().max(32).optional(),
  icon: z.string().max(16).optional(),
  description: z.string().max(5_000).optional(),
  rules: ProjectRulesZ.optional(),
  defaultShare: ShareLevelZ.optional(),
  odoo: OdooMappingZ.nullish(),
  archived: z.boolean().optional(),
})

export function projectView(r: any) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    description: r.description,
    rules: r.rules,
    defaultShare: r.default_share,
    odoo: r.odoo ?? null,
    archived: r.archived,
    hlc: r.hlc,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.getTime() : null,
  }
}

async function memberCountByRole(db: Queryable, workspaceId: string, role: WorkspaceRole) {
  const r = await db.query(`SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = $2`, [workspaceId, role])
  return r.rows[0].n as number
}

export async function workspaceRoutes(app: FastifyInstance, ctx: Ctx) {
  const clock = new ServerClock(ctx.now)
  const auth = (req: Parameters<typeof authenticate>[1]) => authenticate(ctx, req)

  // ---- workspaces & members ----

  app.get('/api/workspaces', async (req) => {
    const a = await auth(req)
    const r = await ctx.db.query(
      `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.created_at`,
      [a.userId],
    )
    return { workspaces: r.rows.map((x) => ({ id: x.id, name: x.name, role: x.role })) }
  })

  app.post('/api/workspaces', async (req) => {
    const a = await auth(req)
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body)
    const id = await withSeqTx(ctx.db, async (tx) => {
      const w = await tx.query(`INSERT INTO workspaces(name) VALUES ($1) RETURNING id`, [name])
      await addMembership(tx, w.rows[0].id, a.userId, 'owner')
      return w.rows[0].id as string
    })
    return { id, name, role: 'owner' }
  })

  app.get('/api/workspaces/:id', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    const role = await requireWorkspaceRole(ctx.db, id, a.userId, 'viewer')
    const w = await ctx.db.query(`SELECT id, name, created_at FROM workspaces WHERE id = $1`, [id])
    return { id, name: w.rows[0].name, role, createdAt: w.rows[0].created_at.getTime() }
  })

  app.patch('/api/workspaces/:id', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    await requireWorkspaceRole(ctx.db, id, a.userId, 'admin')
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body)
    await ctx.db.query(`UPDATE workspaces SET name = $2 WHERE id = $1`, [id, name])
    return { id, name }
  })

  app.get('/api/workspaces/:id/members', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    await requireWorkspaceRole(ctx.db, id, a.userId, 'viewer')
    const r = await ctx.db.query(
      `SELECT u.id, u.email, u.name, u.avatar_url, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 ORDER BY u.name, u.email`,
      [id],
    )
    return {
      members: r.rows.map((x) => ({
        userId: x.id,
        email: x.email,
        name: x.name,
        avatarUrl: x.avatar_url,
        role: x.role,
        joinedAt: x.created_at.getTime(),
      })),
    }
  })

  app.patch('/api/workspaces/:id/members/:userId', async (req) => {
    const a = await auth(req)
    const { id, userId } = parse(z.object({ id: Uuid, userId: Uuid }), req.params)
    const { role } = parse(z.object({ role: RoleZ }), req.body)
    const myRole = await requireWorkspaceRole(ctx.db, id, a.userId, 'admin')
    const target = await workspaceRole(ctx.db, id, userId)
    if (!target) throw notFound('member not found')
    if ((role === 'owner' || target === 'owner') && myRole !== 'owner') throw forbidden('only an owner can grant or revoke owner')
    if (target === 'owner' && role !== 'owner' && (await memberCountByRole(ctx.db, id, 'owner')) <= 1)
      throw conflict('a workspace needs at least one owner')
    await ctx.db.query(`UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [id, userId, role])
    return { userId, role }
  })

  app.delete('/api/workspaces/:id/members/:userId', async (req) => {
    const a = await auth(req)
    const { id, userId } = parse(z.object({ id: Uuid, userId: Uuid }), req.params)
    const myRole = await workspaceRole(ctx.db, id, a.userId)
    if (!myRole) throw notFound('workspace not found')
    const self = userId === a.userId
    if (!self && !roleAtLeast(myRole, 'admin')) throw forbidden('requires admin role')
    const target = await workspaceRole(ctx.db, id, userId)
    if (!target) throw notFound('member not found')
    if (target === 'owner' && !self && myRole !== 'owner') throw forbidden('only an owner can remove an owner')
    if (target === 'owner' && (await memberCountByRole(ctx.db, id, 'owner')) <= 1) throw conflict('a workspace needs at least one owner')
    const fx = newEffects()
    await withSeqTx(ctx.db, async (tx) => {
      await tx.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [id, userId])
      await recomputeProjection(tx, { workspaceId: id, userId })
      const ps = await tx.query(`SELECT id FROM projects WHERE workspace_id = $1`, [id])
      for (const p of ps.rows) fx.feedProjects.add(p.id)
    })
    fx.notifyUsers.add(userId)
    await publishEffects(ctx, fx)
    return { ok: true }
  })

  // ---- invites ----

  app.post('/api/workspaces/:id/invites', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    const body = parse(z.object({ email: z.string().email().max(254), role: RoleZ.default('member') }), req.body)
    const myRole = await requireWorkspaceRole(ctx.db, id, a.userId, 'admin')
    if (body.role === 'owner' && myRole !== 'owner') throw forbidden('only an owner can invite owners')
    const token = randomToken('dfi_', 24)
    const expiresAt = new Date(ctx.now() + INVITE_TTL_MS)
    const r = await ctx.db.query(
      `INSERT INTO invites(workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [id, body.email.toLowerCase(), body.role, sha256(token), a.userId, expiresAt],
    )
    const base = ctx.config.PUBLIC_URL.replace(/\/+$/, '')
    return {
      id: r.rows[0].id,
      email: body.email.toLowerCase(),
      role: body.role,
      token,
      url: `${base}/invite/${token}`,
      expiresAt: expiresAt.getTime(),
    }
  })

  app.get('/api/workspaces/:id/invites', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    await requireWorkspaceRole(ctx.db, id, a.userId, 'admin')
    const r = await ctx.db.query(
      `SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM invites WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [id],
    )
    return {
      invites: r.rows.map((x) => ({
        id: x.id,
        email: x.email,
        role: x.role,
        createdAt: x.created_at.getTime(),
        expiresAt: x.expires_at.getTime(),
        status: x.accepted_at ? 'accepted' : x.revoked_at ? 'revoked' : x.expires_at.getTime() < ctx.now() ? 'expired' : 'pending',
      })),
    }
  })

  app.delete('/api/workspaces/:id/invites/:inviteId', async (req) => {
    const a = await auth(req)
    const { id, inviteId } = parse(z.object({ id: Uuid, inviteId: Uuid }), req.params)
    await requireWorkspaceRole(ctx.db, id, a.userId, 'admin')
    const r = await ctx.db.query(`UPDATE invites SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL RETURNING id`, [
      inviteId,
      id,
    ])
    if (!r.rowCount) throw notFound('invite not found')
    return { ok: true }
  })

  const TokenParam = z.object({ token: z.string().min(10).max(100) })

  async function loadInvite(token: string) {
    const r = await ctx.db.query(
      `SELECT i.*, w.name AS workspace_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = $1`,
      [sha256(token)],
    )
    const inv = r.rows[0]
    if (!inv || inv.revoked_at) throw notFound('invite not found')
    return inv
  }

  app.get('/api/invites/:token', { config: { rateLimit: { max: ctx.config.AUTH_RATE_LIMIT, timeWindow: '1 minute' } } }, async (req) => {
    await auth(req)
    const { token } = parse(TokenParam, req.params)
    const inv = await loadInvite(token)
    return {
      workspaceId: inv.workspace_id,
      workspaceName: inv.workspace_name,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expires_at.getTime(),
      accepted: !!inv.accepted_at,
    }
  })

  app.post('/api/invites/:token/accept', { config: { rateLimit: { max: ctx.config.AUTH_RATE_LIMIT, timeWindow: '1 minute' } } }, async (req) => {
    const a = await auth(req)
    const { token } = parse(TokenParam, req.params)
    const inv = await loadInvite(token)
    if (inv.accepted_at) throw new HttpError(410, 'invite_used', 'invite already accepted')
    if (inv.expires_at.getTime() < ctx.now()) throw new HttpError(410, 'invite_expired', 'invite expired')
    if (inv.email !== a.email.toLowerCase()) throw forbidden('this invite was sent to a different email address')
    const fx = newEffects()
    await withSeqTx(ctx.db, async (tx) => {
      const upd = await tx.query(`UPDATE invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1 AND accepted_at IS NULL RETURNING id`, [
        inv.id,
        a.userId,
      ])
      if (!upd.rowCount) throw new HttpError(410, 'invite_used', 'invite already accepted')
      const existing = await workspaceRole(tx, inv.workspace_id, a.userId)
      // never downgrade an existing member through an invite
      const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const
      const role: WorkspaceRole = existing && RANK[existing as WorkspaceRole] > RANK[inv.role as WorkspaceRole] ? existing : inv.role
      await addMembership(tx, inv.workspace_id, a.userId, role)
      await recomputeProjection(tx, { workspaceId: inv.workspace_id, userId: a.userId })
      fx.workspaces.add(inv.workspace_id)
      await processEffects(tx, fx)
    })
    await publishEffects(ctx, fx)
    return { workspaceId: inv.workspace_id, workspaceName: inv.workspace_name, role: inv.role }
  })

  // ---- projects ----

  app.get('/api/workspaces/:id/projects', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    await requireWorkspaceRole(ctx.db, id, a.userId, 'viewer')
    const q = parse(z.object({ includeArchived: z.enum(['0', '1', 'true', 'false']).optional() }), req.query)
    const all = q.includeArchived === '1' || q.includeArchived === 'true'
    const r = await ctx.db.query(
      `SELECT * FROM projects WHERE workspace_id = $1 AND NOT deleted ${all ? '' : 'AND NOT archived'} ORDER BY name`,
      [id],
    )
    return { projects: r.rows.map(projectView) }
  })

  app.post('/api/workspaces/:id/projects', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    await requireWorkspaceRole(ctx.db, id, a.userId, 'admin')
    const body = parse(ProjectCreateZ, req.body)
    const pid = body.id ?? randomUUID()
    const fx = newEffects()
    await withSeqTx(ctx.db, async (tx) => {
      if ((await tx.query(`SELECT 1 FROM projects WHERE id = $1`, [pid])).rowCount) throw conflict('project id already exists')
      const d = parse(ProjectDataZ, { ...body, workspaceId: id })
      await writeProject(tx, pid, id, d, false, clock.next(), 'server', true)
      fx.workspaces.add(id)
      await processEffects(tx, fx)
    })
    await publishEffects(ctx, fx)
    return getProject(pid)
  })

  async function getProject(pid: string) {
    const r = await ctx.db.query(`SELECT * FROM projects WHERE id = $1`, [pid])
    return projectView(r.rows[0])
  }

  async function patchProject(a: Auth, pid: string, body: unknown, expectWorkspace?: string) {
    const access = await requireProjectRole(ctx.db, pid, a.userId, 'admin')
    if (expectWorkspace && access.workspaceId !== expectWorkspace) throw notFound('project not found')
    const patch = parse(ProjectPatchZ, body)
    const fx = newEffects()
    await withSeqTx(ctx.db, async (tx) => {
      const cur = (await tx.query(`SELECT * FROM projects WHERE id = $1 FOR UPDATE`, [pid])).rows[0]
      const d = parse(ProjectDataZ, {
        workspaceId: cur.workspace_id,
        name: patch.name ?? cur.name,
        color: patch.color ?? cur.color,
        icon: patch.icon ?? cur.icon,
        description: patch.description ?? cur.description,
        rules: patch.rules ?? cur.rules,
        defaultShare: patch.defaultShare ?? cur.default_share,
        odoo: patch.odoo === undefined ? cur.odoo : patch.odoo,
        archived: patch.archived ?? cur.archived,
      })
      await writeProject(tx, pid, cur.workspace_id, d, false, clock.next(cur.hlc), 'server', false)
      fx.workspaces.add(cur.workspace_id)
      if (patch.defaultShare && patch.defaultShare !== cur.default_share) fx.projects.add(pid)
      await processEffects(tx, fx)
    })
    await publishEffects(ctx, fx)
    return getProject(pid)
  }

  async function deleteProject(a: Auth, pid: string, expectWorkspace?: string) {
    const access = await requireProjectRole(ctx.db, pid, a.userId, 'admin')
    if (expectWorkspace && access.workspaceId !== expectWorkspace) throw notFound('project not found')
    const fx = newEffects()
    await withSeqTx(ctx.db, async (tx) => {
      const cur = (await tx.query(`SELECT hlc, workspace_id FROM projects WHERE id = $1 FOR UPDATE`, [pid])).rows[0]
      await writeProject(tx, pid, cur.workspace_id, undefined, true, clock.next(cur.hlc), 'server', false)
      fx.workspaces.add(cur.workspace_id)
      fx.projects.add(pid)
      fx.feedProjects.add(pid)
      await processEffects(tx, fx)
    })
    await publishEffects(ctx, fx)
    return { ok: true, id: pid, deleted: true }
  }

  const WsProject = z.object({ id: Uuid, projectId: Uuid })
  app.get('/api/projects/:id', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    await requireProjectRole(ctx.db, id, a.userId, 'viewer')
    return getProject(id)
  })
  app.patch('/api/workspaces/:id/projects/:projectId', async (req) => {
    const p = parse(WsProject, req.params)
    return patchProject(await auth(req), p.projectId, req.body, p.id)
  })
  app.delete('/api/workspaces/:id/projects/:projectId', async (req) => {
    const p = parse(WsProject, req.params)
    return deleteProject(await auth(req), p.projectId, p.id)
  })
  app.patch('/api/projects/:id', async (req) => patchProject(await auth(req), parse(IdParam, req.params).id, req.body))
  app.delete('/api/projects/:id', async (req) => deleteProject(await auth(req), parse(IdParam, req.params).id))

  // ---- project members (share level overrides) ----

  app.get('/api/projects/:id/members', async (req) => {
    const a = await auth(req)
    const { id } = parse(IdParam, req.params)
    const access = await requireProjectRole(ctx.db, id, a.userId, 'viewer')
    const r = await ctx.db.query(
      `SELECT u.id, u.name, u.email, m.role, pm.share_level, p.default_share
         FROM memberships m JOIN users u ON u.id = m.user_id
         JOIN projects p ON p.id = $2
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id AND NOT pm.deleted
        WHERE m.workspace_id = $1 ORDER BY u.name, u.email`,
      [access.workspaceId, id],
    )
    return {
      members: r.rows.map((x) => ({
        userId: x.id,
        name: x.name,
        email: x.email,
        role: x.role,
        shareLevel: x.share_level,
        effectiveShareLevel: x.share_level ?? x.default_share,
      })),
    }
  })

  app.put('/api/projects/:id/members/:userId', async (req) => {
    const a = await auth(req)
    const { id, userId } = parse(z.object({ id: Uuid, userId: Uuid }), req.params)
    const { shareLevel } = parse(z.object({ shareLevel: ShareLevelZ.nullable() }), req.body)
    const access = await requireProjectRole(ctx.db, id, a.userId, 'viewer')
    if (!roleAtLeast(access.role, 'admin') && userId !== a.userId) throw forbidden('requires admin role')
    if (!(await workspaceRole(ctx.db, access.workspaceId, userId))) throw badRequest('user is not a workspace member')
    const fx = newEffects()
    await withSeqTx(ctx.db, async (tx) => {
      const cur = (await tx.query(`SELECT id, hlc FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])).rows[0]
      await writeProjectMember(tx, cur?.id ?? `${id}:${userId}`, id, userId, shareLevel, false, clock.next(cur?.hlc), 'server', !cur)
      fx.workspaces.add(access.workspaceId)
      addProjectUser(fx, id, userId)
      fx.feedProjects.add(id)
      await processEffects(tx, fx)
    })
    await publishEffects(ctx, fx)
    return { projectId: id, userId, shareLevel }
  })
}
