import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import pg from 'pg'
import { buildApp } from '../src/app'
import { loadConfig, type Config } from '../src/config'
import type { Ctx } from '../src/context'
import { createPool, migrate, type Db } from '../src/db'
import { parseCall, serializeFault, serializeResponse } from '../src/odoo/xmlrpc'
import { formatHlc, type SyncChange } from '../src/shared'

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'

export interface TestEnv {
  app: FastifyInstance
  ctx: Ctx
  db: Db
  config: Config
  clock: { now: number }
  baseUrl: string
  close(): Promise<void>
}

/** Fresh database per test file: CREATE DATABASE, migrate, run, DROP. */
export async function setup(env: Record<string, string> = {}): Promise<TestEnv> {
  const name = `dayflow_test_${randomBytes(5).toString('hex')}`
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  const db = createPool(url.toString())
  await migrate(db)
  const config = loadConfig({
    DATABASE_URL: url.toString(),
    PUBLIC_URL: 'http://dayflow.test:8790',
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    DEV_AUTH: '1',
    BOOTSTRAP_ADMIN_EMAILS: 'owner@example.com',
    WEB_DIST: '/nonexistent',
    AUTH_RATE_LIMIT: '10000',
    ...env,
  })
  const clock = { now: Date.UTC(2026, 10, 2, 9, 0, 0) }
  const { app, ctx } = await buildApp({ config, db, now: () => clock.now, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  return {
    app,
    ctx,
    db,
    config,
    clock,
    baseUrl,
    async close() {
      await app.close()
      await db.end()
      const a = new pg.Client({ connectionString: ADMIN_URL })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await a.end()
    },
  }
}

export interface Device {
  token: string
  userId: string
  deviceId: string
  email: string
  seq: number
  hlc(offsetMs?: number): string
  headers: { authorization: string }
}

export async function devLogin(t: TestEnv, email: string, deviceName = 'pc'): Promise<Device> {
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/dev', payload: { email, deviceName } })
  if (r.statusCode !== 200) throw new Error(`dev login failed: ${r.statusCode} ${r.body}`)
  const b = r.json()
  const d: Device = {
    token: b.deviceToken,
    userId: b.user.id,
    deviceId: b.device.id,
    email,
    seq: 0,
    hlc(offsetMs = 0) {
      return formatHlc(t.clock.now + offsetMs, this.seq++, this.deviceId)
    },
    headers: { authorization: `Bearer ${b.deviceToken}` },
  }
  return d
}

export async function pushAs(t: TestEnv, d: Device, changes: Partial<SyncChange>[]) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: d.headers,
    payload: { changes: changes.map((c) => ({ deviceId: d.deviceId, ...c })) },
  })
  return { status: r.statusCode, body: r.json() }
}

export async function pullAll(t: TestEnv, d: Device, cursor = 0) {
  const r = await t.app.inject({ method: 'GET', url: `/api/sync/pull?cursor=${cursor}`, headers: d.headers })
  return r.json() as { changes: SyncChange[]; cursor: number; more: boolean }
}

export async function api(t: TestEnv, d: Device | null, method: string, url: string, payload?: unknown) {
  const r = await t.app.inject({ method: method as any, url, headers: d ? d.headers : {}, ...(payload !== undefined ? { payload: payload as any } : {}) })
  let body: any = null
  try {
    body = r.json()
  } catch {
    body = r.body
  }
  return { status: r.statusCode, body, headers: r.headers }
}

export const uuid = () => crypto.randomUUID()

export function cardChange(d: Device, id: string, data: Record<string, unknown>, extra: Partial<SyncChange> = {}): Partial<SyncChange> {
  return {
    entity: 'card',
    id,
    hlc: d.hlc(),
    data: {
      userId: d.userId,
      startTs: Date.UTC(2026, 10, 2, 8, 0),
      endTs: Date.UTC(2026, 10, 2, 9, 0),
      day: '2026-11-02',
      title: 'Card',
      summary: 'summary',
      detailedSummary: 'detailed',
      category: 'Work',
      subcategory: 'Coding',
      metadata: {},
      isError: false,
      ...data,
    },
    ...extra,
  }
}

function listen(server: Server, host = '127.0.0.1', port = 0): Promise<string> {
  return new Promise((resolve) => server.listen(port, host, () => resolve(`http://${host}:${(server.address() as AddressInfo).port}`)))
}

const readBody = (req: import('node:http').IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })

// ---- mock Google (token endpoint + JWKS) ----

export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'
export const GOOGLE_CLIENT_SECRET = 'test-secret'

export async function mockGoogle() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const state = {
    claims: {} as Record<string, unknown>,
    audience: GOOGLE_CLIENT_ID,
    issuer: 'https://accounts.google.com',
    lastForm: null as URLSearchParams | null,
  }
  const server = createServer(async (req, res) => {
    if (req.url === '/jwks') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ keys: [jwk] }))
    }
    if (req.url === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      state.lastForm = form
      res.setHeader('content-type', 'application/json')
      if (form.get('client_secret') !== GOOGLE_CLIENT_SECRET || form.get('code') !== 'good-code' || !form.get('code_verifier')) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: 'invalid_grant' }))
      }
      const id = await new SignJWT({ email_verified: true, name: 'Test User', ...state.claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(state.issuer)
        .setAudience(state.audience)
        .setSubject(String(state.claims.sub ?? 'google-sub-1'))
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey)
      return res.end(JSON.stringify({ access_token: 'x', id_token: id, token_type: 'Bearer', expires_in: 3600 }))
    }
    res.statusCode = 404
    res.end()
  })
  const url = await listen(server)
  return { url, state,
    idToken: (claims: Record<string, unknown>, audience = GOOGLE_CLIENT_ID) => new SignJWT({ email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(state.issuer).setAudience(audience).setSubject(String(claims.sub ?? 'google-sub-1'))
      .setIssuedAt().setExpirationTime('1h').sign(privateKey),
    close: () => new Promise<void>((r) => server.close(() => r())) }
}

// ---- mock Odoo 15 XML-RPC ----

export interface MockOdoo {
  url: string
  lines: Map<number, Record<string, unknown>>
  calls: { model: string; method: string; args: unknown[] }[]
  close(): Promise<void>
}

export async function mockOdoo(opts: { db?: string; login?: string; apiKey?: string; host?: string; port?: number } = {}): Promise<MockOdoo> {
  const DB = opts.db ?? 'odoo15'
  const LOGIN = opts.login ?? 'bot@example.com'
  const KEY = opts.apiKey ?? 'odoo-api-key-123'
  const UID = 7
  const lines = new Map<number, Record<string, unknown>>()
  const calls: MockOdoo['calls'] = []
  let nextId = 100
  const employees = [
    { id: 11, name: 'Owner Person', work_email: 'owner@example.com', user_id: [21, 'Owner'] },
    { id: 12, name: 'Member Person', work_email: 'member@example.com', user_id: false },
  ]
  const users = [{ id: 21, login: 'owner@example.com' }]
  const projects = [
    { id: 5, name: 'Website' },
    { id: 6, name: 'ERP' },
  ]

  const server = createServer(async (req, res) => {
    const body = await readBody(req)
    res.setHeader('content-type', 'text/xml')
    try {
      const { method, params } = parseCall(body)
      if (req.url === '/xmlrpc/2/common') {
        if (method === 'version') return res.end(serializeResponse({ server_version: '15.0', protocol_version: 1 }))
        if (method === 'authenticate') {
          const [db, login, key] = params as string[]
          return res.end(serializeResponse(db === DB && login === LOGIN && key === KEY ? UID : false))
        }
      }
      if (req.url === '/xmlrpc/2/object' && method === 'execute_kw') {
        const [db, uid, key, model, m, args = [], kwargs = {}] = params as any[]
        if (db !== DB || uid !== UID || key !== KEY) return res.end(serializeFault(3, 'Access Denied'))
        calls.push({ model, method: m, args })
        if (model === 'account.analytic.line') {
          if (m === 'create') {
            const id = nextId++
            lines.set(id, { ...args[0] })
            return res.end(serializeResponse(id))
          }
          if (m === 'write') {
            for (const id of args[0]) {
              if (!lines.has(id)) return res.end(serializeFault(2, 'Record does not exist or has been deleted.'))
              lines.set(id, { ...lines.get(id), ...args[1] })
            }
            return res.end(serializeResponse(true))
          }
          if (m === 'search_count') {
            const id = args[0][0][2]
            return res.end(serializeResponse(lines.has(id) ? 1 : 0))
          }
        }
        const filterIn = (rows: any[], field: string) => {
          const dom = (args[0] ?? []) as any[]
          const cond = dom.find((d) => d[0] === field && d[1] === 'in')
          return cond ? rows.filter((r) => cond[2].includes(r[field])) : rows
        }
        if (m === 'search_read') {
          if (model === 'hr.employee') return res.end(serializeResponse(filterIn(employees, 'work_email')))
          if (model === 'res.users') return res.end(serializeResponse(filterIn(users, 'login')))
          if (model === 'project.project') return res.end(serializeResponse(projects))
          if (model === 'project.task') return res.end(serializeResponse([{ id: 50, name: 'Build', project_id: [5, 'Website'] }]))
        }
        void kwargs
      }
      res.end(serializeFault(1, `unsupported ${req.url} ${method}`))
    } catch (e) {
      res.end(serializeFault(1, (e as Error).message))
    }
  })
  const url = await listen(server, opts.host, opts.port)
  return { url, lines, calls, close: () => new Promise<void>((r) => server.close(() => r())) }
}
