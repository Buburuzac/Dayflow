//
//  Mixed end-to-end check: this Mac core and the real Windows client (windows/src/main/sync) as two
//  devices of one user on a real Dayflow Sync Server. Runs in three steps:
//
//    1. DAYFLOW_SYNC_E2E_PHASE=mac1  — the Mac analyses a day (project work, a Personal card,
//       unassigned work, an observation), writes a standup / day goal / categories, signs in, syncs.
//    2. the Windows client (Node) signs in as the same user, checks what arrived (scopes, docs),
//       renames the Mac's project card and adds its own card + standup + category, syncs.
//    3. DAYFLOW_SYNC_E2E_PHASE=mac2  — the Mac pulls, checks the Windows edits merged, signs out.
//
//  State between the steps lives in DAYFLOW_SYNC_E2E_STATE (the Mac's database and token). With
//  Scripts/megaserv-test.sh use a path in the cache volume, e.g. /cache/mixed-state: /src is re-uploaded
//  (wiped) on every run.
//

import GRDB
import XCTest

@testable import DayflowSyncCore

let E2E_PHASE = ProcessInfo.processInfo.environment["DAYFLOW_SYNC_E2E_PHASE"] ?? ""
let E2E_STATE = ProcessInfo.processInfo.environment["DAYFLOW_SYNC_E2E_STATE"] ?? ""
/// 12:00 UTC: the same logical day in UTC (container) and Central Europe (the Windows client).
let tMixed = Int64(1_794_225_600)  // 2026-11-09T12:00:00Z
let MIXED_DAY = "2026-11-09"

final class MixedE2ETests: XCTestCase {
  func open(_ background: Bool = false) async throws -> (TestDevice, URL) {
    let dir = URL(fileURLWithPath: E2E_STATE)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let d = try await makeDevice(dir, "mac-e2e", url: REAL_SERVER, transport: URLSessionSyncTransport(), policy: .default)
    d.categories.set([
      SyncCategory(name: "Work", color: "#B984FF", description: "Focused work"),
      SyncCategory(name: "Personal", color: "#6AADFF", description: "Life admin"),
      SyncCategory(name: "Idle", color: "#A0AEC0", description: "", isIdle: true),
    ])
    let tokenFile = dir.appendingPathComponent("token")
    if let t = try? String(contentsOf: tokenFile, encoding: .utf8) { d.token.set(t) }
    return (d, tokenFile)
  }

  func mixedCards(_ d: TestDevice) throws -> [MacStore.Card] {
    try d.store.cardsForDay(MIXED_DAY)
  }

  func testPhase1MacAnalysesAndUploads() async throws {
    try XCTSkipIf(REAL_SERVER.isEmpty || E2E_PHASE != "mac1" || E2E_STATE.isEmpty, "mixed e2e phase mac1")
    let (A, tokenFile) = try await open()
    let b = try A.store.createBatch(tMixed, tMixed + 5400)
    let ids = try A.store.replaceTimelineCardsInRange(
      from: tMixed, to: tMixed + 5400,
      with: [
        TestCard(startTs: tMixed, endTs: tMixed + 1800, title: "Biosun invoice import", appSitesPrimary: "odoo.velesagro.pl"),
        TestCard(startTs: tMixed + 1800, endTs: tMixed + 3600, title: "Booked the dentist", category: "Personal"),
        TestCard(startTs: tMixed + 3600, endTs: tMixed + 5400, title: "Reading Swift docs"),
      ], batchId: b)
    try A.store.saveObservations(batchId: b, [(tMixed, tMixed + 60, "typing an invoice in Odoo")])
    try A.store.saveDailyStandup("2026-11-08", STANDUP_JSON)
    try A.store.saveDayGoalPlan(day: MIXED_DAY, focus: 300, distraction: 45, focusCats: [("11111111-2222-3333-4444-555555555555", "Work", "#B984FF")])

    let st = try await A.engine.signInDev(email: ADMIN_EMAIL)
    XCTAssertTrue(st.signedIn)
    try A.token.get().write(to: tokenFile, atomically: true, encoding: .utf8)
    let me = try await A.engine.me()
    let ws = try XCTUnwrap(me.workspaces.first { $0.role == .owner || $0.role == .admin }, "the bootstrap admin owns a workspace")
    let project = try await A.engine.saveProject(
      ProjectDraft(workspaceId: ws.id, name: "Biosun e2e", color: "#336699", description: "invoice imports", rules: ProjectRules(titleKeywords: ["Biosun"]), defaultShare: .cards))
    try await A.engine.assignCard(recordId: ids[0], projectId: project.id)
    let after = await A.engine.syncNow()
    XCTAssertNil(after.lastError)
    XCTAssertEqual(after.pending, 0)
    XCTAssertEqual(try mixedCards(A).map { $0.title }, ["Biosun invoice import", "Booked the dentist", "Reading Swift docs"], "local cards keep their content")
    print("E2E mac1 device=\(A.store.local.deviceId) project=\(project.id)")
  }

  func testPhase2MacMergesTheWindowsEditsAndSignsOut() async throws {
    try XCTSkipIf(REAL_SERVER.isEmpty || E2E_PHASE != "mac2" || E2E_STATE.isEmpty, "mixed e2e phase mac2")
    let (A, tokenFile) = try await open()
    let st = await A.engine.syncNow()
    XCTAssertTrue(st.signedIn)
    XCTAssertNil(st.lastError)
    let cards = try mixedCards(A)
    let mine = cards.filter { !$0.remote }
    let remote = cards.filter { $0.remote }
    // The Windows rename of the Mac's card merged per field; the Mac's analysis fields stayed.
    let biosun = try XCTUnwrap(mine.first { $0.title.hasPrefix("Biosun") })
    XCTAssertEqual(biosun.title, "Biosun invoice import (renamed on Windows)")
    XCTAssertEqual(biosun.summary, "Biosun invoice import summary")
    // Out-of-scope / personal cards are untouched locally (their redacted echoes never overwrite them).
    XCTAssertEqual(mine.map { $0.title }.sorted(), ["Biosun invoice import (renamed on Windows)", "Booked the dentist", "Reading Swift docs"])
    // The Windows card arrived in full (confirmed project), in its own lane.
    let win = try XCTUnwrap(remote.first { $0.title == "Windows: Odoo timesheets" }, "remote: \(remote.map { $0.title })")
    XCTAssertNotEqual(win.deviceId, A.store.local.deviceId)
    let info = await A.engine.cardSyncInfo(recordIds: [win.id, biosun.id])
    XCTAssertEqual(info[win.id]?.projects.map { $0.name }, ["Biosun e2e"])
    XCTAssertEqual(info[biosun.id]?.projects.map { "\($0.name) \($0.source.rawValue) \($0.confirmed)" }, ["Biosun e2e manual true"])
    // The Windows standup is stored in the Mac's DailyStandupDraft form.
    let standup = try XCTUnwrap(try A.store.fetchStandup(MIXED_DAY))
    let s = try XCTUnwrap(JSONValue.parse(standup))
    XCTAssertEqual(s["highlights"]?.arrayValue?.first?["text"], .string("Windows highlight"))
    XCTAssertNotNil(s["generation"]?["generatedAt"]?.numberValue, "ISO date converted for the Mac decoder")
    XCTAssertNotNil(UUID(uuidString: s["highlights"]?.arrayValue?.first?["id"]?.stringValue ?? ""))
    // The Windows category edit arrived through the categories doc.
    XCTAssertTrue(A.categories.value.contains { $0.name == "Deep work" && $0.color == "#123456" }, "\(A.categories.value)")
    XCTAssertTrue(A.categories.value.contains { $0.isIdle })

    // Sign-out revokes this device and removes the other device's rows and the projects.
    let out = await A.engine.signOut()
    XCTAssertFalse(out.signedIn)
    XCTAssertEqual(try mixedCards(A).map { $0.title }.sorted(), ["Biosun invoice import (renamed on Windows)", "Booked the dentist", "Reading Swift docs"])
    XCTAssertEqual(try A.store.count("SELECT COUNT(*) FROM timeline_cards WHERE device_id IS NOT NULL AND device_id != '\(A.store.local.deviceId)'"), 0)
    XCTAssertEqual(try A.store.count("SELECT COUNT(*) FROM projects"), 0)
    let oldToken = (try? String(contentsOf: tokenFile, encoding: .utf8)) ?? ""
    let revoked = try SyncClient(baseUrl: REAL_SERVER, token: oldToken, transport: URLSessionSyncTransport())
    do {
      _ = try await revoked.me()
      XCTFail("the signed-out device's token must be revoked")
    } catch let e as HttpError {
      XCTAssertEqual(e.status, 401)
    }
  }
}
