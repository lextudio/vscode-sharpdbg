'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const projectPath = path.join(repoRoot, 'sharpdbg', 'src', 'SharpDbg.Cli', 'SharpDbg.Cli.csproj');
const outputRoot = path.join(repoRoot, 'dist', 'sharpdbg');

const publishTargets = [
  {
    framework: 'net10.0',
    outputDir: path.join(outputRoot, 'net10.0'),
    extraArgs: ['--self-contained', 'false', '-p:UseAppHost=false']
  },
  {
    framework: 'net48',
    outputDir: path.join(outputRoot, 'net48'),
    extraArgs: []
  }
];

for (const target of publishTargets) {
  const args = [
    'publish',
    projectPath,
    '-c',
    'Release',
    '-f',
    target.framework,
    '-o',
    target.outputDir,
    ...target.extraArgs
  ];

  const result = spawnSync('dotnet', args, {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
