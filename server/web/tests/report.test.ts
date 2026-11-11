import { describe, expect, it } from 'vitest'
import type { WorkspaceReport } from '../src/api/types.ts'
import { contributionsByProject, fmtPct, minutesByUserProject, reportCsv } from '../src/lib/report.ts'

const user = (userId: string, userName: string, minutes: number, extra: Partial<WorkspaceReport['users'][number]> = {}) => ({
  userId,
  userName,
  email: `${userId}@example.com`,
  avatarUrl: null,
  role: 'member' as const,
  minutes,
  activeDays: minutes ? 2 : 0,
  projectCount: 0,
  odooHours: 0,
  lastSeenAt: null,
  ...extra,
})

const rep: WorkspaceReport = {
  workspaceId: 'w',
  from: '2026-11-02',
  to: '2026-11-08',
  totalMinutes: 240,
  users: [user('a', 'Anna', 180, { odooHours: 2.5 }), user('b', 'Bob; "B"', 60), user('c', 'Idle', 0)],
  projects: [
    { projectId: 'web', name: 'Website', color: '#4276E9', archived: false, minutes: 150, userCount: 1 },
    { projectId: 'erp', name: 'ERP', color: '#4CB8A4', archived: false, minutes: 90, userCount: 2 },
  ],
  byUserProject: [
    { userId: 'a', projectId: 'web', minutes: 150 },
    { userId: 'a', projectId: 'erp', minutes: 30 },
    { userId: 'b', projectId: 'erp', minutes: 60 },
  ],
  byUserDay: [],
  byDay: [],
}

describe('workspace report helpers', () => {
  it('computes each person’s share of a project, largest first', () => {
    const c = contributionsByProject(rep)
    expect(c.get('erp')!.map((x) => [x.userName, x.minutes, Math.round(x.pct * 100)])).toEqual([
      ['Bob; "B"', 60, 67],
      ['Anna', 30, 33],
    ])
    expect(c.get('web')![0].pct).toBe(1)
    expect(minutesByUserProject(rep).get('a')!.get('erp')).toBe(30)
  })

  it('formats percentages', () => {
    expect(fmtPct(0)).toBe('0%')
    expect(fmtPct(0.004)).toBe('<1%')
    expect(fmtPct(1 / 3)).toBe('33%')
  })

  it('keeps names that look like formulas as text', () => {
    const evil: WorkspaceReport = { ...rep, users: [user('x', '=HYPERLINK("http://e.vil";"x")', 60), user('y', '-2+3', 0), user('z', '@SUM(A1)', 0)] }
    const lines = reportCsv(evil).slice(1).split('\r\n')
    expect(lines).toContain(`"'=HYPERLINK(""http://e.vil"";""x"")";x@example.com;1,00;2;0;0,00;`)
    expect(lines).toContain("'-2+3;y@example.com;0,00;0;0;0,00;")
    expect(lines).toContain("'@SUM(A1);z@example.com;0,00;0;0;0,00;")
  })

  it('exports a semicolon CSV with decimal commas, quoting and a BOM', () => {
    const csv = reportCsv(rep)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe('Person;Email;Project;Hours;Share of project;From;To')
    expect(lines[1]).toBe('Anna;a@example.com;Website;2,50;100%;2026-11-02;2026-11-08')
    expect(lines[2]).toBe('Anna;a@example.com;ERP;0,50;33%;2026-11-02;2026-11-08')
    expect(lines[3]).toBe('"Bob; ""B""";b@example.com;ERP;1,00;67%;2026-11-02;2026-11-08')
    expect(lines).toContain('Anna;a@example.com;3,00;2;0;2,50;')
    expect(lines).toContain('Idle;c@example.com;0,00;0;0;0,00;')
  })
})
