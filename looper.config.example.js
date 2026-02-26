/**
 * Looper Configuration — Example
 *
 * Copy this file to looper.config.js and fill in your values.
 *
 *   cp looper.config.example.js looper.config.js
 *
 * looper.config.js is .gitignored and will not be committed.
 */

module.exports = {
  // ─── Target Repository ──────────────────────────────────────────────────────
  repo: {
    // Absolute path to the repo looper should operate on
    root: process.env.LOOPER_REPO_ROOT || '/path/to/your/repo',
    // The primary integration branch (e.g., 'main' or 'master')
    mainBranch: 'main',
    // GitHub owner/org and repo name (used for PR links, CODEOWNERS, etc.)
    owner: 'your-org',
    name: 'your-repo',
  },

  // ─── Environment ────────────────────────────────────────────────────────────
  env: {
    // Set to true if your repo uses Hermit (https://cashapp.github.io/hermit/)
    // for managing tool versions. This adds ${repo.root}/bin to PATH.
    hermit: false,
  },

  // ─── AI Model ───────────────────────────────────────────────────────────────
  ai: {
    // OpenAI model identifier. Requires OPENAI_API_KEY in .env
    model: 'gpt-4o',
  },

  // ─── Test Runners ───────────────────────────────────────────────────────────
  test: {
    // Which test runners are active: ['vitest'], ['jest'], or ['jest', 'vitest']
    runners: ['jest', 'vitest'],
    // Base vitest command (looper appends per-file args)
    vitestCommand: 'yarn run test:vitest --run',
    // Base jest command (looper appends per-file args). Leave empty if not used.
    jestCommand: 'npx jest',
  },

  // ─── Test Timezone ──────────────────────────────────────────────────────────
  // Timezone used for Jest test commands (TZ="...")
  // Set to your project's canonical timezone, or '' to use system default.
  timezone: 'UTC',

  // ─── Default App ────────────────────────────────────────────────────────────
  // If your repo is a monorepo with multiple apps, set the primary app name here.
  // Used for E2E tag resolution, branch naming, etc.
  defaultApp: 'app',

  // ─── Lint / ESLint ──────────────────────────────────────────────────────────
  lint: {
    // Command to run ESLint
    command: 'npm run lint',
    // Command to run ESLint in quiet JSON mode (for parsing errors)
    quietCommand: 'npm run lint -- --quiet -f json',
    // Command to prune stale suppressions (if applicable)
    pruneCommand: '',
    // Filename for ESLint suppressions (leave empty if not used)
    suppressionsFile: '',
    // Name of the i18n static-keys ESLint rule that must never be eslint-disabled.
    // Leave empty if your project doesn't have one.
    i18nRule: '',
  },

  // ─── E2E / Playwright Testing ───────────────────────────────────────────────
  e2e: {
    // Make target to run E2E tests via docker-compose
    makeTarget: 'test:e2e',
    // Make target to build E2E images locally (fallback when ECR unavailable)
    buildTarget: 'test:e2e:build',
    // Docker compose file for E2E test infra
    dockerComposeFile: 'docker-compose.test.yml',
    // Default BROWSER_ENV for E2E tests
    defaultBrowserEnv: 'ci-local',
    // Default tags for smoke tests
    defaultSmokeTags: '@smoke',
    // Default tags for general E2E
    defaultTags: '@e2e',
    // Source-path → E2E tag mapping. Maps file path patterns to Playwright tags.
    // Order matters — more specific patterns first.
    tagMap: [
      // Example:
      // { pattern: /\/auth\/|Login\./i, tags: ['@e2e_auth'] },
      // { pattern: /\/payments\//i, tags: ['@e2e_payments'] },
    ],
    // Fallback tag when no tagMap entry matches
    fallbackTag: '@smoke',
  },

  // ─── AWS / ECR (for pulling private Docker images) ──────────────────────────
  // Only needed if your E2E tests pull images from a private ECR registry.
  // Leave empty/null if not applicable.
  aws: {
    profile: '',
    region: '',
    ecrUrl: '',
    authCommand: '',
    authCommandSkipPrompt: '',
    ecrLoginCommand: '',
  },

  // ─── Branch Naming ──────────────────────────────────────────────────────────
  branches: {
    // Regex patterns that identify looper-created PR branches
    patterns: [
      /^feat\/auto-fix-/,
      /^fix\/lint-/,
    ],
    // Functions that generate branch names for different fix types
    prefixes: {
      i18n: (scope, name, timestamp) => `feat/${scope}/static-i18n-keys-${name}-${timestamp}`,
      i18nBatch: (scope, component, timestamp, index) => `feat/${scope}/static-i18n-keys-${component}-${timestamp}-${index}`,
      autoFix: (timestamp) => `feat/auto-fix-${timestamp}`,
    },
  },

  // ─── PR Templates ──────────────────────────────────────────────────────────
  pr: {
    // Markdown checklist appended to every PR description.
    // Customize with your team's review requirements.
    checklist: [
      '',
      '**Checklist:**',
      '- [ ] Changes are tested',
      '- [ ] Includes unit tests (or not applicable)',
      '- [ ] Code has been reviewed',
    ].join('\n'),
  },

  // ─── CI Detection Patterns ─────────────────────────────────────────────────
  ci: {
    // Pattern in container names that indicates a CI container for this repo
    containerPattern: '',
    // Strings that identify Playwright CI jobs (matched against check names/logs)
    playwrightJobPatterns: ['playwright', 'e2e'],
  },

  // ─── Skip Paths ─────────────────────────────────────────────────────────────
  // Regex matching file paths that should never be processed by fixer agents
  skipPathPatterns: /^(node_modules|dist|build|\.next|\.git|coverage)[\/]/,
};
