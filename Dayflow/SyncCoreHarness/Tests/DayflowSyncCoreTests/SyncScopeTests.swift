//
//  Port of windows/tests/sync-scope.test.ts: the upload policy (excluded / full / out_of_scope),
//  scope clocks, observation upload switch, bookkeeping only for accepted changes.
//

import GRDB
import XCTest

@testable import DayflowSyncCore

final class SyncScopeTests: XCTestCase {
  var dir: URL!
  var store: MacStore!

  override func setUpWithError() throws {
    dir = try tempDir()
    store = try MacStore(dir: dir)
    try store.setSyncEnabled(true)
    store.local.policy = .default
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func card(_ start: Int64, _ end: Int64, _ title: String, _ category: String = "Work") -> TestCard {
    TestCard(startTs: start, endTs: end, title: title, category: category, subcategory: "dev", summary: "\(title) summary", detailedSummary: "details")
  }

  func liveCard(_ changes: [SyncChange]) -> SyncChange? { changes.first { $0.entity == .card && $0.deleted != true } }

  func testCardScopePersonalAndPrivateExcludedConfirmedProjectFullRestOutOfScope() {
    let p = SyncPolicy.default
    XCTAssertEqual(cardScope(category: "personal", isPrivate: false, hasConfirmedLiveProject: true, policy: p), .excluded)
    XCTAssertEqual(cardScope(category: "Work", isPrivate: true, hasConfirmedLiveProject: true, policy: p), .excluded)
    XCTAssertEqual(cardScope(category: "Work", isPrivate: false, hasConfirmedLiveProject: true, policy: p), .full)
    XCTAssertEqual(cardScope(category: "Work", isPrivate: false, hasConfirmedLiveProject: false, policy: p), .outOfScope)
    var noOOS = p
    noOOS.outOfScope = false
    XCTAssertEqual(cardScope(category: "Work", isPrivate: false, hasConfirmedLiveProject: false, policy: noOOS), .full)
    XCTAssertEqual(p, SyncPolicy(excludedCategories: ["Personal"], outOfScope: true, observations: false), "Windows defaults")
  }

  func testUnassignedWorkUploadsAsOutOfScopeConfirmingAProjectUploadsItInFullWithANewerClock() throws {
    let b = try store.createBatch(t9, t9 + 1800)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Fixed the Biosun invoice import")], batchId: b)
    let uuid = try store.cardsForDay("2026-11-08")[0].uuid!

    let first = liveCard(try store.flush())!
    XCTAssertEqual(first.title, OUT_OF_SCOPE_LABEL)
    XCTAssertEqual(first.str("summary"), "")
    XCTAssertEqual(first.str("detailedSummary"), "")
    XCTAssertEqual(first.str("category"), OUT_OF_SCOPE_LABEL)
    XCTAssertEqual(first.data?["metadata"], .object(["distractions": .array([]), "appSites": .null, "private": .bool(false)]))
    XCTAssertGreaterThan(first.data?["startTs"]?.intValue ?? 0, 0, "times are kept")

    // The local card keeps its real content.
    XCTAssertEqual(try store.cardsForDay("2026-11-08")[0].title, "Fixed the Biosun invoice import")

    let project = try store.db.write { db in
      try store.repo.saveProject(db, ProjectDraft(workspaceId: "ws", name: "Biosun", color: "#336699", defaultShare: .cards))
    }
    try store.db.write { try store.repo.setManualProject($0, cardUuid: uuid, projectId: project.id) }
    XCTAssertGreaterThanOrEqual(try store.rescope(), 1, "the card is re-queued once its scope changes")
    let second = liveCard(try store.flush())!
    XCTAssertEqual(second.title, "Fixed the Biosun invoice import")
    XCTAssertEqual(second.str("summary"), "Fixed the Biosun invoice import summary")
    XCTAssertGreaterThan(second.hlc, first.hlc, "record clock beats the redacted copy on the server")
    XCTAssertGreaterThan(second.fieldHlc!["title"]!, first.fieldHlc!["title"]!, "title clock beats the redacted title")

    // Archiving the project puts it back out of scope, again with a newer clock.
    try store.db.write { db in
      var p = try store.repo.project(db, project.id)!
      p.archived = true
      p.hlc = store.local.tick()
      try store.repo.putProject(db, p)
    }
    XCTAssertGreaterThanOrEqual(try store.rescope(), 1)
    let third = liveCard(try store.flush())!
    XCTAssertEqual(third.title, OUT_OF_SCOPE_LABEL)
    XCTAssertGreaterThan(third.fieldHlc!["title"]!, second.fieldHlc!["title"]!)
    XCTAssertEqual(try store.rescope(), 0, "nothing left to re-scope")
  }

  func testPersonalCardsAreWipedAndDeletedOnTheServerAndTheirProjectLinksStayLocal() throws {
    let b = try store.createBatch(t9, t9 + 1800)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Booked the dentist", "Personal")], batchId: b)
    let uuid = try store.cardsForDay("2026-11-08")[0].uuid!
    let project = try store.db.write { try store.repo.saveProject($0, ProjectDraft(workspaceId: "ws", name: "P", color: "#000000")) }
    try store.db.write { try store.repo.setManualProject($0, cardUuid: uuid, projectId: project.id) }
    let changes = try store.flush()
    let c = changes.first { $0.entity == .card }!
    XCTAssertEqual(c.deleted, true)
    XCTAssertEqual(c.title, OUT_OF_SCOPE_LABEL)
    XCTAssertEqual(c.str("summary"), "")
    XCTAssertFalse(changes.contains { $0.entity == .cardProject }, "no project link for a personal card")
  }

  func testOurOwnEchoNeverOverwritesTheFullLocalCard() throws {
    let b = try store.createBatch(t9, t9 + 1800)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Real title")], batchId: b)
    let echo = liveCard(try store.flush())!
    XCTAssertEqual(echo.title, OUT_OF_SCOPE_LABEL)
    _ = try store.db.write { try store.applier(userId: "user-1").applyCard($0, echo) }
    XCTAssertEqual(try store.cardsForDay("2026-11-08")[0].title, "Real title")
  }

  func testObservationsNotUploadedByDefaultSwitchingOffSendsTombstonesSwitchingOnRevives() throws {
    let b = try store.createBatch(t9, t9 + 900)
    let now = Int64(Date().timeIntervalSince1970)
    try store.saveObservations(batchId: b, [(now, now + 60, "chatting on WhatsApp")])
    XCTAssertFalse(try store.flush().contains { $0.entity == .observation }, "policy off: nothing uploaded")

    store.local.policy.observations = true
    XCTAssertEqual(try store.requeueObservations(upload: true), 1)
    let revived = try store.flush().filter { $0.entity == .observation }
    XCTAssertEqual(revived.count, 1)
    XCTAssertEqual(revived[0].str("text"), "chatting on WhatsApp")

    store.local.policy.observations = false
    XCTAssertEqual(try store.requeueObservations(upload: false), 1)
    let tomb = try store.flush().filter { $0.entity == .observation }
    XCTAssertEqual(tomb.count, 1)
    XCTAssertEqual(tomb[0].deleted, true)
    XCTAssertNil(tomb[0].data, "tombstones carry no text")
    XCTAssertGreaterThan(tomb[0].hlc, revived[0].hlc)
  }

  func testSwitchingObservationUploadOffRemovesEveryUploadedObservationHoweverOld() throws {
    store.local.policy.observations = true
    let old = Int64(Date().timeIntervalSince1970) - 120 * 86400  // four months ago, far outside any window
    let b = try store.createBatch(old, old + 900)
    try store.saveObservations(batchId: b, [(old, old + 60, "an old private chat")])
    XCTAssertEqual(try store.flush().filter { $0.entity == .observation }.count, 1)
    store.local.policy.observations = false
    XCTAssertEqual(try store.requeueObservations(upload: false), 1, "the old uploaded observation gets a tombstone")
    let tomb = try store.flush().filter { $0.entity == .observation }
    XCTAssertEqual(tomb.count, 1)
    XCTAssertEqual(tomb[0].deleted, true)
    XCTAssertEqual(try store.requeueObservations(upload: false), 0, "nothing left on the server to remove")
  }

  func testRejectedUploadIsNotRecordedSoTheCardIsRescopedAndResent() throws {
    let b = try store.createBatch(t9, t9 + 1800)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Unassigned work")], batchId: b)
    let batch = try store.buildBatch()
    try store.db.write { db in
      try commitAccepted(db, batch) { _ in false }  // the server rejected everything
      try store.repo.markPushed(db, batch.used)
    }
    XCTAssertGreaterThanOrEqual(try store.rescope(), 1, "still differs from what the server holds")
    _ = try store.flush()
    XCTAssertEqual(try store.rescope(), 0)
  }

  func testScopeChangeBumpsOnlyTheFieldsItRewrites() throws {
    let b = try store.createBatch(t9, t9 + 1800)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Work")], batchId: b)
    let first = liveCard(try store.flush())!
    // full → out_of_scope happened on first upload (never sent before = "full").
    XCTAssertGreaterThan(first.fieldHlc!["title"]!, first.fieldHlc!["private"]!, "title is re-clocked")
    XCTAssertEqual(first.fieldHlc!["private"], first.fieldHlc!["deleted"], "private and deleted keep their clocks")
  }

  // Mac-specific: a card marked private on this Mac becomes excluded (wiped + deleted remotely).
  func testMarkingACardPrivateWipesTheServerCopy() throws {
    store.local.policy.outOfScope = false
    let b = try store.createBatch(t9, t9 + 1800)
    let ids = try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Visible")], batchId: b)
    let first = liveCard(try store.flush())!
    XCTAssertEqual(first.title, "Visible")
    try store.db.write { try store.local.editCard($0, id: ids[0], isPrivate: true) }
    let second = try store.flush().first { $0.entity == .card }!
    XCTAssertEqual(second.deleted, true)
    XCTAssertEqual(second.title, OUT_OF_SCOPE_LABEL)
    XCTAssertGreaterThan(second.fieldHlc!["deleted"]!, first.fieldHlc!["deleted"]!)
    XCTAssertGreaterThan(second.fieldHlc!["private"]!, first.fieldHlc!["private"]!)
  }
}
