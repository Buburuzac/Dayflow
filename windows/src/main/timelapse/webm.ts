// Adds (or fixes) Segment > Info > Duration in a WebM file. Chromium's MediaRecorder writes
// live-style WebM without a duration, which players show as unknown length and seek poorly.
// Pure: no Electron imports.

const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067
const ID_INFO = 0x1549a966
const ID_DURATION = 0x4489
const ID_TIMECODE_SCALE = 0x2ad7b1

interface VInt {
  value: number
  length: number
  unknown: boolean
}

function readId(b: Uint8Array, pos: number): { id: number; length: number } | null {
  const first = b[pos]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 4 || pos + length > b.length) return null
  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + b[pos + i]
  return { id, length }
}

function readSize(b: Uint8Array, pos: number): VInt | null {
  const first = b[pos]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8 || pos + length > b.length) return null
  let value = first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[pos + i]
    if (b[pos + i] !== 0xff) allOnes = false
  }
  return { value, length, unknown: allOnes }
}

/** 8-byte size field (0x01 + 7 bytes). */
function size8(n: number): Uint8Array {
  const out = new Uint8Array(8)
  out[0] = 0x01
  let v = n
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256
    v = Math.floor(v / 256)
  }
  return out
}

function writeSizeInPlace(b: Uint8Array, pos: number, length: number, value: number): boolean {
  if (value >= 2 ** (7 * length) - 1) return false
  let v = value
  for (let i = length - 1; i >= 1; i--) {
    b[pos + i] = v % 256
    v = Math.floor(v / 256)
  }
  b[pos] = (0x80 >> (length - 1)) | v
  return true
}

function float64(v: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setFloat64(0, v)
  return out
}

/** Returns WebM bytes whose Info carries `durationMs` (in TimecodeScale units, default 1 ms). */
export function setWebmDuration(input: Uint8Array, durationMs: number): Uint8Array {
  const b = input
  const header = readId(b, 0)
  if (!header || header.id !== ID_EBML) return input
  const hs = readSize(b, header.length)
  if (!hs) return input
  let pos = header.length + hs.length + hs.value
  const seg = readId(b, pos)
  if (!seg || seg.id !== ID_SEGMENT) return input
  const segSizePos = pos + seg.length
  const segSize = readSize(b, segSizePos)
  if (!segSize) return input
  pos = segSizePos + segSize.length
  const segEnd = segSize.unknown ? b.length : Math.min(b.length, pos + segSize.value)

  while (pos < segEnd) {
    const el = readId(b, pos)
    if (!el) return input
    const sz = readSize(b, pos + el.length)
    if (!sz) return input
    const dataStart = pos + el.length + sz.length
    if (el.id !== ID_INFO) {
      if (sz.unknown) return input // a live cluster before Info: give up
      pos = dataStart + sz.value
      continue
    }
    const infoEnd = dataStart + sz.value
    // Look for an existing Duration and the TimecodeScale.
    let scale = 1_000_000
    let p = dataStart
    let durationAt = -1
    let durationLen = 0
    while (p < infoEnd) {
      const c = readId(b, p)
      if (!c) break
      const cs = readSize(b, p + c.length)
      if (!cs) break
      const d = p + c.length + cs.length
      if (c.id === ID_TIMECODE_SCALE) {
        let v = 0
        for (let i = 0; i < cs.value; i++) v = v * 256 + b[d + i]
        if (v > 0) scale = v
      } else if (c.id === ID_DURATION) {
        durationAt = d
        durationLen = cs.value
      }
      p = d + cs.value
    }
    const value = (durationMs * 1_000_000) / scale
    if (durationAt >= 0 && (durationLen === 8 || durationLen === 4)) {
      const out = b.slice()
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
      if (durationLen === 8) view.setFloat64(durationAt, value)
      else view.setFloat32(durationAt, value)
      return out
    }
    const durationEl = new Uint8Array([0x44, 0x89, 0x88, ...float64(value)])
    const newInfoSize = sz.value + durationEl.length
    const newHeader = new Uint8Array([...b.slice(pos, pos + el.length), ...size8(newInfoSize)])
    const oldHeaderLen = el.length + sz.length
    const delta = newHeader.length + newInfoSize - (oldHeaderLen + sz.value)
    const out = new Uint8Array(b.length + delta)
    out.set(b.subarray(0, pos), 0)
    out.set(newHeader, pos)
    out.set(b.subarray(dataStart, infoEnd), pos + newHeader.length)
    out.set(durationEl, pos + newHeader.length + sz.value)
    out.set(b.subarray(infoEnd), pos + newHeader.length + newInfoSize)
    if (!segSize.unknown && !writeSizeInPlace(out, segSizePos, segSize.length, segSize.value + delta)) return input
    return out
  }
  return input
}

/** Reads Segment > Info > Duration in milliseconds, or null. (Used by tests.) */
export function readWebmDurationMs(b: Uint8Array): number | null {
  const header = readId(b, 0)
  if (!header || header.id !== ID_EBML) return null
  const hs = readSize(b, header.length)
  if (!hs) return null
  let pos = header.length + hs.length + hs.value
  const seg = readId(b, pos)
  if (!seg || seg.id !== ID_SEGMENT) return null
  const ss = readSize(b, pos + seg.length)
  if (!ss) return null
  pos += seg.length + ss.length
  while (pos < b.length) {
    const el = readId(b, pos)
    const sz = el && readSize(b, pos + el.length)
    if (!el || !sz) return null
    const d = pos + el.length + sz.length
    if (el.id === ID_INFO) {
      let p = d
      let scale = 1_000_000
      let dur: number | null = null
      while (p < d + sz.value) {
        const c = readId(b, p)
        const cs = c && readSize(b, p + c.length)
        if (!c || !cs) break
        const cd = p + c.length + cs.length
        const view = new DataView(b.buffer, b.byteOffset + cd, cs.value)
        if (c.id === ID_TIMECODE_SCALE) {
          let v = 0
          for (let i = 0; i < cs.value; i++) v = v * 256 + b[cd + i]
          scale = v || scale
        } else if (c.id === ID_DURATION) dur = cs.value === 8 ? view.getFloat64(0) : view.getFloat32(0)
        p = cd + cs.value
      }
      return dur == null ? null : (dur * scale) / 1_000_000
    }
    if (sz.unknown) return null
    pos = d + sz.value
  }
  return null
}
