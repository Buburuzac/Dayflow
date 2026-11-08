// FlowSessionTimeline.swift port (spec A.9): the focused / distracted / break log of a session,
// kept in <dataDir>/flow-session-timeline.json. Times are unix seconds; the file uses ISO-8601.
// No Electron imports, so it runs under `node --test`.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { FlowEntryKind, FlowTimelineEntry } from '../../shared/flow-types.ts'
import { clock24 } from './prompts.ts'

export interface TimelineEntry {
  id: string
  title: string
  kind: FlowEntryKind
  startedAt: number
  endedAt: number
  iconURL?: string
  completedTasks?: string[]
  category?: string
  site?: string
}

export interface TimelineObservation {
  at: number
  offTask: boolean
  appName?: string
  reason?: string
}

export interface Span {
  start: number
  end?: number
}

export interface ModelItem {
  start?: unknown
  end?: unknown
  title?: unknown
  kind?: unknown
  completed?: unknown
  category?: unknown
  site?: unknown
}

const MAX_OBSERVATIONS = 2000
const BLIP_SECONDS = 120

export function tidyTitle(raw: string): string {
  let text = raw.trim()
  while (text.endsWith('.')) text = text.slice(0, -1)
  if ([...text].length > 60) text = [...text].slice(0, 57).join('') + '…'
  if (!text) return ''
  return text[0].toUpperCase() + text.slice(1)
}

function tidySite(raw: unknown): string | undefined {
  const site = typeof raw === 'string' ? raw.trim() : ''
  return site && site.length <= 80 ? site : undefined
}

function tidyCompleted(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const cleaned = raw.map((t) => tidyTitle(String(t))).filter(Boolean)
  return cleaned.length ? cleaned.slice(0, 5) : undefined
}

export function matchCategory(raw: unknown, distracted: boolean, names: string[]): string | undefined {
  const wanted = (typeof raw === 'string' ? raw : '').trim().toLowerCase()
  if (wanted) {
    const m = names.find((n) => n.toLowerCase() === wanted)
    if (m) return m
    // Models sometimes copy the briefing line "Name: details" whole.
    const head = wanted.split(':')[0].replace(/^[·•\-\s]+/, '').trim()
    const h = head && names.find((n) => n.toLowerCase() === head)
    if (h) return h
  }
  if (!distracted) return undefined
  return names.find((n) => n.toLowerCase().includes('distract'))
}

/** Parses "HH:mm" (or "h:mm am/pm") onto the day (−1/0/+1 of the session day) nearest `anchor`. */
export function clockNear(text: unknown, sessionStart: number, anchor: number): number | null {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t) return null
  const lower = t.toLowerCase()
  const digits = lower.replace(/am|pm/g, '').trim()
  const parts = digits.split(':')
  if (parts.length < 2) return null
  let hour = Number.parseInt(parts[0], 10)
  const minute = Number.parseInt(parts[1].slice(0, 2), 10)
  if (!/^\s*\d+\s*$/.test(parts[0]) || !Number.isFinite(minute)) return null
  if (lower.includes('pm') && hour < 12) hour += 12
  if (lower.includes('am') && hour === 12) hour = 0
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  let best: number | null = null
  for (const off of [-1, 0, 1]) {
    const d = new Date(sessionStart * 1000)
    d.setDate(d.getDate() + off)
    d.setHours(hour, minute, 0, 0)
    const c = d.getTime() / 1000
    if (best == null || Math.abs(c - anchor) < Math.abs(best - anchor)) best = c
  }
  return best
}

const dur = (e: TimelineEntry) => e.endedAt - e.startedAt

/**
 * The validation pipeline of FlowSessionTimeline.apply, minus icons and persistence.
 * Returns null when nothing usable came back.
 */
export function buildEntries(
  items: ModelItem[],
  sessionStart: number,
  now: number,
  categoryNames: string[],
  breaks: Span[],
  makeId: () => string = randomUUID,
): TimelineEntry[] | null {
  const middle = sessionStart + (now - sessionStart) / 2
  const parsed: TimelineEntry[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? tidyTitle(item.title) : ''
    const start = clockNear(item.start, sessionStart, middle)
    const end = clockNear(item.end, sessionStart, middle)
    if (!title || start == null || end == null) continue
    const word = typeof item.kind === 'string' ? item.kind.toLowerCase() : ''
    const kind: FlowEntryKind =
      word === 'focused' || word === 'distracted' || word === 'break' ? word : word === 'off_task' ? 'distracted' : 'focused'
    const e: TimelineEntry = {
      id: makeId(),
      title,
      kind,
      startedAt: Math.max(sessionStart, start),
      endedAt: Math.min(now, Math.max(start, end)),
    }
    if (kind === 'focused') {
      const c = tidyCompleted(item.completed)
      if (c) e.completedTasks = c
    }
    if (kind !== 'break') {
      const cat = matchCategory(item.category, kind === 'distracted', categoryNames)
      if (cat) e.category = cat
      const site = tidySite(item.site)
      if (site) e.site = site
    }
    parsed.push(e)
  }
  parsed.sort((a, b) => a.startedAt - b.startedAt)

  // Contiguous from the session start; drop empty pieces.
  let cursor = sessionStart
  let list: TimelineEntry[] = []
  for (const e0 of parsed) {
    const e = { ...e0 }
    e.startedAt = Math.max(cursor, Math.min(e.startedAt, now))
    e.endedAt = Math.max(e.startedAt, e.endedAt)
    if (e.endedAt <= e.startedAt) continue
    list.push(e)
    cursor = e.endedAt
  }
  if (!list.length) return null

  // Fold blips: a short piece between two neighbours of another, shared kind.
  let i = 1
  while (i < list.length - 1) {
    const blip = list[i]
    const before = list[i - 1]
    const after = list[i + 1]
    if (
      dur(blip) < BLIP_SECONDS &&
      blip.kind !== 'break' &&
      before.kind === after.kind &&
      before.kind !== blip.kind &&
      !blip.completedTasks
    ) {
      const joined: TimelineEntry = { ...before }
      if (dur(after) > dur(before)) {
        joined.title = after.title
        joined.category = after.category ?? before.category
        joined.site = after.site ?? before.site
      }
      joined.endedAt = after.endedAt
      const done = [...(before.completedTasks ?? []), ...(after.completedTasks ?? [])]
      if (done.length) joined.completedTasks = done
      else delete joined.completedTasks
      list.splice(i - 1, 3, joined)
    } else i++
  }

  // Merge consecutive distracted entries (the longer piece's title wins).
  const merged: TimelineEntry[] = []
  for (const e of list) {
    const last = merged[merged.length - 1]
    if (!last || last.kind !== 'distracted' || e.kind !== 'distracted') {
      merged.push(e)
      continue
    }
    const joined: TimelineEntry = { ...last }
    if (dur(e) > dur(last)) {
      joined.title = e.title
      joined.category = e.category ?? last.category
      joined.site = e.site ?? last.site
    }
    joined.endedAt = e.endedAt
    merged[merged.length - 1] = joined
  }
  list = overlayBreaks(merged, breaks, now, makeId)

  // Completed tasks are kept once, on the latest piece.
  const seen = new Set<string>()
  for (let k = list.length - 1; k >= 0; k--) {
    const done = list[k].completedTasks
    if (!done) continue
    const fresh = done.filter((t) => {
      const key = t.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (fresh.length) list[k] = { ...list[k], completedTasks: fresh }
    else {
      const copy = { ...list[k] }
      delete copy.completedTasks
      list[k] = copy
    }
  }
  return list
}

/** Cuts the app's exact break spans into the entries (model-written breaks are dropped). */
export function overlayBreaks(entries: TimelineEntry[], breaks: Span[], now: number, makeId: () => string = randomUUID): TimelineEntry[] {
  let result = entries.filter((e) => e.kind !== 'break')
  for (const span of breaks) {
    const bs = span.start
    const be = Math.min(now, span.end ?? now)
    if (be <= bs) continue
    const next: TimelineEntry[] = []
    for (const e of result) {
      if (e.endedAt <= bs || e.startedAt >= be) {
        next.push(e)
        continue
      }
      if (e.startedAt < bs) next.push({ ...e, endedAt: bs })
      if (e.endedAt > be) next.push({ ...e, id: makeId(), startedAt: be })
    }
    next.push({ id: makeId(), title: 'Break', kind: 'break', startedAt: bs, endedAt: be })
    result = next.sort((a, b) => a.startedAt - b.startedAt)
  }
  return result
}

function jsonString(v: string): string {
  return JSON.stringify(v)
}

interface FileShape {
  sessionStartedAt: string
  updatedAt: string
  entries: FlowTimelineEntry[]
  observations: Array<{ at: string; offTask: boolean; appName?: string; reason?: string }>
  breaks: Array<{ start: string; end?: string }>
}

const iso = (s: number) => new Date(s * 1000).toISOString()
const fromIso = (s: string) => new Date(s).getTime() / 1000

/** Stable JSON with sorted keys (the macOS file uses .sortedKeys). */
function sortedJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x as Record<string, unknown>)
          .sort()
          .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      )
    }
    return x
  }
  return JSON.stringify(sort(v), null, 2)
}

export function toPublicEntry(e: TimelineEntry): FlowTimelineEntry {
  const out: FlowTimelineEntry = { id: e.id, title: e.title, kind: e.kind, startedAt: iso(e.startedAt), endedAt: iso(e.endedAt) }
  if (e.iconURL) out.iconURL = e.iconURL
  if (e.completedTasks) out.completedTasks = e.completedTasks
  if (e.category) out.category = e.category
  if (e.site) out.site = e.site
  return out
}

export class FlowSessionTimeline {
  entries: TimelineEntry[] = []
  observations: TimelineObservation[] = []
  breaks: Span[] = []
  sessionStartedAt = Date.now() / 1000
  updatedAt: number | null = null
  lastModelUpdateAt: number | null = null
  private readonly file: string | null
  private readonly categoryNames: () => string[]

  constructor(file: string | null, categoryNames: () => string[]) {
    this.file = file
    this.categoryNames = categoryNames
  }

  /** Reuses the file when it belongs to the same session (±5 s), else starts fresh. */
  begin(started: number): void {
    const f = this.load()
    if (f && Math.abs(fromIso(f.sessionStartedAt) - started) < 5) {
      this.sessionStartedAt = fromIso(f.sessionStartedAt)
      this.entries = (f.entries ?? []).map((e) => ({
        ...e,
        startedAt: fromIso(e.startedAt),
        endedAt: fromIso(e.endedAt),
      }))
      this.observations = (f.observations ?? []).map((o) => ({ ...o, at: fromIso(o.at) }))
      this.breaks = (f.breaks ?? []).map((b) => ({ start: fromIso(b.start), end: b.end ? fromIso(b.end) : undefined }))
      this.updatedAt = fromIso(f.updatedAt)
      this.lastModelUpdateAt = this.entries.length ? this.updatedAt : null
      return
    }
    this.sessionStartedAt = started
    this.entries = []
    this.observations = []
    this.breaks = []
    this.updatedAt = null
    this.lastModelUpdateAt = null
    this.save()
  }

  observe(offTask: boolean, appName: string | undefined, reason: string | undefined, now = Date.now() / 1000): void {
    this.observations.push({ at: now, offTask, appName: appName || undefined, reason: reason || undefined })
    if (this.observations.length > MAX_OBSERVATIONS) this.observations.splice(0, this.observations.length - MAX_OBSERVATIONS)
    this.save()
  }

  beginBreak(now = Date.now() / 1000): void {
    const last = this.breaks[this.breaks.length - 1]
    if (last && last.end == null) return
    this.breaks.push({ start: now })
    this.save()
  }

  endBreak(now = Date.now() / 1000): void {
    const last = this.breaks[this.breaks.length - 1]
    if (!last || last.end != null) return
    last.end = now
    this.save()
  }

  wantsUpdate(interval: number, now = Date.now() / 1000): boolean {
    if (this.lastModelUpdateAt == null) return now - this.sessionStartedAt >= Math.min(interval, 60)
    return now - this.lastModelUpdateAt >= interval
  }

  /** Applies the model's timeline. Returns false when nothing usable came back. */
  apply(items: ModelItem[], now = Date.now() / 1000): boolean {
    const list = buildEntries(items, this.sessionStartedAt, now, this.categoryNames(), this.breaks)
    if (!list) return false
    this.entries = list
    this.lastModelUpdateAt = now
    this.save()
    return true
  }

  /** Ends an open break and extends the last entry to now if the gap is under 15 minutes. */
  finish(now = Date.now() / 1000): void {
    this.endBreak(now)
    const last = this.entries[this.entries.length - 1]
    if (!last || last.endedAt >= now || now - last.endedAt >= 15 * 60) return
    last.endedAt = now
    this.save()
  }

  clear(): void {
    this.entries = []
    this.observations = []
    this.breaks = []
    this.updatedAt = null
    this.lastModelUpdateAt = null
    if (this.file) rmSync(this.file, { force: true })
  }

  promptTimelineJSON(): string {
    if (!this.entries.length) return '[]'
    const rows = this.entries.map(
      (e) =>
        `{"start":"${clock24(e.startedAt)}","end":"${clock24(e.endedAt)}","kind":"${e.kind}","title":${jsonString(e.title)}` +
        (e.category ? `,"category":${jsonString(e.category)}` : '') +
        (e.site ? `,"site":${jsonString(e.site)}` : '') +
        (e.completedTasks ? `,"completed":[${e.completedTasks.map(jsonString).join(',')}]` : '') +
        '}',
    )
    return '[\n' + rows.join(',\n') + '\n]'
  }

  promptObservations(since: number | null): string {
    const recent = this.observations.filter((o) => since == null || o.at > since)
    if (!recent.length) return '(no checks since the last update)'
    return recent
      .map((o) => {
        let line = `${clock24(o.at)} ${o.offTask ? 'off_task' : 'on_task'}`
        if (o.appName) line += ` · ${o.appName}`
        if (o.reason) line += ` · ${o.reason}`
        return line
      })
      .join('\n')
  }

  promptBreaks(): string {
    if (!this.breaks.length) return '(none)'
    return this.breaks.map((b) => `${clock24(b.start)}–${b.end != null ? clock24(b.end) : 'ongoing'}`).join(', ')
  }

  publicEntries(): FlowTimelineEntry[] {
    return this.entries.map(toPublicEntry)
  }

  private save(): void {
    this.updatedAt = Date.now() / 1000
    if (!this.file) return
    const data: FileShape = {
      sessionStartedAt: iso(this.sessionStartedAt),
      updatedAt: iso(this.updatedAt),
      entries: this.publicEntries(),
      observations: this.observations.map((o) => ({ at: iso(o.at), offTask: o.offTask, appName: o.appName, reason: o.reason })),
      breaks: this.breaks.map((b) => ({ start: iso(b.start), end: b.end != null ? iso(b.end) : undefined })),
    }
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, sortedJson(data))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[flow] could not save the session timeline', err)
    }
  }

  private load(): FileShape | null {
    if (!this.file || !existsSync(this.file)) return null
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as FileShape
    } catch {
      return null
    }
  }
}

/** Extracts timeline items from a reply's extra JSON objects ({"timeline":[...]} or a bare array). */
export function timelineFromObjects(objects: string[]): ModelItem[] | null {
  for (const o of objects) {
    try {
      const v = JSON.parse(o) as unknown
      if (v && typeof v === 'object' && Array.isArray((v as { timeline?: unknown }).timeline)) {
        return (v as { timeline: ModelItem[] }).timeline
      }
    } catch {
      /* skip */
    }
  }
  return null
}
