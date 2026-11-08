// Pure helpers for timelapse generation (VideoProcessingService / TimelapseStorageManager).
// No Electron imports.

import { join } from 'node:path'

export interface FrameSource {
  capturedAt: number
  filePath: string
}

/** Every `stride`-th screenshot, chronological. */
export function sampleFrames<T extends FrameSource>(shots: T[], stride = 1): T[] {
  const s = Math.max(1, Math.floor(stride))
  return [...shots].sort((a, b) => a.capturedAt - b.capturedAt).filter((_, i) => i % s === 0)
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

/** Output canvas: first frame's size made even (≥2), scaled down to `maxHeight` if taller. */
export function canvasSize(width: number, height: number, maxHeight?: number | null): { width: number; height: number } {
  let w = width
  let h = height
  if (maxHeight && h > maxHeight) {
    w = Math.round((w * maxHeight) / h)
    h = maxHeight
  }
  return { width: even(w), height: even(h) }
}

/** Aspect-fit rectangle of a frame inside the canvas (centered, letterboxed). */
export function fitRect(fw: number, fh: number, cw: number, ch: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(cw / fw, ch / fh)
  const w = Math.round(fw * scale)
  const h = Math.round(fh * scale)
  return { x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w, h }
}

/** Width/height from a JPEG's SOF marker, or null when the data isn't a readable JPEG. */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xff) {
      i++
      continue
    }
    const len = (buf[i + 2] << 8) | buf[i + 3]
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = (buf[i + 5] << 8) | buf[i + 6]
      const width = (buf[i + 7] << 8) | buf[i + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (marker === 0xda || len < 2) return null
    i += 2 + len
  }
  return null
}

/** ffconcat list showing each frame for 1/fps seconds. */
export function concatList(paths: string[], fps: number): string {
  const d = (1 / fps).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  const q = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
  const lines = ['ffconcat version 1.0']
  for (const p of paths) lines.push(`file ${q(p)}`, `duration ${d}`)
  return lines.join('\n') + '\n'
}

export function ffmpegArgs(listFile: string, out: string, width: number, height: number, fps: number, bitrate: number, keyframeSeconds = 10): string[] {
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease:out_range=tv,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},format=yuv420p`
  return [
    '-hide_banner', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'high',
    '-b:v', String(Math.max(100_000, bitrate)),
    '-g', String(Math.max(1, Math.round(fps * keyframeSeconds))),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ]
}

/** Local yyyy-MM-dd of a unix timestamp. */
export function localDay(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** <root>/yyyy-MM-dd/<cardId>_timelapse.<ext> (date = card start, local). */
export function timelapsePath(root: string, cardId: number, startTs: number, ext: string): string {
  return join(root, localDay(startTs), `${cardId}_timelapse.${ext}`)
}

export interface StorageEntry {
  path: string
  sizeBytes: number
  /** ms, creation or modification time */
  time: number
  /** Counts toward usage but is never deleted (the video just written, an active job's files). */
  keep?: boolean
}

/** Entries (one per video) to delete, oldest first, until usage is under the limit (0 = unlimited). */
export function purgePlan(entries: StorageEntry[], limitBytes: number): StorageEntry[] {
  if (!limitBytes || limitBytes <= 0) return []
  let used = entries.reduce((a, e) => a + e.sizeBytes, 0)
  if (used <= limitBytes) return []
  const out: StorageEntry[] = []
  for (const e of [...entries].sort((a, b) => a.time - b.time)) {
    if (used <= limitBytes) break
    if (e.keep) continue
    out.push(e)
    used -= e.sizeBytes
  }
  return out
}

/** Parses the frame counter out of an ffmpeg progress line ("frame=  123 fps=..."). */
export function ffmpegFrame(line: string): number | null {
  const m = /frame=\s*(\d+)/.exec(line)
  return m ? Number(m[1]) : null
}
