//
//  SyncApply.swift
//  Dayflow — Dayflow Sync client core
//
//  Applies pulled changes with the contract's conflict rules (port of windows/src/main/sync/apply.ts):
//  - HLC string order, last writer wins per record;
//  - cards: the generating device owns analysis fields; title/category/subcategory/deleted/private
//    merge per field via fieldHlc; field clocks stamped by this device are ignored (own echoes);
//  - card_projects / projects / project_members / docs: LWW per record.
//  Cards and observations from other devices keep their origin device_id, so this device's
//  analysis never replaces them.
//

import Foundation
import GRDB

struct ApplyResult: Equatable {
  var applied = 0
  var skipped = 0
  var cards = false
  var projects = false
  var docs: [DocEntity] = []
  /// `local.policy` changed (a category renamed on another device kept its exclusion).
  var policyChanged = false
}

private func str(_ v: JSONValue?, _ maxLen: Int = 100_000) -> String {
  guard let v else { return "" }
  if case .string(let s) = v { return String(s.prefix(maxLen)) }
  return String(v.looseString.prefix(maxLen))
}

private func finite(_ v: JSONValue?) -> Double? { v?.numberValue }

private func isHexColor6or8(_ s: String) -> Bool {
  let u = Array(s.utf8)
  guard u.first == 0x23, u.count == 7 || u.count == 9 else { return false }
  return u.dropFirst().allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// Whitelists the metadata keys a pulled card may carry.
func cleanMetadata(_ m: JSONValue?) -> [String: JSONValue] {
  let o = m?.objectValue ?? [:]
  var out: [String: JSONValue] = [:]
  if let ds = o["distractions"]?.arrayValue {
    out["distractions"] = .array(
      ds.compactMap { $0.objectValue }.prefix(50).map { x in
        .object([
          "startTime": .string(str(x["startTime"], 20)),
          "endTime": .string(str(x["endTime"], 20)),
          "title": .string(str(x["title"], 500)),
          "summary": .string(str(x["summary"], 2000)),
        ])
      })
  }
  if let a = o["appSites"]?.objectValue {
    out["appSites"] = .object([
      "primary": (a["primary"]?.isTruthy ?? false) ? .string(str(a["primary"], 200)) : .null,
      "secondary": (a["secondary"]?.isTruthy ?? false) ? .string(str(a["secondary"], 200)) : .null,
    ])
  }
  if o["private"]?.boolValue == true { out["private"] = .bool(true) }
  if let w = o["windowApps"]?.arrayValue {
    out["windowApps"] = .array(Array(w.filter { $0.stringValue != nil }.prefix(20)))
  }
  if let projects = o["detailProjects"]?.objectValue {
    out["detailProjects"] = .object(projects.filter { $0.key.hasPrefix("detail:") || $0.key.hasPrefix("distraction:") })
  }
  return out
}


struct RemoteApplier {
  let local: SyncLocal
  let repo: SyncRepo
  let docs: SyncDocSources
  /// The signed-in user (docs of other users are ignored).
  let userId: String?

  init(local: SyncLocal, docs: SyncDocSources, userId: String?) {
    self.local = local
    self.repo = SyncRepo(local: local)
    self.docs = docs
    self.userId = userId
  }

  /// Applies a page of pulled changes in the caller's transaction.
  func apply(_ db: Database, _ changes: [SyncChange]) -> ApplyResult {
    var res = ApplyResult()
    var docChanges: [SyncChange] = []
    for c in changes {
      if c.id.isEmpty || c.hlc.isEmpty {
        res.skipped += 1
        continue
      }
      local.observeHlc(c.hlc)
      if c.entity == .standup || c.entity == .dayGoal || c.entity == .userDoc {
        docChanges.append(c)
        continue
      }
      var ok = false
      do {
        try db.inSavepoint {
          ok = try applyOne(db, c, &res)
          return ok ? .commit : .rollback
        }
      } catch {
        print("⚠️ [Sync] could not apply change \(c.entity.rawValue): \(error)")
        ok = false
      }
      if ok { res.applied += 1 } else { res.skipped += 1 }
    }
    for c in docChanges {
      var ok = false
      do {
        ok = try applyDoc(db, c, &res)
      } catch {
        print("⚠️ [Sync] could not apply change \(c.entity.rawValue): \(error)")
      }
      if ok {
        res.applied += 1
        let e: DocEntity = c.entity == .standup ? .standup : (c.entity == .dayGoal ? .dayGoal : .userDoc)
        if !res.docs.contains(e) { res.docs.append(e) }
      } else {
        res.skipped += 1
      }
    }
    return res
  }

  private func applyOne(_ db: Database, _ c: SyncChange, _ res: inout ApplyResult) throws -> Bool {
    switch c.entity {
    case .card:
      let ok = try applyCard(db, c)
      if ok { res.cards = true }
      return ok
    case .observation:
      return try applyObservation(db, c)
    // Pulled projects, memberships and assignments can change the scope of any older card.
    case .cardProject:
      let ok = try applyCardProject(db, c)
      if ok {
        res.cards = true
        local.markScopeDirty()
      }
      return ok
    case .project:
      let ok = try applyProject(db, c)
      if ok {
        res.projects = true
        res.cards = true
        local.markScopeDirty()
      }
      return ok
    case .projectMember:
      let ok = try applyMember(db, c)
      if ok {
        res.projects = true
        local.markScopeDirty()
      }
      return ok
    default:
      return false
    }
  }

  func applyCard(_ db: Database, _ c: SyncChange) throws -> Bool {
    let me = local.deviceId
    let d = c.data ?? [:]
    let originRaw = d["originDeviceId"]?.stringValue ?? ""
    let origin = originRaw.isEmpty ? c.deviceId : originRaw
    guard let row = try Row.fetchOne(db, sql: "SELECT * FROM timeline_cards WHERE uuid = ?", arguments: [c.id]) else {
      // Never seen: store it as the origin device's card. Error cards are never synced.
      guard c.data != nil, d["isError"]?.boolValue != true, origin != me else { return false }
      guard let s = finite(d["startTs"]), let e = finite(d["endTs"]), e >= s else { return false }
      let startTs = Int64(s)
      let endTs = Int64(e)
      let dayRaw = str(d["day"])
      let day = syncIsDayString(dayRaw) ? dayRaw : syncLogicalDay(startTs)
      let category = str(d["category"], 100)
      try db.execute(
        sql: """
          INSERT INTO timeline_cards (batch_id, start, end, start_ts, end_ts, day, title, summary, category, subcategory,
            detailed_summary, metadata, is_deleted, uuid, hlc, field_hlc, device_id)
          VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          """,
        arguments: [
          syncFormatClock(startTs), syncFormatClock(endTs), startTs, endTs, day, str(d["title"], 500), str(d["summary"]),
          category.isEmpty ? "Work" : category, str(d["subcategory"], 100), str(d["detailedSummary"]),
          cleanMetadata(d["metadata"]).jsonString, c.deleted == true ? 1 : 0, c.id, c.hlc,
          encodeFieldHlc(c.fieldHlc ?? [:]), origin,
        ])
      return true
    }

    let rowDevice: String? = row["device_id"]
    let isLocal = rowDevice == nil || rowDevice == me
    let rowHlc: String = row["hlc"] ?? ""
    var fh = parseJSONObject(row["field_hlc"])
    var meta = parseJSONObject(row["metadata"])
    var sets: [String] = []
    var vals: [DatabaseValueConvertible?] = []
    var metaChanged = false

    // Analysis fields: only from the device that generated the card, never onto our own cards.
    if !isLocal, c.data != nil, origin == rowDevice, c.hlc > rowHlc {
      if let s = finite(d["startTs"]), let e = finite(d["endTs"]), e >= s {
        let startTs = Int64(s)
        let endTs = Int64(e)
        let dayRaw = str(d["day"])
        sets += ["start = ?", "end = ?", "start_ts = ?", "end_ts = ?", "day = ?"]
        vals += [syncFormatClock(startTs), syncFormatClock(endTs), startTs, endTs, syncIsDayString(dayRaw) ? dayRaw : syncLogicalDay(startTs)]
      }
      sets += ["summary = ?", "detailed_summary = ?", "hlc = ?"]
      vals += [str(d["summary"]), str(d["detailedSummary"]), c.hlc]
      let m = cleanMetadata(d["metadata"])
      for k in ["distractions", "appSites", "windowApps"] {
        if let v = m[k] { meta[k] = v } else { meta.removeValue(forKey: k) }
      }
      metaChanged = true
    }

    // User-editable fields merge per field: newer field HLC wins. Without an explicit field HLC
    // only the origin device's record clock counts (its copy of the field is authoritative).
    let fromOrigin = origin == c.deviceId && !isLocal
    // Field clocks stamped by this device are our own writes coming back. They may carry the scoped
    // upload form of the card ("Out of scope" / a wiped personal card) and must never replace the
    // full local copy; edits made on other devices carry their own clocks and still merge.
    func ownClock(_ h: String) -> Bool { h.hasSuffix("-\(me)") }
    func remoteField(_ f: String) -> String {
      let h = c.fieldHlc?[f] ?? (fromOrigin ? c.hlc : "")
      return !h.isEmpty && !ownClock(h) ? h : ""
    }
    func localField(_ f: String) -> String { fh[f]?.stringValue ?? rowHlc }

    if c.data != nil {
      for f in ["title", "category", "subcategory"] {
        guard let v = d[f]?.stringValue else { continue }
        let rf = remoteField(f)
        if rf > localField(f) {
          sets.append("\(f) = ?")
          vals.append(String(v.prefix(f == "title" ? 500 : 100)))
          fh[f] = .string(rf)
        }
      }
      let md = d["metadata"]?.objectValue ?? [:]
      let rp = remoteField("private")
      if rp > localField("private") {
        let p = md["private"]?.boolValue == true
        if p != (meta["private"]?.boolValue == true) {
          if p { meta["private"] = .bool(true) } else { meta.removeValue(forKey: "private") }
          metaChanged = true
        }
        fh["private"] = .string(rp)
      }
      let detailClock = remoteField("detailProjects")
      if detailClock > localField("detailProjects") {
        if let projects = cleanMetadata(d["metadata"])["detailProjects"] {
          meta["detailProjects"] = projects
        } else {
          meta.removeValue(forKey: "detailProjects")
        }
        metaChanged = true
        fh["detailProjects"] = .string(detailClock)
      }
    }
    let rd = remoteField("deleted")
    if rd > localField("deleted") {
      let del = c.deleted == true ? 1 : 0
      let cur: Int = row["is_deleted"] ?? 0
      if del != cur {
        sets.append("is_deleted = ?")
        vals.append(del)
      }
      fh["deleted"] = .string(rd)
    }
    if metaChanged {
      sets.append("metadata = ?")
      vals.append(meta.jsonString)
    }
    if sets.isEmpty { return false }
    sets.append("field_hlc = ?")
    vals.append(fh.jsonString)
    let rowId: Int64 = row["id"]
    vals.append(rowId)
    try db.execute(
      sql: "UPDATE timeline_cards SET \(sets.joined(separator: ", ")) WHERE id = ?", arguments: StatementArguments(vals))
    return true
  }

  private func encodeFieldHlc(_ f: [String: String]) -> String {
    f.mapValues { JSONValue.string($0) }.jsonString
  }

  func applyObservation(_ db: Database, _ c: SyncChange) throws -> Bool {
    let me = local.deviceId
    let row = try Row.fetchOne(db, sql: "SELECT device_id, hlc FROM observations WHERE uuid = ?", arguments: [c.id])
    if let row {
      let dev: String? = row["device_id"]
      if dev == nil || dev == me { return false }
    }
    if c.deviceId == me { return false }
    if c.deleted == true {
      guard row != nil else { return false }
      try db.execute(sql: "DELETE FROM observations WHERE uuid = ?", arguments: [c.id])
      return true
    }
    let d = c.data ?? [:]
    guard let s = finite(d["startTs"]), let e = finite(d["endTs"]), let text = d["text"]?.stringValue else {
      return false
    }
    if let row {
      let h: String = row["hlc"] ?? ""
      guard c.hlc > h else { return false }
      try db.execute(
        sql: "UPDATE observations SET start_ts = ?, end_ts = ?, observation = ?, hlc = ? WHERE uuid = ?",
        arguments: [Int64(s), Int64(e), String(text.prefix(100_000)), c.hlc, c.id])
      return true
    }
    try db.execute(
      sql: "INSERT INTO observations (batch_id, start_ts, end_ts, observation, uuid, hlc, device_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)",
      arguments: [Int64(s), Int64(e), String(text.prefix(100_000)), c.id, c.hlc, c.deviceId])
    return true
  }

  func applyCardProject(_ db: Database, _ c: SyncChange) throws -> Bool {
    let d = c.data ?? [:]
    let pair = splitPair(c.id)
    guard let cardUuid = d["cardId"]?.stringValue ?? pair?.0, let projectId = d["projectId"]?.stringValue ?? pair?.1
    else { return false }
    let cur = try repo.cardProject(db, cardUuid: cardUuid, projectId: projectId)
    if let cur, !(c.hlc > cur.hlc) { return false }
    let source = AssignmentSource(rawValue: d["source"]?.stringValue ?? "") ?? .manual
    try repo.putCardProject(
      db,
      CardProjectRow(
        cardUuid: cardUuid, projectId: projectId, share: clamp01(finite(d["share"]) ?? cur?.share ?? 1),
        source: c.data != nil ? source : (cur?.source ?? .manual),
        confidence: clamp01(finite(d["confidence"]) ?? cur?.confidence ?? 1),
        confirmed: c.data != nil ? d["confirmed"]?.boolValue == true : (cur?.confirmed ?? false),
        deleted: c.deleted == true, hlc: c.hlc))
    return true
  }

  func applyProject(_ db: Database, _ c: SyncChange) throws -> Bool {
    let cur = try repo.project(db, c.id)
    if let cur, !(c.hlc > cur.hlc) { return false }
    let d = c.data ?? [:]
    if cur == nil && (c.deleted == true || c.data == nil) { return false }
    let rules = d["rules"]?.objectValue ?? [:]
    func list(_ v: JSONValue?) -> [String]? {
      guard let a = v?.arrayValue else { return nil }
      return Array(a.compactMap { $0.stringValue }.prefix(100))
    }
    let odoo = d["odoo"]?.objectValue ?? [:]
    let ws = str(d["workspaceId"], 100)
    let name = str(d["name"], 200)
    let color = str(d["color"])
    let share = ShareLevel(rawValue: d["defaultShare"]?.stringValue ?? "")
    try repo.putProject(
      db,
      ProjectRow(
        id: c.id, workspaceId: ws.isEmpty ? (cur?.workspaceId ?? "") : ws,
        name: name.isEmpty ? (cur?.name ?? "Project") : name,
        color: isHexColor6or8(color) ? color : (cur?.color ?? "#7BC47F"),
        icon: d["icon"]?.stringValue ?? cur?.icon ?? "",
        description: str(d["description"], 2000),
        rules: c.data != nil
          ? ProjectRules(
            apps: list(rules["apps"]), domains: list(rules["domains"]), titleKeywords: list(rules["titleKeywords"]),
            repos: list(rules["repos"]))
          : (cur?.rules ?? ProjectRules()),
        defaultShare: share ?? cur?.defaultShare ?? .time,
        odoo: c.data != nil
          ? OdooMapping(
            projectId: finite(odoo["projectId"]).map { Int($0) }, taskId: finite(odoo["taskId"]).map { Int($0) },
            projectName: odoo["projectName"]?.stringValue, taskName: odoo["taskName"]?.stringValue)
          : (cur?.odoo ?? OdooMapping()),
        archived: c.data != nil ? d["archived"]?.boolValue == true : (cur?.archived ?? false),
        deleted: c.deleted == true, hlc: c.hlc))
    return true
  }

  func applyMember(_ db: Database, _ c: SyncChange) throws -> Bool {
    let d = c.data ?? [:]
    let pair = splitPair(c.id)
    guard let projectId = d["projectId"]?.stringValue ?? pair?.0, let userId = d["userId"]?.stringValue ?? pair?.1
    else { return false }
    if let cur = try repo.memberRow(db, projectId: projectId, userId: userId), !(c.hlc > cur.hlc) { return false }
    let level = ShareLevel(rawValue: d["shareLevel"]?.stringValue ?? "")
    try repo.putMember(db, projectId: projectId, userId: userId, shareLevel: level, deleted: c.deleted == true, hlc: c.hlc)
    return true
  }

  func applyDoc(_ db: Database, _ c: SyncChange) throws -> Bool {
    var res = ApplyResult()
    return try applyDoc(db, c, &res)
  }

  func applyDoc(_ db: Database, _ c: SyncChange, _ res: inout ApplyResult) throws -> Bool {
    guard let uid = userId, c.id.hasPrefix("\(uid):") else { return false }
    let localId = String(c.id.dropFirst(uid.count + 1))
    let entity: DocEntity = c.entity == .standup ? .standup : (c.entity == .dayGoal ? .dayGoal : .userDoc)
    let key = "\(entity.rawValue):\(localId)"
    let localHlc = try repo.metaHlc(db, key)
    guard c.hlc > localHlc else { return false }
    var payload: JSONValue? = c.data?["payload"]
    if case .some(.null) = payload { payload = nil }
    if let s = payload?.stringValue, let parsed = JSONValue.parse(s) { payload = parsed }
    if entity == .userDoc, localId == "categories", c.deleted != true, let bridge = docs.categoryBridge,
      let remote = validateSyncCategories(payload)
    {
      // No local clock yet = the first pull of this session: merge instead of deleting.
      let plan = planCategoryApply(local: bridge.currentCategories() ?? [], remote: remote, firstPull: localHlc.isEmpty)
      var policy = local.policy
      for r in plan.renames {
        if let next = policy.renamingCategory(from: r.from, to: r.to) { policy = next }
      }
      try db.inSavepoint {
        try repo.setMetaHlc(db, key, c.hlc)
        // A fresh local clock (newer than c.hlc, which was observed) uploads the merged list.
        if plan.pushBack { try local.recordDoc(db, .userDoc, "categories") }
        return .commit
      }
      bridge.applyRemoteCategories(plan.apply)
      if policy != local.policy {
        local.policy = policy
        res.policyChanged = true
      }
      return true
    }
    try db.inSavepoint {
      try docs.write(db, entity, localId, c.deleted == true ? nil : payload)
      try repo.setMetaHlc(db, key, c.hlc)
      return .commit
    }
    return true
  }
}
