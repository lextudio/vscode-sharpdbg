# Contributing

## Repository layout

- `sharpdbg/` is a git submodule that contains the SharpDbg debugger implementation.
- `src/extension.js` contains the VS Code extension bootstrap logic.
- `scripts/publish-sharpdbg.js` publishes the framework-dependent SharpDbg payload.

## Development setup

Install the .NET 10 SDK before working on this repository.
The extension launcher probes for an installed .NET 10 host first, then falls back to the runtime tool only when needed.

## Common commands

- `npm run build:sharpdbg` publishes SharpDbg into `dist/sharpdbg`
- `npm run check` validates the JavaScript files with `node --check`

## Workflow

1. Make your changes.
2. Run `npm run check`.
3. Run `npm run build:sharpdbg`.
4. Verify the generated files in `dist/sharpdbg` if your change affects packaging or startup.

## Submodule updates

If you need a newer SharpDbg version, update the `sharpdbg` submodule and make sure the extension still launches the published CLI correctly.
