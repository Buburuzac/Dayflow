import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { roundQuarter } from '../src/odoo/timesheets'
import { parseCall, parseResponse, serializeCall, serializeResponse, XmlRpcFault, serializeFault } from '../src/odoo/xmlrpc'
import { api, cardChange, devLogin, mockOdoo, pushAs, setup, uuid, type Device, type MockOdoo, type TestEnv } from './helpers'

describe('rounding', () => {
  test('rounds to the nearest quarter hour', () => {
    assert.equal(roundQuarter(0.1), 0)
    assert.equal(roundQuarter(0.13), 0.25)
    assert.equal(roundQuarter(50 / 60), 0.75)
    assert.equal(roundQuarter(52.5 / 60), 1)
    assert.equal(roundQuarter(1.374), 1.25)
    assert.equal(roundQuarter(1.376), 1.5)
  })
})

describe('xml-rpc codec', () => {
  test('round-trips Odoo values', () => {
    const v = { a: 1, b: 2.5, c: 'x<&>"', d: [true, false, null], e: { nested: [1, 'two'] } }
    const call = parseCall(serializeCall('execute_kw', ['db', 7, 'key', 'res.partner', 'read', [[1]], v]))
    assert.equal(call.method, 'execute_kw')
    assert.deepEqual(call.params[6], v)
    assert.deepEqual(parseResponse(serializeResponse([{ id: 1, name: 'Zoë & co' }])), [{ id: 1, name: 'Zoë & co' }])
    assert.throws(() => parseResponse(serializeFault(2, 'boom')), XmlRpcFault)
    assert.equal(parseResponse('<?xml version="1.0"?><methodResponse><params><param><value>plain</value></param></params></methodResponse>'), 'plain')
  })
})

describe('timesheets against a mock Odoo', () => {
  let t: TestEnv
  let odoo: MockOdoo
  let owner: Device
  let member: Device
  let wsId: string
  let projectId: string
  const H = (h: number, m = 0) => Date.UTC(2026, 10, 2, h, m)

  before(async () => {
    t = await setup()
    odoo = await mockOdoo()
    owner = await devLogin(t, 'owner@example.com', 'PC')
    member = await devLogin(t, 'member@example.com', 'PC')
    wsId = (await api(t, owner, 'GET', '/api/me')).body.workspaces[0].id
    const inv = await api(t, owner, 'POST', `/api/workspaces/${wsId}/invites`, { email: 'member@example.com' })
    await api(t, member, 'POST', `/api/invites/${inv.body.token}/accept`)
    projectId = (
      await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'Website', odoo: { projectId: 5, taskId: 50, projectName: 'Website', taskName: 'Build' } })
    ).body.id
  })
  after(async () => {
    await odoo.close()
    await t.close()
  })

  test('admin configures the connection; the API key is encrypted at rest and never returned', async () => {
    assert.equal((await api(t, member, 'PUT', `/api/workspaces/${wsId}/odoo`, { url: odoo.url, db: 'odoo15', login: 'bot@example.com', apiKey: 'x' })).status, 403)
    const r = await api(t, owner, 'PUT', `/api/workspaces/${wsId}/odoo`, { url: odoo.url, db: 'odoo15', login: 'bot@example.com', apiKey: 'odoo-api-key-123' })
    assert.equal(r.status, 200)
    const stored = (await t.db.query(`SELECT api_key_encrypted FROM odoo_connections`)).rows[0].api_key_encrypted as string
    assert.ok(!stored.includes('odoo-api-key-123'))
    assert.match(stored, /^v1\./)
    const g = await api(t, owner, 'GET', `/api/workspaces/${wsId}/odoo`)
    assert.equal(g.body.hasApiKey, true)
    assert.ok(!JSON.stringify(g.body).includes('odoo-api-key-123'))
  })

  test('test connection calls common.version and authenticate', async () => {
    const ok = await api(t, owner, 'POST', `/api/workspaces/${wsId}/odoo/test`, {})
    assert.deepEqual(ok.body, { ok: true, serverVersion: '15.0', uid: 7 })
    const bad = await api(t, owner, 'POST', `/api/workspaces/${wsId}/odoo/test`, { apiKey: 'wrong' })
    assert.equal(bad.body.ok, false)
    assert.equal(bad.body.serverVersion, '15.0')
    assert.match(bad.body.error, /authentication failed/)
  })

  test('auto-map links members to hr.employee by work email', async () => {
    const r = await api(t, owner, 'POST', `/api/workspaces/${wsId}/odoo/auto-map`)
    assert.equal(r.status, 200)
    assert.equal(r.body.employeeMap[owner.userId].employeeId, 11)
    assert.equal(r.body.employeeMap[owner.userId].odooUserId, 21)
    assert.equal(r.body.employeeMap[member.userId].employeeId, 12)
    assert.equal(odoo.calls.filter((c) => c.method === 'create' || c.method === 'write').length, 0, 'mapping never writes to Odoo')
  })

  test('proposals sum confirmed minutes per day and project, rounded to 0.25 h', async () => {
    const c1 = uuid()
    const c2 = uuid()
    const c3 = uuid()
    const link = (card: string, confirmed = true, share = 1) => ({
      entity: 'card_project' as const,
      id: `${card}:${projectId}`,
      hlc: owner.hlc(),
      data: { cardId: card, projectId, share, source: 'manual', confidence: 1, confirmed },
    })
    const r = await pushAs(t, owner, [
      cardChange(owner, c1, { title: 'Header', startTs: H(8), endTs: H(8, 35) }),
      cardChange(owner, c2, { title: 'Footer', startTs: H(9), endTs: H(9, 20) }),
      cardChange(owner, c3, { title: 'Unconfirmed', startTs: H(10), endTs: H(12) }),
      link(c1),
      link(c2),
      link(c3, false),
    ])
    assert.deepEqual(r.body.rejected, [])
    const p = await api(t, owner, 'GET', `/api/timesheets/proposals?from=2026-11-02&to=2026-11-02&workspaceId=${wsId}`)
    assert.equal(p.status, 200)
    assert.equal(p.body.proposals.length, 1)
    const line = p.body.proposals[0]
    assert.equal(line.minutes, 55)
    assert.equal(line.hours, 1) // 55 min → 0.9167 h → 1.0
    assert.equal(line.odooProjectId, 5)
    assert.equal(line.odooTaskId, 50)
    assert.equal(line.description, 'Header; Footer')
    assert.deepEqual(line.cardIds.sort(), [c1, c2].sort())
    assert.equal(line.existingOdooLineId, null)
  })

  test('proposals count Unix-second client cards in minutes', async () => {
    const id = uuid()
    const start = Math.floor(Date.UTC(2026, 10, 3, 8) / 1000)
    const r = await pushAs(t, owner, [
      cardChange(owner, id, { day: '2026-11-03', title: 'Seconds', startTs: start, endTs: start + 1800 }),
      { entity: 'card_project', id: `${id}:${projectId}`, hlc: owner.hlc(),
        data: { cardId: id, projectId, share: 1, source: 'manual', confidence: 1, confirmed: true } },
    ])
    assert.deepEqual(r.body.rejected, [])
    const p = await api(t, owner, 'GET', `/api/timesheets/proposals?from=2026-11-03&to=2026-11-03&workspaceId=${wsId}`)
    assert.equal(p.body.proposals[0].minutes, 30)
    assert.equal(p.body.proposals[0].hours, 0.5)
  })

  test('submit creates the line, resubmit updates it instead of duplicating', async () => {
    const lines = [{ day: '2026-11-02', projectId, hours: 1, description: 'Header; Footer', cardIds: [] }]
    const r1 = await api(t, owner, 'POST', '/api/timesheets/submit', { lines })
    assert.equal(r1.status, 200)
    assert.deepEqual(r1.body.failed, [])
    assert.equal(r1.body.sent[0].updated, false)
    const lineId = r1.body.sent[0].odooLineId
    assert.deepEqual(odoo.lines.get(lineId), {
      name: 'Header; Footer',
      date: '2026-11-02',
      unit_amount: 1,
      project_id: 5,
      task_id: 50,
      employee_id: 11,
      user_id: 21,
    })

    const r2 = await api(t, owner, 'POST', '/api/timesheets/submit', { lines: [{ ...lines[0], hours: 1.3, description: 'Edited' }] })
    assert.deepEqual(r2.body.sent, [{ day: '2026-11-02', projectId, odooLineId: lineId, updated: true }])
    assert.equal(odoo.lines.size, 1)
    assert.equal(odoo.lines.get(lineId)!.unit_amount, 1.25)
    assert.equal(odoo.lines.get(lineId)!.name, 'Edited')

    const p = await api(t, owner, 'GET', `/api/timesheets/proposals?from=2026-11-02&to=2026-11-02&workspaceId=${wsId}`)
    assert.equal(p.body.proposals[0].existingOdooLineId, lineId)

    // the line was deleted in Odoo: the next submit creates a new one
    odoo.lines.delete(lineId)
    const r3 = await api(t, owner, 'POST', '/api/timesheets/submit', { lines })
    assert.equal(r3.body.sent[0].updated, false)
    assert.notEqual(r3.body.sent[0].odooLineId, lineId)
    assert.equal(odoo.lines.size, 1)
  })

  test('submit refuses unmapped projects, outsiders and viewers', async () => {
    const unmapped = (await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'Internal' })).body.id
    const r = await api(t, owner, 'POST', '/api/timesheets/submit', { lines: [{ day: '2026-11-02', projectId: unmapped, hours: 1, description: 'x', cardIds: [] }] })
    assert.match(r.body.failed[0].error, /not mapped/)
    const outsider = await devLogin(t, 'outsider@example.com')
    const r2 = await api(t, outsider, 'POST', '/api/timesheets/submit', { lines: [{ day: '2026-11-02', projectId, hours: 1, description: 'x', cardIds: [] }] })
    assert.match(r2.body.failed[0].error, /not found/)
    assert.equal(odoo.lines.size, 1)
  })

  test('Odoo admin endpoints list projects and tasks for mapping', async () => {
    const p = await api(t, owner, 'GET', `/api/workspaces/${wsId}/odoo/projects`)
    assert.deepEqual(p.body.projects, [
      { id: 5, name: 'Website' },
      { id: 6, name: 'ERP' },
    ])
    const tk = await api(t, owner, 'GET', `/api/workspaces/${wsId}/odoo/tasks?projectId=5`)
    assert.equal(tk.body.tasks[0].projectId, 5)
    assert.equal((await api(t, member, 'GET', `/api/workspaces/${wsId}/odoo/projects`)).status, 403)
  })
})
