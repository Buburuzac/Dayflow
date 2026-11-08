import { describe, expect, it } from 'vitest'
import { categoryColor, DEFAULT_CATEGORIES, normalizeCategories } from '../src/lib/categories.ts'
import { dayStartMs, daysInRange, logicalDay, minuteOfDay, rangeFor, rangeLabel, rangeLength, shiftRange, toMs, weekStart } from '../src/lib/dates.ts'
import { fmtMinutes, parseHours, roundQuarter, stepHours } from '../src/lib/format.ts'
import { groupByDevice, hourWindow, layoutLane } from '../src/lib/lanes.ts'
import { buildSubmit, toRows } from '../src/lib/timesheets.ts'
import type { TimesheetProposal } from '../src/api/types.ts'

describe('dates', () => {
  it('uses a 4 AM day boundary', () => {
    expect(logicalDay(new Date(2026, 10, 8, 3, 59))).toBe('2026-11-07')
    expect(logicalDay(new Date(2026, 10, 8, 4, 0))).toBe('2026-11-08')
    expect(minuteOfDay(dayStartMs('2026-11-08') / 1000 + 90 * 60, '2026-11-08')).toBe(90)
  })
  it('accepts seconds or milliseconds', () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
  it('builds week ranges from Monday', () => {
    expect(weekStart('2026-11-08')).toBe('2026-11-02') // Sunday → previous Monday
    expect(weekStart('2026-11-02')).toBe('2026-11-02')
    expect(rangeFor('week', '2026-11-05')).toEqual({ from: '2026-11-02', to: '2026-11-08' })
  })
  it('builds month ranges and steps them', () => {
    expect(rangeFor('month', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(rangeFor('month', '2028-02-14').to).toBe('2028-02-29')
    expect(shiftRange('month', rangeFor('month', '2026-12-10'), 1)).toEqual({ from: '2027-01-01', to: '2027-01-31' })
    expect(shiftRange('month', rangeFor('month', '2026-03-31'), -1)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
  it('steps day, week and custom ranges by their length', () => {
    expect(shiftRange('day', rangeFor('day', '2026-03-01'), -1)).toEqual({ from: '2026-02-28', to: '2026-02-28' })
    expect(shiftRange('week', rangeFor('week', '2026-12-30'), 1)).toEqual({ from: '2027-01-04', to: '2027-01-10' })
    expect(shiftRange('custom', { from: '2026-11-01', to: '2026-11-10' }, 1)).toEqual({ from: '2026-11-11', to: '2026-11-20' })
  })
  it('normalises reversed custom ranges', () => {
    expect(rangeFor('custom', '2026-01-01', { from: '2026-01-09', to: '2026-01-03' })).toEqual({ from: '2026-01-03', to: '2026-01-09' })
  })
  it('lists days across DST changes', () => {
    const days = daysInRange('2026-10-24', '2026-10-27') // EU DST ends 25 Oct 2026
    expect(days).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
    expect(rangeLength({ from: '2026-03-28', to: '2026-03-30' })).toBe(3)
    expect(daysInRange('2026-01-02', '2026-01-01')).toEqual([])
  })
  it('labels ranges', () => {
    expect(rangeLabel('day', { from: '2026-11-08', to: '2026-11-08' }, '2026-11-08')).toBe('Today')
    expect(rangeLabel('week', { from: '2026-11-02', to: '2026-11-08' }, '2026-11-08')).toBe('2 – 8 Nov 2026')
    expect(rangeLabel('month', { from: '2026-11-01', to: '2026-11-30' })).toBe('November 2026')
  })
})

describe('rounding', () => {
  it('rounds to quarter hours', () => {
    expect(roundQuarter(1.12)).toBe(1)
    expect(roundQuarter(1.13)).toBe(1.25)
    expect(roundQuarter(0.124)).toBe(0)
    expect(roundQuarter(-2)).toBe(0)
    expect(roundQuarter(Number.NaN)).toBe(0)
  })
  it('steps by 0.25 within 0..24', () => {
    expect(stepHours(1, 1)).toBe(1.25)
    expect(stepHours(0, -1)).toBe(0)
    expect(stepHours(24, 1)).toBe(24)
    expect(stepHours(1.1, 1)).toBe(1.25)
  })
  it('parses hour input', () => {
    expect(parseHours('1,5')).toBe(1.5)
    expect(parseHours('1:20')).toBe(1.25)
    expect(parseHours('90m')).toBe(1.5)
    expect(parseHours('2h')).toBe(2)
    expect(parseHours('.75')).toBe(0.75)
    expect(parseHours('')).toBe(0)
    expect(parseHours('30')).toBe(24)
    expect(parseHours('abc')).toBeNull()
  })
  it('formats minutes', () => {
    expect(fmtMinutes(40)).toBe('40m')
    expect(fmtMinutes(120)).toBe('2h')
    expect(fmtMinutes(135)).toBe('2h 15m')
  })
})

describe('lane layout', () => {
  it('keeps non-overlapping cards in one column', () => {
    const out = layoutLane([
      { id: 'a', start: 0, end: 30 },
      { id: 'b', start: 30, end: 60 },
    ])
    expect(out.map((p) => [p.item.id, p.col, p.cols])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
    ])
  })
  it('splits overlapping cards and shares the column count per cluster', () => {
    const out = layoutLane([
      { id: 'a', start: 0, end: 60 },
      { id: 'b', start: 10, end: 30 },
      { id: 'c', start: 35, end: 50 },
      { id: 'd', start: 100, end: 120 },
    ])
    const m = Object.fromEntries(out.map((p) => [p.item.id, [p.col, p.cols]]))
    expect(m.a).toEqual([0, 2])
    expect(m.b).toEqual([1, 2])
    expect(m.c).toEqual([1, 2]) // reuses the freed column
    expect(m.d).toEqual([0, 1]) // new cluster
  })
  it('groups by device in device order, unknown devices last', () => {
    const lanes = groupByDevice(
      [
        { id: '1', deviceId: 'x' },
        { id: '2', deviceId: 'b' },
        { id: '3', deviceId: 'a' },
      ],
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ],
    )
    expect(lanes.map((l) => l.device.name)).toEqual(['A', 'B', 'Other device 1'])
  })
  it('computes a padded hour window', () => {
    expect(hourWindow([])).toEqual([4, 14])
    expect(hourWindow([{ start: 245, end: 760 }])).toEqual([4, 13]) // 08:05..16:40 → 9 h ≥ min span
    expect(hourWindow([{ start: 300, end: 360 }], 8)).toEqual([2, 10])
    expect(hourWindow([{ start: 10, end: 1430 }], 8)).toEqual([0, 24])
  })
})

describe('categories', () => {
  it('falls back to the default colours', () => {
    expect(normalizeCategories(null)).toBe(DEFAULT_CATEGORIES)
    expect(normalizeCategories({ payload: { categories: [{ name: 'Deep work', color: '#123456' }] } })).toEqual([{ name: 'Deep work', color: '#123456' }])
    expect(categoryColor('work', DEFAULT_CATEGORIES)).toBe('#B984FF')
    expect(categoryColor('Unknown', DEFAULT_CATEGORIES)).toMatch(/^#/)
  })
})

describe('timesheets', () => {
  const base: TimesheetProposal = {
    userId: 'u',
    day: '2026-11-02',
    projectId: 'p1',
    odooProjectId: 42,
    odooTaskId: null,
    hours: 1.5,
    description: 'Work',
    cardIds: ['c1'],
    existingOdooLineId: null,
  }
  it('pre-selects only new mapped lines and builds the payload', () => {
    const rows = toRows([
      base,
      { ...base, projectId: 'p2', odooProjectId: null },
      { ...base, day: '2026-11-03', existingOdooLineId: 77 },
    ])
    expect(rows.map((r) => r.selected)).toEqual([true, false, false])
    rows[0].hours = 1.6
    rows[0].description = '  Edited  '
    expect(buildSubmit(rows)).toEqual({ lines: [{ day: '2026-11-02', projectId: 'p1', hours: 1.5, description: 'Edited', cardIds: ['c1'] }] })
  })
})
