import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { api, cardChange, devLogin, pushAs, setup, uuid, type Device, type TestEnv } from './helpers'

let t: TestEnv
let owner: Device
let member: Device
let outsider: Device
let wsId: string
let projectId: string

const H = (h: number, m = 0) => Date.UTC(2026, 10, 2, h, m)

before(async () => {
  t = await setup()
  owner = await devLogin(t, 'owner@example.com', 'Owner PC')
  member = await devLogin(t, 'member@example.com', 'Member PC')
  outsider = await devLogin(t, 'outsider@example.com', 'Outsider PC')
  wsId = (await api(t, owner, 'GET', '/api/me')).body.workspaces[0].id
  const inv = await api(t, owner, 'POST', `/api/workspaces/${wsId}/invites`, { email: 'member@example.com', role: 'member' })
  assert.equal(inv.status, 200)
  const acc = await api(t, member, 'POST', `/api/invites/${inv.body.token}/accept`)
  assert.equal(acc.status, 200)
  const p = await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'Website', defaultShare: 'time' })
  assert.equal(p.status, 200)
  projectId = p.body.id
})
after(() => t.close())

async function cardWithProject(d: Device, opts: { title: string; start: number; end: number; confirmed?: boolean; share?: number; metadata?: Record<string, unknown> }) {
  const id = uuid()
  const r = await pushAs(t, d, [
    cardChange(d, id, {
      title: opts.title,
      summary: `${opts.title} summary`,
      detailedSummary: `${opts.title} detailed`,
      startTs: opts.start,
      endTs: opts.end,
      metadata: { distractions: [{ title: 'news' }], ...(opts.metadata ?? {}) },
    }),
    {
      entity: 'card_project',
      id: `${id}:${projectId}`,
      hlc: d.hlc(),
      data: { cardId: id, projectId, share: opts.share ?? 1, source: 'llm', confidence: 0.9, confirmed: opts.confirmed ?? true },
    },
  ])
  assert.deepEqual(r.body.rejected, [])
  return id
}

const feed = async (d: Device) => (await api(t, d, 'GET', `/api/projects/${projectId}/feed?from=2026-11-01&to=2026-11-03`)).body

describe('project_entries projection', () => {
  test('time level: minutes only; unconfirmed and private cards are not projected', async () => {
    const shared = await cardWithProject(member, { title: 'Landing page', start: H(8), end: H(9) })
    const unconfirmed = await cardWithProject(member, { title: 'Maybe website', start: H(9), end: H(10), confirmed: false })
    const priv = await cardWithProject(member, { title: 'Secret', start: H(10), end: H(11), metadata: { private: true } })
    const f = await feed(owner)
    const ids = f.entries.map((e: any) => e.cardId)
    assert.ok(ids.includes(shared))
    assert.ok(!ids.includes(unconfirmed))
    assert.ok(!ids.includes(priv))
    const e = f.entries.find((x: any) => x.cardId === shared)
    assert.equal(e.minutes, 60)
    assert.equal(e.shareLevel, 'time')
    assert.equal(e.title, null)
    assert.equal(e.summary, null)
    assert.equal(e.detailed, null)
    assert.equal(e.day, '2026-11-02')
  })

  test('cards and detailed levels; member override beats project default', async () => {
    let r = await api(t, owner, 'PATCH', `/api/workspaces/${wsId}/projects/${projectId}`, { defaultShare: 'cards' })
    assert.equal(r.status, 200)
    let f = await feed(owner)
    let e = f.entries.find((x: any) => x.title === 'Landing page')
    assert.equal(e.shareLevel, 'cards')
    assert.equal(e.summary, 'Landing page summary')
    assert.equal(e.detailed, null)

    // the member raises their own level
    r = await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: 'detailed' })
    assert.equal(r.status, 200)
    f = await feed(owner)
    e = f.entries.find((x: any) => x.title === 'Landing page')
    assert.equal(e.shareLevel, 'detailed')
    assert.equal(e.detailed, 'Landing page detailed')
    assert.deepEqual(e.distractions, [{ title: 'news' }])

    // and lowers it back to minutes only
    await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: 'time' })
    f = await feed(owner)
    e = f.entries.find((x: any) => x.cardId && x.minutes === 60 && x.userId === member.userId)
    assert.equal(e.title, null)
    assert.equal(e.shareLevel, 'time')
    await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: null })
  })

  test('a member cannot set someone else’s share level', async () => {
    const r = await api(t, member, 'PUT', `/api/projects/${projectId}/members/${owner.userId}`, { shareLevel: 'detailed' })
    assert.equal(r.status, 403)
  })

  test('confirming, marking private and deleting recompute the projection', async () => {
    const id = await cardWithProject(member, { title: 'Pending', start: H(12), end: H(12, 30), confirmed: false })
    assert.ok(!(await feed(owner)).entries.some((e: any) => e.cardId === id))
    await pushAs(t, member, [
      { entity: 'card_project', id: `${id}:${projectId}`, hlc: member.hlc(), data: { cardId: id, projectId, share: 1, source: 'llm', confidence: 0.9, confirmed: true } },
    ])
    assert.ok((await feed(owner)).entries.some((e: any) => e.cardId === id))
    const h = member.hlc()
    await pushAs(t, member, [cardChange(member, id, { title: 'Pending', metadata: { private: true } }, { hlc: h, fieldHlc: { private: h } })])
    assert.ok(!(await feed(owner)).entries.some((e: any) => e.cardId === id))
    const id2 = await cardWithProject(member, { title: 'To delete', start: H(13), end: H(13, 30) })
    assert.ok((await feed(owner)).entries.some((e: any) => e.cardId === id2))
    const d = member.hlc()
    await pushAs(t, member, [{ entity: 'card', id: id2, hlc: d, deleted: true, fieldHlc: { deleted: d } }])
    assert.ok(!(await feed(owner)).entries.some((e: any) => e.cardId === id2))
  })

  test('shares split minutes and are scaled when they sum above 1', async () => {
    const other = (await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'ERP' })).body.id
    const id = uuid()
    await pushAs(t, member, [
      cardChange(member, id, { title: 'Split', startTs: H(14), endTs: H(15) }),
      { entity: 'card_project', id: `${id}:${projectId}`, hlc: member.hlc(), data: { cardId: id, projectId, share: 0.75, source: 'manual', confidence: 1, confirmed: true } },
      { entity: 'card_project', id: `${id}:${other}`, hlc: member.hlc(), data: { cardId: id, projectId: other, share: 0.75, source: 'manual', confidence: 1, confirmed: true } },
    ])
    const e = (await feed(owner)).entries.find((x: any) => x.cardId === id)
    assert.equal(e.minutes, 30)
  })

  test('seconds-based cards count minutes and filter detailed lines and distractions per project', async () => {
    await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: 'detailed' })
    const id = uuid()
    const start = H(18) / 1000
    const metadata: { detailProjects: Record<string, { projectId: string; share: number; confirmed: boolean }[]>; distractions: { title: string }[] } = { detailProjects: {
      'detail:0': [{ projectId, share: 1, confirmed: true }],
      'detail:1': [],
      'distraction:0': [{ projectId, share: 1, confirmed: true }],
      'distraction:1': [],
    }, distractions: [{ title: 'review' }, { title: 'unrelated' }] }
    await pushAs(t, member, [
      cardChange(member, id, { title: 'Mixed work', startTs: start, endTs: start + 1800, detailedSummary: '18:00 - 18:15: project work\n18:15 - 18:30: other work', metadata }),
      { entity: 'card_project', id: `${id}:${projectId}`, hlc: member.hlc(), data: { cardId: id, projectId, share: 0.5, source: 'manual', confidence: 1, confirmed: true } },
    ])
    const e = (await feed(owner)).entries.find((x: any) => x.cardId === id)
    assert.equal(e.minutes, 15)
    assert.equal(e.detailed, '18:00 - 18:15: project work')
    assert.deepEqual(e.distractions, [{ title: 'review' }])
    const timeline = await api(t, owner, 'GET', `/api/workspaces/${wsId}/members/${member.userId}/timeline?from=2026-11-02&to=2026-11-02`)
    const visible = timeline.body.cards.find((c: any) => c.id === id)
    assert.equal(visible.title, 'Project work / Out of scope')
    assert.equal(visible.summary, '')
    assert.equal(visible.detailedSummary, '18:00 - 18:15: project work')
    assert.deepEqual(visible.metadata.distractions, [{ title: 'review' }])
    assert.deepEqual(visible.metadata.summaryBreakdown, [
      { scope: 'project', projects: [projectId], line: '18:00 - 18:15: project work' },
      { scope: 'out-of-scope', projects: [], line: '18:15 - 18:30' },
    ])
    const edited = member.hlc()
    metadata.detailProjects['detail:1'] = [{ projectId, share: 1, confirmed: true }]
    await pushAs(t, member, [
      { entity: 'card', id, hlc: edited, fieldHlc: { detailProjects: edited }, data: { metadata } },
      { entity: 'card_project', id: `${id}:${projectId}`, hlc: member.hlc(), data: { cardId: id, projectId, share: 1, source: 'manual', confidence: 1, confirmed: true } },
    ])
    const updated = (await feed(owner)).entries.find((x: any) => x.cardId === id)
    assert.equal(updated.minutes, 30)
    assert.match(updated.detailed, /other work/)
    await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: null })
  })

  test('detailed line keys skip whitespace-only lines, including CRLF blanks', async () => {
    await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: 'detailed' })
    const id = uuid()
    const start = H(19) / 1000
    const metadata = { detailProjects: { 'detail:0': [], 'detail:1': [{ projectId, share: 1, confirmed: true }] } }
    await pushAs(t, member, [
      cardChange(member, id, { title: 'CRLF', startTs: start, endTs: start + 1800, detailedSummary: '19:00 - 19:15: other work\r\n\t\r\n19:15 - 19:30: project work', metadata }),
      { entity: 'card_project', id: `${id}:${projectId}`, hlc: member.hlc(), data: { cardId: id, projectId, share: 0.5, source: 'manual', confidence: 1, confirmed: true } },
    ])
    const e = (await feed(owner)).entries.find((x: any) => x.cardId === id)
    assert.equal(e.detailed, '19:15 - 19:30: project work')
    await api(t, member, 'PUT', `/api/projects/${projectId}/members/${member.userId}`, { shareLevel: null })
  })

  test('feed, report and standup are for workspace members only', async () => {
    assert.equal((await api(t, outsider, 'GET', `/api/projects/${projectId}/feed?from=2026-11-01&to=2026-11-03`)).status, 404)
    const rep = (await api(t, owner, 'GET', `/api/projects/${projectId}/report?from=2026-11-01&to=2026-11-03`)).body
    assert.equal(rep.projectId, projectId)
    assert.ok(rep.totalMinutes >= 60)
    assert.equal(rep.byMember[0].userId, member.userId)
    assert.equal(rep.byDay[0].day, '2026-11-02')
    assert.ok(Array.isArray(rep.byCategory))
  })

  test('standup keeps only bullets that relate to the project and respects the share level', async () => {
    await api(t, owner, 'PATCH', `/api/projects/${projectId}`, { defaultShare: 'cards' })
    await pushAs(t, member, [
      {
        entity: 'standup',
        id: `${member.userId}:2026-11-03`,
        hlc: member.hlc(),
        data: {
          userId: member.userId,
          day: '2026-11-03',
          payload: {
            highlights: [{ id: '1', text: 'Finished the landing page layout' }, { id: '2', text: 'Dentist appointment' }],
            tasks: [{ id: '3', text: 'Website: contact form' }, { id: '4', text: 'Taxes' }],
            generation: { provider: 'gemini', runtime: 'gemini_direct', sourceDay: '2026-11-02' },
          },
        },
      },
    ])
    const s = (await api(t, owner, 'GET', `/api/projects/${projectId}/standup?day=2026-11-03`)).body
    const m = s.members.find((x: any) => x.userId === member.userId)
    assert.equal(m.sourceDay, '2026-11-02')
    assert.deepEqual(m.done, ['Finished the landing page layout'])
    assert.deepEqual(m.next, ['Website: contact form'])
    await api(t, owner, 'PATCH', `/api/projects/${projectId}`, { defaultShare: 'time' })
    const s2 = (await api(t, owner, 'GET', `/api/projects/${projectId}/standup?day=2026-11-03`)).body
    const m2 = s2.members.find((x: any) => x.userId === member.userId)
    assert.deepEqual(m2.done, [])
    assert.deepEqual(m2.next, [])
  })

  test('leaving the workspace removes the member’s entries', async () => {
    const before = (await feed(owner)).entries.filter((e: any) => e.userId === member.userId).length
    assert.ok(before > 0)
    const r = await api(t, member, 'DELETE', `/api/workspaces/${wsId}/members/${member.userId}`)
    assert.equal(r.status, 200)
    assert.equal((await feed(owner)).entries.filter((e: any) => e.userId === member.userId).length, 0)
  })

  test('timeline returns the caller’s own cards with device lanes and projects', async () => {
    const tl = (await api(t, member, 'GET', '/api/me/timeline?from=2026-11-02&to=2026-11-02')).body
    assert.ok(tl.cards.length > 0)
    assert.ok(tl.cards.every((c: any) => c.deviceId === member.deviceId))
    assert.ok(tl.devices.some((d: any) => d.id === member.deviceId && d.current))
    assert.ok(tl.cards.some((c: any) => c.projects.length > 0))
    assert.equal(tl.categories, null)
  })
})
