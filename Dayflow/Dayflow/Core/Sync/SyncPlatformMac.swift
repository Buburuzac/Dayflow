//
//  SyncPlatformMac.swift
//  Dayflow — Dayflow Sync, macOS glue
//
//  Connects the platform-neutral sync core to the app: StorageManager's database, the Keychain,
//  NSWorkspace, CategoryStore, the accessibility log (window titles for project rules) and the
//  app lifecycle (`SyncCenter.startForApp()` from AppDelegate).
//

#if os(macOS)
  import AppKit
  import Combine
  import Foundation
  import GRDB
  import Security
  import SystemConfiguration

  // MARK: - Platform

  final class MacSyncPlatform: SyncPlatform, @unchecked Sendable {
    let deviceName: String
    let platformName = "macos"
    let tokenStore: SyncTokenStore = KeychainSyncTokenStore()
    let defaults = UserDefaults.standard
    let transport: SyncHTTPTransport = URLSessionSyncTransport()
    let windowLabels: WindowLabelSource? = AccessibilityWindowLabels()
    let local = SyncLocal.shared
    let background = true

    var categories: CategoryDocBridge? { MacCategoryBridge.shared }

    init() {
      let computer = SCDynamicStoreCopyComputerName(nil, nil) as String?
      deviceName = (computer?.isEmpty == false ? computer : nil) ?? ProcessInfo.processInfo.hostName
    }

    func database() -> DatabaseWriter {
      StorageManager.shared.db
    }

    func openURL(_ url: URL) async throws {
      let opened = await MainActor.run { NSWorkspace.shared.open(url) }
      if !opened { throw SyncError("Could not open the browser.") }
    }

    func makeLoopbackListener() -> LoopbackHTTPListener {
      NWLoopbackListener()
    }
  }

  extension SyncCenter {
    /// Called once from AppDelegate.applicationDidFinishLaunching.
    static func startForApp() {
      // StorageManager.init runs the migration (SyncLocal.shared.migrate) before anything else.
      _ = StorageManager.shared
      MacCategoryBridge.shared.install()
      SyncCenter.shared.start(platform: MacSyncPlatform())
    }
  }

  // MARK: - Lookups for the timeline

  enum MacSyncLookup {
    /// The cards among `recordIds` (timeline_cards.id) that came from another of the user's
    /// devices. Synchronous read on StorageManager's pool; call it off the main thread.
    static func remoteCardIds(_ recordIds: [Int64]) -> Set<Int64> {
      let local = SyncLocal.shared
      guard local.migrated, !recordIds.isEmpty else { return [] }
      let me = local.deviceId
      var out = Set<Int64>()
      for start in stride(from: 0, to: recordIds.count, by: 500) {
        let chunk = Array(recordIds[start..<min(start + 500, recordIds.count)])
        let ph = chunk.map { _ in "?" }.joined(separator: ",")
        let ids =
          (try? StorageManager.shared.db.read { db in
            try Int64.fetchAll(
              db,
              sql: "SELECT id FROM timeline_cards WHERE id IN (\(ph)) AND device_id IS NOT NULL AND device_id != ?",
              arguments: StatementArguments(chunk) + [me])
          }) ?? []
        out.formUnion(ids)
      }
      return out
    }
  }

  // MARK: - Keychain token store

  /// The device token in the login Keychain (same item as KeychainManager's
  /// "com.teleportlabs.dayflow.apikeys.dayflowSyncDeviceToken"). Only a successful read or a
  /// confirmed "no such item" is cached: a locked or unavailable Keychain is asked again next time,
  /// so one failed read at launch does not look like a sign-out for the rest of the session.
  final class KeychainSyncTokenStore: SyncTokenStore, @unchecked Sendable {
    private let account = "dayflowSyncDeviceToken"
    private let lock = NSLock()
    private var cached: String?

    private var service: String { "com.teleportlabs.dayflow.apikeys.\(account)" }

    func get() -> String {
      lock.lock()
      defer { lock.unlock() }
      if let cached { return cached }
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      var result: AnyObject?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      switch status {
      case errSecSuccess:
        guard let data = result as? Data, let v = String(data: data, encoding: .utf8) else { return "" }
        cached = v
        return v
      case errSecItemNotFound:
        cached = ""
        return ""
      default:
        print("⚠️ [Sync] Keychain read failed (\(status)); will retry")
        return ""
      }
    }

    func set(_ token: String) throws {
      lock.lock()
      defer { lock.unlock() }
      if token.isEmpty {
        // Signed out either way; a stale item would only be read back after a failed delete.
        cached = ""
        if !KeychainManager.shared.delete(for: account) {
          throw SyncError("Could not remove the sync token from the Keychain.")
        }
      } else {
        guard KeychainManager.shared.store(token, for: account) else {
          cached = nil
          throw SyncError("Could not save the sync token in the Keychain.")
        }
        cached = token
      }
    }
  }

  // MARK: - Categories (CategoryStore ⇄ user_doc 'categories')

  /// Maps CategoryStore (UserDefaults "colorCategories") to the shared `[{ name, color, description, isIdle? }]`.
  /// colorHex ⇄ color, details ⇄ description, isIdle ⇄ isIdle. Local edits are reported to sync
  /// through a Combine subscription; pulled lists are applied through CategoryStore's own API.
  final class MacCategoryBridge: CategoryDocBridge, @unchecked Sendable {
    static let shared = MacCategoryBridge()

    private var cancellable: AnyCancellable?
    /// Main-thread only: true while a pulled list is being applied (not a local edit).
    private var muted = false
    private let pendingLock = NSLock()
    /// A pulled list handed to `applyRemoteCategories` that the main actor has not applied yet.
    /// `currentCategories()` returns it meanwhile, so an upload in the same sync cycle (the merged
    /// list of a first pull) never sends the stale local list.
    private var pending: [SyncCategory]?

    func currentCategories() -> [SyncCategory]? {
      pendingLock.lock()
      let p = pending
      pendingLock.unlock()
      if let p { return p }
      let stored = CategoryPersistence.loadPersistedCategories()
      let effective = stored.isEmpty ? CategoryPersistence.defaultCategories : stored
      guard !effective.isEmpty else { return nil }
      return effective.sorted { $0.order < $1.order }.map {
        SyncCategory(name: $0.name, color: $0.colorHex, description: $0.details, isIdle: $0.isIdle)
      }
    }

    @MainActor
    func install() {
      guard cancellable == nil else { return }
      cancellable = CategoryStore.shared.$categories
        .dropFirst()
        .removeDuplicates()
        // Checked when the change happens (before the debounce), so applied remote lists never echo.
        .filter { [weak self] _ in self?.muted == false }
        .debounce(for: .milliseconds(500), scheduler: RunLoop.main)
        .sink { _ in
          Task.detached(priority: .utility) {
            let writer: DatabaseWriter = StorageManager.shared.db
            try? await writer.write { db in
              SyncLocal.shared.docWritten(db, .userDoc, "categories")
            }
          }
        }
    }

    func applyRemoteCategories(_ categories: [SyncCategory]) {
      pendingLock.lock()
      pending = categories
      pendingLock.unlock()
      Task { @MainActor in
        self.apply(categories)
        self.pendingLock.lock()
        if self.pending == categories { self.pending = nil }
        self.pendingLock.unlock()
      }
    }

    /// Applies a pulled list in place: existing categories keep their CategoryStore id (and their
    /// details when the pulled description is empty); a category renamed on the other device is
    /// renamed here (matched by position), not removed and re-added.
    @MainActor
    private func apply(_ remote: [SyncCategory]) {
      muted = true
      defer { muted = false }
      let store = CategoryStore.shared
      func key(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
      var used = Set<UUID>()
      // Pass 1: same name (or the idle category).
      var matched: [Int: UUID] = [:]
      for (index, rc) in remote.enumerated() {
        let match = store.categories.first { c in
          guard !used.contains(c.id) else { return false }
          if rc.isIdle { return c.isIdle }
          return !c.isIdle && key(c.name) == key(rc.name)
        }
        if let match {
          used.insert(match.id)
          matched[index] = match.id
        }
      }
      // Pass 2: a pulled name with no local match takes the unmatched local category at the same
      // index (a rename on the other device; same indexing as `currentCategories()` and
      // `planCategoryApply`).
      let ordered = store.categories.sorted { $0.order < $1.order }
      for (index, rc) in remote.enumerated() where matched[index] == nil && !rc.isIdle && index < ordered.count {
        let c = ordered[index]
        guard !used.contains(c.id), !c.isIdle, !c.isSystem else { continue }
        used.insert(c.id)
        matched[index] = c.id
      }
      for (index, rc) in remote.enumerated() {
        if let id = matched[index], let match = store.categories.first(where: { $0.id == id }) {
          let details = rc.description.isEmpty ? match.details : rc.description
          let same =
            match.name == rc.name && match.colorHex == rc.color && match.details == details && match.order == index
          if !same {
            store.updateCategory(id: match.id) { c in
              c.name = rc.name
              c.colorHex = rc.color
              c.details = details
              c.order = index
            }
          }
        } else if !rc.isIdle {
          store.addCategory(name: rc.name, colorHex: rc.color)
          if let added = store.categories.last(where: { $0.name == rc.name && !used.contains($0.id) }) {
            used.insert(added.id)
            store.updateCategory(id: added.id) { c in
              c.details = rc.description
              c.order = index
            }
          }
        }
      }
      // Categories the other device removed. Idle and system categories always stay.
      for c in store.categories where !used.contains(c.id) && !c.isSystem && !c.isIdle {
        store.removeCategory(id: c.id)
      }
    }
  }

  // MARK: - Window labels from the accessibility log

  /// One label per screenshot of a card: the frontmost "app — window title" at the frame's time,
  /// from the accessibility log's `window` events. Frames of blocked apps get no label. Used for
  /// `metadata.windowApps` (app names only leave the Mac) and for project rules.
  final class AccessibilityWindowLabels: WindowLabelSource, @unchecked Sendable {
    private struct WindowEvent {
      let time: Int64
      let label: String?
    }

    private let lock = NSLock()
    private var cache: [String: (modified: Date, events: [WindowEvent])] = [:]
    private var cacheOrder: [String] = []

    func windowLabels(_ db: Database, startTs: Int64, endTs: Int64) -> [String] {
      guard endTs > startTs,
        let frames = try? Int64.fetchAll(
          db, sql: "SELECT captured_at FROM screenshots WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at",
          arguments: [startTs, endTs]),
        !frames.isEmpty
      else { return [] }
      let events = windowEvents(from: startTs - 600, to: endTs)
      guard !events.isEmpty else { return [] }
      var out: [String] = []
      var i = 0
      var current: String?
      var seenAny = false
      for f in frames {
        while i < events.count && events[i].time <= f {
          current = events[i].label
          seenAny = true
          i += 1
        }
        if seenAny, let current { out.append(current) }
      }
      return out
    }

    private func windowEvents(from: Int64, to: Int64) -> [WindowEvent] {
      let files = AccessibilityLogStore.shared.logFiles(
        from: Date(timeIntervalSince1970: TimeInterval(from)), to: Date(timeIntervalSince1970: TimeInterval(to)))
      var all: [WindowEvent] = []
      for f in files { all.append(contentsOf: events(in: f)) }
      return all.filter { $0.time >= from && $0.time < to }.sorted { $0.time < $1.time }
    }

    private func events(in file: URL) -> [WindowEvent] {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
      lock.lock()
      if let hit = cache[file.path], hit.modified == modified {
        lock.unlock()
        return hit.events
      }
      lock.unlock()
      guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
      let decoder = AccessibilityLogEvent.decoder()
      var out: [WindowEvent] = []
      for line in text.split(separator: "\n") where line.contains("\"kind\":\"window\"") {
        guard let data = line.data(using: .utf8),
          let e = try? decoder.decode(AccessibilityLogEvent.self, from: data), e.kind == "window"
        else { continue }
        let t = Int64(e.time.timeIntervalSince1970)
        if e.blocked == true {
          out.append(WindowEvent(time: t, label: nil))
        } else if let app = e.app, !app.isEmpty {
          let title = e.window?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
          out.append(WindowEvent(time: t, label: title.isEmpty ? app : "\(app) — \(title)"))
        }
      }
      lock.lock()
      cache[file.path] = (modified, out)
      cacheOrder.removeAll { $0 == file.path }
      cacheOrder.append(file.path)
      while cacheOrder.count > 48 { cache.removeValue(forKey: cacheOrder.removeFirst()) }
      lock.unlock()
      return out
    }
  }
#endif
