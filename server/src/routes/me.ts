import type { FastifyInstance } from 'fastify'
import { authenticate, deviceInfo, userInfo } from '../auth/auth'
import type { Ctx } from '../context'
import { IdParam, notFound, parse } from '../http'
import type { MeResponse } from '../shared'

export async function meRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/me', async (req): Promise<MeResponse & { via: string; currentDeviceId: string }> => {
    const auth = await authenticate(ctx, req)
    const [u, d, w] = await Promise.all([
      ctx.db.query(`SELECT id, email, name, avatar_url FROM users WHERE id = $1`, [auth.userId]),
      ctx.db.query(
        `SELECT id, name, platform, last_seen_at, revoked_at FROM devices WHERE user_id = $1 ORDER BY revoked_at NULLS FIRST, last_seen_at DESC NULLS LAST`,
        [auth.userId],
      ),
      ctx.db.query(
        `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.created_at`,
        [auth.userId],
      ),
    ])
    return {
      user: userInfo(u.rows[0]),
      devices: d.rows.map((r) => deviceInfo(r, auth.deviceId)),
      workspaces: w.rows.map((r) => ({ id: r.id, name: r.name, role: r.role })),
      via: auth.via,
      currentDeviceId: auth.deviceId,
    }
  })

  app.delete('/api/devices/:id', async (req) => {
    const auth = await authenticate(ctx, req)
    const { id } = parse(IdParam, req.params)
    const r = await ctx.db.query(
      `UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, auth.userId],
    )
    if (!r.rowCount) throw notFound('device not found')
    await ctx.db.query(`DELETE FROM web_link_codes WHERE device_id = $1`, [id])
    return { ok: true, id, revoked: true }
  })
}
