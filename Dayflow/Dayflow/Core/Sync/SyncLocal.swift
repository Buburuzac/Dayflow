//
//  SyncLocal.swift
//  Dayflow — Dayflow Sync client core
//
//  The local half of sync that lives next to the app's own tables (port of the sync parts of
//  windows/src/main/db.ts): the schema migration, this device's id and hybrid clock, the outbox
//  enqueue, and the hooks StorageManager calls at every card / observation / standup / day-goal
//  write. Hooks take the GRDB `Database` of the caller's write transaction, so the bookkeeping
//  commits (or rolls back) together with the app's own change.
//
//  Hooks never throw: a sync bookkeeping failure must not break the app's write.
//

import Foundation
import GRDB

/// User-editable card fields that merge per field across devices (sync-server-design.md).
enum CardUserField: String, CaseIterable, Sendable {
  case title, category, subcategory, deleted
  case isPrivate = "private"
  case detailProjects
}

let CARD_USER_FIELDS: [String] = CardUserField.allCases.map { $0.rawValue }

/// Category of error cards ("Processing failed"); they never leave the device.
let ERROR_CATEGORY = "System"

/// Records stored outside the sync tables whose writes are reported through `SyncLocal.docWritten`.
enum DocEntity: String, Sendable {
  case standup
  case dayGoal = "day_goal"
  case userDoc = "user_doc"

  var syncEntity: SyncEntity {
    switch self {
    case .standup: return .standup
    case .dayGoal: return .dayGoal
    case .userDoc: return .userDoc
    }
  }
}

/// A local card that analysis is about to replace (soft-delete); see `localCardsWillBeReplaced`.
struct ReplacedCard: Sendable {
  let id: Int64
  let uuid: String?
  let startTs: Int64
  let endTs: Int64
  let category: String
  let metadata: String?
}

/// A card the analysis just inserted (for project assignment).
struct InsertedCardRef: Sendable, Equatable {
  let uuid: String
  /// A manual project assignment was carried over from the card this one replaced.
  let inheritedManual: Bool
}

/// What an in-place analysis update of a card had before (see `cardAnalysisWillChange`).
struct CardAnalysisSnapshot: Sendable {
  let id: Int64
  let wasPrivate: Bool
}

final class SyncLocal: @unchecked Sendable {
  /// The instance StorageManager's hooks use. Tests create their own.
  static let shared = SyncLocal()

  private let lock = NSLock()
  private var _deviceId = ""
  private var _migrated = false
  private var clock: Hlc
  private var lastHlc = ""
  private var _syncEnabled = false
  private var _policy = SyncPolicy.default
  private var _onOutbox: (@Sendable () -> Void)?
  private var _onCardsInserted: (@Sendable ([InsertedCardRef]) -> Void)?
  /// Set when card scopes may have changed beyond the recent window (see `markScopeDirty`).
  private var _scopeDirty = true
  private let now: () -> Int64

  init(now: @escaping () -> Int64 = syncNowMs) {
    self.now = now
    self.clock = Hlc("pending", now: now)
  }

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  /// This installation's sync device id (server-assigned after sign-in, a local uuid before).
  var deviceId: String { locked { _deviceId } }

  /// True once `migrate` ran and the sync columns exist.
  var migrated: Bool { locked { _migrated } }

  /// When false (not signed in to a sync server) nothing is queued in the outbox.
  var syncEnabled: Bool { locked { _syncEnabled } }

  /// What may leave this Mac; applied when changes are built for upload.
  var policy: SyncPolicy {
    get { locked { _policy } }
    set {
      locked {
        if !samePolicy(_policy, newValue) { _scopeDirty = true }
        _policy = newValue
      }
    }
  }

  /// Something that can change the scope of old cards happened (policy change, pulled or local
  /// project / assignment / private / category edits): the next rescope scans every card that was
  /// ever sent, not only the recent window.
  func markScopeDirty() { locked { _scopeDirty = true } }

  /// Returns the dirty flag and clears it (call before the scan; re-mark if the scan fails).
  func takeScopeDirty() -> Bool {
    locked {
      let d = _scopeDirty
      _scopeDirty = false
      return d
    }
  }

  /// Called after something was queued in the outbox (the engine debounces a push).
  /// Must not touch the database synchronously (it runs inside the caller's write).
  var onOutbox: (@Sendable () -> Void)? {
    get { locked { _onOutbox } }
    set { locked { _onOutbox = newValue } }
  }

  /// Called with the cards analysis just inserted (project rules / LLM assignment).
  /// Same constraint as `onOutbox`: dispatch, never write synchronously.
  var onCardsInserted: (@Sendable ([InsertedCardRef]) -> Void)? {
    get { locked { _onCardsInserted } }
    set { locked { _onCardsInserted = newValue } }
  }

  /// SQL predicate for rows that belong to this device (legacy rows have no device_id).
  /// Always binds exactly one argument: `localArgument`.
  var localOnlySQL: String {
    migrated ? "(device_id IS NULL OR device_id = ?)" : "(1 = 1 OR ? IS NULL)"
  }

  var localArgument: String { deviceId }

  // MARK: - Clock

  /// Next HLC for a local write.
  func tick() -> String {
    locked {
      lastHlc = clock.tick()
      return lastHlc
    }
  }

  /// Advances the local clock past a remote HLC (pulled changes, server time).
  func observeHlc(_ remote: String) {
    locked { clock.observe(remote) }
  }

  /// Rewrites a local row's HLC to the current device id (rows stamped before sign-in).
  func localHlc(_ hlc: String) -> String {
    guard let p = parseHlc(hlc) else { return hlc }
    let dev = deviceId
    if p.deviceId == dev { return hlc }
    return formatHlc(p.ms, p.counter, dev)
  }

  // MARK: - Migration

  /// Adds the sync columns and tables (same names as Windows), gives legacy rows stable ids,
  /// and loads this device's id. Idempotent. Run once per launch, after the app's own migration.
  func migrate(_ db: Database) throws {
    func columns(_ t: String) throws -> [ColumnInfo] { try db.columns(in: t) }
    func addMissing(_ t: String, _ cols: [(String, String)]) throws {
      let have = Set(try columns(t).map { $0.name })
      for (c, def) in cols where !have.contains(c) {
        try db.execute(sql: "ALTER TABLE \(t) ADD COLUMN \(c) \(def)")
      }
    }

    try addMissing("timeline_cards", [
      ("uuid", "TEXT"),
      ("hlc", "TEXT"),
      ("field_hlc", "TEXT"),
      ("device_id", "TEXT"),
      // What the server last received for this card (SyncScope.swift) and the clock of that change.
      ("sync_scope", "TEXT"),
      ("scope_hlc", "TEXT"),
    ])
    try addMissing("observations", [
      ("uuid", "TEXT"),
      ("hlc", "TEXT"),
      ("device_id", "TEXT"),
      // 1 once the server has accepted this observation, 0 after its tombstone was accepted.
      ("uploaded", "INTEGER"),
    ])
    // Observations pulled from other devices have no local batch, so batch_id must be nullable.
    // The Mac schema creates it NOT NULL: rebuild the table once (nothing references it).
    if try columns("observations").first(where: { $0.name == "batch_id" })?.isNotNull == true {
      try db.execute(
        sql: """
          CREATE TABLE observations_sync_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
              start_ts INTEGER NOT NULL,
              end_ts INTEGER NOT NULL,
              observation TEXT NOT NULL,
              metadata TEXT,
              llm_model TEXT,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              uuid TEXT,
              hlc TEXT,
              device_id TEXT,
              uploaded INTEGER
          );
          INSERT INTO observations_sync_new (id, batch_id, start_ts, end_ts, observation, metadata, llm_model,
                                             created_at, uuid, hlc, device_id, uploaded)
            SELECT id, batch_id, start_ts, end_ts, observation, metadata, llm_model, created_at, uuid, hlc,
                   device_id, uploaded FROM observations;
          DROP TABLE observations;
          ALTER TABLE observations_sync_new RENAME TO observations;
          CREATE INDEX IF NOT EXISTS idx_observations_batch_id ON observations(batch_id);
          CREATE INDEX IF NOT EXISTS idx_observations_start_ts ON observations(start_ts);
          CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);
          """)
    }

    try db.execute(
      sql: """
        CREATE TABLE IF NOT EXISTS sync_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          device_id TEXT NOT NULL,
          device_name TEXT,
          server_url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          user_id TEXT,
          user_json TEXT,
          workspaces_json TEXT,
          cursor INTEGER NOT NULL DEFAULT 0,
          last_push_at INTEGER,
          last_pull_at INTEGER,
          last_sync_at INTEGER,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          entity TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          payload TEXT,
          queued_at INTEGER NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          UNIQUE (entity, entity_id)
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#7BC47F',
          icon TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          rules TEXT NOT NULL DEFAULT '{}',
          default_share TEXT NOT NULL DEFAULT 'time',
          odoo TEXT NOT NULL DEFAULT '{}',
          archived INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          hlc TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_members (
          project_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          share_level TEXT,
          deleted INTEGER NOT NULL DEFAULT 0,
          hlc TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS card_projects (
          card_uuid TEXT NOT NULL,
          project_id TEXT NOT NULL,
          share REAL NOT NULL DEFAULT 1,
          source TEXT NOT NULL CHECK (source IN ('manual', 'rule', 'llm')),
          confidence REAL NOT NULL DEFAULT 1,
          confirmed INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          hlc TEXT NOT NULL,
          PRIMARY KEY (card_uuid, project_id)
        );
        CREATE INDEX IF NOT EXISTS idx_card_projects_project ON card_projects(project_id) WHERE deleted = 0;

        -- HLCs of synced records that live in other tables (standups, day goals, user docs).
        CREATE TABLE IF NOT EXISTS sync_meta (
          key TEXT PRIMARY KEY,
          hlc TEXT NOT NULL
        );
        """)

    try addMissing("projects", [("icon", "TEXT NOT NULL DEFAULT ''")])

    var state = try Row.fetchOne(db, sql: "SELECT device_id, enabled FROM sync_state WHERE id = 1")
    if state == nil {
      try db.execute(
        sql: "INSERT INTO sync_state (id, device_id, server_url) VALUES (1, ?, ?)",
        arguments: [syncNewUUID(), DEFAULT_SYNC_SERVER_URL])
      state = try Row.fetchOne(db, sql: "SELECT device_id, enabled FROM sync_state WHERE id = 1")
    }
    let dev: String = state?["device_id"] ?? syncNewUUID()
    let enabled: Int = state?["enabled"] ?? 0
    // The rest of this transaction (and the hooks) need the id now; if the transaction rolls back
    // the in-memory state goes back to what it was, so it never names a row that does not exist.
    let before = locked { (_deviceId, _syncEnabled) }
    restoreOnRollback(db, deviceId: (before.0, dev), enabled: (before.1, enabled == 1), migrated: true)
    locked {
      _deviceId = dev
      _syncEnabled = enabled == 1
      clock = Hlc(dev, now: now)
    }

    // Stable ids for rows written before sync existed. Their HLC is their start time, so any
    // later edit (here or on another device) wins over them. Set-based: this runs inside
    // StorageManager.init, and a large legacy database must not take one statement per row.
    try db.execute(
      sql: """
        UPDATE timeline_cards SET uuid = \(SyncLocal.SQL_UUID_V4), hlc = \(SyncLocal.SQL_LEGACY_HLC),
               field_hlc = COALESCE(field_hlc, '{}'), device_id = COALESCE(device_id, ?) WHERE uuid IS NULL
        """,
      arguments: [dev, dev])
    try db.execute(
      sql: """
        UPDATE observations SET uuid = \(SyncLocal.SQL_UUID_V4), hlc = \(SyncLocal.SQL_LEGACY_HLC),
               device_id = COALESCE(device_id, ?) WHERE uuid IS NULL
        """,
      arguments: [dev, dev])
    // Private flags and confirmed projects of cards a day reprocess removed (see `localCardsWillBeReprocessed`).
    try db.execute(
      sql: """
        CREATE TABLE IF NOT EXISTS sync_carryover (
          uuid TEXT PRIMARY KEY,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          is_private INTEGER NOT NULL DEFAULT 0,
          projects TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_carryover_time ON sync_carryover(start_ts, end_ts);
        """)
    try db.execute(
      sql: """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_cards_uuid ON timeline_cards(uuid);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_uuid ON observations(uuid);
        """)
    if let maxCard = try String.fetchOne(db, sql: "SELECT MAX(hlc) FROM timeline_cards") {
      observeHlc(maxCard)
    }
    // Only now may hooks and `localOnlySQL` rely on the sync columns. (If this transaction rolls
    // back after all, the columns are gone again and the hooks' own errors are caught.)
    locked { _migrated = true }
  }

  /// A random lowercase v4 uuid, evaluated per row (legacy backfill).
  static let SQL_UUID_V4 = """
    (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
     || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-'
     || lower(hex(randomblob(6))))
    """

  /// `formatHlc(max(0, start_ts * 1000), 0, ?)` in SQL; binds one argument (the device id).
  static let SQL_LEGACY_HLC = "printf('%013d-0000-%s', MAX(0, COALESCE(start_ts, 0) * 1000), ?)"

  /// Undoes an in-memory change of the device id / enabled flag / migrated flag if the caller's
  /// transaction rolls back (they are changed before it commits). Each restore only applies while
  /// the value is still the one this call set, so several calls in one transaction compose.
  private func restoreOnRollback(
    _ db: Database, deviceId: (from: String, to: String)? = nil, enabled: (from: Bool, to: Bool)? = nil,
    migrated: Bool = false
  ) {
    let wasMigrated = locked { _migrated }
    db.afterNextTransaction(
      onCommit: { _ in },
      onRollback: { [weak self] _ in
        guard let self else { return }
        self.locked {
          if let d = deviceId, self._deviceId == d.to {
            self._deviceId = d.from
            let last = self.lastHlc
            self.clock = Hlc(d.from.isEmpty ? "pending" : d.from, now: self.now)
            if !last.isEmpty { self.clock.observe(last) }
          }
          if let e = enabled, self._syncEnabled == e.to { self._syncEnabled = e.from }
          if migrated { self._migrated = wasMigrated }
        }
      })
  }

  // MARK: - Device / enable

  /// Adopts the server-assigned device id: rows written under the provisional id are re-labelled
  /// so they stay "this device's" rows. HLC suffixes are rewritten when changes are built.
  func setDeviceId(_ db: Database, _ id: String) throws {
    let old = deviceId
    guard !id.isEmpty, id != old else { return }
    try db.execute(
      sql: "UPDATE timeline_cards SET device_id = ? WHERE device_id = ? OR device_id IS NULL",
      arguments: [id, old])
    try db.execute(
      sql: "UPDATE observations SET device_id = ? WHERE device_id = ? OR device_id IS NULL",
      arguments: [id, old])
    try db.execute(sql: "UPDATE sync_state SET device_id = ? WHERE id = 1", arguments: [id])
    // Applied now (the rest of the sign-in transaction relies on it), undone if it rolls back:
    // otherwise this Mac's own cards would look remote and a later sign-out would purge them.
    restoreOnRollback(db, deviceId: (old, id))
    locked {
      _deviceId = id
      let prev = lastHlc
      clock = Hlc(id, now: now)
      if !prev.isEmpty { clock.observe(prev) }
    }
  }

  func setSyncEnabled(_ db: Database, _ on: Bool) throws {
    try db.execute(sql: "UPDATE sync_state SET enabled = ? WHERE id = 1", arguments: [on ? 1 : 0])
    let was = syncEnabled
    restoreOnRollback(db, enabled: (was, on))
    locked { _syncEnabled = on }
  }

  // MARK: - Outbox

  /// Queues a change for upload; `payload` is kept for rows that no longer exist (tombstones).
  func enqueue(_ db: Database, _ entity: SyncEntity, _ entityId: String, payload: String? = nil) throws {
    guard syncEnabled, !entityId.isEmpty else { return }
    try db.execute(
      sql: """
        INSERT INTO outbox (entity, entity_id, payload, queued_at, rev) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(entity, entity_id) DO UPDATE SET payload = excluded.payload, queued_at = excluded.queued_at,
          rev = outbox.rev + 1, attempts = 0, last_error = NULL
        """,
      arguments: [entity.rawValue, entityId, payload, now()])
    onOutbox?()
  }

  /// Queues a card unless it is an error card (those never leave the device).
  func enqueueCard(_ db: Database, uuid: String?, category: String?, metadata: String?) throws {
    guard let uuid, !uuid.isEmpty else { return }
    if category == ERROR_CATEGORY || parseJSONObject(metadata)["isError"]?.boolValue == true { return }
    try enqueue(db, .card, uuid)
  }

  // MARK: - Hooks called by StorageManager

  private func hook(_ label: String, _ body: () throws -> Void) {
    guard migrated else { return }
    do {
      try body()
    } catch {
      print("⚠️ [Sync] \(label) failed: \(error)")
    }
  }

  /// Call right before analysis soft-deletes cards, with the WHERE clause of that UPDATE (which must
  /// include `is_deleted = 0`). Stamps each local card's delete clock, queues its tombstone and
  /// returns the cards, so the replacement cards can keep the user's choices (`cardInserted`).
  /// Only this device's cards are considered; the caller's UPDATE must also be restricted to them
  /// with `localOnlySQL`.
  @discardableResult
  func localCardsWillBeReplaced(_ db: Database, where clause: String, arguments: StatementArguments)
    -> [ReplacedCard]
  {
    var out: [ReplacedCard] = []
    hook("localCardsWillBeReplaced") {
      let rows = try Row.fetchAll(
        db,
        sql: """
          SELECT id, uuid, start_ts, end_ts, category, metadata, field_hlc FROM timeline_cards
          WHERE (\(clause)) AND \(localOnlySQL)
          """,
        arguments: arguments + [localArgument])
      for r in rows {
        let id: Int64 = r["id"]
        let h = tick()
        var fh = parseJSONObject(r["field_hlc"])
        fh["deleted"] = .string(h)
        try db.execute(
          sql: "UPDATE timeline_cards SET field_hlc = ? WHERE id = ?", arguments: [fh.jsonString, id])
        let uuid: String? = r["uuid"]
        let category: String = r["category"] ?? ""
        let metadata: String? = r["metadata"]
        try enqueueCard(db, uuid: uuid, category: category, metadata: metadata)
        out.append(
          ReplacedCard(
            id: id, uuid: uuid, startTs: r["start_ts"] ?? 0, endTs: r["end_ts"] ?? 0, category: category,
            metadata: metadata))
      }
    }
    return out
  }

  /// How long the private flags / confirmed projects of reprocessed cards wait for their replacements.
  static let CARRYOVER_TTL_SEC: Int64 = 3 * 86400

  /// Like `localCardsWillBeReplaced`, for removals whose replacement cards are inserted by a later
  /// transaction (reprocessing a day or batches: the cards are soft-deleted first, the new analysis
  /// runs afterwards). The private flag and the manual / confirmed project assignments of each card
  /// are kept by time range, and `cardInserted` hands them to the regenerated cards.
  @discardableResult
  func localCardsWillBeReprocessed(_ db: Database, where clause: String, arguments: StatementArguments)
    -> [ReplacedCard]
  {
    let cards = localCardsWillBeReplaced(db, where: clause, arguments: arguments)
    hook("localCardsWillBeReprocessed") {
      let nowSec = now() / 1000
      try db.execute(
        sql: "DELETE FROM sync_carryover WHERE created_at < ?", arguments: [nowSec - SyncLocal.CARRYOVER_TTL_SEC])
      for c in cards where c.category != ERROR_CATEGORY {
        guard let uuid = c.uuid else { continue }
        let isPrivate = parseJSONObject(c.metadata)["private"]?.boolValue == true
        let rows = try Row.fetchAll(
          db,
          sql: """
            SELECT project_id, share FROM card_projects
             WHERE card_uuid = ? AND deleted = 0 AND (source = 'manual' OR confirmed = 1)
            """,
          arguments: [uuid])
        guard isPrivate || !rows.isEmpty else { continue }
        let projects: [JSONValue] = rows.map { r in
          let pid: String = r["project_id"] ?? ""
          let share: Double = r["share"] ?? 1
          return .object(["projectId": .string(pid), "share": .double(share)])
        }
        try db.execute(
          sql: """
            INSERT OR REPLACE INTO sync_carryover (uuid, start_ts, end_ts, is_private, projects, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
          arguments: [uuid, c.startTs, c.endTs, isPrivate ? 1 : 0, JSONValue.array(projects).jsonString, nowSec])
      }
    }
    return cards
  }

  /// The kept choices of a reprocessed card covering at least half of [start, end), if any.
  private func carriedOver(_ db: Database, start: Int64, end: Int64) throws -> (
    isPrivate: Bool, projects: [(id: String, share: Double)]
  )? {
    let minCreated = now() / 1000 - SyncLocal.CARRYOVER_TTL_SEC
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT uuid, start_ts, end_ts, is_private, projects FROM sync_carryover
         WHERE start_ts < ? AND end_ts > ? AND created_at >= ?
        """,
      arguments: [end, start, minCreated])
    var byUuid: [String: Row] = [:]
    let candidates: [ReplacedCard] = rows.map { r in
      let uuid: String = r["uuid"] ?? ""
      byUuid[uuid] = r
      return ReplacedCard(
        id: 0, uuid: uuid, startTs: r["start_ts"] ?? 0, endTs: r["end_ts"] ?? 0, category: "", metadata: nil)
    }
    guard let best = SyncLocal.bestOverlap(candidates, start: start, end: end), let u = best.uuid, let r = byUuid[u]
    else { return nil }
    let isPrivate = (r["is_private"] as Int? ?? 0) == 1
    let projects: [(id: String, share: Double)] = (JSONValue.parse(r["projects"] ?? "[]")?.arrayValue ?? []).compactMap {
      guard let o = $0.objectValue, let id = o["projectId"]?.stringValue, !id.isEmpty else { return nil }
      return (id, clamp01(o["share"]?.numberValue ?? 1))
    }
    return (isPrivate, projects)
  }

  /// Call right after a card row was inserted by this device (analysis, idle card, onboarding).
  /// Assigns its uuid, clock and device; with `replacing`, the old card it mostly overlaps hands
  /// over its private flag and manual projects (as Windows replaceCardsDetailed does).
  func cardInserted(_ db: Database, id: Int64, replacing old: [ReplacedCard] = []) {
    hook("cardInserted") {
      guard
        let r = try Row.fetchOne(
          db, sql: "SELECT start_ts, end_ts, category, metadata, uuid FROM timeline_cards WHERE id = ?",
          arguments: [id])
      else { return }
      let category: String = r["category"] ?? ""
      var metadata: String? = r["metadata"]
      let isError = category == ERROR_CATEGORY || parseJSONObject(metadata)["isError"]?.boolValue == true
      let uuid = (r["uuid"] as String?) ?? syncNewUUID()
      let start: Int64 = r["start_ts"] ?? 0
      let end: Int64 = r["end_ts"] ?? 0
      let prev = isError ? nil : SyncLocal.bestOverlap(old, start: start, end: end)
      // No card replaced in this transaction: a day / batch reprocess may have removed it earlier.
      var carried: (isPrivate: Bool, projects: [(id: String, share: Double)])?
      if !isError && prev == nil { carried = try carriedOver(db, start: start, end: end) }
      let inheritPrivate =
        (prev.map { parseJSONObject($0.metadata)["private"]?.boolValue == true } ?? false) || carried?.isPrivate == true
      if inheritPrivate {
        var meta = parseJSONObject(metadata)
        meta["private"] = .bool(true)
        metadata = meta.jsonString
      }
      try db.execute(
        sql: """
          UPDATE timeline_cards SET uuid = ?, hlc = ?, field_hlc = '{}', device_id = ?, metadata = ?
          WHERE id = ?
          """,
        arguments: [uuid, tick(), deviceId, metadata, id])
      var inherited = false
      if let prevUuid = prev?.uuid { inherited = try copyManualProjects(db, from: prevUuid, to: uuid) }
      if let carried, !carried.projects.isEmpty {
        for p in carried.projects {
          try db.execute(
            sql: """
              INSERT OR REPLACE INTO card_projects (card_uuid, project_id, share, source, confidence, confirmed, deleted, hlc)
              VALUES (?, ?, ?, 'manual', 1, 1, 0, ?)
              """,
            arguments: [uuid, p.id, p.share, tick()])
          try enqueue(db, .cardProject, cardProjectId(uuid, p.id))
        }
        inherited = true
      }
      if !isError {
        try enqueue(db, .card, uuid)
        onCardsInserted?([InsertedCardRef(uuid: uuid, inheritedManual: inherited)])
      }
    }
  }

  /// Call before analysis rewrites a local card in place (an idle card stretched to a new end).
  func cardAnalysisWillChange(_ db: Database, id: Int64) -> CardAnalysisSnapshot {
    var wasPrivate = false
    hook("cardAnalysisWillChange") {
      let meta: String? = try String.fetchOne(
        db, sql: "SELECT metadata FROM timeline_cards WHERE id = ?", arguments: [id])
      wasPrivate = parseJSONObject(meta)["private"]?.boolValue == true
    }
    return CardAnalysisSnapshot(id: id, wasPrivate: wasPrivate)
  }

  /// Call after analysis rewrote a local card in place. Keeps the private flag, freezes the
  /// user-field clocks and gives the record a new clock, so the server accepts the new analysis
  /// fields without treating unchanged user fields as fresh edits.
  func cardAnalysisChanged(_ db: Database, _ snapshot: CardAnalysisSnapshot) {
    hook("cardAnalysisChanged") {
      guard
        let r = try Row.fetchOne(
          db, sql: "SELECT uuid, hlc, field_hlc, category, metadata FROM timeline_cards WHERE id = ?",
          arguments: [snapshot.id])
      else { return }
      var meta = parseJSONObject(r["metadata"])
      if snapshot.wasPrivate { meta["private"] = .bool(true) }
      var fh = parseJSONObject(r["field_hlc"])
      let old: String = r["hlc"] ?? ""
      if !old.isEmpty {
        for f in CARD_USER_FIELDS where fh[f]?.stringValue == nil { fh[f] = .string(old) }
      }
      try db.execute(
        sql: "UPDATE timeline_cards SET hlc = ?, field_hlc = ?, metadata = ? WHERE id = ?",
        arguments: [tick(), fh.jsonString, meta.jsonString, snapshot.id])
      try enqueueCard(db, uuid: r["uuid"], category: r["category"], metadata: r["metadata"])
    }
  }

  /// Call after a user edit of a card's user-editable fields was written (any device's card):
  /// each edited field gets a fresh clock so concurrent edits on other devices merge per field.
  func cardEdited(_ db: Database, id: Int64, fields: [CardUserField]) {
    guard !fields.isEmpty else { return }
    hook("cardEdited") {
      guard
        let r = try Row.fetchOne(
          db, sql: "SELECT uuid, field_hlc, category, metadata FROM timeline_cards WHERE id = ?",
          arguments: [id])
      else { return }
      var fh = parseJSONObject(r["field_hlc"])
      let h = tick()
      for f in fields { fh[f.rawValue] = .string(h) }
      if fields.contains(.category) || fields.contains(.isPrivate) { markScopeDirty() }
      try db.execute(
        sql: "UPDATE timeline_cards SET field_hlc = ? WHERE id = ?", arguments: [fh.jsonString, id])
      try enqueueCard(db, uuid: r["uuid"], category: r["category"], metadata: r["metadata"])
    }
  }

  /// A user edit of a card (Windows `Store.editCard`): writes the fields and their clocks.
  func editCard(
    _ db: Database, id: Int64, title: String? = nil, category: String? = nil, subcategory: String? = nil,
    deleted: Bool? = nil, isPrivate: Bool? = nil
  ) throws {
    guard let r = try Row.fetchOne(db, sql: "SELECT * FROM timeline_cards WHERE id = ?", arguments: [id])
    else { return }
    var fh = parseJSONObject(r["field_hlc"])
    var meta = parseJSONObject(r["metadata"])
    var sets: [String] = []
    var vals: [DatabaseValueConvertible?] = []
    let h = tick()
    for (k, v) in [("title", title), ("category", category), ("subcategory", subcategory)] {
      guard let v else { continue }
      sets.append("\(k) = ?")
      vals.append(v)
      fh[k] = .string(h)
    }
    if let deleted {
      sets.append("is_deleted = ?")
      vals.append(deleted ? 1 : 0)
      fh["deleted"] = .string(h)
    }
    if let isPrivate {
      if isPrivate { meta["private"] = .bool(true) } else { meta.removeValue(forKey: "private") }
      sets.append("metadata = ?")
      vals.append(meta.jsonString)
      fh["private"] = .string(h)
    }
    guard !sets.isEmpty else { return }
    if category != nil || isPrivate != nil { markScopeDirty() }
    sets.append("field_hlc = ?")
    vals.append(fh.jsonString)
    vals.append(id)
    try db.execute(
      sql: "UPDATE timeline_cards SET \(sets.joined(separator: ", ")) WHERE id = ?",
      arguments: StatementArguments(vals))
    try enqueueCard(db, uuid: r["uuid"], category: category ?? r["category"], metadata: r["metadata"])
  }

  /// True when the card was generated on this device (or before sync existed).
  func isLocalCard(_ db: Database, id: Int64) -> Bool {
    guard migrated,
      let row = try? Row.fetchOne(db, sql: "SELECT device_id FROM timeline_cards WHERE id = ?", arguments: [id]),
      let d = row["device_id"] as String?
    else { return true }
    return d == deviceId
  }

  /// Call right after an observation row was inserted by this device's analysis.
  func observationInserted(_ db: Database, id: Int64) {
    hook("observationInserted") {
      let uuid = syncNewUUID()
      try db.execute(
        sql: "UPDATE observations SET uuid = ?, hlc = ?, device_id = ? WHERE id = ? AND uuid IS NULL",
        arguments: [uuid, tick(), deviceId, id])
      if db.changesCount > 0 { try enqueue(db, .observation, uuid) }
    }
  }

  /// Call right before observations are deleted, with the WHERE clause of that DELETE:
  /// queues tombstones so the server (and the other devices) drop their text too.
  func observationsWillDelete(_ db: Database, where clause: String, arguments: StatementArguments) {
    hook("observationsWillDelete") {
      let uuids = try String.fetchAll(
        db, sql: "SELECT uuid FROM observations WHERE (\(clause)) AND uuid IS NOT NULL", arguments: arguments)
      for u in uuids {
        let payload: [String: JSONValue] = ["deleted": .bool(true), "hlc": .string(tick())]
        try enqueue(db, .observation, u, payload: payload.jsonString)
      }
    }
  }

  /// A local write to a standup / day goal / user doc: new HLC + queued upload.
  /// Before sign-in nothing is tracked; the first sync uploads what the server lacks.
  func docWritten(_ db: Database, _ entity: DocEntity, _ id: String) {
    hook("docWritten") { try recordDoc(db, entity, id) }
  }

  func recordDoc(_ db: Database, _ entity: DocEntity, _ id: String) throws {
    guard syncEnabled else { return }
    try SyncLocal.setMetaHlc(db, "\(entity.rawValue):\(id)", tick())
    try enqueue(db, entity.syncEntity, id)
  }

  static func metaHlc(_ db: Database, _ key: String) throws -> String {
    try String.fetchOne(db, sql: "SELECT hlc FROM sync_meta WHERE key = ?", arguments: [key]) ?? ""
  }

  static func setMetaHlc(_ db: Database, _ key: String, _ hlc: String) throws {
    try db.execute(
      sql: "INSERT INTO sync_meta (key, hlc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET hlc = excluded.hlc",
      arguments: [key, hlc])
  }

  // MARK: - helpers

  /// The old card covering at least half of [start, end), if any (error cards excluded).
  static func bestOverlap(_ old: [ReplacedCard], start: Int64, end: Int64) -> ReplacedCard? {
    var best: ReplacedCard?
    var bestOverlap: Int64 = 0
    for o in old where o.category != ERROR_CATEGORY {
      let ov = min(end, o.endTs) - max(start, o.startTs)
      if ov > bestOverlap {
        best = o
        bestOverlap = ov
      }
    }
    guard let best, bestOverlap * 2 >= max(1, end - start) else { return nil }
    return best
  }

  private func copyManualProjects(_ db: Database, from fromUuid: String, to toUuid: String) throws -> Bool {
    let rows = try Row.fetchAll(
      db,
      sql: "SELECT project_id, share FROM card_projects WHERE card_uuid = ? AND source = 'manual' AND deleted = 0",
      arguments: [fromUuid])
    for r in rows {
      let pid: String = r["project_id"]
      let share: Double = r["share"]
      try db.execute(
        sql: """
          INSERT OR REPLACE INTO card_projects (card_uuid, project_id, share, source, confidence, confirmed, deleted, hlc)
          VALUES (?, ?, ?, 'manual', 1, 1, 0, ?)
          """,
        arguments: [toUuid, pid, share, tick()])
      try enqueue(db, .cardProject, cardProjectId(toUuid, pid))
    }
    return !rows.isEmpty
  }
}

/// A lowercase random uuid (as Node's randomUUID; the server compares device ids as text).
func syncNewUUID() -> String { UUID().uuidString.lowercased() }

// MARK: - Time helpers (port of windows/src/main/time.ts)

/// Dayflow's logical day starts at 4 AM local time.
let DAY_BOUNDARY_HOUR = 4

private func gregorianCalendar() -> Calendar {
  var c = Calendar(identifier: .gregorian)
  c.timeZone = TimeZone.current
  return c
}

/// Logical day ("YYYY-MM-DD") for a unix timestamp (seconds), using the 4 AM boundary.
func syncLogicalDay(_ ts: Int64) -> String {
  let cal = gregorianCalendar()
  var d = Date(timeIntervalSince1970: TimeInterval(ts))
  if cal.component(.hour, from: d) < DAY_BOUNDARY_HOUR {
    d = cal.date(byAdding: .day, value: -1, to: d) ?? d
  }
  let c = cal.dateComponents([.year, .month, .day], from: d)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

/// Formats a unix timestamp (seconds) as "h:mm AM" in local time (the Mac's card clock format).
func syncFormatClock(_ ts: Int64) -> String {
  let cal = gregorianCalendar()
  let d = Date(timeIntervalSince1970: TimeInterval(ts))
  var h = cal.component(.hour, from: d)
  let m = cal.component(.minute, from: d)
  let ampm = h >= 12 ? "PM" : "AM"
  h = h % 12
  if h == 0 { h = 12 }
  return "\(h):\(m < 10 ? "0" : "")\(m) \(ampm)"
}

/// "YYYY-MM-DD" in local time for a date (calendar day, no 4 AM shift).
func syncCalendarDayString(_ date: Date) -> String {
  let c = gregorianCalendar().dateComponents([.year, .month, .day], from: date)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

func syncIsDayString(_ s: String) -> Bool {
  let u = Array(s.utf8)
  guard u.count == 10, u[4] == 0x2D, u[7] == 0x2D else { return false }
  for (i, c) in u.enumerated() where i != 4 && i != 7 {
    if !(c >= 0x30 && c <= 0x39) { return false }
  }
  return true
}
