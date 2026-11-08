// On-demand card timelapses: generation (ffmpeg MP4 when available, MediaRecorder WebM
// otherwise), lookup, storage cap and purge (TimelapseStorageManager).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TimelapseCardData,
  TimelapseFormat,
  TimelapseInfo,
  TimelapseProgress,
  TimelapseStorage,
} from '../../shared/timelapse-types.ts'
import { TIMELAPSE_BITRATE, TIMELAPSE_DEFAULT_LIMIT, TIMELAPSE_FPS } from '../../shared/timelapse-types.ts'
import type { FeatureContext } from '../features/context.ts'
import { canvasSize, jpegSize, localDay, purgePlan, sampleFrames, timelapsePath, type StorageEntry } from './frames.ts'
import { encodeMp4, findFfmpeg } from './ffmpeg.ts'
import { encodeWebm } from './media-recorder.ts'

interface TimelapseSettings {
  storageLimitTimelapsesBytes: number
}

interface Sidecar {
  frameCount: number
  fps: number
  durationSeconds: number
  createdAt: number
  startTs: number
  endTs: number
}

const FILE_RE = /^(\d+)_timelapse\.(mp4|webm)$/

function dirSize(path: string): number {
  let total = 0
  let st
  try {
    st = statSync(path)
  } catch {
    return 0
  }
  if (!st.isDirectory()) return st.size
  for (const name of readdirSync(path)) total += dirSize(join(path, name))
  return total
}

export class TimelapseService {
  readonly root: string
  private readonly ctx: FeatureContext
  private readonly settingsFile: string
  private readonly jobs = new Map<number, Promise<TimelapseInfo>>()

  constructor(ctx: FeatureContext) {
    this.ctx = ctx
    this.root = join(ctx.dataDir, 'timelapses')
    this.settingsFile = join(ctx.dataDir, 'timelapse-settings.json')
    mkdirSync(this.root, { recursive: true })
  }

  // ---- Settings / storage ----

  limit(): number {
    try {
      const s = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<TimelapseSettings>
      const v = s.storageLimitTimelapsesBytes
      return typeof v === 'number' && v >= 0 ? v : TIMELAPSE_DEFAULT_LIMIT
    } catch {
      return TIMELAPSE_DEFAULT_LIMIT
    }
  }

  async setLimit(bytes: number): Promise<TimelapseStorage> {
    const v = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : TIMELAPSE_DEFAULT_LIMIT
    const tmp = `${this.settingsFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ storageLimitTimelapsesBytes: v } satisfies TimelapseSettings, null, 2))
    renameSync(tmp, this.settingsFile)
    await this.purge()
    return this.storage()
  }

  storage(): TimelapseStorage {
    return { dir: this.root, usedBytes: dirSize(this.root), limitBytes: this.limit() }
  }

  /**
   * Deletes videos of deleted cards, then videos oldest first until under the cap. Never touches
   * `keep` (the video just written), videos of cards with a running job, or anything in a folder
   * holding an in-progress `.partial.*` file; those still count toward usage.
   */
  async purge(keep?: string): Promise<void> {
    if (!existsSync(this.root)) return
    const isLive = this.ctx.store.db.prepare('SELECT is_deleted FROM timeline_cards WHERE id = ?')
    const entries: StorageEntry[] = []
    const dirs: string[] = []
    const scan = async (dir: string) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      const busy = names.some((n) => n.includes('.partial.'))
      for (const name of names) {
        const path = join(dir, name)
        let st
        try {
          st = statSync(path)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (dir === this.root) {
            dirs.push(path)
            await scan(path)
          } else entries.push({ path, sizeBytes: dirSize(path), time: st.mtimeMs, keep: true })
          continue
        }
        const m = FILE_RE.exec(name)
        if (!m) {
          // Sidecars are sized with their video; partials and strays only count toward usage.
          if (!/^\d+_timelapse\.json$/.test(name)) entries.push({ path, sizeBytes: st.size, time: st.mtimeMs, keep: true })
          continue
        }
        const cardId = Number(m[1])
        const protect = busy || path === keep || this.jobs.has(cardId)
        const row = isLive.get(cardId) as { is_deleted: number } | undefined
        if (!protect && (!row || Number(row.is_deleted) === 1)) {
          await this.removeFiles(path)
          continue
        }
        let sidecar = 0
        try {
          sidecar = statSync(path.replace(/\.(mp4|webm)$/, '.json')).size
        } catch {
          /* no sidecar */
        }
        entries.push({
          path,
          sizeBytes: st.size + sidecar,
          time: Math.min(st.birthtimeMs || Infinity, st.mtimeMs),
          keep: protect,
        })
      }
    }
    await scan(this.root)
    for (const e of purgePlan(entries, this.limit())) await this.removeFiles(e.path)
    for (const d of dirs) {
      try {
        if (readdirSync(d).length === 0) await rm(d, { recursive: true, force: true })
      } catch {
        /* gone */
      }
    }
  }

  private async removeFiles(video: string): Promise<void> {
    await rm(video, { force: true })
    await rm(video.replace(/\.(mp4|webm)$/, '.json'), { force: true })
  }

  // ---- Lookup ----

  private cardRow(cardId: number) {
    return this.ctx.store.getCard(cardId)
  }

  info(cardId: number): TimelapseInfo | null {
    const card = this.cardRow(cardId)
    if (!card) return null
    for (const format of ['mp4', 'webm'] as TimelapseFormat[]) {
      const path = timelapsePath(this.root, cardId, card.startTs, format)
      const fallback = join(this.root, `${cardId}_timelapse.${format}`)
      for (const p of [path, fallback]) {
        if (!existsSync(p)) continue
        let meta: Partial<Sidecar> = {}
        try {
          meta = JSON.parse(readFileSync(p.replace(/\.(mp4|webm)$/, '.json'), 'utf8')) as Sidecar
        } catch {
          /* no sidecar */
        }
        const st = statSync(p)
        return {
          cardId,
          path: p,
          format,
          sizeBytes: st.size,
          createdAt: meta.createdAt ?? Math.floor(st.mtimeMs / 1000),
          frameCount: meta.frameCount ?? 0,
          fps: meta.fps ?? TIMELAPSE_FPS,
          durationSeconds: meta.durationSeconds ?? 0,
        }
      }
    }
    return null
  }

  async cardData(cardId: number): Promise<TimelapseCardData> {
    const card = this.cardRow(cardId)
    return {
      card: card
        ? {
            id: card.id,
            title: card.title,
            startTs: card.startTs,
            endTs: card.endTs,
            startTime: card.startTime,
            endTime: card.endTime,
            category: card.category,
          }
        : null,
      frames: card ? this.ctx.store.screenshotsInRange(card.startTs, card.endTs) : [],
      video: this.info(cardId),
      generating: this.jobs.has(cardId),
      ffmpeg: (await findFfmpeg()) != null,
    }
  }

  async read(cardId: number): Promise<Uint8Array | null> {
    const i = this.info(cardId)
    return i ? new Uint8Array(await readFile(i.path)) : null
  }

  // ---- Generation ----

  generate(cardId: number, force = false): Promise<TimelapseInfo> {
    const running = this.jobs.get(cardId)
    if (running) return running
    const job = this.run(cardId, force).finally(() => this.jobs.delete(cardId))
    this.jobs.set(cardId, job)
    return job
  }

  private progress(p: TimelapseProgress): void {
    this.ctx.broadcast('timelapse:progress', p)
  }

  private async run(cardId: number, force: boolean): Promise<TimelapseInfo> {
    const fail = (msg: string): never => {
      this.progress({ cardId, phase: 'error', done: 0, total: 0, error: msg })
      throw new Error(msg)
    }
    const card = this.cardRow(cardId)
    if (!card) return fail('Could not find this activity in storage.')
    if (!force) {
      const existing = this.info(cardId)
      if (existing) return existing
    }
    this.progress({ cardId, phase: 'preparing', done: 0, total: 0 })
    const shots = sampleFrames(this.ctx.store.screenshotsInRange(card.startTs, card.endTs))
    // Keep only frames that exist and decode as JPEG; the first one sets the canvas size.
    const frames: string[] = []
    let size: { width: number; height: number } | null = null
    for (const s of shots) {
      try {
        const head = await readFile(s.filePath)
        const dim = jpegSize(head)
        if (!dim) continue
        size ??= dim
        frames.push(s.filePath)
      } catch {
        /* missing file */
      }
    }
    if (!frames.length || !size) return fail('No screenshots are available for this activity range.')
    const { width, height } = canvasSize(size.width, size.height, null)
    const total = frames.length
    const ffmpeg = await findFfmpeg()
    const format: TimelapseFormat = ffmpeg ? 'mp4' : 'webm'
    let out = timelapsePath(this.root, cardId, card.startTs, format)
    try {
      mkdirSync(join(this.root, localDay(card.startTs)), { recursive: true })
    } catch {
      out = join(this.root, `${cardId}_timelapse.${format}`)
    }
    const tmp = `${out}.partial.${format}`
    const onProgress = (done: number) => this.progress({ cardId, phase: 'encoding', done, total })
    onProgress(0)
    let frameCount = total
    try {
      if (ffmpeg) {
        await encodeMp4({ ffmpeg, frames, out: tmp, width, height, fps: TIMELAPSE_FPS, bitrate: TIMELAPSE_BITRATE, onProgress })
      } else {
        const r = await encodeWebm({ frames, width, height, fps: TIMELAPSE_FPS, bitrate: TIMELAPSE_BITRATE, onProgress })
        frameCount = r.frameCount
        this.progress({ cardId, phase: 'saving', done: total, total })
        await writeFile(tmp, r.data)
      }
      // Replace any older video of this card (either format).
      for (const f of ['mp4', 'webm'] as TimelapseFormat[]) await this.removeFiles(timelapsePath(this.root, cardId, card.startTs, f))
      renameSync(tmp, out)
    } catch (err) {
      await rm(tmp, { force: true })
      return fail(`Couldn't create the timelapse: ${err instanceof Error ? err.message : String(err)}`)
    }
    const sidecar: Sidecar = {
      frameCount,
      fps: TIMELAPSE_FPS,
      durationSeconds: frameCount / TIMELAPSE_FPS,
      createdAt: Math.floor(Date.now() / 1000),
      startTs: card.startTs,
      endTs: card.endTs,
    }
    await writeFile(out.replace(/\.(mp4|webm)$/, '.json'), JSON.stringify(sidecar, null, 2))
    await this.purge(out).catch((e) => console.error('[timelapse] purge failed', e))
    const info = this.info(cardId)
    if (!info) return fail('The timelapse could not be found after saving it.')
    this.progress({ cardId, phase: 'done', done: total, total })
    await stat(info.path)
    return info
  }
}
