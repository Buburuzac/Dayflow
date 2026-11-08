import { useState } from 'react'
import { logicalDay, rangeFor, rangeLabel, shiftRange, type DateRange, type RangeMode } from '../lib/dates.ts'
import { Tabs } from './ui.tsx'

export interface RangeValue {
  mode: RangeMode
  range: DateRange
}

export function initialRange(mode: RangeMode = 'week'): RangeValue {
  return { mode, range: rangeFor(mode, logicalDay()) }
}

const MODES: { id: RangeMode; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'custom', label: 'Custom' },
]

/** Day / week / month / custom range picker with prev/next stepping. */
export function RangePicker({ value, onChange, modes = MODES.map((m) => m.id) }: { value: RangeValue; onChange: (v: RangeValue) => void; modes?: RangeMode[] }) {
  const [custom, setCustom] = useState<DateRange>(value.range)
  const today = logicalDay()
  const setMode = (mode: RangeMode) => {
    if (mode === 'custom') {
      setCustom(value.range)
      onChange({ mode, range: value.range })
    } else onChange({ mode, range: rangeFor(mode, value.range.to >= today && value.range.from <= today ? today : value.range.from) })
  }
  const containsToday = value.range.from <= today && today <= value.range.to
  return (
    <div className="range-picker">
      <Tabs value={value.mode} options={MODES.filter((m) => modes.includes(m.id))} onChange={setMode} />
      <div className="date-nav">
        <button className="icon-btn" aria-label="Previous" onClick={() => onChange({ ...value, range: shiftRange(value.mode, value.range, -1) })}>
          ‹
        </button>
        {value.mode === 'custom' ? (
          <span className="custom-range">
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => {
                const r = { ...custom, from: e.target.value }
                setCustom(r)
                if (e.target.value) onChange({ mode: 'custom', range: rangeFor('custom', r.from, r) })
              }}
            />
            <span className="muted">to</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) => {
                const r = { ...custom, to: e.target.value }
                setCustom(r)
                if (e.target.value) onChange({ mode: 'custom', range: rangeFor('custom', r.from, r) })
              }}
            />
          </span>
        ) : (
          <h1 className="range-title">{rangeLabel(value.mode, value.range, today)}</h1>
        )}
        <button className="icon-btn" aria-label="Next" onClick={() => onChange({ ...value, range: shiftRange(value.mode, value.range, 1) })}>
          ›
        </button>
        {!containsToday && value.mode !== 'custom' && (
          <button className="btn ghost small" onClick={() => onChange({ mode: value.mode, range: rangeFor(value.mode, today) })}>
            Today
          </button>
        )}
      </div>
    </div>
  )
}
