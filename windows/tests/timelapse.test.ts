import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  canvasSize,
  concatList,
  ffmpegArgs,
  ffmpegFrame,
  fitRect,
  jpegSize,
  localDay,
  purgePlan,
  sampleFrames,
  timelapsePath,
} from '../src/main/timelapse/frames.ts'
import { readWebmDurationMs, setWebmDuration } from '../src/main/timelapse/webm.ts'

test('frame selection: chronological, every stride-th', () => {
  const shots = [5, 1, 3, 2, 4].map((t) => ({ capturedAt: t, filePath: `f${t}.jpg` }))
  assert.deepEqual(sampleFrames(shots).map((s) => s.capturedAt), [1, 2, 3, 4, 5])
  assert.deepEqual(sampleFrames(shots, 2).map((s) => s.capturedAt), [1, 3, 5])
  assert.deepEqual(sampleFrames(shots, 0).length, 5)
})

test('canvas size is even and capped to the max height', () => {
  assert.deepEqual(canvasSize(1921, 1081), { width: 1920, height: 1080 })
  assert.deepEqual(canvasSize(1920, 1080, 720), { width: 1280, height: 720 })
  assert.deepEqual(canvasSize(1, 1), { width: 2, height: 2 })
  assert.deepEqual(canvasSize(3440, 1440, 720), { width: 1720, height: 720 })
})

test('frames are aspect-fit and centered', () => {
  assert.deepEqual(fitRect(1280, 1024, 1920, 1080), { x: 285, y: 0, w: 1350, h: 1080 })
  assert.deepEqual(fitRect(3840, 1080, 1920, 1080), { x: 0, y: 270, w: 1920, h: 540 })
})

test('jpegSize reads the SOF header and rejects non-JPEG data', () => {
  // SOI, APP0 (len 16), SOF0 (len 17) with height 720 and width 1280.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)]
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const jpeg = new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9])
  assert.deepEqual(jpegSize(jpeg), { width: 1280, height: 720 })
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null)
  assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0, 0, 0, 0])), null)
})

test('ffconcat list and ffmpeg arguments', () => {
  assert.equal(
    concatList(['C:\\rec\\a.jpg', "C:\\rec\\it's.jpg"], 2),
    "ffconcat version 1.0\nfile 'C:/rec/a.jpg'\nduration 0.5\nfile 'C:/rec/it'\\''s.jpg'\nduration 0.5\n",
  )
  const args = ffmpegArgs('list.txt', 'out.mp4', 1920, 1080, 2, 2_000_000)
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'libx264'])
  assert.equal(args[args.indexOf('-g') + 1], '20', 'keyframe every fps × 10 s')
  assert.equal(args[args.indexOf('-b:v') + 1], '2000000')
  assert.ok(args[args.indexOf('-vf') + 1].startsWith('scale=1920:1080:force_original_aspect_ratio=decrease'))
  assert.equal(args.at(-1), 'out.mp4')
  assert.equal(ffmpegArgs('l', 'o', 2, 2, 2, 10)[ffmpegArgs('l', 'o', 2, 2, 2, 10).indexOf('-b:v') + 1], '100000', 'bitrate floor')
  assert.equal(ffmpegFrame('frame=   42 fps=0.0 q=28.0 size='), 42)
  assert.equal(ffmpegFrame('Input #0'), null)
})

test('timelapse path uses the local day of the card start', () => {
  const ts = Math.floor(new Date(2026, 10, 8, 2, 30).getTime() / 1000)
  assert.equal(localDay(ts), '2026-11-08')
  assert.equal(timelapsePath('C:\\tl', 42, ts, 'mp4'), join('C:\\tl', '2026-11-08', '42_timelapse.mp4'))
})

test('purge deletes the oldest entries until under the cap; 0 = unlimited', () => {
  const e = [
    { path: 'c', sizeBytes: 4, time: 30 },
    { path: 'a', sizeBytes: 5, time: 10 },
    { path: 'b', sizeBytes: 3, time: 20 },
  ]
  assert.deepEqual(purgePlan(e, 12).map((x) => x.path), [], 'under the cap')
  assert.deepEqual(purgePlan(e, 7).map((x) => x.path), ['a'])
  assert.deepEqual(purgePlan(e, 4).map((x) => x.path), ['a', 'b'])
  assert.deepEqual(purgePlan(e, 1).map((x) => x.path), ['a', 'b', 'c'])
  assert.deepEqual(purgePlan(e, 0), [])
})

// Minimal MediaRecorder-style WebM: EBML header, Segment of unknown size, Info, Cluster.
function webm(segmentSize: number[] = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]): Uint8Array {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01]
  // Info (size 7) holding TimecodeScale = 1,000,000 (3-byte id, 1-byte size, 3-byte value).
  const info = [0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00]
  return new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, ...segmentSize, ...info, ...cluster])
}

test('WebM duration is added to Info, keeping the rest intact', () => {
  const src = webm()
  assert.equal(readWebmDurationMs(src), null)
  const out = setWebmDuration(src, 45_000)
  assert.equal(out.length, src.length + 11 + 7, 'Duration element (11 bytes) + 8-byte Info size instead of 1')
  assert.equal(readWebmDurationMs(out), 45_000)
  // The cluster bytes are unchanged at the end.
  assert.deepEqual([...out.slice(-15)], [...src.slice(-15)])
  // Running it again overwrites in place.
  const again = setWebmDuration(out, 3000)
  assert.equal(again.length, out.length)
  assert.equal(readWebmDurationMs(again), 3000)
})

test('WebM with a known segment size gets its size bumped; non-WebM is returned as is', () => {
  const infoAndCluster = 12 + 15
  const src = webm([0x40, infoAndCluster])
  const out = setWebmDuration(src, 1000)
  assert.equal(readWebmDurationMs(out), 1000)
  // Segment id at bytes 9-12, its 2-byte size at 13-14.
  assert.deepEqual([out[13], out[14]], [0x40, infoAndCluster + 18], 'segment size grew by the inserted bytes')
  const junk = new Uint8Array([1, 2, 3])
  assert.equal(setWebmDuration(junk, 1000), junk)
})

test('purge plan never picks kept entries but counts them', () => {
  const e = [
    { path: 'new', sizeBytes: 5, time: 1, keep: true },
    { path: 'a', sizeBytes: 3, time: 2 },
    { path: 'b', sizeBytes: 3, time: 3 },
  ]
  assert.deepEqual(purgePlan(e, 8).map((x) => x.path), ['a'])
  assert.deepEqual(purgePlan(e, 1).map((x) => x.path), ['a', 'b'], 'kept entry survives even over the cap')
})
