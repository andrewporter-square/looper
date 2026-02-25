# Looper Architecture

## Overview

Looper is an AI-powered automated code fixer that operates on the Rocketship TypeScript/React monorepo. It identifies lint violations, type errors, unit/integration test failures, and E2E test failures, then uses an LLM agent to generate and validate fixes — all within an automated pipeline that creates branches and PRs. It also monitors open PRs for CI failures and review feedback, auto-fixing them via the full pipeline.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          LOOPER CLI                                  │
│                                                                      │
│  Entry: node index.js [--parallel|--batch|--auto-fix|--e2e|...]     │
│         node check-prs.js [--fix|--fix-comments|...]                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Parallel     │  │  Batch       │  │  Auto-Fix    │              │
│  │  Orchestrator │  │  Orchestrator│  │  Pipeline    │              │
│  │  (worktrees)  │  │  (sequential)│  │  (full CI)   │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┴──────────────────┘                      │
│                            │                                         │
│  ┌─────────────────────────▼─────────────────────────┐              │
│  │              AI Fixer Agent (OpenAI)               │              │
│  │  Tools: read_file, write_file, run_command         │              │
│  │  Loop: error → AI fix → re-validate (max 50)      │              │
│  ├────────────────────────────────────────────────────┤              │
│  │  fixLintErrorsForFile()   — ESLint agentic loop   │              │
│  │  fixTypeErrorsForFile()   — tsc agentic loop      │              │
│  │  fixTestErrorsForFile()   — Jest/Vitest fixer      │              │
│  │  fixE2EFailures()         — Playwright fixer       │              │
│  └────────────────────────────────────────────────────┘              │
│                            │                                         │
│  ┌─────────────────────────▼─────────────────────────┐              │
│  │            Formatting Pipeline                     │              │
│  │  formatFile()         — per-write (prettier+eslint)│              │
│  │  formatChangedFiles() — pre-commit (3-step)        │              │
│  │  formatBranchFiles()  — pre-push (batch of 20)     │              │
│  └────────────────────────────────────────────────────┘              │
│                            │                                         │
│  ┌─────────────────────────▼─────────────────────────┐              │
│  │              Git & GitHub                          │              │
│  │  Branch management, commit, push, PR creation      │              │
│  │  gh CLI for PR ops, review comments                │              │
│  └────────────────────────────────────────────────────┘              │
│                                                                      │
│  ┌───────────────────────────────────────────────────┐              │
│  │         CI Context Gathering                       │              │
│  │  GitHub Actions: annotations + failed job logs     │              │
│  │  Buildkite API: build state + job logs             │              │
│  │  → CI_CONTEXT variable / server-error-context.txt  │              │
│  └───────────────────────────────────────────────────┘              │
│                                                                      │
│  ┌───────────────────────────────────────────────────┐              │
│  │         E2E Testing (Playwright + Docker)          │              │
│  │  Auto-tag resolution from changed files            │              │
│  │  Docker mode with AWS/ECR auth                     │              │
│  │  Pre-existing failure detection                    │              │
│  └───────────────────────────────────────────────────┘              │
│                                                                      │
│  ┌───────────────────────────────────────────────────┐              │
│  │         PR Health Checker (check-prs.js)           │              │
│  │  Scan PRs → check CI → fetch logs → triage         │              │
│  │  --fix: spawn full index.js --auto-fix pipeline    │              │
│  │  --fix-comments: AI-driven review comment fixes    │              │
│  └───────────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
         │                              │                    │
         ▼                              ▼                    ▼
┌──────────────────┐          ┌──────────────────┐  ┌──────────────┐
│  Rocketship Repo │          │    GitHub API     │  │ Buildkite API│
│  (local clone)   │          │  PRs, checks,     │  │ Build logs,  │
│  git worktrees   │          │  comments, runs   │  │ job state    │
└──────────────────┘          └──────────────────┘  └──────────────┘
```

## Core Components

### 1. Orchestrators (`index.js`)

| Mode | Function | Concurrency | Branch Strategy |
|---|---|---|---|
| `--parallel` | `runParallelFixer()` | N workers via worktrees | One branch per file |
| `--batch` | `runBatchFixer()` | Sequential | Single branch for all files |
| `--auto-fix` | `runTestFixer()` | Sequential | User-managed branch |
| `--e2e` | `runE2ERunner()` | Sequential | Current branch |
| `--worker` | `runWorkerMode()` | Single (spawned by parallel) | Worktree branch |
| (default) | `runLoop()` | Interactive | N/A |

**Parallel mode** is the primary production mode. It:
1. Creates N git worktrees from `master`
2. Symlinks `node_modules` from the main repo (avoids N × `yarn install`)
3. Spawns worker processes (`--worker` flag) that run independently
4. Each worker: fixes lint → fixes tests → fixes types → formats → commits → pushes → opens PR

**Auto-fix pipeline** (`runTestFixer()`) is the full CI-fix pipeline:
1. Merge master → `safeYarnInstall()` (restores `package.json` if yarn modifies it)
2. `gatherPRCIContext()` — fetch CI logs from Buildkite + GitHub Actions
3. Discover failing Jest & Vitest tests
4. Filter out pre-existing failures (tests that fail on master too)
5. Fix each failing test with AI agent
6. Global ESLint check → `fixLintErrorsForFile()`
7. TypeScript type check → `fixTypeErrorsForFile()`
8. Prune ESLint suppressions → suppress remaining
9. `formatBranchFiles()` — format all branch files vs master
10. E2E tests (unless `--skip-e2e`)
11. Commit, push, open/update PR

### 2. AI Fixer Agent

The fixer agent is an OpenAI function-calling loop with three tools:

| Tool | Description |
|---|---|
| `read_file` | Read a file from the repo (with line range) |
| `write_file` | Write content to a file, then auto-format via `formatFile()` |
| `run_command` | Execute a shell command in the repo root (Hermit env) |

**Agent loop:**
```
1. Collect error output (eslint/tsc/jest/vitest/playwright)
2. Send to OpenAI with system prompt + file content + context
3. Agent calls tools to investigate and fix
4. Re-run validation
5. Loop until clean or max iterations (50) reached
```

**Key design choice**: The agent has full read/write access to the repo via tools, but the orchestrator controls the git workflow. The agent never commits or pushes.

Four specializations:
- **`fixLintErrorsForFile()`** — ESLint errors. System prompt includes pattern-specific strategies for `@afterpay/i18n-only-static-keys`, `no-unused-vars`, import rules, etc.
- **`fixTypeErrorsForFile()`** — TypeScript `tsc` errors. Traces type dependencies across files.
- **`fixTestErrorsForFile()`** — Jest and Vitest failures. Reads test file + source file, understands assertion patterns.
- **`fixE2EFailures()`** — Playwright E2E failures. Parses structured JSON results, correlates with source changes.

### 3. Formatting Pipeline

Three layers of formatting prevent regressions in agent-generated code:

**`formatFile(relativePath)`** — after every `write_file` tool call:
```
prettier --write <file>
eslint <file> --fix --prune-suppressions
```

**`formatChangedFiles()`** — before every git commit:
```
1. Collect changed .ts/.tsx/.js/.jsx files (git diff)
2. prettier --write <all files>
3. eslint <all files> --fix --prune-suppressions
4. eslint <all files> --suppress-all
```

**`formatBranchFiles()`** — before push:
```
1. Diff all files changed on branch vs origin/master
2. Process in batches of 20 to avoid arg-too-long
3. prettier --write + eslint --fix --prune-suppressions per batch
4. If changes detected: eslint --suppress-all + auto-commit
```

### 4. ESLint Suppression Handling

Instead of manually editing `eslint-suppressions.json`, looper uses ESLint's native flags:

| Flag | Purpose |
|---|---|
| `--prune-suppressions` | Removes stale suppression entries for files that no longer have those errors |
| `--suppress-all` | Adds suppression entries for any remaining unfixed errors |

This keeps `eslint-suppressions.json` in sync with actual errors, passing CI's "Verify suppressions" check.

### 5. CI Context Gathering

`gatherPRCIContext()` fetches failure information from the branch's PR:

1. **Detect branch PR** via `gh pr view`
2. **Classify checks** — find failed/errored/timed_out checks
3. **GitHub Actions** — fetch annotations via `gh api` + failed job logs via `gh run view --log-failed`
4. **Buildkite** — fetch build JSON + failed job logs via REST API (`BUILDKITE_TOKEN` required)
5. **Error extraction** — `extractErrorSections()` scans logs for error patterns (stack traces, assertion failures, compile errors) and returns the most relevant excerpts (capped at 12KB per job)
6. **Output** — combined context string (capped at 40KB total), stored in `CI_CONTEXT` and injected into the AI system prompt

### 6. Pre-existing Failure Detection

When discovering test failures, looper determines which are caused by the branch vs. pre-existing on master:

**Unit/Integration tests:**
- Gets files changed by the branch (`git diff --name-only origin/master...HEAD`)
- For each failing test, checks if the test file or its source file were modified
- Skips tests where neither the test nor its source was changed

**E2E tests:**
- Compares E2E test file content between branch and master
- If test files are identical, failures are flagged as pre-existing and skipped

This avoids wasting AI tokens on unrelated failures.

### 7. E2E Testing

`runE2ETests()` runs Playwright E2E tests with smart tag resolution:

**Tag resolution (`resolveE2ETagsFromChanges()`):**
- Maps changed source file paths to Playwright test tags
- 20+ regex patterns match component/page names to regression suites
- Falls back to `@checkout_local_smoke` if no specific match

**Docker mode (default):**
- Checks Docker is running
- Handles AWS/ECR authentication (`saml2aws login` for image pulls)
- Runs via `yarn test:e2e:$APP --tags $TAGS`
- Parses Playwright JSON results for structured failure data

### 8. PR Health Checker (`check-prs.js`)

**Scanning pipeline:**
```
List open PRs (gh pr list --author @me)
  → Check CI status per PR (gh pr checks)
  → Classify: passing / failing / pending
  → Fetch failure logs (GitHub Actions + Buildkite API)
  → Fetch review comments
  → Display summary table
```

**Fix pipeline (`--fix`):**
```
For each failing PR:
  1. Check out the PR branch
  2. Write CI failure context to server-error-context.txt
  3. Spawn: node index.js --auto-fix --skip-e2e
     (full pipeline: merge master → install → fix tests →
      fix lint → fix types → format → commit → push)
  4. Stream child process output in real-time
  5. Report timing and result
```

**Comment fix pipeline (`--fix-comments`):**
```
For each PR with review comments:
  1. Fetch review comments via gh api
  2. AI triage: is the comment actionable? safe to auto-fix?
  3. If safe: apply fix, commit, push, reply to comment
```

## Data Flow

### Input
- `list.json`: Array of repo-relative file paths to process
- `.env`: Configuration (API keys, repo path, Buildkite token)
- `server-error-context.txt`: CI failure context (auto-populated by check-prs.js or gatherPRCIContext())
- `i18n-static-keys-research-MEGA.md`: Per-file research notes for i18n migrations

### Output
- Git branches with fixed code
- GitHub PRs with description and labels
- `.pr-{number}-logs.txt` files (CI failure logs, gitignored)

### Context Injection

The AI agent receives context from multiple sources:
1. **System prompt**: Fix strategies, patterns, style guide (hardcoded in `index.js`)
2. **File content**: The actual source file being fixed
3. **Error output**: ESLint/tsc/Jest/Vitest/Playwright output
4. **Research doc**: Matched sections from `i18n-static-keys-research-MEGA.md`
5. **CI context**: `CI_CONTEXT` variable (gathered from Buildkite + GitHub Actions)
6. **Server context**: `server-error-context.txt` (CI logs written by check-prs.js)

## Security Considerations

- **API keys**: Stored in `.env` (gitignored), never logged
- **Buildkite token**: Read-only API access, stored in `.env`
- **Repo access**: Uses local git + `gh` CLI auth, no stored tokens
- **AI scope**: The agent can read/write files within `LOOPER_REPO_ROOT` only
- **Push safety**: Always uses `--no-verify` to skip hooks, relies on CI for validation
- **No auto-merge**: PRs are always created as open, requiring human review

## Operational Notes

- **Rate limits**: OpenAI API calls are sequential per worker. Parallel mode with 3 workers = ~3x API usage.
- **Worktree cleanup**: `runParallelFixer` cleans up worktrees on exit. If the process is killed, run `git worktree prune` in the Rocketship repo.
- **Branch naming**: `feat/{scope}/static-i18n-keys-{component}-{timestamp}-{index}` or `fix/lint-{component}-{timestamp}`
- **Hermit env**: `REPO_ENV` prepends Rocketship's `bin/` and `node_modules/.bin/` to `PATH` so `exec()` uses Hermit-managed Node/yarn/vitest.
- **Context window management**: Token usage is estimated per message. Old messages are pruned when approaching the context limit.
- **Docker E2E**: Requires Docker Desktop running + valid AWS credentials (`saml2aws`). Falls back gracefully if either is unavailable.
- **Safe yarn install**: `safeYarnInstall()` restores `package.json` from git if yarn modifies it (e.g., Corepack migration).
