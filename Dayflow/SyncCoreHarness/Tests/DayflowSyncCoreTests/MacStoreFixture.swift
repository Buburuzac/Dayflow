//
//  MacStoreFixture.swift
//
//  A temporary database with the Mac app's schema (StorageManager.migrate, the tables sync touches)
//  and a stand-in for the StorageManager write paths. Each write path uses the same SQL and the
//  same SyncLocal hook calls as the edited StorageManager files, so the tests exercise exactly
//  what the app does.
//

import Foundation
import GRDB

@testable import DayflowSyncCore

let MAC_SCHEMA = """
  CREATE TABLE IF NOT EXISTS analysis_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_start_ts INTEGER NOT NULL,
      batch_end_ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      llm_metadata TEXT,
      detailed_transcription TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS timeline_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      start_ts INTEGER,
      end_ts INTEGER,
      day DATE NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      category TEXT NOT NULL,
      subcategory TEXT,
      detailed_summary TEXT,
      metadata TEXT,
      video_summary_url TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_cards_day ON timeline_cards(day);
  CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      observation TEXT NOT NULL,
      metadata TEXT,
      llm_model TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_observations_batch_id ON observations(batch_id);
  CREATE INDEX IF NOT EXISTS idx_observations_start_ts ON observations(start_ts);
  CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);
  CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      idle_seconds_at_capture INTEGER,
      frame_index INTEGER,
      is_deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS daily_standup_entries (
      standup_day TEXT NOT NULL PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS day_goals (
      day TEXT NOT NULL PRIMARY KEY,
      focus_target_minutes INTEGER NOT NULL,
      distraction_limit_minutes INTEGER NOT NULL,
      is_skipped INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS day_goal_categories (
      day TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('focus', 'distraction')),
      category_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      category_color_hex TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (day, kind, category_id)
  );
  """

/// A card as analysis produces it (TimelineCardShell with resolved times).
struct TestCard {
  var startTs: Int64
  var endTs: Int64
  var title: String
  var category = "Work"
  var subcategory = ""
  var summary: String? = nil
  var detailedSummary = ""
  var appSitesPrimary: String? = nil
}

/// Labels from a test table: frames → "app — window" (stands in for the accessibility log).
final class TableWindowLabels: WindowLabelSource, @unchecked Sendable {
  func windowLabels(_ db: Database, startTs: Int64, endTs: Int64) -> [String] {
    (try? String.fetchAll(
      db,
      sql: "SELECT file_path FROM screenshots WHERE captured_at >= ? AND captured_at < ? AND is_deleted = 0 ORDER BY captured_at",
      arguments: [startTs, endTs]).map { $0.hasPrefix("label:") ? String($0.dropFirst(6)) : "" }.filter { !$0.isEmpty })
      ?? []
  }
}

/// One Mac installation: its database, its SyncLocal, and the StorageManager write paths.
final class MacStore {
  let dir: URL
  let path: String
  let db: DatabaseQueue
  let local: SyncLocal
  let labels = TableWindowLabels()

  init(dir: URL, name: String = "db", now: @escaping () -> Int64 = syncNowMs, schema: String = MAC_SCHEMA) throws {
    self.dir = dir
    path = dir.appendingPathComponent("\(name).sqlite").path
    db = try DatabaseQueue(path: path)
    local = SyncLocal(now: now)
    try db.write { db in try db.execute(sql: schema) }
    try db.write { db in try self.local.migrate(db) }
  }

  var repo: SyncRepo { SyncRepo(local: local) }

  /// Synchronous access (GRDB prefers its async overloads inside async tests).
  func read<T>(_ f: (Database) throws -> T) throws -> T { try db.read(f) }
  func write<T>(_ f: (Database) throws -> T) throws -> T { try db.write(f) }
  func outbox(_ docs: SyncDocSources = NoSyncDocs()) -> SyncOutboxBuilder {
    SyncOutboxBuilder(local: local, docs: docs, labels: labels)
  }
  func applier(_ docs: SyncDocSources = NoSyncDocs(), userId: String? = "u") -> RemoteApplier {
    RemoteApplier(local: local, docs: docs, userId: userId)
  }

  func setSyncEnabled(_ on: Bool) throws { try db.write { try local.setSyncEnabled($0, on) } }

  func createBatch(_ start: Int64, _ end: Int64) throws -> Int64 {
    try db.write { db in
      try db.execute(
        sql: "INSERT INTO analysis_batches (batch_start_ts, batch_end_ts, status) VALUES (?, ?, 'analyzed')",
        arguments: [start, end])
      return db.lastInsertedRowID
    }
  }

  func insertScreenshot(_ at: Int64, label: String) throws {
    try db.write { db in
      try db.execute(
        sql: "INSERT INTO screenshots (captured_at, file_path, file_size) VALUES (?, ?, 1)", arguments: [at, "label:" + label])
    }
  }

  /// StorageManager.replaceTimelineCardsInRange (same SQL and hooks; clock strings come from the timestamps).
  @discardableResult
  func replaceTimelineCardsInRange(from fromTs: Int64, to toTs: Int64, with cards: [TestCard], batchId: Int64) throws
    -> [Int64]
  {
    let local = self.local
    let keepAfterTs = Int.max
    return try db.write { db in
      let syncReplaced = local.localCardsWillBeReplaced(
        db,
        where: """
          ((start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?)) AND is_deleted = 0
          AND (category != 'System' OR batch_id = ?)
          AND NOT (start_ts > ? AND COALESCE(batch_id, -1) IN (SELECT id FROM analysis_batches WHERE batch_start_ts > ?))
          """, arguments: [toTs, fromTs, fromTs, toTs, batchId, keepAfterTs, keepAfterTs])
      try db.execute(
        sql: """
              UPDATE timeline_cards
              SET is_deleted = 1
              WHERE ((start_ts < ? AND end_ts > ?)
                 OR (start_ts >= ? AND start_ts < ?))
                 AND is_deleted = 0
                 AND (category != 'System' OR batch_id = ?)
                 AND NOT (start_ts > ? AND COALESCE(batch_id, -1) IN (
                   SELECT id FROM analysis_batches WHERE batch_start_ts > ?))
                 AND \(local.localOnlySQL)
          """,
        arguments: [toTs, fromTs, fromTs, toTs, batchId, keepAfterTs, keepAfterTs, local.localArgument])
      var ids: [Int64] = []
      for c in cards {
        var meta: [String: JSONValue] = ["distractions": .array([])]
        if let p = c.appSitesPrimary { meta["appSites"] = .object(["primary": .string(p)]) }
        try db.execute(
          sql: """
                INSERT INTO timeline_cards(
                    batch_id, start, end, start_ts, end_ts, day, title,
                    summary, category, subcategory, detailed_summary, metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
          arguments: [
            batchId, syncFormatClock(c.startTs), syncFormatClock(c.endTs), c.startTs, c.endTs, syncLogicalDay(c.startTs),
            c.title, c.summary ?? "\(c.title) summary", c.category, c.subcategory, c.detailedSummary, meta.jsonString,
          ])
        let insertedId = db.lastInsertedRowID
        ids.append(insertedId)
        local.cardInserted(db, id: insertedId, replacing: syncReplaced)
      }
      return ids
    }
  }

  /// The error-card path of LLMService (a "System" card through replaceTimelineCardsInRange).
  func insertErrorCard(batchId: Int64, _ start: Int64, _ end: Int64, _ message: String) throws {
    try replaceTimelineCardsInRange(
      from: start, to: end,
      with: [TestCard(startTs: start, endTs: end, title: "Processing failed", category: ERROR_CATEGORY, summary: message)],
      batchId: batchId)
  }

  /// StorageManager.updateTimelineCard
  func updateTimelineCard(_ id: Int64, title: String? = nil, category: String? = nil) throws {
    let local = self.local
    try db.write { db in
      try db.execute(
        sql: """
              UPDATE timeline_cards
              SET title = COALESCE(?, title),
                  category = COALESCE(?, category)
              WHERE id = ?
          """, arguments: [title, category, id])
      local.cardEdited(
        db, id: id, fields: (title != nil ? [CardUserField.title] : []) + (category != nil ? [CardUserField.category] : []))
    }
  }

  /// StorageManager.deleteTimelineCard(recordId:)
  func deleteTimelineCard(_ recordId: Int64) throws {
    let local = self.local
    try db.write { db in
      guard
        let row = try Row.fetchOne(
          db, sql: "SELECT start_ts, end_ts, batch_id FROM timeline_cards WHERE id = ? AND is_deleted = 0",
          arguments: [recordId])
      else { return }
      let startTs: Int = row["start_ts"] ?? 0
      let endTs: Int = row["end_ts"] ?? 0
      let batchId: Int64? = row["batch_id"]
      try db.execute(sql: "UPDATE timeline_cards SET is_deleted = 1 WHERE id = ? AND is_deleted = 0", arguments: [recordId])
      local.cardEdited(db, id: recordId, fields: [.deleted])
      guard local.isLocalCard(db, id: recordId) else { return }
      guard endTs > startTs else { return }
      if let batchId {
        local.observationsWillDelete(
          db, where: "batch_id = ? AND ((start_ts < ? AND end_ts > ?) OR (start_ts >= ? AND start_ts < ?))",
          arguments: [batchId, endTs, startTs, startTs, endTs])
        try db.execute(
          sql: """
                DELETE FROM observations
                WHERE batch_id = ?
                  AND ((start_ts < ? AND end_ts > ?)
                    OR (start_ts >= ? AND start_ts < ?))
            """, arguments: [batchId, endTs, startTs, startTs, endTs])
      }
    }
  }

  /// StorageManager.saveObservations
  func saveObservations(batchId: Int64, _ obs: [(start: Int64, end: Int64, text: String)]) throws {
    let local = self.local
    try db.write { db in
      for o in obs {
        try db.execute(
          sql: "INSERT INTO observations(batch_id, start_ts, end_ts, observation, metadata, llm_model) VALUES (?, ?, ?, ?, ?, ?)",
          arguments: [batchId, o.start, o.end, o.text, nil, "m"])
        local.observationInserted(db, id: db.lastInsertedRowID)
      }
    }
  }

  /// StorageManager.deleteObservations(forBatchIds:)
  func deleteObservations(forBatchIds batchIds: [Int64]) throws {
    let local = self.local
    try db.write { db in
      let placeholders = Array(repeating: "?", count: batchIds.count).joined(separator: ",")
      local.observationsWillDelete(db, where: "batch_id IN (\(placeholders))", arguments: StatementArguments(batchIds))
      try db.execute(
        sql: "DELETE FROM observations WHERE batch_id IN (\(placeholders))", arguments: StatementArguments(batchIds))
    }
  }

  /// StorageManager.deleteTimelineCards(forDay:) (reprocess a day)
  func deleteTimelineCards(forDay day: String) throws {
    let (start, end) = dayRange(day)
    let local = self.local
    try db.write { db in
      local.localCardsWillBeReprocessed(
        db, where: "start_ts >= ? AND start_ts < ? AND is_deleted = 0", arguments: [start, end])
      try db.execute(
        sql: """
              UPDATE timeline_cards
              SET is_deleted = 1
              WHERE start_ts >= ? AND start_ts < ?
                AND is_deleted = 0
                AND \(local.localOnlySQL)
          """, arguments: [start, end, local.localArgument])
    }
  }

  /// StorageManager.saveDailyStandup
  func saveDailyStandup(_ day: String, _ json: String) throws {
    let local = self.local
    try db.write { db in
      try db.execute(
        sql: """
              INSERT INTO daily_standup_entries (standup_day, payload_json, updated_at)
              VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(standup_day) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  updated_at = CURRENT_TIMESTAMP
          """, arguments: [day, json])
      local.docWritten(db, .standup, day)
    }
  }

  func fetchStandup(_ day: String) throws -> String? {
    try db.read { try String.fetchOne($0, sql: "SELECT payload_json FROM daily_standup_entries WHERE standup_day = ?", arguments: [day]) }
  }

  /// StorageManager.saveDayGoalPlan
  func saveDayGoalPlan(day: String, focus: Int, distraction: Int, focusCats: [(String, String, String)]) throws {
    let local = self.local
    try db.write { db in
      let now = Int(Date().timeIntervalSince1970)
      try db.execute(
        sql: """
              INSERT INTO day_goals(day, focus_target_minutes, distraction_limit_minutes, is_skipped, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(day) DO UPDATE SET
                  focus_target_minutes = excluded.focus_target_minutes,
                  distraction_limit_minutes = excluded.distraction_limit_minutes,
                  is_skipped = excluded.is_skipped,
                  updated_at = excluded.updated_at
          """, arguments: [day, focus, distraction, 0, now, now])
      try db.execute(sql: "DELETE FROM day_goal_categories WHERE day = ?", arguments: [day])
      for (i, c) in focusCats.enumerated() {
        try db.execute(
          sql: """
            INSERT INTO day_goal_categories(day, kind, category_id, category_name, category_color_hex, sort_order)
            VALUES (?, 'focus', ?, ?, ?, ?)
            """, arguments: [day, c.0, c.1, c.2, i])
      }
      local.docWritten(db, .dayGoal, day)
    }
  }

  // MARK: reads (as the timeline / analysis see them)

  struct Card {
    var id: Int64
    var uuid: String?
    var title: String
    var category: String
    var summary: String
    var deviceId: String?
    var remote: Bool
    var isPrivate: Bool
  }

  private func mapCard(_ r: Row) -> Card {
    let dev: String? = r["device_id"]
    return Card(
      id: r["id"], uuid: r["uuid"], title: r["title"], category: r["category"], summary: r["summary"] ?? "",
      deviceId: dev, remote: dev != nil && dev != local.deviceId,
      isPrivate: parseJSONObject(r["metadata"])["private"]?.boolValue == true)
  }

  /// StorageManager.fetchTimelineCards(forDay:) — every device's live cards.
  func cardsForDay(_ day: String) throws -> [Card] {
    let (start, end) = dayRange(day)
    return try db.read { db in
      try Row.fetchAll(
        db, sql: "SELECT * FROM timeline_cards WHERE start_ts >= ? AND start_ts < ? AND is_deleted = 0 ORDER BY start_ts ASC, id ASC",
        arguments: [start, end]
      ).map(mapCard)
    }
  }

  func card(_ id: Int64) throws -> Card? {
    try db.read { try Row.fetchOne($0, sql: "SELECT * FROM timeline_cards WHERE id = ?", arguments: [id]).map(mapCard) }
  }

  /// fetchTimelineCardsByTimeRange(from:to:localOnly:)
  func cardsInRange(_ from: Int64, _ to: Int64, localOnly: Bool) throws -> [Card] {
    try db.read { db in
      try Row.fetchAll(
        db,
        sql: """
              SELECT * FROM timeline_cards
              WHERE ((start_ts < ? AND end_ts > ?)
                 OR (start_ts >= ? AND start_ts < ?))
                AND is_deleted = 0
                AND (? = 0 OR \(local.localOnlySQL))
              ORDER BY start_ts ASC
          """, arguments: [to, from, from, to, localOnly ? 1 : 0, local.localArgument]
      ).map(mapCard)
    }
  }

  /// fetchObservationsByTimeRange — analysis input, this device only.
  func observationsInRange(_ from: Int64, _ to: Int64) throws -> [String] {
    try db.read { db in
      try String.fetchAll(
        db,
        sql: """
              SELECT observation FROM observations
                WHERE ((start_ts < ? AND end_ts > ?)
                   OR (start_ts >= ? AND start_ts < ?))
                  AND \(local.localOnlySQL)
                ORDER BY start_ts ASC
          """, arguments: [to, from, from, to, local.localArgument])
    }
  }

  func count(_ sql: String) throws -> Int { try db.read { try Int.fetchOne($0, sql: sql) ?? 0 } }

  func pendingCount() throws -> Int { try db.read { try repo.pendingCount($0) } }
  func pending() throws -> [OutboxEntry] { try db.read { try repo.pending($0, limit: 1000) } }
  func markPushed(_ e: [OutboxEntry]) throws { try db.write { try repo.markPushed($0, e) } }

  func buildBatch(_ docs: SyncDocSources = NoSyncDocs(), userId: String = "user-1") throws -> BuiltBatch {
    let ob = outbox(docs)
    let entries = try pending()
    return try db.write { db in ob.buildBatch(db, userId: userId, entries) }
  }

  @discardableResult
  func apply(_ changes: [SyncChange], docs: SyncDocSources = NoSyncDocs(), userId: String? = "u") throws -> ApplyResult {
    let a = applier(docs, userId: userId)
    return try db.write { db in a.apply(db, changes) }
  }

  @discardableResult
  func rescope() throws -> Int {
    let ob = outbox()
    return try db.write { try ob.rescopeCards($0) }
  }

  @discardableResult
  func requeueObservations(upload: Bool) throws -> Int {
    let ob = outbox()
    return try db.write { try ob.requeueObservations($0, upload: upload) }
  }

  /// Builds and "pushes" everything queued; the server accepted all of it.
  func flush(_ docs: SyncDocSources = NoSyncDocs()) throws -> [SyncChange] {
    let batch = try buildBatch(docs)
    try db.write { db in
      try commitAccepted(db, batch) { _ in true }
      try repo.markPushed(db, batch.used)
      try repo.markPushed(db, batch.dropped)
    }
    return batch.changes
  }
}

/// [start, end) unix seconds of a logical day (4 AM boundary, local time).
func dayRange(_ day: String) -> (Int64, Int64) {
  let p = day.split(separator: "-").compactMap { Int($0) }
  var cal = Calendar(identifier: .gregorian)
  cal.timeZone = TimeZone.current
  let start = cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 4))!
  let end = cal.date(byAdding: .day, value: 1, to: start)!
  return (Int64(start.timeIntervalSince1970), Int64(end.timeIntervalSince1970))
}

/// `new Date(2026, 10, 8, 9, 0)` in local time (seconds).
func localTs(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Int64 {
  var cal = Calendar(identifier: .gregorian)
  cal.timeZone = TimeZone.current
  return Int64(cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!.timeIntervalSince1970)
}

let t9 = localTs(2026, 11, 8, 9)

func tempDir() throws -> URL {
  let u = FileManager.default.temporaryDirectory.appendingPathComponent("dayflow-sync-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
  return u
}

func remoteCard(
  _ id: String, _ deviceId: String, _ hlc: String, _ over: [String: JSONValue] = [:], deleted: Bool? = nil,
  fieldHlc: [String: String]? = nil
) -> SyncChange {
  var data: [String: JSONValue] = [
    "userId": .string("u"), "startTs": .int(t9), "endTs": .int(t9 + 1800), "day": .string("2026-11-08"),
    "title": .string("Remote work"), "summary": .string("on the laptop"), "detailedSummary": .string(""),
    "category": .string("Work"), "subcategory": .string(""), "metadata": .object(["distractions": .array([])]),
    "isError": .bool(false),
  ]
  for (k, v) in over { data[k] = v }
  return SyncChange(entity: .card, id: id, deviceId: deviceId, hlc: hlc, deleted: deleted, data: data, fieldHlc: fieldHlc)
}

extension SyncChange {
  var title: String? { data?["title"]?.stringValue }
  func str(_ k: String) -> String? { data?[k]?.stringValue }
}
