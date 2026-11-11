//
//  Pure helpers of the Sync & team UI (Dayflow/Dayflow/Views/UI/Sync/SyncUIHelpers.swift):
//  formatting, 0.25 h rounding, day math, token lists, "never upload" categories, timesheet lines.
//

import XCTest

@testable import DayflowSyncCore

final class SyncUIHelpersTests: XCTestCase {
  var cal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "Europe/Warsaw") ?? TimeZone(secondsFromGMT: 3600)!
    return c
  }()

  func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12, _ min: Int = 0) -> Date {
    cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
  }

  func testAgo() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let ms = now.timeIntervalSince1970 * 1000
    XCTAssertEqual(syncAgo(ms: nil as Double?, now: now), "never")
    XCTAssertEqual(syncAgo(ms: 0 as Double?, now: now), "never")
    XCTAssertEqual(syncAgo(ms: ms - 3000, now: now), "just now")
    XCTAssertEqual(syncAgo(ms: ms - 42_000, now: now), "42 s ago")
    XCTAssertEqual(syncAgo(ms: ms - 5 * 60_000, now: now), "5 min ago")
    XCTAssertEqual(syncAgo(ms: ms - 3 * 3_600_000, now: now), "3 h ago")
    XCTAssertEqual(syncAgo(ms: Int64(ms - 90_000), now: now), "2 min ago")
    XCTAssertFalse(syncAgo(ms: ms - 3 * 86_400_000, now: now).contains("ago"))
  }

  func testHoursMinutes() {
    XCTAssertEqual(syncHoursMinutes(0), "0m")
    XCTAssertEqual(syncHoursMinutes(45), "45m")
    XCTAssertEqual(syncHoursMinutes(125), "2h 05m")
    XCTAssertEqual(syncHoursMinutes(119.6), "2h 00m")
    XCTAssertEqual(syncHoursMinutes(-5), "0m")
    XCTAssertEqual(syncHoursMinutes(.nan), "0m")
  }

  func testQuarterHours() {
    XCTAssertEqual(roundToQuarterHour(1.1), 1.0)
    XCTAssertEqual(roundToQuarterHour(1.13), 1.25)
    XCTAssertEqual(roundToQuarterHour(-2), 0)
    XCTAssertEqual(roundToQuarterHour(30), 24)
    XCTAssertEqual(roundToQuarterHour(.infinity), 0)
    XCTAssertEqual(syncHoursLabel(1.25), "1.25 h")
    XCTAssertEqual(syncHoursLabel(2), "2.00 h")
    XCTAssertEqual(syncHoursLabel(0.5), "0.50 h")
    XCTAssertEqual(syncHoursLabel(7.999), "8.00 h")
  }

  func testDays() {
    XCTAssertEqual(syncDayString(date(2026, 3, 7), calendar: cal), "2026-03-07")
    XCTAssertEqual(syncCurrentDay(date(2026, 11, 11, 3, 59), calendar: cal), "2026-11-10")
    XCTAssertEqual(syncCurrentDay(date(2026, 11, 11, 4, 0), calendar: cal), "2026-11-11")
    XCTAssertEqual(syncShiftDay("2026-03-01", by: -1, calendar: cal), "2026-02-28")
    XCTAssertEqual(syncShiftDay("2026-12-31", by: 1, calendar: cal), "2027-01-01")
    XCTAssertEqual(syncShiftDay("bogus", by: 1, calendar: cal), "bogus")
    XCTAssertNil(syncDate(fromDay: "2026-02-31", calendar: cal))
    XCTAssertNil(syncDate(fromDay: "2026-2-3", calendar: cal))
    XCTAssertNotNil(syncDate(fromDay: "2026-02-28", calendar: cal))
    // 2026-11-11 is a Wednesday; 2026-11-15 a Sunday; 2026-11-09 the Monday.
    XCTAssertEqual(syncWeekStart("2026-11-11", calendar: cal), "2026-11-09")
    XCTAssertEqual(syncWeekStart("2026-11-15", calendar: cal), "2026-11-09")
    XCTAssertEqual(syncWeekStart("2026-11-09", calendar: cal), "2026-11-09")
    // Across the DST change (Europe/Warsaw, 2026-03-29).
    XCTAssertEqual(syncWeekStart("2026-03-29", calendar: cal), "2026-03-23")
    XCTAssertEqual(syncShiftDay("2026-03-28", by: 2, calendar: cal), "2026-03-30")
  }

  func testTokens() {
    XCTAssertEqual(parseTokenList(" Code, idea64 ;EXCEL\n\n,code ,"), ["Code", "idea64", "EXCEL"])
    XCTAssertEqual(parseTokenList(""), [])
    XCTAssertEqual(addTokens(["github.com"], from: "GitHub.com, erp.velesagro.pl"), ["github.com", "erp.velesagro.pl"])
    XCTAssertEqual(parseOdooId(" 12a3 "), 123)
    XCTAssertNil(parseOdooId(""))
    XCTAssertNil(parseOdooId("0"))
    XCTAssertNil(parseOdooId("99999999999999999999999"))
    XCTAssertNil(optionalText("   "))
    XCTAssertEqual(optionalText(" Biosun "), "Biosun")
  }

  func testExcludedCategories() {
    let cats = ["Work", "Personal", "Distraction"]
    XCTAssertTrue(isCategoryExcluded(" personal", in: ["Personal"]))
    XCTAssertEqual(toggledExclusions(["Personal"], categoryNames: cats, name: "Distraction", on: true), ["Personal", "Distraction"])
    XCTAssertEqual(toggledExclusions(["personal"], categoryNames: cats, name: "Personal", on: false), [])
    // A name that is only on another device stays excluded.
    XCTAssertEqual(toggledExclusions(["Family", "Personal"], categoryNames: cats, name: "Work", on: true), ["Family", "Work", "Personal"])

    // The new name is added and the old one kept (existing cards still carry it).
    XCTAssertEqual(
      renamedExclusions(["Personal", "Gaming"], from: "personal", to: "Private life"), ["Personal", "Gaming", "Private life"])
    XCTAssertNil(renamedExclusions(["Personal"], from: "Work", to: "Job"))
    XCTAssertNil(renamedExclusions(["Personal"], from: "Personal", to: "Personal"))
    XCTAssertNil(renamedExclusions(["Personal"], from: "Personal", to: "  "))
    // Renaming onto another excluded name does not duplicate it.
    XCTAssertNil(renamedExclusions(["Personal", "Gaming"], from: "Gaming", to: "personal"))

    // Unticking a renamed category removes its earlier names too; other unknown names stay.
    let aliases = ["private life": ["Personal"]]
    XCTAssertEqual(
      toggledExclusions(
        ["Personal", "Family", "Private life"], categoryNames: ["Work", "Private life"], name: "Private life", on: false,
        aliases: aliases), ["Family"])
    XCTAssertEqual(
      toggledExclusions(
        ["Personal", "Family", "Private life"], categoryNames: ["Work", "Private life"], name: "Work", on: true,
        aliases: aliases), ["Personal", "Family", "Work", "Private life"])
  }

  func testOutOfScopeColorAndProjectFilter() {
    XCTAssertEqual(syncFixedCategoryColorHex("Out of scope"), OUT_OF_SCOPE_COLOR_HEX)
    XCTAssertEqual(syncFixedCategoryColorHex(" out of SCOPE "), OUT_OF_SCOPE_COLOR_HEX)
    XCTAssertNil(syncFixedCategoryColorHex("Work"))

    XCTAssertTrue(projectFilterMatches(.all, projectIds: []))
    XCTAssertTrue(projectFilterMatches(.unassigned, projectIds: []))
    XCTAssertFalse(projectFilterMatches(.unassigned, projectIds: ["p1"]))
    XCTAssertTrue(projectFilterMatches(.project("p1"), projectIds: ["p2", "p1"]))
    XCTAssertFalse(projectFilterMatches(.project("p1"), projectIds: []))
  }

  func entry(_ card: String, _ start: Double, day: String? = nil) -> ProjectEntry {
    ProjectEntry(
      cardId: card, projectId: "p", userId: "u", userName: "Max", startTs: start, endTs: start + 600, minutes: 10,
      shareLevel: .time, title: nil, summary: nil, detailed: nil, day: day, category: nil, distractions: nil)
  }

  func testFeedGrouping() {
    let d1 = date(2026, 11, 10, 9).timeIntervalSince1970
    let d2 = date(2026, 11, 11, 9).timeIntervalSince1970
    let groups = groupFeedByDay([entry("a", d1), entry("b", d2), entry("c", d1 + 900), entry("d", d2, day: "2026-11-10")], calendar: cal)
    XCTAssertEqual(groups.map { $0.day }, ["2026-11-10", "2026-11-11"])
    XCTAssertEqual(groups[0].entries.map { $0.cardId }, ["a", "c", "d"])
    XCTAssertEqual(syncFraction(30, of: 120), 0.25)
    XCTAssertEqual(syncFraction(30, of: 0), 0)
    XCTAssertEqual(syncFraction(300, of: 120), 1)
  }

  func proposal(_ day: String, _ project: String, _ hours: Double, task: Int? = nil) -> TimesheetProposal {
    TimesheetProposal(
      userId: "u", day: day, projectId: project, odooProjectId: 7, odooTaskId: task, hours: hours,
      description: " Import fixes ", cardIds: ["c1", "c2"], existingOdooLineId: nil, minutes: hours * 60, projectName: nil)
  }

  func testTimesheetLines() {
    var drafts = timesheetDraftLines([proposal("2026-11-10", "p1", 1.25), proposal("2026-11-10", "p2", 0), proposal("2026-11-11", "p1", 2)])
    XCTAssertEqual(drafts.map { $0.include }, [true, false, true])
    XCTAssertEqual(Set(drafts.map { $0.id }).count, 3)
    drafts[2].hours = 1.6
    drafts[1].include = true  // still 0 h: not sent
    let chosen = timesheetChosen(drafts).map { $0.line }
    XCTAssertEqual(chosen.map { $0.projectId + "@" + $0.day }, ["p1@2026-11-10", "p1@2026-11-11"])
    XCTAssertEqual(chosen.map { $0.hours }, [1.25, 1.5])
    XCTAssertEqual(chosen[0].description, "Import fixes")
    XCTAssertEqual(chosen[0].cardIds, ["c1", "c2"])
    XCTAssertEqual(timesheetTotalHours(chosen), 2.75)

    let result = TimesheetSubmitResult(
      sent: [TimesheetSent(day: "2026-11-10", projectId: "p1", odooLineId: 41, updated: true)],
      failed: [TimesheetFailed(day: "2026-11-11", projectId: "p1", error: "No employee")])
    XCTAssertEqual(timesheetOutcome(day: "2026-11-10", projectId: "p1", in: result), .written(odooLineId: 41, updated: true))
    XCTAssertEqual(timesheetOutcome(day: "2026-11-11", projectId: "p1", in: result), .failed("No employee"))
    XCTAssertEqual(timesheetOutcome(day: "2026-11-12", projectId: "p1", in: result), .unknown)
    XCTAssertEqual(timesheetResultSummary(result), "1 line written to Odoo (1 updated). 1 failed.")

    XCTAssertEqual(odooMappingLabel(OdooMapping(projectId: 12, taskId: 340, projectName: "Biosun", taskName: nil)), "Biosun / #340")
    XCTAssertEqual(odooMappingLabel(OdooMapping(projectId: 12)), "#12")
    XCTAssertNil(odooMappingLabel(OdooMapping(taskId: 3)))
  }

  func testTeamReportMonthStartAndMemberDayGrid() {
    XCTAssertEqual(syncMonthStart("2026-11-11"), "2026-11-01")
    XCTAssertEqual(syncMonthStart("bad"), "bad")
    let r = ProjectReport(
      projectId: "p", from: "2026-11-01", to: "2026-11-11", totalMinutes: 300,
      byMember: [ReportMemberMinutes(userId: "b", userName: "Bob", minutes: 200), ReportMemberMinutes(userId: "a", userName: "Ann", minutes: 100)],
      byDay: [],
      byMemberDay: [
        ReportMemberDayMinutes(userId: "a", day: "2026-11-03", minutes: 100),
        ReportMemberDayMinutes(userId: "b", day: "2026-11-02", minutes: 120),
        ReportMemberDayMinutes(userId: "b", day: "2026-11-03", minutes: 80),
        ReportMemberDayMinutes(userId: "c", day: "2026-11-04", minutes: 5),
      ],
      byCategory: nil)
    let g = teamMemberDayGrid(r)
    XCTAssertEqual(g.days, ["2026-11-02", "2026-11-03", "2026-11-04"])
    XCTAssertEqual(g.rows.map { $0.userName }, ["Bob", "Ann", "c"])
    XCTAssertEqual(g.rows[0].minutes, [120, 80, 0])
    XCTAssertEqual(g.rows[1].minutes, [0, 100, 0])
    XCTAssertEqual(g.rows[1].total, 100)
  }
}
