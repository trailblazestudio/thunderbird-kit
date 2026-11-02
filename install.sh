#!/bin/bash
# Installs the theme into a Thunderbird profile and builds the add-ons.
# Usage: ./install.sh [path-to-profile]     (close Thunderbird first)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# The profile Thunderbird actually uses: installs.ini, else Default=1 in profiles.ini.
default_profile() {
  local base rel
  for base in "$HOME/.thunderbird" "$HOME/snap/thunderbird/common/.thunderbird" "$HOME/.var/app/org.mozilla.Thunderbird/.thunderbird"; do
    [ -d "$base" ] || continue
    rel=$(grep -m1 '^Default=' "$base/installs.ini" 2>/dev/null | cut -d= -f2- || true)
    if [ -z "$rel" ]; then
      rel=$(awk -F= '/^\[/{p=""} /^Path=/{p=$2} /^Default=1/{print p; exit}' "$base/profiles.ini" 2>/dev/null || true)
    fi
    if [ -n "$rel" ]; then
      [[ "$rel" = /* ]] && echo "$rel" || echo "$base/$rel"
      return
    fi
  done
}

PROFILE="${1:-$(default_profile)}"
if [ ! -d "$PROFILE" ]; then
  echo "No Thunderbird profile found. Pass its path: ./install.sh <profile>" >&2
  exit 1
fi
if pgrep -x thunderbird >/dev/null || pgrep -x thunderbird-bin >/dev/null; then
  echo "Please close Thunderbird first." >&2
  exit 1
fi
echo "Profile: $PROFILE"

# Theme (existing files are kept as *.bak-<timestamp>)
mkdir -p "$PROFILE/chrome"
STAMP=$(date +%Y%m%d-%H%M%S)
for f in userChrome.css userContent.css; do
  if [ -f "$PROFILE/chrome/$f" ]; then
    cp "$PROFILE/chrome/$f" "$PROFILE/chrome/$f.bak-$STAMP"
  fi
done
cp "$HERE/theme/userChrome.css" "$HERE/theme/userContent.css" "$PROFILE/chrome/"
rm -rf "$PROFILE/chrome/icons"
cp -r "$HERE/theme/icons" "$PROFILE/chrome/icons"

# Preferences
touch "$PROFILE/user.js"
if ! grep -q "thunderbird-kit" "$PROFILE/user.js"; then
  cat >> "$PROFILE/user.js" <<'PREFS'
// --- thunderbird-kit ---
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true); // load userChrome.css
user_pref("toolbar.unifiedtoolbar.buttonstyle", 2);                       // icon-only toolbar
user_pref("mail.addressDisplayFormat", 2);                                // names, not addresses
user_pref("mail.ui.display.dateformat.thisweek", 4);                      // weekday for this week
user_pref("mailnews.start_page.enabled", false);                          // no start page
PREFS
fi
echo "Theme installed."

if ! fc-list | grep -qi "Inter"; then
  echo "Note: the Inter font is missing – install it with: sudo apt install fonts-inter"
fi

"$HERE/build.sh"
echo
echo "Start Thunderbird and install the add-ons from dist/:"
echo "  Add-ons and Themes → gear icon → Install Add-on From File"
