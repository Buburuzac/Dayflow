import type { Ctx } from '../context'
import { withTx } from '../db'
import { cardMinutesSQL } from '../sync/card-time'
import type { OdooMapping, TimesheetProposal, TimesheetSubmitRequest, TimesheetSubmitResult } from '../shared'
import { OdooClient, type OdooCreds } from './client'

export interface EmployeeMapEntry {
  employeeId: number
  odooUserId?: number | null
  employeeName?: string
}
export type EmployeeMap = Record<string, EmployeeMapEntry>

export interface OdooConnection {
  workspaceId: string
  creds: OdooCreds
  employeeMap: EmployeeMap
  /** true when the connection comes from ODOO_* environment defaults */
  fromEnv: boolean
}

/** Rounds hours to the nearest quarter hour. */
export const roundQuarter = (hours: number) => Math.round(hours * 4) / 4

export async function loadConnection(ctx: Ctx, workspaceId: string): Promise<OdooConnection | null> {
  const r = await ctx.db.query(`SELECT * FROM odoo_connections WHERE workspace_id = $1`, [workspaceId])
  const row = r.rows[0]
  if (row) {
    return {
      workspaceId,
      creds: { url: row.url, db: row.db, login: row.login, apiKey: ctx.box.decrypt(row.api_key_encrypted) },
      employeeMap: row.employee_map ?? {},
      fromEnv: false,
    }
  }
  const c = ctx.config
  if (c.ODOO_URL && c.ODOO_DB && c.ODOO_LOGIN && c.ODOO_API_KEY) {
    return { workspaceId, creds: { url: c.ODOO_URL, db: c.ODOO_DB, login: c.ODOO_LOGIN, apiKey: c.ODOO_API_KEY }, employeeMap: {}, fromEnv: true }
  }
  return null
}

export const clientFor = (ctx: Ctx, creds: OdooCreds) => new OdooClient(creds, ctx.fetch)

interface ProposalRow {
  day: string
  project_id: string
  project_name: string
  odoo: OdooMapping | null
  card_id: string
  title: string
  private: boolean
  minutes: number
}

/** Confirmed card_project minutes of one user per (day, project) in a workspace, rounded to 0.25 h. */
export async function buildProposals(
  ctx: Ctx,
  userId: string,
  workspaceId: string,
  from: string,
  to: string,
): Promise<TimesheetProposal[]> {
  const r = await ctx.db.query<ProposalRow>(
    `SELECT c.day, p.id AS project_id, p.name AS project_name, p.odoo, c.id AS card_id, c.title, c.private,
            ${cardMinutesSQL()}
              * LEAST(1, GREATEST(0, cp.share))
              * CASE WHEN t.total > 1 THEN 1 / t.total ELSE 1 END AS minutes
       FROM card_projects cp
       JOIN cards c ON c.id = cp.card_id AND c.user_id = cp.user_id
       JOIN projects p ON p.id = cp.project_id AND p.workspace_id = $2 AND NOT p.deleted
       CROSS JOIN LATERAL (
         SELECT SUM(LEAST(1, GREATEST(0, x.share))) AS total FROM card_projects x
          WHERE x.card_id = c.id AND x.user_id = c.user_id AND x.confirmed AND NOT x.deleted
       ) t
      WHERE cp.user_id = $1 AND cp.confirmed AND NOT cp.deleted AND NOT c.deleted AND NOT c.is_error
        AND c.day BETWEEN $3 AND $4
      ORDER BY c.day, c.start_ts`,
    [userId, workspaceId, from, to],
  )
  const groups = new Map<string, { rows: ProposalRow[]; minutes: number }>()
  for (const row of r.rows) {
    const k = `${row.day}|${row.project_id}`
    const g = groups.get(k) ?? { rows: [], minutes: 0 }
    g.rows.push(row)
    g.minutes += Number(row.minutes)
    groups.set(k, g)
  }
  const sent = await ctx.db.query(
    `SELECT day, project_id, task_key, odoo_line_id FROM timesheet_exports
      WHERE user_id = $1 AND workspace_id = $2 AND day BETWEEN $3 AND $4 AND odoo_line_id IS NOT NULL`,
    [userId, workspaceId, from, to],
  )
  const sentBy = new Map(sent.rows.map((s) => [`${s.day}|${s.project_id}|${s.task_key}`, s.odoo_line_id as number]))
  const out: TimesheetProposal[] = []
  for (const g of groups.values()) {
    const first = g.rows[0]
    const hours = roundQuarter(g.minutes / 60)
    if (hours <= 0) continue
    const taskId = first.odoo?.taskId ?? null
    out.push({
      userId,
      day: first.day,
      projectId: first.project_id,
      projectName: first.project_name,
      odooProjectId: first.odoo?.projectId ?? null,
      odooTaskId: taskId,
      hours,
      minutes: Math.round(g.minutes * 100) / 100,
      description: describe(g.rows),
      cardIds: [...new Set(g.rows.map((x) => x.card_id))],
      existingOdooLineId: sentBy.get(`${first.day}|${first.project_id}|${taskId ?? 0}`) ?? null,
    })
  }
  return out
}

/** Card titles in time order, de-duplicated; private cards contribute minutes but never their titles. */
function describe(rows: ProposalRow[]): string {
  const titles: string[] = []
  for (const r of rows) {
    const t = r.private ? '' : r.title.trim()
    if (t && !titles.includes(t)) titles.push(t)
  }
  const s = titles.join('; ')
  return (s || rows[0].project_name).slice(0, 1000)
}

type Line = TimesheetSubmitRequest['lines'][number]

/**
 * Creates or updates `account.analytic.line` records. Idempotent per user + day + project + task:
 * a second submit writes to the line created by the first one.
 */
export async function submitLines(ctx: Ctx, userId: string, lines: Line[]): Promise<TimesheetSubmitResult> {
  const result: TimesheetSubmitResult = { sent: [], failed: [] }
  const conns = new Map<string, OdooConnection | null>()
  const clients = new Map<string, OdooClient>()

  for (const line of lines) {
    const fail = (error: string) => result.failed.push({ day: line.day, projectId: line.projectId, error })
    const p = (
      await ctx.db.query(
        `SELECT p.id, p.workspace_id, p.name, p.odoo, m.role FROM projects p
           LEFT JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
          WHERE p.id = $1 AND NOT p.deleted`,
        [line.projectId, userId],
      )
    ).rows[0]
    if (!p || !p.role) {
      fail('project not found')
      continue
    }
    if (p.role === 'viewer') {
      fail('viewers cannot submit timesheets')
      continue
    }
    const odoo = (p.odoo ?? {}) as OdooMapping
    if (!odoo.projectId) {
      fail('project is not mapped to an Odoo project')
      continue
    }
    if (!conns.has(p.workspace_id)) conns.set(p.workspace_id, await loadConnection(ctx, p.workspace_id))
    const conn = conns.get(p.workspace_id)
    if (!conn) {
      fail('Odoo connection is not configured for this workspace')
      continue
    }
    const emp = conn.employeeMap[userId]
    if (!emp?.employeeId) {
      fail('your account is not mapped to an Odoo employee')
      continue
    }
    const hours = roundQuarter(line.hours)
    if (hours <= 0 || hours > 24) {
      fail('hours must be between 0.25 and 24')
      continue
    }
    let client = clients.get(p.workspace_id)
    if (!client) clients.set(p.workspace_id, (client = clientFor(ctx, conn.creds)))

    const ownCards = (
      await ctx.db.query<{ id: string }>(`SELECT id FROM cards WHERE id = ANY($1::uuid[]) AND user_id = $2`, [line.cardIds, userId])
    ).rows.map((x) => x.id)
    const taskId = odoo.taskId ?? null
    const vals: Record<string, unknown> = {
      name: line.description.trim() || p.name,
      date: line.day,
      unit_amount: hours,
      project_id: odoo.projectId,
      employee_id: emp.employeeId,
    }
    if (taskId) vals.task_id = taskId
    if (emp.odooUserId) vals.user_id = emp.odooUserId

    try {
      const sent = await withTx(ctx.db, async (tx) => {
        // the row lock serialises concurrent submits of the same key
        await tx.query(
          `INSERT INTO timesheet_exports(workspace_id, project_id, user_id, day, odoo_project_id, odoo_task_id, task_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, day, project_id, task_key) DO NOTHING`,
          [p.workspace_id, p.id, userId, line.day, odoo.projectId, taskId, taskId ?? 0],
        )
        const row = (
          await tx.query(
            `SELECT id, odoo_line_id FROM timesheet_exports WHERE user_id = $1 AND day = $2 AND project_id = $3 AND task_key = $4 FOR UPDATE`,
            [userId, line.day, p.id, taskId ?? 0],
          )
        ).rows[0]
        try {
          let lineId: number
          let updated = false
          if (row.odoo_line_id && (await client!.exists('account.analytic.line', row.odoo_line_id))) {
            await client!.write('account.analytic.line', [row.odoo_line_id], vals)
            lineId = row.odoo_line_id
            updated = true
          } else {
            lineId = await client!.create('account.analytic.line', vals)
          }
          await tx.query(
            `UPDATE timesheet_exports SET odoo_line_id = $2, status = 'sent', error = NULL, sent_at = now(), minutes = $3, hours = $4,
                    description = $5, card_ids = $6::uuid[], odoo_project_id = $7, odoo_task_id = $8 WHERE id = $1`,
            [row.id, lineId, hours * 60, hours, vals.name, ownCards, odoo.projectId, taskId],
          )
          return { lineId, updated }
        } catch (e) {
          await tx.query(`UPDATE timesheet_exports SET status = 'failed', error = $2 WHERE id = $1`, [row.id, (e as Error).message.slice(0, 500)])
          return { error: (e as Error).message }
        }
      })
      if ('error' in sent) fail(sent.error!)
      else result.sent.push({ day: line.day, projectId: line.projectId, odooLineId: sent.lineId!, updated: sent.updated! })
    } catch (e) {
      fail((e as Error).message)
    }
  }
  return result
}
