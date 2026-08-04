#!/usr/bin/env bash
set -euo pipefail

# Build a clean extension zip for Chrome Web Store / Firefox Add-ons submission.
# Usage:
#   ./scripts/build-zip.sh           # produces dist/extension.zip
#   VERSION=1.2.3 ./scripts/build-zip.sh  # patches manifest version first

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

# If VERSION is set, patch manifest.json before zipping
if [ -n "${VERSION:-}" ]; then
  # Strip leading "v" if present (e.g. v1.2.0 -> 1.2.0)
  VERSION="${VERSION#v}"
  echo "Setting manifest version to $VERSION"
  # Use node for portable JSON editing
  node -e "
    const fs = require('fs');
    const path = '$ROOT/manifest.json';
    const m = JSON.parse(fs.readFileSync(path, 'utf8'));
    m.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
  "
fi

rm -rf "$DIST"
mkdir -p "$DIST"

cd "$ROOT"

EXTENSION_FILES=(
  manifest.json
  background.js
  content.js
  content.css
  popup.html
  popup.js
  popup.css
  options.html
  options.js
  options.css
  lib/host.js
  lib/storage.js
  lib/notes.js
  lib/purify.min.js
  lib/marked.min.js
  icons/icon-16.png
  icons/icon-48.png
  icons/icon-128.png
)

zip -r9 "$DIST/extension.zip" "${EXTENSION_FILES[@]}"

echo "Built $DIST/extension.zip"
ls -lh "$DIST/extension.zip"

# Verify every declared file made it into the zip. The list is explicit (not a
# glob), so a forgotten entry is a silent broken build otherwise.
echo "Verifying zip contents..."
ZIP_LIST="$(unzip -l "$DIST/extension.zip" | awk 'NR>3 {print $NF}')"
MISSING=()
for f in "${EXTENSION_FILES[@]}"; do
  if ! printf '%s\n' "$ZIP_LIST" | grep -qxF "$f"; then
    MISSING+=("$f")
  fi
done

if [ "${#MISSING[@]}" -ne 0 ]; then
  echo "ERROR: the following declared EXTENSION_FILES are missing from $DIST/extension.zip:" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  exit 1
fi

echo "All ${#EXTENSION_FILES[@]} declared files present in zip."
