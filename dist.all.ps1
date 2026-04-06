$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

npm run sync-version

$version = node -p "require('./package.json').version"
$name = node -p "require('./package.json').name"
$vsixName = "$name-$version.vsix"

npx --yes @vscode/vsce package --out $vsixName

Write-Host "Created $vsixName"
