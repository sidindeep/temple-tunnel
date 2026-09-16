# Technology Stack

Last reviewed: 2026-09-16, during GI bootstrap.
Evidence: package.json, README.md and the src/ directory listing.

| Layer | Technology | Evidence |
| --- | --- | --- |
| Desktop runtime | Electron ^44.1.1; JavaScript; Windows | package.json |
| Application entry | src/main.js | package.json main |
| UI | Electron renderer and preload bridge | src/renderer/, src/preload.js |
| VPN | sing-box and Xray-core; VLESS and Hysteria 2 | README.md |
| Storage | Electron safeStorage / Windows DPAPI; encrypted profiles and logs | README.md |
| QR import | jsqr 1.4.0 | package.json |
| Development QR tooling | qrcode 1.5.4 | package.json |
| Packages | pnpm and pnpm-lock.yaml | README.md, lockfile presence |
| Packaging | electron-builder ^26.15.3, Windows NSIS | package.json |
| Tests | Node.js built-in test runner | package.json scripts.test |

Versions above are manifest ranges, not verified installed runtime versions.
Commands and operations: ../../AGENT_RUNBOOK.md.
External network services are user-selected subscription and VPN endpoints;
do not persist their private addresses or credentials in agent memory.

## Gaps

Installed Node.js/pnpm versions, native toolchain, resolved dependency versions,
and runtime behavior were not checked during this documentation-only bootstrap.
