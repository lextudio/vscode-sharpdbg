const assert = require('assert');
const test = require('node:test');
const { detectProjectKindFromContents } = require('../../src/project-kind');

test('detects SDK-style projects', () => {
  const kind = detectProjectKindFromContents(`
    <Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup>
        <TargetFramework>net10.0</TargetFramework>
      </PropertyGroup>
    </Project>
  `);

  assert.strictEqual(kind, 'sdk');
});

test('detects legacy project files', () => {
  const kind = detectProjectKindFromContents(`
    <Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
      <PropertyGroup>
        <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
      </PropertyGroup>
    </Project>
  `);

  assert.strictEqual(kind, 'legacy');
});

test('rejects malformed project XML', () => {
  assert.throws(() => {
    detectProjectKindFromContents('<NotAProject />', 'broken.csproj');
  }, /Unable to read a Project root element/);
});
