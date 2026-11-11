import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crossDeviceOverlapIds } from '../src/renderer/src/timeline-layout.ts'

test('synced cards use the full timeline width until they overlap local work', () => {
  const local = { id: 1, startTs: 100, endTs: 200, remote: false }
  const remoteEarlier = { id: 2, startTs: 20, endTs: 80, remote: true }
  const remoteOverlapping = { id: 3, startTs: 150, endTs: 250, remote: true }
  const remoteLater = { id: 4, startTs: 250, endTs: 300, remote: true }

  assert.deepEqual([...crossDeviceOverlapIds([remoteEarlier, remoteLater])], [])
  assert.deepEqual([...crossDeviceOverlapIds([local, remoteEarlier, remoteOverlapping, remoteLater])].sort(), [1, 3])
})
