#!/bin/bash
# Installs (or reinstalls) the launchd job that runs sync.sh every 15 minutes.
#
# macOS won't let a plain background shell read or replace files in iCloud Drive,
# so the job runs a tiny AppleScript helper app ("bop Aero iCloud Sync") that
# calls sync.sh. The app asks once for iCloud Drive access (Files & Folders),
# which is narrower than granting Full Disk Access to /bin/bash.
#
# Remove with: launchctl bootout gui/$(id -u)/com.bopaero.icloud-sync
#              rm ~/Library/LaunchAgents/com.bopaero.icloud-sync.plist
#              rm -rf ~/Library/Application\ Support/bopaero-icloud-sync
set -eu
here=$(cd "$(dirname "$0")" && pwd)
plist="$HOME/Library/LaunchAgents/com.bopaero.icloud-sync.plist"
log="$HOME/Library/Logs/bopaero-icloud-sync.log"
appdir="$HOME/Library/Application Support/bopaero-icloud-sync"
app="$appdir/bop Aero iCloud Sync.app"

mkdir -p "$appdir"
rm -rf "$app"
# try/end try: a failed sync is logged by sync.sh, never shown as a dialog
osacompile -o "$app" -e "try" \
  -e "do shell script quoted form of \"$here/sync.sh\" & \" >> \" & quoted form of \"$log\" & \" 2>&1\"" \
  -e "end try"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.bopaero.icloud-sync" "$app/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.bopaero.icloud-sync" "$app/Contents/Info.plist"
codesign --force --deep -s - "$app"

sed -e "s|__SCRIPT__|$app/Contents/MacOS/applet|" -e "s|__LOG__|$log|" "$here/com.bopaero.icloud-sync.plist" > "$plist"
launchctl bootout "gui/$(id -u)/com.bopaero.icloud-sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed. Log: $log"
