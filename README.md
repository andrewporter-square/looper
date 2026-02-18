# Looper

**Automated ESLint, TypeScript, and test fixer agent for the Rocketship monorepo.**

Looper uses OpenAI to automatically fix lint violations (especially `@afterpay/i18n-only-static-keys`), TypeScript type errors, and failing tests across the Rocketship codebase. It creates branches, applies fixes, runs validation, and opens PRs — all automated.

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> && cd looper
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your OPENAI_API_KEY and LOOPER_REPO_ROOT

# 3. Add files to fix
echo '["apps/checkout/src/page/example/Example.tsx"]' > list.json

# 4. Run
node index.js --parallel
```

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18+ | Tested on 24.x |
| `gh` CLI | 2.x+ | Authenticated with `gh auth login` |
| Git | 2.30+ | With push access to Rocketship |
| OpenAI API key | — | Needs GPT-4o / GPT-5 access |
| Rocketship repo | — | Cloned locally with `yarn install` done |

## Configuration

All configuration is via environment variables (`.env` file):

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `LOOPER_REPO_ROOT` | No | `/Users/aporter/Development/rocketship` | Path to local Rocketship checkout |
| `LOOPER_CONCURRENCY` | No | `3` | Number of parallel workers for `--parallel` mode |

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
4. Each worker: fixes lint → runs Jest/Vitest → fixes type errors → prunes suppressions → commits → pushes → opens PR
5. Cleans up worktrees

### `--batch` — Sequential Batch Fixer

Processes all files in `list.json` sequentially on a single branch.

```bash
node index.js --batch
```

### `--auto-fix` / `--fix-tests` — Test Fixer

Interactive mode that fixes lint errors, then discovers and fixes failing tests.

```bash
node index.js --auto-fix
```

### `--check-prs` — PR Health Checker

Scans all open looper PRs, checks CI status, fetches failure logs, and optionally auto-fixes issues.

```bash
node check-prs.js                  # List & check all looper PRs
node check-prs.js --fix            # Fix CI failures + review comments
node check-prs.js --fix-comments   # Only fix review comment feedback
node check-prs.js --author @me     # Filter by author (default: @me)
node check-prs.js --label checkout # Filter by label
```

**Features:**
- Detects and auto-fixes "PR description too short" validation errors
- Fetches GitHub Actions failure logs
- Uses AI to analyze and fix code failures
- Reads PR review comments, triages actionable feedback, and applies fixes

### Interactive Agent (default)

A chat-based agent loop for ad-hoc tasks.

```bash
node index.js
```

## File Reference

| File | Purpose |
|---|---|
| `index.js` | Main entry point — all fixer modes, AI agent, tool definitions |
| `check-prs.js` | PR health checker — CI status, log fetching, comment-based fixes |
| `list.json` | Input: array of file paths (relative to repo root) to process |
| `server-error-context.txt` | Optional: extra context injected into the AI fixer prompt |
| `i18n-static-keys-research-MEGA.md` | Research doc with per-file analysis for i18n key migrations |
| `notes.md` | Style guide and coding principles for the fixer agent |

## How the Fixer Agent Works

```
list.json → [file paths] → for each file:
  1. Remove eslint-suppressions.json entry
  2. Run ESLint → collect errors
  3. AI agent reads file + errors + context
  4. Agent uses tools (read_file, write_file, run_command) to fix
  5. Re-lint in a loop (max 50 iterations) until clean
  6. Run Jest/Vitest on related tests → fix failures
  7. Run TypeScript type check → fix errors
  8. Prune suppressions
  9. Commit, push, open PR
```

The AI agent has access to file I/O and shell commands within the repo. It follows a detailed system prompt with pattern-specific fix strategies for `@afterpay/i18n-only-static-keys` and other common ESLint rules.

## Architecture

```
looper/
├── index.js          # Core engine
│   ├── fixLintErrorsForFile()     # AI-powered lint fixer (agentic loop)
│   ├── fixTypeErrorsForFile()     # AI-powered type error fixer
│   ├── fixTestErrorsForFile()     # AI-powered test fixer
│   ├── runParallelFixer()         # Worktree-based parallel orchestrator
│   ├── runBatchFixer()            # Sequential batch orchestrator
│   ├── runTestFixer()             # Test discovery + fix orchestrator
│   ├── runWorkerMode()            # Single-file worker (used by parallel)
│   └── runLoop()                  # Interactive chat agent
├── check-prs.js      # PR health monitoring
│   ├── listLooperPRs()            # Find open looper PRs via gh CLI
│   ├── getPRChecks()              # Fetch CI check status
│   ├── getFailedRunLogs()         # Fetch GitHub Actions failure logs
│   ├── fixPRDescription()         # Auto-fix short PR descriptions
│   ├── fixFailingPR()             # AI-powered CI failure fixer
│   ├── fetchPRComments()          # Fetch review comments
│   └── fixFromComments()          # AI triage + fix from review feedback
└── list.json          # Input file list
```

## Support

- **Slack**: [#rocketship-dev-team](https://square.slack.com/archives/C033Q541WS2)
- **Issues**: Open an issue in this repository
- **PR Reviews**: Tag `@AfterpayTouch/rocketship-checkout` for review
