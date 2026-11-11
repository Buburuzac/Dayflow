import type { FastifyReply, FastifyRequest } from 'fastify'
import { jwtVerify, SignJWT } from 'jose'
import type { Auth, Ctx } from '../context'
import { randomToken, sha256 } from '../crypto'
import { withSeqTx, type Queryable } from '../db'
import { forbidden, HttpError, unauthorized } from '../http'
import type { AuthResponse, DeviceInfo, UserInfo } from '../shared'
import { addMembership } from '../access'

export const SESSION_COOKIE = 'df_session'
export const SESSION_TTL_S = 12 * 3600

const secretKey = (ctx: Ctx) => new TextEncoder().encode(ctx.config.JWT_SECRET)

/**
 * ALLOWED_EMAIL_DOMAINS entries are domains (`velesagro.pl`) or exact addresses (`someone@gmail.com`).
 * Bootstrap admins are always allowed, so an owner may use an address outside the company domain
 * without opening sign-in to the whole of that domain.
 */
export function emailAllowed(ctx: Ctx, email: string): boolean {
  const allowed = ctx.config.ALLOWED_EMAIL_DOMAINS.map((x) => x.toLowerCase())
  if (allowed.length === 0) return true
  const e = email.toLowerCase()
  if (ctx.config.BOOTSTRAP_ADMIN_EMAILS.map((x) => x.toLowerCase()).includes(e)) return true
  if (allowed.includes(e)) return true
  const d = e.split('@')[1] ?? ''
  return allowed.includes(d)
}

export function userInfo(r: { id: string; email: string; name: string; avatar_url: string | null }): UserInfo {
  return { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url }
}

export function deviceInfo(
  r: { id: string; name: string; platform: string; last_seen_at: Date | null; revoked_at: Date | null },
  currentId?: string,
): DeviceInfo {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    lastSeenAt: r.last_seen_at ? r.last_seen_at.getTime() : null,
    revoked: r.revoked_at != null,
    ...(currentId ? { current: r.id === currentId } : {}),
  }
}

/** Creates or updates the user, applies the bootstrap-admin rule and registers a new device. */
export async function signIn(
  ctx: Ctx,
  p: { email: string; name: string; avatarUrl: string | null; googleSub: string | null; device: { name: string; platform: string; id?: string; reuse?: boolean } },
): Promise<AuthResponse> {
  const email = p.email.toLowerCase()
  if (!emailAllowed(ctx, email)) throw new HttpError(403, 'domain_not_allowed', 'this email domain is not allowed')
  return withSeqTx(ctx.db, async (tx) => {
    const u = await tx.query(
      `INSERT INTO users(email, name, avatar_url, google_sub) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE users.name END,
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub)
       RETURNING id, email, name, avatar_url, google_sub`,
      [email, p.name, p.avatarUrl, p.googleSub],
    )
    const user = u.rows[0]
    if (p.googleSub && user.google_sub && user.google_sub !== p.googleSub)
      throw new HttpError(403, 'account_mismatch', 'this email is linked to a different Google account')

    await bootstrapAdmin(ctx, tx, user.id, email)

    const token = randomToken('dfd_')
    let d
    // A client-proposed device id is adopted when unused, or re-keyed when it is the caller's live device.
    // `reuse` (web sign-in) keeps one live device per platform instead of adding a row per sign-in.
    const reused = !p.device.id && p.device.reuse
      ? (await tx.query<{ id: string }>(
          `SELECT id FROM devices WHERE user_id = $1 AND platform = $2 AND revoked_at IS NULL
           ORDER BY last_seen_at DESC NULLS LAST LIMIT 1 FOR UPDATE`,
          [user.id, p.device.platform],
        )).rows[0]?.id
      : undefined
    const prev = p.device.id
      ? (await tx.query(`SELECT user_id, revoked_at FROM devices WHERE id = $1 FOR UPDATE`, [p.device.id])).rows[0]
      : undefined
    if (reused || (p.device.id && prev && prev.user_id === user.id && !prev.revoked_at)) {
      d = await tx.query(
        `UPDATE devices SET token_hash = $2, name = $3, platform = $4, last_seen_at = now() WHERE id = $1
         RETURNING id, name, platform, last_seen_at, revoked_at`,
        [reused ?? p.device.id, sha256(token), p.device.name, p.device.platform],
      )
    } else {
      d = await tx.query(
        `INSERT INTO devices(id, user_id, name, platform, token_hash, last_seen_at) VALUES (COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3, $4, now())
         RETURNING id, name, platform, last_seen_at, revoked_at`,
        [user.id, p.device.name, p.device.platform, sha256(token), p.device.id && !prev ? p.device.id : null],
      )
    }
    return { deviceToken: token, user: userInfo(user), device: deviceInfo(d.rows[0], d.rows[0].id) }
  })
}

/** Users listed in BOOTSTRAP_ADMIN_EMAILS become owners of the default workspace (created on first use). */
async function bootstrapAdmin(ctx: Ctx, tx: Queryable, userId: string, email: string): Promise<void> {
  if (!ctx.config.BOOTSTRAP_ADMIN_EMAILS.includes(email)) return
  let ws = (await tx.query<{ id: string }>(`SELECT id FROM workspaces WHERE is_default`)).rows[0]
  if (!ws) {
    ws = (
      await tx.query<{ id: string }>(
        `INSERT INTO workspaces(name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING RETURNING id`,
        ['Default'],
      )
    ).rows[0] ?? (await tx.query<{ id: string }>(`SELECT id FROM workspaces WHERE is_default`)).rows[0]
  }
  const existing = await tx.query(`SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [ws.id, userId])
  if (existing.rowCount) {
    if (existing.rows[0].role !== 'owner')
      await tx.query(`UPDATE memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [ws.id, userId])
    return
  }
  await addMembership(tx, ws.id, userId, 'owner')
}

export async function issueSession(ctx: Ctx, auth: { userId: string; deviceId: string }): Promise<string> {
  return new SignJWT({ did: auth.deviceId, typ: 'web' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(auth.userId)
    .setIssuedAt(Math.floor(ctx.now() / 1000))
    .setExpirationTime(Math.floor(ctx.now() / 1000) + SESSION_TTL_S)
    .sign(secretKey(ctx))
}

export function setSessionCookie(ctx: Ctx, reply: FastifyReply, jwt: string): void {
  reply.setCookie(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.PUBLIC_URL.startsWith('https:'),
    path: '/',
    maxAge: SESSION_TTL_S,
  })
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (!h) return null
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  return m ? m[1] : null
}

function originAllowed(ctx: Ctx, req: FastifyRequest): boolean {
  const origin = req.headers.origin
  if (!origin) return true // same-origin navigations / non-browser clients
  try {
    const o = new URL(origin)
    if (o.host === req.headers.host) return true
    if (o.origin === new URL(ctx.config.PUBLIC_URL).origin) return true
  } catch {
    return false
  }
  return false
}

/**
 * Resolves the caller from `Authorization: Bearer <device token>` or the web session cookie.
 * `deviceOnly` rejects cookie sessions (sync endpoints, web-link creation).
 */
export async function authenticate(ctx: Ctx, req: FastifyRequest, opts: { deviceOnly?: boolean } = {}): Promise<Auth> {
  const token = bearer(req)
  if (token) {
    const r = await ctx.db.query(
      `SELECT d.id AS device_id, u.id AS user_id, u.email, d.last_seen_at
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
      [sha256(token)],
    )
    const row = r.rows[0]
    if (!row) throw unauthorized('invalid or revoked device token')
    if (!row.last_seen_at || ctx.now() - row.last_seen_at.getTime() > 60_000)
      await ctx.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [row.device_id])
    return { userId: row.user_id, email: row.email, deviceId: row.device_id, via: 'device' }
  }
  if (opts.deviceOnly) throw unauthorized('device token required')
  const jwt = req.cookies?.[SESSION_COOKIE]
  if (!jwt) throw unauthorized()
  let sub: string, did: string
  try {
    const { payload } = await jwtVerify(jwt, secretKey(ctx), { algorithms: ['HS256'], currentDate: new Date(ctx.now()) })
    if (payload.typ !== 'web' || typeof payload.sub !== 'string' || typeof payload.did !== 'string') throw new Error()
    sub = payload.sub
    did = payload.did
  } catch {
    throw unauthorized('session expired')
  }
  // A session dies with the device that created it.
  const r = await ctx.db.query(
    `SELECT u.email FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL`,
    [did, sub],
  )
  if (!r.rowCount) throw unauthorized('session revoked')
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(ctx, req)) throw forbidden('cross-origin request')
  return { userId: sub, email: r.rows[0].email, deviceId: did, via: 'session' }
}
