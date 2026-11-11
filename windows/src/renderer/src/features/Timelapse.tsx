// Card timelapse: a button for the card detail panel that opens the screenshot slideshow
// (ScreenshotSlideshowModal) and lets the user turn it into a saved video (MP4 with ffmpeg,
// WebM otherwise) with play / Save as… / Show in folder actions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScreenshotInfo } from '../../../shared/types.ts'
import type { TimelapseCardData, TimelapseInfo, TimelapseProgress } from '../../../shared/timelapse-types.ts'
import { clock24 } from '../dates.ts'
import './timelapse.css'

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)
const SPEEDS = [20, 40, 60]
const SPEED_KEY = 'activitySlideshowPlaybackSpeedX'
const VIDEO_RATES = [1, 2, 3]

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
const shortTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

function useProgress(cardId: number): [TimelapseProgress | null, (p: TimelapseProgress | null) => void] {
  const [p, setP] = useState<TimelapseProgress | null>(null)
  useEffect(() => {
    setP(null)
    return window.dayflow.on('timelapse:progress', (raw) => {
      const next = raw as TimelapseProgress
      if (next.cardId === cardId) setP(next)
    })
  }, [cardId])
  return [p, setP]
}

export function TimelapseButton({ cardId }: { cardId: number }) {
  const [open, setOpen] = useState(false)
  const [video, setVideo] = useState<TimelapseInfo | null>(null)
  const [progress] = useProgress(cardId)

  const refresh = useCallback(() => {
    void call<TimelapseInfo | null>('timelapse:info', cardId).then(setVideo).catch(() => setVideo(null))
  }, [cardId])
  useEffect(refresh, [refresh])
  useEffect(() => {
    if (progress?.phase === 'done') refresh()
  }, [progress?.phase, refresh])

  const busy = progress && (progress.phase === 'preparing' || progress.phase === 'encoding' || progress.phase === 'saving')
  return (
    <div className="tlx-button-row">
      <button className="btn ghost tlx-open" onClick={() => setOpen(true)} title="Play this activity's screenshots as a timelapse">
        ▶ Timelapse
      </button>
      {busy ? (
        <span className="tlx-note">Creating video… {progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : ''}</span>
      ) : video ? (
        <span className="tlx-note">
          Video saved · {fmtBytes(video.sizeBytes)}
          <button className="link-btn" onClick={() => void call('timelapse:saveAs', cardId)}>
            Save as…
          </button>
        </span>
      ) : null}
      {open && <TimelapseModal cardId={cardId} onClose={() => { setOpen(false); refresh() }} />}
    </div>
  )
}

function TimelapseModal({ cardId, onClose }: { cardId: number; onClose: () => void }) {
  const [data, setData] = useState<TimelapseCardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'slideshow' | 'video'>('slideshow')
  const [progress, setProgress] = useProgress(cardId)

  const load = useCallback(() => {
    void call<TimelapseCardData>('timelapse:card', cardId)
      .then((d) => {
        setData(d)
        if (!d.card) setError('Could not find this activity in storage.')
        else if (!d.frames.length) setError('No screenshots are available for this activity range.')
      })
      .catch((e) => setError(String(e?.message ?? e)))
  }, [cardId])
  useEffect(load, [load])
  useEffect(() => {
    if (progress?.phase === 'done') {
      load()
      setMode('video')
    }
  }, [progress?.phase, load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const generate = async () => {
    setProgress({ cardId, phase: 'preparing', done: 0, total: 0 })
    try {
      await call<TimelapseInfo>('timelapse:generate', cardId, !!data?.video)
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      setProgress({ cardId, phase: 'error', done: 0, total: 0, error: msg })
    }
  }

  const busy = progress && (progress.phase === 'preparing' || progress.phase === 'encoding' || progress.phase === 'saving')
  const card = data?.card
  return createPortal(
    <div className="tlx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tlx-modal" role="dialog" aria-label="Timelapse">
        <header className="tlx-header">
          <div>
            <div className="tlx-title">{card?.title ?? 'Timelapse'}</div>
            {card && (
              <div className="tlx-sub">
                {clock24(card.startTs)} to {clock24(card.endTs)}
                {data && data.frames.length > 0 && ` · ${data.frames.length} screenshots`}
              </div>
            )}
          </div>
          <div className="tlx-header-actions">
            {data?.video && (
              <div className="tlx-tabs">
                <button className={mode === 'slideshow' ? 'on' : ''} onClick={() => setMode('slideshow')}>
                  Slideshow
                </button>
                <button className={mode === 'video' ? 'on' : ''} onClick={() => setMode('video')}>
                  Video
                </button>
              </div>
            )}
            <button className="tlx-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        {error ? (
          <div className="tlx-stage tlx-message">{error}</div>
        ) : !data ? (
          <div className="tlx-stage tlx-message">Preparing timelapse...</div>
        ) : mode === 'video' && data.video ? (
          <VideoPlayer key={data.video.createdAt} cardId={cardId} video={data.video} />
        ) : (
          <Slideshow frames={data.frames} />
        )}

        <footer className="tlx-footer">
          {busy ? (
            <div className="tlx-progress">
              <span>
                {progress.phase === 'preparing'
                  ? 'Preparing frames…'
                  : progress.phase === 'saving'
                    ? 'Saving…'
                    : `Creating video… ${progress.done} / ${progress.total} frames`}
              </span>
              <div className="tlx-bar">
                <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 3}%` }} />
              </div>
            </div>
          ) : (
            <>
              {progress?.phase === 'error' && <span className="tlx-error">{progress.error}</span>}
              {data && data.frames.length > 0 && (
                <button className="btn ghost" onClick={() => void generate()}>
                  {data.video ? 'Recreate video' : 'Create video'}
                </button>
              )}
              {data?.video && (
                <>
                  <button className="btn ghost" onClick={() => void call('timelapse:saveAs', cardId)}>
                    Save as…
                  </button>
                  <button className="btn ghost" onClick={() => void call('timelapse:showInFolder', cardId)}>
                    Show in folder
                  </button>
                </>
              )}
              <button className="link-btn" onClick={() => void call('timelapse:openFolder')}>
                Open timelapses folder
              </button>
              <span className="tlx-spacer" />
              {data?.video ? (
                <span className="tlx-note">
                  {data.video.format.toUpperCase()} · {fmtBytes(data.video.sizeBytes)} · {Math.round(data.video.durationSeconds)} s
                </span>
              ) : (
                data && <span className="tlx-note">{data.ffmpeg ? 'Saves an MP4 (ffmpeg)' : 'Saves a WebM video; creating it takes about half a second per screenshot'}</span>
              )}
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- Slideshow

function Slideshow({ frames }: { frames: ScreenshotInfo[] }) {
  const first = frames[0]?.capturedAt ?? 0
  const offsets = useMemo(() => frames.map((f) => f.capturedAt - first), [frames, first])
  const end = offsets[offsets.length - 1] ?? 0
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [scrubbing, setScrubbing] = useState(false)
  const [speed, setSpeed] = useState(() => {
    const v = Number(localStorage.getItem(SPEED_KEY))
    return SPEEDS.includes(v) ? v : 20
  })
  const timeRef = useRef(0)
  timeRef.current = time

  // Playback: advance delta × speed per display frame (delta capped at 0.1 s), loop at the end.
  useEffect(() => {
    if (!playing || scrubbing || frames.length < 2) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000)
      last = now
      let t = timeRef.current + delta * speed
      if (t > end + 10) t = 0
      setTime(t)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, scrubbing, speed, end, frames.length])

  // Last frame whose offset ≤ time.
  const index = useMemo(() => {
    let lo = 0
    let hi = offsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= time) lo = mid
      else hi = mid - 1
    }
    return Math.max(0, lo)
  }, [offsets, time])

  // Prefetch two frames ahead.
  useEffect(() => {
    for (const f of frames.slice(index + 1, index + 3)) {
      const img = new Image()
      img.src = window.dayflow.imageUrl(f.filePath)
    }
  }, [index, frames])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (e.key !== ' ' || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'))) return
      e.preventDefault()
      setPlaying((p) => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]
    setSpeed(next)
    localStorage.setItem(SPEED_KEY, String(next))
  }

  const frame = frames[index]
  if (!frame) return <div className="tlx-stage tlx-message">No screenshots are available for this activity range.</div>
  const progress = end > 0 ? Math.min(1, time / end) : 0
  return (
    <>
      <div className="tlx-stage" onClick={() => setPlaying((p) => !p)}>
        <img src={window.dayflow.imageUrl(frame.filePath)} alt="" draggable={false} />
        {!playing && <div className="tlx-play">▶</div>}
        <button
          className="tlx-speed"
          onClick={(e) => {
            e.stopPropagation()
            cycleSpeed()
          }}
          title="Playback speed"
        >
          {speed}x
        </button>
      </div>
      <Filmstrip
        frames={frames}
        progress={progress}
        label={shortTime(first + progress * end)}
        onScrub={(p, active) => {
          setScrubbing(active)
          setTime(p * end)
        }}
      />
    </>
  )
}

function Filmstrip({
  frames,
  progress,
  label,
  onScrub,
}: {
  frames: ScreenshotInfo[]
  progress: number
  label: string
  onScrub: (progress: number, active: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const tileW = (64 * 16) / 9
  const count = Math.max(1, Math.ceil(width / tileW))
  const tiles = useMemo(
    () => Array.from({ length: count }, (_, i) => frames[Math.min(frames.length - 1, Math.floor((i / count) * frames.length))]),
    [count, frames],
  )
  const seek = (clientX: number, active: boolean) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    onScrub(Math.min(1, Math.max(0, (clientX - r.left) / r.width)), active)
  }
  return (
    <div className="tlx-strip-wrap">
      <div
        className="tlx-strip"
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seek(e.clientX, true)
        }}
        onPointerMove={(e) => e.buttons === 1 && seek(e.clientX, true)}
        onPointerUp={(e) => seek(e.clientX, false)}
      >
        {tiles.map((f, i) => (
          <img key={i} src={window.dayflow.imageUrl(f.filePath)} alt="" draggable={false} style={{ width: `${100 / count}%` }} />
        ))}
        <div className="tlx-playhead" style={{ left: `${progress * 100}%` }}>
          <span className="tlx-chip">{label}</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Saved video

function VideoPlayer({ cardId, video }: { cardId: number; video: TimelapseInfo }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [rate, setRate] = useState(1)
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let revoked: string | null = null
    void call<Uint8Array | null>('timelapse:read', cardId).then((bytes) => {
      if (!bytes) return setFailed(true)
      const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: video.format === 'mp4' ? 'video/mp4' : 'video/webm' }))
      revoked = u
      setUrl(u)
    })
    return () => {
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [cardId, video.format])

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate
  }, [rate, url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !ref.current) return
      e.preventDefault()
      if (ref.current.paused) void ref.current.play()
      else ref.current.pause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (failed) {
    return (
      <div className="tlx-stage tlx-message">
        <div>
          Can't play the video here.
          <div>
            <button className="btn" onClick={() => void call('timelapse:open', cardId)}>
              Open in your video player
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="tlx-stage video">
      {url && <video ref={ref} src={url} controls autoPlay loop onError={() => setFailed(true)} />}
      <button
        className="tlx-speed"
        onClick={() => setRate((r) => VIDEO_RATES[(VIDEO_RATES.indexOf(r) + 1) % VIDEO_RATES.length])}
        title="Playback speed"
      >
        {rate * 20}x
      </button>
    </div>
  )
}
