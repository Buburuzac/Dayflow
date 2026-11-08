// Read-only chat tools (fetchTimeline / fetchObservations), ported from
// GeminiDirectProvider+DashboardTools.swift. Pure: takes a DatabaseSync, no Electron imports,
// so the MCP server (run under ELECTRON_RUN_AS_NODE) and the tests can use it too.

import type { DatabaseSync } from 'node:sqlite'
import type { ToolRequestEcho, ToolResponse } from '../../shared/chat-types.ts'
import { dayRange, formatClock, logicalDay } from '../time.ts'

export const TOOL_NAMES = ['fetchTimeline', 'fetchObservations'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** Above this, fetchTimeline drops detailedSummary first. */
export const TIMELINE_SOFT_LIMIT_BYTES = 200_000
/** Hard cap on the serialized `items` of either tool; rows past it are dropped (truncated: true). */
export const MAX_TOOL_PAYLOAD_BYTES = 200_000
/** Longest date range one call may cover; longer ranges keep their most recent days. */
export const MAX_RANGE_DAYS = 62
/** Upper bound on rows read from SQLite per call (tools run synchronously on the main thread). */
export const MAX_TOOL_ROWS = 5000

const LIMITS_NOTE = `Ranges longer than ${MAX_RANGE_DAYS} days are clamped to the last ${MAX_RANGE_DAYS} days of the range, and results are capped at about ${MAX_TOOL_PAYLOAD_BYTES / 1000} KB. When the response has truncated=true or rangeClamped=true, make more calls with narrower ranges.`
const DESC_TIMELINE = `Fetch timeline cards for a single day or date range. Returns structured JSON cards including day, time range, title, summary, category, and optional detailed summaries. ${LIMITS_NOTE}`
const DESC_OBSERVATIONS = `Fetch raw observations for a single day or date range. Returns structured JSON grouped by day, with each day's observations ordered chronologically. Observations are dense: prefer single days or short ranges. ${LIMITS_NOTE}`

/** Gemini functionDeclarations (OpenAPI subset with upper-case types), verbatim from the spec. */
export const GEMINI_FUNCTION_DECLARATIONS = [
  {
    name: 'fetchTimeline',
    description: DESC_TIMELINE,
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Single day in YYYY-MM-DD format.' },
        startDate: { type: 'STRING', description: 'Range start date in YYYY-MM-DD.' },
        endDate: { type: 'STRING', description: 'Range end date in YYYY-MM-DD.' },
        includeDetailedSummary: {
          type: 'BOOLEAN',
          description: 'When true (default), include detailedSummary. Set false for very large windows.',
        },
        limit: { type: 'NUMBER', description: 'Optional row cap. If omitted, returns matching rows up to the size cap.' },
      },
    },
  },
  {
    name: 'fetchObservations',
    description: DESC_OBSERVATIONS,
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Single day in YYYY-MM-DD format.' },
        startDate: { type: 'STRING', description: 'Range start date in YYYY-MM-DD.' },
        endDate: { type: 'STRING', description: 'Range end date in YYYY-MM-DD.' },
        limit: { type: 'NUMBER', description: 'Optional row cap. If omitted, returns matching rows up to the size cap.' },
      },
    },
  },
]

/** Same declarations as standard JSON Schema (OpenAI tools, MCP inputSchema). */
export function jsonSchemaTools(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const lower = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(lower)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        out[k] = k === 'type' && typeof val === 'string' ? val.toLowerCase() : lower(val)
      }
      return out
    }
    return v
  }
  return GEMINI_FUNCTION_DECLARATIONS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: lower(d.parameters) as Record<string, unknown>,
  }))
}

// ---- Argument coercion (§3.2) ----

type Args = Record<string, unknown>

export function stringArg(args: Args, key: string): string | null {
  const v = args[key]
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

export function boolArg(args: Args, key: string): boolean | null {
  const v = args[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['true', '1', 'yes'].includes(s)) return true
    if (['false', '0', 'no'].includes(s)) return false
  }
  return null
}

export function positiveIntArg(args: Args, key: string): number | null {
  const v = args[key]
  let n: number | null = null
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v)
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.trim()))) n = Math.trunc(Number(v.trim()))
  return n !== null && n > 0 ? n : null
}

// ---- Date range (§3.3) ----

class ValidationError extends Error {}

export interface DateWindow {
  mode: 'date' | 'range'
  date: string | null
  startDate: string | null
  endDate: string | null
  fromTs: number
  toTs: number
  /** Original startDate when the range was clamped to MAX_RANGE_DAYS */
  requestedStartDate?: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The YYYY-MM-DD `days` calendar days after `day` (negative goes back). */
function addDays(day: string, days: number): string {
  const d = ymdDate(day)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Inclusive number of calendar days in [start, end]. */
function spanDays(start: string, end: string): number {
  return Math.round((ymdDate(end).getTime() - ymdDate(start).getTime()) / 86_400_000) + 1
}

function parseYmd(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dt = new Date(y, mo - 1, d, 12)
    if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) return value
  }
  throw new ValidationError(`Invalid date format '${value}'. Use YYYY-MM-DD.`)
}

export function parseDateWindow(args: Args): DateWindow {
  const date = stringArg(args, 'date')
  const startDate = stringArg(args, 'startDate')
  const endDate = stringArg(args, 'endDate')
  if (date) {
    if (startDate || endDate) throw new ValidationError('Provide either {date} OR {startDate, endDate}.')
    const d = parseYmd(date)
    const r = dayRange(d)
    return { mode: 'date', date: d, startDate: null, endDate: null, fromTs: r.start, toTs: r.end }
  }
  if (!startDate || !endDate) throw new ValidationError('Provide either {date} OR {startDate, endDate}.')
  let s = parseYmd(startDate)
  const e = parseYmd(endDate)
  if (s > e) throw new ValidationError('startDate must be less than or equal to endDate.')
  let requestedStartDate: string | undefined
  if (spanDays(s, e) > MAX_RANGE_DAYS) {
    requestedStartDate = s
    s = addDays(e, -(MAX_RANGE_DAYS - 1))
  }
  return {
    mode: 'range',
    date: null,
    startDate: s,
    endDate: e,
    fromTs: dayRange(s).start,
    toTs: dayRange(e).end,
    ...(requestedStartDate ? { requestedStartDate } : {}),
  }
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function ymdDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

export function dateDescription(w: Pick<DateWindow, 'mode' | 'date' | 'startDate' | 'endDate'>): string {
  if (w.mode === 'date' && w.date) {
    const d = ymdDate(w.date)
    return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`
  }
  if (w.mode === 'range' && w.startDate && w.endDate) {
    const a = ymdDate(w.startDate)
    const b = ymdDate(w.endDate)
    const sa = `${MON[a.getMonth()]} ${a.getDate()}`
    const sb = `${MON[b.getMonth()]} ${b.getDate()}`
    return sa === sb ? sa : `${sa} to ${sb}`
  }
  return 'the requested dates'
}

function echo(w: DateWindow, limit: number | null, includeDetailed?: boolean): ToolRequestEcho {
  return {
    mode: w.mode,
    date: w.date,
    startDate: w.startDate,
    endDate: w.endDate,
    ...(includeDetailed !== undefined ? { includeDetailedSummary: includeDetailed } : {}),
    limit,
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---- Tools ----

interface CardMeta {
  distractions?: unknown[]
  appSites?: { primary?: string | null; secondary?: string | null }
}

function decodeMeta(raw: unknown): CardMeta {
  if (raw == null) return {}
  try {
    const v = JSON.parse(String(raw)) as unknown
    if (Array.isArray(v)) return { distractions: v }
    if (v && typeof v === 'object') return v as CardMeta
  } catch {
    /* ignore */
  }
  return {}
}

export function fetchTimeline(db: DatabaseSync, args: Args): ToolResponse {
  const w = parseDateWindow(args)
  const includeDetailed = boolArg(args, 'includeDetailedSummary') ?? true
  const limit = positiveIntArg(args, 'limit')
  const cols = `day, start, "end", title, summary, category, subcategory, metadata${includeDetailed ? ', detailed_summary' : ''}`
  const rowCap = rowLimit(limit)
  const rows = (
    w.mode === 'date'
      ? db
          .prepare(
            `SELECT ${cols} FROM timeline_cards WHERE start_ts >= ? AND start_ts < ? AND is_deleted = 0 ORDER BY start_ts ASC, start ASC LIMIT ?`,
          )
          .all(w.fromTs, w.toTs, rowCap.sql)
      : db
          .prepare(
            `SELECT ${cols} FROM timeline_cards WHERE ((start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?)) AND is_deleted = 0 ORDER BY start_ts ASC LIMIT ?`,
          )
          .all(w.toTs, w.fromTs, w.fromTs, w.toTs, rowCap.sql)
  ) as Array<Record<string, unknown>>
  let cutOff = rowCap.overflowed(rows.length)
  const limited = rows.slice(0, rowCap.max)
  let items = limited.map((r) => {
    const meta = decodeMeta(r.metadata)
    const item: Record<string, unknown> = {
      day: String(r.day),
      startTime: String(r.start),
      endTime: String(r.end),
      title: String(r.title),
      summary: String(r.summary ?? ''),
      category: String(r.category),
      subcategory: String(r.subcategory ?? ''),
      distractionsCount: Array.isArray(meta.distractions) ? meta.distractions.length : 0,
    }
    if (meta.appSites && typeof meta.appSites === 'object') {
      item.appSites = { primary: meta.appSites.primary ?? null, secondary: meta.appSites.secondary ?? null }
    }
    const detailed = String(r.detailed_summary ?? '')
    if (includeDetailed && detailed) item.detailedSummary = detailed
    return item
  })
  let droppedDetails = false
  if (includeDetailed && jsonBytes(items) > TIMELINE_SOFT_LIMIT_BYTES) {
    items = items.map(({ detailedSummary: _d, ...rest }) => rest)
    droppedDetails = true
  }
  // Hard byte cap: keep the longest prefix that fits.
  let bytes = 2
  let n = 0
  for (; n < items.length; n++) {
    const add = jsonBytes(items[n]) + 1
    if (bytes + add > MAX_TOOL_PAYLOAD_BYTES) break
    bytes += add
  }
  if (n < items.length) {
    items = items.slice(0, n)
    cutOff = true
  }
  let summary = `Fetched ${plural(items.length, 'timeline card')} for ${dateDescription(w)}.`
  if (droppedDetails) summary += ' Detailed summaries were omitted due to payload size.'
  if (cutOff) {
    const lastDay = items.length ? String(items[items.length - 1].day) : null
    summary += ` Results hit the size cap${lastDay ? ` after ${lastDay}` : ''}; fetch the remaining dates separately.`
  }
  summary += clampSummary(w)
  return {
    request: echo(w, limit, includeDetailed),
    summary,
    itemCount: items.length,
    truncated: droppedDetails || cutOff,
    ...clampFields(w),
    items,
  }
}

export function fetchObservations(db: DatabaseSync, args: Args): ToolResponse {
  const w = parseDateWindow(args)
  const limit = positiveIntArg(args, 'limit')
  const rowCap = rowLimit(limit)
  const rows = db
    .prepare(
      'SELECT start_ts, end_ts, observation FROM observations WHERE (start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?) ORDER BY start_ts ASC LIMIT ?',
    )
    .all(w.toTs, w.fromTs, w.fromTs, w.toTs, rowCap.sql) as Array<Record<string, unknown>>
  let truncated = rowCap.overflowed(rows.length)
  const limited = rows.slice(0, rowCap.max)
  const groups: Array<{ day: string; observations: Array<{ startTime: string; endTime: string; observation: string }> }> = []
  let bytes = 2
  let n = 0
  for (const r of limited) {
    const start = Number(r.start_ts)
    const day = logicalDay(start)
    const last = groups[groups.length - 1]
    const obs = { startTime: formatClock(start), endTime: formatClock(Number(r.end_ts)), observation: String(r.observation) }
    const sameDay = last !== undefined && last.day === day
    const add = jsonBytes(obs) + 1 + (sameDay ? 0 : jsonBytes({ day, observations: [] }) + 1)
    if (bytes + add > MAX_TOOL_PAYLOAD_BYTES) {
      truncated = true
      break
    }
    bytes += add
    n++
    if (sameDay) last.observations.push(obs)
    else groups.push({ day, observations: [obs] })
  }
  const d = groups.length
  let summary = `Fetched ${plural(n, 'observation')} for ${dateDescription(w)}${d > 0 ? ` across ${plural(d, 'day')}` : ''}.`
  if (truncated) {
    const lastGroup = groups[groups.length - 1]
    const lastObs = lastGroup?.observations[lastGroup.observations.length - 1]
    summary += ` Results hit the size cap${lastGroup && lastObs ? ` at ${lastObs.endTime} on ${lastGroup.day}` : ''}; fetch the rest with a narrower range.`
  }
  summary += clampSummary(w)
  return { request: echo(w, limit), summary, dayCount: d, itemCount: n, truncated, ...clampFields(w), items: groups }
}

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')

/**
 * Row cap pushed into SQL: the caller's limit bounded by MAX_TOOL_ROWS, plus one extra row to
 * tell whether MAX_TOOL_ROWS (not the caller's own limit) cut the result short.
 */
function rowLimit(limit: number | null): { max: number; sql: number; overflowed: (fetched: number) => boolean } {
  const max = Math.min(limit ?? MAX_TOOL_ROWS, MAX_TOOL_ROWS)
  const capByUs = limit === null || limit > MAX_TOOL_ROWS
  return { max, sql: max + 1, overflowed: (fetched) => capByUs && fetched > max }
}

function clampFields(w: DateWindow): Record<string, unknown> {
  return w.requestedStartDate ? { rangeClamped: true, requestedStartDate: w.requestedStartDate } : {}
}

function clampSummary(w: DateWindow): string {
  return w.requestedStartDate
    ? ` The range was clamped to the last ${MAX_RANGE_DAYS} days (requested from ${w.requestedStartDate}); query earlier dates separately.`
    : ''
}

/** Runs a tool by name. Never throws: validation and DB errors come back as `error` payloads. */
export function executeTool(db: DatabaseSync, name: string, rawArgs: unknown): ToolResponse {
  let args: Args = {}
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Args
    } catch {
      /* empty args */
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs as Args
  }
  try {
    if (name === 'fetchTimeline') return fetchTimeline(db, args)
    if (name === 'fetchObservations') return fetchObservations(db, args)
    const message = `Unknown tool '${name}'.`
    return { summary: message, error: { code: 'unknown_tool', message } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof ValidationError ? 'validation_error' : 'query_error'
    return { summary: message, error: { code, message } }
  }
}
