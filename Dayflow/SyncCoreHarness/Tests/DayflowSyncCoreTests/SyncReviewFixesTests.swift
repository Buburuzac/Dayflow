//
//  Tests of the code-review fixes shared with the Windows client (S1–S11) and the Mac-only core
//  fixes (device id applied with its transaction, set-based legacy backfill).
//

import GRDB
import XCTest

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@testable import DayflowSyncCore

/// MockSyncServer with a gate on /api/sync/pull: while `hold` is set, pulls wait (ignoring task
/// cancellation, like a request that is already on the wire) until `release()`.
final class GatedTransport: SyncHTTPTransport, @unchecked Sendable {
  let inner: MockSyncServer
  private let lock = NSLock()
  private var holding = false
  private var waiting = 0
  init(_ inner: MockSyncServer) { self.inner = inner }

  func hold() {
    lock.lock()
    holding = true
    lock.unlock()
  }
  func release() {
    lock.lock()
    holding = false
    lock.unlock()
  }
  var pullsWaiting: Int {
    lock.lock()
    defer { lock.unlock() }
    return waiting
  }
  private var isHolding: Bool {
    lock.lock()
    defer { lock.unlock() }
    return holding
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    if request.url?.path == "/api/sync/pull" && isHolding {
      // Read the server's answer now (it holds the other device's card), deliver it late.
      let res = try await inner.send(request)
      lock.lock()
      waiting += 1
      lock.unlock()
      while isHolding { try? await Task.sleep(nanoseconds: 10_000_000) }
      lock.lock()
      waiting -= 1
      lock.unlock()
      return res
    }
    return try await inner.send(request)
  }

  func streamLines(
    _ request: URLRequest, onOpen: @escaping @Sendable () -> Void, onLine: @escaping @Sendable (String) -> Void
  ) async throws {
    try await inner.streamLines(request, onOpen: onOpen, onLine: onLine)
  }
}

final class SyncReviewFixesTests: XCTestCase {
  var dir: URL!

  override func setUpWithError() throws { dir = try tempDir() }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

  func makeStore(_ name: String = "db", policy: SyncPolicy = .default) throws -> MacStore {
    let s = try MacStore(dir: dir, name: name)
    try s.setSyncEnabled(true)
    s.local.policy = policy
    return s
  }

  func card(_ start: Int64, _ end: Int64, _ title: String, _ category: String = "Work") -> TestCard {
    TestCard(startTs: start, endTs: end, title: title, category: category, subcategory: "dev", summary: "\(title) summary")
  }

  func liveCards(_ changes: [SyncChange]) -> [SyncChange] { changes.filter { $0.entity == .card } }

  // MARK: S1 / S11

  func testDeletedAndPrivateAreAlwaysSentAsBooleans() throws {
    let store = try makeStore()
    let b = try store.createBatch(t9, t9 + 1800)
    let id = try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Invoices")], batchId: b)[0]

    let first = liveCards(try store.flush())[0]
    XCTAssertEqual(first.deleted, false, "a live card says deleted = false")
    XCTAssertEqual(first.data?["metadata"]?["private"], .bool(false), "redacted form carries private = false")

    // Private: excluded, wiped and deleted on the server.
    try store.write { try store.local.editCard($0, id: id, isPrivate: true) }
    XCTAssertGreaterThanOrEqual(try store.rescope(), 0)
    let priv = liveCards(try store.flush())[0]
    XCTAssertEqual(priv.deleted, true)
    XCTAssertEqual(priv.data?["metadata"]?["private"], .bool(true))

    // Un-marked: back out of excluded, so the server must hear deleted = false and private = false.
    try store.write { try store.local.editCard($0, id: id, isPrivate: false) }
    _ = try store.rescope()
    let back = liveCards(try store.flush())[0]
    XCTAssertEqual(back.deleted, false, "leaving excluded un-deletes the server copy")
    XCTAssertEqual(back.data?["metadata"]?["private"], .bool(false), "un-marking private reaches the server")
    XCTAssertGreaterThan(back.fieldHlc!["private"]!, priv.fieldHlc!["private"]!)

    // In full (out-of-scope off) the flag is a boolean too.
    store.local.policy = SyncPolicy(excludedCategories: [], outOfScope: false, observations: false)
    _ = try store.rescope()
    let full = liveCards(try store.flush())[0]
    XCTAssertEqual(full.title, "Invoices")
    XCTAssertEqual(full.data?["metadata"]?["private"], .bool(false))
    XCTAssertEqual(full.deleted, false)
  }

  func testPrivateFalseReachesTheMockServer() async throws {
    let mock = MockSyncServer(devAuth: true)
    let A = try await makeDevice(dir, "desktop", url: "http://mock.local", transport: mock, policy: .shareAll)
    let b = try A.store.createBatch(t9, t9 + 1800)
    let id = try A.store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Design")], batchId: b)[0]
    _ = try await A.engine.signInDev(email: "a@x.test")
    try await A.engine.setCardPrivate(recordId: id, isPrivate: true)
    _ = await A.engine.syncNow()
    try await A.engine.setCardPrivate(recordId: id, isPrivate: false)
    _ = await A.engine.syncNow()
    let sent = mock.pushes.flatMap { $0 }.filter { $0.entity == .card }
    XCTAssertEqual(sent.last?.data?["metadata"]?["private"], .bool(false))
    XCTAssertEqual(sent.last?.deleted, false)
    let uuid = try A.store.card(id)!.uuid!
    XCTAssertNotEqual(mock.records["card:\(uuid)"]?.change.deleted, true, "the server copy is live again")
    await A.engine.stop()
  }

  // MARK: S2

  func testScopedEchoAfterADeviceIdChangeLeavesTheLocalCardsIntact() throws {
    let store = try makeStore()
    let b = try store.createBatch(t9, t9 + 3600)
    let ids = try store.replaceTimelineCardsInRange(
      from: t9, to: t9 + 3600,
      with: [card(t9, t9 + 1800, "Fixed the import"), card(t9 + 1800, t9 + 3600, "Dentist", "Personal")], batchId: b)
    // Uploaded scoped: "Out of scope" and a wiped, deleted personal card.
    let echo = liveCards(try store.flush())
    XCTAssertEqual(echo.count, 2)
    XCTAssertTrue(echo.allSatisfy { $0.title == OUT_OF_SCOPE_LABEL })

    // Sign-out / sign-in: a new device id; the cursor starts at 0 and our own echoes come back.
    try store.write { try store.local.setDeviceId($0, "srv-new") }
    try store.apply(echo)

    let work = try store.card(ids[0])!
    XCTAssertEqual(work.title, "Fixed the import")
    XCTAssertEqual(work.category, "Work")
    let personal = try store.card(ids[1])!
    XCTAssertEqual(personal.title, "Dentist")
    XCTAssertEqual(personal.category, "Personal")
    XCTAssertEqual(try store.count("SELECT COUNT(*) FROM timeline_cards WHERE is_deleted = 1"), 0, "nothing deleted")
  }

  // MARK: S3

  func testASlowPullThatFinishesAfterSignOutWritesNothing() async throws {
    let mock = MockSyncServer(devAuth: true)
    let gated = GatedTransport(mock)
    let A = try await makeDevice(dir, "desktop", url: "http://mock.local", transport: mock)
    let B = try await makeDevice(dir, "laptop", url: "http://mock.local", transport: gated)
    _ = try await A.engine.signInDev(email: "a@x.test")
    _ = try await B.engine.signInDev(email: "a@x.test")
    let bA = try A.store.createBatch(t9, t9 + 1800)
    try A.store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Desktop work")], batchId: bA)
    _ = await A.engine.syncNow()

    gated.hold()
    let cycle = Task { await B.engine.syncNow() }
    try await waitFor { gated.pullsWaiting > 0 }
    let out = Task { await B.engine.signOut() }
    try await Task.sleep(nanoseconds: 100_000_000)
    gated.release()
    let st = await out.value
    _ = await cycle.value

    XCTAssertFalse(st.signedIn)
    XCTAssertEqual(try B.store.count("SELECT COUNT(*) FROM timeline_cards WHERE device_id != '\(B.store.local.deviceId)'"), 0)
    let state = try B.store.read { try B.store.repo.state($0) }
    XCTAssertEqual(state.cursor, 0, "the late pull did not move the cursor")
    XCTAssertNil(state.userId)
    XCTAssertNil(state.lastPullAt)
    await A.engine.stop()
  }

  func testSigningInAsAnotherUserPurgesWhatThePreviousOneLeft() async throws {
    let mock = MockSyncServer(devAuth: true)
    let A = try await makeDevice(dir, "desktop", url: "http://mock.local", transport: mock)
    let B = try await makeDevice(dir, "laptop", url: "http://mock.local", transport: mock)
    _ = try await A.engine.signInDev(email: "a@x.test")
    let bA = try A.store.createBatch(t9, t9 + 1800)
    try A.store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [card(t9, t9 + 1800, "Desktop work")], batchId: bA)
    _ = await A.engine.syncNow()
    _ = try await B.engine.signInDev(email: "a@x.test")
    XCTAssertEqual(try B.store.count("SELECT COUNT(*) FROM timeline_cards"), 1)
    // A remote row left behind without an account on record (e.g. an interrupted sign-out).
    try B.store.write { try B.store.repo.updateState($0, SyncStatePatch(userId: .some(nil))) }
    B.token.set("")
    _ = try await B.engine.signInDev(email: "other@x.test")
    XCTAssertEqual(try B.store.count("SELECT COUNT(*) FROM timeline_cards"), 0, "the other user's card is gone")
    await A.engine.stop()
    await B.engine.stop()
  }

  // MARK: S5

  func testFirstPullMergesCategoriesThenRenamesKeepTheirExclusion() throws {
    let store = try makeStore(policy: SyncPolicy(excludedCategories: ["Gaming"], outOfScope: true, observations: false))
    let cats = MemoryCategories([
      SyncCategory(name: "Work", color: "#111111", description: "w"),
      SyncCategory(name: "Gaming", color: "#222222", description: ""),
      SyncCategory(name: "Idle", color: "#333333", description: "", isIdle: true),
    ])
    let docs = MacSyncDocSources(categories: cats)
    func doc(_ names: [String], _ hlc: String) -> SyncChange {
      SyncChange(
        entity: .userDoc, id: "u:categories", deviceId: "laptop", hlc: hlc,
        data: [
          "userId": .string("u"), "kind": .string("categories"),
          "payload": .array(names.map { .object(["name": .string($0), "color": .string("#444444"), "description": .string("")]) }),
        ])
    }
    let base = syncNowMs()
    // First pull of the session: nothing local is dropped, and the merged list goes back up.
    try store.apply([doc(["Work", "Meetings"], formatHlc(base, 0, "laptop"))], docs: docs)
    XCTAssertEqual(cats.value.map { $0.name }, ["Work", "Meetings", "Gaming"])
    let up = try store.buildBatch(docs, userId: "u").changes.filter { $0.entity == .userDoc }
    XCTAssertEqual(up.count, 1)
    XCTAssertEqual(up[0].data?["payload"]?.arrayValue?.compactMap { $0["name"]?.stringValue }, ["Work", "Meetings", "Gaming"])
    _ = try store.flush(docs)

    // Later pull: "Gaming" became "Games" at the same index on the other device.
    _ = store.local.takeScopeDirty()
    let res = try store.apply([doc(["Work", "Meetings", "Games"], formatHlc(base + 60_000, 0, "laptop"))], docs: docs)
    XCTAssertEqual(cats.value.map { $0.name }, ["Work", "Meetings", "Games"])
    XCTAssertTrue(res.policyChanged)
    XCTAssertEqual(store.local.policy.excludedCategories, ["Gaming", "Games"], "old name kept, new one added")
    XCTAssertEqual(store.local.policy.categoryAliases["games"], ["Gaming"])
    XCTAssertTrue(store.local.takeScopeDirty(), "a remote rename triggers the full rescope")
    XCTAssertEqual(try store.buildBatch(docs, userId: "u").changes.filter { $0.entity == .userDoc }.count, 0, "no echo")

    XCTAssertEqual(
      planCategoryApply(
        local: [SyncCategory(name: "A", color: "#000000", description: "")],
        remote: [SyncCategory(name: "B", color: "#000000", description: "")], firstPull: false
      ).renames, [CategoryRename(from: "A", to: "B")])
  }

  func testLocalCategoryRenameKeepsTheOldExclusion() {
    let p = SyncPolicy(excludedCategories: ["Personal"])
    let n = p.renamingCategory(from: "Personal", to: "Private life")!
    XCTAssertEqual(n.excludedCategories, ["Personal", "Private life"])
    XCTAssertEqual(n.categoryAliases["private life"], ["Personal"])
    let m = n.renamingCategory(from: "Private life", to: "Home")!
    XCTAssertEqual(m.excludedCategories, ["Personal", "Private life", "Home"])
    XCTAssertEqual(m.categoryAliases["home"], ["Personal", "Private life"])
    XCTAssertNil(m.categoryAliases["private life"])
    XCTAssertTrue(samePolicy(SyncPolicy(excludedCategories: ["Work"]), SyncPolicy(excludedCategories: ["Work"], categoryAliases: ["a": ["b"]])))
  }

  // MARK: S6

  func testObservationUploadSwitchedOffMidPushSendsATombstone() throws {
    let store = try makeStore(policy: .shareAll)
    let b = try store.createBatch(t9, t9 + 1800)
    try store.saveObservations(batchId: b, [(t9, t9 + 60, "editing invoices.swift")])
    let batch = try store.buildBatch()
    XCTAssertEqual(batch.changes.filter { $0.entity == .observation && $0.deleted != true }.count, 1)
    // Switched off while the push is in flight; then the server accepts it.
    store.local.policy = .default
    try store.write { db in
      try commitAccepted(db, batch) { _ in true }
      try store.repo.markPushed(db, batch.used)
    }
    XCTAssertEqual(try store.count("SELECT COUNT(*) FROM observations WHERE uploaded = 1"), 1)
    let next = try store.flush()
    XCTAssertEqual(next.filter { $0.entity == .observation }.map { $0.deleted }, [true], "the text is removed again")
    XCTAssertEqual(try store.count("SELECT COUNT(*) FROM observations WHERE uploaded = 0"), 1)
  }

  // MARK: S7

  func testOneIdPerBatchAndRejectionsByEntityAndId() throws {
    let store = try makeStore()
    try store.saveDailyStandup("2026-11-08", STANDUP_JSON)
    try store.saveDayGoalPlan(day: "2026-11-08", focus: 60, distraction: 30, focusCats: [])
    let docs = MacSyncDocSources(categories: nil)
    let first = try store.buildBatch(docs, userId: "u")
    XCTAssertEqual(first.changes.map { $0.id }, ["u:2026-11-08"], "the day goal waits for the next batch")
    try store.write { db in
      try commitAccepted(db, first) { _ in true }
      try store.repo.markPushed(db, first.used)
    }
    let second = try store.buildBatch(docs, userId: "u")
    XCTAssertEqual(second.changes.map { $0.id }, ["u:2026-11-08"])
    XCTAssertNotEqual(first.changes[0].entity, second.changes[0].entity)

    let changes = [
      SyncChange(entity: .standup, id: "u:d", deviceId: "x", hlc: "h"),
      SyncChange(entity: .card, id: "c1", deviceId: "x", hlc: "h"),
      SyncChange(entity: .dayGoal, id: "u:e", deviceId: "x", hlc: "h"),
    ]
    let r = rejectionReasons(
      changes, [PushRejection(id: "c1", reason: "bad"), PushRejection(id: "u:e", reason: "nope", entity: "standup")])
    XCTAssertEqual(r, [1: "bad"], "an entity-qualified rejection only matches that entity")
  }

  // MARK: S8

  func testOldCardsAreOnlyRescopedAfterSomethingMarkedTheScopeDirty() throws {
    let store = try makeStore()
    let now = Int64(Date().timeIntervalSince1970)
    let old = now - 90 * 86400
    let b = try store.createBatch(old, old + 1800)
    try store.replaceTimelineCardsInRange(from: old, to: old + 1800, with: [card(old, old + 1800, "Old work")], batchId: b)
    _ = try store.flush()
    _ = store.local.takeScopeDirty()
    store.local.policy = SyncPolicy(excludedCategories: ["Work"])
    XCTAssertTrue(store.local.takeScopeDirty(), "a policy change marks the scope dirty")
    XCTAssertEqual(try store.write { try store.outbox().rescopeCards($0, full: false) }, 0, "window-only scan skips it")
    XCTAssertEqual(try store.write { try store.outbox().rescopeCards($0, full: true) }, 1)
    XCTAssertFalse(store.local.takeScopeDirty())
    store.local.policy = SyncPolicy(excludedCategories: ["work"])
    XCTAssertFalse(store.local.takeScopeDirty(), "an equivalent policy is not a change")
  }

  // MARK: S9

  func testReprocessingADayKeepsPrivateFlagsAndManualProjects() throws {
    let store = try makeStore()
    let b = try store.createBatch(t9, t9 + 3600)
    let ids = try store.replaceTimelineCardsInRange(
      from: t9, to: t9 + 3600, with: [card(t9, t9 + 1800, "Biosun"), card(t9 + 1800, t9 + 3600, "Bank")], batchId: b)
    let project = try store.write {
      try store.repo.saveProject($0, ProjectDraft(workspaceId: "ws", name: "Biosun", color: "#336699"))
    }
    let uuid0 = try store.card(ids[0])!.uuid!
    try store.write { try store.repo.setManualProject($0, cardUuid: uuid0, projectId: project.id) }
    try store.write { try store.local.editCard($0, id: ids[1], isPrivate: true) }

    try store.deleteTimelineCards(forDay: "2026-11-08")
    XCTAssertEqual(try store.cardsForDay("2026-11-08").count, 0)
    // The re-analysis runs later, in its own transaction, with slightly different boundaries.
    let b2 = try store.createBatch(t9, t9 + 3600)
    try store.replaceTimelineCardsInRange(
      from: t9, to: t9 + 3600,
      with: [card(t9 + 60, t9 + 1700, "Biosun import"), card(t9 + 1700, t9 + 3600, "Bank transfer")], batchId: b2)
    let cards = try store.cardsForDay("2026-11-08")
    XCTAssertEqual(cards.map { $0.title }, ["Biosun import", "Bank transfer"])
    XCTAssertFalse(cards[0].isPrivate)
    XCTAssertTrue(cards[1].isPrivate, "the private flag survives the reprocess")
    let cp = try store.read { try store.repo.cardProjects($0, cardUuid: cards[0].uuid!) }
    XCTAssertEqual(cp.map { $0.projectId }, [project.id])
    XCTAssertEqual(cp.first?.source, .manual)
    XCTAssertEqual(cp.first?.confirmed, true)
    XCTAssertEqual(try store.read { try store.repo.cardProjects($0, cardUuid: cards[1].uuid!) }.count, 0)
  }

  // MARK: device id / migration

  func testDeviceIdAndEnabledFlagRollBackWithTheirTransaction() throws {
    let store = try MacStore(dir: dir)
    let before = store.local.deviceId
    struct Boom: Error {}
    XCTAssertThrowsError(
      try store.write { db in
        try store.local.setDeviceId(db, "srv-1")
        try store.local.setSyncEnabled(db, true)
        XCTAssertEqual(store.local.deviceId, "srv-1", "visible inside the transaction")
        throw Boom()
      })
    XCTAssertEqual(store.local.deviceId, before)
    XCTAssertFalse(store.local.syncEnabled)
    XCTAssertEqual(try store.read { try store.repo.state($0) }.deviceId, before)
    // And kept when it commits.
    try store.write { try store.local.setDeviceId($0, "srv-2") }
    XCTAssertEqual(store.local.deviceId, "srv-2")
    XCTAssertTrue(store.local.tick().hasSuffix("-srv-2"))
  }

  func testLegacyRowsGetUuidsAndClocksInOneStatement() throws {
    let store = try MacStore(dir: dir)
    let dev = store.local.deviceId
    try store.write { db in
      for i in 0..<300 {
        try db.execute(
          sql: """
            INSERT INTO timeline_cards (batch_id, start, end, start_ts, end_ts, day, title, summary, category, subcategory,
              detailed_summary, metadata) VALUES (NULL, 'a', 'b', ?, ?, '2026-11-08', 't', 's', 'Work', '', '', '{}')
            """, arguments: [t9 + Int64(i) * 60, t9 + Int64(i) * 60 + 60])
        try db.execute(
          sql: "INSERT INTO observations (batch_id, start_ts, end_ts, observation) VALUES (NULL, ?, ?, 'o')",
          arguments: [t9 + Int64(i), t9 + Int64(i) + 1])
      }
    }
    let local = SyncLocal()
    try store.write { try local.migrate($0) }
    XCTAssertEqual(local.deviceId, dev)
    for table in ["timeline_cards", "observations"] {
      let rows = try store.read { try Row.fetchAll($0, sql: "SELECT uuid, hlc, start_ts FROM \(table)") }
      XCTAssertEqual(rows.count, 300)
      var seen = Set<String>()
      for r in rows {
        let uuid: String = r["uuid"]
        let hlc: String = r["hlc"]
        let start: Int64 = r["start_ts"]
        let parsed = try XCTUnwrap(UUID(uuidString: uuid), uuid)
        XCTAssertEqual(parsed.uuidString.lowercased(), uuid, "lowercase canonical form")
        let chars = Array(uuid)
        XCTAssertEqual(chars[14], "4", "version 4")
        XCTAssertTrue("89ab".contains(chars[19]), "RFC 4122 variant")
        seen.insert(uuid)
        XCTAssertEqual(hlc, formatHlc(start * 1000, 0, dev))
        XCTAssertEqual(parseHlc(hlc), ParsedHLC(ms: start * 1000, counter: 0, deviceId: dev))
      }
      XCTAssertEqual(seen.count, 300, "unique")
    }
    XCTAssertEqual(try store.count("SELECT COUNT(*) FROM timeline_cards WHERE field_hlc = '{}' AND device_id = '\(dev)'"), 300)
  }
}
