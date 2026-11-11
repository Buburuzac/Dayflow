// swift-tools-version:5.9
//
// SyncCoreHarness — builds and tests the platform-neutral Dayflow Sync core
// (Dayflow/Dayflow/Core/Sync/*.swift, without the *Mac.swift glue) outside Xcode, on macOS or Linux.
//
//   cd Dayflow/SyncCoreHarness
//   ./link-core.sh          # (re)creates Sources/DayflowSyncCore/*.swift symlinks to the app's files
//   swift build && swift test
//
// End-to-end tests against a real Dayflow Sync Server (DEV_AUTH=1) run when
// DAYFLOW_SYNC_E2E_URL is set, e.g. DAYFLOW_SYNC_E2E_URL=http://127.0.0.1:18790 swift test.
//
// Linux: needs libsqlite3-dev. Ubuntu's SQLite is built without SQLITE_ENABLE_SNAPSHOT, which GRDB
// links against; SQLiteSnapshotShim provides inert stubs (the sync core never uses snapshots).
//
// GRDB is pinned to the revision in Dayflow.xcodeproj's Package.resolved, so the API matches the app.

import PackageDescription

let package = Package(
  name: "SyncCoreHarness",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DayflowSyncCore", targets: ["DayflowSyncCore"])
  ],
  dependencies: [
    .package(url: "https://github.com/groue/GRDB.swift", revision: "0aaa2a4f3774c3e0541adfa07465e4220f72d1c2")
  ],
  targets: [
    .target(name: "SQLiteSnapshotShim", path: "Sources/SQLiteSnapshotShim"),
    .target(
      name: "DayflowSyncCore",
      dependencies: [
        .product(name: "GRDB", package: "GRDB.swift"),
        .target(name: "SQLiteSnapshotShim", condition: .when(platforms: [.linux])),
      ],
      path: "Sources/DayflowSyncCore"
    ),
    .testTarget(
      name: "DayflowSyncCoreTests",
      dependencies: [
        "DayflowSyncCore",
        .product(name: "GRDB", package: "GRDB.swift"),
      ],
      path: "Tests/DayflowSyncCoreTests"
    ),
  ]
)
