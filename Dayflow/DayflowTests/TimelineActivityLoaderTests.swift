import XCTest

@testable import Dayflow

final class TimelineActivityLoaderTests: XCTestCase {
  func testBuildActivitiesAlignsRemoteTimeFromAbsoluteTimestamp() {
    let start = ISO8601DateFormatter().date(from: "2026-11-07T20:00:00Z")!
    let card = TimelineCard(
      recordId: 7, batchId: nil, startTimestamp: "5:00 AM", endTimestamp: "6:00 AM",
      category: "Work", subcategory: "", title: "Tokyo work", summary: "",
      detailedSummary: "", day: "2026-11-08", distractions: nil,
      videoSummaryURL: nil, otherVideoSummaryURLs: nil, appSites: nil,
      startTs: Int(start.timeIntervalSince1970), endTs: Int(start.timeIntervalSince1970) + 3600)

    let activities = TimelineActivityLoader.buildActivities(from: [card])

    XCTAssertEqual(activities.count, 1)
    XCTAssertEqual(activities[0].startTime, start)
    XCTAssertEqual(activities[0].endTime, start.addingTimeInterval(3600))
  }

  func testResolveDisplaySegmentsGroupsConsecutiveFailures() {
    let activities = [
      activity(
        id: "failure-3", startMinute: 31, endMinute: 46, title: "Processing failed", batchId: 3),
      activity(
        id: "failure-1", startMinute: 0, endMinute: 15, title: "Processing failed", batchId: 1),
      activity(
        id: "failure-2", startMinute: 15, endMinute: 30, title: "Processing failed", batchId: 2),
    ]

    let segments = TimelineActivityLoader.resolveDisplaySegments(from: activities)

    XCTAssertEqual(segments.count, 1)
    XCTAssertEqual(segments[0].activity.id, "failure-1")
    XCTAssertEqual(segments[0].failureCount, 3)
    XCTAssertEqual(segments[0].batchIds, [1, 2, 3])
    XCTAssertEqual(segments[0].start, date(minute: 0))
    XCTAssertEqual(segments[0].end, date(minute: 46))
  }

  func testResolveDisplaySegmentsDoesNotGroupAcrossAnotherActivity() {
    let activities = [
      activity(
        id: "failure-1", startMinute: 0, endMinute: 15, title: "Processing failed", batchId: 1),
      activity(id: "idle", startMinute: 15, endMinute: 30, title: "Idle"),
      activity(
        id: "failure-2", startMinute: 30, endMinute: 45, title: "Processing failed", batchId: 2),
    ]

    let segments = TimelineActivityLoader.resolveDisplaySegments(from: activities)

    XCTAssertEqual(segments.count, 3)
    XCTAssertEqual(segments.map(\.failureCount), [1, 0, 1])
  }

  func testResolveDisplaySegmentsDoesNotGroupFailuresSeparatedByMoreThanOneMinute() {
    let activities = [
      activity(
        id: "failure-1", startMinute: 0, endMinute: 15, title: "Processing failed", batchId: 1),
      activity(
        id: "failure-2", startMinute: 17, endMinute: 32, title: "Processing failed", batchId: 2),
    ]

    let segments = TimelineActivityLoader.resolveDisplaySegments(from: activities)

    XCTAssertEqual(segments.count, 2)
    XCTAssertEqual(segments.map(\.failureCount), [1, 1])
  }

  private func activity(
    id: String,
    startMinute: Int,
    endMinute: Int,
    title: String,
    batchId: Int64? = nil
  ) -> TimelineActivity {
    TimelineActivity(
      id: id,
      recordId: nil,
      batchId: batchId,
      startTime: date(minute: startMinute),
      endTime: date(minute: endMinute),
      title: title,
      summary: "",
      detailedSummary: "",
      category: title == "Idle" ? "Idle" : "System",
      subcategory: "",
      distractions: nil,
      videoSummaryURL: nil,
      screenshot: nil,
      appSites: nil,
      isBackupGenerated: false
    )
  }

  private func date(minute: Int) -> Date {
    Date(timeIntervalSinceReferenceDate: TimeInterval(minute * 60))
  }
}
