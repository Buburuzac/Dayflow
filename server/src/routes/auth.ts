import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, issueSession, SESSION_COOKIE, setSessionCookie, signIn } from '../auth/auth'
import { exchangeCode, isLoopbackRedirect, verifyIdToken } from '../auth/google'
import type { Ctx } from '../context'
import { randomToken, sha256 } from '../crypto'
import { badRequest, forbidden, HttpError, notFound, parse, Uuid } from '../http'


const DeviceZ = z.object({ name: z.string().trim().min(1).max(100), platform: z.string().max(50).default('') })

const ExchangeZ = z.object({
  code: z.string().min(1).max(2048),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().max(300),
  device: DeviceZ,
})

const DevZ = z.object({
  email: z.string().email().max(254),
  deviceName: z.string().trim().min(1).max(100),
  name: z.string().max(200).optional(),
  platform: z.string().max(50).optional(),
  deviceId: Uuid.optional(),
})

export const WEB_LINK_TTL_MS = 60_000

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const AUTH_LIMIT = { rateLimit: { max: ctx.config.AUTH_RATE_LIMIT, timeWindow: '1 minute' } }
  app.get('/api/auth/google/config', async () => ({ clientId: ctx.config.GOOGLE_CLIENT_ID, webClientId: ctx.config.GOOGLE_WEB_CLIENT_ID, devAuth: ctx.config.DEV_AUTH }))

  app.post('/api/auth/google/web', { config: AUTH_LIMIT }, async (req, reply) => {
    const { credential } = parse(z.object({ credential: z.string().min(100).max(10000) }), req.body)
    if (req.headers.origin) {
      const allowed = new URL(ctx.config.PUBLIC_URL).origin
      const sameHost = `${req.protocol}://${req.headers.host}`
      if (req.headers.origin !== allowed && req.headers.origin !== sameHost) throw forbidden('cross-origin request')
    }
    if (!ctx.config.GOOGLE_WEB_CLIENT_ID) throw new HttpError(503, 'google_web_not_configured', 'Web sign-in is not configured')
    const id = await verifyIdToken(ctx, credential, ctx.config.GOOGLE_WEB_CLIENT_ID)
    const signed = await signIn(ctx, {
      email: id.email,
      name: id.name,
      avatarUrl: id.picture,
      googleSub: id.sub,
      device: { name: 'Web Dashboard', platform: 'web', reuse: true },
    })
    setSessionCookie(ctx, reply, await issueSession(ctx, { userId: signed.user.id, deviceId: signed.device.id }))
    return { ok: true }
  })

  app.post('/api/auth/google/exchange', { config: AUTH_LIMIT }, async (req) => {
    const body = parse(ExchangeZ, req.body)
    if (!isLoopbackRedirect(body.redirectUri)) throw badRequest('redirectUri must be a loopback http URL')
    const idToken = await exchangeCode(ctx, body)
    const id = await verifyIdToken(ctx, idToken)
    if (ctx.config.ALLOWED_EMAIL_DOMAINS.length && id.hd && !ctx.config.ALLOWED_EMAIL_DOMAINS.includes(id.hd.toLowerCase()))
      throw new HttpError(403, 'domain_not_allowed', 'this email domain is not allowed')
    return signIn(ctx, {
      email: id.email,
      name: id.name,
      avatarUrl: id.picture,
      googleSub: id.sub,
      device: { name: body.device.name, platform: body.device.platform },
    })
  })

  app.post('/api/auth/dev', { config: AUTH_LIMIT }, async (req) => {
    if (!ctx.config.DEV_AUTH) throw notFound()
    const body = parse(DevZ, req.body)
    return signIn(ctx, {
      email: body.email,
      name: body.name ?? body.email.split('@')[0],
      avatarUrl: null,
      googleSub: null,
      device: { name: body.deviceName, platform: body.platform ?? 'dev', id: body.deviceId },
    })
  })

  // Desktop → browser hand-off: one-time code valid 60 s.
  app.post('/api/auth/web-link', { config: AUTH_LIMIT }, async (req) => {
    const auth = await authenticate(ctx, req, { deviceOnly: true })
    const code = randomToken('', 32)
    await ctx.db.query(`DELETE FROM web_link_codes WHERE expires_at < now() - interval '1 hour'`)
    await ctx.db.query(`INSERT INTO web_link_codes(code_hash, user_id, device_id, expires_at) VALUES ($1, $2, $3, $4)`, [
      sha256(code),
      auth.userId,
      auth.deviceId,
      new Date(ctx.now() + WEB_LINK_TTL_MS),
    ])
    const base = ctx.config.PUBLIC_URL.replace(/\/+$/, '')
    return { url: `${base}/api/auth/web-link/${code}`, expiresAt: ctx.now() + WEB_LINK_TTL_MS }
  })

  app.get('/api/auth/web-link/:code', { config: AUTH_LIMIT }, async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().min(16).max(100) }), req.params)
    const r = await ctx.db.query(
      `UPDATE web_link_codes w SET used_at = now()
         FROM devices d
        WHERE w.code_hash = $1 AND w.used_at IS NULL AND w.expires_at > $2
          AND d.id = w.device_id AND d.revoked_at IS NULL
        RETURNING w.user_id, w.device_id`,
      [sha256(code), new Date(ctx.now())],
    )
    if (!r.rowCount) {
      return reply
        .status(401)
        .type('text/html')
        .send('<!doctype html><meta charset="utf-8"><title>Dayflow</title><p>This sign-in link has expired or was already used. Open the dashboard again from the Dayflow app.</p>')
    }
    const jwt = await issueSession(ctx, { userId: r.rows[0].user_id, deviceId: r.rows[0].device_id })
    setSessionCookie(ctx, reply, jwt)
    reply.header('cache-control', 'no-store')
    return reply.redirect('/', 302)
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })
}
