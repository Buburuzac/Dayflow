import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireWorkspaceRole } from '../access'
import { authenticate } from '../auth/auth'
import type { Ctx } from '../context'
import { badRequest, HttpError, IdParam, notFound, parse, Uuid } from '../http'
import { OdooError } from '../odoo/client'
import { clientFor, loadConnection, type EmployeeMap } from '../odoo/timesheets'

const HttpUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')

const ConnZ = z.object({
  url: HttpUrl,
  db: z.string().min(1).max(200),
  login: z.string().min(1).max(254),
  /** omitted on update = keep the stored key */
  apiKey: z.string().min(1).max(500).optional(),
})

const TestZ = z.object({
  url: HttpUrl.optional(),
  db: z.string().min(1).max(200).optional(),
  login: z.string().min(1).max(254).optional(),
  apiKey: z.string().min(1).max(500).optional(),
})

const MapEntryZ = z.object({
  employeeId: z.number().int().positive(),
  odooUserId: z.number().int().positive().nullish(),
  employeeName: z.string().max(300).optional(),
})

const odooFail = (e: unknown) => {
  if (e instanceof OdooError) return new HttpError(502, `odoo_${e.kind}`, e.message)
  return e
}

export async function odooAdminRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = async (req: any) => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    await requireWorkspaceRole(ctx.db, id, auth.userId, 'admin')
    return { auth, workspaceId: id }
  }
  const connected = async (workspaceId: string) => {
    const conn = await loadConnection(ctx, workspaceId)
    if (!conn) throw notFound('Odoo connection is not configured')
    return conn
  }

  app.get('/api/workspaces/:id/odoo', async (req) => {
    const { workspaceId } = await admin(req)
    const r = await ctx.db.query(`SELECT url, db, login, employee_map, updated_at FROM odoo_connections WHERE workspace_id = $1`, [workspaceId])
    const row = r.rows[0]
    if (!row) {
      const env = await loadConnection(ctx, workspaceId)
      return env
        ? { configured: true, fromEnv: true, url: env.creds.url, db: env.creds.db, login: env.creds.login, hasApiKey: true, employeeMap: {} }
        : { configured: false }
    }
    return {
      configured: true,
      fromEnv: false,
      url: row.url,
      db: row.db,
      login: row.login,
      hasApiKey: true,
      employeeMap: row.employee_map,
      updatedAt: row.updated_at.getTime(),
    }
  })

  app.put('/api/workspaces/:id/odoo', async (req) => {
    const { workspaceId } = await admin(req)
    const body = parse(ConnZ, req.body)
    const cur = await ctx.db.query(`SELECT api_key_encrypted FROM odoo_connections WHERE workspace_id = $1`, [workspaceId])
    if (!body.apiKey && !cur.rowCount) throw badRequest('apiKey is required')
    const enc = body.apiKey ? ctx.box.encrypt(body.apiKey) : cur.rows[0].api_key_encrypted
    await ctx.db.query(
      `INSERT INTO odoo_connections(workspace_id, url, db, login, api_key_encrypted) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id) DO UPDATE SET url = $2, db = $3, login = $4, api_key_encrypted = $5, updated_at = now()`,
      [workspaceId, body.url.replace(/\/+$/, ''), body.db, body.login, enc],
    )
    return { configured: true, url: body.url.replace(/\/+$/, ''), db: body.db, login: body.login, hasApiKey: true }
  })

  app.delete('/api/workspaces/:id/odoo', async (req) => {
    const { workspaceId } = await admin(req)
    await ctx.db.query(`DELETE FROM odoo_connections WHERE workspace_id = $1`, [workspaceId])
    return { ok: true }
  })

  /** Calls common.version and common.authenticate with the stored settings, optionally overridden by the body. */
  app.post('/api/workspaces/:id/odoo/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { workspaceId } = await admin(req)
    const body = parse(TestZ, req.body ?? {})
    const stored = await loadConnection(ctx, workspaceId)
    const creds = {
      url: body.url ?? stored?.creds.url ?? '',
      db: body.db ?? stored?.creds.db ?? '',
      login: body.login ?? stored?.creds.login ?? '',
      apiKey: body.apiKey ?? stored?.creds.apiKey ?? '',
    }
    if (!creds.url || !creds.db || !creds.login || !creds.apiKey) throw badRequest('url, db, login and apiKey are required')
    const client = clientFor(ctx, creds)
    let version: Record<string, unknown> | null = null
    try {
      version = await client.version()
      const uid = await client.authenticate()
      return { ok: true, serverVersion: version.server_version ?? null, uid }
    } catch (e) {
      return { ok: false, serverVersion: version?.server_version ?? null, error: (e as Error).message }
    }
  })

  app.put('/api/workspaces/:id/odoo/employee-map', async (req) => {
    const { workspaceId } = await admin(req)
    const { map } = parse(z.object({ map: z.record(Uuid, MapEntryZ) }), req.body)
    const r = await ctx.db.query(`UPDATE odoo_connections SET employee_map = $2, updated_at = now() WHERE workspace_id = $1 RETURNING employee_map`, [
      workspaceId,
      JSON.stringify(map),
    ])
    if (!r.rowCount) throw notFound('configure the Odoo connection first')
    return { employeeMap: r.rows[0].employee_map }
  })

  app.patch('/api/workspaces/:id/odoo/employee-map/:userId', async (req) => {
    const { workspaceId } = await admin(req)
    const { userId } = parse(z.object({ id: Uuid, userId: Uuid }), req.params)
    const entry = parse(MapEntryZ.nullable(), req.body ?? null)
    const r = entry
      ? await ctx.db.query(
          `UPDATE odoo_connections SET employee_map = employee_map || jsonb_build_object($2::text, $3::jsonb), updated_at = now()
            WHERE workspace_id = $1 RETURNING employee_map`,
          [workspaceId, userId, JSON.stringify(entry)],
        )
      : await ctx.db.query(
          `UPDATE odoo_connections SET employee_map = employee_map - $2::text, updated_at = now() WHERE workspace_id = $1 RETURNING employee_map`,
          [workspaceId, userId],
        )
    if (!r.rowCount) throw notFound('configure the Odoo connection first')
    return { employeeMap: r.rows[0].employee_map }
  })

  /** Maps unmapped members by email: hr.employee.work_email and res.users.login. Read-only on the Odoo side. */
  app.post('/api/workspaces/:id/odoo/auto-map', async (req) => {
    const { workspaceId } = await admin(req)
    const conn = await connected(workspaceId)
    if (conn.fromEnv) throw badRequest('save the connection in the workspace first')
    const members = await ctx.db.query(
      `SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1`,
      [workspaceId],
    )
    const emails = members.rows.map((m) => m.email as string)
    const client = clientFor(ctx, conn.creds)
    try {
      const [emps, users] = await Promise.all([
        client.searchRead('hr.employee', [['work_email', 'in', emails]], ['id', 'name', 'work_email', 'user_id'], { limit: 500 }),
        client.searchRead('res.users', [['login', 'in', emails]], ['id', 'login'], { limit: 500 }),
      ])
      const map: EmployeeMap = { ...conn.employeeMap }
      const matched: string[] = []
      for (const m of members.rows) {
        if (map[m.id]?.employeeId) continue
        const e = emps.find((x) => String(x.work_email ?? '').toLowerCase() === m.email)
        if (!e) continue
        const u = users.find((x) => String(x.login ?? '').toLowerCase() === m.email)
        const empUser = Array.isArray(e.user_id) ? (e.user_id[0] as number) : null
        map[m.id] = { employeeId: e.id as number, odooUserId: (u?.id as number) ?? empUser, employeeName: String(e.name ?? '') }
        matched.push(m.id)
      }
      await ctx.db.query(`UPDATE odoo_connections SET employee_map = $2, updated_at = now() WHERE workspace_id = $1`, [workspaceId, JSON.stringify(map)])
      return { matched, employeeMap: map, unmatched: members.rows.filter((m) => !map[m.id]).map((m) => m.id) }
    } catch (e) {
      throw odooFail(e)
    }
  })

  const SearchQ = z.object({ search: z.string().max(100).optional(), projectId: z.coerce.number().int().positive().optional() })

  app.get('/api/workspaces/:id/odoo/employees', async (req) => {
    const { workspaceId } = await admin(req)
    const q = parse(SearchQ, req.query)
    const client = clientFor(ctx, (await connected(workspaceId)).creds)
    try {
      const rows = await client.searchRead('hr.employee', q.search ? [['name', 'ilike', q.search]] : [], ['id', 'name', 'work_email', 'user_id'], {
        limit: 100,
        order: 'name',
      })
      return { employees: rows.map((r) => ({ id: r.id, name: r.name, workEmail: r.work_email || null, userId: Array.isArray(r.user_id) ? r.user_id[0] : null })) }
    } catch (e) {
      throw odooFail(e)
    }
  })

  app.get('/api/workspaces/:id/odoo/projects', async (req) => {
    const { workspaceId } = await admin(req)
    const q = parse(SearchQ, req.query)
    const client = clientFor(ctx, (await connected(workspaceId)).creds)
    try {
      const rows = await client.searchRead('project.project', q.search ? [['name', 'ilike', q.search]] : [], ['id', 'name'], { limit: 100, order: 'name' })
      return { projects: rows.map((r) => ({ id: r.id, name: r.name })) }
    } catch (e) {
      throw odooFail(e)
    }
  })

  app.get('/api/workspaces/:id/odoo/tasks', async (req) => {
    const { workspaceId } = await admin(req)
    const q = parse(SearchQ, req.query)
    const domain: unknown[] = []
    if (q.projectId) domain.push(['project_id', '=', q.projectId])
    if (q.search) domain.push(['name', 'ilike', q.search])
    const client = clientFor(ctx, (await connected(workspaceId)).creds)
    try {
      const rows = await client.searchRead('project.task', domain, ['id', 'name', 'project_id'], { limit: 200, order: 'name' })
      return { tasks: rows.map((r) => ({ id: r.id, name: r.name, projectId: Array.isArray(r.project_id) ? r.project_id[0] : null })) }
    } catch (e) {
      throw odooFail(e)
    }
  })
}
