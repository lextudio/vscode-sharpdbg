const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, before } = require('mocha');
const vscode = require('vscode');

const TEST_LOG_PATH = path.join(os.tmpdir(), 'sharpdbg-integration-test.log');

function testLog(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(TEST_LOG_PATH, line);
  } catch (e) {
    // ignore — log file may not be writable in sandboxed environments
  }
}

before(() => {
  fs.writeFileSync(TEST_LOG_PATH, `=== Integration test run started at ${new Date().toISOString()} ===\n`);
  testLog('Test log reset');
});

function waitForDebugSession(type) {
  testLog(`waitForDebugSession: waiting for ${type}`);
  return new Promise((resolve, reject) => {
    // Always wait for a new onDidStartDebugSession event — never use
    // activeDebugSession, which may be a stale session from a prior test.
    const disposable = vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === type) {
        testLog(`waitForDebugSession: session started ${session.id}`);
        disposable.dispose();
        resolve(session);
      }
    });

    setTimeout(() => {
      testLog(`waitForDebugSession: TIMEOUT waiting for ${type}`);
      disposable.dispose();
      reject(new Error(`Timed out waiting for ${type} debug session`));
    }, 60000);
  });
}

function waitForSessionTermination(session) {
  testLog(`waitForSessionTermination: waiting for session ${session.id}`);
  return new Promise((resolve) => {
    const disposable = vscode.debug.onDidTerminateDebugSession((terminatedSession) => {
      if (terminatedSession.id === session.id) {
        testLog(`waitForSessionTermination: session ${session.id} terminated`);
        disposable.dispose();
        resolve();
      }
    });

    setTimeout(() => {
      testLog(`waitForSessionTermination: TIMEOUT after 30s for session ${session.id} — resolving anyway`);
      disposable.dispose();
      resolve();
    }, 30000);
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
  testLog('configureSharpDbgForFixture: start');
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

  testLog(`configureSharpDbgForFixture: dotnet=${dotnetExecutable}, dll=${cliDll}`);
  await vscode.workspace.getConfiguration('sharpdbg').update('adapterExecutable', dotnetExecutable, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('sharpdbg').update('adapterArgs', [cliDll, '--interpreter=vscode'], vscode.ConfigurationTarget.Workspace);
  testLog('configureSharpDbgForFixture: done');
}

async function launchFixtureApp(config) {
  testLog(`launchFixtureApp: start config=${JSON.stringify(config)}`);
  const extension = vscode.extensions.getExtension('lextudio.sharpdbg');
  assert.ok(extension, 'extension should be present');
  await extension.activate();

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(workspaceFolder, 'workspace folder should be available');
  testLog(`launchFixtureApp: workspace=${workspaceFolder.uri.fsPath}`);

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

    // Register the session waiter before startDebugging so we don't miss the event
    const sessionPromise = waitForDebugSession('sharpdbg');
    testLog('launchFixtureApp: calling startDebugging');
    const started = await vscode.debug.startDebugging(workspaceFolder, config);
    assert.strictEqual(started, true, 'debug session should start');
    testLog(`launchFixtureApp: startDebugging returned ${started}`);

    const session = await sessionPromise;
    assert.strictEqual(session.type, 'sharpdbg');

    testLog(`launchFixtureApp: calling stopDebugging for session ${session.id}`);
    await vscode.debug.stopDebugging(session);
    testLog('launchFixtureApp: stopDebugging returned, waiting for termination');
    await waitForSessionTermination(session);
    testLog('launchFixtureApp: session terminated');
  } finally {
    testLog('launchFixtureApp: cleaning up workspace settings');
    fs.rmSync(workspaceSettingsDir, { recursive: true, force: true });
    testLog('launchFixtureApp: done');
  }
}

suite('SharpDbg integration', () => {
  test('launches the fixture app from program and responds to DAP requests', async function () {
    this.timeout(120000);
    testLog('TEST START: launches from program');

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
    testLog('TEST END: launches from program');
  });

  test('launches the fixture app from projectPath and responds to DAP requests', async function () {
    this.timeout(120000);
    testLog('TEST START: launches from projectPath');

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
    testLog('TEST END: launches from projectPath');
  });

  test('stops at unhandled exception and logs exception type', async function () {
    this.timeout(120000);
    testLog('TEST START: stops at unhandled exception');

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

    // Clear adapterExecutable so the extension uses the cliDllPath code path (which enables engine logging)
    await vscode.workspace.getConfiguration('sharpdbg').update('adapterExecutable', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('sharpdbg').update('adapterArgs', undefined, vscode.ConfigurationTarget.Workspace);
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
              if (!message) return;
              const summary = message.type === 'event'
                ? `event=${message.event || 'N/A'}`
                : message.type === 'response'
                  ? `cmd=${message.command || 'N/A'} success=${message.success}`
                  : `type=${message.type}`;
              testLog(`tracker[${session.id.slice(0, 8)}]: ${message.type} ${summary}`);

              if (message.type !== 'event') return;

              if (message.event === 'stopped') {
                const reason = message.body && message.body.reason;
                testLog(`tracker: stopped event with reason=${reason}`);
                if (reason && String(reason).toLowerCase().includes('exception')) {
                  testLog('tracker: matched exception stopped event, resolving');
                  stoppedDetected = true;
                  stoppedResolve(message);
                }
              }
            } catch (err) {
              testLog(`tracker error: ${err.message}`);
            }
          }
        };
      }
    };

    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('sharpdbg', trackerFactory);

    try {
      // Register the session waiter before startDebugging so we don't miss the event
      const sessionPromise = waitForDebugSession('sharpdbg');
      testLog('crash test: calling startDebugging');
      const started = await vscode.debug.startDebugging(workspaceFolder, {
        type: 'sharpdbg',
        request: 'launch',
        name: 'Crash fixture launch',
        program,
        cwd: fixtureDir,
        stopAtEntry: false
      });

      assert.strictEqual(started, true, 'debug session should start');
      testLog('crash test: startDebugging returned, waiting for session');

      const session = await sessionPromise;
      testLog(`crash test: session started ${session.id}, waiting for stopped event`);

      const stoppedMessage = await Promise.race([
        stoppedPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for stopped event')), 60000))
      ]);

      assert.ok(stoppedDetected, 'debug session should stop due to exception');
      testLog('crash test: stopped event received');

      const threadId = stoppedMessage && stoppedMessage.body ? stoppedMessage.body.threadId : undefined;
      assert.ok(threadId, 'stopped event should include threadId');

      testLog(`crash test: requesting exceptionInfo for threadId=${threadId}`);
      const exceptionInfo = await session.customRequest('exceptionInfo', { threadId });
      assert.ok(exceptionInfo, 'exceptionInfo response should be present');
      testLog(`crash test: exceptionInfo received`);

      const details = exceptionInfo.details || exceptionInfo.Details || exceptionInfo;
      const evaluateName = details && details.evaluateName ? details.evaluateName : details && details.EvaluateName ? details.EvaluateName : null;
      assert.ok(evaluateName, 'Exception details should include an evaluateName');

      testLog(`crash test: evaluating ${evaluateName}`);
      const evalResp = await session.customRequest('evaluate', { expression: evaluateName });
      assert.ok(evalResp, 'evaluate response should be present');
      const variablesReference = evalResp.variablesReference || evalResp.VariablesReference || 0;
      assert.ok(variablesReference > 0, 'evaluate should return a variablesReference for the exception object');
      testLog(`crash test: evaluate returned varRef=${variablesReference}`);

      testLog('crash test: requesting variables');
      const vars = await session.customRequest('variables', { variablesReference });
      assert.ok(vars && vars.variables && vars.variables.length > 0, 'variables for exception object should be returned');
      testLog(`crash test: got ${vars.variables.length} variables`);

      const logPath = getSessionLogPath(session.id);
      testLog(`crash test: waiting for engine log at ${logPath}`);
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

      testLog('crash test: engine log received, verifying content');
      assert.match(log, /Unhandled exception: System\.InvalidOperationException: Unhandled test exception for extension testing/);
      assert.match(log, /Exception call stack:/);
      assert.match(log, /DebuggeeAppCrash\.dll!Program\.<Main>\$\(\)/);
      testLog('crash test: all assertions passed');

      testLog(`crash test: stopping debug session ${session.id}`);
      await vscode.debug.stopDebugging(session);
      testLog('crash test: waiting for session termination');
      await waitForSessionTermination(session);
      testLog('crash test: session terminated');
    } finally {
      testLog('crash test: cleaning up');
      trackerDisposable.dispose();
      const workspaceSettingsDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
      fs.rmSync(workspaceSettingsDir, { recursive: true, force: true });
      testLog('TEST END: stops at unhandled exception');
    }
  });
});
