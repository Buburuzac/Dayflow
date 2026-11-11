//
//  SyncEngine.swift
//  Dayflow — Dayflow Sync client core
//
//  Sync engine and account operations (port of windows/src/main/sync/service.ts), independent of
//  AppKit/SwiftUI. One actor serialises everything: push loop with batching and backoff, pull loop
//  with a cursor, an SSE stream that triggers pulls, sign-in/out and the team API.
//  `SyncCenter` (SyncCenter.swift) is the UI-facing facade on top of it.
//

import Foundation
import GRDB

/// Where the device token lives (Keychain on the Mac, memory in tests).
protocol SyncTokenStore: AnyObject, Sendable {
  /// "" when there is none.
  func get() -> String
  /// "" removes it. Throws when the token could not be stored or removed.
  func set(_ token: String) throws
}

final class InMemorySyncTokenStore: SyncTokenStore, @unchecked Sendable {
  private let lock = NSLock()
  private var token = ""
  init(_ token: String = "") { self.token = token }
  func get() -> String {
    lock.lock()
    defer { lock.unlock() }
    return token
  }
  func set(_ token: String) {
    lock.lock()
    self.token = token
    lock.unlock()
  }
}

struct SyncEngineConfig: Sendable {
  var deviceName: String
  var platform: String
  /// Days of existing cards/observations uploaded after the first sign-in.
  var backfillDays = 30
  /// Background timers, push debounce and the SSE stream (off in unit tests).
  var background = true
  var pushDebounce: TimeInterval = 3
  /// Interval of the periodic sync cycle.
  var periodicInterval: TimeInterval = 60

  init(deviceName: String, platform: String, backfillDays: Int = 30, background: Bool = true, pushDebounce: TimeInterval = 3) {
    self.deviceName = deviceName
    self.platform = platform
    self.backfillDays = backfillDays
    self.background = background
    self.pushDebounce = pushDebounce
  }
}

/// Notifications out of the engine (called from the engine's executor; hop to the main actor yourself).
struct SyncEngineEvents: Sendable {
  var onCardsChanged: (@Sendable () -> Void)?
  var onProjectsChanged: (@Sendable () -> Void)?
  var onDocsChanged: (@Sendable ([DocEntity]) -> Void)?
  var onStatus: (@Sendable () -> Void)?
  /// The sync policy changed because of pulled data (a category renamed on another device kept its
  /// exclusion); persist `policy` and refresh the UI.
  var onPolicyChanged: (@Sendable (SyncPolicy) -> Void)?
  init() {}
}

private let MAX_BACKOFF: TimeInterval = 5 * 60

private func safeText(_ s: String?, _ maxLen: Int) -> String {
  String((s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxLen))
}

actor SyncEngine {
  nonisolated let local: SyncLocal
  nonisolated let repo: SyncRepo
  private let database: @Sendable () -> DatabaseWriter
  private let docs: SyncDocSources
  private let labels: WindowLabelSource?
  private let token: SyncTokenStore
  private let transport: SyncHTTPTransport
  private let config: SyncEngineConfig
  private let openBrowser: (@Sendable (URL) async throws -> Void)?
  private let makeListener: (@Sendable () -> LoopbackHTTPListener)?
  private var events: SyncEngineEvents

  private var running: Task<Void, Never>?
  private var again = false
  private var failures = 0
  private var syncing = false
  private var streamConnected = false
  private var streaming = false
  private var streamTask: Task<Void, Never>?
  private var periodicTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private var pushTask: Task<Void, Never>?
  private var pullTask: Task<Void, Never>?
  private var rejectNote: String?
  private var needsDocBackfill = false
  private var lastChunkAt = Date()
  /// Incremented on every sign-in, sign-out and lost authorisation. A cycle captures it when it
  /// starts and re-checks it after every await before it writes, so work begun for one session
  /// never lands in the next (e.g. a slow pull finishing after sign-out).
  private var session = 0

  init(
    local: SyncLocal, database: @escaping @Sendable () -> DatabaseWriter, docs: SyncDocSources,
    labels: WindowLabelSource?, token: SyncTokenStore, transport: SyncHTTPTransport = URLSessionSyncTransport(),
    config: SyncEngineConfig, openBrowser: (@Sendable (URL) async throws -> Void)? = nil,
    makeListener: (@Sendable () -> LoopbackHTTPListener)? = nil, events: SyncEngineEvents = SyncEngineEvents()
  ) {
    self.local = local
    self.repo = SyncRepo(local: local)
    self.database = database
    self.docs = docs
    self.labels = labels
    self.token = token
    self.transport = transport
    self.config = config
    self.openBrowser = openBrowser
    self.makeListener = makeListener
    self.events = events
    let weakNudge: @Sendable () -> Void = { [weak self] in
      guard let self else { return }
      Task { await self.nudge() }
    }
    local.onOutbox = weakNudge
    local.onCardsInserted = { [weak self] refs in
      guard let self else { return }
      Task { await self.assignInserted(refs) }
    }
  }

  func setEvents(_ e: SyncEngineEvents) { events = e }

  // MARK: database

  /// Synchronous GRDB write on the app's writer (short transactions only).
  nonisolated func writeSync<T>(_ body: (Database) throws -> T) throws -> T {
    try database().write(body)
  }

  nonisolated func readSync<T>(_ body: (Database) throws -> T) throws -> T {
    try database().read(body)
  }

  private func state() -> SyncStateRow {
    (try? readSync { try repo.state($0) })
      ?? SyncStateRow(
        deviceId: local.deviceId, deviceName: "", serverUrl: DEFAULT_SYNC_SERVER_URL, enabled: false, userId: nil,
        user: nil, workspaces: [], cursor: 0, lastPushAt: nil, lastPullAt: nil, lastSyncAt: nil, lastError: nil)
  }

  private func updateState(_ p: SyncStatePatch) {
    _ = try? writeSync { try repo.updateState($0, p) }
  }

  /// Throws CancellationError when the session changed (or the task was cancelled) since `gen`.
  private func live(_ gen: Int) throws {
    if gen != session || Task.isCancelled { throw CancellationError() }
  }

  /// Cancels the running cycle (if any) and waits until it has stopped.
  private func cancelRunning() async {
    guard let t = running else { return }
    t.cancel()
    await t.value
  }

  private var outbox: SyncOutboxBuilder { SyncOutboxBuilder(local: local, docs: docs, labels: labels) }

  // MARK: status

  func signedIn() -> Bool {
    !token.get().isEmpty && state().userId != nil
  }

  private func client(withToken: Bool = true) throws -> SyncClient {
    try SyncClient(baseUrl: state().serverUrl, token: withToken ? token.get() : nil, transport: transport)
  }

  func status() -> SyncStatus {
    let s = state()
    return SyncStatus(
      serverUrl: s.serverUrl, signedIn: !token.get().isEmpty && s.userId != nil, user: s.user,
      deviceId: s.deviceId, deviceName: s.deviceName.isEmpty ? config.deviceName : s.deviceName,
      workspaces: s.workspaces, lastSyncAt: s.lastSyncAt, lastPushAt: s.lastPushAt, lastPullAt: s.lastPullAt,
      pending: (try? readSync { try repo.pendingCount($0) }) ?? 0, lastError: s.lastError, syncing: syncing,
      streamConnected: streamConnected)
  }

  private func emitStatus() { events.onStatus?() }

  func setServerUrl(_ raw: String) throws -> SyncStatus {
    if signedIn() { throw SyncError("Sign out before changing the server.") }
    let url = try normalizeServerUrl(raw)
    updateState(SyncStatePatch(serverUrl: url, lastError: .some(nil)))
    emitStatus()
    return status()
  }

  func authConfig() async -> AuthConfigStatus {
    do {
      let c = try await client(withToken: false).googleConfig()
      return AuthConfigStatus(
        reachable: true, googleConfigured: !(c.clientId ?? "").isEmpty, devAuth: c.devAuth == true, error: nil)
    } catch {
      return AuthConfigStatus(reachable: false, googleConfigured: false, devAuth: false, error: syncErrorMessage(error))
    }
  }

  // MARK: sign-in

  private func deviceInfo() -> GoogleExchangeDevice {
    GoogleExchangeDevice(name: config.deviceName, platform: config.platform, id: local.deviceId)
  }

  func signInGoogle() async throws -> SyncStatus {
    let c = try client(withToken: false)
    let cfg = try await c.googleConfig()
    guard let clientId = cfg.clientId, !clientId.isEmpty else {
      throw SyncError("Google sign-in is not configured on this server yet (no client id).")
    }
    guard let openBrowser, let makeListener else { throw SyncError("No browser available for sign-in.") }
    let r = try await loopbackAuthorize(clientId: clientId, listener: makeListener(), openBrowser: openBrowser)
    let auth = try await c.googleExchange(
      GoogleExchangeRequest(code: r.code, codeVerifier: r.codeVerifier, redirectUri: r.redirectUri, device: deviceInfo()))
    return try await completeSignIn(auth)
  }

  func signInDev(email: String) async throws -> SyncStatus {
    let c = try client(withToken: false)
    let cfg = try? await c.googleConfig()
    if let cfg, cfg.devAuth != true { throw SyncError("Dev sign-in is disabled on this server.") }
    let e = safeText(email, 200)
    let parts = e.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty, !e.contains(where: { $0.isWhitespace }) else {
      throw SyncError("Enter an email address.")
    }
    let auth = try await c.devAuth(
      DevAuthRequest(email: e, deviceName: config.deviceName, platform: config.platform, deviceId: local.deviceId))
    return try await completeSignIn(auth)
  }

  func completeSignIn(_ auth: AuthResponse) async throws -> SyncStatus {
    guard !auth.deviceToken.isEmpty, !auth.user.id.isEmpty else {
      throw SyncError("The server returned an incomplete sign-in response.")
    }
    session += 1
    let gen = session
    stop()
    await cancelRunning()
    try live(gen)
    let prev = state()
    try writeSync { db in
      // Another account, or no account on record (signed out): nothing a previous session left
      // (other devices' cards, projects, doc clocks) may stay, and the pull starts over. A sign-in
      // of the same user after a lost authorisation keeps everything.
      if prev.userId != auth.user.id {
        try repo.purgeRemote(db)
        try repo.updateState(db, SyncStatePatch(cursor: 0))
      }
    }
    do {
      try token.set(auth.deviceToken)
    } catch {
      throw SyncError("Could not save the sign-in to the Keychain: \(syncErrorMessage(error))")
    }
    let backfillDays = config.backfillDays
    let deviceName = (auth.device?.name).flatMap { $0.isEmpty ? nil : $0 } ?? config.deviceName
    try writeSync { db in
      if let id = auth.device?.id, !id.isEmpty { try local.setDeviceId(db, id) }
      try repo.updateState(
        db, SyncStatePatch(deviceName: deviceName, userId: .some(auth.user.id), user: .some(auth.user), lastError: .some(nil)))
      try local.setSyncEnabled(db, true)
      try repo.backfill(db, days: backfillDays)
      local.markScopeDirty()
      // Observation upload may have been switched off while signed out: remove what an earlier
      // session left on the server.
      if !local.policy.observations { try outbox.requeueObservations(db, upload: false) }
    }
    needsDocBackfill = true
    failures = 0
    _ = try? await me()
    start()
    await run()
    return status()
  }

  func signOut() async -> SyncStatus {
    // The revoke goes out with the current token, after the local sign-out.
    let revoke: SyncClient? = signedIn() ? (try? client()) : nil
    let deviceId = local.deviceId
    session += 1
    let gen = session
    stop()
    // From here on signedIn() is false: no new cycle starts, and the running one is cancelled and
    // awaited before anything is purged (it re-checks the session before each of its writes).
    try? token.set("")
    await cancelRunning()
    guard gen == session else { return status() }
    _ = try? writeSync { db in
      try local.setSyncEnabled(db, false)
      try repo.purgeRemote(db)
      try repo.updateState(
        db,
        SyncStatePatch(
          userId: .some(nil), user: .some(nil), workspaces: [], cursor: 0, lastPushAt: .some(nil),
          lastPullAt: .some(nil), lastSyncAt: .some(nil), lastError: .some(nil)))
    }
    events.onCardsChanged?()
    events.onProjectsChanged?()
    emitStatus()
    // Offline or already revoked: the local sign-out has happened anyway.
    if let revoke { try? await revoke.revokeDevice(deviceId) }
    return status()
  }

  /// The server no longer accepts our token (device revoked): stop syncing, keep local data.
  private func authLost() {
    session += 1
    stop()
    try? token.set("")
    _ = try? writeSync { db in
      try local.setSyncEnabled(db, false)
      try repo.updateState(
        db,
        SyncStatePatch(
          lastError: .some(
            "The server rejected this device (signed out or revoked). Sign in again to resume syncing.")))
    }
    emitStatus()
  }

  // MARK: loops

  /// Starts the background timers and the SSE stream (no-op when signed out or `background` is off).
  func start() {
    guard signedIn(), config.background else { return }
    stopTimers()
    let interval = config.periodicInterval
    periodicTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        if Task.isCancelled { break }
        await self?.run()
      }
    }
    if !streaming {
      streaming = true
      streamTask = Task { [weak self] in await self?.streamLoop() }
    }
  }

  private func stopTimers() {
    for t in [periodicTask, retryTask, pushTask, pullTask] { t?.cancel() }
    periodicTask = nil
    retryTask = nil
    pushTask = nil
    pullTask = nil
  }

  func stop() {
    stopTimers()
    streaming = false
    streamTask?.cancel()
    streamTask = nil
    streamConnected = false
  }

  /// Applies "What leaves this Mac". Cards are re-checked on the next cycle; switching observation
  /// upload off sends tombstones so the server drops their text.
  func setPolicy(_ policy: SyncPolicy) {
    let prev = local.policy
    if samePolicy(prev, policy) { return }
    local.policy = policy
    if signedIn() && prev.observations != policy.observations {
      _ = try? writeSync { try outbox.requeueObservations($0, upload: policy.observations) }
    }
    nudge()
  }

  /// Something was queued: push soon (debounced).
  func nudge() {
    guard config.background, pushTask == nil, signedIn() else { return }
    let delay = config.pushDebounce
    pushTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard !Task.isCancelled else { return }
      await self?.firePush()
    }
  }

  private func firePush() async {
    pushTask = nil
    await run()
  }

  private func schedulePull() {
    guard pullTask == nil else { return }
    pullTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 300_000_000)
      guard !Task.isCancelled else { return }
      await self?.firePull()
    }
  }

  private func firePull() async {
    pullTask = nil
    await run()
  }

  /// One pull → rescope → push cycle; concurrent calls coalesce into one more cycle.
  func run() async {
    if let t = running {
      again = true
      await t.value
      return
    }
    let t = Task { await self.runLoop() }
    running = t
    await t.value
  }

  private func runLoop() async {
    repeat {
      again = false
      await cycle()
    } while again && signedIn()
    running = nil
  }

  func syncNow() async -> SyncStatus {
    await run()
    return status()
  }

  private func cycle() async {
    guard signedIn() else { return }
    let gen = session
    syncing = true
    emitStatus()
    defer {
      syncing = false
      emitStatus()
    }
    do {
      rejectNote = nil
      // Pull first: edits from the user's other devices are merged locally before this device
      // re-sends any card, so a scope change never overrides an edit it hasn't seen yet.
      try await pull(gen)
      // Scopes may have changed (project confirmed, archived or deleted, a category edit, policy).
      // Every card ever sent is only re-checked after such a change; otherwise the recent window.
      try live(gen)
      let full = local.takeScopeDirty()
      do {
        _ = try writeSync { try outbox.rescopeCards($0, full: full) }
      } catch {
        if full { local.markScopeDirty() }
        throw error
      }
      try await push(gen)
      if needsDocBackfill {
        needsDocBackfill = false
        try live(gen)
        backfillDocs()
        try await push(gen)
      }
      try live(gen)
      failures = 0
      updateState(SyncStatePatch(lastSyncAt: .some(syncNowMs()), lastError: .some(rejectNote)))
    } catch {
      // A cycle of an ended session (signed out / in meanwhile) leaves no trace.
      if error is CancellationError || gen != session { return }
      if let h = error as? HttpError, h.status == 401 {
        authLost()
        return
      }
      failures += 1
      updateState(SyncStatePatch(lastError: .some(syncErrorMessage(error))))
      if config.background && signedIn() {
        let delay = min(MAX_BACKOFF, 5 * pow(2, Double(failures - 1)))
        retryTask?.cancel()
        retryTask = Task { [weak self] in
          try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
          guard !Task.isCancelled else { return }
          await self?.fireRetry()
        }
      }
    }
  }

  private func fireRetry() async {
    retryTask = nil
    await run()
  }

  private func push(_ gen: Int) async throws {
    guard let userId = state().userId else { return }
    let c = try client()
    let outbox = self.outbox
    for _ in 0..<200 {
      try live(gen)
      // Window labels (accessibility log files) are read outside the write transaction.
      let windowApps: [String: [String]] = try readSync { db in
        outbox.windowAppsForBatch(db, try repo.pending(db, limit: 1000))
      }
      try live(gen)
      let batch: BuiltBatch = try writeSync { db in
        let entries = try repo.pending(db, limit: 1000)
        let b = outbox.buildBatch(db, userId: userId, entries, windowApps: windowApps)
        if !b.dropped.isEmpty { try repo.markPushed(db, b.dropped) }
        return b
      }
      if batch.used.isEmpty && batch.dropped.isEmpty { return }
      if batch.changes.isEmpty { continue }
      let res: PushResponse
      do {
        res = try await c.push(batch.changes)
      } catch {
        try live(gen)
        let msg = syncErrorMessage(error)
        _ = try? writeSync { try repo.markFailed($0, batch.used, error: msg) }
        throw error
      }
      try live(gen)
      if let t = res.serverTime { local.observeHlc(formatHlc(Int64(t), 0, "server")) }
      let reasons = rejectionReasons(batch.changes, res.rejected ?? [])
      var ok: [OutboxEntry] = []
      var bad: [(entry: OutboxEntry, reason: String)] = []
      for (i, e) in batch.used.enumerated() {
        if let reason = reasons[i] { bad.append((e, reason)) } else { ok.append(e) }
      }
      try writeSync { db in
        // Remember what the server now holds (card scope, observation uploaded) for accepted changes only.
        try commitAccepted(db, batch) { reasons[$0] == nil }
        try repo.markPushed(db, ok)
        if !bad.isEmpty { try repo.markRejected(db, bad) }
        try repo.updateState(db, SyncStatePatch(lastPushAt: .some(syncNowMs())))
      }
      if let first = bad.first {
        rejectNote =
          "\(bad.count) change\(bad.count > 1 ? "s were" : " was") rejected by the server: \(first.reason)"
      }
    }
  }

  private func pull(_ gen: Int) async throws {
    let c = try client()
    var cursor = state().cursor
    var total = ApplyResult()
    let userId = state().userId
    let applier = RemoteApplier(local: local, docs: docs, userId: userId)
    for _ in 0..<1000 {
      let r = try await c.pull(cursor: cursor, limit: 1000)
      // Signed out (or in again) while the request was in flight: nothing of it may be written.
      try live(gen)
      let changes = r.changes ?? []
      let newCursor = (r.cursor.map { $0 >= cursor ? $0 : cursor }) ?? cursor
      let res: ApplyResult = try writeSync { db in
        let res = applier.apply(db, changes)
        try repo.updateState(db, SyncStatePatch(cursor: newCursor, lastPullAt: .some(syncNowMs())))
        return res
      }
      cursor = newCursor
      total.applied += res.applied
      total.skipped += res.skipped
      total.cards = total.cards || res.cards
      total.projects = total.projects || res.projects
      total.policyChanged = total.policyChanged || res.policyChanged
      for d in res.docs where !total.docs.contains(d) { total.docs.append(d) }
      if r.more != true || changes.isEmpty { break }
    }
    if total.cards { events.onCardsChanged?() }
    if total.projects { events.onProjectsChanged?() }
    if !total.docs.isEmpty { events.onDocsChanged?(total.docs) }
    if total.policyChanged { events.onPolicyChanged?(local.policy) }
  }

  /// After the first pull: upload local standups/day goals/categories the server has no newer copy of.
  private func backfillDocs() {
    let sinceDate = Date(timeIntervalSince1970: Date().timeIntervalSince1970 - Double(config.backfillDays) * 86400)
    // Windows uses `toISOString().slice(0, 10)` (the UTC date).
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let p = utc.dateComponents([.year, .month, .day], from: sinceDate)
    let since = String(format: "%04d-%02d-%02d", p.year ?? 0, p.month ?? 0, p.day ?? 0)
    _ = try? writeSync { db in
      if let days = try? String.fetchAll(
        db, sql: "SELECT standup_day FROM daily_standup_entries WHERE standup_day >= ?", arguments: [since])
      {
        for d in days where try repo.metaHlc(db, "standup:\(d)").isEmpty { try repo.recordDoc(db, .standup, d) }
      }
      if let days = try? String.fetchAll(db, sql: "SELECT day FROM day_goals WHERE day >= ?", arguments: [since]) {
        for d in days where try repo.metaHlc(db, "day_goal:\(d)").isEmpty { try repo.recordDoc(db, .dayGoal, d) }
      }
      if try repo.metaHlc(db, "user_doc:categories").isEmpty, try docs.read(db, .userDoc, "categories") != nil {
        try repo.recordDoc(db, .userDoc, "categories")
      }
    }
  }

  private func streamLoop() async {
    var delay: TimeInterval = 2
    while streaming && signedIn() && !Task.isCancelled {
      guard let c = try? client() else { break }
      lastChunkAt = Date()
      // The stream task is cancelled by stop(), so holding the actor strongly here is fine.
      let engine = self
      let inner = Task { () -> Error? in
        do {
          try await c.stream(
            onEvent: { event, _ in
              if event == "changed" { Task { await engine.streamChanged() } }
            },
            onOpen: { Task { await engine.streamOpened() } },
            onChunk: { Task { await engine.streamChunk() } })
          return nil
        } catch {
          return error
        }
      }
      // The server sends a heartbeat every 25 s; silence for 70 s means a dead connection.
      let watchdog = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 5_000_000_000)
          guard let self, !Task.isCancelled else { return }
          if await self.idleFor() > 70 {
            inner.cancel()
            return
          }
        }
      }
      let err = await withTaskCancellationHandler {
        await inner.value
      } onCancel: {
        inner.cancel()
      }
      watchdog.cancel()
      if let h = err as? HttpError, h.status == 401 {
        streamConnected = false
        authLost()
        return
      }
      if streamConnected {
        streamConnected = false
        emitStatus()
      }
      if !streaming || Task.isCancelled { break }
      // A stream that came up resets the backoff (as `delay = 2000` in onOpen on Windows).
      if streamConnectedOnce {
        delay = 2
        streamConnectedOnce = false
      }
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      delay = min(60, delay * 2)
    }
  }

  private var streamConnectedOnce = false

  private func idleFor() -> TimeInterval { Date().timeIntervalSince(lastChunkAt) }

  private func streamChunk() { lastChunkAt = Date() }

  private func streamChanged() { schedulePull() }

  private func streamOpened() async {
    streamConnected = true
    streamConnectedOnce = true
    lastChunkAt = Date()
    emitStatus()
    await run()
  }

  // MARK: account

  func me() async throws -> MeView {
    let gen = session
    let r = try await client().me()
    try live(gen)
    updateState(SyncStatePatch(user: .some(r.user), workspaces: r.workspaces ?? []))
    emitStatus()
    let me = local.deviceId
    return MeView(
      user: r.user,
      devices: (r.devices ?? []).map { d in
        var x = d
        x.current = d.current ?? (d.id == me)
        return x
      }, workspaces: r.workspaces ?? [])
  }

  func revokeDevice(_ id: String) async throws -> MeView {
    if id == local.deviceId {
      _ = await signOut()
      throw SyncError("This device was signed out.")
    }
    try await client().revokeDevice(id)
    return try await me()
  }

  func webLink() async throws -> URL {
    let r = try await client().webLink()
    guard let s = r.url, s.hasPrefix("http://") || s.hasPrefix("https://"), let u = URL(string: s) else {
      throw SyncError("The server did not return a dashboard link.")
    }
    return u
  }

  // MARK: projects

  func isAdmin(_ workspaceId: String) -> Bool {
    let w = state().workspaces.first { $0.id == workspaceId }
    return w?.role == .owner || w?.role == .admin
  }

  func listProjects() -> [ProjectView] {
    let uid = state().userId
    return (try? readSync { try repo.projectViews($0, userId: uid) }) ?? []
  }

  func saveProject(_ raw: ProjectDraft) throws -> ProjectView {
    guard signedIn() else { throw SyncError("Sign in to a sync server first.") }
    let d = try sanitizeProjectDraft(raw)
    guard isAdmin(d.workspaceId) else { throw SyncError("Only workspace owners and admins can edit projects.") }
    let row: ProjectRow = try writeSync { db in
      if let id = d.id, let cur = try repo.project(db, id), cur.workspaceId != d.workspaceId {
        throw SyncError("A project cannot move to another workspace.")
      }
      return try repo.saveProject(db, d)
    }
    events.onProjectsChanged?()
    guard let v = listProjects().first(where: { $0.id == row.id }) else { throw SyncError("Unknown project") }
    return v
  }

  func setMyShare(projectId: String, level: ShareLevel?) throws {
    guard let uid = state().userId else { throw SyncError("Sign in to a sync server first.") }
    try writeSync { db in
      guard try repo.project(db, projectId) != nil else { throw SyncError("Unknown project") }
      try repo.setMyShare(db, projectId: projectId, userId: uid, level: level)
    }
    events.onProjectsChanged?()
  }

  private func cardUuid(_ db: Database, recordId: Int64) throws -> String {
    guard let r = try Row.fetchOne(db, sql: "SELECT uuid, category, metadata FROM timeline_cards WHERE id = ?", arguments: [recordId]),
      let uuid = r["uuid"] as String?
    else { throw SyncError("Card not found") }
    let cat: String = r["category"] ?? ""
    if cat == ERROR_CATEGORY || parseJSONObject(r["metadata"])["isError"]?.boolValue == true {
      throw SyncError("Error cards cannot be assigned to projects.")
    }
    return uuid
  }

  /// Manual project choice for a card (timeline_cards.id); nil removes the assignment.
  func assignCard(recordId: Int64, projectId: String?) throws {
    try writeSync { db in
      let uuid = try cardUuid(db, recordId: recordId)
      if let projectId, try repo.project(db, projectId) == nil { throw SyncError("Unknown project") }
      try repo.setManualProject(db, cardUuid: uuid, projectId: projectId)
      if let metadata: String = try String.fetchOne(db,
        sql: "SELECT metadata FROM timeline_cards WHERE id = ?", arguments: [recordId]) {
        var object = parseJSONObject(metadata)
        if object["detailProjects"] != nil {
          object["detailProjects"] = .object([:])
          try db.execute(sql: "UPDATE timeline_cards SET metadata = ? WHERE id = ?",
                         arguments: [object.jsonString, recordId])
          local.cardEdited(db, id: recordId, fields: [.detailProjects])
        }
      }
    }
    events.onCardsChanged?()
  }

  func editDetailProject(recordId: Int64, key: String, projectId: String,
                         action: DetailProjectAction) throws {
    try writeSync { db in
      let uuid = try cardUuid(db, recordId: recordId)
      guard let project = try repo.project(db, projectId),
            action != .add || !project.archived else { throw SyncError("Project is not available") }
      guard let row = try Row.fetchOne(db,
        sql: "SELECT detailed_summary, metadata FROM timeline_cards WHERE id = ?", arguments: [recordId])
      else { throw SyncError("Card not found") }
      var metadata = parseJSONObject(row["metadata"])
      let records = syncDetailRecords(summary: row["detailed_summary"] ?? "",
                                      distractions: metadata["distractions"]?.arrayValue ?? [])
      let defaults = try repo.cardProjects(db, cardUuid: uuid).filter { !$0.deleted }.map {
        DetailProjectRef(projectId: $0.projectId, share: $0.share, source: $0.source,
                         confidence: $0.confidence, confirmed: $0.confirmed)
      }
      let stored = metadata["detailProjects"]?.objectValue ?? [:]
      var allocations: [String: [DetailProjectRef]] = [:]
      for record in records {
        allocations[record.key] = stored[record.key].map { ($0.arrayValue ?? []).compactMap(DetailProjectRef.init) } ?? defaults
      }
      guard var refs = allocations[key] else { throw SyncError("Unknown detail line") }
      switch action {
      case .add:
        if !refs.contains(where: { $0.projectId == projectId }) {
          refs.append(DetailProjectRef(projectId: projectId))
          for i in refs.indices { refs[i].share = 1 / Double(refs.count) }
        }
      case .remove:
        refs.removeAll { $0.projectId == projectId }
        let total = refs.reduce(0.0) { $0 + max(0, $1.share) }
        if total > 0 { for i in refs.indices { refs[i].share /= total } }
      case .confirm:
        if let i = refs.firstIndex(where: { $0.projectId == projectId }) {
          refs[i].confirmed = true
          refs[i].source = .manual
          refs[i].confidence = 1
        }
      }
      allocations[key] = refs
      metadata["detailProjects"] = .object(allocations.mapValues { .array($0.map(\.json)) })
      try db.execute(sql: "UPDATE timeline_cards SET metadata = ? WHERE id = ?",
                     arguments: [metadata.jsonString, recordId])
      local.cardEdited(db, id: recordId, fields: [.detailProjects])

      let weight = records.reduce(0.0) { $0 + $1.minutes }
      var sums: [String: (confirmed: Double, suggested: Double, ref: DetailProjectRef)] = [:]
      if weight > 0 {
        for record in records {
          let entries = allocations[record.key] ?? []
          let total = entries.reduce(0.0) { $0 + max(0, $1.share) }
          let scale = total > 1 ? 1 / total : 1
          for ref in entries {
            let part = record.minutes / weight * max(0, ref.share) * scale
            let previous = sums[ref.projectId]
            sums[ref.projectId] = (
              (previous?.confirmed ?? 0) + (ref.confirmed ? part : 0),
              (previous?.suggested ?? 0) + (ref.confirmed ? 0 : part), ref)
          }
        }
      }
      let next = sums.compactMap { id, sum -> AssignmentInput? in
        let share = round3(sum.confirmed > 0 ? sum.confirmed : sum.suggested)
        guard share > 0 else { return nil }
        return AssignmentInput(projectId: id, share: share,
                               source: sum.confirmed > 0 ? .manual : sum.ref.source,
                               confidence: sum.ref.confidence, confirmed: sum.confirmed > 0)
      }
      try repo.setAssignments(db, cardUuid: uuid, next)
    }
    events.onCardsChanged?()
  }

  func confirmCard(recordId: Int64, projectId: String) throws {
    try writeSync { db in
      guard let uuid = try String.fetchOne(db, sql: "SELECT uuid FROM timeline_cards WHERE id = ?", arguments: [recordId])
      else { throw SyncError("Card not found") }
      try repo.confirmProject(db, cardUuid: uuid, projectId: projectId)
      if let metadata: String = try String.fetchOne(db,
        sql: "SELECT metadata FROM timeline_cards WHERE id = ?", arguments: [recordId]) {
        var object = parseJSONObject(metadata)
        if let stored = object["detailProjects"]?.objectValue, !stored.isEmpty {
          object["detailProjects"] = .object(stored.mapValues { value in
            .array((value.arrayValue ?? []).map { item in
              guard var ref = DetailProjectRef(item), ref.projectId == projectId else { return item }
              ref.confirmed = true
              ref.source = .manual
              ref.confidence = 1
              return ref.json
            })
          })
          try db.execute(sql: "UPDATE timeline_cards SET metadata = ? WHERE id = ?",
                         arguments: [object.jsonString, recordId])
          local.cardEdited(db, id: recordId, fields: [.detailProjects])
        }
      }
    }
    events.onCardsChanged?()
  }

  func setCardPrivate(recordId: Int64, isPrivate: Bool) throws {
    try writeSync { try local.editCard($0, id: recordId, isPrivate: isPrivate) }
    events.onCardsChanged?()
  }

  func cardSyncInfo(recordIds: [Int64]) -> [Int64: CardSyncInfo] {
    (try? readSync { try repo.cardSyncInfo($0, recordIds: recordIds) }) ?? [:]
  }

  /// Rules (and LLM guesses, when given) for cards analysis just inserted.
  func assignInserted(_ refs: [InsertedCardRef], llmGuesses: [String: [LlmProjectGuess]] = [:]) {
    let labels = self.labels
    let local = self.local
    _ = try? writeSync { try assignProjects($0, local: local, labels: labels, cards: refs, llmGuesses: llmGuesses) }
    events.onCardsChanged?()
  }

  // MARK: team

  func feed(projectId: String, from: String, to: String) async throws -> [ProjectEntry] {
    try checkRange(from, to)
    return try await client().projectFeed(projectId, from: from, to: to)
  }

  func report(projectId: String, from: String, to: String) async throws -> ProjectReport {
    try checkRange(from, to)
    return try await client().projectReport(projectId, from: from, to: to)
  }

  func timesheetProposals(from: String, to: String, workspaceId: String) async throws -> TimesheetProposalsView {
    try checkRange(from, to)
    return try await client().timesheetProposals(from: from, to: to, workspaceId: workspaceId)
  }

  func timesheetSubmit(_ req: TimesheetSubmitRequest) async throws -> TimesheetSubmitResult {
    try await client().timesheetSubmit(sanitizeSubmit(req))
  }
}

/// The rejection reason of each change of a pushed batch (index-aligned), keyed by entity + id.
/// The server reports rejections by id (an `entity` is used when present); a batch never holds
/// two changes with the same id (`SyncOutboxBuilder.buildBatch`), so the id is unambiguous.
func rejectionReasons(_ changes: [SyncChange], _ rejected: [PushRejection]) -> [Int: String] {
  var byKey: [String: String] = [:]
  var byId: [String: String] = [:]
  for r in rejected {
    if let e = r.entity, !e.isEmpty { byKey["\(e)\u{1F}\(r.id)"] = r.reason } else { byId[r.id] = r.reason }
  }
  var out: [Int: String] = [:]
  for (i, ch) in changes.enumerated() {
    if let reason = byKey["\(ch.entity.rawValue)\u{1F}\(ch.id)"] ?? byId[ch.id] { out[i] = reason }
  }
  return out
}

// MARK: - Validation (service.ts)

func checkRange(_ from: String, _ to: String) throws {
  guard syncIsDayString(from), syncIsDayString(to), from <= to else { throw SyncError("Invalid date range") }
}

private func cleanList(_ v: [String]?) -> [String]? {
  guard let v else { return nil }
  var seen = Set<String>()
  var out: [String] = []
  for x in v {
    let s = safeText(x, 200)
    if !s.isEmpty, !seen.contains(s) {
      seen.insert(s)
      out.append(s)
    }
  }
  let r = Array(out.prefix(100))
  return r.isEmpty ? nil : r
}

private func isUuidLike(_ s: String) -> Bool {
  s.count == 36 && s.allSatisfy { $0 == "-" || $0.isHexDigit }
}

private func isHex6(_ s: String) -> Bool {
  s.count == 7 && s.first == "#" && s.dropFirst().allSatisfy { $0.isHexDigit }
}

func sanitizeProjectDraft(_ raw: ProjectDraft) throws -> ProjectDraft {
  let name = safeText(raw.name, 120)
  guard !name.isEmpty else { throw SyncError("A project needs a name.") }
  let workspaceId = safeText(raw.workspaceId, 100)
  guard !workspaceId.isEmpty else { throw SyncError("Pick a workspace.") }
  func positive(_ v: Int?) -> Int? { v.flatMap { $0 > 0 ? $0 : nil } }
  return ProjectDraft(
    id: raw.id.flatMap { isUuidLike($0) ? $0 : nil }, workspaceId: workspaceId, name: name,
    color: isHex6(raw.color) ? raw.color : "#7BC47F", icon: safeText(raw.icon, 16), description: safeText(raw.description, 2000),
    rules: ProjectRules(
      apps: cleanList(raw.rules.apps), domains: cleanList(raw.rules.domains),
      titleKeywords: cleanList(raw.rules.titleKeywords), repos: cleanList(raw.rules.repos)),
    defaultShare: raw.defaultShare,
    odoo: OdooMapping(
      projectId: positive(raw.odoo.projectId), taskId: positive(raw.odoo.taskId),
      projectName: safeText(raw.odoo.projectName, 200).isEmpty ? nil : safeText(raw.odoo.projectName, 200),
      taskName: safeText(raw.odoo.taskName, 200).isEmpty ? nil : safeText(raw.odoo.taskName, 200)),
    archived: raw.archived == true)
}

func sanitizeSubmit(_ req: TimesheetSubmitRequest) throws -> TimesheetSubmitRequest {
  guard !req.lines.isEmpty else { throw SyncError("Nothing to submit") }
  guard req.lines.count <= 500 else { throw SyncError("Too many lines") }
  return TimesheetSubmitRequest(
    lines: try req.lines.map { l in
      guard syncIsDayString(l.day) else { throw SyncError("Invalid day") }
      guard l.hours.isFinite, l.hours > 0, l.hours <= 24 else { throw SyncError("Invalid hours for \(l.day)") }
      return TimesheetLine(
        day: l.day, projectId: safeText(l.projectId, 100), hours: (l.hours * 100).rounded() / 100,
        description: safeText(l.description, 2000), cardIds: Array(l.cardIds.prefix(1000)))
    })
}
