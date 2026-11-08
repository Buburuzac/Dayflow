// Writes accessibility events to plain JSONL files, port of AccessibilityLogStore.swift:
//
//   <dataDir>/accessibility/2026-10-28/1430.jsonl
//
// One folder per local day, one file per 10-minute window, one event per line, append-only,
// so a crash loses at most the line being written. Kept out of chunks.sqlite so the frequent
// writes never compete with screenshot and card writes.

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { A11yEvent } from './types.ts'

const WINDOW_SECONDS = 10 * 60

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** ISO-8601 local time with milliseconds and offset, e.g. 2026-10-28T14:31:07.123+01:00 */
export function isoLocal(ms: number): string {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:` +
    `${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** One JSON line, keys in the Swift encoder's order, nil fields left out. */
export function encodeEvent(e: A11yEvent): string {
  const o: Record<string, unknown> = { time: isoLocal(e.time), kind: e.kind }
  if (e.app !== undefined) o.app = e.app
  if (e.bundleId !== undefined) o.bundle_id = e.bundleId
  if (e.window !== undefined) o.window = e.window
  if (e.blocked !== undefined) o.blocked = e.blocked
  if (e.target !== undefined) o.target = e.target
  if (e.field !== undefined) o.field = e.field
  if (e.text !== undefined) o.text = e.text
  if (e.keys !== undefined) o.keys = e.keys
  if (e.trigger !== undefined) o.trigger = e.trigger
  if (e.tree !== undefined) o.tree = e.tree
  if (e.diff !== undefined) o.diff = e.diff
  if (e.snapshotMs !== undefined) o.snapshot_ms = e.snapshotMs
  return JSON.stringify(o)
}

const STRING_FIELDS: Array<[string, keyof A11yEvent]> = [
  ['app', 'app'],
  ['bundle_id', 'bundleId'],
  ['window', 'window'],
  ['target', 'target'],
  ['field', 'field'],
  ['text', 'text'],
  ['keys', 'keys'],
  ['trigger', 'trigger'],
  ['tree', 'tree'],
  ['diff', 'diff'],
]

/** Parses one line; null when it can't be read (like a failing Decodable). */
export function decodeEvent(line: string): A11yEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.time !== 'string' || typeof o.kind !== 'string') return null
  // Swift accepts internet date-time with or without fractional seconds.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)$/.test(o.time)) return null
  const time = Date.parse(o.time)
  if (Number.isNaN(time)) return null
  const e: A11yEvent = { time, kind: o.kind }
  for (const [json, key] of STRING_FIELDS) {
    const v = o[json]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return null
    ;(e as unknown as Record<string, unknown>)[key] = v
  }
  if (o.blocked !== undefined && o.blocked !== null) {
    if (typeof o.blocked !== 'boolean') return null
    e.blocked = o.blocked
  }
  if (o.snapshot_ms !== undefined && o.snapshot_ms !== null) {
    if (typeof o.snapshot_ms !== 'number' || !Number.isInteger(o.snapshot_ms)) return null
    e.snapshotMs = o.snapshot_ms
  }
  return e
}

export class A11yLogStore {
  readonly rootDir: string
  private fd: number | null = null
  private fdPath: string | null = null

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /** `accessibility/yyyy-MM-dd/HHmm.jsonl`, minutes rounded down to the 10-minute window, local time. */
  filePath(ms: number): string {
    const d = new Date(ms)
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const minute = Math.floor(d.getMinutes() / 10) * 10
    return join(this.rootDir, day, `${pad(d.getHours())}${pad(minute)}.jsonl`)
  }

  append(event: A11yEvent): void {
    const line = encodeEvent(event) + '\n'
    const path = this.filePath(event.time)
    if (path !== this.fdPath) {
      this.close()
      try {
        mkdirSync(join(path, '..'), { recursive: true })
        this.fd = openSync(path, 'a')
        this.fdPath = path
      } catch (err) {
        console.error('[a11y] could not open log file', err)
        return
      }
    }
    try {
      writeSync(this.fd!, line)
    } catch (err) {
      console.error('[a11y] write failed', err)
      this.close()
    }
  }

  /** Closes the open file. The next event reopens it. */
  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        /* already closed */
      }
    }
    this.fd = null
    this.fdPath = null
  }

  /** Deletes every file whose 10-minute window ended before `cutoffMs`, condensed batch logs
   * written before it, then any day folders left empty. */
  prune(cutoffMs: number): void {
    let days: string[]
    try {
      days = readdirSync(this.rootDir)
    } catch {
      return
    }
    for (const day of days) {
      if (day.startsWith('.')) continue
      const folder = join(this.rootDir, day)
      let files: string[]
      try {
        if (!statSync(folder).isDirectory()) continue
        files = readdirSync(folder)
      } catch {
        continue
      }
      for (const name of files) {
        const path = join(folder, name)
        if (name.endsWith('.txt')) {
          try {
            if (statSync(path).mtimeMs < cutoffMs) unlinkSync(path)
          } catch {
            /* ignore */
          }
        } else if (name.endsWith('.jsonl')) {
          if (path === this.fdPath) continue
          const start = windowStart(day, name)
          if (start !== null && start + WINDOW_SECONDS * 1000 < cutoffMs) {
            try {
              unlinkSync(path)
            } catch {
              /* ignore */
            }
          }
        }
      }
      try {
        if (readdirSync(folder).length === 0) rmdirSync(folder)
      } catch {
        /* ignore */
      }
    }
  }

  /** Saves the condensed log sent with a batch as `HHmm-batch<id>.txt` next to the raw logs. */
  saveCondensedLog(text: string, batchId: number, batchStartMs: number): void {
    const d = new Date(batchStartMs)
    const folder = join(this.filePath(batchStartMs), '..')
    const path = join(folder, `${pad(d.getHours())}${pad(d.getMinutes())}-batch${batchId}.txt`)
    try {
      mkdirSync(folder, { recursive: true })
      writeFileSync(`${path}.tmp`, text, 'utf8')
      renameSync(`${path}.tmp`, path)
    } catch (err) {
      console.error('[a11y] could not save condensed log', err)
    }
  }

  /** Log files that may hold events from `[start, end)`: folders a day either side, files
   * matched by creation < end and modification ≥ start (robust to time-zone changes). */
  logFiles(startMs: number, endMs: number): string[] {
    const out: string[] = []
    const s = new Date(startMs)
    const e = new Date(endMs)
    const day = new Date(s.getFullYear(), s.getMonth(), s.getDate() - 1)
    const lastDay = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1)
    while (day.getTime() <= lastDay.getTime()) {
      const folder = join(this.filePath(day.getTime()), '..')
      let names: string[] = []
      try {
        names = readdirSync(folder)
      } catch {
        /* no folder */
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name.startsWith('.')) continue
        const path = join(folder, name)
        try {
          const st = statSync(path)
          const created = st.birthtimeMs > 0 ? st.birthtimeMs : -Infinity
          if (created < endMs && st.mtimeMs >= startMs) out.push(path)
        } catch {
          /* vanished */
        }
      }
      day.setDate(day.getDate() + 1)
    }
    return out.sort()
  }

  /** Events in `[start, end)`, stable-sorted by time. Unreadable lines are skipped. */
  loadEvents(startMs: number, endMs: number): A11yEvent[] {
    const events: A11yEvent[] = []
    for (const path of this.logFiles(startMs, endMs)) {
      let data: string
      try {
        data = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const line of data.split('\n')) {
        if (!line) continue
        const event = decodeEvent(line)
        if (event && event.time >= startMs && event.time < endMs) events.push(event)
      }
    }
    // Array.prototype.sort is stable.
    return events.sort((a, b) => a.time - b.time)
  }
}

/** The window's start time from its folder and file name. */
function windowStart(day: string, file: string): number | null {
  const parts = day.split('-').map((p) => Number(p))
  const time = file.replace(/\.jsonl$/, '')
  if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p)) || !/^\d{4}$/.test(time)) return null
  return new Date(parts[0], parts[1] - 1, parts[2], Number(time.slice(0, 2)), Number(time.slice(2))).getTime()
}
