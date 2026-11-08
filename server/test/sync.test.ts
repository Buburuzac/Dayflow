import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { formatHlc } from '../src/shared'
import { api, cardChange, devLogin, pullAll, pushAs, setup, uuid, type Device, type TestEnv } from './helpers'

let t: TestEnv
let a1: Device // owner@example.com, PC 1 (generating device)
let a2: Device // owner@example.com, PC 2
let b: Device // someone else

before(async () => {
  t = await setup()
  a1 = await devLogin(t, 'owner@example.com', 'PC 1')
  a2 = await devLogin(t, 'owner@example.com', 'PC 2')
  b = await devLogin(t, 'other@example.com', 'Laptop')
})
after(() => t.close())

const findCard = (changes: any[], id: string) => changes.filter((c) => c.entity === 'card' && c.id === id).at(-1)

describe('push / pull', () => {
  test('two devices of one user see each other, other users see nothing', async () => {
    const id = uuid()
    const r = await pushAs(t, a1, [cardChange(a1, id, { title: 'Write spec' })])
    assert.equal(r.status, 200)
    assert.equal(r.body.accepted, 1)
    assert.deepEqual(r.body.rejected, [])
    assert.equal(typeof r.body.serverTime, 'number')

    const p = await pullAll(t, a2)
    const c = findCard(p.changes, id)
    assert.ok(c, 'PC 2 pulls the card')
    assert.equal(c.data.title, 'Write spec')
    assert.equal(c.data.originDeviceId, a1.deviceId)
    assert.equal(c.deviceId, a1.deviceId)
    assert.ok(p.cursor > 0)

    const echo = await pullAll(t, a1)
    assert.ok(findCard(echo.changes, id), 'own echo is included')

    const other = await pullAll(t, b)
    assert.equal(findCard(other.changes, id), undefined)
  })

  test('cursor pagination', async () => {
    const changes = Array.from({ length: 5 }, () => ({ entity: 'observation' as const, id: uuid(), hlc: a1.hlc(), data: { userId: a1.userId, startTs: 1, endTs: 2, text: 'obs' } }))
    assert.equal((await pushAs(t, a1, changes)).body.accepted, 5)
    const first = (await t.app.inject({ url: '/api/sync/pull?cursor=0&limit=2', headers: a2.headers })).json()
    assert.equal(first.changes.length, 2)
    assert.equal(first.more, true)
    let cursor = first.cursor
    let seen = first.changes.length
    for (;;) {
      const page = (await t.app.inject({ url: `/api/sync/pull?cursor=${cursor}&limit=2`, headers: a2.headers })).json()
      seen += page.changes.length
      for (const c of page.changes) assert.ok(true, c)
      cursor = page.cursor
      if (!page.more) break
    }
    const all = await pullAll(t, a2)
    assert.equal(seen, all.changes.length)
  })

  test('rejects more than 1000 changes per request', async () => {
    const changes = Array.from({ length: 1001 }, () => ({ entity: 'observation', id: uuid(), hlc: a1.hlc(), deviceId: a1.deviceId }))
    const r = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: a1.headers, payload: { changes } })
    assert.equal(r.statusCode, 400)
  })

  test('sync endpoints require a device token', async () => {
    assert.equal((await api(t, null, 'GET', '/api/sync/pull')).status, 401)
    assert.equal((await t.app.inject({ url: '/api/sync/pull', headers: { authorization: 'Bearer nope' } })).statusCode, 401)
  })
})

describe('card merge rules', () => {
  test('per-field LWW: rename on PC 2 and category change on PC 1 both survive', async () => {
    const id = uuid()
    await pushAs(t, a1, [cardChange(a1, id, { title: 'Original', category: 'Work' })])

    // PC 2 renames (user edit, explicit field clock)
    const h2 = a2.hlc(1000)
    let r = await pushAs(t, a2, [cardChange(a2, id, { title: 'Renamed on PC2', category: 'Work' }, { hlc: h2, fieldHlc: { title: h2 } })])
    assert.equal(r.body.accepted, 1)

    // PC 1 has not pulled yet: changes the category with its own field clock (title still the old one)
    const h1 = a1.hlc(2000)
    r = await pushAs(t, a1, [cardChange(a1, id, { title: 'Original', category: 'Personal' }, { hlc: h1, fieldHlc: { category: h1 } })])
    assert.equal(r.body.accepted, 1)

    const c = findCard((await pullAll(t, a2)).changes, id)
    assert.equal(c.data.title, 'Renamed on PC2')
    assert.equal(c.data.category, 'Personal')
    assert.equal(c.fieldHlc.title, h2)
    assert.equal(c.fieldHlc.category, h1)
    assert.equal(c.hlc, h1 > h2 ? h1 : h2)
  })

  test('re-analysis on the generating device keeps user edits but updates analysis fields', async () => {
    const id = uuid()
    await pushAs(t, a1, [cardChange(a1, id, { title: 'LLM title', summary: 'v1' })])
    const h2 = a2.hlc(1000)
    await pushAs(t, a2, [cardChange(a2, id, { title: 'My title' }, { hlc: h2, fieldHlc: { title: h2 } })])
    // later analysis rewrite, no field clocks
    await pushAs(t, a1, [cardChange(a1, id, { title: 'LLM title v2', summary: 'v2', endTs: Date.UTC(2026, 10, 2, 9, 30) }, { hlc: a1.hlc(5000) })])
    const c = findCard((await pullAll(t, a1)).changes, id)
    assert.equal(c.data.title, 'My title')
    assert.equal(c.data.summary, 'v2')
    assert.equal(c.data.endTs, Date.UTC(2026, 10, 2, 9, 30))
  })

  test('a non-generating device cannot change analysis fields', async () => {
    const id = uuid()
    await pushAs(t, a1, [cardChange(a1, id, { summary: 'from PC1' })])
    const h = a2.hlc(1000)
    const r = await pushAs(t, a2, [cardChange(a2, id, { summary: 'hacked by PC2', title: 'Card' }, { hlc: h, fieldHlc: { title: h } })])
    assert.equal(r.body.accepted, 1)
    const c = findCard((await pullAll(t, a1)).changes, id)
    assert.equal(c.data.summary, 'from PC1')
  })

  test('older clocks lose; delete merges as a field', async () => {
    const id = uuid()
    const h0 = a1.hlc()
    await pushAs(t, a1, [cardChange(a1, id, { title: 'A' }, { hlc: h0 })])
    const late = a2.hlc(3000)
    await pushAs(t, a2, [cardChange(a2, id, { title: 'B' }, { hlc: late, fieldHlc: { title: late } })])
    const early = formatHlc(t.clock.now + 1000, 0, a1.deviceId)
    await pushAs(t, a1, [cardChange(a1, id, { title: 'C' }, { hlc: early, fieldHlc: { title: early } })])
    let c = findCard((await pullAll(t, a1)).changes, id)
    assert.equal(c.data.title, 'B')

    const del = a2.hlc(4000)
    await pushAs(t, a2, [{ entity: 'card', id, hlc: del, deleted: true, fieldHlc: { deleted: del } }])
    c = findCard((await pullAll(t, a1)).changes, id)
    assert.equal(c.deleted, true)
  })

  test('private flag set from another device is kept across re-analysis', async () => {
    const id = uuid()
    await pushAs(t, a1, [cardChange(a1, id, { metadata: { appSites: { primary: 'x' } } })])
    const h = a2.hlc(1000)
    await pushAs(t, a2, [cardChange(a2, id, { metadata: { private: true } }, { hlc: h, fieldHlc: { private: h } })])
    await pushAs(t, a1, [cardChange(a1, id, { metadata: { appSites: { primary: 'y' } } }, { hlc: a1.hlc(2000) })])
    const c = findCard((await pullAll(t, a1)).changes, id)
    assert.equal(c.data.metadata.private, true)
    assert.deepEqual(c.data.metadata.appSites, { primary: 'y' })
  })
})

describe('ownership and clock guards', () => {
  test('rejects a change signed with another device id', async () => {
    const id = uuid()
    const r = await pushAs(t, a1, [{ ...cardChange(a2, id, {}), deviceId: a2.deviceId }])
    assert.equal(r.body.accepted, 0)
    assert.deepEqual(r.body.rejected, [{ id, reason: 'foreign_device' }])
  })

  test('rejects an HLC whose device suffix differs from deviceId', async () => {
    const id = uuid()
    const r = await pushAs(t, a1, [cardChange(a1, id, {}, { hlc: formatHlc(t.clock.now, 0, a2.deviceId) })])
    assert.equal(r.body.rejected[0].reason, 'hlc_device_mismatch')
  })

  test('rejects writes to another user’s records', async () => {
    const id = uuid()
    await pushAs(t, a1, [cardChange(a1, id, { title: 'mine' })])
    const r = await pushAs(t, b, [cardChange(b, id, { title: 'stolen', userId: b.userId }, { hlc: b.hlc(10_000) })])
    assert.equal(r.body.rejected[0].reason, 'not_owner')
    const r2 = await pushAs(t, b, [cardChange(b, uuid(), { userId: a1.userId })])
    assert.equal(r2.body.rejected[0].reason, 'user_mismatch')
    const r3 = await pushAs(t, b, [{ entity: 'standup', id: `${a1.userId}:2026-11-02`, hlc: b.hlc(), data: { payload: {} } }])
    assert.equal(r3.body.rejected[0].reason, 'not_owner')
    const c = findCard((await pullAll(t, a1)).changes, id)
    assert.equal(c.data.title, 'mine')
  })

  test('rejects HLCs more than 5 minutes in the future (record and field clocks)', async () => {
    const id = uuid()
    const future = formatHlc(t.clock.now + 6 * 60_000, 0, a1.deviceId)
    let r = await pushAs(t, a1, [cardChange(a1, id, {}, { hlc: future })])
    assert.deepEqual(r.body.rejected, [{ id, reason: 'hlc_in_future' }])
    r = await pushAs(t, a1, [cardChange(a1, id, {}, { fieldHlc: { title: future } })])
    assert.equal(r.body.rejected[0].reason, 'hlc_in_future')
    const ok = formatHlc(t.clock.now + 4 * 60_000, 0, a1.deviceId)
    r = await pushAs(t, a1, [cardChange(a1, id, {}, { hlc: ok })])
    assert.equal(r.body.accepted, 1)
  })

  test('only workspace admins can write projects through sync; members may set their own share level', async () => {
    const me = (await api(t, a1, 'GET', '/api/me')).body
    const ws = me.workspaces[0]
    assert.equal(ws.role, 'owner', 'bootstrap admin owns the default workspace')
    const pid = uuid()
    const data = { workspaceId: ws.id, name: 'Sync project', color: '#f00', description: '', rules: {}, defaultShare: 'cards', archived: false }
    let r = await pushAs(t, b, [{ entity: 'project', id: pid, hlc: b.hlc(), data }])
    assert.equal(r.body.rejected[0].reason, 'forbidden')
    r = await pushAs(t, a1, [{ entity: 'project', id: pid, hlc: a1.hlc(), data }])
    assert.equal(r.body.accepted, 1)
    const pulled = (await pullAll(t, a2)).changes.find((c) => c.entity === 'project' && c.id === pid)
    assert.equal(pulled?.data?.name, 'Sync project')
    // b is not a member: cannot see it, cannot assign cards to it
    assert.equal((await pullAll(t, b)).changes.find((c) => c.entity === 'project'), undefined)
    const card = uuid()
    r = await pushAs(t, b, [
      cardChange(b, card, {}),
      { entity: 'card_project', id: `${card}:${pid}`, hlc: b.hlc(), data: { cardId: card, projectId: pid, share: 1, source: 'manual', confidence: 1, confirmed: true } },
    ])
    assert.equal(r.body.rejected[0].reason, 'forbidden_project')
  })
})

describe('stream', () => {
  test('SSE emits `changed` to the user’s other devices after a push', async () => {
    const ac = new AbortController()
    const res = await fetch(`${t.baseUrl}/api/sync/stream`, { headers: a2.headers, signal: ac.signal })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const waitFor = async (needle: string, count: number) => {
      const deadline = Date.now() + 5000
      while (buf.split(needle).length - 1 < count) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}; got ${buf}`)
        const { value, done } = await reader.read()
        if (done) throw new Error('stream closed')
        buf += dec.decode(value)
      }
    }
    await waitFor('event: changed', 1) // initial nudge
    // other user's push must not reach a2
    await pushAs(t, b, [cardChange(b, uuid(), {})])
    await pushAs(t, a1, [cardChange(a1, uuid(), {})])
    await waitFor('event: changed', 2)
    ac.abort()
    assert.equal(buf.split('event: changed').length - 1, 2)
  })
})
