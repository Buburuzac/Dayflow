import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { WorkspaceRole } from '../src/shared'
import { api, cardChange, devLogin, pushAs, setup, uuid, type Device, type TestEnv } from './helpers'

// Shared fixtures are never changed by a test: anything a test mutates (roles, share levels, devices)
// belongs to a person created for that test with `join`.
let t: TestEnv
let owner: Device
let member: Device
let idle: Device
let outsider: Device
let wsId: string
let website: string
let erp: string

const H = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m)
const dayOf = (day: number) => `2026-11-${String(day).padStart(2, '0')}`
const reportUrl = (from = '2026-11-02', to = '2026-11-03') => `/api/workspaces/${wsId}/report?from=${from}&to=${to}`
const usersUrl = (from: string, to = from) => `/api/workspaces/${wsId}/users?from=${from}&to=${to}`
const timelineUrl = (userId: string, from: string, to = from) => `/api/workspaces/${wsId}/members/${userId}/timeline?from=${from}&to=${to}`

/** Signs a new person in and adds them to the workspace with the given role. */
async function join(email: string, role: WorkspaceRole = 'member', deviceName = 'PC'): Promise<Device> {
  const d = await devLogin(t, email, deviceName)
  const inv = await api(t, owner, 'POST', `/api/workspaces/${wsId}/invites`, { email, role })
  assert.equal((await api(t, d, 'POST', `/api/invites/${inv.body.token}/accept`)).status, 200)
  return d
}

before(async () => {
  t = await setup()
  owner = await devLogin(t, 'owner@example.com', 'Owner PC')
  outsider = await devLogin(t, 'outsider@example.com', 'Outsider PC')
  wsId = (await api(t, owner, 'GET', '/api/me')).body.workspaces[0].id
  member = await join('member@example.com', 'member', 'Member PC')
  idle = await join('idle@example.com', 'member', 'Idle PC')
  website = (await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'Website', color: '#4276E9', defaultShare: 'cards' })).body.id
  erp = (await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'ERP', color: '#4CB8A4', defaultShare: 'detailed' })).body.id
})
after(() => t.close())

interface Link {
  projectId: string
  share?: number
  confirmed?: boolean
}

/** One card with its project links; returns the card id. */
async function work(d: Device, day: number, start: number, end: number, links: Link[] = [], data: Record<string, unknown> = {}): Promise<string> {
  const id = uuid()
  const r = await pushAs(t, d, [
    cardChange(d, id, { day: dayOf(day), startTs: H(day, start), endTs: H(day, end), ...data }),
    ...links.map((l) => ({
      entity: 'card_project' as const,
      id: `${id}:${l.projectId}`,
      hlc: d.hlc(),
      data: { cardId: id, projectId: l.projectId, share: l.share ?? 1, source: 'manual', confidence: 1, confirmed: l.confirmed ?? true },
    })),
  ])
  assert.deepEqual(r.body.rejected, [])
  return id
}

describe('workspace report', () => {
  test('sums confirmed project time per member, project and day', async () => {
    await work(member, 2, 8, 10, [{ projectId: website }]) // 120 website
    await work(member, 3, 8, 9, [{ projectId: website, share: 0.5 }, { projectId: erp, share: 0.5 }]) // 30 + 30
    await work(member, 3, 9, 10, [{ projectId: erp, confirmed: false }]) // unconfirmed: not counted
    await work(member, 3, 10, 11, [{ projectId: erp }], { metadata: { private: true } }) // private: not counted
    await work(owner, 2, 9, 10, [{ projectId: erp }]) // 60 erp
    await work(owner, 5, 9, 10, [{ projectId: erp }]) // outside the range

    const r = await api(t, owner, 'GET', reportUrl())
    assert.equal(r.status, 200)
    const rep = r.body
    assert.equal(rep.totalMinutes, 240)

    const users = new Map(rep.users.map((u: any) => [u.email, u]))
    assert.equal(rep.users.length, 3, 'every member is listed, including those without time')
    assert.equal(rep.users[0].email, 'member@example.com', 'sorted by time')
    const m = users.get('member@example.com') as any
    assert.equal(m.minutes, 180)
    assert.equal(m.activeDays, 2)
    assert.equal(m.projectCount, 2)
    assert.equal(m.role, 'member')
    assert.ok(m.lastSeenAt > 0)
    const i = users.get('idle@example.com') as any
    assert.equal(i.minutes, 0)
    assert.equal(i.activeDays, 0)
    assert.equal((users.get('owner@example.com') as any).minutes, 60)
    assert.ok(!users.has('outsider@example.com'))

    assert.deepEqual(
      rep.projects.map((p: any) => [p.name, p.minutes, p.userCount, p.color]),
      [
        ['Website', 150, 1, '#4276E9'],
        ['ERP', 90, 2, '#4CB8A4'],
      ],
    )
    const cell = (u: Device, p: string) => rep.byUserProject.find((x: any) => x.userId === u.userId && x.projectId === p)?.minutes
    assert.equal(cell(member, website), 150)
    assert.equal(cell(member, erp), 30)
    assert.equal(cell(owner, erp), 60)
    assert.equal(cell(owner, website), undefined)
    assert.deepEqual(rep.byDay, [
      { day: '2026-11-02', minutes: 180 },
      { day: '2026-11-03', minutes: 60 },
    ])
    assert.ok(rep.byUserDay.some((x: any) => x.userId === member.userId && x.day === '2026-11-03' && x.minutes === 60))
  })

  test('counts timesheet hours sent to Odoo in the range', async () => {
    const p = await join('odoo@example.com')
    await t.db.query(
      `INSERT INTO timesheet_exports(workspace_id, project_id, user_id, day, hours, minutes, status)
       VALUES ($1, $2, $3, '2026-11-02', 2, 120, 'sent'), ($1, $4, $3, '2026-11-03', 0.5, 30, 'failed'),
              ($1, $4, $3, '2026-11-09', 1, 60, 'sent')`,
      [wsId, website, p.userId, erp],
    )
    const rep = (await api(t, owner, 'GET', reportUrl())).body
    assert.equal(rep.users.find((u: any) => u.userId === p.userId).odooHours, 2)
  })

  test('deleted projects drop out', async () => {
    const tmp = (await api(t, owner, 'POST', `/api/workspaces/${wsId}/projects`, { name: 'Temp' })).body.id
    const before = (await api(t, owner, 'GET', reportUrl('2026-11-04', '2026-11-04'))).body.totalMinutes
    await work(member, 4, 12, 13, [{ projectId: tmp }])
    assert.equal((await api(t, owner, 'GET', reportUrl('2026-11-04', '2026-11-04'))).body.totalMinutes, before + 60)
    assert.equal((await api(t, owner, 'DELETE', `/api/projects/${tmp}`)).status, 200)
    const rep = (await api(t, owner, 'GET', reportUrl('2026-11-04', '2026-11-04'))).body
    assert.equal(rep.totalMinutes, before)
    assert.ok(!rep.projects.some((p: any) => p.projectId === tmp))
  })

  test('admins only; non-members get 404; range is validated', async () => {
    assert.equal((await api(t, member, 'GET', reportUrl())).status, 403)
    assert.equal((await api(t, outsider, 'GET', reportUrl())).status, 404)
    assert.equal((await api(t, null, 'GET', reportUrl())).status, 401)
    assert.equal((await api(t, owner, 'GET', reportUrl('2026-11-03', '2026-11-02'))).status, 400)
    assert.equal((await api(t, owner, 'GET', reportUrl('2026-01-01', '2026-11-02'))).status, 400)
    const admin = await join('report-admin@example.com', 'admin')
    assert.equal((await api(t, admin, 'GET', reportUrl())).status, 200)
  })
})

describe('member timeline (admin view)', () => {
  test('Tokyo and Madrid place the same card on the viewer\'s logical day', async () => {
    const japan = await join('tokyo-timeline@example.com')
    const start = Math.floor(H(7, 20) / 1000) // 05:00 Nov 8 in Tokyo; 21:00 Nov 7 in Madrid
    const cardId = await work(japan, 8, 5, 6, [{ projectId: website }], {
      day: '2026-11-08', startTs: start, endTs: start + 3_600,
    })
    const madrid = '?from=2026-11-07&to=2026-11-07&timezone=Europe%2FMadrid'
    const tokyo = '?from=2026-11-08&to=2026-11-08&timezone=Asia%2FTokyo'
    const ownMadrid = await api(t, japan, 'GET', `/api/me/timeline${madrid}`)
    const ownTokyo = await api(t, japan, 'GET', `/api/me/timeline${tokyo}`)
    assert.ok(ownMadrid.body.cards.some((c: any) => c.id === cardId))
    assert.ok(ownTokyo.body.cards.some((c: any) => c.id === cardId))
    assert.ok(!(await api(t, japan, 'GET', '/api/me/timeline?from=2026-11-08&to=2026-11-08&timezone=Europe%2FMadrid')).body.cards.some((c: any) => c.id === cardId))
    const admin = await api(t, owner, 'GET', timelineUrl(japan.userId, '2026-11-07') + '&timezone=Europe%2FMadrid')
    assert.ok(admin.body.cards.some((c: any) => c.id === cardId))
    assert.equal((await api(t, japan, 'GET', '/api/me/timeline?from=2026-11-07&to=2026-11-07&timezone=NotAZone')).status, 400)
  })

  test('shows every device lane and cuts content to what the member shares', async () => {
    const pc = await join('lanes@example.com', 'member', 'Lanes PC')
    const laptop = await devLogin(t, 'lanes@example.com', 'Lanes laptop')
    const metadata = { distractions: [{ title: 'news' }], appSites: { primary: 'x.com' } }
    const card = (d: Device, h: number, title: string, links: Link[] = [], extra: Record<string, unknown> = {}) =>
      work(d, 6, h, h + 1, links, { title, summary: `${title} summary`, metadata: { ...metadata, ...extra } })
    const shared = await card(pc, 8, 'Landing page', [{ projectId: website }])
    const detailed = await card(pc, 9, 'ERP import', [{ projectId: erp }])
    const both = await card(pc, 10, 'Both', [{ projectId: website }, { projectId: erp }])
    const outside = await card(pc, 11, 'Bank statements')
    const guess = await card(pc, 12, 'Maybe ERP', [{ projectId: erp, confirmed: false }])
    const priv = await card(pc, 13, 'Secret', [{ projectId: erp }], { private: true })
    const other = await card(laptop, 14, 'On the laptop', [{ projectId: erp }])

    const r = await api(t, owner, 'GET', timelineUrl(pc.userId, '2026-11-06'))
    assert.equal(r.status, 200)
    assert.equal(r.body.user.email, 'lanes@example.com')
    assert.deepEqual(r.body.devices.map((d: any) => d.name).sort(), ['Lanes PC', 'Lanes laptop'])
    const by = new Map(r.body.cards.map((c: any) => [c.id, c]))
    assert.ok(!by.has(priv), 'private cards are left out')
    assert.equal(r.body.cards.length, 6)

    const s = by.get(shared) as any
    assert.equal(s.shareLevel, 'cards')
    assert.equal(s.title, 'Landing page')
    assert.equal(s.summary, 'Landing page summary')
    assert.equal(s.detailedSummary, '')
    assert.deepEqual(s.metadata, {}, 'apps and sites are never shown')

    const d = by.get(detailed) as any
    assert.equal(d.shareLevel, 'detailed')
    assert.deepEqual(d.metadata, { distractions: [{ title: 'news' }] })
    assert.equal(d.detailedSummary, 'detailed')

    assert.equal((by.get(both) as any).shareLevel, 'cards', 'the lowest level among its projects wins')
    assert.equal((by.get(both) as any).projects.length, 2)

    for (const id of [outside, guess]) {
      const c = by.get(id) as any
      assert.equal(c.shareLevel, null)
      assert.equal(c.title, 'Out of scope')
      assert.equal(c.summary, '')
      assert.equal(c.category, 'Out of scope')
      assert.deepEqual(c.projects, [], 'unconfirmed guesses are not shown')
    }
    assert.equal((by.get(other) as any).deviceId, laptop.deviceId)

    // the member lowers ERP to time only: titles give way to project names
    assert.equal((await api(t, pc, 'PUT', `/api/projects/${erp}/members/${pc.userId}`, { shareLevel: 'time' })).status, 200)
    const r2 = new Map((await api(t, owner, 'GET', timelineUrl(pc.userId, '2026-11-06'))).body.cards.map((c: any) => [c.id, c]))
    const dt = r2.get(detailed) as any
    assert.equal(dt.shareLevel, 'time')
    assert.equal(dt.title, 'ERP')
    assert.equal(dt.summary, '')
    assert.equal(dt.category, '')
    assert.deepEqual(dt.metadata, {})
    assert.equal((r2.get(shared) as any).title, 'Landing page')
  })

  test('work confirmed only for another workspace stays out', async () => {
    const p = await join('two-jobs@example.com')
    const otherWs = (await api(t, p, 'POST', '/api/workspaces', { name: 'Side job' })).body.id
    assert.ok(otherWs)
    const side = (await api(t, p, 'POST', `/api/workspaces/${otherWs}/projects`, { name: 'Side project' })).body.id
    const sideOnly = await work(p, 7, 8, 9, [{ projectId: side }])
    const mixed = await work(p, 7, 9, 10, [{ projectId: side, share: 0.5 }, { projectId: website, share: 0.5 }])
    const noProject = await work(p, 7, 10, 11)
    const ids = (await api(t, owner, 'GET', timelineUrl(p.userId, '2026-11-07'))).body.cards.map((c: any) => c.id)
    assert.ok(!ids.includes(sideOnly))
    assert.ok(ids.includes(mixed))
    assert.ok(ids.includes(noProject))
    const mixedCard = (await api(t, owner, 'GET', timelineUrl(p.userId, '2026-11-07'))).body.cards.find((c: any) => c.id === mixed)
    assert.deepEqual(mixedCard.projects.map((x: any) => x.projectName), ['Website'], 'other workspaces’ projects are not named')
    const u = (await api(t, owner, 'GET', usersUrl('2026-11-07'))).body.users.find((x: any) => x.userId === p.userId)
    assert.equal(u.trackedMinutes, 120)
  })

  test('admins may not open an owner’s timeline; owners see everyone', async () => {
    const admin = await join('timeline-admin@example.com', 'admin')
    const r = await api(t, admin, 'GET', timelineUrl(owner.userId, '2026-11-02'))
    assert.equal(r.status, 403)
    assert.equal((await api(t, admin, 'GET', timelineUrl(member.userId, '2026-11-02'))).status, 200)
    assert.equal((await api(t, admin, 'GET', timelineUrl(admin.userId, '2026-11-02'))).status, 200)
    assert.equal((await api(t, owner, 'GET', timelineUrl(admin.userId, '2026-11-02'))).status, 200)
  })

  test('every view by someone else is logged once per period and shown to the member', async () => {
    const p = await join('watched@example.com')
    await api(t, owner, 'GET', timelineUrl(p.userId, '2026-11-02'))
    await api(t, owner, 'GET', timelineUrl(p.userId, '2026-11-02')) // same period within 10 minutes: one entry
    await api(t, owner, 'GET', timelineUrl(p.userId, '2026-11-02', '2026-11-08'))
    await api(t, p, 'GET', timelineUrl(p.userId, '2026-11-02')) // not an admin
    await api(t, owner, 'GET', timelineUrl(owner.userId, '2026-11-02')) // own timeline: not logged
    const views = (await api(t, p, 'GET', '/api/me/timeline-views')).body.views
    assert.deepEqual(
      views.map((v: any) => [v.viewerEmail, v.from, v.to]).sort(),
      [
        ['owner@example.com', '2026-11-02', '2026-11-02'],
        ['owner@example.com', '2026-11-02', '2026-11-08'],
      ],
    )
    assert.ok(views[0].workspaceName)
    t.clock.now += 11 * 60_000
    await api(t, owner, 'GET', timelineUrl(p.userId, '2026-11-02'))
    assert.equal((await api(t, p, 'GET', '/api/me/timeline-views')).body.views.length, 3)
    assert.deepEqual((await api(t, owner, 'GET', '/api/me/timeline-views')).body.views, [])
  })

  test('admins only, members of this workspace only', async () => {
    assert.equal((await api(t, idle, 'GET', timelineUrl(member.userId, '2026-11-06'))).status, 403)
    assert.equal((await api(t, outsider, 'GET', timelineUrl(member.userId, '2026-11-06'))).status, 404)
    assert.equal((await api(t, owner, 'GET', timelineUrl(outsider.userId, '2026-11-06'))).status, 404)
    const r = await api(t, owner, 'GET', timelineUrl(idle.userId, '2026-11-06'))
    assert.equal(r.status, 200)
    assert.equal(r.body.cards.length, 0)
  })
})

describe('users directory (admin view)', () => {
  test('lists every member with tracked time per device and project time', async () => {
    const pc = await join('tracker@example.com', 'member', 'Tracker PC')
    const laptop = await devLogin(t, 'tracker@example.com', 'Tracker laptop')
    await work(pc, 10, 8, 9, [{ projectId: website }])
    await work(pc, 10, 9, 10, [{ projectId: website }, { projectId: erp }]) // shares above 1 are scaled: counts once
    await work(pc, 10, 10, 11) // out of scope
    await work(pc, 10, 11, 12, [{ projectId: erp }], { metadata: { private: true } }) // private: left out
    await work(laptop, 10, 14, 15, [{ projectId: erp }])

    const r = await api(t, owner, 'GET', usersUrl('2026-11-10'))
    assert.equal(r.status, 200)
    assert.ok(r.body.users.some((u: any) => u.userId === idle.userId), 'members without time are listed')
    const u = r.body.users.find((x: any) => x.userId === pc.userId)
    assert.equal(u.restricted, false)
    assert.equal(u.trackedMinutes, 240)
    assert.equal(u.projectMinutes, 180)
    assert.equal(u.activeDays, 1)
    assert.ok(u.lastSeenAt > 0)
    assert.deepEqual(u.devices.map((d: any) => [d.name, d.minutes]), [
      ['Tracker PC', 180],
      ['Tracker laptop', 60],
    ])
    const i = r.body.users.find((x: any) => x.userId === idle.userId)
    assert.equal(i.trackedMinutes, 0)
    assert.deepEqual(i.devices.map((d: any) => d.name), ['Idle PC'])
  })

  test('revoked devices stay listed only while they have time in the range', async () => {
    const pc = await join('revoked@example.com', 'member', 'Old PC')
    await work(pc, 11, 8, 9)
    assert.equal((await api(t, pc, 'DELETE', `/api/devices/${pc.deviceId}`)).status, 200)
    const u = (await api(t, owner, 'GET', usersUrl('2026-11-11'))).body.users.find((x: any) => x.userId === pc.userId)
    assert.deepEqual(u.devices.map((d: any) => [d.name, d.revoked, d.minutes]), [['Old PC', true, 60]])
    assert.equal(u.lastSeenAt, null, 'revoked devices do not count as seen')
    const later = (await api(t, owner, 'GET', usersUrl('2026-11-20'))).body.users.find((x: any) => x.userId === pc.userId)
    assert.deepEqual(later.devices, [])
  })

  test('an admin sees owners without their own time', async () => {
    const admin = await join('users-admin@example.com', 'admin')
    const rows = (await api(t, admin, 'GET', usersUrl('2026-11-02'))).body.users
    const o = rows.find((x: any) => x.userId === owner.userId)
    assert.equal(o.restricted, true)
    assert.equal(o.trackedMinutes, null)
    assert.equal(o.activeDays, null)
    assert.ok(o.devices.every((d: any) => d.minutes === null))
    assert.equal(o.projectMinutes, 60, 'project time is team data and stays visible')
    assert.equal(rows.find((x: any) => x.userId === member.userId).restricted, false)
    const asOwner = (await api(t, owner, 'GET', usersUrl('2026-11-02'))).body.users
    assert.ok(asOwner.every((x: any) => !x.restricted))
  })

  test('admins only', async () => {
    assert.equal((await api(t, idle, 'GET', usersUrl('2026-11-06'))).status, 403)
    assert.equal((await api(t, outsider, 'GET', usersUrl('2026-11-06'))).status, 404)
  })
})
