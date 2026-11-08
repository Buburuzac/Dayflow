// MP4 encoding through an ffmpeg found on PATH (optional; no bundled dependency).

import { spawn } from 'node:child_process'
import { writeFile, rm } from 'node:fs/promises'
import { ffmpegArgs, ffmpegFrame, concatList } from './frames.ts'

let cached: Promise<string | null> | null = null

/** Absolute path of ffmpeg.exe on PATH, or null. Cached for the session. */
export function findFfmpeg(): Promise<string | null> {
  cached ??= new Promise((resolve) => {
    const child = spawn('where.exe', ['ffmpeg'], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l))
      resolve(code === 0 && first ? first : null)
    })
  })
  return cached
}

export async function encodeMp4(opts: {
  ffmpeg: string
  frames: string[]
  out: string
  width: number
  height: number
  fps: number
  bitrate: number
  onProgress: (done: number) => void
}): Promise<void> {
  const list = `${opts.out}.txt`
  await writeFile(list, concatList(opts.frames, opts.fps), 'utf8')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(opts.ffmpeg, ffmpegArgs(list, opts.out, opts.width, opts.height, opts.fps, opts.bitrate), {
        windowsHide: true,
      })
      let tail = ''
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        tail = (tail + d).slice(-4000)
        const f = ffmpegFrame(d.split('\r').pop() ?? '')
        if (f != null) opts.onProgress(Math.min(f, opts.frames.length))
      })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${tail.trim().split('\n').slice(-3).join(' ')}`)),
      )
    })
  } finally {
    await rm(list, { force: true })
  }
}
