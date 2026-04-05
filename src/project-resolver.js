'use strict';

const defaultCp = require('child_process');
const defaultFs = require('fs');
const defaultPath = require('path');
let defaultVscode;
try {
  defaultVscode = require('vscode');
} catch (err) {
  defaultVscode = undefined;
}
const { detectProjectKind } = require('./project-kind');

function createProjectResolver(overrides = {}) {
  const cp = overrides.cp || defaultCp;
  const fs = overrides.fs || defaultFs;
  const path = overrides.path || defaultPath;
  const vscode = overrides.vscode || defaultVscode;
  const processInfo = overrides.process || process;
  const detectKind = overrides.detectProjectKind || detectProjectKind;
  const resolvePath = overrides.resolvePath || createResolvePath(path);
  const findVisualStudioMsBuild = overrides.findVisualStudioMsBuild || createFindVisualStudioMsBuild({ cp, fs, path, process: processInfo });
  const getTargetPathFromProject = overrides.getTargetPathFromProject || createGetTargetPathFromProject({ cp, path });
  const buildProject = overrides.buildProject || createBuildProject({ cp, path });

  async function resolveProgramFromProjectPath(folder, projectPath) {
    const workspaceFolder = folder ? folder.uri.fsPath : undefined;
    const context = {
      asAbsolutePath: (value) => (workspaceFolder ? path.resolve(workspaceFolder, value) : value)
    };
    const cfg = vscode.workspace.getConfiguration('sharpdbg', folder);
    const dotnetCommand = cfg.get('dotnetPath') || 'dotnet';
    const absoluteProjectPath = resolvePath(projectPath, workspaceFolder, context);

    const projectKind = detectKind(absoluteProjectPath, fs);
    const buildTool = await resolveProjectBuildTool(projectKind, dotnetCommand);

    const program = await getTargetPathFromProject(absoluteProjectPath, buildTool.path, buildTool.kind);
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
      if (processInfo.platform !== 'win32') {
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

  return {
    resolveProgramFromProjectPath,
    resolveProjectBuildTool
  };
}

function createResolvePath(path) {
  return (candidate, workspaceFolder, context) => {
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
  };
}

function createGetTargetPathFromProject({ cp, path }) {
  return function getTargetPathFromProject(projectPath, buildToolPath, toolKind) {
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
  };
}

function createBuildProject({ cp, path }) {
  return function buildProject(projectPath, buildToolPath, toolKind) {
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
  };
}

function createFindVisualStudioMsBuild({ cp, fs, path, process }) {
  return function findVisualStudioMsBuild() {
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
  };
}

const defaultResolver = createProjectResolver();

module.exports = {
  createProjectResolver,
  resolveProgramFromProjectPath: defaultResolver.resolveProgramFromProjectPath
};
