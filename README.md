# SharpDbg Extension for Visual Studio Code

[![Become a Sponsor](https://img.shields.io/badge/Become%20a%20Sponsor-lextudio-orange.svg?style=for-readme)](https://github.com/sponsors/lextudio)
[![Version](https://vsmarketplacebadges.dev/version/lextudio.sharpdbg.svg)](https://marketplace.visualstudio.com/items?itemName=lextudio.sharpdbg)
[![Installs](https://vsmarketplacebadges.dev/installs/lextudio.sharpdbg.svg)](https://marketplace.visualstudio.com/items?itemName=lextudio.sharpdbg)
[![Downloads](https://vsmarketplacebadges.dev/downloads/lextudio.sharpdbg.svg)](https://marketplace.visualstudio.com/items?itemName=lextudio.sharpdbg)
[![Rating](https://vsmarketplacebadges.dev/rating/lextudio.sharpdbg.svg)](https://marketplace.visualstudio.com/items?itemName=lextudio.sharpdbg)

This extension adds an open source managed code debugger for .NET Framework, .NET Core, and .NET applications.

## Features

- Launch .NET applications under SharpDbg
- Attach to a running process
- Use the `sharpdbg` debug type in `launch.json`

## Requirements

- VS Code
- The `ms-dotnettools.vscode-dotnet-runtime` extension
- A .NET application you want to debug
- .NET 10 runtime to launch SharpDbg itself if you already have it installed
- Visual Studio Build Tools with MSBuild for .NET Framework project files on Windows

## Usage

1. Install this extension.
2. Open a .NET workspace.
3. Create or update `.vscode/launch.json`.
4. Choose `sharpdbg` as the debugger type.

Example:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch with SharpDbg",
      "type": "sharpdbg",
      "request": "launch",
      "projectPath": "${workspaceFolder}/YourApp.csproj",
      "stopAtEntry": false
    },
    {
      "name": "Attach with SharpDbg",
      "type": "sharpdbg",
      "request": "attach",
      "processId": "${command:pickProcess}"
    }
  ]
}
```

## Configuration

You can customize SharpDbg through VS Code settings:

- `sharpdbg.runtimeVersion`
- `sharpdbg.cliDllPath`
- `sharpdbg.dotnetPath`
- `sharpdbg.adapterExecutable`
- `sharpdbg.adapterArgs`
- `sharpdbg.adapterCwd`
- `sharpdbg.adapterEnv`

## Notes

SharpDbg first uses an installed .NET 10 host when it finds one. If no suitable host is available, it falls back to the .NET runtime install tool so the debugger can still start without requiring a manual install.

Launch configurations can use either `program` or `projectPath`. If you point SharpDbg at a project file, SharpDbg reads the project XML to decide how to build it: SDK-style projects use `dotnet`, while legacy .NET Framework projects on Windows use Visual Studio Build Tools/MSBuild when available (vswhere.exe is used so applicable to VS2017 and above).

## License

This project, vscode-sharpdbg, is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

SharpDbg itself is licensed under the MIT License as well, created by Matt Parker and the SharpDbg contributors.

This extension ships with a custom build from LeXtudio Inc. with extra features:

- .NET Framework support
- Stop at entry support

## Copyright

Copyright (c) 2026 LeXtudio Inc. All rights reserved.
