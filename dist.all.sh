#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

npm run sync-version
npm run build:extension
npm run build:sharpdbg

version="$(node -p "require('./package.json').version")"
vsix_name="$(node -p "require('./package.json').name")-${version}.vsix"

npx --yes @vscode/vsce package --no-dependencies --out "$vsix_name"

echo "Created $vsix_name"
