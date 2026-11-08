// End-to-end check against a running server over real HTTP (used with docker-compose.e2e.yml, DEV_AUTH=1).
// Exercises two devices of one user, a teammate, projects, invites, the team feed and timesheets (mock Odoo).
import assert from 'node:assert/strict'
import { formatHlc, type SyncChange } from '../../src/shared'
import { mockOdoo } from '../helpers'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8790'
const ODOO_HOST = process.env.MOCK_ODOO_HOST ?? '0.0.0.0'
const ODOO_PUBLIC = process.env.MOCK_ODOO_PUBLIC_URL ?? 'http://127.0.0.1:8069'
const log = (...a: unknown[]) => console.log('[e2e]', ...a)

interface Dev {
  token: string
  userId: string
  deviceId: string
  seq: number
  cursor: number
}

async function http(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* html */
  }
  return { status: res.status, json, headers: res.headers }
}

async function login(email: string, deviceName: string): Promise<Dev> {
  const r = await http('POST', '/api/auth/dev', { body: { email, deviceName, platform: 'e2e' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return { token: r.json.deviceToken, userId: r.json.user.id, deviceId: r.json.device.id, seq: 0, cursor: 0 }
}

const hlc = (d: Dev, offset = 0) => formatHlc(Date.now() + offset, d.seq++, d.deviceId)

async function push(d: Dev, changes: Partial<SyncChange>[]) {
  const r = await http('POST', '/api/sync/push', { token: d.token, body: { changes: changes.map((c) => ({ deviceId: d.deviceId, ...c })) } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.rejected, [], JSON.stringify(r.json.rejected))
  return r.json
}

async function pull(d: Dev): Promise<SyncChange[]> {
  const out: SyncChange[] = []
  for (;;) {
    const r = await http('GET', `/api/sync/pull?cursor=${d.cursor}&limit=500`, { token: d.token })
    assert.equal(r.status, 200)
    out.push(...r.json.changes)
    d.cursor = r.json.cursor
    if (!r.json.more) return out
  }
}

/** Opens /api/sync/stream and resolves `next(event)` promises as events arrive. */
async function stream(d: Dev) {
  const ac = new AbortController()
  const res = await fetch(BASE + '/api/sync/stream', { headers: { authorization: `Bearer ${d.token}` }, signal: ac.signal })
  assert.equal(res.status, 200)
  const events: string[] = []
  const pending: Record<string, number> = {}
  const waiters: { name: string; resolve: () => void }[] = []
  const deliver = (name: string) => {
    const i = waiters.findIndex((w) => w.name === name)
    if (i >= 0) waiters.splice(i, 1)[0].resolve()
    else pending[name] = (pending[name] ?? 0) + 1
  }
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk)
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const m = /^event: (\S+)/m.exec(block)
          if (!m) continue
          events.push(m[1])
          deliver(m[1])
        }
      }
    } catch {
      /* aborted */
    }
  })()
  return {
    events,
    next: (name: string, ms = 5000) =>
      new Promise<void>((resolve, reject) => {
        if (pending[name]) {
          pending[name]--
          return resolve()
        }
        const t = setTimeout(() => reject(new Error(`no ${name} event within ${ms} ms`)), ms)
        waiters.push({ name, resolve: () => (clearTimeout(t), resolve()) })
      }),
    close: () => ac.abort(),
  }
}

const day = new Date().toISOString().slice(0, 10)
const at = (h: number, m = 0) => Date.parse(`${day}T00:00:00Z`) + (h * 60 + m) * 60_000
const card = (d: Dev, id: string, data: Record<string, unknown>, extra: Partial<SyncChange> = {}): Partial<SyncChange> => ({
  entity: 'card',
  id,
  hlc: hlc(d),
  data: { userId: d.userId, startTs: at(8), endTs: at(9), day, title: 'Card', summary: 's', detailedSummary: 'd', category: 'Work', subcategory: 'Dev', metadata: {}, isError: false, ...data },
  ...extra,
})

async function main() {
  const odoo = await mockOdoo({ host: ODOO_HOST, port: 8069, login: 'bot@e2e.test', apiKey: 'e2e-odoo-key', db: 'odoo15' })
  const results: Record<string, string> = {}
  const ok = (k: string) => {
    results[k] = 'ok'
    log('✔', k)
  }

  const h = await http('GET', '/api/health')
  assert.equal(h.json.ok, true)
  assert.equal(h.json.devAuth, true)
  ok('health')

  // ---- two devices of one user ----
  const a1 = await login('owner@example.com', 'Owner PC 1')
  const a2 = await login('owner@example.com', 'Owner PC 2')
  const s2 = await stream(a2)
  await s2.next('changed') // initial nudge
  await pull(a2)
  const cid = crypto.randomUUID()
  const waitA2 = s2.next('changed')
  await push(a1, [card(a1, cid, { title: 'Draft proposal' })])
  await waitA2
  let got = (await pull(a2)).filter((c) => c.id === cid)
  assert.equal(got.at(-1)?.data?.title, 'Draft proposal')
  ok('push on PC1 → SSE changed on PC2 → pull')

  const hr = hlc(a2, 1000)
  await push(a2, [card(a2, cid, { title: 'Proposal for client' }, { hlc: hr, fieldHlc: { title: hr } })])
  const hc = hlc(a1, 2000)
  await push(a1, [card(a1, cid, { title: 'Draft proposal', category: 'Sales' }, { hlc: hc, fieldHlc: { category: hc } })])
  for (const d of [a1, a2]) {
    const c = (await pull(d)).filter((x) => x.id === cid).at(-1)!
    assert.equal(c.data!.title, 'Proposal for client')
    assert.equal(c.data!.category, 'Sales')
  }
  ok('per-field LWW across devices')

  // ---- workspace, project, invite ----
  const me = await http('GET', '/api/me', { token: a1.token })
  const ws = me.json.workspaces[0]
  assert.equal(ws.role, 'owner')
  const proj = await http('POST', `/api/workspaces/${ws.id}/projects`, {
    token: a1.token,
    body: { name: 'Website', color: '#3b82f6', description: 'Company website', rules: { titleKeywords: ['website'] }, defaultShare: 'time', odoo: { projectId: 5, taskId: 50 } },
  })
  assert.equal(proj.status, 200)
  const pid = proj.json.id
  assert.ok((await pull(a2)).some((c) => c.entity === 'project' && c.id === pid))
  ok('project created via REST and synced to devices')

  const m = await login('member@example.com', 'Member laptop')
  const inv = await http('POST', `/api/workspaces/${ws.id}/invites`, { token: a1.token, body: { email: 'member@example.com', role: 'member' } })
  assert.equal(inv.status, 200)
  const sm = await stream(m)
  await sm.next('changed')
  const acc = await http('POST', `/api/invites/${inv.json.token}/accept`, { token: m.token })
  assert.equal(acc.status, 200)
  assert.ok((await pull(m)).some((c) => c.entity === 'project' && c.id === pid), 'new member pulls existing projects')
  const waitM = sm.next('changed')
  await http('PATCH', `/api/projects/${pid}`, { token: a1.token, body: { description: 'Company website v2' } })
  await waitM
  ok('invite accepted; member sees projects; project edits stream to members')

  // ---- team feed ----
  const mc = crypto.randomUUID()
  const sa = await stream(a1)
  await sa.next('changed')
  const feedEvt = sa.next('feed')
  await push(m, [
    card(m, mc, { title: 'Website hero section', summary: 'Built hero', detailedSummary: 'Built hero, fixed CSS', startTs: at(10), endTs: at(11, 30), metadata: { distractions: [] } }),
    { entity: 'card_project', id: `${mc}:${pid}`, hlc: hlc(m), data: { cardId: mc, projectId: pid, share: 1, source: 'rule', confidence: 1, confirmed: true } },
    { entity: 'standup', id: `${m.userId}:${day}`, hlc: hlc(m), data: { userId: m.userId, day, payload: { highlights: [{ id: '1', text: 'Website hero section done' }], tasks: [{ id: '2', text: 'Website footer' }, { id: '3', text: 'Lunch' }] } } },
  ])
  await feedEvt
  let feed = await http('GET', `/api/projects/${pid}/feed?from=${day}&to=${day}`, { token: a1.token })
  let e = feed.json.entries.find((x: any) => x.cardId === mc)
  assert.equal(e.minutes, 90)
  assert.equal(e.title, null)
  await http('PATCH', `/api/projects/${pid}`, { token: a1.token, body: { defaultShare: 'cards' } })
  feed = await http('GET', `/api/projects/${pid}/feed?from=${day}&to=${day}`, { token: a1.token })
  e = feed.json.entries.find((x: any) => x.cardId === mc)
  assert.equal(e.title, 'Website hero section')
  assert.equal(e.detailed, null)
  const rep = await http('GET', `/api/projects/${pid}/report?from=${day}&to=${day}`, { token: a1.token })
  assert.equal(rep.json.totalMinutes, 90)
  const st = await http('GET', `/api/projects/${pid}/standup?day=${day}`, { token: a1.token })
  const sMember = st.json.members.find((x: any) => x.userId === m.userId)
  assert.deepEqual(sMember.next, ['Website footer'])
  ok('team feed honours share levels; report; standup')

  // ---- timesheets against the mock Odoo ----
  let r = await http('PUT', `/api/workspaces/${ws.id}/odoo`, { token: a1.token, body: { url: ODOO_PUBLIC, db: 'odoo15', login: 'bot@e2e.test', apiKey: 'e2e-odoo-key' } })
  assert.equal(r.status, 200)
  r = await http('POST', `/api/workspaces/${ws.id}/odoo/test`, { token: a1.token, body: {} })
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  r = await http('POST', `/api/workspaces/${ws.id}/odoo/auto-map`, { token: a1.token })
  assert.equal(r.json.employeeMap[m.userId].employeeId, 12)
  const prop = await http('GET', `/api/timesheets/proposals?from=${day}&to=${day}&workspaceId=${ws.id}`, { token: m.token })
  assert.equal(prop.json.proposals.length, 1)
  const line = prop.json.proposals[0]
  assert.equal(line.hours, 1.5)
  const sub1 = await http('POST', '/api/timesheets/submit', { token: m.token, body: { lines: [line] } })
  assert.equal(sub1.json.sent.length, 1, JSON.stringify(sub1.json))
  const sub2 = await http('POST', '/api/timesheets/submit', { token: m.token, body: { lines: [{ ...line, hours: 1.75 }] } })
  assert.equal(sub2.json.sent[0].updated, true)
  assert.equal(sub2.json.sent[0].odooLineId, sub1.json.sent[0].odooLineId)
  assert.equal(odoo.lines.size, 1)
  assert.equal(odoo.lines.get(sub1.json.sent[0].odooLineId)!.unit_amount, 1.75)
  ok('timesheet proposals, submit and idempotent resubmit (mock Odoo)')

  // ---- web link + cookie session ----
  const wl = await http('POST', '/api/auth/web-link', { token: a1.token })
  const path = new URL(wl.json.url).pathname
  const open = await fetch(BASE + path, { redirect: 'manual' })
  assert.equal(open.status, 302)
  const cookie = (open.headers.get('set-cookie') ?? '').split(';')[0]
  const meWeb = await http('GET', '/api/me', { cookie })
  assert.equal(meWeb.json.via, 'session')
  assert.equal((await fetch(BASE + path, { redirect: 'manual' })).status, 401)
  ok('web link → session cookie (single use)')

  // ---- revoke ----
  const rv = await http('DELETE', `/api/devices/${a2.deviceId}`, { token: a1.token })
  assert.equal(rv.status, 200)
  assert.equal((await http('GET', '/api/sync/pull', { token: a2.token })).status, 401)
  ok('device revoke')

  for (const s of [s2, sm, sa]) s.close()
  await odoo.close()
  console.log(JSON.stringify({ e2e: 'passed', checks: results }, null, 2))
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[e2e] FAILED:', e)
    process.exit(1)
  },
)
