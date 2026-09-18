#!/usr/bin/env bash
# Create the source-built Chrome Web Store archive; publishing remains manual.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$here/package-store.ts" "$@"
