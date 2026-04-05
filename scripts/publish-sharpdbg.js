'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const projectPath = path.join(repoRoot, 'sharpdbg', 'src', 'SharpDbg.Cli', 'SharpDbg.Cli.csproj');
const outputDir = path.join(repoRoot, 'dist', 'sharpdbg');

const args = [
  'publish',
  projectPath,
  '-c',
  'Release',
  '-f',
  'net10.0',
  '-o',
  outputDir,
  '--self-contained',
  'false',
  '-p:UseAppHost=false'
];

const result = spawnSync('dotnet', args, {
  cwd: repoRoot,
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
