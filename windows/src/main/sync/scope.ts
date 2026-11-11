// What leaves this computer. Every card this device generated gets a sync scope, decided here on
// the device before anything is uploaded:
//
//   excluded      — a personal card (category listed in syncExcludedCategories, or marked private):
//                   its content never leaves the PC; a copy already on the server is wiped and deleted.
//   full          — confirmed work for a live project (not deleted, not archived): uploaded as is.
//   out_of_scope  — everything else: only its time span is uploaded, as an "Out of scope" block,
//                   so other devices see the time was taken but not what it was.
//
// When a card's scope changes it is re-sent with a fresh clock (scope_hlc), so the server and the
// user's other devices replace the earlier copy instead of ignoring it as stale.
// Pure module: no Electron, no database.

import type { CardData } from '../../shared/sync-types.ts'

export type CardScope = 'full' | 'out_of_scope' | 'excluded'

export interface SyncPolicy {
  /** Category names (case-insensitive) whose cards never leave this PC. */
  excludedCategories: string[]
  /** Cards without a confirmed live project are uploaded as time-only "Out of scope" blocks. */
  outOfScope: boolean
  /** Upload raw observations (the model's screen descriptions). */
  observations: boolean
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  excludedCategories: ['Personal'],
  outOfScope: true,
  observations: false,
}

export const OUT_OF_SCOPE_LABEL = 'Out of scope'

export function cardScope(
  card: { category: string; private: boolean },
  hasConfirmedLiveProject: boolean,
  policy: SyncPolicy,
): CardScope {
  const cat = card.category.trim().toLowerCase()
  if (card.private) return 'excluded'
  if (policy.excludedCategories.some((c) => c.trim().toLowerCase() === cat)) return 'excluded'
  if (hasConfirmedLiveProject || !policy.outOfScope) return 'full'
  return 'out_of_scope'
}

/** The upload form of a card for its scope. Times stay; everything that describes the work goes. */
export function redactCard(data: CardData, scope: CardScope): CardData {
  if (scope === 'full') return data
  // Idle time is a distinct state, even when no project is attached. Keep only its label.
  const idle = data.category.trim().toLowerCase() === 'idle'
  const label = idle ? 'Idle' : OUT_OF_SCOPE_LABEL
  return {
    ...data,
    title: label,
    summary: '',
    detailedSummary: '',
    category: label,
    subcategory: '',
    // The private flag stays accurate on the server (it decides the team projection).
    metadata: { distractions: [], appSites: null, private: data.metadata.private === true },
  }
}

export function samePolicy(a: SyncPolicy, b: SyncPolicy): boolean {
  return (
    a.outOfScope === b.outOfScope &&
    a.observations === b.observations &&
    a.excludedCategories.map((c) => c.toLowerCase()).sort().join('\n') ===
      b.excludedCategories.map((c) => c.toLowerCase()).sort().join('\n')
  )
}
