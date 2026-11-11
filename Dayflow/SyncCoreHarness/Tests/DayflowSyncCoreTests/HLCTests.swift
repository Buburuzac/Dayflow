import XCTest

@testable import DayflowSyncCore

final class HLCTests: XCTestCase {
  /// sync.test.ts — "hlc: monotonic ticks, string order, observe advances past remote clocks"
  func testMonotonicTicksStringOrderAndObserve() {
    final class Clock { var now: Int64 = 1_700_000_000_000 }
    let clock = Clock()
    let a = Hlc("dev-a", now: { clock.now })
    let h1 = a.tick()
    let h2 = a.tick()
    XCTAssertGreaterThan(h2, h1, "same ms → counter increments")
    clock.now += 5
    let h3 = a.tick()
    XCTAssertGreaterThan(h3, h2)
    XCTAssertEqual(parseHlc(h3), ParsedHLC(ms: clock.now, counter: 0, deviceId: "dev-a"))
    // A remote clock 10 s ahead: our next tick must sort after it.
    let remote = formatHlc(clock.now + 10_000, 3, "dev-b")
    a.observe(remote)
    let h4 = a.tick()
    XCTAssertGreaterThan(h4, remote)
    // Clock going backwards never produces a smaller HLC.
    clock.now -= 60_000
    XCTAssertGreaterThan(a.tick(), h4)
    XCTAssertNil(parseHlc("garbage"))
    XCTAssertLessThan(formatHlc(5, 0, "x"), formatHlc(10, 0, "x"), "zero-padded so string order = time order")
  }

  func testFormatMatchesWindows() {
    XCTAssertEqual(formatHlc(1_762_588_800_000, 26, "abc"), "1762588800000-001a-abc")
    XCTAssertEqual(formatHlc(5, 0, "d"), "0000000000005-0000-d")
    XCTAssertEqual(parseHlc("1762588800000-001a-a-b-c"), ParsedHLC(ms: 1_762_588_800_000, counter: 26, deviceId: "a-b-c"))
    XCTAssertNil(parseHlc("1762588800000-001A-x"), "upper-case hex is not an HLC")
    XCTAssertNil(parseHlc("176258880000-0001-x"))
  }
}
