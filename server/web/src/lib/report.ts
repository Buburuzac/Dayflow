// Shaping of the workspace report (GET /api/workspaces/:id/report) for the Team page.

import type { WorkspaceReport } from '../api/types.ts'

export interface Contribution {
  userId: string
  userName: string
  minutes: number
  /** share of the project's time, 0..1 */
  pct: number
}

/** projectId → contributors, largest first. */
export function contributionsByProject(rep: WorkspaceReport): Map<string, Contribution[]> {
  const names = new Map(rep.users.map((u) => [u.userId, u.userName]))
  const totals = new Map(rep.projects.map((p) => [p.projectId, p.minutes]))
  const out = new Map<string, Contribution[]>()
  for (const c of rep.byUserProject) {
    const total = totals.get(c.projectId) ?? 0
    const list = out.get(c.projectId) ?? []
    list.push({ userId: c.userId, userName: names.get(c.userId) ?? '?', minutes: c.minutes, pct: total > 0 ? c.minutes / total : 0 })
    out.set(c.projectId, list)
  }
  for (const list of out.values()) list.sort((a, b) => b.minutes - a.minutes || a.userName.localeCompare(b.userName))
  return out
}

/** userId → projectId → minutes */
export function minutesByUserProject(rep: WorkspaceReport): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const c of rep.byUserProject) {
    const m = out.get(c.userId) ?? new Map<string, number>()
    m.set(c.projectId, (m.get(c.projectId) ?? 0) + c.minutes)
    out.set(c.userId, m)
  }
  return out
}

/** 0.3333 → "33%", tiny non-zero shares → "<1%". */
export function fmtPct(p: number): string {
  if (p <= 0) return '0%'
  if (p < 0.01) return '<1%'
  return `${Math.round(p * 100)}%`
}

const cell = (v: string | number) => {
  let s = String(v)
  // a text cell starting with = + - @ (or tab/CR) would run as a formula in Excel: keep it text
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const BOM = String.fromCharCode(0xfeff)
// decimal comma: semicolon CSV is what Excel expects in PL/RU locales, and those use a comma
const num = (n: number) => n.toFixed(2).replace('.', ',')
const hours = (minutes: number) => num(minutes / 60)

/**
 * One row per person × project with hours and the person's share of the project, then per-person totals.
 * Semicolon-separated, decimal comma, with a BOM so Excel (PL/RU locale) opens it with the right columns and encoding.
 */
export function reportCsv(rep: WorkspaceReport): string {
  const projects = new Map(rep.projects.map((p) => [p.projectId, p]))
  const byUser = minutesByUserProject(rep)
  const rows: (string | number)[][] = [['Person', 'Email', 'Project', 'Hours', 'Share of project', 'From', 'To']]
  for (const u of rep.users) {
    const list = [...(byUser.get(u.userId) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])
    for (const [projectId, minutes] of list) {
      const p = projects.get(projectId)
      rows.push([u.userName, u.email, p?.name ?? projectId, hours(minutes), p && p.minutes > 0 ? fmtPct(minutes / p.minutes) : '', rep.from, rep.to])
    }
  }
  rows.push([])
  rows.push(['Person', 'Email', 'Total hours', 'Active days', 'Projects', 'Sent to Odoo, h', ''])
  for (const u of rep.users) rows.push([u.userName, u.email, hours(u.minutes), u.activeDays, u.projectCount, num(u.odooHours), ''])
  return BOM + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n'
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
