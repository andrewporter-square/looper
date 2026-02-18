# Contributing to Looper

Thanks for your interest in contributing! This document explains how to get set up and contribute effectively.

## Getting Started

1. **Clone the repo** and run `npm install`
2. **Copy `.env.example` to `.env`** and fill in your `OPENAI_API_KEY`
3. **Set `LOOPER_REPO_ROOT`** to your local Rocketship checkout path
4. **Ensure `gh` CLI is authenticated**: `gh auth status`

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
node -c index.js && node -c check-prs.js

# Dry run: put a single file in list.json and run batch mode
echo '["apps/checkout/src/page/example/Example.tsx"]' > list.json
node index.js --batch

# Check PR health (read-only by default)
node check-prs.js
```

**Tip**: Start with `--batch` mode (sequential, single branch) when testing changes to the fixer logic. Only use `--parallel` once you're confident the fix works.

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

- Add Buildkite API integration to `check-prs.js` for fetching build logs
- Add retry logic for transient OpenAI API errors
- Support configurable OpenAI model selection via env var
- Add a `--report` flag that outputs JSON/CSV summaries

### Advanced

- Add support for other ESLint rules beyond `@afterpay/i18n-only-static-keys`
- Implement a "confidence score" for AI fixes to gate auto-merging
- Add metrics/telemetry for fix success rates
- Build a web dashboard for PR health monitoring

## Key Design Decisions

1. **Single-file architecture**: `index.js` is intentionally one large file. This makes it easy to read top-to-bottom and understand the full flow. Don't split it into modules unless there's a strong reason.

2. **AI is the fixer, not the orchestrator**: The orchestration logic (branch management, test running, PR creation) is deterministic Node.js code. The AI only handles the actual code fixing within a constrained tool loop.

3. **Server-error-context.txt as context injection**: Extra context (CI logs, review comments) is passed to the fixer agent via this file. This avoids modifying the core fixer function signatures.

4. **Git worktrees for parallelism**: Instead of multiple clones, we use `git worktree` with symlinked `node_modules` for fast parallel processing.

## Submitting PRs

- Keep PRs focused on a single change
- Include a clear description of what changed and why
- If your change affects the fixer agent's behavior, include before/after examples
- Tag `@aporter` for review

## Questions?

Reach out on [#rocketship-dev-team](https://square.slack.com/archives/C033Q541WS2) or open an issue.
