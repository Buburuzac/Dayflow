#!/bin/sh
# Links the app's platform-neutral sync core (and the Sync UI's pure helpers) into the harness target (the *Mac.swift glue
# needs AppKit/Network/StorageManager and is compiled by Xcode only).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dst="$here/Sources/DayflowSyncCore"
mkdir -p "$dst"
find "$dst" -maxdepth 1 -type l -name '*.swift' -exec rm -f {} +
for f in "$here"/../Dayflow/Core/Sync/*.swift; do
  name=$(basename "$f")
  case "$name" in
    *Mac.swift) continue ;;
  esac
  ln -s "../../../Dayflow/Core/Sync/$name" "$dst/$name"
done
# Pure (Foundation-only) helpers of the Sync & team UI.
for f in "$here"/../Dayflow/Views/UI/Sync/*Helpers.swift; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  ln -s "../../../Dayflow/Views/UI/Sync/$name" "$dst/$name"
done
ls "$dst"
