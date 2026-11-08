import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../auth/auth'
import type { Ctx } from '../context'
import { badRequest, parse } from '../http'
import { MAX_PULL, MAX_PUSH, pull, push } from '../sync/engine'
import { publishEffects } from '../sync/notify'

export const HEARTBEAT_MS = 25_000

const PullQueryZ = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL).default(MAX_PULL),
})

export async function syncRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/api/sync/push', async (req) => {
    const auth = await authenticate(ctx, req, { deviceOnly: true })
    const body = req.body as { changes?: unknown } | undefined
    if (!body || !Array.isArray(body.changes)) throw badRequest('body must be { changes: Change[] }')
    if (body.changes.length > MAX_PUSH) throw badRequest(`at most ${MAX_PUSH} changes per request`)
    const { response, effects } = await push(ctx.db, auth, body.changes, ctx.now())
    await publishEffects(ctx, effects)
    return response
  })

  app.get('/api/sync/pull', async (req) => {
    const auth = await authenticate(ctx, req, { deviceOnly: true })
    const q = parse(PullQueryZ, req.query)
    return pull(ctx.db, auth.userId, q.cursor, q.limit)
  })

  // Server-Sent Events. Device token (desktop) or session cookie (dashboard EventSource).
  app.get('/api/sync/stream', async (req, reply) => {
    const auth = await authenticate(ctx, req)
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`)
    }
    res.write(`retry: 5000\n\n`)
    // initial nudge: the client pulls once after (re)connecting
    send('changed', {})
    const unsubscribe = ctx.hub.subscribe(auth.userId, send)
    const beat = setInterval(async () => {
      // a revoked device loses its open stream at the next heartbeat
      const r = await ctx.db.query(`SELECT 1 FROM devices WHERE id = $1 AND revoked_at IS NULL`, [auth.deviceId]).catch(() => null)
      if (r && !r.rowCount) {
        close()
        res.end()
        return
      }
      send('ping', { t: ctx.now() })
    }, HEARTBEAT_MS)
    const close = () => {
      clearInterval(beat)
      unsubscribe()
    }
    req.raw.on('close', close)
    res.on('error', close)
  })
}
