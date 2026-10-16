#!/bin/bash
# Runs sync.sh against a scratch folder: first run must copy all 8 PDFs,
# second run must change nothing, a corrupted copy must be replaced.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }
out=$(DEST="$d" "$here/sync.sh")
check "first run copies 8" '[ "$(echo "$out" | grep -c updated)" = 8 ]'
check "all are PDFs" '[ "$(for f in "$d"/*.pdf; do head -c 5 "$f"; echo; done | grep -c %PDF-)" = 8 ]'
out=$(DEST="$d" "$here/sync.sh")
check "second run is a no-op" '[ -z "$out" ]'
echo junk > "$d/bop-Aero-SF50-Expo-1-Pager.pdf"
out=$(DEST="$d" "$here/sync.sh")
check "changed file replaced" '[ "$out" != "${out%updated bop-Aero-SF50-Expo-1-Pager.pdf}" ]'
check "no temp files left" '[ -z "$(ls -A "$d" | grep part || true)" ]'
out=$(DEST="$d/missing" "$here/sync.sh" 2>&1) && r=0 || r=$?
check "missing destination fails" '[ $r = 1 ]'
echo "icloud-sync: $pass passed, $fail failed"; [ $fail = 0 ]
