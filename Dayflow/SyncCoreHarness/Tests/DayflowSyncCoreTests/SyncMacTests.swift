//
//  Mac-specific parts of the port: doc payload mapping (standups, day goals, categories),
//  PKCE / loopback sign-in, SSE parsing, the SyncCenter facade.
//

import GRDB
import XCTest

@testable import DayflowSyncCore

final class SyncDocsTests: XCTestCase {
  var dir: URL!

  override func setUpWithError() throws { dir = try tempDir() }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

  func testStandupUploadsInTheWindowsShapeAndComesBackInTheMacShape() throws {
    let up = try XCTUnwrap(standupPayloadFromMac(STANDUP_JSON))
    XCTAssertEqual(up["generation"]?["generatedAt"], .string("2025-11-05T01:46:40.500Z"), "seconds since 2001 → ISO-8601")
    XCTAssertEqual(up["highlights"]?.arrayValue?.first?["text"], .string("shipped"))
    // Windows writes ISO dates and may omit fields; the Mac decoder gets every required key.
    let windows: JSONValue = .object([
      "highlights": .array([.object(["id": .string("not-a-uuid"), "text": .string("a")])]),
      "tasks": .array([.object(["text": .string("b")]), .string("junk")]),
      "blockersBody": .string("none"),
      "generation": .object(["provider": .string("gemini"), "generatedAt": .string("2026-11-08T07:00:00.000Z"), "sourceDay": .string("2026-11-07")]),
    ])
    let mac = try XCTUnwrap(JSONValue.parse(standupJSONForMac(windows)))
    XCTAssertEqual(mac["highlightsTitle"], .string("Yesterday's highlights"))
    XCTAssertEqual(mac["tasksTitle"], .string("Today's tasks"))
    XCTAssertEqual(mac["blockersTitle"], .string("Blockers"))
    XCTAssertEqual(mac["tasks"]?.arrayValue?.count, 1)
    XCTAssertNotNil(UUID(uuidString: mac["highlights"]?.arrayValue?[0]["id"]?.stringValue ?? ""), "ids are UUIDs for DailyBulletItem")
    XCTAssertEqual(mac["generation"]?["runtime"], .string("gemini_direct"), "runtime filled from the provider like Windows RUNTIME")
    let at = try XCTUnwrap(mac["generation"]?["generatedAt"]?.numberValue)
    XCTAssertEqual(Date(timeIntervalSinceReferenceDate: at).timeIntervalSince1970, 1_794_121_200, accuracy: 0.001)
    // Round trip Mac → server → Mac is lossless.
    XCTAssertEqual(JSONValue.parse(standupJSONForMac(up)), JSONValue.parse(STANDUP_JSON))
  }

  func testDayGoalsReadAndWriteTheSharedPlanShape() throws {
    let store = try MacStore(dir: dir)
    try store.saveDayGoalPlan(day: "2026-11-08", focus: 270, distraction: 120, focusCats: [("A", "Work", "#111111"), ("B", "Code", "#222222")])
    let p = try XCTUnwrap(try store.db.read { try MacSyncDocSources.readDayGoal($0, day: "2026-11-08") })
    XCTAssertEqual(p["day"], .string("2026-11-08"))
    XCTAssertEqual(p["distractionLimitMinutes"], .int(120))
    XCTAssertEqual(p["isSkipped"], .bool(false))
    XCTAssertEqual(p["focusCategories"]?.arrayValue?.map { $0["name"]?.stringValue ?? "" }, ["Work", "Code"])
    XCTAssertEqual(p["focusCategories"]?.arrayValue?[1]["sortOrder"], .int(1))
    // A Windows plan (category ids are normalised names) lands in the Mac tables.
    let docs = MacSyncDocSources(categories: nil)
    var w = p.objectValue!
    w["focusCategories"] = .array([.object(["categoryID": .string("work"), "name": .string("Work"), "colorHex": .string("#B984FF"), "sortOrder": .int(0)])])
    w["isSkipped"] = .bool(true)
    try store.db.write { try docs.write($0, .dayGoal, "2026-11-09", .object(w)) }
    let back = try XCTUnwrap(try store.db.read { try MacSyncDocSources.readDayGoal($0, day: "2026-11-09") })
    XCTAssertEqual(back["isSkipped"], .bool(true))
    XCTAssertEqual(back["focusCategories"]?.arrayValue?.first?["categoryID"], .string("work"))
    try store.db.write { try docs.write($0, .dayGoal, "2026-11-09", nil) }
    XCTAssertNil(try store.db.read { try MacSyncDocSources.readDayGoal($0, day: "2026-11-09") })
  }

  func testCategoriesFollowWindowsValidation() {
    let ok = validateSyncCategories(
      .array([
        .object(["name": .string(" Work "), "color": .string("#B984FF"), "description": .string("d")]),
        .object(["name": .string("Idle"), "color": .string("#A0AEC0aa"), "description": .null, "isIdle": .bool(true)]),
      ]))
    XCTAssertEqual(ok, [SyncCategory(name: "Work", color: "#B984FF", description: "d"), SyncCategory(name: "Idle", color: "#A0AEC0aa", description: "", isIdle: true)])
    XCTAssertNil(validateSyncCategories(.array([])), "1–30 items")
    XCTAssertNil(validateSyncCategories(.array([.object(["name": .string("A"), "color": .string("red")])])), "hex colours only")
    XCTAssertNil(
      validateSyncCategories(.array([.object(["name": .string("A"), "color": .string("#000000")]), .object(["name": .string("a"), "color": .string("#000000")])])),
      "names unique case-insensitively")
    XCTAssertNil(validateSyncCategories(.array([.object(["name": .string("A"), "color": .string("#000000"), "description": .string(String(repeating: "x", count: 501))])])))
    // Uploads are clipped so Windows accepts them.
    let up = categoriesPayload([
      SyncCategory(name: String(repeating: "n", count: 70), color: "nope", description: String(repeating: "d", count: 900)),
      SyncCategory(name: "Idle", color: "#A0AEC0", description: "", isIdle: true),
    ])
    XCTAssertNotNil(validateSyncCategories(up))
    XCTAssertEqual(up?.arrayValue?[0]["color"], .string("#E5E7EB"))
    XCTAssertEqual(up?.arrayValue?[1]["isIdle"], .bool(true))
  }

  func testCategoriesDocUploadsAndAppliesThroughTheBridge() throws {
    let store = try MacStore(dir: dir)
    let cats = MemoryCategories([SyncCategory(name: "Work", color: "#B984FF", description: "work stuff")])
    let docs = MacSyncDocSources(categories: cats)
    let payload = try store.db.read { try docs.read($0, .userDoc, "categories") }
    XCTAssertEqual(payload, .array([.object(["name": .string("Work"), "color": .string("#B984FF"), "description": .string("work stuff")])]))
    try store.db.write {
      try docs.write($0, .userDoc, "categories", .array([.object(["name": .string("Deep work"), "color": .string("#000000"), "description": .string("")])]))
    }
    XCTAssertEqual(cats.value.map { $0.name }, ["Deep work"])
    // An invalid payload is ignored, as on Windows.
    try store.db.write { try docs.write($0, .userDoc, "categories", .array([.object(["color": .string("#000000")])])) }
    XCTAssertEqual(cats.value.map { $0.name }, ["Deep work"])
  }

  func testDocWritesAreTrackedOnlyWhileSignedIn() throws {
    let store = try MacStore(dir: dir)
    try store.saveDailyStandup("2026-11-08", STANDUP_JSON)
    XCTAssertEqual(try store.pendingCount(), 0, "before sign-in nothing is tracked")
    try store.setSyncEnabled(true)
    try store.saveDailyStandup("2026-11-08", STANDUP_JSON)
    let docs = MacSyncDocSources(categories: nil)
    let ch = try store.buildBatch(docs, userId: "u1").changes
    XCTAssertEqual(ch.map { $0.id }, ["u1:2026-11-08"])
    XCTAssertEqual(ch[0].entity, .standup)
    XCTAssertEqual(ch[0].data?["day"], .string("2026-11-08"))
    XCTAssertEqual(ch[0].data?["payload"]?["generation"]?["generatedAt"], .string("2025-11-05T01:46:40.500Z"))
  }
}

final class SyncAuthTests: XCTestCase {
  func testSHA256AndPKCE() {
    XCTAssertEqual(syncSHA256(Array("abc".utf8)).map { String(format: "%02x", $0) }.joined(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    XCTAssertEqual(syncSHA256([]).map { String(format: "%02x", $0) }.joined(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    let long = Array(String(repeating: "a", count: 1000).utf8)
    XCTAssertEqual(syncSHA256(long).map { String(format: "%02x", $0) }.joined(), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    // RFC 7636 appendix B
    XCTAssertEqual(syncBase64url(syncSHA256(Array("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".utf8))), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    let (v, c) = pkcePair()
    XCTAssertEqual(v.count, 64)
    XCTAssertEqual(c, syncBase64url(syncSHA256(Array(v.utf8))))
    XCTAssertFalse(v.contains("=") || v.contains("+") || v.contains("/"))
  }

  func testAuthorizeURL() throws {
    let u = authorizeUrl(clientId: "cid.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:5555/callback", challenge: "ch", state: "st")
    let q = try XCTUnwrap(URLComponents(string: u)?.queryItems)
    let d = Dictionary(uniqueKeysWithValues: q.map { ($0.name, $0.value ?? "") })
    XCTAssertTrue(u.hasPrefix(GOOGLE_AUTHORIZE_URL + "?"))
    XCTAssertEqual(d["redirect_uri"], "http://127.0.0.1:5555/callback")
    XCTAssertEqual(d["scope"], "openid email profile")
    XCTAssertEqual(d["code_challenge_method"], "S256")
    XCTAssertEqual(d["response_type"], "code")
    XCTAssertEqual(d["prompt"], "select_account")
  }

  /// In-memory listener: the "browser" calls `deliver`.
  final class FakeListener: LoopbackHTTPListener, @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<[URLQueryItem], Error>?
    private var reply: (@Sendable ([URLQueryItem]) -> (status: Int, html: String))?
    var lastPage: (status: Int, html: String)?
    var stopped = false
    func start() async throws -> UInt16 { 5555 }
    func awaitCallback(reply: @escaping @Sendable ([URLQueryItem]) -> (status: Int, html: String)) async throws -> [URLQueryItem] {
      try await withCheckedThrowingContinuation { c in
        lock.lock()
        cont = c
        self.reply = reply
        lock.unlock()
      }
    }
    func deliver(_ items: [URLQueryItem]) {
      lock.lock()
      let c = cont
      cont = nil
      let r = reply
      lock.unlock()
      lastPage = r?(items)
      c?.resume(returning: items)
    }
    func stop() {
      stopped = true
      lock.lock()
      let c = cont
      cont = nil
      lock.unlock()
      c?.resume(throwing: CancellationError())
    }
  }

  func testLoopbackSignInChecksStateAndReturnsTheCode() async throws {
    let l = FakeListener()
    let r = try await loopbackAuthorize(clientId: "cid", listener: l, openBrowser: { url in
      let q = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
      let state = q.first { $0.name == "state" }!.value!
      XCTAssertEqual(q.first { $0.name == "redirect_uri" }?.value, "http://127.0.0.1:5555/callback")
      Task { l.deliver([URLQueryItem(name: "code", value: "4/abc"), URLQueryItem(name: "state", value: state)]) }
    })
    XCTAssertEqual(r.code, "4/abc")
    XCTAssertEqual(r.redirectUri, "http://127.0.0.1:5555/callback")
    XCTAssertEqual(l.lastPage?.status, 200)
    XCTAssertTrue(l.stopped)

    let bad = FakeListener()
    do {
      _ = try await loopbackAuthorize(clientId: "cid", listener: bad, openBrowser: { _ in
        Task { bad.deliver([URLQueryItem(name: "code", value: "x"), URLQueryItem(name: "state", value: "forged")]) }
      })
      XCTFail("a forged state must fail")
    } catch {
      XCTAssertEqual(bad.lastPage?.status, 400)
    }
    let denied = FakeListener()
    do {
      _ = try await loopbackAuthorize(clientId: "cid", listener: denied, openBrowser: { _ in
        Task { denied.deliver([URLQueryItem(name: "error", value: "access_denied")]) }
      })
      XCTFail("denied")
    } catch {
      XCTAssertEqual(syncErrorMessage(error), "Sign-in was cancelled.")
    }
    let slow = FakeListener()
    do {
      _ = try await loopbackAuthorize(clientId: "cid", listener: slow, openBrowser: { _ in }, timeout: 0.2)
      XCTFail("timeout")
    } catch {
      XCTAssertEqual(syncErrorMessage(error), "Sign-in timed out. Try again.")
    }
  }

  func testSSEParser() {
    let p = SSEParser()
    var events: [String] = []
    for l in ["retry: 5000", "", ": heartbeat", "event: changed", "data: {}", "", "event: ping", "data: {\"t\":1}", "data:2", "", "data: x", ""] {
      if let e = p.feed(l) { events.append("\(e.event)|\(e.data)") }
    }
    XCTAssertEqual(events, ["changed|{}", "ping|{\"t\":1}\n2", "message|x"])
  }

  func testWireShapes() throws {
    let c = SyncChange(entity: .cardProject, id: "a:b", deviceId: "d", hlc: "h", data: ["share": .double(0.5)])
    let s = String(data: try SyncCoding.encode(c), encoding: .utf8)!
    XCTAssertTrue(s.contains("\"entity\":\"card_project\""))
    XCTAssertFalse(s.contains("fieldHlc"), "absent keys are omitted")
    let pulled = try SyncCoding.decode(
      PullResponse.self,
      from: Data(#"{"changes":[{"entity":"card","id":"x","deviceId":"d","hlc":"h","deleted":false,"data":null,"fieldHlc":{"title":"t","bad":3}}],"cursor":42,"more":false}"#.utf8))
    XCTAssertEqual(pulled.cursor, 42)
    XCTAssertNil(pulled.changes?[0].data)
    XCTAssertEqual(pulled.changes?[0].fieldHlc, ["title": "t"])
    XCTAssertEqual(try normalizeServerUrl(" https://h:8790/ "), "https://h:8790")
    XCTAssertThrowsError(try normalizeServerUrl("ftp://h"))
    XCTAssertEqual(splitPair("a:b:c").map { [$0.0, $0.1] }, ["a", "b:c"])
    XCTAssertNil(splitPair(":b"))
    XCTAssertNoThrow(try sanitizeSubmit(TimesheetSubmitRequest(lines: [TimesheetLine(day: "2026-11-08", projectId: "p", hours: 1.234, description: "d", cardIds: [])])))
    XCTAssertEqual(try sanitizeSubmit(TimesheetSubmitRequest(lines: [TimesheetLine(day: "2026-11-08", projectId: "p", hours: 1.234, description: " d ", cardIds: [])])).lines[0].hours, 1.23)
    XCTAssertThrowsError(try sanitizeSubmit(TimesheetSubmitRequest(lines: [TimesheetLine(day: "2026-11-08", projectId: "p", hours: 25, description: "", cardIds: [])])))
    XCTAssertThrowsError(try checkRange("2026-11-09", "2026-11-08"))
    let d = try sanitizeProjectDraft(ProjectDraft(id: "nope", workspaceId: " w ", name: "  P ", color: "red", rules: ProjectRules(apps: [" code ", "code", ""]), odoo: OdooMapping(projectId: -1, taskId: 7, projectName: " ")))
    XCTAssertNil(d.id)
    XCTAssertEqual(d.name, "P")
    XCTAssertEqual(d.color, "#7BC47F")
    XCTAssertEqual(d.rules.apps, ["code"])
    XCTAssertNil(d.rules.domains)
    XCTAssertNil(d.odoo.projectId)
    XCTAssertEqual(d.odoo.taskId, 7)
    XCTAssertNil(d.odoo.projectName)
  }
}

/// SyncCenter end to end on the mock: the facade the UI uses.
final class SyncCenterTests: XCTestCase {
  final class TestPlatform: SyncPlatform, @unchecked Sendable {
    let deviceName = "Test Mac"
    let platformName = "macos"
    let tokenStore: SyncTokenStore = InMemorySyncTokenStore()
    let defaults: UserDefaults
    let transport: SyncHTTPTransport
    let local: SyncLocal
    let background = false
    let store: MacStore
    var categories: CategoryDocBridge? { nil }
    var windowLabels: WindowLabelSource? { nil }
    init(store: MacStore, transport: SyncHTTPTransport) {
      self.store = store
      self.transport = transport
      self.local = store.local
      defaults = UserDefaults(suiteName: "dayflow-sync-tests-\(UUID().uuidString)")!
    }
    func database() -> DatabaseWriter { store.db }
    func openURL(_ url: URL) async throws {}
    func makeLoopbackListener() -> LoopbackHTTPListener { SyncAuthTests.FakeListener() }
  }

  @MainActor
  func testFacadeSignInPolicyProjectsAndSignOut() async throws {
    let dir = try tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try MacStore(dir: dir)
    let mock = MockSyncServer(devAuth: true)
    let platform = TestPlatform(store: store, transport: mock)
    let center = SyncCenter()
    center.start(platform: platform)
    try await center.setServerURL("http://mock.local")
    XCTAssertEqual(center.policy, .default, "defaults: Personal excluded, out of scope on, observations off")
    XCTAssertEqual(store.local.policy, .default)
    let cfg = await center.refreshAuthConfig()
    XCTAssertTrue(cfg.devAuth)
    let st = try await center.signInDev(email: "mac@velesagro.pl")
    XCTAssertTrue(st.signedIn)
    XCTAssertEqual(center.status.user?.email, "mac@velesagro.pl")
    XCTAssertEqual(center.status.deviceName, "Test Mac")
    XCTAssertTrue(center.canEditProjects(workspaceId: "ws-1"))

    await center.setObservationsUpload(true)
    XCTAssertTrue(platform.defaults.bool(forKey: SyncPolicyKeys.observations))
    XCTAssertTrue(store.local.policy.observations)
    await center.setExcludedCategories(["Personal", " Health ", ""])
    XCTAssertEqual(platform.defaults.stringArray(forKey: SyncPolicyKeys.excludedCategories), ["Personal", "Health"])

    let p = try await center.saveProject(ProjectDraft(workspaceId: "ws-1", name: "Biosun", color: "#336699"))
    XCTAssertEqual(center.projects.map { $0.name }, ["Biosun"])
    let b = try store.createBatch(t9, t9 + 900)
    let ids = try store.replaceTimelineCardsInRange(from: t9, to: t9 + 1800, with: [TestCard(startTs: t9, endTs: t9 + 1800, title: "Invoices")], batchId: b)
    try await center.assignCard(recordId: ids[0], projectId: p.id)
    let info = await center.cardSyncInfo(recordIds: ids)
    XCTAssertEqual(info[ids[0]]?.projects.first?.name, "Biosun")
    let after = await center.syncNow()
    XCTAssertNil(after.lastError)
    XCTAssertEqual(after.pending, 0)
    let pushedTitle = mock.allPushes.last { $0.entity == .card && $0.deleted != true }?.title
    XCTAssertEqual(pushedTitle, "Invoices", "confirmed project work uploads in full")

    let out = await center.signOut()
    XCTAssertFalse(out.signedIn)
    XCTAssertTrue(center.projects.isEmpty)
    center.stop()
  }
}
