'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

function activate(context) {
  const descriptorFactory = new SharpDbgAdapterDescriptorFactory(context);
  const configurationProvider = new SharpDbgConfigurationProvider(context);

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('sharpdbg', descriptorFactory),
    vscode.debug.registerDebugConfigurationProvider('sharpdbg', configurationProvider)
  );
}

function deactivate() {}

class SharpDbgConfigurationProvider {
  constructor(context) {
    this.context = context;
  }

  provideDebugConfigurations() {
    return [
      {
        name: 'Launch SharpDbg',
        type: 'sharpdbg',
        request: 'launch',
        program: '${workspaceFolder}/bin/Debug/net8.0/YourApp.dll',
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
    if (!config.type) {
      config.type = 'sharpdbg';
    }

    if (!config.request) {
      config.request = 'launch';
    }

    return config;
  }
}

class SharpDbgAdapterDescriptorFactory {
  constructor(context) {
    this.context = context;
  }

  async createDebugAdapterDescriptor(session) {
    const workspaceFolder = session.workspaceFolder ? session.workspaceFolder.uri.fsPath : undefined;
    const cfg = vscode.workspace.getConfiguration('sharpdbg', session.workspaceFolder);

    const adapterExecutable = cfg.get('adapterExecutable');
    if (adapterExecutable) {
      const adapterArgs = cfg.get('adapterArgs', []);
      const adapterOptions = adapterOptionsFromConfiguration(cfg, workspaceFolder, this.context);
      return new vscode.DebugAdapterExecutable(resolvePath(adapterExecutable, workspaceFolder, this.context), adapterArgs, adapterOptions);
    }

    const configuredDllPath = resolvePath(
      cfg.get('cliDllPath') || path.join('dist', 'sharpdbg', 'SharpDbg.Cli.dll'),
      workspaceFolder,
      this.context
    );
    const fallbackDllPath = this.context.asAbsolutePath(
      path.join('sharpdbg', 'artifacts', 'bin', 'SharpDbg.Cli', 'Debug', 'net10.0', 'SharpDbg.Cli.dll')
    );
    const dllPath = fs.existsSync(configuredDllPath) ? configuredDllPath : fallbackDllPath;
    const adapterOptions = adapterOptionsFromConfiguration(cfg, workspaceFolder, this.context);

    const runtimeVersion = cfg.get('runtimeVersion') || '10.0';
    const requestingExtensionId = 'lextudio.vscode-sharpdbg';
    let dotnetPath = await findSystemDotnetHost(runtimeVersion, cfg.get('dotnetPath') || 'dotnet');

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
      } catch (err) {
        dotnetPath = undefined;
      }
    }

    if (!dotnetPath) {
      dotnetPath = cfg.get('dotnetPath') || 'dotnet';
    }

    return new vscode.DebugAdapterExecutable(dotnetPath, [dllPath, '--interpreter=vscode'], adapterOptions);
  }
}

function adapterOptionsFromConfiguration(cfg, workspaceFolder, context) {
  const adapterCwd = cfg.get('adapterCwd');
  const cwd = adapterCwd ? resolvePath(adapterCwd, workspaceFolder, context) : workspaceFolder || undefined;
  const options = {};

  if (cwd) {
    options.cwd = cwd;
  }

  const env = cfg.get('adapterEnv');
  if (env && typeof env === 'object') {
    options.env = env;
  }

  return options;
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

function findSystemDotnetHost(runtimeVersion, dotnetCommand) {
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
        resolve(undefined);
        return;
      }

      resolve(found ? dotnetCommand : undefined);
    });
  });
}

module.exports = {
  activate,
  deactivate
};
