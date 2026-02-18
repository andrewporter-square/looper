# Looper Architecture

## Overview

Looper is an AI-powered automated code fixer that operates on the Rocketship TypeScript/React monorepo. It identifies lint violations, type errors, and test failures, then uses an LLM agent to generate and validate fixes — all within an automated pipeline that creates branches and PRs.

## System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        LOOPER                               │
│                                                             │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │ list.json│──▶│ Orchestrator │──▶│  AI Fixer Agent   │    │
│  │ (input)  │   │              │   │  (OpenAI GPT)     │    │
│  └──────────┘   │  --parallel  │   │                   │    │
│                 │  --batch     │   │ Tools:             │    │
│                 │  --auto-fix  │   │  read_file         │    │
│                 └──────┬───────┘   │  write_file        │    │
│                        │           │  run_command        │    │
│                        │           │  list_files         │    │
│                        ▼           └────────┬───────────┘    │
│                 ┌──────────────┐            │                │
│                 │  Validation  │◀───────────┘                │
│                 │  ESLint      │                             │
│                 │  TypeScript  │──▶ Re-run agent if errors   │
│                 │  Jest/Vitest │                             │
│                 └──────┬───────┘                             │
│                        │                                     │
│                        ▼                                     │
│                 ┌──────────────┐                             │
│                 │  Git + GitHub│                             │
│                 │  commit/push │                             │
│                 │  gh pr create│                             │
│                 └──────────────┘                             │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ check-prs.js                                         │   │
│  │  Monitor PRs → Check CI → Fetch logs → Fix failures  │   │
│  │  Read review comments → Triage → Re-run fixer agent  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│  Rocketship Repo │          │    GitHub API     │
│  (local clone)   │          │  PRs, checks,     │
│  git worktrees   │          │  comments, runs   │
└──────────────────┘          └──────────────────┘
```

## Core Components

### 1. Orchestrators (`index.js`)

Three modes of operation, all reading from `list.json`:

| Mode | Function | Concurrency | Branch Strategy |
|---|---|---|---|
| `--parallel` | `runParallelFixer()` | N workers via worktrees | One branch per file |
| `--batch` | `runBatchFixer()` | Sequential | Single branch for all files |
| `--auto-fix` | `runTestFixer()` | Sequential | User-managed branch |

**Parallel mode** is the primary production mode. It:
1. Creates N git worktrees from `master`
2. Symlinks `node_modules` from the main repo (avoids N × `yarn install`)
3. Spawns worker processes (`--worker` flag) that run independently
4. Each worker commits + pushes + creates a PR

### 2. AI Fixer Agent

The fixer functions (`fixLintErrorsForFile`, `fixTypeErrorsForFile`, `fixTestErrorsForFile`) each run an agentic loop:

```
System prompt (rules + patterns + examples)
     + File content + Error output + Context
          ↓
     OpenAI API call
          ↓
     Tool calls (read_file, write_file, run_command)
          ↓
     Re-validation (eslint / tsc / jest)
          ↓
     Loop until clean or max steps reached
```

**Key design choice**: The agent has full read/write access to the repo via tools, but the orchestrator controls the git workflow. The agent never commits or pushes.

### 3. PR Health Checker (`check-prs.js`)

Post-PR monitoring pipeline:

```
List open PRs (gh pr list)
     ↓
Check CI status per PR (gh pr checks)
     ↓
For failures:
  ├── "Description too short" → Auto-fix description + re-trigger
  ├── GitHub Actions failures → Fetch logs → AI analysis → Fix
  └── Buildkite failures → Log description only (no API integration yet)
     ↓
Fetch review comments (gh api)
     ↓
AI triage: actionable? safe to fix?
     ↓
If safe → Write context → Spawn fixer worker → Push → Comment on PR
```

## Data Flow

### Input
- `list.json`: Array of repo-relative file paths to process
- `.env`: Configuration (API key, repo path)
- `server-error-context.txt`: Optional extra context for the AI agent
- `i18n-static-keys-research-MEGA.md`: Per-file research notes

### Output
- Git branches with fixed code
- GitHub PRs with description and labels
- `.pr-{number}-logs.txt` files (CI failure logs, gitignored)

### Context Injection

The AI agent receives context from multiple sources:
1. **System prompt**: Fix strategies, patterns, style guide (hardcoded in `index.js`)
2. **File content**: The actual source file being fixed
3. **Error output**: ESLint/tsc/Jest output
4. **Research doc**: Matched sections from `i18n-static-keys-research-MEGA.md`
5. **Server context**: `server-error-context.txt` (CI logs, review comments)

## Security Considerations

- **API keys**: Stored in `.env` (gitignored), never logged
- **Repo access**: Uses local git + `gh` CLI auth, no stored tokens
- **AI scope**: The agent can read/write files within `LOOPER_REPO_ROOT` only
- **Push safety**: Always uses `--no-verify` to skip hooks, but relies on CI for validation
- **No auto-merge**: PRs are always created as open, requiring human review

## Operational Notes

- **Rate limits**: OpenAI API calls are sequential per worker. Parallel mode with 3 workers = ~3x API usage.
- **Worktree cleanup**: `runParallelFixer` cleans up worktrees on exit. If the process is killed, run `git worktree prune` in the Rocketship repo.
- **Branch naming**: `feat/{scope}/static-i18n-keys-{component}-{timestamp}-{index}` or `fix/lint-{component}-{timestamp}`
