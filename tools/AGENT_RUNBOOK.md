# Temple Tunnel — Agent Runbook

Run commands from the project root. Sources: README.md and package.json.

## Commands

| Purpose | PowerShell command |
| --- | --- |
| Install dependencies | `pnpm install --frozen-lockfile` |
| Run desktop client | `pnpm start` |
| Tests | `node --test` |
| Unpacked application | `pnpm pack` |
| Windows NSIS installer | `pnpm dist` |
| Build network guard | `pnpm run build:guard` |

Build output: `dist/`. The source packaging assets are in `build/`.

## Smoke check

Start the client only for an explicitly requested runtime check. Verify that its
window opens and displays connection controls. Connecting creates a system TUN
and changes routing; perform a VPN connection check only within the requested scope.
TUN requires administrator rights and the bundled VPN cores.
These runtime checks were not performed during instruction bootstrap.

## Logs and private data

Use the application's Journal -> Export log action for sanitized text.
Encrypted logs are under `%APPDATA%\temple-tunnel\logs`; do not read user data
outside the project without explicit authorization. Never copy subscription URLs,
VLESS keys, decrypted profiles, or raw core output into project memory.

## Project map

- `src/main.js`: Electron application entry point.
- `src/preload.js`, `src/renderer/`: desktop UI bridge and renderer.
- `src/singbox.js`, `src/xray.js`: VPN core integrations.
- `test/`: tests; `tools/`: development helpers.
- `vendor/`: bundled runtime components; inspect only when relevant to the task.
- `docs/`: product and release documentation.
- `tools/project-memory/specs/technology-stack.md`: verified stack inventory.

## Known verification limits

README.md says kill-switch packet behavior still needs administrator-level
verification. The bootstrap did not install dependencies, run tests, build,
launch the app, or alter system routing.
