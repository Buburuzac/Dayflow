import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Category, TimelineCard } from '../src/shared/types.ts'
import {
  accessProgress,
  appColorHex,
  buildContextCharts,
  buildDashboard,
  buildDonut,
  buildFacts,
  buildHeatmap,
  buildPreviewDashboard,
  buildSankey,
  buildSankeyModel,
  buildTreemap,
  buildWorkflow,
  distractedMinutes,
  durationText,
  fallbackColorHex,
  heatmapScores,
  normalizedHost,
  normalizedKey,
  normalizedMinuteRange,
  prettyAppName,
  recordedMinutesFor,
  runLengths,
  sankeyDuration,
  sankeyPercent,
  shiftWeek,
  treemapDurationText,
  weekContaining,
  weekDayStrings,
  weekFromDay,
  weeklyActivityWindow,
  ymd,
  BUILDER_PALETTE,
} from '../src/main/features/weekly-builder.ts'

const cats: Category[] = [
  { name: 'Work', color: '#B984FF', description: '' },
  { name: 'Personal', color: '#6AADFF', description: '' },
  { name: 'Distraction', color: '#FF5950', description: '' },
  { name: 'Idle', color: '#A0AEC0', description: '', isIdle: true },
]

const WEEK = weekFromDay('2026-11-02') // Monday Nov 2 2026
let nextId = 1
function card(day: string, start: string, end: string, category: string, extra: Partial<TimelineCard> = {}): TimelineCard {
  return {
    id: nextId++,
    batchId: null,
    startTs: 0,
    endTs: 0,
    startTime: start,
    endTime: end,
    day,
    title: 'Something',
    summary: '',
    detailedSummary: '',
    category,
    subcategory: '',
    distractions: [],
    appSites: null,
    isError: false,
    ...extra,
  }
}

test('week ranges start Monday 04:00 and handle early Monday hours', () => {
  const w = weekContaining(new Date(2026, 10, 8, 15)) // Sunday Nov 8
  assert.equal(ymd(w.start), '2026-11-02')
  assert.equal(w.start.getHours(), 4)
  assert.equal(ymd(w.end), '2026-11-09')
  const early = weekContaining(new Date(2026, 10, 9, 2)) // Monday 2 AM belongs to the previous week
  assert.equal(ymd(early.start), '2026-11-02')
  const after = weekContaining(new Date(2026, 10, 9, 5))
  assert.equal(ymd(after.start), '2026-11-09')
  assert.equal(ymd(shiftWeek(w, -1).start), '2026-10-26')
  assert.deepEqual(weekDayStrings(w), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
  // DST change (Europe ends DST Oct 25 2026): still 04:00 local
  assert.equal(shiftWeek(w, -2).start.getHours(), 4)
})

test('keys, normalization and fallback colours', () => {
  assert.equal(normalizedKey('  Coding / Debugging '), 'coding_debugging')
  assert.equal(normalizedKey('Café'), 'cafe')
  assert.deepEqual(normalizedMinuteRange(23 * 60, 30), { start: 1380, end: 1470 })
  assert.deepEqual(normalizedMinuteRange(600, 600), { start: 600, end: 2040 })
  assert.ok(BUILDER_PALETTE.includes(fallbackColorHex('research', BUILDER_PALETTE)))
  assert.equal(fallbackColorHex('x', BUILDER_PALETTE), fallbackColorHex('x', BUILDER_PALETTE))
})

test('app identity mapping', () => {
  assert.equal(prettyAppName('chatgpt.com'), 'ChatGPT')
  assert.equal(prettyAppName('https://chat.openai.com/c/1'), 'Chat')
  assert.equal(prettyAppName('docs.google.com'), 'Docs')
  assert.equal(prettyAppName('twitter.com'), 'X')
  assert.equal(prettyAppName('visual studio code'), 'Visual Studio Code')
  assert.equal(prettyAppName(''), 'Other')
  assert.equal(appColorHex('Max'), '111111') // the broad "x" needle, ported as-is
  assert.equal(appColorHex('Slack'), '36C5F0')
  assert.equal(normalizedHost('github.com'), 'github.com')
  assert.equal(normalizedHost('https://www.youtube.com/watch'), 'www.youtube.com')
  assert.equal(normalizedHost('figma.com/file/abc'), 'figma.com')
  assert.equal(normalizedHost('slack'), 'slack.com')
  assert.equal(normalizedHost('codex.so'), 'chatgpt.com')
  assert.equal(normalizedHost(''), null)
})

test('facts: system/idle flags, distraction rules and aligned intervals', () => {
  const day = '2026-11-02'
  const facts = buildFacts(
    [
      card(day, '9:00 AM', '10:00 AM', 'Work', {
        distractions: [{ startTime: '9:20 AM', endTime: '9:30 AM', title: 'X', summary: '' }],
        appSites: { primary: 'github.com' },
      }),
      card(day, '10:00 AM', '10:30 AM', 'Distraction', { appSites: { primary: 'youtube.com' } }),
      card(day, '10:30 AM', '11:00 AM', 'Idle'),
      card(day, '11:00 AM', '11:15 AM', 'System', { isError: true }),
      card(day, 'bad', '11:15 AM', 'Work'),
    ],
    cats,
    WEEK,
  )
  assert.equal(facts.length, 4)
  const [work, dist, idle, sys] = facts
  assert.equal(work.appName, 'GitHub')
  assert.equal(work.isDistraction, true)
  assert.equal(work.isFullDistraction, false)
  assert.deepEqual(work.embeddedIntervals, [{ start: 560, end: 570 }])
  assert.equal(dist.isFullDistraction, true)
  assert.equal(dist.appKind, 'distraction')
  assert.equal(idle.isIdle, true)
  assert.equal(sys.isSystem, true)
  assert.equal(distractedMinutes(facts.filter((f) => !f.isSystem && !f.isIdle)), 10 + 30)
  assert.equal(work.categoryColorHex, 'B984FF')
})

test('donut: top 5 with Other, excludes idle/system and out-of-week cards', () => {
  const day = '2026-11-03'
  const extra: Category[] = [...cats, ...['A', 'B', 'C'].map((n) => ({ name: n, color: '#123456', description: '' }))]
  const cards = [
    card(day, '9:00 AM', '12:00 PM', 'Work'),
    card(day, '12:00 PM', '1:00 PM', 'Personal'),
    card(day, '1:00 PM', '1:50 PM', 'A'),
    card(day, '2:00 PM', '2:40 PM', 'B'),
    card(day, '3:00 PM', '3:30 PM', 'C'),
    card(day, '4:00 PM', '4:20 PM', 'Distraction'),
    card(day, '5:00 PM', '9:00 PM', 'Idle'),
    card('2026-11-20', '9:00 AM', '5:00 PM', 'Work'),
  ]
  const d = buildDonut(cards, extra, WEEK)
  assert.deepEqual(
    d.items.map((i) => [i.name, i.minutes]),
    [['Work', 180], ['Personal', 60], ['A', 50], ['B', 40], ['Other', 50]],
  )
  assert.equal(d.totalMinutes, 380)
  assert.equal(buildDonut([], cats, WEEK).items.length, 0)
})

test('context charts count shifts and distractions per day', () => {
  const day = '2026-11-05' // Thursday
  const facts = buildFacts(
    [
      card(day, '9:00 AM', '9:30 AM', 'Work'),
      card(day, '9:30 AM', '10:00 AM', 'Distraction'),
      card(day, '10:00 AM', '11:00 AM', 'Work', {
        distractions: [
          { startTime: '10:10 AM', endTime: '10:15 AM', title: '', summary: '' },
          { startTime: '10:40 AM', endTime: '10:45 AM', title: '', summary: '' },
        ],
      }),
    ],
    cats,
    WEEK,
  )
  const c = buildContextCharts(facts, WEEK)
  assert.deepEqual(c.comparison.days[3], { day: 'Thur', distracted: 3, shifts: 2 })
  assert.equal(c.comparison.insight, 'Thur had the most interruptions, with 2 context shifts and 3 distractions.')
  assert.equal(
    buildContextCharts([], WEEK).comparison.insight,
    'No context shift or distraction pattern was detected in this week.',
  )
})

test('activity window and workflow grid', () => {
  assert.deepEqual(weeklyActivityWindow([]), { start: 540, end: 1320 })
  const day = '2026-11-02'
  const facts = buildFacts(
    [card(day, '9:10 AM', '9:40 AM', 'Work'), card(day, '9:40 AM', '9:50 AM', 'Distraction')],
    cats,
    WEEK,
  )
  assert.deepEqual(weeklyActivityWindow(facts), { start: 510, end: 630 })
  const wf = buildWorkflow(facts, WEEK, 'en-US')
  assert.equal(wf.rows.length, 7)
  assert.equal(wf.rows[0].cells.length, 8)
  const c = wf.rows[0].cells
  assert.equal(c[2].categoryName, 'Work') // 9:00–9:15 → 5 min of work
  assert.equal(c[2].minutes, 5)
  assert.equal(c[4].categoryName, 'Work') // 9:30–9:45: 10 work, 5 distraction → Work
  assert.equal(c[4].occupancy, 1)
  assert.equal(wf.rows[1].cells[0].occupancy, 0)
  assert.deepEqual(
    wf.totals.map((t) => [t.name, t.duration]),
    [['Work', '30m'], ['Distraction', '10m']],
  )
  assert.equal(wf.timeLabels[0].label, '9 AM')
})

test('workflow dominant bucket picks the larger overlap', () => {
  const day = '2026-11-02'
  const facts = buildFacts([card(day, '9:30 AM', '9:40 AM', 'Work'), card(day, '9:40 AM', '9:45 AM', 'Distraction')], cats, WEEK)
  const wf = buildWorkflow(facts, WEEK)
  const slot = wf.rows[0].cells.find((x) => x.minutes === 15)!
  assert.equal(slot.categoryName, 'Work')
  assert.equal(slot.occupancy, 1)
})

test('heatmap scoring, run lengths and row order', () => {
  assert.deepEqual(runLengths([true, true, false, true]), [2, 2, 0, 1])
  const s = heatmapScores([5, 5, 5, 0], [0, 0, 0, 5], [0, 0, 0, 0], 5)
  assert.ok(s[0] < 0 && s[1] < 0 && s[2] < 0)
  assert.equal(s[3], 1)
  const day = '2026-11-08' // Sunday → first row
  const facts = buildFacts([card(day, '9:00 AM', '10:00 AM', 'Work'), card(day, '10:00 AM', '10:30 AM', 'Distraction')], cats, WEEK)
  const h = buildHeatmap(facts, WEEK)
  assert.deepEqual(h.rows.map((r) => r.label), ['Sun', 'Mon', 'Tue', 'Wed', 'Thur', 'Fri', 'Sat'])
  assert.equal(h.endMinute - h.startMinute, h.rows[0].values.length * 5)
  const vals = h.rows[0].values
  assert.ok(vals.some((v) => v < -0.5))
  assert.ok(vals.some((v) => v > 0.5))
  assert.ok(h.rows[1].values.every((v) => v === 0))
})

test('treemap groups apps per category with week-over-week change', () => {
  const day = '2026-11-02'
  const facts = buildFacts(
    [
      card(day, '9:00 AM', '11:00 AM', 'Work', { appSites: { primary: 'github.com' } }),
      card(day, '11:00 AM', '11:30 AM', 'Work', { appSites: { primary: 'Slack' } }),
      card(day, '1:00 PM', '1:20 PM', 'Personal', { appSites: { primary: 'Messages' } }),
    ],
    cats,
    WEEK,
  )
  const prevWeek = shiftWeek(WEEK, -1)
  const prev = buildFacts([card('2026-10-26', '9:00 AM', '9:30 AM', 'Work', { appSites: { primary: 'github.com' } })], cats, prevWeek)
  const t = buildTreemap(facts, prev)
  assert.equal(t.categories[0].name, 'Work')
  assert.deepEqual(t.categories[0].apps.map((a) => a.name), ['GitHub', 'Slack'])
  assert.deepEqual(t.categories[0].apps[0].change, { text: '+ 90m', kind: 'positive' })
  assert.equal(t.categories[0].apps[1].change, null)
  assert.equal(treemapDurationText(7200 + 300), '2hr 5m')
  assert.equal(durationText(60), '1h')
})

test('sankey snapshot buckets and model layout', () => {
  const day = '2026-11-02'
  const apps = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com', 'j.com', 'k.com', 'l.com']
  const fmt = (m: number) => {
    const h = Math.floor(m / 60)
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }
  const cards = apps.map((a, i) =>
    card(day, fmt(540 + i * 30), fmt(540 + i * 30 + 25), i % 3 ? 'Work' : 'Personal', { appSites: { primary: a } }),
  )
  const facts = buildFacts(cards, cats, WEEK)
  assert.equal(facts.length, 12)
  const s = buildSankey(facts, WEEK, 'en-US')
  assert.equal(s.id, 'weekly-sankey-2026-11-02')
  assert.equal(s.sourceName, 'Nov 2-Nov 8')
  assert.equal(s.apps.length, 10)
  assert.equal(s.apps[9].id, 'other')
  assert.equal(s.apps[9].minutes, 75)
  const sum = s.links.reduce((x, l) => x + l.minutes, 0)
  assert.equal(sum, 300)
  const m = buildSankeyModel(s)
  assert.equal(m.source.metric, '5hr 0min')
  assert.equal(m.apps[m.apps.length - 1].id, 'other')
  // bands stay within the column
  for (const a of m.apps) assert.ok(a.bar.y >= 54 - 1e-6 && a.bar.y + a.bar.height <= 928 + 1e-6)
  // labels do not overlap
  const ys = [...m.apps].map((a) => a.label.y).sort((x, y) => x - y)
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 56 + 10 - 1e-6)
  assert.equal(m.flows.length, m.categories.length + s.links.length)
  assert.equal(sankeyDuration(45), '45min')
  assert.equal(sankeyPercent(1, 1000), '1%')
  assert.equal(sankeyPercent(0, 0), '0%')
  assert.equal(buildSankey([], WEEK).id, 'empty-weekly-sankey')
})

test('recorded minutes and access progress', () => {
  const s = Math.floor(WEEK.start.getTime() / 1000)
  const cards = [
    card('2026-11-02', '9:00 AM', '10:00 AM', 'Work', { startTs: s + 3600, endTs: s + 7200 }),
    card('2026-11-02', '10:00 AM', '10:30 AM', 'System', { startTs: s + 7200, endTs: s + 9000 }),
    card('2026-10-30', '9:00 AM', '10:00 AM', 'Work', { startTs: s - 3600, endTs: s }),
  ]
  assert.equal(recordedMinutesFor(cards, WEEK), 60)
  assert.equal(accessProgress(0, 0).recordedText, '0h / 30h')
  assert.equal(accessProgress(2, 0).recordedText, '30m / 30h')
  assert.equal(accessProgress(4, 0).recordedText, '1h / 30h')
  assert.equal(accessProgress(5, 0).recordedText, '1h 15m / 30h')
  assert.equal(accessProgress(200, 0).isComplete, true)
  assert.equal(accessProgress(200, 0).progress, 1)
  assert.equal(accessProgress(100, 0).estimatedUnlockAt, 20 * 15 * 60)
})

test('full dashboard and preview fixture build without throwing', () => {
  const d = buildDashboard([card('2026-11-02', '9:00 AM', '5:00 PM', 'Work')], [], cats, WEEK)
  assert.equal(d.donut.totalMinutes, 480)
  const p = buildPreviewDashboard('en-US')
  assert.ok(p.donut.items.length > 0)
  assert.ok(p.treemap.categories.length > 0)
  assert.ok(p.sankeyModel.flows.length > 0)
})
