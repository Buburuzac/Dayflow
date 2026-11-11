import type { Queryable } from '../db'
import { cardMinutesSQL } from './card-time'

/**
 * Rebuilds `project_entries` — the only team-visible view of personal cards.
 *
 * Rules (docs/sync-server-design.md, "Sharing levels"):
 *  - only confirmed, non-deleted card_projects of non-deleted, non-error, non-private cards;
 *  - only while the card owner is a member of the project's workspace and the project is not deleted;
 *  - level = project_members.share_level ?? projects.default_share:
 *      time     → minutes + day
 *      cards    → + title, summary, category
 *      detailed → + detailed summary, distractions;
 *  - minutes = card duration × share; when a card's confirmed shares sum above 1 they are scaled down.
 */
export interface ProjectionScope {
  cardIds?: string[]
  projectId?: string
  userId?: string
  workspaceId?: string
}

// A manually edited detailed line is shown only in the projects explicitly confirmed for it.
// Unedited cards keep the original full summary for compatibility with existing data.
const detailedForProject = `CASE WHEN jsonb_typeof(c.metadata->'detailProjects') = 'object' AND c.metadata->'detailProjects' <> '{}'::jsonb THEN (
  SELECT string_agg(line, E'\\n' ORDER BY n) FROM (
    SELECT line, row_number() OVER (ORDER BY ord) - 1 AS n
      FROM string_to_table(c.detailed_summary, E'\\n') WITH ORDINALITY AS lines(line, ord)
     WHERE line ~ '\\S' -- same blank-line rule as JS trim() and Swift .whitespacesAndNewlines
  ) detail_lines
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.metadata->'detailProjects'->('detail:' || n)) = 'array'
           THEN c.metadata->'detailProjects'->('detail:' || n) ELSE '[]'::jsonb END
    ) ref WHERE ref->>'projectId' = p.id::text AND ref->>'confirmed' = 'true'
  )
) ELSE c.detailed_summary END`

const distractionsForProject = `CASE WHEN jsonb_typeof(c.metadata->'detailProjects') = 'object' AND c.metadata->'detailProjects' <> '{}'::jsonb THEN COALESCE((
  SELECT jsonb_agg(item ORDER BY ord) FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.metadata->'distractions') = 'array' THEN c.metadata->'distractions' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS distractions(item, ord)
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.metadata->'detailProjects'->('distraction:' || (ord - 1))) = 'array'
           THEN c.metadata->'detailProjects'->('distraction:' || (ord - 1)) ELSE '[]'::jsonb END
    ) ref WHERE ref->>'projectId' = p.id::text AND ref->>'confirmed' = 'true'
  )
), '[]'::jsonb) ELSE COALESCE(c.metadata->'distractions', '[]'::jsonb) END`

export async function recomputeProjection(tx: Queryable, scope: ProjectionScope): Promise<void> {
  const del: string[] = []
  const ins: string[] = []
  const args: unknown[] = []
  const arg = (v: unknown) => {
    args.push(v)
    return `$${args.length}`
  }
  if (scope.cardIds) {
    if (scope.cardIds.length === 0) return
    const a = arg(scope.cardIds)
    del.push(`card_id = ANY(${a}::uuid[])`)
    ins.push(`cp.card_id = ANY(${a}::uuid[])`)
  }
  if (scope.projectId) {
    const a = arg(scope.projectId)
    del.push(`project_id = ${a}`)
    ins.push(`cp.project_id = ${a}`)
  }
  if (scope.userId) {
    const a = arg(scope.userId)
    del.push(`user_id = ${a}`)
    ins.push(`cp.user_id = ${a}`)
  }
  if (scope.workspaceId) {
    const a = arg(scope.workspaceId)
    del.push(`project_id IN (SELECT id FROM projects WHERE workspace_id = ${a})`)
    ins.push(`p.workspace_id = ${a}`)
  }
  if (del.length === 0) throw new Error('projection scope required')

  await tx.query(`DELETE FROM project_entries WHERE ${del.join(' AND ')}`, args)
  await tx.query(
    `INSERT INTO project_entries(card_id, project_id, user_id, day, start_ts, end_ts, minutes,
                                 title, summary, category, detailed, distractions, share_level, updated_at)
     SELECT c.id, p.id, c.user_id, c.day, c.start_ts, c.end_ts,
            ${cardMinutesSQL()}
              * LEAST(1, GREATEST(0, cp.share))
              * CASE WHEN t.total > 1 THEN 1 / t.total ELSE 1 END,
            CASE WHEN l.lvl IN ('cards','detailed') THEN c.title END,
            CASE WHEN l.lvl IN ('cards','detailed') THEN c.summary END,
            CASE WHEN l.lvl IN ('cards','detailed') THEN c.category END,
            CASE WHEN l.lvl = 'detailed' THEN ${detailedForProject} END,
            CASE WHEN l.lvl = 'detailed' THEN ${distractionsForProject} END,
            l.lvl, now()
       FROM card_projects cp
       JOIN cards c ON c.id = cp.card_id AND c.user_id = cp.user_id
       JOIN projects p ON p.id = cp.project_id AND NOT p.deleted
       JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = c.user_id
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = c.user_id AND NOT pm.deleted
       CROSS JOIN LATERAL (SELECT COALESCE(pm.share_level, p.default_share) AS lvl) l
       CROSS JOIN LATERAL (
         SELECT SUM(LEAST(1, GREATEST(0, x.share))) AS total FROM card_projects x
          WHERE x.card_id = c.id AND x.user_id = c.user_id AND x.confirmed AND NOT x.deleted
       ) t
      WHERE cp.confirmed AND NOT cp.deleted AND NOT c.deleted AND NOT c.is_error AND NOT c.private
        AND ${ins.join(' AND ')}`,
    args,
  )
}

/** Projects whose entries may have changed for the given cards (before or after a write). */
export async function projectsOfCards(tx: Queryable, cardIds: string[]): Promise<string[]> {
  if (cardIds.length === 0) return []
  const r = await tx.query<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM card_projects WHERE card_id = ANY($1::uuid[])
     UNION SELECT DISTINCT project_id FROM project_entries WHERE card_id = ANY($1::uuid[])`,
    [cardIds],
  )
  return r.rows.map((x) => x.project_id)
}
