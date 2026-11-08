// Timelapse videos (spec B): shared between src/main/timelapse and features/Timelapse.tsx.

import type { ScreenshotInfo } from './types.ts'

/** Saved card timelapses play at 2 fps: with 10 s captures that is 20× real time. */
export const TIMELAPSE_FPS = 2
export const TIMELAPSE_BITRATE = 2_000_000
export const TIMELAPSE_DEFAULT_LIMIT = 10_000_000_000
/** Storage cap options in bytes (spec B.3); 0 = unlimited. */
export const TIMELAPSE_LIMIT_OPTIONS = [1e9, 2e9, 3e9, 5e9, 10e9, 20e9, 0]

export type TimelapseFormat = 'mp4' | 'webm'

export interface TimelapseInfo {
  cardId: number
  path: string
  format: TimelapseFormat
  sizeBytes: number
  createdAt: number
  frameCount: number
  fps: number
  durationSeconds: number
}

export interface TimelapseCardInfo {
  id: number
  title: string
  startTs: number
  endTs: number
  startTime: string
  endTime: string
  category: string
}

export interface TimelapseCardData {
  card: TimelapseCardInfo | null
  frames: ScreenshotInfo[]
  video: TimelapseInfo | null
  generating: boolean
  /** True when ffmpeg is on PATH (MP4 output); otherwise videos are WebM. */
  ffmpeg: boolean
}

export interface TimelapseProgress {
  cardId: number
  phase: 'preparing' | 'encoding' | 'saving' | 'done' | 'error'
  done: number
  total: number
  error?: string
}

export interface TimelapseStorage {
  dir: string
  usedBytes: number
  /** 0 = unlimited */
  limitBytes: number
}
