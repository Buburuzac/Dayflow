import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProjectRole } from '../access'
import { authenticate, deviceInfo } from '../auth/auth'
import type { Ctx } from '../context'
import { Day, DayRange, IdParam, parse } from '../http'
import type { ProjectEntry, ProjectReport, ProjectStandupResponse, ShareLevel, TimelineResponse } from '../shared'

export function entryView(r: any): ProjectEntry {
  return {
    cardId: r.card_id,
    projectId: r.project_id,
    userId: r.user_id,
    userName: r.user_name || r.user_email,
    day: r.day,
    startTs: r.start_ts,
    endTs: r.end_ts,
    minutes: Math.round(r.minutes * 100) / 100,
    shareLevel: r.share_level,
    title: r.title,
    summary: r.summary,
    category: r.category,
    detailed: r.detailed,
    distractions: r.distractions,
  }
}

const STOP = new Set(['with', 'from', 'that', 'this', 'have', 'into', 'about', 'were', 'will', 'work', 'working', 'review', 'and', 'the'])
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  )

/** Standup bullets are free text; keep the ones that clearly relate to the project's cards. */
export function bulletMatches(text: string, projectTerms: string[], cardTitles: string[]): boolean {
  const low = text.toLowerCase()
  if (projectTerms.some((t) => t.length >= 3 && low.includes(t.toLowerCase()))) return true
  const tt = tokens(text)
  for (const title of cardTitles) {
    let common = 0
    for (const t of tokens(title)) if (tt.has(t)) common++
    if (common >= 2) return true
  }
  return false
}

function bullets(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list
    .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : ''))
    .filter((s) => s.trim().length > 0)
}

export async function teamRoutes(app: FastifyInstance, ctx: Ctx) {
  // The caller's own merged cards from all devices (device lanes).
  app.get('/api/me/timeline', async (req): Promise<TimelineResponse> => {
    const auth = await authenticate(ctx, req)
    const { from, to } = parse(DayRange(93), req.query)
    const [devices, cards, links, cats] = await Promise.all([
      ctx.db.query(`SELECT id, name, platform, last_seen_at, revoked_at FROM devices WHERE user_id = $1 ORDER BY created_at`, [auth.userId]),
      ctx.db.query(
        `SELECT * FROM cards WHERE user_id = $1 AND day BETWEEN $2 AND $3 AND NOT deleted ORDER BY start_ts`,
        [auth.userId, from, to],
      ),
      ctx.db.query(
        `SELECT cp.card_id, cp.project_id, cp.share, cp.source, cp.confidence, cp.confirmed, p.name, p.color
           FROM card_projects cp JOIN cards c ON c.id = cp.card_id AND c.user_id = cp.user_id
           JOIN projects p ON p.id = cp.project_id AND NOT p.deleted
          WHERE cp.user_id = $1 AND NOT cp.deleted AND c.day BETWEEN $2 AND $3`,
        [auth.userId, from, to],
      ),
      ctx.db.query(`SELECT payload FROM user_docs WHERE id = $1 AND NOT deleted`, [`${auth.userId}:categories`]),
    ])
    const byCard = new Map<string, TimelineResponse['cards'][number]['projects']>()
    for (const l of links.rows) {
      const list = byCard.get(l.card_id) ?? []
      list.push({
        projectId: l.project_id,
        projectName: l.name,
        color: l.color,
        share: l.share,
        source: l.source,
        confidence: l.confidence,
        confirmed: l.confirmed,
      })
      byCard.set(l.card_id, list)
    }
    return {
      from,
      to,
      devices: devices.rows.map((d) => deviceInfo(d, auth.deviceId)),
      categories: cats.rows[0]?.payload ?? null,
      cards: cards.rows.map((c) => ({
        id: c.id,
        deviceId: c.device_id,
        day: c.day,
        startTs: c.start_ts,
        endTs: c.end_ts,
        title: c.title,
        summary: c.summary,
        detailedSummary: c.detailed_summary,
        category: c.category,
        subcategory: c.subcategory,
        metadata: { ...c.metadata, ...(c.private ? { private: true } : {}) },
        isError: c.is_error,
        projects: byCard.get(c.id) ?? [],
      })),
    }
  })

  const RangeQ = DayRange(93)

  app.get('/api/projects/:id/feed', async (req) => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    const { from, to } = parse(RangeQ, req.query)
    await requireProjectRole(ctx.db, id, auth.userId, 'viewer')
    const r = await ctx.db.query(
      `SELECT e.*, u.name AS user_name, u.email AS user_email FROM project_entries e JOIN users u ON u.id = e.user_id
        WHERE e.project_id = $1 AND e.day BETWEEN $2 AND $3 ORDER BY e.start_ts DESC LIMIT 5000`,
      [id, from, to],
    )
    return { projectId: id, from, to, entries: r.rows.map(entryView) }
  })

  app.get('/api/projects/:id/report', async (req): Promise<ProjectReport> => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    const { from, to } = parse(RangeQ, req.query)
    await requireProjectRole(ctx.db, id, auth.userId, 'viewer')
    const args = [id, from, to]
    const where = `e.project_id = $1 AND e.day BETWEEN $2 AND $3`
    const [member, day, memberDay, category] = await Promise.all([
      ctx.db.query(
        `SELECT e.user_id, COALESCE(NULLIF(u.name,''), u.email) AS name, SUM(e.minutes) AS m FROM project_entries e JOIN users u ON u.id = e.user_id
          WHERE ${where} GROUP BY e.user_id, u.name, u.email ORDER BY m DESC`,
        args,
      ),
      ctx.db.query(`SELECT e.day, SUM(e.minutes) AS m FROM project_entries e WHERE ${where} GROUP BY e.day ORDER BY e.day`, args),
      ctx.db.query(
        `SELECT e.user_id, e.day, SUM(e.minutes) AS m FROM project_entries e WHERE ${where} GROUP BY e.user_id, e.day ORDER BY e.day`,
        args,
      ),
      // category is only known for entries shared at 'cards' level or above
      ctx.db.query(
        `SELECT COALESCE(NULLIF(e.category,''), CASE WHEN e.share_level = 'time' THEN '(not shared)' ELSE '(none)' END) AS category,
                SUM(e.minutes) AS m FROM project_entries e WHERE ${where} GROUP BY 1 ORDER BY m DESC`,
        args,
      ),
    ])
    const r2 = (n: number) => Math.round(Number(n) * 100) / 100
    return {
      projectId: id,
      from,
      to,
      totalMinutes: r2(member.rows.reduce((s, x) => s + Number(x.m), 0)),
      byMember: member.rows.map((x) => ({ userId: x.user_id, userName: x.name, minutes: r2(x.m) })),
      byDay: day.rows.map((x) => ({ day: x.day, minutes: r2(x.m) })),
      byMemberDay: memberDay.rows.map((x) => ({ userId: x.user_id, day: x.day, minutes: r2(x.m) })),
      byCategory: category.rows.map((x) => ({ category: x.category, minutes: r2(x.m) })),
    }
  })

  app.get('/api/projects/:id/standup', async (req): Promise<ProjectStandupResponse> => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    const { day } = parse(z.object({ day: Day }), req.query)
    const access = await requireProjectRole(ctx.db, id, auth.userId, 'viewer')
    const proj = (await ctx.db.query(`SELECT name, rules, default_share FROM projects WHERE id = $1`, [id])).rows[0]
    const members = await ctx.db.query(
      `SELECT u.id, COALESCE(NULLIF(u.name,''), u.email) AS name, COALESCE(pm.share_level, $3) AS lvl
         FROM memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN project_members pm ON pm.project_id = $2 AND pm.user_id = u.id AND NOT pm.deleted
        WHERE m.workspace_id = $1 ORDER BY 2`,
      [access.workspaceId, id, proj.default_share],
    )
    const standups = await ctx.db.query(
      `SELECT user_id, payload FROM standups WHERE day = $1 AND NOT deleted AND user_id = ANY($2::uuid[])`,
      [day, members.rows.map((m) => m.id)],
    )
    const standupBy = new Map(standups.rows.map((s) => [s.user_id, s.payload]))
    const terms = [proj.name, ...((proj.rules?.titleKeywords as string[]) ?? [])]

    const out: ProjectStandupResponse['members'] = []
    for (const m of members.rows) {
      const payload = standupBy.get(m.id) as Record<string, any> | undefined
      const draft = (payload?.draft ?? payload ?? {}) as Record<string, any>
      const sourceDay: string = draft.generation?.sourceDay ?? payload?.sourceDay ?? day
      const entries = await ctx.db.query(
        `SELECT title, summary, minutes, day FROM project_entries WHERE project_id = $1 AND user_id = $2 AND day = ANY($3::text[]) ORDER BY start_ts`,
        [id, m.id, [...new Set([day, sourceDay])]],
      )
      const level = m.lvl as ShareLevel
      const minutes = entries.rows.filter((e) => e.day === day).reduce((s, e) => s + Number(e.minutes), 0)
      const sourceMinutes = entries.rows.filter((e) => e.day === sourceDay).reduce((s, e) => s + Number(e.minutes), 0)
      if (!payload && entries.rowCount === 0) continue
      let done: string[] = []
      let next: string[] = []
      if (level !== 'time') {
        const titles = entries.rows.map((e) => e.title).filter(Boolean) as string[]
        done = bullets(draft.highlights).filter((b) => bulletMatches(b, terms, titles))
        next = bullets(draft.tasks).filter((b) => bulletMatches(b, terms, titles))
        if (done.length === 0) done = [...new Set(entries.rows.filter((e) => e.day === sourceDay && e.title).map((e) => e.title as string))]
      }
      out.push({
        userId: m.id,
        userName: m.name,
        shareLevel: level,
        sourceDay,
        minutes: Math.round(minutes * 100) / 100,
        sourceMinutes: Math.round(sourceMinutes * 100) / 100,
        done,
        next,
        hasStandup: !!payload,
      })
    }
    return { projectId: id, day, members: out }
  })
}
