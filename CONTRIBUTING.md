# Contributing to Looper

Thanks for your interest in contributing! This document explains how to get set up and contribute effectively.

## Getting Started

1. **Clone the repo** and run `npm install`
2. **Copy `.env.example` to `.env`** and fill in:
   - `OPENAI_API_KEY` — required for all modes
   - `LOOPER_REPO_ROOT` — path to your target repo (or set in looper.config.js)
   - `BUILDKITE_TOKEN` — optional, enables fetching Buildkite CI build logs
3. **Ensure `gh` CLI is authenticated**: `gh auth status`
4. **For E2E testing**: Docker Desktop must be running, and AWS credentials configured (see looper.config.js)

## Development Workflow

### Making Changes

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make your changes
3. Test locally (see below)
4. Open a PR describing what you changed and why

### Testing Locally

Looper doesn't have a formal test suite yet — validation is done by running the tool against real files:

```bash
# Syntax check
node -c index.js && node -c check-prs.js && node -c fix-history.js

# Dry run: put a single file in list.json and run batch mode
echo '["apps/myapp/src/page/example/Example.tsx"]' > list.json
node index.js --batch

# Full pipeline on current branch
node index.js --auto-fix --skip-e2e

# Check PR health (read-only by default)
node check-prs.js

# Run E2E tests against current branch
node index.js --e2e
```

**Tip**: Start with `--batch` mode (sequential, single branch) when testing changes to the fixer logic. Use `--auto-fix --skip-e2e` for testing the full pipeline without waiting for E2E. Only use `--parallel` once you're confident the fix works.

### Code Style

- **No TypeScript** — this is a plain Node.js project for simplicity
- **CommonJS** (`require`/`module.exports`) — no ESM
- **chalk v4** for terminal colors (CommonJS-compatible)
- Keep functions focused and under ~100 lines where possible
- Use `async/await` throughout, never raw callbacks

## Areas to Contribute

### Good First Issues

- Add a `--dry-run` flag to preview what would happen without making changes
- Improve error messages when `gh` CLI is not authenticated
- Add a `--pr-only` flag to `check-prs.js` to check a single PR by number

### Medium Complexity

- Add retry logic for transient OpenAI API errors
- Support configurable OpenAI model selection via env var
- Add a `--report` flag that outputs JSON/CSV summaries
- Improve E2E tag resolution with broader component coverage

### Advanced

- Implement a "confidence score" for AI fixes to gate auto-merging
- Add metrics/telemetry for fix success rates
- Build a web dashboard for PR health monitoring
- Add support for auto-merging PRs when all checks pass

## Key Design Decisions

1. **Single-file architecture**: `index.js` is intentionally one large file (~4300 lines). This makes it easy to read top-to-bottom and understand the full flow. Don't split it into modules unless there's a strong reason. (`fix-history.js` is a notable exception — it was extracted for clean separation of cross-run persistence logic.)

2. **AI is the fixer, not the orchestrator**: The orchestration logic (branch management, test running, PR creation) is deterministic Node.js code. The AI only handles the actual code fixing within a constrained tool loop.

3. **Three-layer formatting pipeline**: `formatFile()` runs after every agent write, `formatChangedFiles()` runs before every commit, and `formatBranchFiles()` runs before push. This catches formatting regressions at every stage.

4. **ESLint native flags over manual JSON**: ESLint's `--prune-suppressions` and `--suppress-all` flags manage `eslint-suppressions.json` instead of manual JSON manipulation. More reliable and handles edge cases.

5. **CI context injection**: Extra context (CI logs, review comments) is gathered via `gatherPRCIContext()` and passed to the fixer agent as a context variable. For `check-prs.js`, context is written to `server-error-context.txt`.

6. **Git worktrees for parallelism**: Instead of multiple clones, we use `git worktree` with symlinked `node_modules` for fast parallel processing.

7. **Pre-existing failure filtering**: Test failures that also occur on master are automatically skipped. This avoids wasting tokens fixing unrelated issues.

8. **check-prs.js spawns the full pipeline**: Instead of reimplementing fix logic, `check-prs.js --fix` spawns `node index.js --auto-fix --skip-e2e` as a child process. One source of truth for the fix pipeline.

9. **Cross-run fix history**: `fix-history.js` persists what was tried and why it failed to `.looper-history.json`. This prevents the AI from repeating the same failed approach across invocations, and lets `check-prs.js` skip branches that have been attempted too many times.

10. **Configurable test runners**: Test runner selection (`test.runners`, `test.jestCommand`, `test.vitestCommand`) lives in `looper.config.js`. Discovery and per-file fixing are conditionally guarded so disabled runners are skipped entirely.

## Submitting PRs

- Keep PRs focused on a single change
- Include a clear description of what changed and why
- If your change affects the fixer agent's behavior, include before/after examples
- Request a review from a maintainer

## Questions?

Open an issue or start a discussion.
