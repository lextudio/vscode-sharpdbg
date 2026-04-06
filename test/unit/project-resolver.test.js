const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { createProjectResolver } = require('../../src/project-resolver');

test('uses mocked MSBuild for legacy projectPath resolution on Windows', async () => {
  const projectPath = path.resolve(__dirname, '..', 'fixtures', 'LegacyFrameworkApp', 'LegacyFrameworkApp.csproj');
  const calls = [];
  const outputPath = 'C:\\LegacyFrameworkApp\\bin\\Debug\\LegacyFrameworkApp.exe';

  const resolver = createProjectResolver({
    fs: {
      readFileSync: fs.readFileSync.bind(fs),
      existsSync: () => false
    },
    process: {
      platform: 'win32',
      env: {}
    },
    vscode: {
      workspace: {
        getConfiguration() {
          return {
            get(name) {
              if (name === 'dotnetPath') {
                return 'dotnet';
              }

              return undefined;
            }
          };
        }
      }
    },
    findVisualStudioMsBuild: async () => 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
    getTargetPathFromProject: async (resolvedProjectPath, buildToolPath, toolKind) => {
      calls.push(['target', resolvedProjectPath, buildToolPath, toolKind]);
      return outputPath;
    },
    buildProject: async (resolvedProjectPath, buildToolPath, toolKind) => {
      calls.push(['build', resolvedProjectPath, buildToolPath, toolKind]);
    }
  });

  const result = await resolver.resolveProgramFromProjectPath(null, projectPath);

  assert.strictEqual(result.program, outputPath);
  assert.strictEqual(result.cwd, path.dirname(projectPath));
  assert.deepStrictEqual(calls, [
    ['target', projectPath, 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe', 'msbuild'],
    ['build', projectPath, 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe', 'msbuild']
  ]);
});

test('launches SDK-style DLL outputs through dotnet', async () => {
  const projectPath = path.resolve(__dirname, '..', 'fixtures', 'DebuggeeApp', 'DebuggeeApp.csproj');
  const outputPath = path.resolve(__dirname, '..', 'fixtures', 'DebuggeeApp', 'bin', 'Debug', 'net10.0', 'DebuggeeApp.dll');

  const resolver = createProjectResolver({
    fs: {
      readFileSync: fs.readFileSync.bind(fs),
      existsSync: () => true
    },
    process: {
      platform: 'win32',
      env: {}
    },
    vscode: {
      workspace: {
        getConfiguration() {
          return {
            get(name) {
              if (name === 'dotnetPath') {
                return 'dotnet';
              }

              return undefined;
            }
          };
        }
      }
    },
    getTargetPathFromProject: async () => outputPath
  });

  const result = await resolver.resolveProgramFromProjectPath(null, projectPath);

  assert.strictEqual(result.program, 'dotnet');
  assert.deepStrictEqual(result.args, [outputPath]);
  assert.strictEqual(result.cwd, path.dirname(projectPath));
});
