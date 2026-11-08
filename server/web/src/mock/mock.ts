// DEV ONLY — an in-browser fetch shim that answers /api/* with generated data, for `?mock=1`.
// Imported dynamically behind `import.meta.env.DEV` in main.tsx, so it never ships in `vite build`.
// `?mock=nosession` simulates a missing session cookie.

import type {
  DeviceInfo,
  Invite,
  Member,
  MeResponse,
  OdooConnection,
  Project,
  ProjectEntry,
  ProjectMemberShare,
  ProjectReport,
  ShareLevel,
  ProjectStandupResponse,
  TimelineCard,
  TimesheetProposal,
  TimesheetSubmitRequest,
  TimesheetSubmitResult,
} from '../api/types.ts'
import { dayStartMs, daysInRange, logicalDay, parseDay, shiftDay } from '../lib/dates.ts'
import { roundQuarter } from '../lib/format.ts'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]

const today = logicalDay()
const now = Date.now()

const WS = 'ws-veles'
const ME = 'u-max'

const devices: DeviceInfo[] = [
  { id: 'd-office', name: 'Office PC', platform: 'win32', lastSeenAt: now - 4 * 60_000, revoked: false, current: true },
  { id: 'd-laptop', name: 'ThinkPad X1', platform: 'win32', lastSeenAt: now - 3 * 3600_000, revoked: false },
  { id: 'd-mac', name: 'MacBook Air', platform: 'darwin', lastSeenAt: now - 40 * 86400_000, revoked: true },
]

const me: MeResponse = {
  user: { id: ME, email: 'max@velesagro.pl', name: 'Max Kowalski', avatarUrl: null },
  devices,
  workspaces: [
    { id: WS, name: 'Veles Agro', role: 'owner' },
    { id: 'ws-side', name: 'Freelance', role: 'member' },
  ],
}

let members: Member[] = [
  { userId: ME, email: 'max@velesagro.pl', name: 'Max Kowalski', avatarUrl: null, role: 'owner' },
  { userId: 'u-anna', email: 'anna.nowak@velesagro.pl', name: 'Anna Nowak', avatarUrl: null, role: 'admin' },
  { userId: 'u-piotr', email: 'piotr.wisniewski@velesagro.pl', name: 'Piotr Wiśniewski', avatarUrl: null, role: 'member' },
  { userId: 'u-olga', email: 'olga.lewandowska@velesagro.pl', name: 'Olga Lewandowska', avatarUrl: null, role: 'viewer' },
]

let invites: Invite[] = [{ id: 'inv-1', email: 'tomasz@velesagro.pl', role: 'member', expiresAt: now + 5 * 86400_000 }]

const projects: Project[] = [
  {
    id: 'p-odoo',
    workspaceId: WS,
    name: 'Odoo 15 migration',
    color: '#4276E9',
    description: 'Upgrade of the production ERP to Odoo 15: custom modules, data migration, testing.',
    rules: { apps: ['Code', 'pgAdmin 4'], domains: ['odoo-test.velesagro.pl'], titleKeywords: ['odoo', 'migration'], repos: ['velesagro/odoo-addons'] },
    defaultShare: 'cards',
    odoo: { projectId: 42, projectName: 'Veles – Odoo 15 upgrade', taskId: 311, taskName: 'Module porting' },
    archived: false,
  },
  {
    id: 'p-sync',
    workspaceId: WS,
    name: 'Dayflow sync',
    color: '#F3854B',
    description: 'Sync server, team dashboard and Odoo timesheet export for Dayflow.',
    rules: { apps: ['Code'], titleKeywords: ['dayflow'], repos: ['velesagro/dayflow'] },
    defaultShare: 'detailed',
    odoo: { projectId: 57, projectName: 'Internal tools' },
    archived: false,
  },
  {
    id: 'p-wms',
    workspaceId: WS,
    name: 'Warehouse WMS',
    color: '#4CB8A4',
    description: 'Barcode scanning and stock moves for the Torzym warehouse.',
    rules: { domains: ['wms.velesagro.pl'], titleKeywords: ['wms', 'barcode'] },
    defaultShare: 'cards',
    odoo: { projectId: 61, projectName: 'Torzym WMS', taskId: 402, taskName: 'Scanner app' },
    archived: false,
  },
  {
    id: 'p-admin',
    workspaceId: WS,
    name: 'Internal admin',
    color: '#B984FF',
    description: 'E-mail, meetings, planning.',
    rules: { apps: ['OUTLOOK', 'Teams'] },
    defaultShare: 'time',
    archived: false,
  },
  {
    id: 'p-intrastat',
    workspaceId: WS,
    name: 'Intrastat 2025',
    color: '#8A8A8A',
    description: 'Yearly Intrastat declarations.',
    rules: {},
    defaultShare: 'cards',
    archived: true,
  },
]

const projectShares: Record<string, ProjectMemberShare[]> = {
  'p-odoo': [{ userId: 'u-piotr', shareLevel: 'time' }],
  'p-wms': [{ userId: 'u-anna', shareLevel: 'detailed' }],
}

const odoo: OdooConnection = {
  url: 'https://odoo-test.velesagro.pl',
  db: 'veles_test',
  login: 'dayflow-bot',
  hasApiKey: true,
  employeeMap: {
    [ME]: { employeeId: 12, employeeName: 'Max Kowalski' },
    'u-anna': { employeeId: 17, employeeName: 'Anna Nowak' },
    'u-piotr': { employeeId: 23, employeeName: 'Piotr Wiśniewski' },
  },
}

const TITLES: Record<string, { t: string; s: string }[]> = {
  'p-odoo': [
    { t: 'Porting stock_landed_costs override to Odoo 15', s: 'Rewrote the compute methods for the new valuation layers and fixed the failing unit tests.' },
    { t: 'Migration script for account.move lines', s: 'Mapped legacy journal items to the new account.move structure and tested on a copy of production.' },
    { t: 'Reviewing upgrade report from Odoo', s: 'Went through the upgrade report and listed modules that still need manual work.' },
    { t: 'Fixing QWeb invoice template', s: 'Adapted the Polish invoice template to the new report layout.' },
  ],
  'p-sync': [
    { t: 'Building the Dayflow team dashboard', s: 'Implemented the project feed and report charts in React.' },
    { t: 'Designing the HLC merge rules', s: 'Wrote tests for per-field merges of card edits across two devices.' },
    { t: 'Odoo timesheet export', s: 'Built the XML-RPC client and the idempotent line update.' },
  ],
  'p-wms': [
    { t: 'Barcode scanner flow for stock picking', s: 'Tested the scan → move flow with the Zebra handheld.' },
    { t: 'WMS location import', s: 'Imported 1,240 bin locations from the old spreadsheet.' },
  ],
  'p-admin': [
    { t: 'E-mail and planning', s: 'Answered supplier e-mails and planned the week.' },
    { t: 'Weekly team call', s: 'Status call with the warehouse and accounting teams.' },
  ],
}
const OTHER = [
  { t: 'Reading tech news', s: 'Browsed Hacker News and a few blog posts.', c: 'Distraction' },
  { t: 'Bank transfers and invoices', s: 'Paid personal bills in online banking.', c: 'Personal' },
  { t: 'Away from the computer', s: 'No activity.', c: 'Idle' },
  { t: 'YouTube break', s: 'Watched a couple of videos.', c: 'Distraction' },
]

// ---- personal timeline ----

function cardsForDay(day: string): TimelineCard[] {
  const r = rng(hash(day))
  const dow = parseDay(day).getDay()
  const weekend = dow === 0 || dow === 6
  const out: TimelineCard[] = []
  const base = dayStartMs(day) / 1000 // desktop cards use unix seconds
  const add = (deviceId: string, startMin: number, len: number, projectId: string | null, confirmed = true) => {
    const p = projectId ? pick(r, TITLES[projectId]) : null
    const o = pick(r, OTHER)
    const id = `c-${day}-${deviceId}-${startMin}`
    out.push({
      id,
      deviceId,
      day,
      startTs: base + startMin * 60,
      endTs: base + (startMin + len) * 60,
      title: p?.t ?? o.t,
      summary: p?.s ?? o.s,
      detailedSummary: p ? `${p.s}\n\n• Opened the relevant files\n• Ran the test suite\n• Wrote notes for tomorrow` : '',
      category: p ? (projectId === 'p-admin' ? 'Work' : 'Work') : o.c,
      subcategory: p ? 'Development' : '',
      metadata: {
        appSites: { primary: projectId === 'p-wms' ? 'wms.velesagro.pl' : projectId === 'p-odoo' ? 'odoo-test.velesagro.pl' : 'github.com' },
        distractions: p && r() < 0.25 ? [{ startTime: '10:42', endTime: '10:47', title: 'Twitter', summary: 'Scrolled the feed.' }] : [],
        private: !p && o.c === 'Personal' ? true : undefined,
      },
      isError: false,
      projects: projectId
        ? [
            {
              projectId,
              projectName: projects.find((p) => p.id === projectId)!.name,
              color: projects.find((p) => p.id === projectId)!.color,
              share: 1,
              source: confirmed ? 'rule' : 'llm',
              confidence: confirmed ? 1 : 0.62,
              confirmed,
            },
          ]
        : [],
    })
  }
  if (!weekend) {
    let t = 4 * 60 + Math.floor(r() * 30) // 8:00..8:30
    const end = 12 * 60 + 30
    while (t < end) {
      const len = 20 + Math.floor(r() * 60)
      const roll = r()
      const pid = roll < 0.35 ? 'p-odoo' : roll < 0.6 ? 'p-sync' : roll < 0.72 ? 'p-wms' : roll < 0.84 ? 'p-admin' : null
      add('d-office', t, len, pid, r() > 0.15)
      t += len + (r() < 0.3 ? 10 : 0)
    }
    add('d-laptop', 7 * 60, 50, 'p-admin') // 11:00 call on the laptop, overlaps the office PC
    if (r() < 0.5) add('d-laptop', 7 * 60 + 30, 25, 'p-wms', false)
  }
  if (r() < 0.8) {
    let t = 15 * 60 + Math.floor(r() * 40) // ~19:00
    for (let i = 0; i < 3; i++) {
      const len = 25 + Math.floor(r() * 40)
      add('d-laptop', t, len, i === 0 ? 'p-sync' : null)
      t += len
    }
  }
  return out.filter((c) => c.day < today || c.endTs * 1000 < now)
}

// ---- team projection ----

const memberLevel = (pid: string, uid: string): ShareLevel => {
  const p = projects.find((x) => x.id === pid)!
  return projectShares[pid]?.find((s) => s.userId === uid)?.shareLevel ?? p.defaultShare
}

function entries(pid: string, from: string, to: string): ProjectEntry[] {
  const out: ProjectEntry[] = []
  const people = members.filter((m) => m.role !== 'viewer' || pid === 'p-admin')
  for (const day of daysInRange(from, to)) {
    if (day > today) continue
    const dow = parseDay(day).getDay()
    if (dow === 0 || dow === 6) continue
    for (const m of people) {
      const r = rng(hash(`${pid}${m.userId}${day}`))
      if (r() < 0.35) continue
      const n = 1 + Math.floor(r() * 3)
      let t = 4 * 60 + Math.floor(r() * 120)
      for (let i = 0; i < n; i++) {
        const len = 20 + Math.floor(r() * 70)
        const level = memberLevel(pid, m.userId)
        const tt = pick(r, TITLES[pid] ?? TITLES['p-admin'])
        const start = dayStartMs(day) / 1000 + t * 60
        out.push({
          cardId: `e-${pid}-${m.userId}-${day}-${i}`,
          projectId: pid,
          userId: m.userId,
          userName: m.name,
          day,
          startTs: start,
          endTs: start + len * 60,
          minutes: len,
          shareLevel: level,
          title: level === 'time' ? null : tt.t,
          summary: level === 'time' ? null : tt.s,
          detailed: level === 'detailed' ? `${tt.s}\n\nDistractions: none worth noting.` : null,
        })
        t += len + 30 + Math.floor(r() * 90)
      }
    }
  }
  return out
}

function report(pid: string, from: string, to: string): ProjectReport {
  const es = entries(pid, from, to)
  const byMember = new Map<string, { userId: string; userName: string; minutes: number }>()
  const byDay = new Map<string, number>()
  const byMemberDay = new Map<string, { userId: string; day: string; minutes: number }>()
  for (const e of es) {
    const day = logicalDay(new Date(e.startTs * 1000))
    const m = byMember.get(e.userId) ?? { userId: e.userId, userName: e.userName, minutes: 0 }
    m.minutes += e.minutes
    byMember.set(e.userId, m)
    byDay.set(day, (byDay.get(day) ?? 0) + e.minutes)
    const k = `${e.userId}|${day}`
    const md = byMemberDay.get(k) ?? { userId: e.userId, day, minutes: 0 }
    md.minutes += e.minutes
    byMemberDay.set(k, md)
  }
  return {
    projectId: pid,
    from,
    to,
    totalMinutes: es.reduce((s, e) => s + e.minutes, 0),
    byMember: [...byMember.values()],
    byDay: [...byDay].map(([day, minutes]) => ({ day, minutes })),
    byMemberDay: [...byMemberDay.values()],
  }
}

function standup(pid: string, day: string): ProjectStandupResponse {
  const es = entries(pid, day, day)
  const ids = [...new Set(es.map((e) => e.userId))]
  return {
    projectId: pid,
    day,
    members: ids.map((uid) => {
      const mine = es.filter((e) => e.userId === uid)
      const level = mine[0].shareLevel
      const minutes = mine.reduce((s, e) => s + e.minutes, 0)
      return {
        userId: uid,
        userName: mine[0].userName,
        shareLevel: level,
        sourceDay: day,
        minutes,
        sourceMinutes: minutes,
        hasStandup: uid !== 'u-anna',
        done: level === 'time' ? [] : mine.map((e) => e.title ?? ''),
        next: level === 'time' ? [] : [pick(rng(hash(uid + day)), TITLES[pid] ?? TITLES['p-admin']).t],
      }
    }),
  }
}

const sentLines = new Map<string, number>()
function proposals(from: string, to: string): TimesheetProposal[] {
  const out: TimesheetProposal[] = []
  for (const p of projects.filter((x) => !x.archived)) {
    const mine = entries(p.id, from, to).filter((e) => e.userId === ME)
    const byDay = new Map<string, ProjectEntry[]>()
    for (const e of mine) {
      const d = logicalDay(new Date(e.startTs * 1000))
      byDay.set(d, [...(byDay.get(d) ?? []), e])
    }
    for (const [day, es] of byDay) {
      const key = `${day}|${p.id}`
      const old = day < shiftDay(today, -3) && p.odoo?.projectId ? 9000 + (hash(key) % 900) : null
      out.push({
        userId: ME,
        day,
        projectId: p.id,
        odooProjectId: p.odoo?.projectId ?? null,
        odooTaskId: p.odoo?.taskId ?? null,
        hours: roundQuarter(es.reduce((s, e) => s + e.minutes, 0) / 60),
        description: [...new Set(es.map((e) => e.title ?? 'Work'))].join('; '),
        cardIds: es.map((e) => e.cardId),
        existingOdooLineId: sentLines.get(key) ?? old,
        projectName: p.name,
      })
    }
  }
  return out
}

function submit(body: TimesheetSubmitRequest): TimesheetSubmitResult {
  const res: TimesheetSubmitResult = { sent: [], failed: [] }
  for (const l of body.lines) {
    const key = `${l.day}|${l.projectId}`
    if (l.projectId === 'p-wms') {
      res.failed.push({ day: l.day, projectId: l.projectId, error: 'Task 402 is closed in Odoo' })
      continue
    }
    const existing = sentLines.get(key)
    const id = existing ?? 10_000 + (hash(key) % 5000)
    sentLines.set(key, id)
    res.sent.push({ day: l.day, projectId: l.projectId, odooLineId: id, updated: existing != null })
  }
  return res
}

// ---- router ----

type Handler = (m: RegExpExecArray, q: URLSearchParams, body: unknown) => unknown

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/me$/, () => me],
  ['POST', /^\/api\/auth\/logout$/, () => null],
  [
    'DELETE',
    /^\/api\/devices\/([^/]+)$/,
    (m) => {
      const d = devices.find((x) => x.id === m[1])
      if (d) d.revoked = true
      return null
    },
  ],
  [
    'GET',
    /^\/api\/me\/timeline$/,
    (_m, q) => ({
      from: q.get('from'),
      to: q.get('to'),
      cards: daysInRange(q.get('from')!, q.get('to')!).flatMap(cardsForDay),
      devices,
      categories: null, // exercise the default-colour fallback
    }),
  ],
  ['GET', /^\/api\/workspaces\/([^/]+)\/projects$/, (m) => ({ projects: projects.filter((p) => p.workspaceId === m[1]) })],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/projects$/,
    (m, _q, b) => {
      const p = { ...(b as Project), id: `p-${projects.length + 1}`, workspaceId: m[1] }
      projects.push(p)
      return p
    },
  ],
  [
    'PATCH',
    /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)$/,
    (m, _q, b) => {
      const p = projects.find((x) => x.id === m[2])!
      Object.assign(p, b)
      return p
    },
  ],
  ['GET', /^\/api\/workspaces\/([^/]+)\/members$/, () => ({ members })],
  [
    'PATCH',
    /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/,
    (m, _q, b) => {
      members = members.map((x) => (x.userId === m[2] ? { ...x, role: (b as Member).role } : x))
      return null
    },
  ],
  [
    'DELETE',
    /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/,
    (m) => {
      members = members.filter((x) => x.userId !== m[2])
      return null
    },
  ],
  ['GET', /^\/api\/workspaces\/([^/]+)\/invites$/, () => ({ invites: [...invites, { id: 'inv-0', email: 'old@velesagro.pl', role: 'member', expiresAt: now - 86400_000, status: 'expired' }] })],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/invites$/,
    (_m, _q, b) => {
      const { email, role } = b as Invite
      const inv: Invite = { id: `inv-${invites.length + 2}`, email, role, expiresAt: now + 7 * 86400_000 }
      invites = [...invites, inv]
      return { ...inv, token: 'dfi_8f3a1c0d9e7b44c2a6f1b0d3', url: `${location.origin}/invite/dfi_8f3a1c0d9e7b44c2a6f1b0d3` }
    },
  ],
  [
    'DELETE',
    /^\/api\/workspaces\/([^/]+)\/invites\/([^/]+)$/,
    (m) => {
      invites = invites.filter((i) => i.id !== m[2])
      return null
    },
  ],
  ['GET', /^\/api\/invites\/([^/]+)$/, () => ({ workspaceId: 'ws-side', workspaceName: 'Freelance', email: me.user.email, role: 'member', expiresAt: now + 86400_000, accepted: false })],
  ['POST', /^\/api\/invites\/([^/]+)\/accept$/, () => ({ workspaceId: 'ws-side', workspaceName: 'Freelance', role: 'member' })],
  ['GET', /^\/api\/projects\/([^/]+)\/feed$/, (m, q) => ({ entries: entries(m[1], q.get('from')!, q.get('to')!) })],
  ['GET', /^\/api\/projects\/([^/]+)\/report$/, (m, q) => report(m[1], q.get('from')!, q.get('to')!)],
  ['GET', /^\/api\/projects\/([^/]+)\/standup$/, (m, q) => standup(m[1], q.get('day')!)],
  ['GET', /^\/api\/projects\/([^/]+)\/members$/, (m) => ({ members: projectShares[m[1]] ?? [] })],
  [
    'PUT',
    /^\/api\/projects\/([^/]+)\/members\/([^/]+)$/,
    (m, _q, b) => {
      const list = (projectShares[m[1]] ??= []).filter((s) => s.userId !== m[2])
      list.push({ userId: m[2], shareLevel: (b as ProjectMemberShare).shareLevel })
      projectShares[m[1]] = list
      return null
    },
  ],
  [
    'GET',
    /^\/api\/timesheets\/proposals$/,
    (_m, q) => ({ workspaceId: WS, from: q.get('from'), to: q.get('to'), odooConfigured: true, employeeMapped: true, proposals: proposals(q.get('from')!, q.get('to')!) }),
  ],
  ['POST', /^\/api\/timesheets\/submit$/, (_m, _q, b) => submit(b as TimesheetSubmitRequest)],
  ['GET', /^\/api\/workspaces\/([^/]+)\/odoo$/, () => ({ configured: true, fromEnv: false, ...odoo })],
  [
    'PUT',
    /^\/api\/workspaces\/([^/]+)\/odoo$/,
    (_m, _q, b) => {
      const { url, db, login } = b as OdooConnection
      Object.assign(odoo, { url, db, login, hasApiKey: true })
      return { configured: true, url, db, login, hasApiKey: true }
    },
  ],
  [
    'PUT',
    /^\/api\/workspaces\/([^/]+)\/odoo\/employee-map$/,
    (_m, _q, b) => {
      odoo.employeeMap = (b as { map: OdooConnection['employeeMap'] }).map
      return { employeeMap: odoo.employeeMap }
    },
  ],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/odoo\/auto-map$/,
    () => {
      odoo.employeeMap['u-olga'] = { employeeId: 31, employeeName: 'Olga Lewandowska' }
      return { matched: 1, employeeMap: odoo.employeeMap, unmatched: [] }
    },
  ],
  ['POST', /^\/api\/workspaces\/([^/]+)\/odoo\/test$/, () => ({ ok: true, serverVersion: '15.0-20241105', uid: 7 })],
]

export function installMock(variant: string): void {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
    if (!url.pathname.startsWith('/api/')) return real(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    await new Promise((r) => setTimeout(r, 80))
    const json = (status: number, data: unknown) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    if (variant === 'nosession') return json(401, { error: 'No session' })
    for (const [m, re, h] of routes) {
      const match = m === method ? re.exec(url.pathname) : null
      if (match) {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        const data = h(match, url.searchParams, body)
        return data == null ? new Response(null, { status: 204 }) : json(200, data)
      }
    }
    return json(404, { error: `Mock: no route for ${method} ${url.pathname}` })
  }
  console.info('[dayflow] mock API installed')
}
