'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const packagePath = path.join(repoRoot, 'package.json');

function main() {
  ensureToolRestore();

  const result = spawnSync('dotnet', ['tool', 'run', 'dotnet-gitversion', '/showvariable', 'SemVer'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    console.error('dotnet-gitversion failed with exit code', result.status);
    if (result.stdout) console.error('stdout:', result.stdout);
    if (result.stderr) console.error('stderr:', result.stderr);
    process.exit(result.status || 1);
  }

  const semVer = (result.stdout || '').trim();
  if (!semVer) {
    throw new Error('GitVersion did not return a SemVer value.');
  }

  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (packageJson.version === semVer) {
    return;
  }

  packageJson.version = semVer;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  process.stdout.write(`Updated package.json version to ${semVer}\n`);
}

function ensureToolRestore() {
  const result = spawnSync('dotnet', ['tool', 'restore', '--verbosity', 'quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    console.error('dotnet tool restore failed with exit code', result.status);
    process.exit(result.status || 1);
  }
}

main();
