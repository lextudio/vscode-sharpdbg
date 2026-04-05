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

suite('SharpDbg integration', () => {
  test('launches the fixture app and responds to DAP requests', async function () {
    this.timeout(120000);

    const extension = vscode.extensions.getExtension('lextudio.vscode-sharpdbg');
    assert.ok(extension, 'extension should be present');
    await extension.activate();

    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    assert.ok(workspaceFolder, 'workspace folder should be available');

    const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'DebuggeeApp');
    const program = path.join(fixtureDir, 'bin', 'Debug', 'net10.0', 'DebuggeeApp.dll');
    assert.ok(fs.existsSync(program), `fixture build output should exist at ${program}`);

    const dotnetExecutable = cp.execFileSync('which', ['dotnet'], { encoding: 'utf8' }).trim();
    const cliDll = path.resolve(__dirname, '..', '..', 'dist', 'sharpdbg', 'SharpDbg.Cli.dll');
    assert.ok(fs.existsSync(cliDll), `SharpDbg CLI should exist at ${cliDll}`);

    const workspaceSettingsDir = path.join(workspaceFolder.uri.fsPath, '.vscode');

    try {
      await vscode.workspace.getConfiguration('sharpdbg').update('adapterExecutable', dotnetExecutable, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('sharpdbg').update('adapterArgs', [cliDll, '--interpreter=vscode'], vscode.ConfigurationTarget.Workspace);

      const started = await vscode.debug.startDebugging(workspaceFolder, {
        type: 'sharpdbg',
        request: 'launch',
        name: 'SharpDbg integration launch',
        program,
        cwd: fixtureDir,
        stopAtEntry: false
      });

      assert.strictEqual(started, true, 'debug session should start');

      const session = await waitForDebugSession('sharpdbg');
      assert.strictEqual(session.type, 'sharpdbg');

      await vscode.debug.stopDebugging(session);
      await waitForSessionTermination(session);
    } finally {
      fs.rmSync(workspaceSettingsDir, { recursive: true, force: true });
    }
  });
});
