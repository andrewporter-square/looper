# Looper: AI-Powered Automated Code Fixer

## Presentation Guide — Technical Deep Dive

---

## 1. What Is Looper?

Looper is an autonomous AI coding agent that fixes lint violations, TypeScript type errors, failing unit tests, and E2E test failures across your target monorepo. It creates branches, applies fixes, validates them through multiple CI-equivalent checks, and opens pull requests — fully automated, end to end.

**Key stats:**
- ~4,300 lines of Node.js (single-file architecture: `index.js`)
- ~1,700 lines for PR health monitoring (`check-prs.js`)
- Uses OpenAI GPT-5.2 as the AI backbone
- Processes files in parallel via git worktrees
- Full CI pipeline reproduction: ESLint → Jest → Vitest → TypeScript → Playwright E2E
- Integrates with GitHub API, Buildkite API, and Docker

**Core thesis:** Deterministic orchestration + AI-powered fixing. The pipeline logic (branching, testing, committing) is deterministic Node.js. The AI is scoped to a constrained tool-use loop for code editing only — it never touches git or CI directly.

---

## 2. The Problem

Your target repo is typically a large TypeScript/React monorepo (e.g., Yarn workspaces). Maintaining it involves:

- **ESLint rule migrations** — especially your custom i18n ESLint rule (configurable in `looper.config.js`), which requires converting dynamic i18n keys (`t(\`key.${var}\`)`) into static ones using declarative mappings. Each file takes 30–90 minutes *manually* depending on complexity.
- **Suppression file management** — `eslint-suppressions.json` (configurable) must stay in sync with actual lint errors. CI rejects mismatches.
- **Test churn** — lint fixes change component output (e.g., new translation keys), breaking snapshot tests, unit tests, and E2E tests.
- **Type ripple effects** — changing an interface or enum in one file causes cascade type errors across imports.
- **PR maintenance** — after opening a PR, CI failures and review comments require additional fix cycles.

At scale (100+ files to migrate), manual fixing is infeasible.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          LOOPER CLI                                  │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Parallel     │  │  Batch       │  │  Auto-Fix    │              │
│  │  Orchestrator │  │  Orchestrator│  │  Pipeline    │              │
│  │  (worktrees)  │  │  (sequential)│  │  (full CI)   │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         └──────────────────┴──────────────────┘                      │
│                            │                                         │
│  ┌─────────────────────────▼─────────────────────────┐              │
│  │              AI Fixer Agent (OpenAI GPT-5.2)       │              │
│  │  5 tools: read_file, write_file, run_command,      │              │
│  │           search_files, list_files                  │              │
│  │  Loop: error → AI fix → re-validate (max 50 iters) │              │
│  └────────────────────────────────────────────────────┘              │
│                            │                                         │
│  ┌─────────────────────────▼──────────────────────────┐             │
│  │            Formatting Pipeline                      │             │
│  │  formatFile()         — per-write (prettier+eslint) │             │
│  │  formatChangedFiles() — pre-commit (3-step)         │             │
│  │  formatBranchFiles()  — pre-push (batch of 20)      │             │
│  └─────────────────────────────────────────────────────┘             │
│                            │                                         │
│  ┌──────────────────────────────────────────────────────┐           │
│  │              Git & GitHub & Buildkite                  │           │
│  │  Branch management, commit, push, PR creation          │           │
│  │  CI log fetching, review comment handling               │           │
│  └──────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

**Design principle:** Single-file architecture. `index.js` is one ~4,300-line file — intentionally. It reads top-to-bottom as a complete pipeline, with no module abstraction overhead. This makes it trivially auditable and debuggable.

---

## 4. Execution Modes

### 4.1 Parallel Fixer (`--parallel`)

The production workhorse. Processes N files concurrently, each in an isolated git worktree.

```
list.json → [file1, file2, file3, ...]
                ↓
    ┌───────────┼───────────┐
    ▼           ▼           ▼
 Worktree 1  Worktree 2  Worktree 3    (git worktree add)
    │           │           │
    ▼           ▼           ▼
 Worker 1    Worker 2    Worker 3       (node index.js --worker)
    │           │           │
    ▼           ▼           ▼
 Branch 1    Branch 2    Branch 3       (independent branches)
    │           │           │
    ▼           ▼           ▼
  PR #1       PR #2       PR #3        (gh pr create)
```

**Key implementation details:**
- `LOOPER_CONCURRENCY` controls parallelism (default: 3)
- Worktrees share `node_modules` via symlink (avoids N × `yarn install`)
- Each worker is a separate `node` process with env vars: `LOOPER_WORKER_FILE`, `LOOPER_WORKER_BRANCH`, `LOOPER_REPO_ROOT`
- Worktrees are cleaned up on exit; if killed, run `git worktree prune`

### 4.2 Auto-Fix Pipeline (`--auto-fix`)

The full CI-equivalent pipeline for a single branch. This is what `check-prs.js --fix` spawns per failing PR.

```
1. Pre-flight        → stash dirty work, ensure not on master
2. Merge master      → git merge origin/master -X theirs
3. yarn install      → safeYarnInstall() (restores package.json if yarn modifies it)
4. CI context        → gatherPRCIContext() from Buildkite + GitHub Actions
5. Jest discovery    → npx jest --json --outputFile=jest-results.json
6. Vitest discovery  → yarn test:vitest --run --reporter=json
7. Pre-exist filter  → skip failures that also fail on master
8. Fix each test     → fixTestErrorsForFile() AI loop per failing suite
9. Global lint       → yarn lint:js -f json → fixLintErrorsForFile() per file
10. Type check       → npx tsc --noEmit per package → fixTypeErrorsForFile()
11. Prune supprs.    → eslint --prune-suppressions
12. Format branch    → formatBranchFiles() (prettier + eslint on all branch diffs)
13. E2E tests        → Playwright in Docker (unless --skip-e2e)
14. Commit & push    → git commit --no-verify → git push → gh pr create/edit
```

### 4.3 Batch Fixer (`--batch`)

Sequential processing of `list.json` on a single branch. Creates one PR with all fixes. Used for testing/development.

### 4.4 E2E Runner (`--e2e`)

Standalone Playwright E2E execution with intelligent tag auto-detection from changed files.

### 4.5 PR Health Checker (`--check-prs`)

Monitors all open looper PRs, checks CI status, and auto-fixes failures:
- `--fix`: spawns `node index.js --auto-fix --skip-e2e` per failing PR
- `--fix-comments`: reads review comments, triages them via AI, and applies fixes

---

## 5. The AI Fixer Agent — Deep Dive

### 5.1 Architecture

The agent is an OpenAI function-calling loop. It is **not** a chat conversation — it's a structured tool-use loop with a constrained tool set.

**Model:** `gpt-5.2-2025-12-11`

**Tools available to the agent:**

| Tool | Description | Safety |
|---|---|---|
| `read_file` | Read file content (supports line ranges) | Read-only |
| `write_file` | Write complete file content | Guarded: blocks `package.json`, `yarn.lock` |
| `search_files` | Grep across the repo (regex, glob filters) | Read-only |
| `list_files` | List directory contents | Read-only |
| `run_command` | Execute shell commands in repo root | Uses Hermit env |

**Guard rails:**
- `write_file` blocks writes to `package.json`, `yarn.lock`, and lock files
- Every `write_file` triggers `formatFile()` (prettier + eslint `--fix`)
- `run_command` uses Hermit-managed Node/yarn (not system versions)
- Max 50 iterations per fixer loop (90 for E2E)
- Context window management: token estimation + message pruning at ~100K tokens
- "UNFIXABLE" escape hatch: agent can declare a problem unfixable to avoid infinite loops

### 5.2 Four Fixer Specializations

Each has a custom system prompt with domain-specific strategies:

**1. `fixLintErrorsForFile()`**
- Pre-runs `eslint --fix --quiet` for trivially auto-fixable rules
- Pre-runs `eslint --prune-suppressions` to remove stale entries
- Pre-gathers: file imports, tsconfig location, i18n research context
- **Dynamic key tracing:** detects `t(\`key.${var}\`)` patterns, resolves the variable's TypeScript type, and provides the full enum/union type definition to the agent
- System prompt includes pattern-specific strategies for your custom i18n ESLint rule (configurable in `looper.config.js`), import ordering, `no-unused-vars`, etc.

**2. `fixTypeErrorsForFile()`**
- Runs `npx tsc --noEmit` scoped to the file's package
- Traces type dependencies: if `Foo` has an error, reads `Foo`'s type definition from its source
- System prompt emphasizes: fix the source, not the types; don't use `@ts-ignore`; trace the chain

**3. `fixTestErrorsForFile()`**
- Supports both Jest and Vitest (detected per test file)
- Runs the specific test file in isolation: `npx jest <file> --json` or `yarn vitest run <file>`
- System prompt: understand what the test expects → read the source → fix source OR test
- Snapshot handling: detects snapshot mismatches and updates them via `--updateSnapshot`

**4. `fixE2EFailures()`**
- Parses `playwright-report/results.json` for structured failures
- Reads: failing test code, changed source files, git diffs
- Pre-existing failure detection: compares test file content between branch and master
- Strategy: E2E tests are ground truth — fix source code, never modify test files
- Max 3 re-run attempts after each fix to verify

### 5.3 Context Injection

The agent receives multi-layered context:

```
┌────────────────────────────────────┐
│  System Prompt                      │  Fix strategies, patterns,
│  (hardcoded per specialization)     │  coding style rules
├────────────────────────────────────┤
│  File Content                       │  The actual source being fixed
│  (read at start, refreshed on edit) │
├────────────────────────────────────┤
│  Error Output                       │  ESLint/tsc/Jest/Vitest/Playwright
│  (re-collected each iteration)      │  errors for the specific file
├────────────────────────────────────┤
│  Research Doc                       │  Matched sections from
│  (i18n-static-keys-research-MEGA.md)│  per-file analysis notes
├────────────────────────────────────┤
│  CI Context (CI_CONTEXT)            │  Buildkite + GitHub Actions
│  (gathered from PR's failed checks) │  failure logs, annotations
├────────────────────────────────────┤
│  Dynamic Type Research              │  TypeScript type definitions
│  (traced from dynamic key patterns) │  for variables used in t()
└────────────────────────────────────┘
```

### 5.4 Context Window Management

Long-running fix loops can exceed the model's context window. Looper handles this:

1. **Token estimation:** `estimateTokens()` approximates tokens at ~3.5 chars/token
2. **Pruning threshold:** 100,000 tokens triggers pruning
3. **Strategy:** Keep system prompt + initial user message + last 20 messages. Middle messages are summarized — count of write attempts, last failure errors, and count of successes.
4. **Result:** Agent continues from the pruned context with a "Continue fixing from where you left off" instruction.

---

## 6. Formatting Pipeline

A triple-layer defense against formatting regressions:

### Layer 1: `formatFile(path)` — Per Write

After every `write_file` tool call:
```bash
prettier --write <file>
eslint <file> --fix --prune-suppressions
```

Why: AI-generated code often has slightly wrong formatting — expanded imports, ternaries that prettier wants on one line, trailing whitespace.

### Layer 2: `formatChangedFiles()` — Pre Commit

Before every `git commit`:
```bash
git diff --name-only HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'   # collect changed files
prettier --write <files>
eslint <files> --fix --prune-suppressions                      # fix + remove stale suppressions
eslint <files> --suppress-all                                  # add entries for remaining errors
```

Why: Ensures `eslint-suppressions.json` (configurable) stays perfectly in sync. CI runs `yarn lint:js` with `--verify-suppressions` and rejects stale or missing entries.

### Layer 3: `formatBranchFiles()` — Pre Push

Before `git push`:
```bash
git diff --name-only origin/master...HEAD -- '*.ts' '*.tsx'    # all files changed on branch
# Process in batches of 20:
prettier --write <batch>
eslint <batch> --fix --prune-suppressions
# If anything changed:
eslint <all branch files> --suppress-all
git commit -m "fix: auto-format branch files (prettier + eslint)"
```

Why: Catches formatting issues in *already-committed* code — e.g., files committed before the formatting pipeline existed.

---

## 7. ESLint Suppression Strategy

Your repo uses `eslint-suppressions.json` (configurable) to incrementally adopt new lint rules. CI enforces that this file is in sync:

**Old approach (before Looper):** Manual JSON editing — find the file's entry, remove it, fix errors, re-add remaining errors. Error-prone, especially at scale.

**Looper's approach:** Uses ESLint's native `--prune-suppressions` and `--suppress-all` flags:

| Flag | What It Does |
|---|---|
| `--prune-suppressions` | Removes suppression entries for rules that no longer have violations in a file |
| `--suppress-all` | Adds suppression entries for any current violations |

Applied at every stage: per-file format, pre-commit, and pre-push. The suppression file is always in perfect sync.

---

## 8. CI Context Gathering

### `gatherPRCIContext()`

When running `--auto-fix`, looper fetches failure details from the branch's PR before fixing:

```
1. gh pr view <branch> → get PR number, check status
2. Filter to failed/errored/timed_out checks
3. For each failed check:
   ├── GitHub Actions?
   │   ├── gh api .../annotations → structured error messages
   │   └── gh run view --log-failed → full job output
   └── Buildkite?
       ├── REST API → /builds/<id> → build state, failed jobs
       └── REST API → /jobs/<id>/log → full job log (up to 2MB)
4. extractErrorSections() → scan logs for error patterns
   (stack traces, assertion failures, compile errors)
   → return most relevant 12KB per job
5. Total context capped at 40KB
```

This context is injected into the AI system prompt so the fixer knows *exactly* what CI is complaining about — not just local test failures, but CI-specific issues (environment differences, missing mocks, different Node versions, etc.).

### `check-prs.js` Context Relay

When `check-prs.js --fix` processes a PR:
1. Fetches CI failure logs for that PR
2. Writes them to `server-error-context.txt`
3. Spawns `node index.js --auto-fix --skip-e2e`
4. `index.js` reads `server-error-context.txt` and includes it in the agent's context

---

## 9. Pre-existing Failure Detection

Not all test failures are caused by the branch. Looper filters them:

### Unit/Integration Tests

```javascript
// For each failing test:
const testChanged = changedByBranch.includes(task.filePath);
const sourceChanged = changedByBranch.some(f =>
  f.startsWith(sourceBase + '.') ||        // PayMonthlySummary.tsx for PayMonthlySummary.test.tsx
  (f.startsWith(testDir + '/') && !isTest)  // other source files in same dir
);
const pkgChanged = changedByBranch.some(f => f.startsWith(testPkg + '/'));

if (testChanged || sourceChanged || pkgChanged) → fix it
else → skip (pre-existing)
```

### E2E Tests

- Checks if E2E test file diffs exist between branch and master
- If test files are identical to master, failures are pre-existing
- Domain-matching heuristic: `test.includes('summary') && file.includes('summary')`

**Impact:** Prevents wasting API tokens and time on failures that aren't the branch's fault. Common in large monorepos where master can have flaky tests.

---

## 10. E2E Testing Integration

### Tag Resolution

Looper auto-detects which Playwright E2E suites to run based on what files changed:

```javascript
const TAG_MAP = [
  { pattern: /paymentMethod|PaymentMethod|creditCard|CreditCard/i,
    tags: ['@app_regression_payment_method'] },
  { pattern: /\/login\/|\/auth\/|Login\./i,
    tags: ['@app_regression_au_login'] },
  { pattern: /consumerLending|ConsumerLending|PaymentPlan/i,
    tags: ['@app_regression_cl_us'] },
  // ... 20+ patterns
];
// Fallback: @app_smoke
```

### Docker Mode

E2E tests run in Docker to match CI's environment:
1. Check Docker is running
2. Authenticate AWS/ECR (configurable AWS auth, e.g., `saml2aws login`, `aws sso`) for image pulls
3. Run via `make playwright-local-tests` with correct env vars
4. Parse `playwright-report/results.json` for structured failures

### Failure Fixing

Structured failures from Playwright JSON are fed to `fixE2EFailures()`:
```
For each failure:
  testFile: "browser/scenarios/myapp/summary.spec.ts"
  testTitle: "displays total amount"
  error: "Expected 'A$24.00' but received 'A$0.00'"
  errorContext: <page snapshot HTML>
```

The agent reads the test, reads the changed source files, and fixes the source code to restore expected behavior.

---

## 11. PR Health Checker — The Outer Loop

`check-prs.js` is the outer automation loop that monitors PRs after they're created:

```
                    ┌─────────────────────┐
                    │  Looper creates PRs  │
                    │  (--parallel/batch)  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  CI runs on PRs      │
                    │  (Buildkite, GHA)    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  check-prs.js --fix  │ ◀── Runs periodically or on-demand
                    │                      │
                    │  For each failing PR: │
                    │  1. Fetch CI logs     │
                    │  2. Write context     │
                    │  3. Spawn auto-fix    │
                    │  4. Push fixes        │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  CI re-runs          │
                    │  (hopefully passes)  │
                    └─────────────────────┘
```

### PR Description Auto-Fix

CI rejects PRs with short descriptions. Looper generates detailed descriptions by:
1. Getting the full `git diff` for the branch
2. Sending it to GPT-5.2 with a prompt: "Write a PR description explaining WHAT changed and WHY"
3. Appending the standard PR checklist
4. Updating the PR via `gh pr edit`

### Review Comment Handling

When reviewers leave comments, `check-prs.js --fix-comments`:
1. Fetches all review comments via `gh api`
2. Sends each to AI for triage: "Is this actionable? Is it safe to auto-fix?"
3. If actionable and safe: apply the fix, commit, push, reply to the comment
4. If not safe: skip and leave for human review

---

## 12. Hermit Environment Management

If your repo uses Hermit for Node.js version management, Looper handles this by setting a custom `REPO_ENV`:

```javascript
const REPO_ENV = {
  ...process.env,
  PATH: `${REPO_ROOT}/node_modules/.bin:${REPO_ROOT}/bin:${process.env.PATH}`,
  HERMIT_BIN: `${REPO_ROOT}/bin`,
  HERMIT_ENV: REPO_ROOT,
};
```

All `exec()` calls in the repo use `REPO_ENV`, ensuring `vitest`, `jest`, `eslint`, `prettier`, `tsc`, and `yarn` resolve to Hermit-managed binaries rather than system-installed versions.

---

## 13. Safety & Guard Rails

| Mechanism | Purpose |
|---|---|
| `write_file` guards | Blocks writes to `package.json`, `yarn.lock`, lock files |
| `--no-verify` commits | Skips git hooks (speed), relies on CI for validation |
| No auto-merge | PRs always require human review |
| Pre-existing filter | Avoids fixing failures that aren't the branch's fault |
| Max iterations | 50 per lint/type/test loop, 90 for E2E, 3 E2E re-run attempts |
| Context pruning | Prevents token overflow and infinite loops |
| `UNFIXABLE` escape | Agent can declare a problem unfixable to break the loop |
| `formatFile()` auto-format | Every agent write is immediately formatted — prevents formatting regressions |
| `safeYarnInstall()` | Restores `package.json` from git if `yarn install` modifies it |
| `SKIP_PATH_PATTERNS` | Ignores `.hermit/`, `node_modules/`, `dist/`, etc. |

---

## 14. Key Design Decisions

### Why single-file?

`index.js` is one 4,300-line file. This is intentional:
- Top-to-bottom readability — the entire pipeline is in one scroll
- No import chains to trace
- `grep` works perfectly
- When handing off to AI for modification, the entire context fits in one file
- CommonJS (`require`/`module.exports`) — no ESM complexity

### Why AI is the fixer, not the orchestrator?

The orchestration (branching, test execution, commit, push) is deterministic. If a merge conflict occurs, there's a deterministic strategy (`-X theirs`). The AI only handles the part that requires reasoning — reading error messages and figuring out what code change will fix them.

This means:
- Pipeline bugs are reproducible and debuggable
- AI failures are isolated to individual fix attempts
- The rest of the system continues working even if the AI produces garbage

### Why three formatting layers?

Early versions had formatting regressions slip through. AI-generated code would pass lint but fail prettier, or leave stale suppression entries. The triple-layer approach is defensive-in-depth:
- Layer 1 catches issues at write time
- Layer 2 catches issues at commit time
- Layer 3 catches issues in *already-committed* code from earlier in the session

### Why ESLint native flags instead of JSON manipulation?

The old approach:
```javascript
const suppressions = JSON.parse(fs.readFileSync('eslint-suppressions.json'));
delete suppressions['path/to/file.tsx'];
fs.writeFileSync('eslint-suppressions.json', JSON.stringify(suppressions));
```

Problems: race conditions with parallel workers, missed entries when rules are renamed, partial deletions when a file has multiple suppressed rules.

The new approach: `eslint --prune-suppressions` and `--suppress-all` let ESLint itself manage the JSON. More reliable, atomic, and handles all edge cases.

### Why spawn `index.js` from `check-prs.js` instead of importing?

`check-prs.js --fix` spawns `node index.js --auto-fix --skip-e2e` as a child process rather than importing and calling `runTestFixer()` directly. This:
- Isolates memory and state between PRs
- Gets a fresh `process.env` per PR
- Streams output in real-time
- Means there's one source of truth for the fix pipeline
- Avoids complex cleanup between sequential PR fixes

---

## 15. Technology Stack

| Component | Technology |
|---|---|
| Language | Node.js (CommonJS) |
| AI Model | OpenAI GPT-5.2 (`gpt-5.2-2025-12-11`) |
| Terminal Colors | chalk v4 (CommonJS-compatible) |
| Environment | dotenv for `.env` loading |
| Git | Native git CLI via `child_process.exec` |
| GitHub | `gh` CLI for PR ops, `gh api` for REST |
| Buildkite | REST API v2 with Bearer token auth |
| E2E Tests | Playwright (running in Docker) |
| Unit Tests | Jest + Vitest (both supported) |
| Lint | ESLint with custom rules |
| Formatting | Prettier + ESLint `--fix` |
| Type Checking | TypeScript `tsc --noEmit` |
| AWS Auth | Configurable AWS auth (e.g., `saml2aws`, `aws sso`) for ECR image pulls |

---

## 16. Operational Metrics & Constraints

- **OpenAI API usage:** Sequential per worker. 3 parallel workers = ~3× API cost.
- **Token budget per fix:** ~100K token context window, with pruning. Typical lint fix: 5–15K tokens. Complex type error: 30–60K tokens.
- **Max iterations:** 50 per fixer loop. Most fixes complete in 3–10 iterations.
- **E2E test time:** 3–15 minutes per run (Docker build + test execution).
- **Full pipeline time:** 10–45 minutes per branch depending on test suite size and number of failures.
- **Worktree overhead:** negligible (symlinked `node_modules`), ~100ms creation time.

---

## 17. Future Directions

- **Auto-merge with confidence scoring** — gate merges on fix confidence, test coverage delta, and file scope
- **Metrics/telemetry** — track fix success rates, token usage, and time-to-fix per error type
- **Web dashboard** — real-time PR health monitoring with fix status
- **Model selection** — configurable model per task (cheaper models for simple lint, stronger for type errors)
- **Retry logic** — transient OpenAI API error handling with exponential backoff

---

## Appendix A: CLI Reference

```bash
# Core modes
node index.js --parallel              # Parallel fixer (N worktrees)
node index.js --batch                 # Sequential batch fixer
node index.js --auto-fix              # Full pipeline on current branch
node index.js --auto-fix --skip-e2e   # Full pipeline without E2E
node index.js --e2e                   # E2E test runner

# E2E options
node index.js --e2e --e2e-tags=@app_smoke
node index.js --e2e --e2e-native     # Without Docker
node index.js --e2e --e2e-headed     # Show browser
node index.js --e2e --no-fix         # Don't auto-fix failures

# PR health checker
node check-prs.js                    # List all looper PRs
node check-prs.js --fix              # Fix CI failures (full pipeline)
node check-prs.js --fix-comments     # Fix review comment feedback
node check-prs.js --author @me       # Filter by author
node check-prs.js --label myapp      # Filter by label

# Interactive
node index.js                        # Chat agent for ad-hoc tasks
```

## Appendix B: Environment Variables

```bash
OPENAI_API_KEY=sk-...           # Required: OpenAI API key
LOOPER_REPO_ROOT=/path/to/your-repo   # Path to local repo clone
LOOPER_CONCURRENCY=3            # Number of parallel workers
BUILDKITE_TOKEN=bkua_...        # Buildkite API token (for CI log fetching)
```

## Appendix C: File Layout

```
looper/
├── index.js                     # Core engine (~4,300 lines)
├── check-prs.js                 # PR health monitoring (~1,700 lines)
├── list.json                    # Input: file paths to process
├── server-error-context.txt     # CI context (auto-populated)
├── notes.md                     # AI fixer style guide
├── i18n-static-keys-research-MEGA.md  # Per-file research notes
├── package.json                 # Dependencies: openai, chalk, dotenv
├── .env                         # API keys and config (gitignored)
├── docs/
│   ├── ARCHITECTURE.md          # System architecture
│   └── PRESENTATION.md          # This document
├── CONTRIBUTING.md              # Contributing guidelines
└── README.md                    # User-facing documentation
```
