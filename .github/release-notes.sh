#!/usr/bin/env bash
# Skriver ut avsnittet för en version ur CHANGELOG.md. Avslutar med fel om det saknas.
set -euo pipefail
version="$1"
notes="$(awk -v v="$version" '
  /^## \[/ { found = (index($0, "## [" v "]") == 1); next }
  found { print }
' CHANGELOG.md)"
if [[ -z "${notes//[[:space:]]/}" ]]; then
  echo "CHANGELOG.md saknar ett avsnitt '## [$version]'" >&2
  exit 1
fi
printf '%s\n' "$notes"
