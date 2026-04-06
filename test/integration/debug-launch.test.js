const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { suite, test } = require('mocha');
const vscode = require('vscode');

function waitForDebugSession(type) {
  return new Promise((resolve, reject) => {
    const existing = vscode.debug.activeDebugSession;
    if (existing && existing.type === type) {
      resolve(existing);
      return;
    }

    const disposable = vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === type) {
        disposable.dispose();
        resolve(session);
      }
    });

    setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for ${type} debug session`));
    }, 60000);
  });
}

function waitForSessionTermination(session) {
  return new Promise((resolve) => {
    const disposable = vscode.debug.onDidTerminateDebugSession((terminatedSession) => {
      if (terminatedSession.id === session.id) {
        disposable.dispose();
        resolve();
      }
    });
  });
}

async function configureSharpDbgForFixture() {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const dotnetExecutable = cp.execFileSync(lookupCommand, ['dotnet'], { encoding: 'utf8' })
    .split(/\r?\n/)[0]
    .trim();
  const cliDll = path.resolve(__dirname, '..', '..', 'dist', 'sharpdbg', 'SharpDbg.Cli.dll');
  assert.ok(fs.existsSync(cliDll), `SharpDbg CLI should exist at ${cliDll}`);

  await vscode.workspace.getConfiguration('sharpdbg').update('adapterExecutable', dotnetExecutable, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('sharpdbg').update('adapterArgs', [cliDll, '--interpreter=vscode'], vscode.ConfigurationTarget.Workspace);
}

async function launchFixtureApp(config) {
  const extension = vscode.extensions.getExtension('lextudio.vscode-sharpdbg');
  assert.ok(extension, 'extension should be present');
  await extension.activate();

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(workspaceFolder, 'workspace folder should be available');

  const workspaceSettingsDir = path.join(workspaceFolder.uri.fsPath, '.vscode');

  try {
    await configureSharpDbgForFixture();

    const started = await vscode.debug.startDebugging(workspaceFolder, config);
    assert.strictEqual(started, true, 'debug session should start');

    const session = await waitForDebugSession('sharpdbg');
    assert.strictEqual(session.type, 'sharpdbg');

    await vscode.debug.stopDebugging(session);
    await waitForSessionTermination(session);
  } finally {
    fs.rmSync(workspaceSettingsDir, { recursive: true, force: true });
  }
}

suite('SharpDbg integration', () => {
  test('launches the fixture app from program and responds to DAP requests', async function () {
    this.timeout(120000);

    const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'DebuggeeApp');
    const program = path.join(fixtureDir, 'bin', 'Debug', 'net10.0', 'DebuggeeApp.dll');
    assert.ok(fs.existsSync(program), `fixture build output should exist at ${program}`);

    await launchFixtureApp({
      type: 'sharpdbg',
      request: 'launch',
      name: 'SharpDbg integration launch from program',
      program,
      cwd: fixtureDir,
      stopAtEntry: false
    });
  });

  test('launches the fixture app from projectPath and responds to DAP requests', async function () {
    this.timeout(120000);

    const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'DebuggeeApp');
    const projectPath = path.join(fixtureDir, 'DebuggeeApp.csproj');
    assert.ok(fs.existsSync(projectPath), `fixture project should exist at ${projectPath}`);

    await launchFixtureApp({
      type: 'sharpdbg',
      request: 'launch',
      name: 'SharpDbg integration launch from projectPath',
      projectPath,
      stopAtEntry: false
    });
  });
});
