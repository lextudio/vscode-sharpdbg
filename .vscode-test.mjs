import { defineConfig } from '@vscode/test-cli';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  files: 'test/**/*.test.js',
  extensionDevelopmentPath: __dirname,
  workspaceFolder: path.join(__dirname, 'test/fixtures/workspace'),
  mocha: {
    timeout: 120000
  }
});
