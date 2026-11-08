// File storage for the Daily Brief (spec-daily.md §2c), rooted at <dataDir>/daily_brief.
// JSON is pretty-printed with sorted keys and written atomically; decoding is tolerant.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DailyBrief,
  DailyBriefFeedbackEvent,
  DailyBriefRangeSummary,
  DailyBriefSavedItem,
  SummaryRange,
} from '../../shared/daily-types.ts'
import { emptyUserState, isSummaryRange, MAX_FEEDBACK_EVENTS } from './brief-logic.ts'

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(sortKeys(value), null, 2), 'utf8')
  renameSync(tmp, path)
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const IMAGE_NAME_RE = /^[\w.-]+\.jpe?g$/i
const PART_NAMES = ['docket', 'extras']

/** `join(dir, name)` only if the result stays strictly inside `dir` (normalized); else null. */
export function inside(dir: string, name: string): string | null {
  const root = resolve(dir)
  const p = resolve(root, name)
  return p.startsWith(root + sep) ? p : null
}

export class BriefFileStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = join(dataDir, 'daily_brief')
    mkdirSync(this.root, { recursive: true })
  }

  dayDir(day: string): string {
    if (!DAY_RE.test(day)) throw new Error(`Invalid day: ${day}`)
    return join(this.root, day)
  }

  private decode(raw: Partial<DailyBrief> | null, day: string): DailyBrief | null {
    if (!raw || typeof raw !== 'object') return null
    const content = raw.content && typeof raw.content === 'object' ? raw.content : { order: [] }
    return {
      day: typeof raw.day === 'string' ? raw.day : day,
      sourceDay: typeof raw.sourceDay === 'string' ? raw.sourceDay : '',
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date(0).toISOString(),
      content: { ...content, order: Array.isArray(content.order) ? content.order : [] },
      userState: { ...emptyUserState(), ...(raw.userState ?? {}) },
      stats: raw.stats,
    }
  }

  load(day: string): DailyBrief | null {
    return this.decode(readJson<Partial<DailyBrief>>(join(this.dayDir(day), 'brief.json')), day)
  }

  save(brief: DailyBrief): void {
    const dir = this.dayDir(brief.day)
    mkdirSync(dir, { recursive: true })
    writeJsonAtomic(join(dir, 'brief.json'), brief)
  }

  /** Folder names of 10 chars starting with a digit, newest first. */
  loadAll(): DailyBrief[] {
    let names: string[] = []
    try {
      names = readdirSync(this.root).filter((n) => n.length === 10 && /^\d/.test(n) && DAY_RE.test(n))
    } catch {
      return []
    }
    return names
      .sort()
      .reverse()
      .map((n) => this.load(n))
      .filter((b): b is DailyBrief => !!b)
  }

  deleteDay(day: string): void {
    rmSync(join(this.dayDir(day), 'brief.json'), { force: true })
  }

  copyImage(day: string, srcPath: string): string {
    const dir = join(this.dayDir(day), 'images')
    mkdirSync(dir, { recursive: true })
    const name = basename(srcPath)
    copyFileSync(srcPath, join(dir, name))
    return `images/${name}`
  }

  /** Absolute path of "images/<file>" inside a day's folder; refuses anything that escapes it. */
  imagePath(day: string, rel: string): string | null {
    const name = basename(String(rel))
    if (!IMAGE_NAME_RE.test(name) || name.startsWith('.')) return null
    const p = inside(join(this.dayDir(day), 'images'), name)
    return p && existsSync(p) ? p : null
  }

  transcriptPath(day: string, part: string): string {
    if (!PART_NAMES.includes(part)) throw new Error(`Invalid part: ${part}`)
    return join(this.dayDir(day), `transcript-${part}.txt`)
  }

  writeTranscript(day: string, part: string, text: string): void {
    mkdirSync(this.dayDir(day), { recursive: true })
    writeFileSync(this.transcriptPath(day, part), text, 'utf8')
  }

  readTranscript(day: string, part: string): string | null {
    try {
      return readFileSync(this.transcriptPath(day, part), 'utf8')
    } catch {
      return null
    }
  }

  clearTranscripts(day: string): void {
    for (const p of ['docket', 'extras']) rmSync(this.transcriptPath(day, p), { force: true })
  }

  handoffsDir(day: string): string {
    const d = join(this.dayDir(day), 'handoffs')
    mkdirSync(d, { recursive: true })
    return d
  }

  // ---- feedback ----

  private get feedbackFile(): string {
    return join(this.root, 'feedback.json')
  }

  feedback(): DailyBriefFeedbackEvent[] {
    const v = readJson<DailyBriefFeedbackEvent[]>(this.feedbackFile)
    return Array.isArray(v) ? v : []
  }

  addFeedback(ev: DailyBriefFeedbackEvent): void {
    const all = [...this.feedback(), ev]
    writeJsonAtomic(this.feedbackFile, all.slice(-MAX_FEEDBACK_EVENTS))
  }

  // ---- saved images ----

  private get savedDir(): string {
    const d = join(this.root, 'saved')
    mkdirSync(d, { recursive: true })
    return d
  }

  saved(): DailyBriefSavedItem[] {
    const v = readJson<DailyBriefSavedItem[]>(join(this.savedDir, 'saved.json'))
    return Array.isArray(v) ? v : []
  }

  saveImage(day: string, rel: string, caption?: string): DailyBriefSavedItem | null {
    const src = this.imagePath(day, rel)
    if (!src) return null
    const file = `${day}_images_${basename(src)}`
    copyFileSync(src, join(this.savedDir, file))
    const item: DailyBriefSavedItem = { id: randomUUID(), savedAt: new Date().toISOString(), imageFile: file, caption, sourceDay: day }
    writeJsonAtomic(join(this.savedDir, 'saved.json'), [item, ...this.saved().filter((s) => s.imageFile !== file)])
    return item
  }

  savedImagePath(file: string): string | null {
    const name = basename(String(file))
    if (!IMAGE_NAME_RE.test(name) || name.startsWith('.')) return null
    const p = inside(this.savedDir, name)
    return p && existsSync(p) ? p : null
  }

  // ---- range summaries ----

  summary(range: SummaryRange): DailyBriefRangeSummary | null {
    if (!isSummaryRange(range)) return null
    return readJson<DailyBriefRangeSummary>(join(this.root, 'summaries', `${range}.json`))
  }

  saveSummary(s: DailyBriefRangeSummary): void {
    if (!isSummaryRange(s.range)) throw new Error('Invalid range')
    const d = join(this.root, 'summaries')
    mkdirSync(d, { recursive: true })
    writeJsonAtomic(join(d, `${s.range}.json`), s)
  }
}
