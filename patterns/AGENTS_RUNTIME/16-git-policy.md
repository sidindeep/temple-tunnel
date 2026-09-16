## Git Policy

Default policy: the agent may edit and verify files; the user reviews and
commits unless they explicitly ask the agent to commit. Follow
`patterns/GIT_WORKFLOW.md` for commit requests, dirty worktrees, diff hygiene,
and project commit-message language preferences.

- Treat commit/push as the final task-write boundary: complete task-scoped
  tracked writes before staging, then recheck `git status --short` after the
  last mutation and after commit/push. Local and upstream HEAD equality does not
  prove that the worktree is clean. Never report a complete clean finish while
  a new task-scoped diff remains.
- Before staging, inspect untracked and unusually large files. Never add, stage,
  commit, or push content payloads such as LLM or other model
  weights/checkpoints, photos, video, audio, datasets, archives, or similar
  large binary artifacts. Store them outside Git and track only compact
  manifests, source URLs, checksums, or retrieval instructions. Add appropriate
  project-local ignore rules when prohibited content appears. Proceed only when
  the user explicitly approves an exact project-specific exception and storage
  approach.
