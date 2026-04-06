'use strict';

const esbuild = require('esbuild');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(repoRoot, 'src', 'extension.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(repoRoot, 'dist', 'extension.js'),
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
}).catch(() => process.exit(1));
