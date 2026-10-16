# Agent Instructions

This runtime entrypoint uses focused modules under `patterns/AGENTS_RUNTIME/`.
Load only needed modules; specific project instructions, contracts, memory, and
runbooks override shared defaults.

## Project

Temple Tunnel is a Windows Electron client for VLESS subscriptions and per-app tunneling. Product context: README.md. Entry point: src/main.js. Stack: tools/project-memory/specs/technology-stack.md.

## Goal And Loading Contract

- Derive a bounded goal and observable success criteria from request/context.
  Ask only when missing information changes scope; continue independent authorized work.
- This file alone is sufficient only for greetings and status-neutral replies.
  Before concrete work, select the matching runtime modules.
- For GI commands, run `tools/get-gi-context.ps1 -CommandText "<exact user command>"`
  for staged update check, longest-prefix routing, and bounded retrieval.
  Read `COMMANDS.md` directly only for help or command-index requests.
- Run the staged update check on the session's first concrete task, even without
  GI. Equal versions with no explicit skipped migrations mean `pending migrations: 0`;
  do not read migration filenames/bodies, `CHANGELOG.md`, or `INDEX.md`. If accepted
  source is newer, enumerate and apply pending accepted migrations; absent
  `auto_apply_pending_migrations` means `true`. Skip only for explicit `false`
  or a concrete blocker; report the pending count. Never inspect `updates/` at startup.
- Treat “do/follow strictly by GI” and equivalents as strict compliance with all
  loaded rules. Report a blocked operation precisely and continue independent
  authorized work.
- Before adding a clarification or approval gate, apply
  `patterns/AGENTS_RUNTIME/03-rule-precedence.md` and existing authorization.
- State-changing GI commands must not run from memory. If the context builder,
  route manifest, resolver, or a mandatory routed file is missing, stop that
  operation and name the missing path.
- Broad or unclear work requires `01-purpose.md`, `03-rule-precedence.md`,
  `06-tool-usage-and-token-economy.md`, and the most relevant task module.
  Cross-topic work requires every matching module.

## Core Safety And Boundaries

- Before implementation, fixes, or refactoring, load modules 04, 06, and 15;
  follow the mechanism gate in `patterns/ARCHITECTURE_AND_CODE_QUALITY.md`:
  trace the scenario, correct causes at the contract owner, and justify bypasses.
- Verify the active project root and target identity before writes. Treat this
  root as the normal filesystem boundary; exact external paths and actions need
  explicit authorization. Preserve unrelated dirty changes.
- Pasted credentials do not block unrelated work. Warn once without repeating
  values, recommend rotation, and block only unsafe credential use.
- Warn before third-party service launches; load runtime module 09.
- Never commit secrets, private data, model weights, checkpoints, photos, video,
  audio, datasets, archives, or similar large content payloads. Use approved
  artifact storage and commit compact manifests, checksums, sources, or
  retrieval instructions unless the exact exception is explicitly approved.
- Keep rebuildable build output in dedicated ignored directories and out of
  source Git; version build inputs. Follow
  `patterns/AGENTS_RUNTIME/09-build-and-install.md` for authorized cleanup,
  verification, and explicitly approved project exceptions.
- `tools/` holds durable reusable development/agent tooling. Put product code,
  tests, docs, outputs, screenshots, exports, downloads, bundles, and one-off probes
  in documented project locations. `tools/project-memory/` holds compact knowledge
  and evidence references, not bulk artifacts or replacements for source/tests.
- Align scoped code, tests, docs, and project-memory contracts before completing
  meaningful behavior or architecture work.
- Do not revert user changes without an explicit request. Ask before destructive
  operations, broad formatting churn, dependency replacement, data migration,
  public contract changes, or unrelated expansion.

## Runtime Routing

- Purpose, RAG, memory, summaries, connected projects: `01-purpose.md`
- Repository map: `02-repository-map.md`; precedence/scope: `03-rule-precedence.md`
- Authoring, configuration, quality, inventories: `04-content-and-authoring.md`
- Windows shell/networking: `05-windows-command-policy.md`
- Token economy and info/stack/logic/refactor: `06-tool-usage-and-token-economy.md`
- Startup/restore: `07-startup.md`; scope/evidence/cleanup: `07-scope-and-evidence.md`
- Config: `08-config-service.md`; task manager: `08-task-manager.md`; sprints: `08-sprint.md`
- Publication: `09-production.md`; deploy: `09-deploy-gateway.md`; FTP: `09-ftp.md`
- Runtime/restart/defaults: `09-runtime-and-defaults.md`; tester: `09-testing.md`;
  full-system tests: `09-full-testing.md`
- Build/install: `09-build-and-install.md`; memory operations: `09-project-memory-operations.md`
- Private/missing context: `10-private-scope-and-missing-context.md`
- Language: `11-language-preferences.md`; UI: `12-ui-and-focus.md`; progress: `13-progress-updates.md`
- Updates: `14-update-intake.md`; verification: `15-verification.md`; Git: `16-git-policy.md`
- Roles: `17-agent-role-office.md`; product engineering: `18-startup-product-engineering.md`
- Game modding: `19-game-modding.md`

All paths above are under `patterns/AGENTS_RUNTIME/`. The legacy combined 07/08/09
files are compatibility indexes only and contain no operational rules.

## Project Memory And Working Areas

- Source: `src/`; tests: `test/`; build artifacts: `artifacts/` (ignored); diagnostic evidence: `diagnostics/` (ignored); packaging source assets: `build/`.
- Summaries: `tools/summary/`; durable project knowledge:
  `tools/project-memory/`; reusable tooling: `tools/`.
- Put product behavior, business rules, workflow contracts, architecture
  decisions, and verified implementation findings in project memory. Put normal
  documentation in `README.md`, `docs/`, and runbooks.
- Preserve text encodings. On Windows, send non-ASCII API/admin write bodies as
  explicit UTF-8 bytes with `charset=utf-8` or via Node `fetch`, then read back
  and check for replacement characters or mojibake.

## Local Commands

TODO: record install/run/test/build/log commands in the runbook or package config.
