'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { resolveProgramFromProjectPath: resolveProjectFromProjectPath } = require('./project-resolver');

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
      vscode.window.showErrorMessage('SharpDbg launch requires either program or projectPath.');
      return undefined;
    }

    if (!config.program && config.projectPath) {
      try {
        const resolved = await resolveProjectFromProjectPath(folder, config.projectPath);
        config.program = resolved.program;
        if (!config.cwd && resolved.cwd) {
          config.cwd = resolved.cwd;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`SharpDbg could not resolve projectPath: ${err.message}`);
        return undefined;
      }
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
