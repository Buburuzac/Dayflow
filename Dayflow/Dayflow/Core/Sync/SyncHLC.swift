//
//  SyncHLC.swift
//  Dayflow — Dayflow Sync client core
//
//  Hybrid logical clock, identical to windows/src/shared/sync-types.ts:
//  "<unix ms, 13 digits>-<counter, 4 hex>-<deviceId>", ordered by plain string compare.
//

import Foundation

struct ParsedHLC: Equatable {
  let ms: Int64
  let counter: Int
  let deviceId: String
}

func formatHlc(_ ms: Int64, _ counter: Int, _ deviceId: String) -> String {
  let m = String(max(0, ms))
  let padded = String(repeating: "0", count: max(0, 13 - m.count)) + m
  let hex = String(max(0, counter), radix: 16)
  let paddedHex = String(repeating: "0", count: max(0, 4 - hex.count)) + hex
  return "\(padded)-\(paddedHex)-\(deviceId)"
}

/// `^(\d{13})-([0-9a-f]{4})-(.+)$`
func parseHlc(_ hlc: String) -> ParsedHLC? {
  let chars = Array(hlc.utf8)
  guard chars.count >= 13 + 1 + 4 + 1 + 1 else { return nil }
  for i in 0..<13 where !(chars[i] >= 0x30 && chars[i] <= 0x39) { return nil }
  guard chars[13] == 0x2D else { return nil }
  for i in 14..<18 {
    let c = chars[i]
    let ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)
    if !ok { return nil }
  }
  guard chars[18] == 0x2D else { return nil }
  let msText = String(decoding: chars[0..<13], as: UTF8.self)
  let ctrText = String(decoding: chars[14..<18], as: UTF8.self)
  let dev = String(decoding: chars[19...], as: UTF8.self)
  guard !dev.isEmpty, let ms = Int64(msText), let ctr = Int(ctrText, radix: 16) else { return nil }
  // `.+` in JS does not match line terminators.
  if dev.contains("\n") || dev.contains("\r") { return nil }
  return ParsedHLC(ms: ms, counter: ctr, deviceId: dev)
}

/// Milliseconds since 1970 (`Date.now()`).
func syncNowMs() -> Int64 {
  Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
}

/// Hybrid logical clock: monotonic per device, advanced by observed remote clocks.
/// Not thread-safe on its own; `SyncLocal` serialises access.
final class Hlc {
  private var ms: Int64 = 0
  private var counter = 0
  let deviceId: String
  private let now: () -> Int64

  init(_ deviceId: String, now: @escaping () -> Int64 = syncNowMs) {
    self.deviceId = deviceId
    self.now = now
  }

  func tick() -> String {
    let t = now()
    if t > ms {
      ms = t
      counter = 0
    } else {
      counter += 1
    }
    return formatHlc(ms, counter, deviceId)
  }

  /// Call with every HLC received from the server so local clocks never fall behind.
  func observe(_ remote: String) {
    guard let r = parseHlc(remote) else { return }
    let t = now()
    let mx = max(t, ms, r.ms)
    if mx == ms && mx == r.ms {
      counter = max(counter, r.counter) + 1
    } else if mx == ms {
      counter += 1
    } else if mx == r.ms {
      counter = r.counter + 1
    } else {
      counter = 0
    }
    ms = mx
  }
}

func maxHlc(_ values: [String]) -> String {
  var m = ""
  for v in values where v > m { m = v }
  return m
}
