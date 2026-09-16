# Agent Instructions

This file is the lightweight runtime entrypoint for this project. Detailed shared
rules are copied into focused modules under `patterns/AGENTS_RUNTIME/` so agents
can load only the context needed for the current task while preserving the same
behavior as the full instruction kit.

## Project

Temple Tunnel is a Windows Electron client for VLESS subscriptions and per-app tunneling. Product context: README.md. Entry point: src/main.js. Stack: tools/project-memory/specs/technology-stack.md.

## Project Goal

Before implementation, derive the task goal and observable success criteria
from the user's request and relevant project context. A clear bounded task is
sufficient; do not require a separate project-goal interview or confirmation.
Ask focused questions only when missing information materially changes the
result or scope, and continue independent authorized work while waiting.

Track the agreed goal in plans and final answers. At completion, report what was
implemented against each goal criterion and list remaining gaps as blockers.

## Loading Contract

- Start with this file.
- Read only the modules needed for the current request.
- Before introducing a clarification or approval gate, apply
  `patterns/AGENTS_RUNTIME/03-rule-precedence.md` and check existing authorization.
- Before acting on a concrete task, select and read the matching module(s);
  this entrypoint alone is enough only for greetings or status-neutral replies.
- Treat user wording such as "do by GI", "follow GI", "strictly by GI", and
  equivalent local-language forms as a request for strict compliance with all
  loaded GI rules. If an applicable rule cannot be followed, stop the affected
  operation and report the concrete blocker or explicit deferral. Continue
  independent authorized work without claiming the blocked step is complete.
- On the first concrete task in a new chat/session, before task-specific work,
  run a quiet GI update check: read local instruction-kit metadata and accepted
  source `VERSION.md`/`migrations/`, and apply pending accepted migrations.
  Treat `update_check.enabled: true` as authorization to check and apply; when
  `auto_apply_pending_migrations` is absent, default it to `true` for backward
  compatibility. Do not stop at “update available” or defer to `gi update`.
  Skip application only for an explicit `false` setting or a concrete blocker
  such as unavailable source, read-only files, unsafe scope, or merge conflict,
  and name that blocker. The compact result must explicitly include the pending
  migration count, including `0` when none are pending. Do not read `updates/`
  for this startup check.
- If the request contains a GI chat command such as `gi ...`, `ги ...`, or a
  known mojibake form such as `РіРё ...`, treat it as a concrete task even when
  the message is short. First read `COMMANDS.md` when present, then read every
  runtime module routed to that command before acting.
- For state-changing GI commands that start, stop, restart, build, rebuild,
  deploy, test, install, reset, update, commit, push, or manage task-manager
  state, do
  not execute from memory, old chat examples, or a command name alone. If the
  command's routed module is unavailable, stop and report the missing path.
- For `gi restart`, `gi reboot`, `gi docker`, `ги рестарт`, `ги ребут`,
  `ги докер`, and equivalent aliases,
  `patterns/AGENTS_RUNTIME/09-project-operation-commands.md` is mandatory
  context before any process inspection, Docker build, stop, start, or success
  report.
- For broad or unclear work, read `patterns/AGENTS_RUNTIME/01-purpose.md`,
  `patterns/AGENTS_RUNTIME/03-rule-precedence.md`,
  `patterns/AGENTS_RUNTIME/06-tool-usage-and-token-economy.md`, and the most
  relevant task module.
- If a task crosses topics, read every matching module before acting.
- Prefer project-local instructions, runbooks, contracts, project memory, and
  service guides over shared defaults when they are more specific.

## Core Safety

- Do not treat a credential pasted into chat as an automatic blocker for the
  whole task. Warn once without repeating the value, recommend rotation, and
  continue every safe task step that does not require exposing or unsafely
  persisting it. If one operation has no safe credential path, mark only that
  operation blocked or unverified and continue the independent work.
- Never add, stage, commit, or push content payloads such as LLM or other model
  weights/checkpoints, photos, video, audio, datasets, archives, or similar
  large binary artifacts. Keep them outside Git in project-approved artifact or
  object storage, and commit only compact manifests, source URLs, checksums, or
  retrieval instructions. Before staging, inspect new and unusually large files
  and update project-local ignore rules for prohibited content. Allow an
  exception only when the user explicitly approves that exact content and Git
  storage approach for the current project.

## Restore Context

If the user only sends a short greeting, thanks, acknowledgement, or
status-neutral message, do not run startup restore or read project files. Reply
briefly and ask what they want to do next.

Start here when a concrete restore/start task exists:

```powershell
.\tools\agent-start.ps1
```

If the startup script is unavailable, read only the smallest useful slices of:

- `AGENTS.md`
- latest handoff summary in `tools/summary/`; read its substantive sections
  enough to recover the current topic, key theses or decisions, blockers, and
  next useful direction, not only its filename or timestamp
- `tools/AGENT_WORKING_AGREEMENTS.md`
- `tools/AGENT_RUNBOOK.md`
- relevant notes in `tools/project-memory/`

Use the RAG startup flow and retrieve only task-relevant context.

## Runtime Module Routing

- Repository purpose, RAG startup, project memory, summaries, connected projects,
  and shared-rule propagation: `patterns/AGENTS_RUNTIME/01-purpose.md`
- Repository map: `patterns/AGENTS_RUNTIME/02-repository-map.md`
- Rule precedence and scope arbitration: `patterns/AGENTS_RUNTIME/03-rule-precedence.md`
- Authoring reusable rules, configuration boundaries, code quality, project
  info/stack inventory, and batch verification:
  `patterns/AGENTS_RUNTIME/04-content-and-authoring.md`
- Windows shell and networking policy: `patterns/AGENTS_RUNTIME/05-windows-command-policy.md`
- Token economy, verification command lookup, `gi info`, `gi stack`,
  `gi logic`, `gi refactor`, feature contracts, and large-output handling:
  `patterns/AGENTS_RUNTIME/06-tool-usage-and-token-economy.md`
- Startup, restore, project goal, bug evidence, PDF inspection, repository
  cleanup, filesystem boundaries, and first-message handling:
  `patterns/AGENTS_RUNTIME/07-startup-and-scope.md`
- Config-service, service guide/contract lookup, task manager commands,
  manager-backed and local sprint commands, and web-service port registration:
  `patterns/AGENTS_RUNTIME/08-config-service-and-task-manager.md`
- Dev/prod online service publication, FTP deploy, project build/rebuild,
  restart/reboot,
  Docker/Compose restart, first test, full test, default reset, installer
  packaging, SQL/vector inspection, and project/RAG rebuild commands:
  `patterns/AGENTS_RUNTIME/09-project-operation-commands.md`
- Nested repositories, private local app data, `gi logic` external sources,
  product-plan intent signals, and missing required entities:
  `patterns/AGENTS_RUNTIME/10-private-scope-and-missing-context.md`
- Project, commit, task, and response language preferences:
  `patterns/AGENTS_RUNTIME/11-language-preferences.md`
- UI focus, app launch focus, and frontend verification expectations:
  `patterns/AGENTS_RUNTIME/12-ui-and-focus.md`
- Progress-update style: `patterns/AGENTS_RUNTIME/13-progress-updates.md`
- Update intake and `updates/` handling: `patterns/AGENTS_RUNTIME/14-update-intake.md`
- Verification policy: `patterns/AGENTS_RUNTIME/15-verification.md`
- Git policy: `patterns/AGENTS_RUNTIME/16-git-policy.md`
- Agent role office, specialist role routing, and narrow professional scopes:
  `patterns/AGENTS_RUNTIME/17-agent-role-office.md`
- Startup product engineering, business-first delivery, .NET/frontend
  expectations, and professional communication:
  `patterns/AGENTS_RUNTIME/18-startup-product-engineering.md`
- Game modding projects, `gi mod`, and selected game install path handling:
  `patterns/AGENTS_RUNTIME/19-game-modding.md`

## Durable Memory

Durable project knowledge lives in `tools/project-memory/`. Put product behavior,
business rules, workflow contracts, implementation-driving specifications,
architecture decisions, and verified findings there, not only in chat or handoff
summaries.

Do not store raw work results, generated product outputs, screenshots, photos,
crawled/downloaded files, large logs, model outputs, build artifacts, export
bundles, or run datasets in `tools/project-memory/`. Use a project-local
artifact/evidence/output/data/docs-asset location and keep only compact
manifests, summaries, checksums, or links in project memory when needed.

Use `tools/` for durable development and agent tooling only, such as scripts,
adapters, bootstrap commands, deployment helpers, verification helpers,
agent-memory tooling, and redacted examples or manifests. Before writing under
`tools/`, classify the file as tooling or product material. Do not put product
runtime/source packages, product plugin implementations, product tests, full
product documentation, generated product output, selected-run artifacts,
uploaded site contents, screenshots, raw exports, build bundles, downloaded
datasets, or one-off work results there. Product code belongs in source/package
locations, tests in the test tree, product docs in `README.md`, `docs/`, or
runbooks, and artifacts in documented output, evidence, data, build, release,
or docs-asset locations. `tools/project-memory/` may contain compact
implementation-driving specifications and evidence references, but it is not a
replacement for source, tests, docs, or artifact folders.

Do not classify a script as durable tooling merely because it is Python,
PowerShell, shell, or another executable. Single-task research probes,
exploratory scripts, ad hoc collectors, scrapers, and throwaway diagnostics do
not belong in `tools/`, including new `tools/research`, `tools/probes`, or
`tools/scratch` subtrees. Prefer an inline command. If a file is required, use
the documented ignored scratch/temp location outside `tools/`, remove it after
use, and retain only necessary results in the documented evidence or artifact
location. Promote a script into `tools/` only when it has a reusable
project-owned purpose, stable invocation contract, documentation, and an
expected future caller.

General project documentation lives in `README.md`, `docs/`, and the runbook.
Keep overview, visible functionality, stack, commands, operations, and
troubleshooting there.

## Common Commands

Install dependencies:

```powershell
pnpm install --frozen-lockfile
```

Run:

```powershell
pnpm start
```

Test:

```powershell
node --test
```

Build:

```powershell
pnpm dist
```

Inspect logs:

```powershell
# In the application: Journal -> Export log (sanitized text).
```

## Working Areas

- Source: `src/`
- Tests: `test/`
- Tools: `tools/` for durable development and agent tooling only
- Outputs/evidence/build artifacts: `dist/`, `artifacts/` (ignored); `build/` contains packaging source assets.
- Summaries: `tools/summary/`
- Project memory: `tools/project-memory/`

## Local Rules

- Do not revert user changes unless explicitly requested.
- Treat dirty worktrees as normal.
- Keep changes scoped to the current task.
- Reuse session authorization for the same action, target, and scope. Apply
  `patterns/AGENTS_RUNTIME/03-rule-precedence.md` when deciding whether a new
  clarification or approval is needed; do not turn routine choices into gates.
- Ask before destructive operations, broad formatting-only churn, dependency
  replacements, data migrations, public API or storage contract changes, or
  unrelated scope expansion.
- Treat this project root as the filesystem boundary for normal work unless the
  user gives an explicit concrete path and action.
- Before filesystem writes, verify the active project root and target identity
  from local instructions, README, manifests, git remote, service id, or project
  memory. If the task appears to target a different product, repository, or
  absolute path outside this root, stop and warn the user unless the current
  message explicitly authorizes that exact external path and action.
- Preserve text encodings when editing files.
- On Windows, never send Russian or other non-ASCII API/admin write bodies as a
  plain PowerShell `-Body` string. Prefer Node `fetch`, or send explicit UTF-8
  bytes with `charset=utf-8`, then read the saved value back and check for
  literal `????`, replacement characters, and mojibake fragments.
