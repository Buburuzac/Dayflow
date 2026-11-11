#!/bin/sh
# Copies the sync core + harness to megaserv and runs `swift build` / `swift test` in a throwaway
# swift:6.1-noble container (scratch dir /home/jkl/dayflow-swift-ci, cache volume dayflow-swift-ci-cache;
# remove both when done). Usage: megaserv-test.sh [build|test] [ENV=value ...]
#   TEST_FILTER=SyncScopeTests megaserv-test.sh test
#   megaserv-test.sh test DAYFLOW_SYNC_E2E_URL=http://127.0.0.1:18790     (e2e stack on megaserv)
set -eu
mode=${1:-build}
shift || true
cd "$(dirname "$0")/../../.."
tar -cf - Dayflow/Dayflow/Core/Sync Dayflow/Dayflow/Views/UI/Sync/SyncUIHelpers.swift Dayflow/SyncCoreHarness/Package.swift Dayflow/SyncCoreHarness/link-core.sh \
  Dayflow/SyncCoreHarness/Sources/DayflowSyncCore/HarnessShims.swift Dayflow/SyncCoreHarness/Sources/SQLiteSnapshotShim \
  Dayflow/SyncCoreHarness/Tests |
  ssh -o BatchMode=yes -p 60022 jkl@192.168.0.90 'rm -rf /home/jkl/dayflow-swift-ci/repo && mkdir -p /home/jkl/dayflow-swift-ci/repo && tar -xf - -C /home/jkl/dayflow-swift-ci/repo && sh /home/jkl/dayflow-swift-ci/repo/Dayflow/SyncCoreHarness/link-core.sh >/dev/null'
envs=""
for e in "$@"; do envs="$envs -e $e"; done
if [ "$mode" = test ]; then cmd="timeout ${TEST_TIMEOUT:-300} swift test ${TEST_FILTER:+--filter $TEST_FILTER} --cache-path /cache/swiftpm --scratch-path /cache/harness-build"; else cmd="swift build --build-tests --cache-path /cache/swiftpm --scratch-path /cache/harness-build"; fi
ssh -o BatchMode=yes -p 60022 jkl@192.168.0.90 "sudo docker run --rm -t --name dayflow-swift-ci-run --network host $envs -v /home/jkl/dayflow-swift-ci/repo:/src -v dayflow-swift-ci-cache:/cache -w /src/Dayflow/SyncCoreHarness swift:6.1-noble bash -c 'if ! dpkg -s libsqlite3-dev >/dev/null 2>&1; then apt-get update -qq >/dev/null && apt-get install -y -qq libsqlite3-dev >/dev/null 2>&1; fi; $cmd 2>&1'"
