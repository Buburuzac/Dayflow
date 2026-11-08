// Project assignment for new cards (sync-server-design.md "Projects and assignment"):
//   1. manual (carried over from the card a rewritten card replaces) — kept as is;
//   2. rules: project.rules matched against the card's window labels, appSites, title/summary;
//   3. LLM: the model's "projects" output, confirmed when confidence ≥ 0.8.

import type { InsertedCard, Store } from '../db.ts'
import type { AppSites } from '../../shared/types.ts'
import type { ProjectRules } from '../../shared/sync-types.ts'
import type { LlmProjectGuess } from '../llm/types.ts'
import type { ProjectRow } from './repo.ts'
import { SyncRepo } from './repo.ts'

export const LLM_CONFIRM_THRESHOLD = 0.8

export interface RuleInput {
  /** Foreground window labels of the card's frames: "process — window title" */
  labels: string[]
  appSites: AppSites | null | undefined
  title: string
  summary: string
}

export interface RuleMatch {
  projectId: string
  share: number
}

const norm = (s: string) => s.trim().toLowerCase()

function splitLabel(label: string): { process: string; title: string } {
  const i = label.indexOf(' — ')
  return i < 0 ? { process: label, title: '' } : { process: label.slice(0, i), title: label.slice(i + 3) }
}

function processMatches(process: string, app: string): boolean {
  const p = norm(process).replace(/\.exe$/, '')
  const a = norm(app).replace(/\.exe$/, '')
  return !!a && p === a
}

function domainMatches(text: string, domain: string): boolean {
  const d = norm(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
  if (!d) return false
  const t = norm(text)
  if (t === d || t.endsWith('.' + d)) return true
  // Inside a window title or free text: the domain as a whole token.
  const re = new RegExp(`(^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`)
  return re.test(t)
}

function includesWord(text: string, keyword: string): boolean {
  const k = norm(keyword)
  return !!k && norm(text).includes(k)
}

function hasRules(r: ProjectRules | undefined): boolean {
  return !!r && [r.apps, r.domains, r.titleKeywords, r.repos].some((l) => Array.isArray(l) && l.some((x) => x.trim()))
}

/** Does one window label satisfy a project's rules? */
function labelMatches(label: string, rules: ProjectRules): boolean {
  const { process, title } = splitLabel(label)
  if (rules.apps?.some((a) => processMatches(process, a))) return true
  if (rules.domains?.some((d) => domainMatches(title, d))) return true
  if (rules.titleKeywords?.some((k) => includesWord(title, k))) return true
  if (rules.repos?.some((r) => includesWord(title, repoName(r)))) return true
  return false
}

/** "github.com/acme/dayflow" / "acme/dayflow" / "dayflow" → "dayflow" */
function repoName(repo: string): string {
  const parts = repo.trim().replace(/\.git$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function textMatches(input: RuleInput, rules: ProjectRules): boolean {
  const sites = [input.appSites?.primary, input.appSites?.secondary].filter((s): s is string => !!s)
  if (rules.domains?.some((d) => sites.some((s) => domainMatches(s, d)))) return true
  const text = `${input.title}\n${input.summary}`
  if (rules.titleKeywords?.some((k) => includesWord(text, k))) return true
  if (rules.repos?.some((r) => includesWord(text, repoName(r)))) return true
  return false
}

/**
 * Projects whose rules match the card. The share of a project is the fraction of frames whose
 * window matched (or 1 when only title/summary/appSites matched); shares are scaled to sum ≤ 1.
 */
export function matchRules(projects: Pick<ProjectRow, 'id' | 'rules' | 'archived'>[], input: RuleInput): RuleMatch[] {
  const out: RuleMatch[] = []
  for (const p of projects) {
    if (p.archived || !hasRules(p.rules)) continue
    const frames = input.labels.filter((l) => labelMatches(l, p.rules)).length
    let share = input.labels.length ? frames / input.labels.length : 0
    if (textMatches(input, p.rules)) share = Math.max(share, 1)
    if (share > 0) out.push({ projectId: p.id, share })
  }
  const total = out.reduce((s, m) => s + m.share, 0)
  if (total > 1) for (const m of out) m.share = m.share / total
  for (const m of out) m.share = Math.round(m.share * 1000) / 1000
  return out.sort((a, b) => b.share - a.share)
}

/** LLM guesses → assignments to known projects (matched by name, case-insensitively). */
export function llmAssignments(
  projects: Pick<ProjectRow, 'id' | 'name' | 'archived'>[],
  guesses: LlmProjectGuess[] | undefined,
): { projectId: string; share: number; confidence: number; confirmed: boolean }[] {
  if (!guesses?.length) return []
  const byName = new Map(projects.filter((p) => !p.archived).map((p) => [norm(p.name), p.id]))
  const seen = new Set<string>()
  const out: { projectId: string; share: number; confidence: number; confirmed: boolean }[] = []
  for (const g of guesses) {
    const id = byName.get(norm(g.name))
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ projectId: id, share: g.share, confidence: g.confidence, confirmed: g.confidence >= LLM_CONFIRM_THRESHOLD })
  }
  return out
}

/** Assigns projects to the cards the analysis just wrote. */
export function assignProjects(store: Store, cards: InsertedCard[]): void {
  const repo = new SyncRepo(store)
  const projects = repo.projects()
  if (projects.length === 0) return
  for (const c of cards) {
    if (c.inheritedManual) continue
    const labels = store
      .liveScreenshotsInRange(c.startTs, c.endTs)
      .map((s) => s.windowLabel)
      .filter((l): l is string => !!l)
    const rules = matchRules(projects, {
      labels,
      appSites: c.card.appSites,
      title: c.card.title,
      summary: c.card.summary,
    })
    if (rules.length) {
      repo.setAssignments(
        c.uuid,
        rules.map((m) => ({ projectId: m.projectId, share: m.share, source: 'rule', confidence: 1, confirmed: true })),
      )
      continue
    }
    const llm = llmAssignments(projects, c.card.projects)
    if (llm.length) repo.setAssignments(c.uuid, llm.map((a) => ({ ...a, source: 'llm' })))
  }
}

/** Project list for the card-generation prompt. */
export function projectsForPrompt(store: Store): { name: string; description: string }[] {
  return new SyncRepo(store).projects().map((p) => ({ name: p.name, description: p.description }))
}
