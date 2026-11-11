//
//  SyncAssign.swift
//  Dayflow — Dayflow Sync client core
//
//  Project assignment for new cards (port of windows/src/main/sync/assign.ts,
//  sync-server-design.md "Projects and assignment"):
//    1. manual (carried over from the card a rewritten card replaces) — kept as is;
//    2. rules: project.rules matched against the card's window labels, appSites, title/summary;
//    3. LLM: the model's "projects" output, confirmed when confidence ≥ 0.8.
//
//  LLM guesses are not produced by the Mac card prompts yet. To add them, list
//  `projectsForPrompt` in the card-generation prompts (Core/AI/*Provider+Prompts.swift and
//  LLMService's ActivityGenerationContext), parse a per-card `"projects": [{ name, share,
//  confidence }]`, and pass the guesses to `assignProjects(..., llmGuesses:)`.
//

import Foundation
import GRDB

let LLM_CONFIRM_THRESHOLD = 0.8

struct RuleInput {
  /// Foreground window labels of the card's frames: "app — window title"
  var labels: [String]
  var appSitesPrimary: String?
  var appSitesSecondary: String?
  var title: String
  var summary: String
}

struct RuleMatch: Equatable {
  var projectId: String
  var share: Double
}

/// A model's project guess for one card.
struct LlmProjectGuess: Equatable, Sendable {
  var name: String
  var share: Double
  var confidence: Double
}

private func norm(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

private func splitLabel(_ label: String) -> (process: String, title: String) {
  guard let r = label.range(of: " — ") else { return (label, "") }
  return (String(label[..<r.lowerBound]), String(label[r.upperBound...]))
}

private func stripExe(_ s: String) -> String { s.hasSuffix(".exe") ? String(s.dropLast(4)) : s }

private func processMatches(_ process: String, _ app: String) -> Bool {
  let p = stripExe(norm(process))
  let a = stripExe(norm(app))
  return !a.isEmpty && p == a
}

/// `(^|[^a-z0-9-])(?:[a-z0-9-]+\.)*<domain>($|[^a-z0-9-])` on lowercased text, as on Windows.
private func domainMatches(_ text: String, _ domain: String) -> Bool {
  var d = norm(domain)
  for prefix in ["https://", "http://"] where d.hasPrefix(prefix) {
    d = String(d.dropFirst(prefix.count))
    break
  }
  if d.hasPrefix("www.") { d = String(d.dropFirst(4)) }
  while d.hasSuffix("/") { d = String(d.dropLast()) }
  if d.isEmpty { return false }
  let t = norm(text)
  if t == d || t.hasSuffix("." + d) { return true }
  // Inside a window title or free text: the domain as a whole token.
  let pattern = "(^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*" + NSRegularExpression.escapedPattern(for: d) + "($|[^a-z0-9-])"
  guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
  return re.firstMatch(in: t, range: NSRange(t.startIndex..<t.endIndex, in: t)) != nil
}

private func includesWord(_ text: String, _ keyword: String) -> Bool {
  let k = norm(keyword)
  return !k.isEmpty && norm(text).contains(k)
}

private func hasRules(_ r: ProjectRules) -> Bool {
  [r.apps, r.domains, r.titleKeywords, r.repos].contains { l in
    (l ?? []).contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }
}

/// "github.com/acme/dayflow" / "acme/dayflow" / "dayflow" → "dayflow"
private func repoName(_ repo: String) -> String {
  var r = repo.trimmingCharacters(in: .whitespacesAndNewlines)
  if r.hasSuffix(".git") { r = String(r.dropLast(4)) }
  let parts = r.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init).filter { !$0.isEmpty }
  return parts.last ?? ""
}

/// Does one window label satisfy a project's rules?
private func labelMatches(_ label: String, _ rules: ProjectRules) -> Bool {
  let (process, title) = splitLabel(label)
  if (rules.apps ?? []).contains(where: { processMatches(process, $0) }) { return true }
  if (rules.domains ?? []).contains(where: { domainMatches(title, $0) }) { return true }
  if (rules.titleKeywords ?? []).contains(where: { includesWord(title, $0) }) { return true }
  if (rules.repos ?? []).contains(where: { includesWord(title, repoName($0)) }) { return true }
  return false
}

private func textMatches(_ input: RuleInput, _ rules: ProjectRules) -> Bool {
  let sites = [input.appSitesPrimary, input.appSitesSecondary].compactMap { $0 }.filter { !$0.isEmpty }
  if (rules.domains ?? []).contains(where: { d in sites.contains { domainMatches($0, d) } }) { return true }
  let text = "\(input.title)\n\(input.summary)"
  if (rules.titleKeywords ?? []).contains(where: { includesWord(text, $0) }) { return true }
  if (rules.repos ?? []).contains(where: { includesWord(text, repoName($0)) }) { return true }
  return false
}

/// Projects whose rules match the card. The share of a project is the fraction of frames whose
/// window matched (or 1 when only title/summary/appSites matched); shares are scaled to sum ≤ 1.
func matchRules(_ projects: [(id: String, rules: ProjectRules, archived: Bool)], _ input: RuleInput) -> [RuleMatch] {
  var out: [RuleMatch] = []
  for p in projects {
    if p.archived || !hasRules(p.rules) { continue }
    let frames = input.labels.filter { labelMatches($0, p.rules) }.count
    var share = input.labels.isEmpty ? 0 : Double(frames) / Double(input.labels.count)
    if textMatches(input, p.rules) { share = max(share, 1) }
    if share > 0 { out.append(RuleMatch(projectId: p.id, share: share)) }
  }
  let total = out.reduce(0) { $0 + $1.share }
  if total > 1 { for i in out.indices { out[i].share = out[i].share / total } }
  for i in out.indices { out[i].share = round3(out[i].share) }
  // Stable sort by share, descending (Array.sort in JS is stable).
  return out.enumerated().sorted { a, b in
    a.element.share != b.element.share ? a.element.share > b.element.share : a.offset < b.offset
  }.map { $0.element }
}

/// LLM guesses → assignments to known projects (matched by name, case-insensitively).
func llmAssignments(_ projects: [(id: String, name: String, archived: Bool)], _ guesses: [LlmProjectGuess]?)
  -> [AssignmentInput]
{
  guard let guesses, !guesses.isEmpty else { return [] }
  var byName: [String: String] = [:]
  // `new Map(entries)` keeps the last entry of a duplicated key.
  for p in projects where !p.archived { byName[norm(p.name)] = p.id }
  var seen = Set<String>()
  var out: [AssignmentInput] = []
  for g in guesses {
    guard let id = byName[norm(g.name)], !seen.contains(id) else { continue }
    seen.insert(id)
    out.append(
      AssignmentInput(
        projectId: id, share: g.share, source: .llm, confidence: g.confidence,
        confirmed: g.confidence >= LLM_CONFIRM_THRESHOLD))
  }
  return out
}

/// Assigns projects to the cards the analysis just wrote (rules first, then LLM guesses).
func assignProjects(
  _ db: Database, local: SyncLocal, labels: WindowLabelSource?, cards: [InsertedCardRef],
  llmGuesses: [String: [LlmProjectGuess]] = [:]
) throws {
  let repo = SyncRepo(local: local)
  let projects = try repo.projects(db)
  if projects.isEmpty { return }
  for c in cards {
    if c.inheritedManual { continue }
    guard
      let r = try Row.fetchOne(
        db,
        sql: "SELECT start_ts, end_ts, title, summary, metadata FROM timeline_cards WHERE uuid = ? AND is_deleted = 0",
        arguments: [c.uuid])
    else { continue }
    let start: Int64 = r["start_ts"] ?? 0
    let end: Int64 = r["end_ts"] ?? 0
    let sites = parseJSONObject(r["metadata"])["appSites"]
    let input = RuleInput(
      labels: labels?.windowLabels(db, startTs: start, endTs: end) ?? [],
      appSitesPrimary: sites?["primary"]?.stringValue, appSitesSecondary: sites?["secondary"]?.stringValue,
      title: r["title"] ?? "", summary: r["summary"] ?? "")
    let rules = matchRules(projects.map { ($0.id, $0.rules, $0.archived) }, input)
    if !rules.isEmpty {
      try repo.setAssignments(
        db, cardUuid: c.uuid,
        rules.map { AssignmentInput(projectId: $0.projectId, share: $0.share, source: .rule, confidence: 1, confirmed: true) })
      continue
    }
    let llm = llmAssignments(projects.map { ($0.id, $0.name, $0.archived) }, llmGuesses[c.uuid])
    if !llm.isEmpty { try repo.setAssignments(db, cardUuid: c.uuid, llm) }
  }
}

/// Project list for a card-generation prompt.
func projectsForPrompt(_ db: Database, local: SyncLocal) throws -> [(name: String, description: String)] {
  try SyncRepo(local: local).projects(db).map { ($0.name, $0.description) }
}
