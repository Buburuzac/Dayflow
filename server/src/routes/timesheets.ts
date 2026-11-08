import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireWorkspaceRole } from '../access'
import { authenticate } from '../auth/auth'
import type { Ctx } from '../context'
import { Day, DayRange, parse, Uuid } from '../http'
import { buildProposals, loadConnection, submitLines } from '../odoo/timesheets'

const SubmitZ = z.object({
  lines: z
    .array(
      z.object({
        day: Day,
        projectId: Uuid,
        hours: z.number().min(0).max(24),
        description: z.string().max(2_000).default(''),
        cardIds: z.array(Uuid).max(2_000).default([]),
      }),
    )
    .min(1)
    .max(500),
})

export async function timesheetRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/timesheets/proposals', async (req) => {
    const auth = await authenticate(ctx, req)
    const q = parse(z.object({ from: Day, to: Day, workspaceId: Uuid }), req.query)
    parse(DayRange(93), q)
    await requireWorkspaceRole(ctx.db, q.workspaceId, auth.userId, 'viewer')
    const conn = await loadConnection(ctx, q.workspaceId)
    const proposals = await buildProposals(ctx, auth.userId, q.workspaceId, q.from, q.to)
    return {
      workspaceId: q.workspaceId,
      from: q.from,
      to: q.to,
      odooConfigured: !!conn,
      employeeMapped: !!conn?.employeeMap[auth.userId]?.employeeId,
      proposals,
    }
  })

  // Writes to Odoo only on this explicit request.
  app.post('/api/timesheets/submit', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await authenticate(ctx, req)
    const body = parse(SubmitZ, req.body)
    return submitLines(ctx, auth.userId, body.lines)
  })

  app.get('/api/timesheets/exports', async (req) => {
    const auth = await authenticate(ctx, req)
    const q = parse(z.object({ from: Day, to: Day, workspaceId: Uuid.optional() }), req.query)
    parse(DayRange(366), q)
    const r = await ctx.db.query(
      `SELECT e.*, p.name AS project_name FROM timesheet_exports e JOIN projects p ON p.id = e.project_id
        WHERE e.user_id = $1 AND e.day BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR e.workspace_id = $4)
        ORDER BY e.day, p.name`,
      [auth.userId, q.from, q.to, q.workspaceId ?? null],
    )
    return {
      exports: r.rows.map((x) => ({
        id: x.id,
        workspaceId: x.workspace_id,
        projectId: x.project_id,
        projectName: x.project_name,
        day: x.day,
        hours: x.hours,
        description: x.description,
        odooProjectId: x.odoo_project_id,
        odooTaskId: x.odoo_task_id,
        odooLineId: x.odoo_line_id,
        status: x.status,
        error: x.error,
        cardIds: x.card_ids,
        sentAt: x.sent_at ? x.sent_at.getTime() : null,
      })),
    }
  })
}
