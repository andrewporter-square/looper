# Looper

**Automated ESLint, TypeScript, test, and E2E fixer agent for TypeScript/React monorepos.**

Looper uses OpenAI to automatically fix lint violations (including custom ESLint rules like i18n static-key enforcement), TypeScript type errors, failing unit/integration tests, and Playwright E2E tests across your codebase. It creates branches, applies fixes, runs validation, and opens PRs — all automated.

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> && cd looper
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your OPENAI_API_KEY, LOOPER_REPO_ROOT, and BUILDKITE_TOKEN

# 3. Add files to fix
echo '["apps/myapp/src/page/example/Example.tsx"]' > list.json

# 4. Run
node index.js --parallel
```

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18+ | Tested on 24.x |
| `gh` CLI | 2.x+ | Authenticated with `gh auth login` |
| Git | 2.30+ | With push access to your target repo |
| OpenAI API key | — | Needs GPT-4o / GPT-5 access |
| Target repo | — | Cloned locally with dependencies installed |
| Docker Desktop | — | Required for E2E tests (optional otherwise) |
| AWS CLI | — | Required for E2E Docker image pulls from private ECR (optional) |

### Configuration

Copy the example config and customize for your repo:

```bash
cp looper.config.example.js looper.config.js
```

Edit `looper.config.js` to set your repo path, app name, branch naming, E2E tag mappings, PR checklist, and other repo-specific settings. See `looper.config.example.js` for all available options.

## Environment Variables

Additional configuration is via environment variables (`.env` file):

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `LOOPER_REPO_ROOT` | No | `/path/to/your/repo` | Path to target repo (also set in looper.config.js) |
| `LOOPER_CONCURRENCY` | No | `3` | Number of parallel workers for `--parallel` mode |
| `BUILDKITE_TOKEN` | No | — | Buildkite API token for fetching CI build logs |

## Modes

### `--parallel` — Parallel Fixer (recommended)

Processes multiple files concurrently using git worktrees. Each file gets its own branch, fixes, tests, and PR.

```bash
node index.js --parallel
```

**What it does:**
1. Reads `list.json` for files to fix
2. Creates a git worktree per file (branched from `master`)
3. Spawns concurrent worker processes (controlled by `LOOPER_CONCURRENCY`)
4. Each worker: fixes lint → runs Jest/Vitest → fixes type errors → prunes suppressions → formats branch files → commits → pushes → opens PR
5. Cleans up worktrees

### `--batch` — Sequential Batch Fixer

Processes all files in `list.json` sequentially on a single branch.

```bash
node index.js --batch
```

### `--auto-fix` / `--fix-tests` — Full Fix Pipeline

The primary pipeline mode. Merges master, installs dependencies, then iteratively fixes all lint, type, test, and E2E errors on the current branch.

```bash
node index.js --auto-fix                # Full pipeline including E2E
node index.js --auto-fix --skip-e2e     # Skip E2E tests (faster iteration)
```

**Pipeline steps:**
1. Merge master → yarn install
2. Gather CI context from Buildkite & GitHub Actions
3. Discover failing tests using configured runners (Jest, Vitest, or both)
4. Filter out pre-existing failures (tests that fail on master too)
5. Fix each failing test with AI agent (with cross-run history tracking)
6. Global ESLint check → fix lint errors
7. TypeScript type check → fix type errors
8. Prune eslint-suppressions → suppress remaining
9. Format all branch files (prettier + eslint)
10. Commit, push, open/update PR

### `--e2e` — E2E Test Runner

Runs Playwright E2E tests in Docker, auto-detects relevant test tags from branch changes, and attempts AI-driven fixes for failures.

```bash
node index.js --e2e                          # Auto-detect tags, Docker
node index.js --e2e --e2e-tags=@your_app_smoke  # Specific tag
node index.js --e2e --e2e-native             # Without Docker
node index.js --e2e --e2e-headed             # Show browser
node index.js --e2e --no-fix                 # Skip auto-fix on failure
```

**Features:**
- Auto-resolves E2E tags from changed files (e.g., component changes → matching E2E tags)
- Docker mode with automatic AWS/ECR authentication
- Pre-existing failure detection: skips failures that also fail on master
- AI-powered E2E failure fixer with Playwright JSON result parsing

### `--check-prs` — PR Health Checker

Scans all open looper PRs, checks CI status, fetches failure logs, and optionally auto-fixes issues using the **full fix pipeline** (same as `index.js --auto-fix`).

```bash
node check-prs.js                  # List & check all looper PRs
node check-prs.js --fix            # Fix CI failures (full pipeline) + review comments
node check-prs.js --fix-comments   # Only fix review comment feedback
node check-prs.js --author @me     # Filter by author (default: @me)
node check-prs.js --label myapp # Filter by label
```

**Features:**
- Detects and auto-fixes "PR description too short" validation errors
- Fetches Buildkite & GitHub Actions failure logs via API
- **`--fix` runs the full pipeline per PR**: checks out the branch, writes CI context to `server-error-context.txt`, then spawns `node index.js --auto-fix --skip-e2e` — merge master → yarn install → discover failing tests → fix tests → global lint → fix lint → type check → fix types → prune suppressions → format branch files → commit → push
- Tracks fix attempts per branch — skips branches with 5+ consecutive failures (see [Fix History](#fix-history))
- Reads PR review comments, triages actionable feedback, and applies AI-driven fixes

### Interactive Agent (default)

A chat-based agent loop for ad-hoc tasks.

```bash
node index.js
```

## File Reference

| File | Purpose |
|---|---|
| `index.js` | Main entry point — all fixer modes, AI agent, tool definitions |
| `check-prs.js` | PR health checker — CI status, log fetching, full pipeline fix |
| `fix-history.js` | Persistent fix-attempt tracking across runs (see [Fix History](#fix-history)) |
| `looper.config.js` | Repo-specific configuration (gitignored — copy from example) |
| `looper.config.example.js` | Example config with all available options |
| `list.json` | Input: array of file paths (relative to repo root) to process |
| `.looper-history.json` | Fix attempt history (auto-generated, gitignored) |
| `server-error-context.txt` | CI failure context injected into the AI fixer prompt (auto-populated) |
| `notes.md` | Style guide and coding principles for the fixer agent |
| `docs/ARCHITECTURE.md` | System architecture and data flow documentation |
| `CONTRIBUTING.md` | Contributing guidelines and development workflow |

## How the Fixer Agent Works

### AI Fixer Loop

Each fixer function (`fixLintErrorsForFile`, `fixTypeErrorsForFile`, `fixTestErrorsForFile`, `fixE2EFailures`) runs an agentic loop:

```
Error output → AI reads file + errors + context + fix history
  → Agent uses tools (read_file, write_file, run_command, search_files, list_files) to fix
  → Re-run validation → loop until clean (max 50–90 iterations)
```

The AI agent has access to file I/O, search, and shell commands within the repo. It follows a detailed system prompt with pattern-specific fix strategies and previous attempt history.

### Fix History

Looper tracks what was tried across runs via `fix-history.js`, persisting to `.looper-history.json`:

- **Cross-run memory**: Each fix attempt records the branch, file, fix type, approach taken, errors encountered, and success/failure
- **Prompt injection**: Previous failed approaches are injected into the AI system prompt with explicit instructions not to repeat them
- **Approach extraction**: `summarizeAgentApproach()` captures which files the agent read/wrote and its stated strategy
- **Attempt limits**: `check-prs.js` skips branches with 5+ consecutive failed attempts
- **Auto-pruning**: Entries older than 7 days are expired; max 20 entries per branch/file

Clear history for a specific branch:
```bash
node -e "require('./fix-history').clearBranchHistory('feat/my-branch')"
```

### Formatting Pipeline

Every file write and commit goes through a multi-stage formatting pipeline:

1. **`formatFile(path)`** — runs after every agent file write
   - `prettier --write` to fix formatting
   - `eslint --fix --prune-suppressions` to auto-fix + remove stale suppressions

2. **`formatChangedFiles()`** — runs before every commit
   - Collects all changed `.ts/.tsx/.js/.jsx` files
   - `prettier --write` on all changed files
   - `eslint --fix --prune-suppressions` to clean up
   - `eslint --suppress-all` to add suppression entries for any remaining unfixed errors

3. **`formatBranchFiles()`** — runs before push
   - Diffs all files changed on the branch vs `origin/master`
   - Processes in batches of 20 (avoids arg-too-long errors)
   - `prettier --write` + `eslint --fix --prune-suppressions` per batch
   - Auto-commits if any formatting issues found

### ESLint Suppression Handling

Instead of manually editing `eslint-suppressions.json`, looper uses ESLint's native flags:
- `--prune-suppressions` — removes stale suppression entries for cleaned-up files
- `--suppress-all` — adds suppression entries for any remaining unfixed errors

This keeps `eslint-suppressions.json` in sync with actual errors, passing CI's "Verify suppressions" check.

### CI Context Gathering

Before fixing, looper gathers failure context from the branch's PR:

1. **GitHub Actions** — fetches annotations + failed job logs via `gh api`
2. **Buildkite** — fetches build state, failed job details, and full job logs via REST API (requires `BUILDKITE_TOKEN`)
3. Context is stored in the `CI_CONTEXT` variable and injected into the AI fixer's system prompt
4. For `check-prs.js --fix`, context is also written to `server-error-context.txt`

### Pre-existing Failure Detection

When discovering test failures, looper checks whether failures also occur on master:
- Compares test file content between branch and master
- If test files are identical to master, failures are flagged as "pre-existing"
- Pre-existing failures are skipped instead of wasting AI tokens fixing unrelated issues
- This filters both unit test and E2E test failures

### Configurable Test Runners

Looper supports both Jest and Vitest, configured in `looper.config.js`:

```js
test: {
  runners: ['vitest'],            // Active runners: ['vitest'], ['jest'], or ['jest', 'vitest']
  vitestCommand: 'yarn test:vitest --run',  // Base vitest command
  jestCommand: '',                // Base jest command (empty = skip jest)
},
```

- **Discovery**: Only enabled runners participate in test discovery
- **Per-file fixing**: The default runner for `fixTestErrorsForFile()` is the first configured runner
- **Commands**: Looper appends per-file arguments (`--reporter`, `--outputFile`, file patterns, etc.)

### E2E Tag Resolution

Looper auto-detects which Playwright E2E test suites to run based on changed files:

```
Changed files → pattern matching → E2E tags
  ComponentA.tsx  → @app_regression_component_a
  FeatureB.tsx    → @app_regression_feature_b
  PageC.tsx       → @app_regression_page_c
  (no match)      → @app_smoke (fallback)
```

20+ patterns map source directories/components to specific E2E regression tags.

## Architecture

```
looper/
├── index.js              # Core engine (~4300 lines)
│   ├── formatFile()                 # Prettier + eslint after every agent write
│   ├── formatChangedFiles()         # Format + sync suppressions before commit
│   ├── formatBranchFiles()          # Format all branch files vs master before push
│   ├── gatherPRCIContext()          # Fetch CI logs from GitHub Actions + Buildkite
│   ├── resolveE2ETagsFromChanges()  # Map changed files → Playwright test tags
│   ├── runE2ETests()                # Run Playwright in Docker with auto-retry
│   ├── fixLintErrorsForFile()       # AI-powered lint fixer (agentic loop)
│   ├── fixTypeErrorsForFile()       # AI-powered type error fixer
│   ├── fixTestErrorsForFile()       # AI-powered test fixer
│   ├── fixE2EFailures()             # AI-powered E2E failure fixer
│   ├── runParallelFixer()           # Worktree-based parallel orchestrator
│   ├── runBatchFixer()              # Sequential batch orchestrator
│   ├── runTestFixer()               # Full pipeline orchestrator (--auto-fix)
│   ├── runE2ERunner()               # Standalone E2E runner (--e2e)
│   ├── runWorkerMode()              # Single-file worker (used by --parallel)
│   └── runLoop()                    # Interactive chat agent
├── check-prs.js          # PR health monitoring (~1700 lines)
│   ├── listLooperPRs()              # Find open looper PRs via gh CLI
│   ├── getPRChecks()                # Fetch CI check status
│   ├── getFailedRunLogs()           # Fetch GitHub Actions failure logs
│   ├── getBuildkiteLogs()           # Fetch Buildkite failure logs via API
│   ├── fixPRDescription()           # Auto-fix short PR descriptions
│   ├── fixFailingPR()               # Spawn full index.js --auto-fix pipeline
│   ├── fetchPRComments()            # Fetch review comments
│   └── fixFromComments()            # AI triage + fix from review feedback
├── fix-history.js         # Persistent fix-attempt tracking
│   ├── recordAttempt()              # Save attempt details to history
│   ├── getHistoryForPrompt()        # Format failed attempts for AI prompt
│   ├── getBranchSummary()           # Aggregate stats per branch
│   ├── clearBranchHistory()         # Clear history after successful fix
│   └── pruneHistory()               # Expire old entries (7 day / 20 cap)
├── looper.config.js       # Repo-specific config (gitignored)
├── looper.config.example.js  # Config template with all options
├── list.json              # Input file list
├── server-error-context.txt  # CI context (auto-populated, gitignored)
└── docs/
    └── ARCHITECTURE.md    # Detailed architecture documentation
```

## Support

- **Issues**: Open an issue in this repository
- See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines
