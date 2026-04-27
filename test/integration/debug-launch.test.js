const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
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

function waitUntil(predicate, timeoutMs, message) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        reject(new Error(message));
        return;
      }

      setTimeout(poll, 250);
    };

    poll();
  });
}

function getSessionLogPath(sessionId) {
  const sanitized = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `sharpdbg-${sanitized}.log`);
}

async function configureSharpDbgForFixture() {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const dotnetExecutable = cp.execFileSync(lookupCommand, ['dotnet'], { encoding: 'utf8' })
    .split(/\r?\n/)[0]
    .trim();

  const sharpdbgDir = path.resolve(__dirname, '..', '..', 'dist', 'sharpdbg');
  let cliDll = null;

  const candidates = [
    path.join(sharpdbgDir, 'SharpDbg.Cli.dll'),
    path.join(sharpdbgDir, 'net10.0', 'SharpDbg.Cli.dll'),
    path.join(sharpdbgDir, 'net48', 'SharpDbg.Cli.dll')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cliDll = candidate;
      break;
    }
  }

  assert.ok(cliDll, `SharpDbg CLI should exist at one of: ${candidates.join(', ')}`);

  await vscode.workspace.getConfiguration('sharpdbg').update('adapterExecutable', dotnetExecutable, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('sharpdbg').update('adapterArgs', [cliDll, '--interpreter=vscode'], vscode.ConfigurationTarget.Workspace);
}

async function launchFixtureApp(config) {
  const extension = vscode.extensions.getExtension('lextudio.sharpdbg');
  assert.ok(extension, 'extension should be present');
  await extension.activate();

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(workspaceFolder, 'workspace folder should be available');

  const workspaceSettingsDir = path.join(workspaceFolder.uri.fsPath, '.vscode');

  // If the debug config points at a projectPath, build it first so the
  // extension doesn't need to build/resolve it while waiting for the
  // debug session (this can exceed the session wait timeout).
  if (config && config.projectPath) {
    try {
      let projectPath = config.projectPath;
      if (!path.isAbsolute(projectPath)) {
        projectPath = path.join(workspaceFolder.uri.fsPath, projectPath);
      }

      if (fs.existsSync(projectPath)) {
        cp.execFileSync('dotnet', ['build', projectPath, '-c', 'Debug']);
      }
    } catch (err) {
      // If build fails, allow the test to continue and surface the error
    }
  }

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

  test('stops at unhandled exception and logs exception type', async function () {
    this.timeout(120000);

    const fixtureDir = path.resolve(__dirname, '..', 'fixtures', 'DebuggeeAppCrash');
    const projectPath = path.join(fixtureDir, 'DebuggeeAppCrash.csproj');
    assert.ok(fs.existsSync(projectPath), `fixture project should exist at ${projectPath}`);

    // Build the crash fixture to ensure output exists
    cp.execFileSync('dotnet', ['build', projectPath, '-c', 'Debug']);
    const program = path.join(fixtureDir, 'bin', 'Debug', 'net10.0', 'DebuggeeAppCrash.dll');
    assert.ok(fs.existsSync(program), `fixture build output should exist at ${program}`);

    const extension = vscode.extensions.getExtension('lextudio.sharpdbg');
    assert.ok(extension, 'extension should be present');
    await extension.activate();

    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    assert.ok(workspaceFolder, 'workspace folder should be available');

    // Configure the extension to use the built CLI DLL so the extension will enable engine logging.
    const sharpdbgDir = path.resolve(__dirname, '..', '..', 'dist', 'sharpdbg');
    let cliDll = null;
    const candidates = [
      path.join(sharpdbgDir, 'SharpDbg.Cli.dll'),
      path.join(sharpdbgDir, 'net10.0', 'SharpDbg.Cli.dll'),
      path.join(sharpdbgDir, 'net48', 'SharpDbg.Cli.dll')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        cliDll = candidate;
        break;
      }
    }

    assert.ok(cliDll, `SharpDbg CLI should exist at one of: ${candidates.join(', ')}`);

    await vscode.workspace.getConfiguration('sharpdbg').update('cliDllPath', cliDll, vscode.ConfigurationTarget.Workspace);

    // Register a debug adapter tracker to observe the exception stop. Exception
    // text is written to the SharpDbg engine log, which the extension tails into
    // the SharpDbg output channel.
    let stoppedDetected = false;

    let stoppedResolve;
    const stoppedPromise = new Promise((resolve) => { stoppedResolve = resolve; });

    const trackerFactory = {
      createDebugAdapterTracker: (session) => {
        return {
          onDidSendMessage: (message) => {
            try {
              if (!message || message.type !== 'event') return;

              if (message.event === 'stopped') {
                const reason = message.body && message.body.reason;
                if (reason && String(reason).toLowerCase().includes('exception')) {
                  stoppedDetected = true;
                  stoppedResolve(message);
                }
              }
            } catch (err) {
              // swallow tracker errors to not crash the adapter
            }
          }
        };
      }
    };

    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('sharpdbg', trackerFactory);

    try {
      const started = await vscode.debug.startDebugging(workspaceFolder, {
        type: 'sharpdbg',
        request: 'launch',
        name: 'Crash fixture launch',
        program,
        cwd: fixtureDir,
        stopAtEntry: false
      });

      assert.strictEqual(started, true, 'debug session should start');

      const session = await waitForDebugSession('sharpdbg');

      await Promise.race([
        stoppedPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for stopped event')), 60000))
      ]);

      assert.ok(stoppedDetected, 'debug session should stop due to exception');

      const logPath = getSessionLogPath(session.id);
      const log = await waitUntil(() => {
        if (!fs.existsSync(logPath)) {
          return undefined;
        }

        const text = fs.readFileSync(logPath, 'utf8');
        return text.includes('InvalidOperationException') &&
          text.includes('Unhandled test exception for extension testing') &&
          text.includes('Exception call stack:') &&
          text.includes('DebuggeeAppCrash.dll!Program.<Main>$()')
          ? text
          : undefined;
      }, 60000, `Timed out waiting for exception details in ${logPath}`);

      assert.match(log, /Unhandled exception: System\.InvalidOperationException: Unhandled test exception for extension testing/);
      assert.match(log, /Exception call stack:/);
      assert.match(log, /DebuggeeAppCrash\.dll!Program\.<Main>\$\(\)/);

      await vscode.debug.stopDebugging(session);
      await waitForSessionTermination(session);
    } finally {
      trackerDisposable.dispose();
      const workspaceSettingsDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
      fs.rmSync(workspaceSettingsDir, { recursive: true, force: true });
    }
  });
});
