import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DailyBrief, DailyStandupDraft, DayGoalPlan } from '../src/shared/daily-types.ts'
import type { Category, TimelineCard } from '../src/shared/types.ts'
import {
  compactClock,
  decodeDraft,
  draftFromParsed,
  firstBalancedObject,
  makeCardsText,
  parseRecapResponse,
  PLACEHOLDER_MESSAGES,
  placeholderDraft,
  RecapParseError,
  resolveSourceDay,
  SOURCE_MIN_MINUTES,
  standupClipboardText,
} from '../src/main/daily/standup.ts'
import {
  carriedForwardPlan,
  computeProgress,
  defaultPlan,
  formatCompactHours,
  mergeBlocks,
  normalizePlan,
  removeOverlaps,
} from '../src/main/daily/goals.ts'
import {
  buildPrompt,
  cardLines,
  chooseTemplate,
  claudeAbsRulePath,
  classifyClaudeFailure,
  cleanDocket,
  cleanExtras,
  coerceToSchema,
  docketStatus,
  DOCKET_SCHEMA,
  EXTRAS_SCHEMA,
  feedbackSummary,
  balancedJsonValues,
  hookDecision,
  hookLogCounts,
  hookScriptSource,
  isSummaryRange,
  keepFailedParts,
  mcpWriteDenyRules,
  objectFromText,
  terminalScript,
  unguardedToolCalls,
  mergeParts,
  orderedKinds,
  parseClaudeEvents,
  recentBriefItems,
  resultEnvelope,
  structuredFromEnvelope,
  validateSchema,
} from '../src/main/daily/brief-logic.ts'
import { makeRecapPrompt, recapInstructions, LOCAL_RECAP_PROMPT } from '../src/main/daily/prompts.ts'
import { BriefFileStore, inside } from '../src/main/daily/brief-store.ts'
import { CancelledError, generateTextAbortable } from '../src/main/daily/abortable.ts'
import { RecapService } from '../src/main/daily/recap.ts'
import { runCommand } from '../src/main/daily/spawn.ts'
import { Store } from '../src/main/db.ts'
import { DailyStore } from '../src/main/daily/store.ts'
import { dayRange } from '../src/main/time.ts'

const cats: Category[] = [
  { name: 'Work', color: '#B984FF', description: 'Work stuff' },
  { name: 'Personal', color: '#6AADFF', description: '' },
  { name: 'Distraction', color: '#FF5950', description: 'Scrolling' },
  { name: 'Idle', color: '#A0AEC0', description: '', isIdle: true },
]

function card(p: Partial<TimelineCard> & { id: number; startTs: number; endTs: number }): TimelineCard {
  return {
    batchId: 1,
    startTime: '9:00 AM',
    endTime: '10:00 AM',
    day: '2026-11-06',
    title: `Card ${p.id}`,
    summary: '',
    detailedSummary: '',
    category: 'Work',
    subcategory: '',
    distractions: [],
    appSites: null,
    isError: false,
    ...p,
  }
}

// ---------------------------------------------------------------------------------------------
// Source-day selection
// ---------------------------------------------------------------------------------------------

test('source day: most recent of the previous 3 days with enough activity', () => {
  const minutes: Record<string, number> = { '2026-11-07': 30, '2026-11-06': 200, '2026-11-05': 500 }
  const deps = { consumed: new Set<string>(), activityMinutes: (d: string) => minutes[d] ?? 0 }
  assert.equal(resolveSourceDay('2026-11-08', deps), '2026-11-06')
})

test('source day: consumed days are skipped; Monday can use Friday after an empty weekend', () => {
  // 2026-11-09 is a Monday.
  const minutes: Record<string, number> = { '2026-11-06': 300 }
  const deps = { consumed: new Set<string>(), activityMinutes: (d: string) => minutes[d] ?? 0 }
  assert.equal(resolveSourceDay('2026-11-09', deps), '2026-11-06')
  deps.consumed.add('2026-11-06')
  assert.equal(resolveSourceDay('2026-11-09', deps), null)
})

test('source day: looks back at most 3 days and uses the unified 120-minute threshold', () => {
  assert.equal(SOURCE_MIN_MINUTES, 120)
  const minutes: Record<string, number> = { '2026-11-04': 900, '2026-11-07': 119 }
  const deps = { consumed: new Set<string>(), activityMinutes: (d: string) => minutes[d] ?? 0 }
  assert.equal(resolveSourceDay('2026-11-08', deps), null)
  minutes['2026-11-07'] = 120
  assert.equal(resolveSourceDay('2026-11-08', deps), '2026-11-07')
})

test('source day: consumed set comes from other rows only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-daily-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const daily = new DailyStore(store.db)
    daily.saveStandup('2026-11-07', JSON.stringify({ generation: { provider: 'claude', runtime: 'chat_cli', sourceDay: '2026-11-06' } }))
    daily.saveStandup('2026-11-08', JSON.stringify({ generation: { provider: 'claude', runtime: 'chat_cli', sourceDay: '2026-11-07' } }))
    daily.saveStandup('2026-11-09', 'not json')
    assert.deepEqual([...daily.consumedSourceDays('2026-11-08')].sort(), ['2026-11-06'])
    assert.deepEqual([...daily.consumedSourceDays('2026-11-10')].sort(), ['2026-11-06', '2026-11-07'])
    // Upsert keeps one row per day
    daily.saveStandup('2026-11-07', JSON.stringify({ generation: { provider: 'gemini', runtime: 'gemini_direct', sourceDay: '2026-11-05' } }))
    assert.equal(JSON.parse(daily.fetchStandup('2026-11-07')!).generation.sourceDay, '2026-11-05')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activity minutes include System cards, tracked minutes exclude them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-daily-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const daily = new DailyStore(store.db)
    const { start } = dayRange('2026-11-06')
    const ins = store.db.prepare(
      'INSERT INTO timeline_cards (start, end, start_ts, end_ts, day, title, category) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    ins.run('9:00 AM', '10:00 AM', start + 5 * 3600, start + 6 * 3600, '2026-11-06', 'a', 'Work')
    ins.run('10:00 AM', '10:30 AM', start + 6 * 3600, start + 6.5 * 3600, '2026-11-06', 'b', 'System')
    ins.run('2:00 AM', '3:00 AM', start - 2 * 3600, start - 3600, '2026-11-05', 'before 4am', 'Work')
    assert.equal(daily.activityMinutes('2026-11-06'), 90)
    assert.equal(daily.trackedMinutes('2026-11-06'), 60)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------------------------

test('recap parsing: plain JSON', () => {
  const r = parseRecapResponse('{"done": ["Shipped the pricing page", "Sent the deck"], "next": "Reply to Lisa"}')
  assert.deepEqual(r, { done: ['Shipped the pricing page', 'Sent the deck'], next: 'Reply to Lisa' })
})

test('recap parsing: thinking block, fences and surrounding prose', () => {
  const raw = '---THINKING---\nhmm {not json}\n---END_THINKING---\n```json\n{"done": ["A"], "next": null}\n```'
  assert.deepEqual(parseRecapResponse(raw), { done: ['A'], next: null })
  const prose = 'Sure! Here it is: {"done": ["Fixed the {brace} bug \\"quoted\\""], "next": ["", "Write tests"]} Hope that helps.'
  assert.deepEqual(parseRecapResponse(prose), { done: ['Fixed the {brace} bug "quoted"'], next: 'Write tests' })
})

test('recap parsing: scalar done, numbers, "null" strings, duplicates and the 5-item cap', () => {
  assert.deepEqual(parseRecapResponse('{"done": "Only one"}'), { done: ['Only one'], next: null })
  const r = parseRecapResponse('{"done": [" a ", "a", "NULL", "", 42, "b", "c", "d", "e", "f"], "next": "null"}')
  assert.deepEqual(r.done, ['a', '42', 'b', 'c', 'd'])
  assert.equal(r.next, null)
})

test('recap parsing: errors', () => {
  assert.throws(() => parseRecapResponse('no json here'), (e: unknown) => e instanceof RecapParseError && e.kind === 'invalidJSONResponse')
  assert.throws(() => parseRecapResponse('[1,2]'), (e: unknown) => e instanceof RecapParseError && e.kind === 'invalidJSONResponse')
  assert.throws(() => parseRecapResponse('{"items": []}'), (e: unknown) => e instanceof RecapParseError && e.kind === 'invalidResponseShape')
  const empty = parseRecapResponse('{"done": [], "next": null}')
  assert.throws(
    () => draftFromParsed(empty, { provider: 'gemini', runtime: 'gemini_direct' }),
    (e: unknown) => e instanceof RecapParseError && e.kind === 'emptyGeneratedContent',
  )
})

test('recap draft: highlights, single task, empty blockers, default titles', () => {
  const d = draftFromParsed({ done: ['A', 'B'], next: 'C' }, { provider: 'claude', runtime: 'chat_cli', sourceDay: '2026-11-06' })
  assert.deepEqual(d.highlights.map((b) => b.text), ['A', 'B'])
  assert.deepEqual(d.tasks.map((b) => b.text), ['C'])
  assert.equal(d.blockersBody, '')
  assert.equal(d.highlightsTitle, "Yesterday's highlights")
  assert.equal(d.tasksTitle, "Today's tasks")
  assert.match(d.highlights[0].id, /^[0-9A-F-]{36}$/)
})

test('stored payload decoding: legacy rows without generation are Dayflow backend rows', () => {
  const d = decodeDraft('{"highlights":[{"id":"X","text":"t"}],"tasks":[],"blockersBody":"b"}')!
  assert.deepEqual(d.generation, { provider: 'dayflow', runtime: 'dayflow_backend' })
  assert.equal(d.blockersTitle, 'Blockers')
  assert.equal(decodeDraft('nope'), null)
})

test('balanced object scanner tracks strings and escapes', () => {
  assert.equal(firstBalancedObject('x {"a": "}", "b": {"c": 1}} y {"z":2}'), '{"a": "}", "b": {"c": 1}}')
  assert.equal(firstBalancedObject('no braces'), null)
})

test('cards text: compact clock, numbering, summary indentation', () => {
  assert.equal(compactClock('9:05 AM'), '9:05am')
  assert.equal(compactClock('12:30 PM'), '12:30pm')
  assert.equal(compactClock('Noonish'), 'noonish')
  const text = makeCardsText('2026-11-06', [
    card({ id: 2, startTs: 200, endTs: 300, startTime: '10:20 AM', endTime: '11:00 AM', title: 'Second', summary: 'Second' }),
    card({ id: 1, startTs: 100, endTs: 200, startTime: '9:05 AM', endTime: '10:20 AM', title: 'First', summary: 'Did a thing' }),
    card({ id: 3, startTs: 300, endTs: 400, startTime: '11:00 AM', endTime: '11:30 AM', title: '', summary: '' }),
  ])
  assert.equal(
    text,
    'Timeline activities for 2026-11-06:\n\n1. 9:05am - 10:20am: First\n   Did a thing\n2. 10:20am - 11:00am: Second\n3. 11:00am - 11:30am: Untitled activity',
  )
  assert.equal(makeCardsText('2026-11-06', []), 'No timeline activities were recorded for 2026-11-06.')
})

test('recap prompt: per-provider instructions and the language section', () => {
  assert.equal(recapInstructions('gemini'), LOCAL_RECAP_PROMPT)
  assert.match(recapInstructions('chatgpt'), /\n\nAdditional evidence checks:\n- Treat visual-access refusals/)
  const noLang = makeRecapPrompt('INSTR', 'CARDS', '')
  assert.ok(noLang.includes('CARDS\n\n\n\n## Output format'), 'empty language section leaves two blank lines')
  const withLang = makeRecapPrompt('INSTR', 'CARDS', 'The user only speaks Polish.')
  assert.ok(withLang.includes('CARDS\n\n## Language\n\nThe user only speaks Polish.\n\n## Output format'))
})

// ---------------------------------------------------------------------------------------------
// Clipboard format
// ---------------------------------------------------------------------------------------------

test('clipboard: sections, bullets, blockers split on newlines, empty sections', () => {
  const draft: DailyStandupDraft = {
    highlightsTitle: "Yesterday's highlights",
    highlights: [{ id: '1', text: ' Shipped the pricing page ' }, { id: '2', text: '' }],
    tasksTitle: "Today's tasks",
    tasks: [],
    blockersTitle: 'Blockers',
    blockersBody: 'Waiting on legal\n\nNo staging access',
  }
  const titles = { highlights: 'Highlights from Yesterday', tasks: 'Tasks for Today', blockers: 'Blockers' }
  assert.equal(
    standupClipboardText(draft, titles),
    'Highlights from Yesterday\n- Shipped the pricing page\n\nTasks for Today\n- None right now\n\nBlockers\n- Waiting on legal\n- No staging access',
  )
})

test('clipboard: placeholder messages are filtered out (case-insensitive)', () => {
  const p = placeholderDraft('insufficientHistory')
  assert.equal(p.highlightsTitle, 'Recent highlights')
  assert.equal(p.tasksTitle, 'Tasks')
  const titles = { highlights: 'H', tasks: 'T', blockers: 'B' }
  assert.equal(standupClipboardText(p, titles), 'H\n- None right now\n\nT\n- None right now\n\nB\n- None right now')
  const shouty = { ...p, highlights: [{ id: 'x', text: PLACEHOLDER_MESSAGES.notGenerated.toUpperCase() }, { id: 'y', text: 'Real' }] }
  assert.ok(standupClipboardText(shouty, titles).startsWith('H\n- Real\n\nT'))
})

// ---------------------------------------------------------------------------------------------
// Day goals
// ---------------------------------------------------------------------------------------------

const DAY = '2026-11-06'
const D0 = dayRange(DAY).start // 4:00 AM
const at = (h: number, m = 0) => D0 + ((h - 4) * 60 + m) * 60

test('goals: default plan', () => {
  const p = defaultPlan(DAY, [...cats, { name: 'System', color: '#000', description: '' }])
  assert.equal(p.focusTargetMinutes, 270)
  assert.equal(p.distractionLimitMinutes, 120)
  assert.deepEqual(p.focusCategories.map((c) => c.name), ['Work', 'Personal'])
  assert.deepEqual(p.distractionCategories.map((c) => c.name), ['Distraction'])
})

test('goals: carry-forward resets skip/timestamps and re-resolves renamed or recoloured categories', () => {
  const saved: DayGoalPlan = {
    ...defaultPlan('2026-11-01', cats),
    isSkipped: true,
    createdAt: 100,
    updatedAt: 200,
    focusCategories: [
      { categoryID: 'work', name: 'Work', colorHex: '#old', sortOrder: 0 },
      { categoryID: 'gone', name: 'Gone', colorHex: '#123', sortOrder: 1 },
    ],
  }
  const p = carriedForwardPlan(saved, DAY, cats)
  assert.equal(p.day, DAY)
  assert.equal(p.isSkipped, false)
  assert.equal(p.createdAt, 0)
  assert.equal(p.focusCategories[0].colorHex, '#B984FF')
  assert.equal(p.focusCategories[1].name, 'Gone', 'unmatched snapshots are kept')
  const same = carriedForwardPlan({ ...saved, day: DAY }, DAY, cats)
  assert.equal(same.isSkipped, true, 'a plan for the same day is not reset')
})

test('goals: overlap removal counts each minute once (longer first on equal starts)', () => {
  const ivs = removeOverlaps([
    { start: 0, end: 30, category: 'Work', id: 2 },
    { start: 0, end: 60, category: 'Distraction', id: 1 },
    { start: 50, end: 90, category: 'Work', id: 3 },
    { start: 60, end: 70, category: 'Personal', id: 4 }, // fully covered by id 3
  ])
  assert.deepEqual(
    ivs.map((i) => [i.id, i.start, i.end]),
    [
      [1, 0, 60],
      [3, 60, 90],
    ],
  )
})

test('goals: progress with overlaps, System cards dropped, clipping to the day', () => {
  const plan = defaultPlan(DAY, cats)
  const cards = [
    card({ id: 1, startTs: at(9), endTs: at(11), category: 'Work' }), // 120
    card({ id: 2, startTs: at(10), endTs: at(12), category: 'Distraction' }), // 60 after overlap
    card({ id: 3, startTs: at(12, 3), endTs: at(13), category: 'Personal' }), // 57
    card({ id: 4, startTs: at(14), endTs: at(15), category: 'System', isError: true }),
    card({ id: 5, startTs: at(3), endTs: at(4, 30), category: 'Work' }), // starts before the day: 30 counted
  ]
  const p = computeProgress(plan, false, cards, D0, cats)
  assert.equal(p.totalCapturedMinutes, 120 + 60 + 57 + 30)
  assert.equal(p.focusMinutes, 120 + 57 + 30)
  assert.equal(p.distractedMinutes, 60)
  assert.deepEqual(p.focusSegments.map((s) => [s.name, s.minutes]), [
    ['Work', 150],
    ['Personal', 57],
  ])
  assert.equal(p.categoryDurations[0].name, 'Work')
  // Focus blocks: 0–30 (4:00–4:30), 300–420 (9–11) and 483–540 (12:03–13) stay apart (gap 63 ≥ 5)
  assert.deepEqual(p.focusBlocks, [
    { start: 0, end: 30 },
    { start: 300, end: 420 },
    { start: 483, end: 540 },
  ])
})

test('goals: focus blocks merge gaps under 5 minutes', () => {
  assert.deepEqual(mergeBlocks([{ start: 0, end: 10 }, { start: 14, end: 20 }, { start: 25, end: 30 }]), [
    { start: 0, end: 20 },
    { start: 25, end: 30 },
  ])
})

test('goals: matching by name when the snapshot id is stale', () => {
  const plan: DayGoalPlan = {
    ...defaultPlan(DAY, cats),
    focusCategories: [{ categoryID: 'old-uuid', name: 'work', colorHex: '#000', sortOrder: 0 }],
    distractionCategories: [],
  }
  const p = computeProgress(plan, true, [card({ id: 1, startTs: at(9), endTs: at(10) })], D0, cats)
  assert.equal(p.focusMinutes, 60)
})

test('goals: normalize clamps to 5-minute steps within 0–12h55 and dedupes', () => {
  const p = normalizePlan(
    {
      ...defaultPlan(DAY, cats),
      focusTargetMinutes: 1000,
      distractionLimitMinutes: 33,
      focusCategories: [
        { categoryID: 'work', name: 'Work', colorHex: '#000', sortOrder: 5 },
        { categoryID: 'work', name: 'Work', colorHex: '#000', sortOrder: 6 },
      ],
    },
    cats,
  )
  assert.equal(p.focusTargetMinutes, 775)
  assert.equal(p.distractionLimitMinutes, 35)
  assert.deepEqual(p.focusCategories.map((c) => [c.name, c.sortOrder]), [['Work', 0]])
})

test('goals: compact hours formatting', () => {
  assert.equal(formatCompactHours(270), '4.5')
  assert.equal(formatCompactHours(240), '4')
  assert.equal(formatCompactHours(240.3), '4')
  assert.equal(formatCompactHours(100), '1.7')
})

test('goals: store round-trip, carry-forward lookup and consecutive skips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-goals-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const daily = new DailyStore(store.db)
    const base = defaultPlan('2026-11-01', cats)
    daily.saveDayGoalPlan({ ...base, focusTargetMinutes: 300 })
    daily.saveDayGoalPlan({ ...base, day: '2026-11-03', isSkipped: true })
    daily.saveDayGoalPlan({ ...base, day: '2026-11-04', isSkipped: true })
    const p = daily.fetchDayGoalPlan('2026-11-01')!
    assert.equal(p.focusTargetMinutes, 300)
    assert.deepEqual(p.focusCategories.map((c) => c.name), ['Work', 'Personal'])
    assert.deepEqual(p.distractionCategories.map((c) => c.name), ['Distraction'])
    assert.ok(p.createdAt > 0)
    assert.equal(daily.fetchMostRecentDayGoalPlan('2026-11-02')!.day, '2026-11-01')
    assert.equal(daily.consecutiveSkippedDayGoalCount('2026-11-05', 5), 2)
    assert.equal(daily.consecutiveSkippedDayGoalCount('2026-11-04', 5), 1)
    assert.equal(daily.consecutiveSkippedDayGoalCount('2026-11-02', 5), 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// Daily Brief logic
// ---------------------------------------------------------------------------------------------

test('brief prompt: single-pass replacement, unknown keys literal, newline collapse, override slot', () => {
  const out = buildPrompt('A {{X}}\n\n\n\n{{Y}} {{UNKNOWN}}', { X: '{{Y}}', Y: 'y' })
  assert.equal(out, 'A {{Y}}\n\ny {{UNKNOWN}}')
  assert.equal(chooseTemplate('default {{OVERRIDE_INSTRUCTIONS}}', '  ').template, 'default {{OVERRIDE_INSTRUCTIONS}}')
  const custom = chooseTemplate('default', 'mine')
  assert.equal(custom.template, 'mine\n\n{{OVERRIDE_INSTRUCTIONS}}')
  assert.equal(custom.usedOverride, true)
})

test('brief card lines: short and detailed variants', () => {
  const c = card({
    id: 123,
    startTs: 1,
    endTs: 2,
    startTime: '9:05 AM',
    endTime: '10:20 AM',
    title: 'Title',
    summary: 'x'.repeat(500),
    detailedSummary: 'line one\n\n  line two  ',
    appSites: { primary: 'figma.com', secondary: 'slack' },
  })
  const short = cardLines([c], false)
  assert.equal(short, `[cardId 123] 9:05 AM–10:20 AM · Work · Title — ${'x'.repeat(400)} · apps: figma.com, slack`)
  assert.ok(cardLines([c], true).endsWith('apps: figma.com, slack\n    line one\n    line two'))
})

test('brief feedback summary and recent items', () => {
  const now = new Date('2026-11-08T10:00:00Z')
  const ev = (section: string, action: 'opened' | 'dismissed', title: string, at: string) => ({ day: '2026-11-07', section, itemTitle: title, action, at })
  const s = feedbackSummary(
    [
      ev('docket', 'opened', 'A', '2026-11-07T09:00:00Z'),
      ev('docket', 'dismissed', 'B', '2026-11-07T08:00:00Z'),
      ev('docket', 'opened', 'C', '2026-10-01T08:00:00Z'), // older than 21 days
      ev('site_seeing', 'opened', 'D', '2026-11-07T08:00:00Z'),
    ],
    ['docket'],
    now,
  )
  assert.equal(
    s,
    'Counts by section:\n- docket: dismissed 1, opened 1\n\nLatest actions:\n- 2026-11-07 · docket · dismissed · "B"\n- 2026-11-07 · docket · opened · "A"',
  )
  assert.equal(feedbackSummary([], ['docket'], now), 'No feedback yet.')
  const brief = (day: string, content: DailyBrief['content']): DailyBrief => ({
    day,
    sourceDay: day,
    generatedAt: '',
    content,
    userState: { checkedItemKeys: [], dismissedItemKeys: [], addedTasks: [], hasBeenShown: false, promptEdits: {}, folders: {}, handoffs: [] },
  })
  const items = recentBriefItems(
    [
      brief('2026-11-08', { order: [], docket: [{ title: 'today' }] }),
      brief('2026-11-06', { order: [], industry_news: [{ headline: 'H', url: 'https://x.com' }] }),
      brief('2026-11-07', { order: [], docket: [{ title: 'T1' }], keep_tracking: [{ label: 'L', status: 'S' }] }),
    ],
    ['docket', 'keep_tracking'],
    '2026-11-08',
  )
  assert.equal(items, '#### 2026-11-07\n- docket: T1\n- keep_tracking: L — S')
  assert.equal(recentBriefItems([], ['docket'], '2026-11-08'), 'None yet.')
})

test('brief schemas: validator accepts good output and flags problems', () => {
  const good = { notes: 'n', items: [{ title: 't', prompt: 'p', agent: true, why: 'w', people: [{ name: 'Ann' }] }] }
  assert.deepEqual(validateSchema(good, DOCKET_SCHEMA), [])
  const bad = { notes: 'n', items: [{ title: 't', agent: 'yes', extra: 1 }] }
  const errs = validateSchema(bad, DOCKET_SCHEMA)
  assert.ok(errs.some((e) => e.includes('prompt: required')))
  assert.ok(errs.some((e) => e.includes('agent: expected boolean')))
  assert.ok(errs.some((e) => e.includes('extra: unexpected property')))
  assert.deepEqual(validateSchema({ notes: '', order: ['bogus'] }, EXTRAS_SCHEMA), ['$.order[0]: not one of keep_tracking, completed_yesterday, team_decisions, related_reading, industry_news, site_seeing'])
  // Coercion for providers without native structured output: drops bad fields/items.
  const coerced = coerceToSchema({ notes: 'n', order: ['site_seeing', 'nope'], keep_tracking: [{ label: 'a' }, { label: 'b', status: 's', why: 'w', junk: 1 }] }, EXTRAS_SCHEMA)
  assert.deepEqual(coerced, { notes: 'n', order: ['site_seeing'], keep_tracking: [{ label: 'b', status: 's', why: 'w' }] })
})

test('brief cleaning: trims, lowercases apps, keeps only http(s) URLs, needs candidates for images', () => {
  const candidates = [
    { file: '11_0905.jpg', cardId: 11 },
    { file: '12_1000.jpg', cardId: 12 },
  ]
  const { content, imagesToCopy } = cleanExtras(
    {
      notes: 'x',
      order: ['site_seeing', 'site_seeing', 'related_reading', 'industry_news', 'completed_yesterday', 'unknown'],
      completed_yesterday: [
        { title: ' Shipped it ', cardId: 11, apps: ['Figma', ' '], why: 'w' },
        { title: 'No image', cardId: 999, why: 'w' },
        { title: '  ', why: 'w' },
      ],
      related_reading_intro: 'Intro',
      related_reading: [{ title: 'Bad link', url: 'javascript:alert(1)', why: 'w' }],
      industry_news: [{ headline: 'News', url: 'https://ft.com/a', why: 'w' }],
      site_seeing: [
        { file: 'C:\\tmp\\candidates\\12_1000.jpg', caption: ' Nice ', why: 'w' },
        { file: '12_1000.jpg', why: 'dup' },
        { file: 'not_a_candidate.jpg', why: 'w' },
      ],
      keep_tracking: [{ label: 'L', status: '', why: 'w' }],
      team_decisions: [{ decision: 'D', app: 'Slack', url: 'ftp://x', why: 'w' }],
    },
    candidates,
  )
  assert.deepEqual(content.completed_yesterday, [
    { title: 'Shipped it', apps: ['figma'], cardId: 11, imageFile: 'images/11_0905.jpg' },
    { title: 'No image' },
  ])
  assert.equal(content.related_reading, undefined)
  assert.equal(content.related_reading_intro, undefined, 'intro only kept with surviving reading items')
  assert.deepEqual(content.site_seeing, [{ file: 'images/12_1000.jpg', caption: 'Nice' }])
  assert.equal(content.keep_tracking, undefined)
  assert.deepEqual(content.team_decisions, [{ decision: 'D', app: 'slack' }])
  assert.deepEqual(content.order, ['site_seeing', 'industry_news', 'completed_yesterday'])
  assert.deepEqual(imagesToCopy.sort(), ['11_0905.jpg', '12_1000.jpg'])

  const docket = cleanDocket([
    { title: ' T ', prompt: 'p', agent: true, people: [{ name: '' }, { name: 'Ann', note: ' ' }], links: [{ title: 'Doc', url: 'notaurl', app: 'Notion' }], feedback: [{ name: 'X', text: '' }] },
    { title: '', prompt: 'dropped' },
  ])
  assert.deepEqual(docket, [{ title: 'T', prompt: 'p', agent: true, people: [{ name: 'Ann' }], links: [{ title: 'Doc', app: 'notion' }] }])
})

test('brief merge: docket first, failed parts recorded, both failing throws', () => {
  const extras = { order: ['industry_news' as const], industry_news: [{ headline: 'H', url: 'https://a.b' }] }
  const m = mergeParts({ items: [{ title: 'T' }] }, extras)
  assert.deepEqual(m.content.order, ['docket', 'industry_news'])
  assert.deepEqual(m.failedParts, {})
  const half = mergeParts({ error: 'Docket broke.' }, extras)
  assert.deepEqual(half.content.order, ['industry_news'])
  assert.equal(half.failedParts.docket, 'Docket broke.')
  assert.throws(() => mergeParts({ error: 'Same.' }, { error: 'Same.' }), /^Error: Same\.$/)
  // Failed parts keep the previous brief's sections on retry
  const existing: DailyBrief = {
    day: 'd',
    sourceDay: 's',
    generatedAt: '',
    content: { order: ['docket', 'keep_tracking'], docket: [{ title: 'Old' }], keep_tracking: [{ label: 'L', status: 'S' }] },
    userState: { checkedItemKeys: [], dismissedItemKeys: [], addedTasks: [], hasBeenShown: true, promptEdits: {}, folders: {}, handoffs: [] },
  }
  const kept = keepFailedParts(half.content, half.failedParts, existing)
  assert.deepEqual(kept.docket, [{ title: 'Old' }])
  assert.deepEqual(orderedKinds(kept), ['docket', 'industry_news'])
  const keptExtras = keepFailedParts({ order: ['docket'], docket: [{ title: 'New' }] }, { extras: 'x' }, existing)
  assert.deepEqual(keptExtras.order, ['docket', 'keep_tracking'])
})

test('brief render order: known non-empty sections from order, then the rest in enum order', () => {
  assert.deepEqual(
    orderedKinds({
      order: ['site_seeing', 'docket', 'site_seeing', 'team_decisions'],
      docket: [{ title: 't' }],
      site_seeing: [{ file: 'images/a.jpg' }],
      team_decisions: [],
      keep_tracking: [{ label: 'l', status: 's' }],
    }),
    ['site_seeing', 'docket', 'keep_tracking'],
  )
})

test('claude output: verbose event array, shell noise, structured output, failures', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-opus' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }, { type: 'tool_use', name: 'StructuredOutput', input: {} }] } },
    { type: 'result', subtype: 'success', is_error: false, structured_output: { notes: 'n', items: [] }, total_cost_usd: 0.5, num_turns: 3 },
  ]
  const parsed = parseClaudeEvents(`Welcome to the shell!\r\n${JSON.stringify(events)}\r\n`)
  assert.equal(parsed.length, 3)
  const env = resultEnvelope(parsed)!
  assert.deepEqual(structuredFromEnvelope(env), { notes: 'n', items: [] })
  const textEnv = { type: 'result', subtype: 'success', result: 'Here:\n```json\n{"notes":"x","order":[]}\n```' }
  assert.deepEqual(structuredFromEnvelope(textEnv), { notes: 'x', order: [] })
  assert.equal(classifyClaudeFailure({ type: 'result', subtype: 'error_max_turns' }, '', ''), 'Claude ran out of steps before finishing. Try again.')
  assert.equal(classifyClaudeFailure({ type: 'result', subtype: 'error_max_structured_output_retries' }, '', ''), "Claude's answer came back in an unexpected shape. Try again.")
  assert.equal(classifyClaudeFailure(null, "Claude AI usage limit reached", ''), 'Claude hit its usage limit. Try again after it resets.')
})

test('read-only hook decision: allowlist table of tricky names', () => {
  const table: [string, boolean, string?][] = [
    ['', false],
    ['WebFetch', false, 'only MCP tools reach the hook'],
    ['mcp__', false],
    ['mcp__gmail', false, 'no tool part'],
    ['mcp__dayflow__fetchTimeline', true],
    ['mcp__dayflow__fetchObservations', true],
    ['mcp__dayflow__set_day_goal', false],
    ['mcp__claude_ai_Gmail__search_emails', true],
    ['mcp__claude_ai_Gmail__send_email', false],
    ['mcp__gmail__get_email', true],
    ['mcp__gmail__list_recent_emails', true],
    ['mcp__gmail__list_attachments', true],
    ['mcp__gmail__save_attachment', false],
    ['mcp__gmail__mark_email', false],
    ['mcp__gmail__move_email', false],
    ['mcp__gmail__delete_email', false],
    ['mcp__claude_ai_Slack__slack_read_channel', true, 'server name words are ignored'],
    ['mcp__claude_ai_Slack__slack_search_public_and_private', true],
    ['mcp__claude_ai_Slack__slack_send_message_draft', false],
    ['mcp__claude_ai_Slack__slack_schedule_message', false],
    ['mcp__claude_ai_Linear__save_issue', false],
    ['mcp__claude_ai_Linear__list_issues', true],
    ['mcp__claude_ai_Linear__get_issue', true],
    ['mcp__claude_ai_Linear__list_comments', true],
    ['mcp__claude_ai_Linear__mark_notification', false],
    ['mcp__claude_ai_Linear__extract_images', false],
    ['mcp__notion__getPage', true, 'camelCase is split'],
    ['mcp__notion__updatePage', false],
    ['mcp__google_drive__trash_file', false],
    ['mcp__google_drive__download_file_content', false, 'download writes to disk'],
    ['mcp__google_drive__DOWNLOAD_ATTACHMENT', false],
    ['mcp__google_drive__read_file_content', true],
    ['mcp__google_drive__search_files', true],
    ['mcp__composio__GMAIL_SEND_EMAIL', false, 'ALLCAPS is split'],
    ['mcp__composio__GMAIL_FETCH_EMAILS', false, '"gmail" is not a known word for this server'],
    ['mcp__gmail__GMAIL_FETCH_EMAILS', true],
    ['mcp__cal__modifyEvent', false],
    ['mcp__cal__rescheduleEvent', false],
    ['mcp__cal__upsert_event', false],
    ['mcp__cal__clear_calendar', false],
    ['mcp__cal__list_events', true],
    ['mcp__cal__getHTTPResponse', false, 'ALLCAPS run inside camelCase'],
    ['mcp__x__search_and_delete', false, 'every word must be allowlisted'],
    ['mcp__x__get_or_create_user', false],
    ['mcp__x__read_and_reply', false],
    ['mcp__x__whoami', false, 'unknown verbs are denied'],
    ['mcp__x__messages', false, 'nouns alone are not a read verb'],
    ['mcp__x__mark_read', false],
    ['mcp__x__get-user-profile', true, 'kebab-case'],
    ['mcp__x__fetch__delete_all', false, 'the whole tool part is checked, not only the last __ segment'],
    ['mcp__fetch__fetch', false, 'generic web servers take arbitrary URLs'],
    ['mcp__web__fetch_page', false],
    ['mcp__plugin_playwright_playwright__browser_snapshot', false],
    ['mcp__oduflow__run_db_query', false],
    ['mcp__oduflow__http_request_to_odoo', false],
    ['mcp__chrome__navigate_page', false],
    ['mcp__trans__getFreights', false, 'unknown noun'],
    ['mcp__trans__get_ext_media_storage_api_v1_assets_assetId', false],
  ]
  for (const [name, expected, why] of table) assert.equal(hookDecision(name).allow, expected, `${name}${why ? ` (${why})` : ''}`)
})

test('write-verb deny globs: catch write tools, leave read tools alone', () => {
  // Claude Code permission globs: case-sensitive, `*` matches anything (including `__`).
  const rules = mcpWriteDenyRules().map((r) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
  const denied = (t: string) => rules.some((r) => r.test(t))
  for (const t of [
    'mcp__gmail__send_email', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__x__sendMessage', 'mcp__x__slackSendMessage',
    'mcp__x__GMAIL_SEND_EMAIL', 'mcp__x__trashEmail', 'mcp__google_drive__trash_file', 'mcp__x__DOWNLOAD_ATTACHMENT',
    'mcp__x__download_file_content', 'mcp__x__send-email', 'mcp__linear__save_issue', 'mcp__x__set_day_goal',
    'mcp__oduflow__run_db_query', 'mcp__x__upsert_event', 'mcp__x__reschedule', 'mcp__x__mark_email',
  ]) assert.ok(denied(t), t)
  for (const t of [
    'mcp__gmail__get_email', 'mcp__gmail__search_emails', 'mcp__x__get_settings', 'mcp__x__list_datasets', 'mcp__x__get_address',
    'mcp__x__list_posts', 'mcp__claude_ai_Linear__list_comments', 'mcp__x__list_labels', 'mcp__x__list_runs',
    'mcp__claude_ai_Google_Drive__list_shared_drives', 'mcp__dayflow__fetchTimeline', 'mcp__x__get_markdown',
  ]) assert.ok(!denied(t), t)
})

test('hook heartbeat: every MCP tool call needs a hook log line', () => {
  const log = '2026-11-08T08:00:00.000Z allow mcp__gmail__get_email\n2026-11-08T08:00:01.000Z deny mcp__gmail__send_email\n'
  assert.deepEqual(hookLogCounts(log), { mcp__gmail__get_email: 1, mcp__gmail__send_email: 1 })
  assert.deepEqual(unguardedToolCalls({ WebSearch: 3, mcp__gmail__get_email: 1, mcp__gmail__send_email: 1 }, log), [])
  assert.deepEqual(unguardedToolCalls({ mcp__gmail__get_email: 2 }, log), ['mcp__gmail__get_email'], 'second call not seen')
  assert.deepEqual(unguardedToolCalls({ mcp__slack__read: 1 }, ''), ['mcp__slack__read'], 'hook never ran')
  assert.deepEqual(unguardedToolCalls(undefined, ''), [])
  assert.deepEqual(unguardedToolCalls({ WebSearch: 2, Read: 1 }, ''), [], 'built-ins are not hooked')
})

test('read-only hook script: allow prints JSON and exits 0, deny exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-hook-'))
  try {
    const file = join(dir, 'hook.js')
    writeFileSync(file, hookScriptSource(null))
    const run = (tool: string) => spawnSync(process.execPath, [file], { input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' })
    const ok = run('mcp__claude_ai_Gmail__get_email')
    assert.equal(ok.status, 0)
    assert.deepEqual(JSON.parse(ok.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    const no = run('mcp__claude_ai_Gmail__send_email')
    assert.equal(no.status, 2)
    assert.equal(no.stderr, "Dayflow's daily brief can only read from your tools, so mcp__claude_ai_Gmail__send_email was blocked.")
    const garbage = spawnSync(process.execPath, [file], { input: 'not json', encoding: 'utf8' })
    assert.equal(garbage.status, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claude permission rule paths use the //c/... form', () => {
  assert.equal(claudeAbsRulePath('C:\\Users\\a\\Temp\\candidates'), '//c/Users/a/Temp/candidates')
})

test('docket status', () => {
  const e = { title: 't', dismissed: false, at: '', reviewed: false, failed: false }
  assert.equal(docketStatus(undefined), 'new')
  assert.equal(docketStatus({ ...e, dismissed: true }), 'dismissed')
  assert.equal(docketStatus({ ...e, method: 'run' }), 'inProgress')
  assert.equal(docketStatus({ ...e, method: 'run', finishedAt: 'x' }), 'ready')
  assert.equal(docketStatus({ ...e, method: 'run', failed: true }), 'failed')
  assert.equal(docketStatus({ ...e, method: 'run', reviewed: true }), 'reviewed')
})

test('JSON extractors continue past unclosed braces and unparseable candidates', () => {
  // An unclosed brace before the real object used to stop both scanners.
  const text = 'Thinking {not closed... here it is: {"done":["a"],"next":"b"} trailing'
  assert.deepEqual(balancedJsonValues(text), [{ done: ['a'], next: 'b' }])
  assert.deepEqual(objectFromText(text), { done: ['a'], next: 'b' })
  assert.equal(firstBalancedObject(text), '{"done":["a"],"next":"b"}')
  assert.deepEqual(parseRecapResponse(text), { done: ['a'], next: 'b' })
  // Balanced but not JSON ({placeholder}) is skipped for the next candidate.
  const t2 = 'Use {placeholder} then {"done":["x"]}'
  assert.equal(firstBalancedObject(t2), '{"done":["x"]}')
  assert.deepEqual(objectFromText(t2), { done: ['x'] })
  // A complete object nested inside an unclosed one is still found.
  assert.equal(firstBalancedObject('{ "outer": {"a":1} '), '{"a":1}')
  assert.equal(firstBalancedObject('{ never closed'), null)
  assert.equal(objectFromText('{ never closed'), null)
})

test('brief file store: range validation and path containment', () => {
  assert.equal(isSummaryRange('last_7_days'), true)
  for (const bad of ['../../evil', 'last_7_days/../x', 'toString', '__proto__', '', 7, null]) assert.equal(isSummaryRange(bad), false, String(bad))
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-store-'))
  try {
    const files = new BriefFileStore(dir)
    assert.equal(files.summary('../../evil' as never), null)
    assert.throws(() => files.saveSummary({ range: '../x' } as never), /Invalid range/)
    assert.throws(() => files.dayDir('../2026-11-08'), /Invalid day/)
    assert.throws(() => files.transcriptPath('2026-11-08', '../../x'), /Invalid part/)
    const images = join(files.dayDir('2026-11-08'), 'images')
    mkdirSync(images, { recursive: true })
    writeFileSync(join(images, 'a_0900.jpg'), 'x')
    assert.equal(files.imagePath('2026-11-08', 'images/a_0900.jpg'), join(images, 'a_0900.jpg'))
    assert.equal(files.imagePath('2026-11-08', '..\\..\\a_0900.jpg'), join(images, 'a_0900.jpg'), 'only the base name is used')
    assert.equal(files.imagePath('2026-11-08', '..'), null)
    assert.equal(files.imagePath('2026-11-08', 'brief.json'), null)
    assert.equal(files.savedImagePath('../saved.json'), null)
    assert.equal(files.savedImagePath('..jpg'), null)
    assert.equal(inside(dir, 'a.jpg'), join(dir, 'a.jpg'))
    assert.equal(inside(dir, '../a.jpg'), null)
    assert.equal(inside(dir, '.'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal hand-off script: quoted values, doubled %, no stray quotes', () => {
  const s = terminalScript('C:\\Program Files (x86)\\My "Proj"', 'C:\\Users\\a b\\npm\\claude.cmd', 'Read the task in C:\\x\\100%.prompt\r\nnow')
  assert.equal(
    s,
    '@echo off\r\nchcp 65001 >nul\r\ncd /d "C:\\Program Files (x86)\\My  Proj "\r\ncall "C:\\Users\\a b\\npm\\claude.cmd" "Read the task in C:\\x\\100%%.prompt  now"\r\n',
  )
})

test('abortable provider calls: reject on abort, never return a cancelled answer', async () => {
  let seen: AbortSignal | undefined
  let release: (v: string) => void = () => {}
  const provider = {
    id: 'fake',
    model: null,
    generateText: (_p: string, _o: string, _j: boolean, signal?: AbortSignal) => {
      seen = signal
      return new Promise<string>((r) => (release = r))
    },
  }
  const ac = new AbortController()
  const p = generateTextAbortable(provider, 'p', 'op', true, ac.signal)
  assert.equal(seen, ac.signal, 'the signal is passed to the provider')
  ac.abort()
  await assert.rejects(p, CancelledError)
  release('late answer')
  await assert.rejects(generateTextAbortable(provider, 'p', 'op', true, ac.signal), CancelledError, 'already aborted')
  await assert.rejects(runCommand(process.execPath, ['-e', ''], { cwd: tmpdir(), timeoutMs: 5000, signal: ac.signal }), /Cancelled/)
})

test('recap: a cancelled regenerate is not reused and its provider call is aborted', async () => {
  const signals: AbortSignal[] = []
  const pending: ((v: string) => void)[] = []
  const saved: string[] = []
  const recap = new RecapService({
    daily: {
      settings: () => ({ recapEnabled: true, isDailyUnlocked: true }),
      fetchStandup: () => null,
      consumedSourceDays: () => new Set<string>(),
      activityMinutes: () => 600,
      analyzedBatchCount: () => 100,
      saveStandup: (day: string) => saved.push(day),
    } as never,
    cardsForDay: () => [card({ id: 1, startTs: 1, endTs: 3600, title: 'Work' })],
    settings: () => ({ provider: 'gemini', outputLanguage: '', hasGeminiKey: true }) as never,
    makeProvider: () => ({
      id: 'fake',
      model: 'm',
      generateText: (_p: string, _o: string, _j: boolean, signal?: AbortSignal) => {
        signals.push(signal!)
        return new Promise<string>((r) => pending.push(r))
      },
    }),
    notify: () => {},
    changed: () => {},
  })
  const day = '2026-11-08'
  const first = recap.regenerate(day)
  assert.equal(recap.regenerate(day), first, 'a running regenerate is joined')
  await new Promise((r) => setTimeout(r, 10))
  recap.cancel(day)
  assert.equal(signals[0].aborted, true, 'cancel aborts the provider call')
  const second = recap.regenerate(day)
  assert.notEqual(second, first, 'a cancelled run is not reused')
  assert.equal((await first).status, 'cancelled')
  await new Promise((r) => setTimeout(r, 10))
  pending[0]('{"done":["stale"],"next":null}')
  pending[1]('{"done":["fresh"],"next":"n"}')
  assert.equal((await second).status, 'ok')
  assert.deepEqual(saved, [day], 'only the second run saved')
})
