import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detailLines } from '../src/shared/detailed.ts'
import { detailProjectShares, initialDetailProjects } from '../src/shared/detail-projects.ts'
import type { DetailProjectRef, TimelineCard } from '../src/shared/types.ts'

test('detailed timestamps display in 24-hour form and line assignments determine project shares', () => {
  const card = {
    detailedSummary: '1:00 PM - 1:15 PM: first task\n13:15 - 13:45: second task',
    distractions: [],
    projects: [{ projectId: 'a', name: 'A', color: '#123456', share: 1, source: 'manual', confidence: 1, confirmed: true }],
  } as unknown as TimelineCard
  assert.deepEqual(detailLines(card.detailedSummary).map((l) => [l.start, l.end]), [['13:00', '13:15'], ['13:15', '13:45']])
  const rows = initialDetailProjects(card)
  rows['detail:1'] = [{ projectId: 'b', share: 1, source: 'manual', confidence: 1, confirmed: true }]
  assert.deepEqual(detailProjectShares(card, rows).map((p) => [p.projectId, p.share]), [['a', 0.333], ['b', 0.667]])
})

test('a distraction overrides overlapping detailed time instead of counting it twice', () => {
  const card = { detailedSummary: '9:00 AM - 9:30 AM: focused work', distractions: [{ startTime: '9:10 AM', endTime: '9:15 AM', title: 'Meeting', summary: '' }], projects: [] } as unknown as TimelineCard
  const rows: Record<string, DetailProjectRef[]> = {
    'detail:0': [{ projectId: 'a', share: 1, source: 'manual', confidence: 1, confirmed: true }],
    'distraction:0': [{ projectId: 'b', share: 1, source: 'manual', confidence: 1, confirmed: true }],
  }
  assert.deepEqual(detailProjectShares(card, rows).map((p) => [p.projectId, p.share]), [['a', 0.833], ['b', 0.167]])
})

test('an unparseable distraction does not shift the overlap check of later ones', () => {
  const card = {
    detailedSummary: '',
    distractions: [{ startTime: '', endTime: '', title: 'Unknown', summary: '' }, { startTime: '9:10 AM', endTime: '9:15 AM', title: 'Chat', summary: '' }],
    projects: [],
  } as unknown as TimelineCard
  const rows: Record<string, DetailProjectRef[]> = {
    'distraction:0': [{ projectId: 'a', share: 1, source: 'manual', confidence: 1, confirmed: true }],
    'distraction:1': [{ projectId: 'b', share: 1, source: 'manual', confidence: 1, confirmed: true }],
  }
  assert.deepEqual(detailProjectShares(card, rows).map((p) => [p.projectId, p.share]), [['a', 0.167], ['b', 0.833]])
})

test('blank lines with carriage returns or tabs do not get a line key', () => {
  assert.deepEqual(detailLines('A\r\n\t\r\nB').map((l) => l.text.trim()), ['A', 'B'])
})
