# MAM Quote Search project rules

## Boundary and targets

- Company profile: `mam`. This repository is the filesystem boundary; do not
  access Personal, InsiderLead, Forge, or sibling MAM projects unless requested.
- CC Switch owns shared Skills and MCP definitions. Check Maton with
  `"$HOME/Documents/Codex/bin/codex-project-credential" check maton`. If a
  Keychain-backed check reports missing or denied inside the sandbox, request
  system-level execution and retry. Only a failed system-level check is a hard stop.
- Run GitHub with `GH_CONFIG_DIR="$HOME/.github-profiles/mam"`; verify account
  `mobilityaccessmodifications` and repository
  `mobilityaccessmodifications/mam-quote-portal` before a write.
- Before every commit, require repository-local Git identity
  `user.name=mobilityaccessmodifications` and
  `user.email=310802599+mobilityaccessmodifications@users.noreply.github.com`;
  never change global Git identity.
- Run Vercel with `--global-config "$HOME/.vercel-profiles/mam"`; verify user
  `mobilityaccess`, project `mam-quote-portal`, and the expected team before
  deployment or environment changes.

## Git, worktree, and deletion safety

- Before changing files, run `git status --short --branch` and
  `git worktree list --porcelain`. Treat every pre-existing modified, deleted,
  or untracked path as protected user or other-session work.
- Never run parallel write tasks in the same checkout. Give each task a Codex
  Worktree or dedicated Git worktree on a unique `codex/<task>` branch; one
  branch belongs to one worktree. Use Codex Handoff between Local and Worktree.
- If protected work overlaps the task, or ownership is unclear, stop and ask.
  Do not run repo-wide formatters or generators in a dirty shared checkout.
- Never use `git reset --hard`, `git clean`, `git checkout --`, `git restore`,
  `git stash`, branch/worktree deletion, force push, or bulk deletion unless
  the user explicitly approves the exact target and action. Do not switch
  branches while protected changes exist.
- Delete only files created by the current task or exact user-approved paths
  after verifying each target. Untracked files and another session's artifacts
  are protected, not cleanup candidates.
- Stage only explicit task paths; never use `git add .` or `git add -A` in a
  dirty checkout. Before committing, inspect `git diff --cached --check`,
  `git diff --cached`, and `git status --short`.
- At handoff, report the worktree, branch, changed paths, tests, and commit
  status. Leave every unrelated change untouched.

## Quote-search safety

- This portal is read-only against AroFlo. Do not add AroFlo mutation behavior
  or perform live writes while testing search/status functionality.
- Quote/job identifiers, customer details, signatures, and raw AroFlo responses
  are confidential. Never log, commit, or expose them in fixtures or screenshots.
- Run `npm test`; use `npm run check-aroflo` only with approved MAM credentials
  and treat it as a live external read.
- Deployments, environment changes, pushes, and remote API actions require
  explicit approval and exact target verification.
- Preserve existing work, stage explicit paths only, and never commit `.env*`,
  tokens, API keys, customer exports, or production dumps.
