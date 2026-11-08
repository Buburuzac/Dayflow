import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Config } from './config'
import type { Ctx } from './context'
import { SecretBox } from './crypto'
import type { Db } from './db'
import { HttpError } from './http'
import { authRoutes } from './routes/auth'
import { meRoutes } from './routes/me'
import { odooAdminRoutes } from './routes/odoo-admin'
import { syncRoutes } from './routes/sync'
import { teamRoutes } from './routes/team'
import { timesheetRoutes } from './routes/timesheets'
import { workspaceRoutes } from './routes/workspaces'
import { Hub } from './sync/hub'

export const VERSION = '1.0.0'

export interface AppDeps {
  config: Config
  db: Db
  now?: () => number
  fetch?: typeof fetch
  logger?: boolean
}

/** Paths whose last segment is a one-time secret; redacted in request logs. */
const SECRET_PATH = /(\/api\/auth\/web-link\/|\/api\/invites\/)[^/?]+/g
export const redactUrl = (url: string) => url.replace(SECRET_PATH, '$1[redacted]').replace(/([?&](code|token)=)[^&]+/g, '$1[redacted]')

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const ctx: Ctx = {
    config: deps.config,
    db: deps.db,
    hub: new Hub(),
    box: new SecretBox(deps.config.JWT_SECRET),
    now: deps.now ?? Date.now,
    fetch: deps.fetch ?? fetch,
  }

  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: deps.config.TRUST_PROXY,
    logger:
      deps.logger === false
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            serializers: {
              req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
            },
          },
  })

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
  })

  await app.register(cookie)
  await app.register(rateLimit, { global: false })

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) })
    }
    const e = err as { statusCode?: number; code?: string; message?: string }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message })
    }
    req.log.error({ err: { message: e.message, code: e.code } }, 'unhandled error')
    return reply.status(500).send({ error: 'internal', message: 'internal server error' })
  })

  app.get('/api/health', async () => {
    await ctx.db.query('SELECT 1')
    return { ok: true, version: VERSION, time: ctx.now(), devAuth: ctx.config.DEV_AUTH, googleConfigured: !!ctx.config.GOOGLE_CLIENT_ID }
  })

  await app.register(async (r) => authRoutes(r, ctx))
  await app.register(async (r) => meRoutes(r, ctx))
  await app.register(async (r) => workspaceRoutes(r, ctx))
  await app.register(async (r) => syncRoutes(r, ctx))
  await app.register(async (r) => teamRoutes(r, ctx))
  await app.register(async (r) => timesheetRoutes(r, ctx))
  await app.register(async (r) => odooAdminRoutes(r, ctx))

  // Static dashboard (server/web/dist), SPA fallback for non-API GETs.
  const webDist = resolve(deps.config.WEB_DIST || join(process.cwd(), 'web', 'dist'))
  const hasWeb = existsSync(join(webDist, 'index.html'))
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, index: ['index.html'] })
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html').sendFile('index.html')
    }
    return reply.status(404).send({ error: 'not_found', message: 'not found' })
  })

  return { app, ctx }
}
