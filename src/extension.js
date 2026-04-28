'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { resolveProgramFromProjectPath: resolveProjectFromProjectPath } = require('./project-resolver');

const sessionLogState = new Map();

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('SharpDbg');
  const descriptorFactory = new SharpDbgAdapterDescriptorFactory(context, outputChannel);
  const configurationProvider = new SharpDbgConfigurationProvider(context, outputChannel);

  context.subscriptions.push(
    outputChannel,
    vscode.debug.registerDebugAdapterDescriptorFactory('sharpdbg', descriptorFactory),
    vscode.debug.registerDebugConfigurationProvider('sharpdbg', configurationProvider),
    // Track adapter messages so the extension can react to stopped/exception events
    vscode.debug.registerDebugAdapterTrackerFactory('sharpdbg', {
      createDebugAdapterTracker: (session) => {
        // Tail the engine log file and trigger an exception-info probe when
        // the engine emits Exception-related events. This complements the
        // existing "stopped" handling which queries exceptionInfo/stackTrace.
        let parsePosition = 0;
        let tailInterval = undefined;
        let lastTrigger = 0;
        const tailPollMs = 250;

        const logState = sessionLogState.get(session.id);
        const logPath = logState ? logState.logPath : path.join(os.tmpdir(), `sharpdbg-${sanitizeSessionId(session.id)}.log`);

        const handleEngineException = async () => {
          try {
            // Rate-limit probing to avoid spamming the adapter
            if (Date.now() - lastTrigger < 2000) return;
            lastTrigger = Date.now();

            // Ask for threads, then probe each thread for exceptionInfo or a stack
            let threadsResp;
            try {
              threadsResp = await session.customRequest('threads', {});
            } catch (err) {
              return;
            }

            const threads = (threadsResp && threadsResp.threads) || [];
            for (const t of threads) {
              const threadId = typeof t.id === 'number' ? t.id : (typeof t.threadId === 'number' ? t.threadId : undefined);
              if (typeof threadId !== 'number') continue;

              try {
                const excInfo = await session.customRequest('exceptionInfo', { threadId });
                const typeName = excInfo?.details?.typeName || excInfo?.exceptionId || '';
                const messageText = excInfo?.details?.message || excInfo?.description || '';
                if (typeName || messageText) {
                  log(outputChannel, `Unhandled exception: ${typeName}${messageText ? `: ${messageText}` : ''}`);
                  if (excInfo?.details?.stackTrace) {
                    log(outputChannel, 'Exception call stack:');
                    const lines = excInfo.details.stackTrace.split(/\r?\n/);
                    for (const line of lines) {
                      outputChannel.appendLine(`[${new Date().toISOString()}]   ${line}`);
                    }
                  }
                  return;
                }
              } catch (err) {
                // ignore and try next thread
              }
            }

            // Fallback: try stackTrace on threads to infer a callstack
            for (const t of threads) {
              const threadId = typeof t.id === 'number' ? t.id : (typeof t.threadId === 'number' ? t.threadId : undefined);
              if (typeof threadId !== 'number') continue;
              try {
                const stackResp = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 50 });
                if (stackResp && Array.isArray(stackResp.stackFrames) && stackResp.stackFrames.length) {
                  log(outputChannel, 'Exception call stack (inferred):');
                  for (const frame of stackResp.stackFrames) {
                    const src = frame.source && (frame.source.path || frame.source.name) ? (frame.source.path || frame.source.name) : '<unknown>';
                    outputChannel.appendLine(`[${new Date().toISOString()}]   at ${frame.name} in ${src}:${frame.line}`);
                  }
                  return;
                }
              } catch (err) {
                // best-effort
              }
            }
          } catch (e) {
            // swallow
          }
        };

        const tailer = () => {
          try {
            if (!fs.existsSync(logPath)) return;
            const stats = fs.statSync(logPath);
            if (stats.size <= parsePosition) {
              parsePosition = stats.size;
              return;
            }

            const length = stats.size - parsePosition;
            const fd = fs.openSync(logPath, 'r');
            try {
              const buffer = Buffer.alloc(length);
              fs.readSync(fd, buffer, 0, length, parsePosition);
              parsePosition = stats.size;
              const text = buffer.toString('utf8');
              if (/ExceptionCorDebugManagedCallbackEventArgs|Unhandled exception|Exception thrown/i.test(text)) {
                // fire-and-forget probe; don't await here to avoid blocking tailer
                handleEngineException();
              }
            } finally {
              fs.closeSync(fd);
            }
          } catch (err) {
            // ignore tailing errors
          }
        };

        try {
          tailInterval = setInterval(tailer, tailPollMs);
          tailer();
        } catch (e) {
          // ignore
        }

        return {
          onDidSendMessage: (message) => {
            // Fire async work without blocking delivery to other trackers
            Promise.resolve().then(async () => {
              try {
                if (!message || message.type !== 'event') return;

                if (message.event === 'stopped') {
                  const threadId = message.body && message.body.threadId;
                  try {
                    const excInfo = await session.customRequest('exceptionInfo', { threadId });
                    const typeName = excInfo?.details?.typeName || excInfo?.exceptionId || '';
                    const messageText = excInfo?.details?.message || excInfo?.description || '';
                    if (typeName || messageText) {
                      log(outputChannel, `Unhandled exception: ${typeName}${messageText ? `: ${messageText}` : ''}`);

                      if (excInfo?.details?.stackTrace) {
                        log(outputChannel, 'Exception call stack:');
                        const lines = excInfo.details.stackTrace.split(/\r?\n/);
                        for (const line of lines) {
                          outputChannel.appendLine(`[${new Date().toISOString()}]   ${line}`);
                        }
                      }
                      return;
                    }
                  } catch (err) {
                    // ignore and fall through to stackTrace fallback
                  }

                  if (typeof threadId === 'number') {
                    try {
                      const stackResp = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 50 });
                      if (stackResp && Array.isArray(stackResp.stackFrames) && stackResp.stackFrames.length) {
                        log(outputChannel, 'Exception call stack:');
                        for (const frame of stackResp.stackFrames) {
                          const src = frame.source && (frame.source.path || frame.source.name) ? (frame.source.path || frame.source.name) : '<unknown>';
                          outputChannel.appendLine(`[${new Date().toISOString()}]   at ${frame.name} in ${src}:${frame.line}`);
                        }
                      }
                    } catch (innerErr) {
                      // best-effort only
                    }
                  }
                }

                if (message.event === 'output') {
                  const out = message.body && (message.body.output || message.body.text || message.body.category || '');
                  try {
                    if (typeof out === 'string' && /Unhandled exception/i.test(out)) {
                      log(outputChannel, out.trim());
                    }
                  } catch (e) {
                    // swallow
                  }
                }
              } catch (e) {
                // swallow tracker errors
              }
            }).catch(() => {});
          },
          dispose: () => {
            try {
              if (tailInterval) clearInterval(tailInterval);
            } catch (e) {}
          }
        };
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => stopSessionLogging(session.id))
  );

  log(outputChannel, 'SharpDbg extension activated');

  return {
    /**
     * Locates MSBuild.exe from the latest Visual Studio installation via vswhere.
     * Returns undefined on non-Windows or when no Visual Studio installation is found.
     * @returns {Promise<string | undefined>}
     */
    findMsBuildExe: () => findVisualStudioMsBuild(),

    /**
     * Resolves a .NET project file to a launchable program path, detecting the
     * project kind (SDK vs legacy), selecting the appropriate build tool, and
     * building the project if the output binary is missing.
     * @param {import('vscode').WorkspaceFolder | undefined} folder
     * @param {string} projectPath  Absolute or workspace-relative path to .csproj/.vbproj/.fsproj
     * @param {import('vscode').OutputChannel} [logger]  Optional channel for diagnostic output
     * @returns {Promise<{ program: string, args: string[], cwd: string, runtimeFlavor: string }>}
     */
    resolveProgramFromProjectPath: (folder, projectPath, logger) =>
      resolveProjectFromProjectPath(folder, projectPath, logger)
  };
}

function deactivate() {}

class SharpDbgConfigurationProvider {
  constructor(context, outputChannel) {
    this.context = context;
    this.outputChannel = outputChannel;
  }

  provideDebugConfigurations() {
    return [
      {
        name: 'Launch SharpDbg',
        type: 'sharpdbg',
        request: 'launch',
        program: '${workspaceFolder}/bin/Debug/net10.0/YourApp.dll',
        cwd: '${workspaceFolder}',
        stopAtEntry: false
      },
      {
        name: 'Attach to Process',
        type: 'sharpdbg',
        request: 'attach',
        processId: '${command:pickProcess}'
      }
    ];
  }

  resolveDebugConfiguration(folder, config) {
    log(this.outputChannel, `Resolving debug configuration for ${config.type || 'unknown'} ${config.request || 'unknown'} launch`);

    if (!config.type) {
      config.type = 'sharpdbg';
    }

    if (!config.request) {
      config.request = 'launch';
    }

    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    if (config.request !== 'launch' || config.type !== 'sharpdbg') {
      return config;
    }

    if (!config.program && !config.projectPath) {
      log(this.outputChannel, 'Launch configuration is missing both program and projectPath');
      vscode.window.showErrorMessage('SharpDbg launch requires either program or projectPath.');
      return undefined;
    }

    if (!config.program && config.projectPath) {
      try {
        log(this.outputChannel, `Resolving projectPath: ${config.projectPath}`);
        const resolved = await resolveProjectFromProjectPath(folder, config.projectPath, this.outputChannel);
        const existingArgs = Array.isArray(config.args) ? config.args : [];
        config.program = resolved.program;
        config.args = [...(resolved.args || []), ...existingArgs];
        if (!config.cwd && resolved.cwd) {
          config.cwd = resolved.cwd;
        }
        if (!config.runtimeFlavor && resolved.runtimeFlavor) {
          config.runtimeFlavor = resolved.runtimeFlavor;
        }
        log(this.outputChannel, `Resolved projectPath to program ${config.program} with args ${JSON.stringify(config.args)} and cwd ${config.cwd || '(unset)'}`);
      } catch (err) {
        logError(this.outputChannel, 'projectPath resolution failed', err);
        vscode.window.showErrorMessage(`SharpDbg could not resolve projectPath: ${err.message}`);
        return undefined;
      }
    }

    return config;
  }
}

class SharpDbgAdapterDescriptorFactory {
  constructor(context, outputChannel) {
    this.context = context;
    this.outputChannel = outputChannel;
  }

  async createDebugAdapterDescriptor(session) {
    const workspaceFolder = session.workspaceFolder ? session.workspaceFolder.uri.fsPath : undefined;
    const cfg = vscode.workspace.getConfiguration('sharpdbg', session.workspaceFolder);
    const runtimeFlavor = session.configuration?.runtimeFlavor || 'auto';
    log(this.outputChannel, `Creating debug adapter for session "${session.name}" (${session.id})`);

    const adapterExecutable = getConfiguredValue(cfg, 'adapterExecutable');
    if (adapterExecutable) {
      const adapterArgs = cfg.get('adapterArgs', []);
      const adapterOptions = adapterOptionsFromConfiguration(cfg, workspaceFolder, this.context);
      log(this.outputChannel, `Using custom adapter executable: ${resolvePath(adapterExecutable, workspaceFolder, this.context)}`);
      log(this.outputChannel, `Adapter args: ${JSON.stringify(adapterArgs)}`);
      return new vscode.DebugAdapterExecutable(resolvePath(adapterExecutable, workspaceFolder, this.context), adapterArgs, adapterOptions);
    }

    const adapterOptions = adapterOptionsFromConfiguration(cfg, workspaceFolder, this.context);
    const engineLoggingEnabled = cfg.get('engineLogging') === true;
    let engineLogPath = undefined;
    if (engineLoggingEnabled) {
      engineLogPath = startSessionLogging(session.id, this.outputChannel);
    } else {
      log(this.outputChannel, `Engine logging disabled (sharpdbg.engineLogging=false)`);
    }

    if (runtimeFlavor === 'desktopClr') {
      const desktopCliPath = findDesktopClrCliPath(cfg, workspaceFolder, this.context);
      if (!desktopCliPath) {
        const message = 'Could not find the desktop CLR SharpDbg CLI executable. Checked dist/sharpdbg/net48/SharpDbg.Cli.exe and sharpdbg/artifacts/bin/SharpDbg.Cli/debug_net48/SharpDbg.Cli.exe.';
        log(this.outputChannel, message);
        throw new Error(message);
      }

      const adapterArgs = ['--interpreter=vscode'];
      if (engineLogPath) adapterArgs.push(`--engineLogging=${engineLogPath}`);
      log(this.outputChannel, `Using desktop CLR CLI payload: ${desktopCliPath}`);
      log(this.outputChannel, `Using debug adapter command: ${desktopCliPath} ${adapterArgs.join(' ')}`);
      log(this.outputChannel, `Adapter cwd: ${adapterOptions.cwd || '(default)'}`);
      return new vscode.DebugAdapterExecutable(desktopCliPath, adapterArgs, adapterOptions);
    }

    const dllPath = findCoreClrCliDllPath(cfg, workspaceFolder, this.context);
    if (!dllPath) {
      const configuredDllPath = resolvePath(
        cfg.get('cliDllPath') || path.join('dist', 'sharpdbg', 'net10.0', 'SharpDbg.Cli.dll'),
        workspaceFolder,
        this.context
      );
      const releaseDllPath = this.context.asAbsolutePath(
        path.join('sharpdbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'release', 'SharpDbg.Cli.dll')
      );
      const debugDllPath = this.context.asAbsolutePath(
        path.join('sharpdbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'debug_net10.0', 'SharpDbg.Cli.dll')
      );
      const message = `Could not find SharpDbg.Cli.dll. Checked ${configuredDllPath}, ${releaseDllPath}, and ${debugDllPath}.`;
      log(this.outputChannel, message);
      throw new Error(message);
    }
    log(this.outputChannel, `Using CLI payload: ${dllPath}`);

    const runtimeVersion = cfg.get('runtimeVersion') || '10.0';
    const requestingExtensionId = 'lextudio.vscode-sharpdbg';
    let dotnetPath = await findSystemDotnetHost(runtimeVersion, cfg.get('dotnetPath') || 'dotnet', this.outputChannel);

    if (!dotnetPath) {
      const acquireContext = {
        version: runtimeVersion,
        requestingExtensionId,
        mode: 'runtime',
        architecture: process.arch
      };

      try {
        const result = await vscode.commands.executeCommand('dotnet.acquire', acquireContext);
        dotnetPath = result && result.dotnetPath;
        log(this.outputChannel, `dotnet.acquire returned ${dotnetPath || 'no path'}`);
      } catch (err) {
        logError(this.outputChannel, 'dotnet.acquire failed', err);
        dotnetPath = undefined;
      }
    }

    if (!dotnetPath) {
      dotnetPath = cfg.get('dotnetPath') || 'dotnet';
    }

    const adapterArgs = [dllPath, '--interpreter=vscode'];
    if (engineLogPath) adapterArgs.push(`--engineLogging=${engineLogPath}`);
    log(this.outputChannel, `Using debug adapter command: ${dotnetPath} ${adapterArgs.join(' ')}`);
    log(this.outputChannel, `Adapter cwd: ${adapterOptions.cwd || '(default)'}`);
    return new vscode.DebugAdapterExecutable(dotnetPath, adapterArgs, adapterOptions);
  }
}

function findCoreClrCliDllPath(cfg, workspaceFolder, context) {
  const configuredCliDllPath = getConfiguredValue(cfg, 'cliDllPath');
  const configuredDllPath = configuredCliDllPath
    ? resolvePath(configuredCliDllPath, workspaceFolder, context)
    : context.asAbsolutePath(path.join('dist', 'sharpdbg', 'net10.0', 'SharpDbg.Cli.dll'));
  const releaseDllPath = context.asAbsolutePath(
    path.join('sharpdbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'release', 'SharpDbg.Cli.dll')
  );
  const debugDllPath = context.asAbsolutePath(
    path.join('sharpdbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'debug_net10.0', 'SharpDbg.Cli.dll')
  );

  return [configuredDllPath, releaseDllPath, debugDllPath].find((candidate) => candidate && fs.existsSync(candidate));
}

function findDesktopClrCliPath(cfg, workspaceFolder, context) {
  const configuredExePath = context.asAbsolutePath(
    path.join('dist', 'sharpdbg', 'net48', 'SharpDbg.Cli.exe')
  );
  const debugExePath = context.asAbsolutePath(
    path.join('sharpdbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'debug_net48', 'SharpDbg.Cli.exe')
  );

  return [configuredExePath, debugExePath].find((candidate) => candidate && fs.existsSync(candidate));
}

function adapterOptionsFromConfiguration(cfg, workspaceFolder, context) {
  const adapterCwd = getConfiguredValue(cfg, 'adapterCwd');
  const cwd = adapterCwd ? resolvePath(adapterCwd, workspaceFolder, context) : workspaceFolder || undefined;
  const options = {};

  if (cwd) {
    options.cwd = cwd;
  }

  const env = getConfiguredValue(cfg, 'adapterEnv');
  if (env && typeof env === 'object') {
    options.env = env;
  }

  return options;
}

function getConfiguredValue(cfg, key) {
  const inspection = cfg.inspect(key);
  return inspection?.workspaceFolderValue
    ?? inspection?.workspaceValue
    ?? inspection?.globalValue
    ?? inspection?.globalLanguageValue
    ?? inspection?.workspaceFolderLanguageValue
    ?? inspection?.workspaceLanguageValue;
}

function resolvePath(candidate, workspaceFolder, context) {
  if (!candidate) {
    return candidate;
  }

  if (path.isAbsolute(candidate)) {
    return candidate;
  }

  if (workspaceFolder) {
    return path.resolve(workspaceFolder, candidate);
  }

  return context.asAbsolutePath(candidate);
}

function findSystemDotnetHost(runtimeVersion, dotnetCommand, outputChannel) {
  log(outputChannel, `Probing for .NET runtime ${runtimeVersion} with ${dotnetCommand}`);
  return new Promise((resolve) => {
    const child = cp.spawn(dotnetCommand, ['--list-runtimes'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) {
        log(outputChannel, `${dotnetCommand} --list-runtimes exited with code ${code}`);
        resolve(undefined);
        return;
      }

      const major = parseInt(runtimeVersion.split('.')[0], 10);
      const lines = stdout.split(/\r?\n/);
      const found = lines.some((line) => {
        const match = line.match(/^Microsoft\.NETCore\.App\s+([0-9]+)\.([0-9]+)\.([0-9]+)\s+/);
        if (!match) {
          return false;
        }

        return parseInt(match[1], 10) === major;
      });

      if (!found && stderr) {
        log(outputChannel, `No matching runtime found. stderr: ${stderr.trim()}`);
        resolve(undefined);
        return;
      }

      log(outputChannel, found ? `Found matching runtime with ${dotnetCommand}` : `No matching runtime found with ${dotnetCommand}`);
      resolve(found ? dotnetCommand : undefined);
    });
  });
}

function startSessionLogging(sessionId, outputChannel) {
  const logPath = path.join(os.tmpdir(), `sharpdbg-${sanitizeSessionId(sessionId)}.log`);
  const state = {
    logPath,
    position: 0,
    interval: undefined
  };

  outputChannel.show(true);
  log(outputChannel, `Engine logging to ${logPath}`);

  const pump = () => {
    try {
      if (!fs.existsSync(logPath)) {
        return;
      }

      const stats = fs.statSync(logPath);
      if (stats.size < state.position) {
        state.position = 0;
      }

      if (stats.size === state.position) {
        return;
      }

      const length = stats.size - state.position;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, state.position);
      } finally {
        fs.closeSync(fd);
      }

      state.position = stats.size;
      outputChannel.append(buffer.toString('utf8'));
    } catch (err) {
      logError(outputChannel, 'Failed to read SharpDbg engine log', err);
    }
  };

  state.interval = setInterval(pump, 250);
  sessionLogState.set(sessionId, state);
  pump();

  return logPath;
}

function stopSessionLogging(sessionId) {
  const state = sessionLogState.get(sessionId);
  if (!state) {
    return;
  }

  clearInterval(state.interval);
  sessionLogState.delete(sessionId);
}

function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function log(outputChannel, message) {
  if (!outputChannel) {
    return;
  }

  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logError(outputChannel, message, err) {
  log(outputChannel, `${message}: ${err.message}`);
  if (err.stack) {
    outputChannel.appendLine(err.stack);
  }
}

async function resolveProgramFromProjectPath(folder, projectPath) {
  const workspaceFolder = folder ? folder.uri.fsPath : undefined;
  const context = {
    asAbsolutePath: (value) => (workspaceFolder ? path.resolve(workspaceFolder, value) : value)
  };
  const cfg = vscode.workspace.getConfiguration('sharpdbg', folder);
  const dotnetCommand = cfg.get('dotnetPath') || 'dotnet';
  const absoluteProjectPath = resolvePath(projectPath, workspaceFolder, context);

  const projectKind = detectProjectKind(absoluteProjectPath);
  const buildTool = await resolveProjectBuildTool(projectKind, dotnetCommand);

  let program = await getTargetPathFromProject(absoluteProjectPath, buildTool.path, buildTool.kind);
  if (!program) {
    throw new Error(`Unable to determine target path for ${absoluteProjectPath}`);
  }

  if (!fs.existsSync(program)) {
    await buildProject(absoluteProjectPath, buildTool.path, buildTool.kind);
  }

  return {
    program,
    cwd: path.dirname(absoluteProjectPath)
  };
}

async function resolveProjectBuildTool(projectKind, dotnetCommand) {
  if (projectKind === 'legacy') {
    if (process.platform !== 'win32') {
      throw new Error('Legacy .NET Framework project files require Windows and Visual Studio Build Tools.');
    }

    const msBuildPath = await findVisualStudioMsBuild();
    if (!msBuildPath) {
      throw new Error('Could not find MSBuild.exe through Visual Studio Build Tools.');
    }

    return {
      kind: 'msbuild',
      path: msBuildPath
    };
  }

  return {
    kind: 'dotnet',
    path: dotnetCommand
  };
}

function getTargetPathFromProject(projectPath, buildToolPath, toolKind) {
  return new Promise((resolve, reject) => {
    const args = toolKind === 'msbuild'
      ? [projectPath, '-nologo', '-getProperty:TargetPath']
      : ['msbuild', projectPath, '-nologo', '-getProperty:TargetPath'];

    const child = cp.spawn(buildToolPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${path.basename(buildToolPath)} exited with code ${code}`));
        return;
      }

      const output = stdout.trim();
      if (!output) {
        resolve(undefined);
        return;
      }

      if (output.startsWith('{')) {
        try {
          const parsed = JSON.parse(output);
          resolve(parsed?.Properties?.TargetPath);
          return;
        } catch (err) {
          reject(err);
          return;
        }
      }

      resolve(output);
    });
  });
}

function buildProject(projectPath, buildToolPath, toolKind) {
  return new Promise((resolve, reject) => {
    const args = toolKind === 'msbuild'
      ? [projectPath, '/t:Build']
      : ['build', projectPath];

    const child = cp.spawn(buildToolPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${path.basename(buildToolPath)} exited with code ${code}`));
        return;
      }

      resolve();
    });
  });
}

function findVisualStudioMsBuild() {
  if (process.platform !== 'win32') {
    return Promise.resolve(undefined);
  }

  const candidates = [];
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const programFiles = process.env.ProgramFiles;

  if (programFilesX86) {
    candidates.push(path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  }

  if (programFiles) {
    candidates.push(path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  }

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existing) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve, reject) => {
    const child = cp.spawn(existing, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `vswhere exited with code ${code}`));
        return;
      }

      const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(found ? found : undefined);
    });
  });
}

module.exports = {
  activate,
  deactivate
};
