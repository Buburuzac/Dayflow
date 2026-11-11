//
//  SyncScope.swift
//  Dayflow — Dayflow Sync client core
//
//  What leaves this Mac (port of windows/src/main/sync/scope.ts). Every card this device
//  generated gets a sync scope, decided here before anything is uploaded:
//
//    excluded      — a personal card (category listed in `excludedCategories`, or marked private):
//                    its content never leaves the Mac; a copy already on the server is wiped and deleted.
//    full          — confirmed work for a live project (not deleted, not archived): uploaded as is.
//    out_of_scope  — everything else: only its time span is uploaded, as an "Out of scope" block,
//                    so other devices see the time was taken but not what it was.
//
//  When a card's scope changes it is re-sent with a fresh clock (scope_hlc), so the server and
//  the user's other devices replace the earlier copy instead of ignoring it as stale.
//

import Foundation

enum CardScope: String, Sendable {
  case full
  case outOfScope = "out_of_scope"
  case excluded
}

/// The user's "What leaves this Mac" settings.
struct SyncPolicy: Equatable, Codable, Sendable {
  /// Category names (case-insensitive) whose cards never leave this Mac.
  var excludedCategories: [String]
  /// Cards without a confirmed live project are uploaded as time-only "Out of scope" blocks.
  var outOfScope: Bool
  /// Upload raw observations (the model's screen descriptions).
  var observations: Bool
  /// Earlier names of renamed categories, by the current name's key (`syncCategoryKey`). Cards keep
  /// the category string they were made with, so an excluded category stays excluded under its old
  /// names too; unticking the category removes those as well. Does not affect scopes by itself.
  var categoryAliases: [String: [String]]

  init(
    excludedCategories: [String] = ["Personal"], outOfScope: Bool = true, observations: Bool = false,
    categoryAliases: [String: [String]] = [:]
  ) {
    self.excludedCategories = excludedCategories
    self.outOfScope = outOfScope
    self.observations = observations
    self.categoryAliases = categoryAliases
  }

  /// The policy after the category `old` was renamed to `new` (here or on another device), or nil
  /// when nothing changes. The new name is excluded when the old one is, and the old name stays
  /// excluded: existing cards keep the old category string.
  func renamingCategory(from old: String, to new: String) -> SyncPolicy? {
    let o = old.trimmingCharacters(in: .whitespacesAndNewlines)
    let n = new.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !o.isEmpty, !n.isEmpty, syncCategoryKey(o) != syncCategoryKey(n) else { return nil }
    var p = self
    let excluded = p.excludedCategories.contains { syncCategoryKey($0) == syncCategoryKey(o) }
    if excluded && !p.excludedCategories.contains(where: { syncCategoryKey($0) == syncCategoryKey(n) }) {
      p.excludedCategories.append(n)
    }
    var aliases = p.categoryAliases[syncCategoryKey(o)] ?? []
    aliases.append(o)
    for a in p.categoryAliases[syncCategoryKey(n)] ?? [] where !aliases.contains(where: { syncCategoryKey($0) == syncCategoryKey(a) }) {
      aliases.append(a)
    }
    p.categoryAliases.removeValue(forKey: syncCategoryKey(o))
    var seen = Set<String>()
    p.categoryAliases[syncCategoryKey(n)] = aliases.filter {
      let k = syncCategoryKey($0)
      guard k != syncCategoryKey(n), !seen.contains(k) else { return false }
      seen.insert(k)
      return true
    }
    return p == self ? nil : p
  }

  static let `default` = SyncPolicy()
  /// Everything is shared (used by tests of the sync mechanics).
  static let shareAll = SyncPolicy(excludedCategories: [], outOfScope: false, observations: true)
}

let OUT_OF_SCOPE_LABEL = "Out of scope"

/// Category names compare trimmed and case-insensitively.
func syncCategoryKey(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

func cardScope(category: String, isPrivate: Bool, hasConfirmedLiveProject: Bool, policy: SyncPolicy)
  -> CardScope
{
  let cat = category.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if isPrivate { return .excluded }
  if policy.excludedCategories.contains(where: {
    $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == cat
  }) {
    return .excluded
  }
  if hasConfirmedLiveProject || !policy.outOfScope { return .full }
  return .outOfScope
}

/// The upload form of a card's data for its scope. Times stay; everything that describes the work goes.
func redactCardData(_ data: [String: JSONValue], scope: CardScope) -> [String: JSONValue] {
  if scope == .full { return data }
  var d = data
  let idle = data["category"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "idle"
  let label = idle ? "Idle" : OUT_OF_SCOPE_LABEL
  d["title"] = .string(label)
  d["summary"] = .string("")
  d["detailedSummary"] = .string("")
  d["category"] = .string(label)
  d["subcategory"] = .string("")
  // The private flag stays (always a boolean), so the server's private field stays accurate.
  let isPrivate = d["metadata"]?.objectValue?["private"]?.boolValue == true
  d["metadata"] = .object(["distractions": .array([]), "appSites": .null, "private": .bool(isPrivate)])
  return d
}

func samePolicy(_ a: SyncPolicy, _ b: SyncPolicy) -> Bool {
  a.outOfScope == b.outOfScope && a.observations == b.observations
    && a.excludedCategories.map { $0.lowercased() }.sorted().joined(separator: "\n")
      == b.excludedCategories.map { $0.lowercased() }.sorted().joined(separator: "\n")
}
