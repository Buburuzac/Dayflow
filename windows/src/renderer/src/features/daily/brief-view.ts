// Renderer-side helpers for the Daily Brief (mirrors brief-logic.ts where the UI needs it).

import type {
  BriefSectionKey,
  DailyBriefContent,
  DailyBriefUserState,
  DocketStatus,
  HandoffEntry,
} from '../../../../shared/daily-types.ts'

export const SECTION_KEYS: BriefSectionKey[] = [
  'docket',
  'keep_tracking',
  'completed_yesterday',
  'team_decisions',
  'related_reading',
  'industry_news',
  'site_seeing',
]

export const SECTION_TITLES: Record<BriefSectionKey, string> = {
  docket: 'Your docket today',
  keep_tracking: 'Keep tracking',
  completed_yesterday: 'What you completed yesterday',
  team_decisions: 'Key team decisions',
  related_reading: 'Related to your interests',
  industry_news: 'Latest in your industry',
  site_seeing: 'Recent site-seeing',
}

const nonEmpty = (c: DailyBriefContent, k: BriefSectionKey) => {
  const v = c[k]
  return Array.isArray(v) && v.length > 0
}

export function orderedKinds(c: DailyBriefContent): BriefSectionKey[] {
  const out: BriefSectionKey[] = []
  for (const k of c.order ?? []) if (SECTION_KEYS.includes(k) && !out.includes(k) && nonEmpty(c, k)) out.push(k)
  for (const k of SECTION_KEYS) if (!out.includes(k) && nonEmpty(c, k)) out.push(k)
  return out
}

export const itemKey = (section: string, title: string) => `${section}|${title}`

export function lastHandoff(st: DailyBriefUserState, title: string): HandoffEntry | undefined {
  for (let i = st.handoffs.length - 1; i >= 0; i--) if (st.handoffs[i].title === title) return st.handoffs[i]
  return undefined
}

export function docketStatus(e: HandoffEntry | undefined): DocketStatus {
  if (!e) return 'new'
  if (e.dismissed) return 'dismissed'
  if (e.reviewed) return 'reviewed'
  if (e.failed) return 'failed'
  if (e.method === 'run') return e.finishedAt ? 'ready' : 'inProgress'
  return 'ready'
}

export const STATUS_LABELS: Record<DocketStatus, string> = {
  new: 'New',
  dismissed: 'Dismissed',
  inProgress: 'In progress',
  ready: 'Ready',
  reviewed: 'Reviewed',
  failed: 'Failed',
}

export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

export function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
