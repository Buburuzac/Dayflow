//
//  Port of windows/tests/sync-integration.test.ts: the full client loop (sign-in, backfill, push,
//  pull, SSE, edits, projects, docs, revoke, sign-out) against the in-memory MockSyncServer, or
//  against a real Dayflow Sync Server (DEV_AUTH=1) when DAYFLOW_SYNC_E2E_URL is set.
//

import GRDB
import XCTest

@testable import DayflowSyncCore

let REAL_SERVER = ProcessInfo.processInfo.environment["DAYFLOW_SYNC_E2E_URL"] ?? ""
/// The e2e stack bootstraps this address as workspace owner (BOOTSTRAP_ADMIN_EMAILS).
let ADMIN_EMAIL = ProcessInfo.processInfo.environment["DAYFLOW_SYNC_E2E_ADMIN"] ?? "mac@velesagro.pl"

final class MemoryCategories: CategoryDocBridge, @unchecked Sendable {
  private let lock = NSLock()
  private var cats: [SyncCategory]
  init(_ cats: [SyncCategory]) { self.cats = cats }
  var value: [SyncCategory] {
    lock.lock()
    defer { lock.unlock() }
    return cats
  }
  func set(_ c: [SyncCategory]) {
    lock.lock()
    cats = c
    lock.unlock()
  }
  func currentCategories() -> [SyncCategory]? { value }
  func applyRemoteCategories(_ categories: [SyncCategory]) { set(categories) }
}

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func inc() {
    lock.lock()
    n += 1
    lock.unlock()
  }
  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return n
  }
}

struct TestDevice {
  let store: MacStore
  let engine: SyncEngine
  let token: InMemorySyncTokenStore
  let categories: MemoryCategories
  let cardsChanged: Counter
}

func makeDevice(
  _ dir: URL, _ name: String, url: String, transport: SyncHTTPTransport, background: Bool = false,
  policy: SyncPolicy = .shareAll
) async throws -> TestDevice {
  let store = try MacStore(dir: dir, name: name)
  // The loop tests exchange full cards; the upload policy has its own tests.
  store.local.policy = policy
  let token = InMemorySyncTokenStore()
  let cats = MemoryCategories([
    SyncCategory(name: "Work", color: "#B984FF", description: ""),
    SyncCategory(name: "Idle", color: "#A0AEC0", description: "", isIdle: true),
  ])
  let counter = Counter()
  var events = SyncEngineEvents()
  events.onCardsChanged = { counter.inc() }
  let db = store.db
  let engine = SyncEngine(
    local: store.local, database: { db }, docs: MacSyncDocSources(categories: cats), labels: store.labels, token: token,
    transport: transport,
    config: SyncEngineConfig(deviceName: name, platform: "macos", background: background, pushDebounce: 0.05),
    events: events)
  _ = try await engine.setServerUrl(url)
  return TestDevice(store: store, engine: engine, token: token, categories: cats, cardsChanged: counter)
}

func waitFor(_ seconds: Double = 8, _ cond: () async throws -> Bool) async throws {
  let until = Date().addingTimeInterval(seconds)
  while !(try await cond()) {
    if Date() > until { throw SyncError("timed out waiting") }
    try await Task.sleep(nanoseconds: 25_000_000)
  }
}

let STANDUP_JSON = """
  {"highlightsTitle":"Yesterday's highlights","highlights":[{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","text":"shipped"}],\
  "tasksTitle":"Today's tasks","tasks":[],"blockersTitle":"Blockers","blockersBody":"",\
  "generation":{"provider":"claude","runtime":"chat_cli","generatedAt":784000000.5,"sourceDay":"2026-11-06"}}
  """

final class SyncIntegrationTests: XCTestCase {
  var dir: URL!

  override func setUpWithError() throws {
    dir = try tempDir()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testTwoDevicesExchangeCardsEditsProjectsAndDocsThroughTheServer() async throws {
    let mock = MockSyncServer(devAuth: true)
    let real = !REAL_SERVER.isEmpty
    let url = real ? REAL_SERVER : "http://mock.local"
    let transport: SyncHTTPTransport = real ? URLSessionSyncTransport() : mock
    let A = try await makeDevice(dir, "desktop", url: url, transport: transport)
    let B = try await makeDevice(dir, "laptop", url: url, transport: transport)
    defer {
      Task {
        await A.engine.stop()
        await B.engine.stop()
      }
    }
    // A had cards before signing in: they are backfilled on sign-in.
    let b1 = try A.store.createBatch(t9, t9 + 900)
    try A.store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Desktop: sync design")], batchId: b1)
    let provisional = A.store.local.deviceId

    let cfg = await A.engine.authConfig()
    XCTAssertEqual(cfg, AuthConfigStatus(reachable: true, googleConfigured: false, devAuth: true, error: nil))
    do {
      _ = try await A.engine.signInGoogle()
      XCTFail("Google sign-in must fail without a client id")
    } catch {
      XCTAssertTrue(syncErrorMessage(error).contains("not configured"), syncErrorMessage(error))
    }

    // Daily docs written before sign-in are uploaded after the first pull.
    try A.store.saveDailyStandup("2026-11-07", STANDUP_JSON)
    try A.store.saveDayGoalPlan(day: "2026-11-07", focus: 240, distraction: 60, focusCats: [("cat-1", "Work", "#B984FF")])

    let st = try await A.engine.signInDev(email: ADMIN_EMAIL)
    XCTAssertTrue(st.signedIn)
    XCTAssertEqual(st.user?.email, ADMIN_EMAIL)
    XCTAssertEqual(st.pending, 0)
    // The mock assigns a new device id; the real server keeps the client's proposed uuid.
    XCTAssertEqual(A.store.local.deviceId, st.deviceId)
    if !real { XCTAssertNotEqual(A.store.local.deviceId, provisional, "server-assigned device id adopted") }
    XCTAssertEqual(try A.store.cardsForDay("2026-11-08")[0].deviceId, A.store.local.deviceId)
    XCTAssertEqual(st.workspaces.map { $0.role }, [.owner])

    _ = try await B.engine.signInDev(email: ADMIN_EMAIL)
    var onB = try B.store.cardsForDay("2026-11-08").filter { $0.deviceId == A.store.local.deviceId }
    XCTAssertEqual(onB.map { $0.title }, ["Desktop: sync design"])
    XCTAssertTrue(onB[0].remote)
    // The standup arrives in the Mac's own JSON form (generatedAt back as seconds since 2001).
    let standupOnB = try XCTUnwrap(try B.store.fetchStandup("2026-11-07"))
    XCTAssertEqual(JSONValue.parse(standupOnB), JSONValue.parse(STANDUP_JSON))
    let goalOnB = try B.store.read { try MacSyncDocSources.readDayGoal($0, day: "2026-11-07") }
    XCTAssertEqual(goalOnB?["focusTargetMinutes"], .int(240))
    XCTAssertEqual(goalOnB?["focusCategories"]?.arrayValue?.first?["categoryID"], .string("cat-1"))
    XCTAssertGreaterThan(B.cardsChanged.value, 0)

    // B renames A's card; A changes its category. Both edits survive on both devices.
    try B.store.updateTimelineCard(onB[0].id, title: "Sync design (renamed on laptop)")
    let aCard = try A.store.cardsForDay("2026-11-08")[0]
    try A.store.updateTimelineCard(aCard.id, category: "Idle")
    _ = await B.engine.syncNow()
    _ = await A.engine.syncNow()
    _ = await B.engine.syncNow()
    let a1 = try A.store.card(aCard.id)!
    XCTAssertEqual(a1.title, "Sync design (renamed on laptop)")
    XCTAssertEqual(a1.category, "Idle")
    onB = try B.store.cardsForDay("2026-11-08").filter { $0.deviceId == A.store.local.deviceId }
    XCTAssertEqual(onB[0].title, "Sync design (renamed on laptop)")
    XCTAssertEqual(onB[0].category, "Idle")

    // B analyses its own overlapping time: A's card on B stays; A's analysis doesn't touch B's card.
    let bb = try B.store.createBatch(t9, t9 + 900)
    try B.store.replaceTimelineCardsInRange(from: t9, to: t9 + 2700, with: [TestCard(startTs: t9, endTs: t9 + 1200, title: "Laptop: email")], batchId: bb)
    _ = await B.engine.syncNow()
    _ = await A.engine.syncNow()
    let ab = try A.store.createBatch(t9 + 900, t9 + 1800)
    try A.store.replaceTimelineCardsInRange(from: t9, to: t9 + 2700, with: [TestCard(startTs: t9, endTs: t9 + 2400, title: "Desktop: sync design v2")], batchId: ab)
    let mine = Set([A.store.local.deviceId, B.store.local.deviceId])
    func titles(_ d: TestDevice) throws -> [String] {
      try d.store.cardsForDay("2026-11-08").filter { mine.contains($0.deviceId ?? "") }.map { $0.title }.sorted()
    }
    XCTAssertEqual(try titles(A), ["Desktop: sync design v2", "Laptop: email"])
    _ = await A.engine.syncNow()
    _ = await B.engine.syncNow()
    XCTAssertEqual(try titles(B), ["Desktop: sync design v2", "Laptop: email"])

    // Admin creates a project on A; B receives it. Manual assignment + private flag sync too.
    var wsId = "ws-1"
    if real { wsId = try await A.engine.me().workspaces[0].id }
    let proj = try await A.engine.saveProject(
      ProjectDraft(
        workspaceId: wsId, name: "Dayflow \(real ? String(syncNowMs()) : "")".trimmingCharacters(in: .whitespaces),
        color: "#336699", description: "desktop app", rules: ProjectRules(apps: ["code"]), defaultShare: .cards,
        odoo: OdooMapping(projectId: 12, taskId: 34, projectName: "Internal", taskName: "Dayflow")))
    let v2 = try A.store.cardsForDay("2026-11-08").first { $0.title == "Desktop: sync design v2" }!
    try await A.engine.assignCard(recordId: v2.id, projectId: proj.id)
    try await A.engine.setCardPrivate(recordId: v2.id, isPrivate: true)
    try await A.engine.setMyShare(projectId: proj.id, level: .time)
    _ = await A.engine.syncNow()
    _ = await B.engine.syncNow()
    let projOnB = await B.engine.listProjects().first { $0.id == proj.id }
    XCTAssertEqual(projOnB?.defaultShare, .cards)
    XCTAssertEqual(projOnB?.odoo.taskId, 34)
    XCTAssertEqual(projOnB?.myShare, .time)
    let lastA = await A.engine.status().lastError
    let lastB = await B.engine.status().lastError
    XCTAssertNil(lastA, "no change was rejected")
    XCTAssertNil(lastB, "no change was rejected")
    // A private card never leaves its Mac: the copy B already had is removed, and on A it stays intact.
    XCTAssertNil(try B.store.cardsForDay("2026-11-08").first { $0.uuid == v2.uuid })
    let infoA = await A.engine.cardSyncInfo(recordIds: [v2.id])[v2.id]!
    XCTAssertTrue(infoA.isPrivate)
    XCTAssertEqual(try A.store.card(v2.id)?.title, "Desktop: sync design v2")
    XCTAssertEqual(infoA.projects.map { "\($0.name) \($0.source.rawValue) \($0.confirmed)" }, ["\(proj.name) manual true"])

    // Nothing but syncable, non-error records went up; every change came from the caller's device.
    if !real {
      let all = mock.allPushes
      XCTAssertTrue(all.allSatisfy { $0.entity != .card || $0.data?["isError"]?.boolValue != true })
      XCTAssertFalse(all.isEmpty)
    }

    // Web dashboard link, device list, revoke.
    let link = try await A.engine.webLink()
    XCTAssertTrue(real ? link.absoluteString.contains("/api/auth/web-link/") : link.host == "dashboard.local", link.absoluteString)
    let me = try await A.engine.me()
    XCTAssertTrue(me.devices.filter { !$0.revoked }.count >= 2)
    XCTAssertEqual(me.devices.first { $0.current == true }?.id, A.store.local.deviceId)
    _ = try await A.engine.revokeDevice(B.store.local.deviceId)
    let afterRevoke = await B.engine.syncNow()
    XCTAssertFalse(afterRevoke.signedIn, "revoked device stops syncing")
    XCTAssertTrue((afterRevoke.lastError ?? "").contains("rejected this device"))

    // Signing out removes other devices' cards and projects, keeps own cards.
    let out = await A.engine.signOut()
    XCTAssertFalse(out.signedIn)
    XCTAssertEqual(try A.store.cardsForDay("2026-11-08").map { $0.title }, ["Desktop: sync design v2"])
    let projectsAfter = await A.engine.listProjects()
    XCTAssertTrue(projectsAfter.isEmpty)
    XCTAssertEqual(out.pending, 0)
  }

  func testSSEChangedEventsTriggerAPullAndWritesArePushedAfterADebounce() async throws {
    let mock = MockSyncServer(devAuth: true)
    let real = !REAL_SERVER.isEmpty
    let url = real ? REAL_SERVER : "http://mock.local"
    let transport: SyncHTTPTransport = real ? URLSessionSyncTransport() : mock
    let A = try await makeDevice(dir, "desktop", url: url, transport: transport, background: true)
    let B = try await makeDevice(dir, "laptop", url: url, transport: transport, background: true)
    let email = real ? "team-\(syncNowMs())@velesagro.pl" : "team@velesagro.pl"
    _ = try await A.engine.signInDev(email: email)
    _ = try await B.engine.signInDev(email: email)
    try await waitFor(10) { await B.engine.status().streamConnected }
    // A analyses a batch: the outbox nudge pushes it, the server notifies B's stream, B pulls.
    let b = try A.store.createBatch(t9, t9 + 900)
    try A.store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Pushed live")], batchId: b)
    try await waitFor(10) { try B.store.cardsForDay("2026-11-08").contains { $0.title == "Pushed live" } }
    try await waitFor(5) { await A.engine.status().pending == 0 }
    await A.engine.stop()
    await B.engine.stop()
    mock.closeAllStreams()
  }

  func testDevAuthIsRefusedWhenTheServerDoesNotOfferIt() async throws {
    let mock = MockSyncServer(devAuth: false)
    let A = try await makeDevice(dir, "desktop", url: "http://mock.local", transport: mock)
    let cfg = await A.engine.authConfig()
    XCTAssertEqual(cfg, AuthConfigStatus(reachable: true, googleConfigured: false, devAuth: false, error: nil))
    do {
      _ = try await A.engine.signInDev(email: "a@b.c")
      XCTFail("dev sign-in must be refused")
    } catch {
      XCTAssertTrue(syncErrorMessage(error).contains("disabled"))
    }
    let signedIn = await A.engine.signedIn()
    XCTAssertFalse(signedIn)
    let down = MockSyncServer(devAuth: true)
    down.reachable = false
    let other = try await makeDevice(dir, "other", url: "http://127.0.0.1:9", transport: down)
    let c2 = await other.engine.authConfig()
    XCTAssertFalse(c2.reachable)
    XCTAssertTrue((c2.error ?? "").contains("Could not reach the sync server"))
    // Real transport against a closed port behaves the same.
    let closed = try await makeDevice(dir, "closed", url: "http://127.0.0.1:9", transport: URLSessionSyncTransport())
    let c3 = await closed.engine.authConfig()
    XCTAssertFalse(c3.reachable)
  }

  func testServerURLIsNormalisedAndOnlyChangesWhileSignedOut() async throws {
    let mock = MockSyncServer(devAuth: true)
    let A = try await makeDevice(dir, "desktop", url: "http://mock.local", transport: mock)
    let s = try await A.engine.setServerUrl("  http://mock.local/// ")
    XCTAssertEqual(s.serverUrl, "http://mock.local")
    do {
      _ = try await A.engine.setServerUrl("ftp://x")
      XCTFail("ftp is not allowed")
    } catch {}
    _ = try await A.engine.signInDev(email: "a@b.c")
    do {
      _ = try await A.engine.setServerUrl("http://other")
      XCTFail("signed in: the server cannot change")
    } catch {
      XCTAssertTrue(syncErrorMessage(error).contains("Sign out"))
    }
  }

  /// DAYFLOW_SYNC_E2E_URL: the upload policy across two devices on a real server.
  func testUploadPolicyOutOfScopeAndPersonalCardsAcrossTwoDevices() async throws {
    try XCTSkipIf(REAL_SERVER.isEmpty, "set DAYFLOW_SYNC_E2E_URL")
    let t = URLSessionSyncTransport()
    let A = try await makeDevice(dir, "desktop", url: REAL_SERVER, transport: t, policy: .default)
    let B = try await makeDevice(dir, "laptop", url: REAL_SERVER, transport: t)
    let email = "scope-\(syncNowMs())@velesagro.pl"
    _ = try await A.engine.signInDev(email: email)
    _ = try await B.engine.signInDev(email: email)
    let b1 = try A.store.createBatch(t9, t9 + 3600)
    try A.store.replaceTimelineCardsInRange(
      from: t9, to: t9 + 3600,
      with: [
        TestCard(startTs: t9, endTs: t9 + 1800, title: "Biosun invoice import"),
        TestCard(startTs: t9 + 1800, endTs: t9 + 3600, title: "Booked the dentist", category: "Personal"),
      ], batchId: b1)
    try A.store.saveObservations(batchId: b1, [(t9, t9 + 60, "reading private messages")])
    _ = await A.engine.syncNow()
    _ = await B.engine.syncNow()
    XCTAssertEqual(try B.store.cardsForDay("2026-11-08").map { $0.title }.sorted(), [OUT_OF_SCOPE_LABEL], "work arrives without content; the personal card not at all")
    XCTAssertEqual(try B.store.count("SELECT COUNT(*) FROM observations"), 0, "no observations uploaded")
    // A's own cards are untouched by the redacted echoes.
    XCTAssertEqual(try A.store.cardsForDay("2026-11-08").map { $0.title }.sorted(), ["Biosun invoice import", "Booked the dentist"])
    let errA = await A.engine.status().lastError
    XCTAssertNil(errA)
    await A.engine.stop()
    await B.engine.stop()
  }
}
