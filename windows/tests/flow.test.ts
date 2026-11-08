import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  goalIndex,
  handleVerdict,
  initialNudgeState,
  jsonObjects,
  looksLikeScreenShare,
  nudgeDue,
  parseVerdict,
  type NudgeState,
} from '../src/main/flow/nudge.ts'
import {
  breakSnapshot,
  deadlineDelayMs,
  extendSnapshot,
  handleDeadline,
  nearestDeadline,
  restoreSnapshot,
  startSnapshot,
  transitionEffects,
} from '../src/main/flow/session.ts'
import { buildBriefing, buildTickMessage, categoriesBlock, formatMinutes, goalsUpdatedNote } from '../src/main/flow/prompts.ts'
import { buildEntries, clockNear, FlowSessionTimeline, overlayBreaks, tidyTitle, timelineFromObjects } from '../src/main/flow/timeline.ts'
import { normalizeFlowSettings } from '../src/main/flow/settings.ts'
import type { FlowNativeSnapshot } from '../src/shared/flow-types.ts'

const T0 = Math.floor(new Date(2026, 10, 8, 10, 0, 0).getTime() / 1000)
const at = (h: number, m: number) => Math.floor(new Date(2026, 10, 8, h, m, 0).getTime() / 1000)
const goals = [
  { id: 'a', title: 'Write the report' },
  { id: 'b', title: 'Answer email' },
]
const ctx = (now: number, style: 'quiet' | 'friendly' | 'feisty' = 'friendly') => ({
  style,
  tickSeconds: 15,
  goalTasks: goals,
  screenShared: false,
  now,
})
const off = { status: 'off_task', action: 'none' }
const on = { status: 'on_task', action: 'none' }

// ---- Nudge timing ----

test('friendly: nudge due after 60 s of drift, then 240/300/600 s spacing', () => {
  let s: NudgeState = initialNudgeState()
  s = handleVerdict(s, off, ctx(T0)).state
  assert.equal(s.offTaskSince, T0)
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 59), false)
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 60), true)
  const r = handleVerdict(s, { status: 'off_task', action: 'nudge', message: 'Back to the report?' }, ctx(T0 + 60))
  assert.equal(r.nudge, 'sent')
  assert.equal(r.nudgeMessage, 'Back to the report?')
  s = r.state
  assert.equal(s.unansweredNudges, 1)
  // Second nudge needs 300 s since the last one (unanswered = 1).
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 60 + 299), false)
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 60 + 300), true)
  s = handleVerdict(s, { status: 'off_task', action: 'nudge' }, ctx(T0 + 360)).state
  assert.equal(s.unansweredNudges, 2)
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 360 + 599), false)
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 360 + 600), true)
  // Capped at the last wait.
  s = { ...s, unansweredNudges: 7 }
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 360 + 600), true)
})

test('feisty: due after one tick of drift, every 120 s; quiet: never', () => {
  let s = handleVerdict(initialNudgeState(), off, ctx(T0, 'feisty')).state
  assert.equal(nudgeDue(s, 'feisty', 15, T0 + 14), false)
  assert.equal(nudgeDue(s, 'feisty', 15, T0 + 15), true)
  s = handleVerdict(s, { status: 'off_task', action: 'nudge' }, ctx(T0 + 15, 'feisty')).state
  assert.equal(nudgeDue(s, 'feisty', 15, T0 + 15 + 119), false)
  assert.equal(nudgeDue(s, 'feisty', 15, T0 + 15 + 120), true)
  assert.equal(nudgeDue(s, 'quiet', 15, T0 + 10_000), false)
  const q = handleVerdict(s, { status: 'off_task', action: 'nudge' }, ctx(T0 + 10_000, 'quiet'))
  assert.equal(q.nudge, 'heldNotDue')
})

test('a drift only ends after a full minute back on task', () => {
  let s = handleVerdict(initialNudgeState(), off, ctx(T0)).state
  s = handleVerdict(s, on, ctx(T0 + 15)).state
  assert.equal(s.backOnTaskSince, T0 + 15)
  assert.equal(s.offTaskSince, T0)
  assert.equal(nudgeDue(s, 'friendly', 15, T0 + 100), false, 'not due while back on task')
  s = handleVerdict(s, on, ctx(T0 + 60)).state
  assert.equal(s.offTaskSince, T0, 'still open at 45 s')
  // Off task again: the back-on-task clock resets, the drift keeps its start.
  s = handleVerdict(s, off, ctx(T0 + 70)).state
  assert.equal(s.backOnTaskSince, null)
  assert.equal(s.offTaskSince, T0)
  s = handleVerdict(s, on, ctx(T0 + 80)).state
  s = handleVerdict(s, on, ctx(T0 + 140)).state
  assert.equal(s.offTaskSince, null)
  assert.equal(s.focusedSince, T0 + 80)
})

test('three minutes focused after a nudge resets unanswered nudges', () => {
  let s: NudgeState = { ...initialNudgeState(), unansweredNudges: 2, focusedSince: T0 }
  s = handleVerdict(s, on, ctx(T0 + 179)).state
  assert.equal(s.unansweredNudges, 2)
  s = handleVerdict(s, on, ctx(T0 + 180)).state
  assert.equal(s.unansweredNudges, 0)
})

test('nudges are held when not due, not off task, or the screen is shared', () => {
  let s = handleVerdict(initialNudgeState(), off, ctx(T0)).state
  assert.equal(handleVerdict(s, { status: 'off_task', action: 'nudge' }, ctx(T0 + 30)).nudge, 'heldNotDue')
  assert.equal(handleVerdict(s, { status: 'on_task', action: 'nudge' }, ctx(T0 + 90)).nudge, 'heldNotDue')
  assert.equal(handleVerdict(s, { status: 'off_task', action: 'nudge' }, { ...ctx(T0 + 90), screenShared: true }).nudge, 'heldScreenShare')
  const r = handleVerdict(s, { status: 'distracted', action: 'none' }, ctx(T0 + 90))
  assert.equal(r.nudge, 'dueNotWritten')
  s = r.state
  const sent = handleVerdict(s, { status: 'off_task', action: 'nudge' }, ctx(T0 + 95))
  assert.equal(sent.nudgeMessage, "Psst... I think you're getting distracted!")
})

test('focus changes are reported once per flip', () => {
  let r = handleVerdict(initialNudgeState(), off, ctx(T0))
  assert.equal(r.focusChange, true)
  r = handleVerdict(r.state, off, ctx(T0 + 15))
  assert.equal(r.focusChange, null)
  r = handleVerdict(r.state, on, ctx(T0 + 30))
  assert.equal(r.focusChange, false)
})

test('completed goals resolve short ids once', () => {
  assert.equal(goalIndex('g2'), 2)
  assert.equal(goalIndex('[G1] '), 1)
  assert.equal(goalIndex('x'), null)
  let r = handleVerdict(initialNudgeState(), { ...on, completed_goals: ['g2', '[g2]', 'g9', 'nope'] }, ctx(T0))
  assert.deepEqual(r.completed.map((t) => t.id), ['b'])
  r = handleVerdict(r.state, { ...on, completed_goals: ['g2'] }, ctx(T0 + 15))
  assert.deepEqual(r.completed, [])
})

test('jsonObjects scans top-level objects and skips braces in strings', () => {
  const reply = 'Sure!\n```json\n{"status":"on_task","seeing":"Editor {draft}"}\n```\n{"timeline":[{"start":"10:00","end":"10:05","kind":"focused","title":"A \\"}\\" b"}]}'
  const objs = jsonObjects(reply)
  assert.equal(objs.length, 2)
  assert.equal(parseVerdict(objs)?.seeing, 'Editor {draft}')
  const tl = timelineFromObjects(objs.slice(1))
  assert.equal(tl?.length, 1)
  assert.equal(parseVerdict(['not json']), null)
  assert.equal(parseVerdict([]), null)
})

test('screen share markers', () => {
  assert.equal(looksLikeScreenShare([{ process: 'Zoom', title: 'Zoom Sharing Toolbar' }]), true)
  assert.equal(looksLikeScreenShare([{ process: 'chrome', title: 'meet.google.com is sharing your screen.' }]), true)
  assert.equal(looksLikeScreenShare([{ process: 'chrome', title: 'Sharing toolbar tips' }]), false)
})

// ---- Session state machine ----

const active: FlowNativeSnapshot = { phase: 'active', alertStyle: 'friendly', alwaysOn: false, sessionStartedAt: T0, sessionEndsAt: T0 + 1500 }
const types = (fx: { type: string }[]) => fx.map((f) => f.type)

test('phase transitions produce the mirror effects', () => {
  const idle: FlowNativeSnapshot = { phase: 'idle', alertStyle: 'friendly', alwaysOn: false }
  assert.deepEqual(types(transitionEffects(idle, active)), ['resetDistraction', 'toast', 'agentStart'])
  const brk = { ...active, phase: 'break' as const, breakEndsAt: T0 + 300 }
  assert.deepEqual(types(transitionEffects(active, brk)), ['showBreak', 'agentPause'])
  assert.deepEqual(types(transitionEffects(brk, active)), ['cancelBreakOverlay', 'toast', 'agentResume', 'agentGoalsChanged'])
  assert.deepEqual(types(transitionEffects(active, active)), ['agentGoalsChanged'])
  assert.deepEqual(types(transitionEffects(active, { ...active, phase: 'ended' })), ['resetDistraction', 'timelineFinish', 'agentStop'])
  assert.deepEqual(types(transitionEffects(brk, idle)), ['resetDistraction', 'timelineFinish', 'agentStop', 'hideOverlay'])
  assert.deepEqual(types(transitionEffects({ ...active, phase: 'ended' }, idle)), ['resetDistraction', 'hideOverlay'])
})

test('deadlines: nearest of session end, break end and snooze', () => {
  assert.equal(nearestDeadline(active, null), T0 + 1500)
  assert.equal(nearestDeadline(active, T0 + 600), T0 + 600)
  assert.equal(nearestDeadline({ ...active, phase: 'break', breakEndsAt: T0 + 300 }, null), T0 + 300)
  assert.equal(nearestDeadline({ ...active, alwaysOn: true, sessionEndsAt: undefined }, null), null)
  assert.equal(deadlineDelayMs(T0, T0 * 1000 + 5000), 500)
  assert.equal(deadlineDelayMs(T0 + 10, T0 * 1000), 10_000)
})

test('handleDeadline: snooze expiry nudges again while distracted, session and break end', () => {
  const r1 = handleDeadline({ snapshot: active, snoozeUntil: T0 + 60, isDistracted: true, nudgeStreak: 1, now: T0 + 60 })
  assert.equal(r1.snoozeUntil, null)
  assert.equal(r1.nudgeStreak, 2)
  assert.deepEqual(r1.effects, [{ type: 'nudge', message: 'Snooze is up — ready to get back to it?', escalated: true }])
  const quiet = handleDeadline({ snapshot: { ...active, alertStyle: 'quiet' }, snoozeUntil: T0, isDistracted: true, nudgeStreak: 0, now: T0 + 1 })
  assert.deepEqual(quiet.effects, [])
  const end = handleDeadline({ snapshot: active, snoozeUntil: null, isDistracted: false, nudgeStreak: 0, now: T0 + 1500 })
  assert.equal(end.snapshot.phase, 'ended')
  const brk = handleDeadline({
    snapshot: { ...active, phase: 'break', breakEndsAt: T0 + 300 },
    snoozeUntil: null,
    isDistracted: false,
    nudgeStreak: 0,
    now: T0 + 300,
  })
  assert.equal(brk.snapshot.phase, 'active')
  assert.equal(brk.snapshot.breakEndsAt, undefined)
  const none = handleDeadline({ snapshot: active, snoozeUntil: null, isDistracted: false, nudgeStreak: 0, now: T0 + 10 })
  assert.equal(none.snapshot, active)
})

test('start, extend, break and restore snapshots', () => {
  const s = startSnapshot({ goals: [' Write ', '', 'Email'], minutes: 25, alertStyle: 'feisty' }, T0)
  assert.equal(s.phase, 'active')
  assert.equal(s.sessionEndsAt, T0 + 1500)
  assert.deepEqual(s.goals, ['Write', 'Email'])
  assert.equal(s.goalTasks?.length, 2)
  const open = startSnapshot({ goals: [], minutes: null, alertStyle: 'quiet' }, T0)
  assert.equal(open.alwaysOn, true)
  assert.equal(open.sessionEndsAt, undefined)
  assert.equal(extendSnapshot(s, 10, T0 + 60).sessionEndsAt, T0 + 1500 + 600)
  assert.equal(extendSnapshot(open, 10, T0), open)
  const ended = extendSnapshot({ ...s, phase: 'ended' }, 5, T0 + 2000)
  assert.equal(ended.phase, 'active')
  assert.equal(ended.sessionEndsAt, T0 + 2300)
  assert.equal(breakSnapshot(s, 5, T0 + 10).breakEndsAt, T0 + 310)
  assert.equal(restoreSnapshot(s, T0 + 1500).phase, 'idle')
  assert.equal(restoreSnapshot(s, T0 + 100).phase, 'active')
  assert.equal(restoreSnapshot(open, T0 + 99_999).phase, 'active')
  assert.equal(restoreSnapshot(null, T0).phase, 'idle')
})

// ---- Prompts ----

test('briefing fills every placeholder', () => {
  const b = buildBriefing({
    tickSeconds: 15,
    startedAt: at(9, 5),
    endsAt: at(9, 55),
    style: 'friendly',
    goalTasks: goals,
    categories: [{ name: 'Work', details: 'Coding\nand docs' }, { name: 'Distraction' }],
    extra: 'Be kind.',
  })
  assert.ok(!/\$\{\w+\}/.test(b), 'no unfilled placeholders')
  assert.ok(b.startsWith('You are the focus companion inside Dayflow, a Windows time-tracking app.'))
  assert.ok(b.includes('Roughly every 15 seconds'))
  assert.ok(b.includes('- Started at 9:05 AM.'))
  assert.ok(b.includes('- Planned length: 50 minutes (ends around 9:55 AM).'))
  assert.ok(b.includes('- [g1] Write the report\n- [g2] Answer email'))
  assert.ok(b.includes('    · Work: Coding and docs\n    · Distraction'))
  assert.ok(b.includes('reply with the verdict object first and then a second JSON object'))
  assert.ok(b.endsWith('\n\nADDITIONAL INSTRUCTIONS\nBe kind.'))
  const open = buildBriefing({ tickSeconds: 15, startedAt: at(9, 5), endsAt: null, style: 'quiet', goalTasks: [], categories: [] })
  assert.ok(open.includes('Open-ended: no timer'))
  assert.ok(open.includes("The user didn't list specific goals."))
  assert.ok(open.includes('Quiet. The user asked for zero interruptions.'))
  assert.equal(categoriesBlock([]), '    (none set up: leave category out)')
})

test('tick message lines', () => {
  assert.equal(formatMinutes(75), '1h 15m')
  assert.equal(formatMinutes(-3), '0m')
  const m = buildTickMessage({ now: at(10, 20), startedAt: at(10, 0), endsAt: at(10, 50), nudgeDueDriftMinutes: 0.4, notes: ['NOTE'], timeline: null })
  assert.equal(
    m,
    'Current time: 10:20 AM. Time remaining: 30m. NUDGE DUE: they have been off task for about 1m. If this screenshot is still off task, set action to "nudge" and write the message.\nNOTE',
  )
  const o = buildTickMessage({
    now: at(11, 30),
    startedAt: at(10, 0),
    endsAt: null,
    nudgeDueDriftMinutes: null,
    notes: [],
    timeline: { timelineJSON: '[]', observations: '(no checks since the last update)', breaks: '(none)' },
  })
  assert.ok(o.startsWith('Current time: 11:30 AM. Elapsed: 1h 30m (open-ended session).\nTIMELINE UPDATE — revise the session timeline so it covers the whole session (started 10:00) up to now'))
  assert.ok(o.endsWith('Breaks (exact, from the app): (none)'))
  assert.equal(
    goalsUpdatedNote([goals[1]], [goals[0]], []),
    'GOALS UPDATED. Open goals are now:\n- [g1] Answer email\nNo longer open (done or removed): Write the report',
  )
})

test('settings validation falls back to defaults', () => {
  const s = normalizeFlowSettings({ flowAgentTickSeconds: 2, flowAgentShotHeight: 100, flowAgentReasoning: 'max', flowAgentTimelineSeconds: 30 })
  assert.equal(s.flowAgentTickSeconds, 15)
  assert.equal(s.flowAgentShotHeight, 1080)
  assert.equal(s.flowAgentReasoning, 'low')
  assert.equal(s.flowAgentTimelineSeconds, 30)
})

// ---- Session timeline ----

let n = 0
const id = () => `e${++n}`
const cats = ['Work', 'Personal', 'Distraction']

test('timeline: clock parsing near the session', () => {
  assert.equal(clockNear('10:15', T0, T0), at(10, 15))
  assert.equal(clockNear('2:30 pm', T0, T0), at(14, 30))
  assert.equal(clockNear('12:10 am', at(23, 50), at(23, 55)), at(23, 50) + 20 * 60)
  assert.equal(clockNear('25:00', T0, T0), null)
  assert.equal(clockNear('soon', T0, T0), null)
  assert.equal(tidyTitle('  writing the report...'), 'Writing the report')
  assert.equal(tidyTitle('x'.repeat(70)).length, 58)
})

test('timeline: clamps, makes contiguous, folds blips and merges distractions', () => {
  const items = [
    { start: '09:50', end: '10:20', kind: 'focused', title: 'report draft', category: 'work', site: 'docs.google.com' },
    { start: '10:20', end: '10:21', kind: 'off_task', title: 'Glance at X', category: 'nope' },
    { start: '10:21', end: '10:40', kind: 'focused', title: 'Report charts', category: 'Work' },
    { start: '10:40', end: '10:50', kind: 'distracted', title: 'YouTube', site: 'youtube.com' },
    { start: '10:50', end: '11:20', kind: 'distracted', title: 'X feed', site: 'x.com' },
    { start: '11:20', end: '11:40', kind: 'focused', title: 'Email', completed: ['Answer email', ''] },
  ]
  const list = buildEntries(items, T0, at(11, 30), cats, [], id)!
  assert.equal(list.length, 3)
  // Blip folded; the longer neighbour (30 vs 19 min → before) keeps its title.
  assert.equal(list[0].title, 'Report draft')
  assert.equal(list[0].startedAt, T0, 'clamped to the session start')
  assert.equal(list[0].endedAt, at(10, 40))
  assert.equal(list[0].category, 'Work')
  assert.equal(list[1].kind, 'distracted')
  assert.equal(list[1].title, 'X feed', 'longer distraction wins')
  assert.equal(list[1].category, 'Distraction', 'distracted falls back to a distract* category')
  assert.equal(list[1].startedAt, at(10, 40))
  assert.equal(list[2].endedAt, at(11, 30), 'clamped to now')
  assert.deepEqual(list[2].completedTasks, ['Answer email'])
  assert.equal(buildEntries([{ title: 'x' }], T0, at(11, 0), cats, [], id), null)
})

test('timeline: exact breaks are cut in', () => {
  const entries = [{ id: 'a', title: 'Work', kind: 'focused' as const, startedAt: at(10, 0), endedAt: at(11, 0) }]
  const out = overlayBreaks(entries, [{ start: at(10, 20), end: at(10, 30) }, { start: at(10, 50) }], at(10, 55), id)
  assert.deepEqual(
    out.map((e) => [e.kind, e.startedAt, e.endedAt]),
    [
      ['focused', at(10, 0), at(10, 20)],
      ['break', at(10, 20), at(10, 30)],
      ['focused', at(10, 30), at(10, 50)],
      ['break', at(10, 50), at(10, 55)],
      ['focused', at(10, 55), at(11, 0)],
    ],
  )
})

test('timeline file: begin reuses the same session, wantsUpdate, prompt formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-flow-'))
  try {
    const file = join(dir, 'flow-session-timeline.json')
    const t = new FlowSessionTimeline(file, () => cats)
    t.begin(T0)
    assert.equal(t.wantsUpdate(60, T0 + 59), false)
    assert.equal(t.wantsUpdate(60, T0 + 60), true)
    assert.equal(t.wantsUpdate(300, T0 + 60), true, 'first update after min(interval, 60)')
    t.observe(true, 'chrome', 'YouTube', at(10, 5))
    t.beginBreak(at(10, 10))
    t.endBreak(at(10, 15))
    assert.equal(t.apply([{ start: '10:00', end: '10:20', kind: 'focused', title: 'Report', category: 'Work' }], at(10, 20)), true)
    assert.equal(t.wantsUpdate(60, at(10, 20) + 59), false)
    assert.equal(
      t.promptTimelineJSON(),
      '[\n{"start":"10:00","end":"10:10","kind":"focused","title":"Report","category":"Work"},\n{"start":"10:10","end":"10:15","kind":"break","title":"Break"},\n{"start":"10:15","end":"10:20","kind":"focused","title":"Report","category":"Work"}\n]',
    )
    assert.equal(t.promptObservations(null), '10:05 off_task · chrome · YouTube')
    assert.equal(t.promptObservations(at(10, 6)), '(no checks since the last update)')
    assert.equal(t.promptBreaks(), '10:10–10:15')
    const again = new FlowSessionTimeline(file, () => cats)
    again.begin(T0 + 3)
    assert.equal(again.entries.length, 3)
    assert.equal(again.observations.length, 1)
    const other = new FlowSessionTimeline(file, () => cats)
    other.begin(T0 + 600)
    assert.equal(other.entries.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: category copied with its description still matches', () => {
  const list = buildEntries([{ start: '10:00', end: '10:10', kind: 'focused', title: 'A', category: 'Work: Reports, code' }], T0, at(10, 10), cats, [], id)!
  assert.equal(list[0].category, 'Work')
})

// ---- Agent (fake provider / capture) ----

import { FlowDistractionAgent, withTimeout, type AgentDeps } from '../src/main/flow/agent.ts'
import { upsertSummary } from '../src/main/flow/session.ts'
import type { FlowAgentSettings, FlowSessionSummary } from '../src/shared/flow-types.ts'

interface FakeCall {
  prompt: string
  signal?: AbortSignal
}

function makeAgent(opts: {
  reply?: (call: FakeCall) => Promise<string>
  capture?: () => Promise<void>
  settings?: Partial<FlowAgentSettings>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'dayflow-flow-agent-'))
  const calls: FakeCall[] = []
  const completed: string[][] = []
  let changes = 0
  let settings: FlowAgentSettings = { ...normalizeFlowSettings({}), ...opts.settings }
  const provider = {
    id: 'fake',
    model: null,
    generateWithImages: (prompt: string, _frames: unknown[], _op: string, signal?: AbortSignal) => {
      const call = { prompt, signal }
      calls.push(call)
      return opts.reply ? opts.reply(call) : Promise.resolve('{"status":"on_task","action":"none"}')
    },
    generateText: () => Promise.reject(new Error('unused')),
  }
  const deps: AgentDeps = {
    settings: () => settings,
    makeProvider: () => ({ provider, label: 'Fake' }),
    categories: () => [],
    timeline: new FlowSessionTimeline(join(dir, 'timeline.json'), () => []),
    captureShot: async () => {
      await opts.capture?.()
      return { path: join(dir, 'shot.jpg'), label: null, appName: null, temporary: false }
    },
    isCaptureBlocked: () => false,
    isScreenShared: () => false,
    onFocusChange: () => {},
    onNudge: () => {},
    onCompletedGoals: (t) => completed.push(t.map((x) => x.id)),
    onChange: () => changes++,
  }
  const agent = new FlowDistractionAgent(deps)
  const tick = () => (agent as unknown as { runTick(): Promise<void> }).runTick()
  const cleanup = () => {
    agent.stop()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    agent, calls, completed, tick, cleanup,
    changes: () => changes,
    setSettings: (p: Partial<FlowAgentSettings>) => (settings = { ...settings, ...p }),
  }
}

const snap = (tasks = goals): FlowNativeSnapshot => ({
  phase: 'active', alertStyle: 'friendly', alwaysOn: true, sessionStartedAt: Math.floor(Date.now() / 1000),
  goalTasks: tasks, goals: tasks.map((t) => t.title),
})

test('agent: goal changes rebuild the briefing so gN resolves against the new list', async () => {
  const f = makeAgent({ reply: async () => '{"status":"on_task","action":"none","completed_goals":["g1"]}' })
  try {
    f.agent.start(snap())
    f.agent.goalsChanged(snap([goals[1]]))
    await f.tick()
    const prompt = f.calls[0].prompt
    assert.match(prompt, /\[g1\] Answer email/)
    assert.doesNotMatch(prompt, /\[g2\] Answer email/)
    assert.doesNotMatch(prompt, /\[g1\] Write the report/)
    assert.deepEqual(f.completed, [['b']], 'g1 is the remaining goal, not the removed one')
  } finally {
    f.cleanup()
  }
})

test('agent: notes are requeued at the front after a failed turn or capture', async () => {
  let fail = true
  let captureFails = false
  const f = makeAgent({
    reply: async () => {
      if (fail) throw new Error('boom')
      return '{"status":"on_task","action":"none"}'
    },
    capture: async () => {
      if (captureFails) throw new Error('no screen')
    },
    settings: { flowAgentMaxFailures: 10 },
  })
  try {
    f.agent.start(snap())
    f.agent.noteUserEvent('NOTE-ONE')
    await f.tick()
    assert.match(f.calls[0].prompt, /NOTE-ONE/)
    f.agent.noteUserEvent('NOTE-TWO')
    fail = false
    await f.tick()
    const p = f.calls[1].prompt
    assert.ok(p.includes('NOTE-ONE') && p.indexOf('NOTE-ONE') < p.indexOf('NOTE-TWO'), 'requeued note comes first')
    f.agent.noteUserEvent('NOTE-THREE')
    captureFails = true
    await f.tick()
    assert.equal(f.calls.length, 2, 'no model call when capture fails')
    assert.ok((f.agent as unknown as { pendingNotes: string[] }).pendingNotes.includes('NOTE-THREE'))
  } finally {
    f.cleanup()
  }
})

test('agent: stopping after max failures broadcasts the new status', async () => {
  const f = makeAgent({ reply: async () => Promise.reject(new Error('down')), settings: { flowAgentMaxFailures: 2 } })
  try {
    f.agent.start(snap())
    await f.tick()
    const before = f.changes()
    await f.tick()
    assert.equal(f.agent.isRunning, false)
    assert.equal(f.agent.status, 'Stopped after 2 failures')
    assert.ok(f.changes() > before)
  } finally {
    f.cleanup()
  }
})

test('agent: timeout and stop() abort the in-flight call', async () => {
  const hang = (call: FakeCall) =>
    new Promise<string>((_, reject) => call.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  const f = makeAgent({ reply: hang, settings: { flowAgentTickTimeout: 0.05, flowAgentMaxFailures: 10 } })
  try {
    f.agent.start(snap())
    await f.tick()
    assert.equal(f.calls[0].signal?.aborted, true, 'timeout aborts')
    f.setSettings({ flowAgentTickTimeout: 60 })
    const t = f.tick()
    await new Promise((r) => setImmediate(r))
    f.agent.stop()
    assert.equal(f.calls[1].signal?.aborted, true, 'stop aborts')
    await t
  } finally {
    f.cleanup()
  }
})

test('agent: a tick does nothing once the agent is disabled', async () => {
  const f = makeAgent({})
  try {
    f.agent.start(snap())
    f.setSettings({ flowAgentEnabled: false })
    await f.tick()
    assert.equal(f.calls.length, 0)
  } finally {
    f.cleanup()
  }
})

test('withTimeout aborts its controller', async () => {
  const ac = new AbortController()
  await assert.rejects(withTimeout(new Promise(() => {}), 10, ac), /no reply/)
  assert.equal(ac.signal.aborted, true)
})

test('session summaries: re-ending an extended session replaces its summary', () => {
  const mk = (id: string, startedAt: number, endedAt: number) => ({ id, startedAt, endedAt }) as FlowSessionSummary
  const list = [mk('old', 100, 200)]
  const once = upsertSummary(list, mk('s1', 300, 400))
  assert.deepEqual(once.map((s) => s.id), ['s1', 'old'])
  const again = upsertSummary(once, mk('s2', 300, 900))
  assert.deepEqual(again.map((s) => [s.id, s.endedAt]), [['s1', 900], ['old', 200]])
})
