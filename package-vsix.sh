#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

if [[ ! -d node_modules ]]; then
  npm ci
fi

npm run package

version="$(node -p "require('./package.json').version")"
echo "VSIX: ${root}/cursor-sync-${version}.vsix"
