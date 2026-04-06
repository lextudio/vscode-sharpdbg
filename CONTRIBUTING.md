# Contributing

## Repository layout

- `sharpdbg/` is a git submodule that contains the SharpDbg debugger implementation.
- `src/extension.js` contains the VS Code extension bootstrap logic.
- `scripts/publish-sharpdbg.js` publishes the framework-dependent SharpDbg payload.

## Development setup

Install the .NET 10 SDK before working on this repository.
The extension launcher probes for an installed .NET 10 host first, then falls back to the runtime tool only when needed.
If you are testing legacy .NET Framework `projectPath` resolution on Windows, install Visual Studio Build Tools so `vswhere.exe` can find MSBuild.

To debug the extension itself in VS Code:

1. Open this repository in VS Code.
2. Press `F5`.
3. Choose `Run Extension`.
4. VS Code opens an Extension Development Host with SharpDbg loaded.

## Common commands

- `npm run sync-version` updates `package.json` from the current GitVersion result
- `npm run test:unit` runs the Node-based project XML classifier tests
- `npm run build:sharpdbg` publishes SharpDbg into `dist/sharpdbg`
- `npm run test:integration` runs the VS Code integration test suite
- `npm run check` validates the JavaScript files with `node --check`
- `./dist.all.sh` builds the extension VSIX
- `./publish.sh path/to/file.vsix` publishes a built VSIX to the marketplace

## Workflow

1. Make your changes.
2. Run `npm run check`.
3. Run `npm run test:unit`.
4. Run `npm run build:sharpdbg`.
5. Run `npm run test:integration` before merging debugger changes.
6. Run `./dist.all.sh` before a release.
7. Verify the generated files in `dist/sharpdbg` if your change affects packaging or startup.

## Submodule updates

If you need a newer SharpDbg version, update the `sharpdbg` submodule and make sure the extension still launches the published CLI correctly.
The unit suite includes a mocked legacy `projectPath` resolver test so macOS and Linux can validate the Windows MSBuild selection logic without requiring Visual Studio.

## Versioning

Release versions are derived from Git tags via GitVersion. Use tags like `v0.1.0` for releases, and let `npm run sync-version` update `package.json` before packaging.
