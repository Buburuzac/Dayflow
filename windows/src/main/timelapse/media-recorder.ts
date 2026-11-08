// WebM encoding without ffmpeg: a hidden BrowserWindow draws each frame onto a canvas and
// records the canvas stream with MediaRecorder. Frames are shown for 1/fps seconds each, so
// encoding runs in real time (a 90-frame card takes about 45 s at 2 fps).
// Frames are passed in as data: URLs so the canvas is never tainted.

import { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { trackAux } from '../flow/app-windows.ts'
import { setWebmDuration } from './webm.ts'

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:#000"><canvas id="c"></canvas></body></html>')

const SCRIPT = String.raw`
window.__tl = (() => {
  let c, ctx, track, rec, chunks = [], width = 0, height = 0, interval = 500, last = 0, stopped
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function load(url) {
    const img = new Image()
    img.src = url
    try { await img.decode(); return img } catch { return null }
  }
  function draw(img) {
    const s = Math.min(width / img.naturalWidth, height / img.naturalHeight)
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s)
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h)
  }
  return {
    init(w, h, fps) {
      c = document.getElementById('c')
      c.width = w; c.height = h; width = w; height = h; interval = 1000 / fps
      ctx = c.getContext('2d')
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h)
      return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || ''
    },
    async frame(url, mime, bitrate) {
      const img = await load(url)
      if (!img) return false
      if (!rec) {
        // The canvas stream starts from whatever was composited last, so paint the first
        // frame and let it settle before the recorder starts (otherwise the video opens on black).
        draw(img)
        await sleep(150)
        const stream = c.captureStream(0)
        track = stream.getVideoTracks()[0]
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate })
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
        stopped = new Promise((r) => (rec.onstop = r))
        rec.start(1000)
        draw(img)
        track.requestFrame()
        last = performance.now()
        return true
      }
      const wait = interval - (performance.now() - last)
      if (wait > 0) await sleep(wait)
      draw(img)
      track.requestFrame()
      last = performance.now()
      return true
    },
    async finish() {
      // Hold the last frame for its full duration.
      const wait = interval - (performance.now() - last)
      if (wait > 0) await sleep(wait)
      track.requestFrame()
      await sleep(30)
      rec.stop()
      await stopped
      const blob = new Blob(chunks, { type: 'video/webm' })
      return new Uint8Array(await blob.arrayBuffer())
    },
  }
})(); true
`

export async function encodeWebm(opts: {
  frames: string[]
  width: number
  height: number
  fps: number
  bitrate: number
  onProgress: (done: number) => void
  isCancelled?: () => boolean
}): Promise<{ data: Uint8Array; frameCount: number }> {
  const win = trackAux(
    new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    }),
  )
  try {
    await win.loadURL(PAGE)
    await win.webContents.executeJavaScript(SCRIPT)
    const mime = (await win.webContents.executeJavaScript(`__tl.init(${opts.width}, ${opts.height}, ${opts.fps})`)) as string
    if (!mime) throw new Error('MediaRecorder cannot record WebM here')
    let drawn = 0
    for (let i = 0; i < opts.frames.length; i++) {
      if (opts.isCancelled?.()) throw new Error('cancelled')
      let url: string
      try {
        url = 'data:image/jpeg;base64,' + (await readFile(opts.frames[i])).toString('base64')
      } catch {
        continue // missing file: skip
      }
      if (await win.webContents.executeJavaScript(`__tl.frame(${JSON.stringify(url)}, ${JSON.stringify(mime)}, ${opts.bitrate})`)) drawn++
      opts.onProgress(i + 1)
    }
    if (!drawn) throw new Error('None of the screenshots could be decoded')
    const data = (await win.webContents.executeJavaScript('__tl.finish()')) as Uint8Array
    if (!data || !data.length) throw new Error('MediaRecorder produced no data')
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    // MediaRecorder leaves the duration out; players need it to show length and seek.
    return { data: setWebmDuration(bytes, (drawn / opts.fps) * 1000), frameCount: drawn }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
