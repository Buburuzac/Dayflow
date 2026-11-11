import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireProjectRole, requireWorkspaceRole, roleAtLeast } from '../access'
import { authenticate, deviceInfo } from '../auth/auth'
import type { Ctx } from '../context'
import { cardMinutesSQL, cardStartSQL } from '../sync/card-time'
import { badRequest, Day, DayRange, forbidden, IdParam, notFound, parse, Uuid } from '../http'
import type {
  MemberTimelineResponse,
  ProjectEntry,
  ProjectReport,
  ProjectStandupResponse,
  ShareLevel,
  TimelineResponse,
  TimelineViewsResponse,
  WorkspaceReport,
  WorkspaceUsersResponse,
} from '../shared'

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

/** Timeline dates are interpreted in the viewer's zone; project reports keep each author's day. */
function timelineZone(query: unknown): string | null {
  const { timezone } = parse(z.object({ timezone: z.string().min(1).max(100).optional() }), query)
  if (!timezone) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw badRequest('invalid timeline timezone')
  }
  return timezone
}

/** `day` is source-local, so a cross-zone timeline must select by absolute card start time. */
function timelineRangeSQL(timezone: string | null, zoneParam: number): string {
  if (!timezone) return 'c.day BETWEEN $2 AND $3'
  const instant = cardStartSQL()
  // The day prefilter keeps the (user_id, day) index usable; zones differ by at most 26 h.
  return `c.day BETWEEN to_char($2::date - 2, 'YYYY-MM-DD') AND to_char($3::date + 2, 'YYYY-MM-DD')
      AND ${instant} >= (($2::date + interval '4 hours') AT TIME ZONE $${zoneParam})
      AND ${instant} < (($3::date + interval '1 day 4 hours') AT TIME ZONE $${zoneParam})`
}

export async function teamRoutes(app: FastifyInstance, ctx: Ctx) {
  // The caller's own merged cards from all devices (device lanes).
  app.get('/api/me/timeline', async (req): Promise<TimelineResponse> => {
    const auth = await authenticate(ctx, req)
    const { from, to } = parse(DayRange(93), req.query)
    const timezone = timelineZone(req.query)
    const range = timelineRangeSQL(timezone, 4)
    const args = timezone ? [auth.userId, from, to, timezone] : [auth.userId, from, to]
    const [devices, cards, links, cats] = await Promise.all([
      ctx.db.query(`SELECT id, name, platform, last_seen_at, revoked_at FROM devices WHERE user_id = $1 ORDER BY created_at`, [auth.userId]),
      ctx.db.query(
        `SELECT * FROM cards c WHERE user_id = $1 AND ${range} AND NOT deleted ORDER BY start_ts`,
        args,
      ),
      ctx.db.query(
        `SELECT cp.card_id, cp.project_id, cp.share, cp.source, cp.confidence, cp.confirmed, p.name, p.color, p.icon
           FROM card_projects cp JOIN cards c ON c.id = cp.card_id AND c.user_id = cp.user_id
           JOIN projects p ON p.id = cp.project_id AND NOT p.deleted
          WHERE cp.user_id = $1 AND NOT cp.deleted AND ${range}`,
        args,
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
        icon: l.icon,
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

  // Everyone's confirmed project time across the workspace (admin view). Same projection as the
  // project reports, so private cards, unconfirmed guesses and non-project work never show up.
  app.get('/api/workspaces/:id/report', async (req): Promise<WorkspaceReport> => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    const { from, to } = parse(RangeQ, req.query)
    await requireWorkspaceRole(ctx.db, id, auth.userId, 'admin')
    const args = [id, from, to]
    const scoped = `FROM project_entries e JOIN projects p ON p.id = e.project_id AND NOT p.deleted
                    WHERE p.workspace_id = $1 AND e.day BETWEEN $2 AND $3`
    const [users, projects, userProject, userDay, day] = await Promise.all([
      ctx.db.query(
        `SELECT u.id, COALESCE(NULLIF(u.name,''), u.email) AS name, u.email, u.avatar_url, m.role,
                COALESCE(t.m, 0) AS minutes, COALESCE(t.days, 0) AS days, COALESCE(t.projects, 0) AS projects,
                COALESCE(o.hours, 0) AS odoo_hours,
                (SELECT max(d.last_seen_at) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS last_seen
           FROM memberships m JOIN users u ON u.id = m.user_id
           LEFT JOIN (SELECT e.user_id, SUM(e.minutes) AS m, COUNT(DISTINCT e.day) AS days, COUNT(DISTINCT e.project_id) AS projects
                        ${scoped} GROUP BY e.user_id) t ON t.user_id = u.id
           LEFT JOIN (SELECT user_id, SUM(hours) AS hours FROM timesheet_exports
                       WHERE workspace_id = $1 AND status = 'sent' AND day BETWEEN $2 AND $3 GROUP BY user_id) o ON o.user_id = u.id
          WHERE m.workspace_id = $1
          ORDER BY minutes DESC, name`,
        args,
      ),
      ctx.db.query(
        `SELECT p.id, p.name, p.color, p.archived, SUM(e.minutes) AS m, COUNT(DISTINCT e.user_id) AS users
           ${scoped} GROUP BY p.id, p.name, p.color, p.archived ORDER BY m DESC`,
        args,
      ),
      ctx.db.query(`SELECT e.user_id, e.project_id, SUM(e.minutes) AS m ${scoped} GROUP BY e.user_id, e.project_id`, args),
      ctx.db.query(`SELECT e.user_id, e.day, SUM(e.minutes) AS m ${scoped} GROUP BY e.user_id, e.day ORDER BY e.day`, args),
      ctx.db.query(`SELECT e.day, SUM(e.minutes) AS m ${scoped} GROUP BY e.day ORDER BY e.day`, args),
    ])
    const r2 = (n: number) => Math.round(Number(n) * 100) / 100
    return {
      workspaceId: id,
      from,
      to,
      totalMinutes: r2(projects.rows.reduce((s, x) => s + Number(x.m), 0)),
      users: users.rows.map((x) => ({
        userId: x.id,
        userName: x.name,
        email: x.email,
        avatarUrl: x.avatar_url,
        role: x.role,
        minutes: r2(x.minutes),
        activeDays: Number(x.days),
        projectCount: Number(x.projects),
        odooHours: r2(x.odoo_hours),
        lastSeenAt: x.last_seen ? new Date(x.last_seen).getTime() : null,
      })),
      projects: projects.rows.map((x) => ({
        projectId: x.id,
        name: x.name,
        color: x.color,
        archived: x.archived,
        minutes: r2(x.m),
        userCount: Number(x.users),
      })),
      byUserProject: userProject.rows.map((x) => ({ userId: x.user_id, projectId: x.project_id, minutes: r2(x.m) })),
      byUserDay: userDay.rows.map((x) => ({ userId: x.user_id, day: x.day, minutes: r2(x.m) })),
      byDay: day.rows.map((x) => ({ day: x.day, minutes: r2(x.m) })),
    }
  })

  // Users directory (admin view): every member, their devices and how much each device recorded.
  app.get('/api/workspaces/:id/users', async (req): Promise<WorkspaceUsersResponse> => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    const { from, to } = parse(RangeQ, req.query)
    const callerRole = await requireWorkspaceRole(ctx.db, id, auth.userId, 'admin')
    const [members, devices, tracked, project] = await Promise.all([
      ctx.db.query(
        `SELECT u.id, COALESCE(NULLIF(u.name,''), u.email) AS name, u.email, u.avatar_url, m.role
           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY 2`,
        [id],
      ),
      ctx.db.query(
        `SELECT d.id, d.user_id, d.name, d.platform, d.last_seen_at, d.revoked_at
           FROM devices d JOIN memberships m ON m.user_id = d.user_id AND m.workspace_id = $1 ORDER BY d.created_at`,
        [id],
      ),
      ctx.db.query(
        `SELECT c.user_id, c.device_id,
                SUM(${cardMinutesSQL()}) AS m,
                array_agg(DISTINCT c.day) AS days
           FROM cards c JOIN memberships m ON m.user_id = c.user_id AND m.workspace_id = $1
          WHERE c.day BETWEEN $2 AND $3 AND NOT c.deleted AND NOT c.is_error AND NOT c.private AND ${notOtherWorkspaceWork('c', '$1')}
          GROUP BY c.user_id, c.device_id`,
        [id, from, to],
      ),
      ctx.db.query(
        `SELECT e.user_id, SUM(e.minutes) AS m FROM project_entries e JOIN projects p ON p.id = e.project_id AND NOT p.deleted
          WHERE p.workspace_id = $1 AND e.day BETWEEN $2 AND $3 GROUP BY e.user_id`,
        [id, from, to],
      ),
    ])
    const r2 = (n: number) => Math.round(Number(n) * 100) / 100
    const byDevice = new Map(tracked.rows.map((t) => [`${t.user_id}|${t.device_id}`, Number(t.m)]))
    const projectBy = new Map(project.rows.map((p) => [p.user_id, Number(p.m)]))
    return {
      workspaceId: id,
      from,
      to,
      users: members.rows.map((u) => {
        // an admin does not see an owner's own time (owners see everyone)
        const restricted = !roleAtLeast(callerRole, u.role)
        const rows = restricted ? [] : tracked.rows.filter((t) => t.user_id === u.id)
        const days = new Set(rows.flatMap((t) => t.days as string[]))
        const devs = devices.rows
          .filter((d) => d.user_id === u.id)
          .map((d) => ({ ...deviceInfo(d), minutes: restricted ? null : r2(byDevice.get(`${u.id}|${d.id}`) ?? 0) }))
          .filter((d) => !d.revoked || (d.minutes ?? 0) > 0)
        const seen = devs.filter((d) => !d.revoked && d.lastSeenAt).map((d) => d.lastSeenAt as number)
        return {
          userId: u.id,
          userName: u.name,
          email: u.email,
          avatarUrl: u.avatar_url,
          role: u.role,
          restricted,
          trackedMinutes: restricted ? null : r2(rows.reduce((s, t) => s + Number(t.m), 0)),
          projectMinutes: r2(projectBy.get(u.id) ?? 0),
          activeDays: restricted ? null : days.size,
          lastSeenAt: seen.length ? Math.max(...seen) : null,
          devices: devs,
        }
      }),
    }
  })

  // A member's timeline as a workspace admin may see it: every synced card of theirs, lane per device,
  // with content cut to what they share. Cards confirmed for projects of this workspace show the
  // lowest share level among those projects; anything else is a time-only "Out of scope" block.
  // Private, deleted and error cards never appear (personal cards never reach the server at all).
  app.get('/api/workspaces/:id/members/:userId/timeline', async (req): Promise<MemberTimelineResponse> => {
    const auth = await authenticate(ctx, req)
    const { id, userId } = parse(z.object({ id: Uuid, userId: Uuid }), req.params)
    const { from, to } = parse(RangeQ, req.query)
    const timezone = timelineZone(req.query)
    const range = timelineRangeSQL(timezone, 5)
    const args = timezone ? [userId, from, to, id, timezone] : [userId, from, to, id]
    const callerRole = await requireWorkspaceRole(ctx.db, id, auth.userId, 'admin')
    const who = await ctx.db.query(
      `SELECT u.id, COALESCE(NULLIF(u.name,''), u.email) AS name, u.email, u.avatar_url, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [id, userId],
    )
    if (!who.rowCount) throw notFound('member not found')
    if (!roleAtLeast(callerRole, who.rows[0].role)) throw forbidden('only an owner can view an owner’s timeline')
    if (userId !== auth.userId) await logTimelineView(ctx, id, auth.userId, userId, from, to)
    const [devices, cards, links, cats] = await Promise.all([
      ctx.db.query(`SELECT id, name, platform, last_seen_at, revoked_at FROM devices WHERE user_id = $1 ORDER BY created_at`, [userId]),
      ctx.db.query(
        `SELECT id, device_id, day, start_ts, end_ts, title, summary, detailed_summary, category, subcategory, metadata
           FROM cards c WHERE user_id = $1 AND ${range} AND NOT deleted AND NOT is_error AND NOT private
            AND ${notOtherWorkspaceWork('c', '$4')}
          ORDER BY start_ts`,
        args,
      ),
      ctx.db.query(
        `SELECT cp.card_id, cp.project_id, cp.share, cp.source, cp.confidence, p.name, p.color, p.icon,
                COALESCE(pm.share_level, p.default_share) AS lvl
           FROM card_projects cp JOIN cards c ON c.id = cp.card_id AND c.user_id = cp.user_id
           JOIN projects p ON p.id = cp.project_id AND NOT p.deleted AND p.workspace_id = $4
           LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = cp.user_id AND NOT pm.deleted
          WHERE cp.user_id = $1 AND cp.confirmed AND NOT cp.deleted AND ${range}`,
        args,
      ),
      ctx.db.query(`SELECT payload FROM user_docs WHERE id = $1 AND NOT deleted`, [`${userId}:categories`]),
    ])
    const RANK: Record<ShareLevel, number> = { time: 0, cards: 1, detailed: 2 }
    const byCard = new Map<string, { level: ShareLevel; projects: MemberTimelineResponse['cards'][number]['projects'] }>()
    for (const l of links.rows) {
      const cur = byCard.get(l.card_id) ?? { level: 'detailed' as ShareLevel, projects: [] }
      if (RANK[l.lvl as ShareLevel] < RANK[cur.level]) cur.level = l.lvl
      cur.projects.push({ projectId: l.project_id, projectName: l.name, color: l.color, icon: l.icon, share: l.share, source: l.source, confidence: l.confidence, confirmed: true })
      byCard.set(l.card_id, cur)
    }
    const u = who.rows[0]
    return {
      from,
      to,
      user: { userId: u.id, userName: u.name, email: u.email, avatarUrl: u.avatar_url, role: u.role },
      devices: devices.rows.map((d) => deviceInfo(d)),
      categories: categoryColors(cats.rows[0]?.payload),
      cards: cards.rows.map((c) => {
        const link = byCard.get(c.id)
        const level = link?.level ?? null
        const shown = level === 'cards' || level === 'detailed'
        const allowed = new Set(link?.projects.map((p) => p.projectId) ?? [])
        const refs = c.metadata?.detailProjects
        const hasRows = refs && typeof refs === 'object' && !Array.isArray(refs) && Object.keys(refs).length > 0
        const selectedRefs = (key: string) => Array.isArray(refs?.[key]) ? refs[key].filter((v: any) => v && v.confirmed === true && allowed.has(v.projectId)) : []
        const allLines = String(c.detailed_summary).split('\n').filter((line) => line.trim()).map((line, i) => ({ line, refs: selectedRefs(`detail:${i}`) }))
        const visibleLines = allLines.filter((x) => !hasRows || x.refs.length)
        const mixedScope = hasRows && allLines.some((x) => x.refs.length > 0) && allLines.some((x) => x.refs.length === 0)
        const summaryBreakdown = mixedScope ? allLines.map((x) => ({
          scope: x.refs.length ? 'project' : 'out-of-scope',
          projects: x.refs.map((r: { projectId: string }) => r.projectId),
          // Admins can see the time of unrelated work, never its description.
          line: x.refs.length && level === 'detailed' ? x.line : (x.line.match(/^\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*[-–—]\s*\d{1,2}:\d{2}\s*(?:AM|PM)?/i)?.[0] ?? ''),
        })) : undefined
        const visibleDistractions = (Array.isArray(c.metadata?.distractions) ? c.metadata.distractions : []).map((item: unknown, i: number) => ({ item, refs: selectedRefs(`distraction:${i}`) })).filter((x: { refs: unknown[] }) => !hasRows || x.refs.length)
        const detailProjects = hasRows ? Object.fromEntries([
          ...visibleLines.map((x, i) => [`detail:${i}`, x.refs]),
          ...visibleDistractions.map((x: { refs: unknown[] }, i: number) => [`distraction:${i}`, x.refs]),
        ]) : undefined
        return {
          id: c.id,
          deviceId: c.device_id,
          day: c.day,
          startTs: c.start_ts,
          endTs: c.end_ts,
          title: !link ? (c.category === 'Idle' ? 'Idle' : 'Out of scope') : shown ? (mixedScope ? 'Project work / Out of scope' : c.title) : link.projects.map((p) => p.projectName).join(', '),
          summary: shown && !mixedScope ? c.summary : '',
          detailedSummary: level === 'detailed' ? visibleLines.map((x) => x.line).join('\n') : '',
          category: !link ? (c.category === 'Idle' ? 'Idle' : 'Out of scope') : shown ? c.category : '',
          subcategory: shown ? c.subcategory : '',
          metadata: level === 'detailed' ? { distractions: visibleDistractions.map((x: { item: unknown }) => x.item), ...(detailProjects ? { detailProjects } : {}), ...(summaryBreakdown ? { summaryBreakdown } : {}) } : (level === 'cards' && summaryBreakdown ? { summaryBreakdown } : {}),
          isError: false,
          projects: link?.projects ?? [],
          shareLevel: level,
        }
      }),
    }
  })

  // The caller's own audit trail: who opened their timeline, when, and for which period.
  app.get('/api/me/timeline-views', async (req): Promise<TimelineViewsResponse> => {
    const auth = await authenticate(ctx, req)
    const r = await ctx.db.query(
      `SELECT v.viewed_at, v.range_from, v.range_to, w.name AS workspace_name,
              COALESCE(NULLIF(u.name,''), u.email) AS viewer_name, u.email AS viewer_email
         FROM timeline_views v JOIN users u ON u.id = v.viewer_id JOIN workspaces w ON w.id = v.workspace_id
        WHERE v.user_id = $1 ORDER BY v.viewed_at DESC LIMIT 100`,
      [auth.userId],
    )
    return {
      views: r.rows.map((x) => ({
        viewerName: x.viewer_name,
        viewerEmail: x.viewer_email,
        workspaceName: x.workspace_name,
        from: x.range_from,
        to: x.range_to,
        viewedAt: new Date(x.viewed_at).getTime(),
      })),
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

/** Only names and colours of the member's categories (descriptions are the user's own prompt text). */
function categoryColors(payload: unknown): { name: string; color: string }[] | null {
  let v: unknown = payload
  for (let i = 0; i < 3 && v && typeof v === 'object' && !Array.isArray(v); i++) v = (v as any).categories ?? (v as any).payload ?? null
  if (!Array.isArray(v)) return null
  return v
    .filter((c) => c && typeof c === 'object' && typeof c.name === 'string')
    .map((c) => ({ name: c.name, color: typeof c.color === 'string' ? c.color : '' }))
}

/**
 * SQL condition for a card alias: the card is not work confirmed only for projects of other workspaces.
 * Such cards stay out of this workspace's admin views; cards without any project ("Out of scope") remain.
 */
function notOtherWorkspaceWork(card: string, workspaceParam: string): string {
  const link = (cmp: '=' | '<>') => `EXISTS (
    SELECT 1 FROM card_projects x JOIN projects xp ON xp.id = x.project_id AND NOT xp.deleted
     WHERE x.card_id = ${card}.id AND x.user_id = ${card}.user_id AND x.confirmed AND NOT x.deleted AND xp.workspace_id ${cmp} ${workspaceParam})`
  return `(NOT ${link('<>')} OR ${link('=')})`
}

const VIEW_DEDUP_MS = 10 * 60_000

/** Records an admin opening a member's timeline; the same viewer, member and period count once per 10 minutes. */
async function logTimelineView(ctx: Ctx, workspaceId: string, viewerId: string, userId: string, from: string, to: string) {
  const now = new Date(ctx.now())
  await ctx.db.query(
    `INSERT INTO timeline_views(workspace_id, viewer_id, user_id, range_from, range_to, viewed_at)
     SELECT $1, $2, $3, $4, $5, $6
      WHERE NOT EXISTS (SELECT 1 FROM timeline_views WHERE viewer_id = $2 AND user_id = $3 AND workspace_id = $1
                          AND range_from = $4 AND range_to = $5 AND viewed_at > $7)`,
    [workspaceId, viewerId, userId, from, to, now, new Date(now.getTime() - VIEW_DEDUP_MS)],
  )
}
