#!/bin/bash
# Copies the live, costing-generated prospect PDFs into Detail Sheets/ in the team's
# Google Shared Drive "Bop Aero" (the single source of truth since 2026-10-21; it was
# iCloud Drive before), so Raymond and the team find them where they look. Runs from launchd every 15 minutes
# (com.bopaero.icloud-sync, see install.sh). A file is replaced only when the
# live PDF differs, and only with a download that is really a PDF.
# The program sites stay the source; these copies are never edited by hand.
set -u
DEST="${DEST:-$HOME/Library/CloudStorage/GoogleDrive-raymond@bopaero.com/Shared drives/bop Aero - Team/BopAeroMediaAssets/Detail Sheets}"
SF50=https://sf50program.bopaero.com
SR22T=https://sr22tprogram.bopaero.com
PROGRAMS=https://programs.bopaero.com   # documents covering more than one program (2026-10-21)
FILES=(
  "$SF50/bop-Aero-SF50-Financial-Detail-Sheet.pdf"
  "$SF50/bop-Aero-SF50-G1-Financial-Detail-Sheet.pdf"
  "$SF50/bop-Aero-SF50-G2-Financial-Detail-Sheet.pdf"
  "$SF50/bop-Aero-SF50-G2plus-Financial-Detail-Sheet.pdf"
  "$SF50/bop-Aero-SF50-Expo-1-Pager.pdf"
  "$PROGRAMS/bop-Aero-Aircraft-Ownership-Comparison.pdf"
  "$PROGRAMS/bop-Aero-Founders-Circle-Insert.pdf"
  "$PROGRAMS/bop-Aero-Founders-Circle-Detail-Sheet.pdf"
  "$SR22T/bop-Aero-SR22T-Financial-Detail-Sheet.pdf"
  "$SR22T/bop-Aero-SR22T-Expo-1-Pager.pdf"
)
# The Letter of Intent is an agreement, so it goes to the Admin drive beside the old LOIs (2026-10-21)
ADMIN_DEST="${ADMIN_DEST:-$HOME/Library/CloudStorage/GoogleDrive-raymond@bopaero.com/Shared drives/bop Aero - Admin/1. Company & Legal/Agreements/LOIs}"
ADMIN_FILES=(
  "$PROGRAMS/bop-Aero-Letter-of-Intent.pdf"
)
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

[ -d "$DEST" ] || { log "ERROR destination missing: $DEST"; exit 1; }
[ -d "$ADMIN_DEST" ] || { log "ERROR destination missing: $ADMIN_DEST"; exit 1; }
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fail=0
for entry in "${FILES[@]/#/$DEST|}" "${ADMIN_FILES[@]/#/$ADMIN_DEST|}"; do
  dest=${entry%%|*} url=${entry#*|}
  name=${url##*/}
  if ! curl -fsS --max-time 60 -o "$tmp/$name" "$url?t=$(date +%s)"; then
    log "ERROR download failed: $name"; fail=1; continue
  fi
  if [ "$(head -c 5 "$tmp/$name")" != "%PDF-" ] || [ "$(wc -c < "$tmp/$name")" -lt 10000 ]; then
    log "ERROR not a valid PDF, kept existing copy: $name"; fail=1; continue
  fi
  if cmp -s "$tmp/$name" "$dest/$name"; then continue; fi
  if cp "$tmp/$name" "$dest/.$name.part" && mv -f "$dest/.$name.part" "$dest/$name"; then
    log "updated $name"
  else
    rm -f "$dest/.$name.part"; log "ERROR could not write: $name"; fail=1
  fi
done
exit $fail
