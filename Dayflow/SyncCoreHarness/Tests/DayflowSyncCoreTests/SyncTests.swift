//
//  Port of windows/tests/sync.test.ts (migration, outbox recording, device id remap, remote apply,
//  rules + LLM assignment) against the Mac schema and StorageManager write paths.
//

import GRDB
import XCTest

@testable import DayflowSyncCore

final class SyncTests: XCTestCase {
  var dir: URL!

  override func setUpWithError() throws {
    dir = try tempDir()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  /// These tests cover the sync mechanics, so everything is shared (SyncScopeTests cover the policy).
  func makeStore(_ name: String = "db") throws -> MacStore {
    let s = try MacStore(dir: dir, name: name)
    s.local.policy = .shareAll
    return s
  }

  // MARK: migration

  func testMigrationUpgradesAnOldMacDatabaseInPlace() throws {
    let path = dir.appendingPathComponent("old.sqlite").path
    do {
      let old = try DatabaseQueue(path: path)
      try old.write { db in
        try db.execute(sql: MAC_SCHEMA)
        try db.execute(
          sql: "INSERT INTO analysis_batches (batch_start_ts, batch_end_ts, status) VALUES (?, ?, 'analyzed')",
          arguments: [t9, t9 + 900])
        try db.execute(
          sql: """
            INSERT INTO timeline_cards (batch_id, start, end, start_ts, end_ts, day, title, category, metadata)
            VALUES (1, '9:00 AM', '9:30 AM', ?, ?, '2026-11-08', 'Old card', 'Work', '{"distractions":[]}')
            """, arguments: [t9, t9 + 1800])
        try db.execute(
          sql: "INSERT INTO observations (batch_id, start_ts, end_ts, observation) VALUES (1, ?, ?, 'typing')",
          arguments: [t9, t9 + 60])
      }
    }
    let local = SyncLocal()
    let q = try DatabaseQueue(path: path)
    try q.write { try local.migrate($0) }
    try q.read { db in
      let cardCols = try db.columns(in: "timeline_cards").map { $0.name }
      for c in ["uuid", "hlc", "field_hlc", "device_id", "sync_scope", "scope_hlc"] { XCTAssertTrue(cardCols.contains(c), c) }
      let obsCols = try db.columns(in: "observations")
      XCTAssertEqual(obsCols.first { $0.name == "batch_id" }?.isNotNull, false, "batch_id became nullable")
      for c in ["uuid", "hlc", "device_id", "uploaded"] { XCTAssertTrue(obsCols.contains { $0.name == c }, c) }
      for t in ["projects", "card_projects", "sync_state", "outbox", "project_members", "sync_meta"] {
        XCTAssertTrue(try db.tableExists(t), t)
      }
      for i in ["idx_observations_batch_id", "idx_observations_time_range", "idx_timeline_cards_uuid", "idx_observations_uuid"] {
        XCTAssertNotNil(try Row.fetchOne(db, sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", arguments: [i]), i)
      }
      let card = try Row.fetchOne(db, sql: "SELECT * FROM timeline_cards")!
      XCTAssertEqual(card["title"] as String, "Old card")
      XCTAssertNotNil((card["uuid"] as String?)?.range(of: "^[0-9a-f-]{36}$", options: .regularExpression))
      XCTAssertEqual(card["device_id"] as String?, local.deviceId)
      XCTAssertEqual(card["hlc"] as String?, formatHlc(t9 * 1000, 0, local.deviceId))
      XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM observations WHERE uuid IS NOT NULL"), 1)
    }
    let deviceId = local.deviceId
    let uuid = try q.read { try String.fetchOne($0, sql: "SELECT uuid FROM timeline_cards") }
    // Re-opening is a no-op: same device id and uuids.
    let again = SyncLocal()
    try q.write { try again.migrate($0) }
    XCTAssertEqual(again.deviceId, deviceId)
    XCTAssertEqual(try q.read { try String.fetchOne($0, sql: "SELECT uuid FROM timeline_cards") }, uuid)
    XCTAssertEqual(deviceId, deviceId.lowercased(), "device ids are lowercase like Node's randomUUID")
  }

  // MARK: outbox recording

  func testNothingQueuedUntilSyncEnabledThenCardsEditsAndObservationsAre() throws {
    let store = try makeStore()
    let b1 = try store.createBatch(t9, t9 + 900)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Before sign-in")], batchId: b1)
    XCTAssertEqual(try store.pendingCount(), 0)

    try store.setSyncEnabled(true)
    let b2 = try store.createBatch(t9 + 900, t9 + 1800)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 2700, with: [TestCard(startTs: t9, endTs: t9 + 2700, title: "A")], batchId: b2)
    try store.saveObservations(batchId: b2, [(t9, t9 + 60, "coding")])
    // The old card's deletion + the new card + one observation.
    XCTAssertEqual(try store.pendingCount(), 3)
    let cardA = try store.cardsForDay("2026-11-08")[0]
    try store.updateTimelineCard(cardA.id, title: "Renamed")
    XCTAssertEqual(try store.pendingCount(), 3, "edits coalesce into the queued entry")
    // Re-analysis of the batch: old observations get tombstones, the new one is queued.
    try store.deleteObservations(forBatchIds: [b2])
    try store.saveObservations(batchId: b2, [(t9, t9 + 120, "coding more")])
    XCTAssertEqual(try store.pendingCount(), 4, "old observation tombstone + new observation")

    // Error cards never enter the outbox.
    let b3 = try store.createBatch(t9 + 3600, t9 + 4500)
    let before = try store.pendingCount()
    try store.insertErrorCard(batchId: b3, t9 + 3600, t9 + 4500, "boom")
    XCTAssertEqual(try store.pendingCount(), before)

    let batch = try store.buildBatch()
    let cardChanges = batch.changes.filter { $0.entity == .card }
    let live = cardChanges.first { $0.deleted != true }!
    XCTAssertEqual(live.title, "Renamed")
    XCTAssertNotNil(live.fieldHlc?["title"], "title edit carries a field HLC")
    XCTAssertEqual(live.str("originDeviceId"), store.local.deviceId)
    XCTAssertEqual(live.deviceId, store.local.deviceId)
    XCTAssertTrue(cardChanges.contains { $0.deleted == true }, "replaced card is a tombstone")
    let obs = batch.changes.filter { $0.entity == .observation }
    XCTAssertEqual(obs.filter { $0.deleted == true }.count, 1)
    XCTAssertEqual(obs.first { $0.deleted != true }?.str("text"), "coding more")
    XCTAssertTrue(batch.changes.allSatisfy { $0.entity != .card || $0.data?["isError"]?.boolValue != true })

    // Pushed entries disappear unless re-queued while in flight.
    try store.updateTimelineCard(cardA.id, category: "Idle")
    try store.markPushed(batch.used)
    XCTAssertEqual(try store.pendingCount(), 1, "the card edited after the build stays queued")
  }

  func testDeviceIdRemapRelabelsRowsWrittenBeforeSignIn() throws {
    let store = try makeStore()
    let b = try store.createBatch(t9, t9 + 900)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Mine")], batchId: b)
    try store.db.write { try store.local.setDeviceId($0, "server-device-1") }
    let c = try store.cardsForDay("2026-11-08")[0]
    XCTAssertEqual(c.deviceId, "server-device-1")
    XCTAssertFalse(c.remote)
    try store.setSyncEnabled(true)
    try store.updateTimelineCard(c.id, title: "X")
    let ch = try store.buildBatch(userId: "u").changes[0]
    XCTAssertEqual(parseHlc(ch.hlc)?.deviceId, "server-device-1")
  }

  // MARK: apply remote

  func testPulledCardsKeepTheirOriginDeviceAndSurviveLocalAnalysis() throws {
    let store = try makeStore()
    let uuid = "11111111-1111-4111-8111-111111111111"
    let res = try store.apply([remoteCard(uuid, "laptop", formatHlc(syncNowMs(), 0, "laptop"))])
    XCTAssertTrue(res.cards)
    var day = try store.cardsForDay("2026-11-08")
    XCTAssertEqual(day.count, 1)
    XCTAssertTrue(day[0].remote)
    XCTAssertEqual(day[0].deviceId, "laptop")
    XCTAssertEqual(try store.db.read { try String.fetchOne($0, sql: "SELECT start FROM timeline_cards") }, syncFormatClock(t9))

    // Local analysis over the same window replaces only this device's cards.
    let b = try store.createBatch(t9, t9 + 900)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 2700, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Desktop work")], batchId: b)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 2700, with: [TestCard(startTs: t9, endTs: t9 + 2400, title: "Desktop work v2")], batchId: b)
    day = try store.cardsForDay("2026-11-08")
    XCTAssertEqual(day.map { $0.title }.sorted(), ["Desktop work v2", "Remote work"])
    XCTAssertEqual(try store.cardsInRange(t9, t9 + 2700, localOnly: true).count, 1, "analysis input excludes other devices")
    XCTAssertEqual(try store.cardsInRange(t9, t9 + 2700, localOnly: false).count, 2)
    // Reprocessing the day removes only this device's cards.
    try store.deleteTimelineCards(forDay: "2026-11-08")
    XCTAssertEqual(try store.cardsForDay("2026-11-08").map { $0.title }, ["Remote work"])

    // Remote observations are stored but are not analysis input.
    try store.apply([
      SyncChange(
        entity: .observation, id: "22222222-2222-4222-8222-222222222222", deviceId: "laptop",
        hlc: formatHlc(syncNowMs(), 1, "laptop"),
        data: ["userId": .string("u"), "startTs": .int(t9), "endTs": .int(t9 + 60), "text": .string("laptop typing")])
    ])
    XCTAssertEqual(try store.observationsInRange(t9, t9 + 900).count, 0)
    XCTAssertEqual(try store.count("SELECT COUNT(*) FROM observations"), 1)
    // Error cards are never accepted.
    XCTAssertEqual(
      try store.apply([remoteCard("33333333-3333-4333-8333-333333333333", "laptop", formatHlc(syncNowMs(), 2, "laptop"), ["isError": .bool(true)])]).applied, 0)
  }

  func testPerFieldLWWRenameOnOnePCAndCategoryChangeOnAnotherBothSurvive() throws {
    let store = try makeStore()
    let b = try store.createBatch(t9, t9 + 900)
    try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Original")], batchId: b)
    let local = try store.cardsForDay("2026-11-08")[0]
    let me = store.local.deviceId

    // Laptop renames our card...
    let tRename = formatHlc(syncNowMs() + 1000, 0, "laptop")
    try store.apply([
      remoteCard(
        local.uuid!, "laptop", tRename,
        ["title": .string("Renamed on laptop"), "category": .string("Work"), "summary": .string("stale laptop copy"), "originDeviceId": .string(me)],
        fieldHlc: ["title": tRename])
    ])
    // ...while we change the category here afterwards.
    try store.updateTimelineCard(local.id, category: "Idle")
    var c = try store.card(local.id)!
    XCTAssertEqual(c.title, "Renamed on laptop")
    XCTAssertEqual(c.category, "Idle")
    XCTAssertEqual(c.summary, "Original summary", "another device never rewrites our analysis fields")

    // An older category edit from the laptop loses; an older rename does not resurrect.
    let older = formatHlc(syncNowMs() - 100_000, 0, "laptop")
    try store.apply([
      remoteCard(local.uuid!, "laptop", older, ["title": .string("Old"), "category": .string("Work"), "originDeviceId": .string(me)], fieldHlc: ["title": older, "category": older])
    ])
    c = try store.card(local.id)!
    XCTAssertEqual(c.title, "Renamed on laptop")
    XCTAssertEqual(c.category, "Idle")

    // A laptop card: its analysis fields follow the laptop, user edits merge per field.
    let lap = "44444444-4444-4444-8444-444444444444"
    let h1 = formatHlc(syncNowMs(), 0, "laptop")
    try store.apply([remoteCard(lap, "laptop", h1)])
    let lapRow = try store.cardsForDay("2026-11-08").first { $0.uuid == lap }!
    try store.updateTimelineCard(lapRow.id, title: "My title here")
    let h2 = formatHlc(syncNowMs() + 5000, 0, "laptop")
    // The laptop re-sends its card with a newer record clock but its title field is still from h1.
    let f1 = ["title": h1, "category": h1, "subcategory": h1, "deleted": h1, "private": h1]
    try store.apply([remoteCard(lap, "laptop", h2, ["summary": .string("updated by laptop"), "title": .string("Laptop title")], fieldHlc: f1)])
    var merged = try store.card(lapRow.id)!
    XCTAssertEqual(merged.summary, "updated by laptop", "origin device owns analysis fields")
    XCTAssertEqual(merged.title, "My title here", "our later rename survives")
    // A later rename on the laptop wins.
    let h3 = formatHlc(syncNowMs() + 60_000, 0, "laptop")
    var f3 = f1
    f3["title"] = h3
    try store.apply([remoteCard(lap, "laptop", h3, ["title": .string("Laptop rename")], fieldHlc: f3)])
    merged = try store.card(lapRow.id)!
    XCTAssertEqual(merged.title, "Laptop rename")
  }

  final class RecordingDocs: SyncDocSources, @unchecked Sendable {
    var written: [(DocEntity, String, JSONValue?)] = []
    func read(_ db: Database, _ entity: DocEntity, _ id: String) throws -> JSONValue? { nil }
    func write(_ db: Database, _ entity: DocEntity, _ id: String, _ payload: JSONValue?) throws {
      written.append((entity, id, payload))
    }
  }

  func testDeletesPrivateFlagAndLWWForProjectsCardProjectsAndDocs() throws {
    let store = try makeStore()
    let docs = RecordingDocs()
    let lap = "55555555-5555-4555-8555-555555555555"
    let base = syncNowMs()
    func h(_ d: Int64, _ dev: String = "laptop") -> String { formatHlc(base + d, 0, dev) }
    try store.apply([remoteCard(lap, "laptop", h(0), ["metadata": .object(["private": .bool(true)])])])
    let row = try store.cardsForDay("2026-11-08")[0]
    XCTAssertTrue(row.isPrivate)
    try store.apply([remoteCard(lap, "laptop", h(10), deleted: true, fieldHlc: ["deleted": h(10)])])
    XCTAssertEqual(try store.cardsForDay("2026-11-08").count, 0)

    let pid = "66666666-6666-4666-8666-666666666666"
    func proj(_ hlc: String, _ name: String) -> SyncChange {
      SyncChange(
        entity: .project, id: pid, deviceId: "laptop", hlc: hlc,
        data: [
          "workspaceId": .string("w"), "name": .string(name), "color": .string("#123456"), "description": .string(""),
          "rules": .object(["apps": .array([.string("code")])]), "defaultShare": .string("cards"), "archived": .bool(false),
        ])
    }
    try store.apply([proj(h(20), "Newer")])
    try store.apply([proj(h(5), "Older")])
    let p = try store.db.read { try store.repo.project($0, pid) }
    XCTAssertEqual(p?.name, "Newer")
    XCTAssertEqual(p?.rules.apps, ["code"])

    try store.apply([
      SyncChange(
        entity: .cardProject, id: "\(lap):\(pid)", deviceId: "laptop", hlc: h(30),
        data: [
          "cardId": .string(lap), "projectId": .string(pid), "share": .double(0.5), "source": .string("llm"),
          "confidence": .double(0.6), "confirmed": .bool(false),
        ])
    ])
    XCTAssertEqual(try store.db.read { try store.repo.cardProject($0, cardUuid: lap, projectId: pid) }?.share, 0.5)
    try store.apply([SyncChange(entity: .cardProject, id: "\(lap):\(pid)", deviceId: "laptop", hlc: h(25), deleted: true)])
    XCTAssertEqual(try store.db.read { try store.repo.cardProject($0, cardUuid: lap, projectId: pid) }?.deleted, false, "older tombstone loses")

    try store.apply(
      [
        SyncChange(
          entity: .standup, id: "u:2026-11-08", deviceId: "laptop", hlc: h(40),
          data: ["userId": .string("u"), "day": .string("2026-11-08"), "payload": .object(["done": .int(1)])])
      ], docs: docs)
    try store.apply(
      [
        SyncChange(
          entity: .standup, id: "other-user:2026-11-08", deviceId: "x", hlc: h(50),
          data: ["userId": .string("other-user"), "day": .string("2026-11-08"), "payload": .object([:])])
      ], docs: docs)
    XCTAssertEqual(docs.written.count, 1)
    XCTAssertEqual(docs.written[0].0, .standup)
    XCTAssertEqual(docs.written[0].1, "2026-11-08")
    XCTAssertEqual(docs.written[0].2, .object(["done": .int(1)]))
  }

  // MARK: rules + LLM

  func testRulesAppsDomainsTitleKeywordsReposSharesScaled() {
    let projects: [(id: String, rules: ProjectRules, archived: Bool)] = [
      ("p1", ProjectRules(apps: ["Code"], repos: ["github.com/acme/dayflow"]), false),
      ("p2", ProjectRules(domains: ["velesagro.pl"]), false),
      ("p3", ProjectRules(titleKeywords: ["invoice"]), false),
      ("p4", ProjectRules(apps: ["code"]), true),
      ("p5", ProjectRules(), false),
    ]
    let labels = ["Code — db.ts - dayflow", "Code — sync.ts - dayflow", "chrome — Orders - erp.velesagro.pl", "chrome — YouTube"]
    let m = matchRules(projects, RuleInput(labels: labels, appSitesPrimary: nil, appSitesSecondary: nil, title: "Sync work", summary: ""))
    XCTAssertEqual(m, [RuleMatch(projectId: "p1", share: 0.5), RuleMatch(projectId: "p2", share: 0.25)])
    // appSites / title keywords match the whole card (share 1) and everything is scaled.
    let m2 = matchRules(projects, RuleInput(labels: [], appSitesPrimary: "odoo.velesagro.pl", appSitesSecondary: nil, title: "Invoice run", summary: ""))
    XCTAssertEqual(m2.map { [$0.projectId: $0.share] }, [["p2": 0.5], ["p3": 0.5]])
    XCTAssertEqual(matchRules(projects, RuleInput(labels: ["notepad — notes"], appSitesPrimary: nil, appSitesSecondary: nil, title: "x", summary: "y")), [])
    // "velesagro.pl" must not match "notvelesagro.pl".
    XCTAssertEqual(matchRules(projects, RuleInput(labels: ["chrome — notvelesagro.pl"], appSitesPrimary: nil, appSitesSecondary: nil, title: "", summary: "")), [])
    // ...but does match a subdomain inside a title, and "Code.exe" matches app "code".
    XCTAssertEqual(matchRules(projects, RuleInput(labels: ["chrome — https://shop.velesagro.pl/cart"], appSitesPrimary: nil, appSitesSecondary: nil, title: "", summary: "")).map { $0.projectId }, ["p2"])
    XCTAssertEqual(matchRules(projects, RuleInput(labels: ["Code.exe — x"], appSitesPrimary: nil, appSitesSecondary: nil, title: "", summary: "")).map { $0.projectId }, ["p1"])

    let llm = llmAssignments(
      [("p1", "Dayflow", false), ("p2", "ERP", false)],
      [
        LlmProjectGuess(name: "dayflow", share: 0.7, confidence: 0.9),
        LlmProjectGuess(name: "ERP", share: 0.3, confidence: 0.5),
        LlmProjectGuess(name: "Invented", share: 1, confidence: 1),
      ])
    XCTAssertEqual(
      llm,
      [
        AssignmentInput(projectId: "p1", share: 0.7, source: .llm, confidence: 0.9, confirmed: true),
        AssignmentInput(projectId: "p2", share: 0.3, source: .llm, confidence: 0.5, confirmed: false),
      ])
  }

  func testAssignmentPipelineManualKeptAcrossRewritesRulesBeatLLM() throws {
    let store = try makeStore()
    let repo = store.repo
    try store.db.write { db in
      try repo.putProject(db, ProjectRow(id: "p-code", workspaceId: "w", name: "Dayflow", color: "#111111", description: "", rules: ProjectRules(apps: ["code"]), defaultShare: .time, odoo: OdooMapping(), archived: false, deleted: false, hlc: store.local.tick()))
      try repo.putProject(db, ProjectRow(id: "p-erp", workspaceId: "w", name: "ERP", color: "#222222", description: "", rules: ProjectRules(), defaultShare: .cards, odoo: OdooMapping(), archived: false, deleted: false, hlc: store.local.tick()))
    }
    for i in 0..<10 { try store.insertScreenshot(t9 + Int64(i) * 60, label: "Code — repo") }
    let b = try store.createBatch(t9, t9 + 900)
    final class Box: @unchecked Sendable { var refs: [InsertedCardRef] = [] }
    let box = Box()
    store.local.onCardsInserted = { r in box.refs += r }
    var refs: [InsertedCardRef] { box.refs }
    var ids = try store.replaceTimelineCardsInRange(
      from: t9, to: t9 + 3600,
      with: [TestCard(startTs: t9, endTs: t9 + 1200, title: "Coding"), TestCard(startTs: t9 + 1800, endTs: t9 + 3000, title: "Meeting")],
      batchId: b)
    XCTAssertEqual(refs.count, 2)
    let guesses: [String: [LlmProjectGuess]] = [
      refs[0].uuid: [LlmProjectGuess(name: "ERP", share: 1, confidence: 0.95)],
      refs[1].uuid: [LlmProjectGuess(name: "ERP", share: 1, confidence: 0.6)],
    ]
    try store.db.write { try assignProjects($0, local: store.local, labels: store.labels, cards: refs, llmGuesses: guesses) }
    let coding = try store.db.read { try repo.cardProjects($0, cardUuid: refs[0].uuid) }
    XCTAssertEqual(coding.map { "\($0.projectId) \($0.source.rawValue) \($0.confirmed)" }, ["p-code rule true"])
    let meeting = try store.db.read { try repo.cardProjects($0, cardUuid: refs[1].uuid) }
    XCTAssertEqual(meeting.map { "\($0.projectId) \($0.source.rawValue) \($0.confirmed)" }, ["p-erp llm false"])

    // User fixes the meeting manually; the next rewrite of the window keeps it.
    try store.db.write { try repo.setManualProject($0, cardUuid: refs[1].uuid, projectId: "p-code") }
    box.refs = []
    ids = try store.replaceTimelineCardsInRange(
      from: t9, to: t9 + 3600,
      with: [TestCard(startTs: t9, endTs: t9 + 1200, title: "Coding"), TestCard(startTs: t9 + 1800, endTs: t9 + 3300, title: "Meeting (longer)")],
      batchId: b)
    XCTAssertEqual(refs[1].inheritedManual, true)
    try store.db.write { try assignProjects($0, local: store.local, labels: store.labels, cards: refs) }
    XCTAssertEqual(try store.db.read { try repo.cardProjects($0, cardUuid: refs[1].uuid) }.map { "\($0.projectId) \($0.source.rawValue)" }, ["p-code manual"])
    let info = try store.db.read { try repo.cardSyncInfo($0, recordIds: ids) }
    XCTAssertEqual(info[ids[1]]?.projects.first?.name, "Dayflow")
    XCTAssertEqual(info[ids[1]]?.remote, false)
  }

  func testPrivateFlagIsInheritedByTheCardThatReplacesIt() throws {
    let store = try makeStore()
    let b = try store.createBatch(t9, t9 + 900)
    let ids = try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Draft")], batchId: b)
    try store.db.write { try store.local.editCard($0, id: ids[0], isPrivate: true) }
    let next = try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1500, title: "Final")], batchId: b)
    XCTAssertEqual(try store.card(next[0])?.isPrivate, true)
  }
}
