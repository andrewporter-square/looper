#!/usr/bin/env node

/**
 * check-prs.js — Looper PR Health Checker
 *
 * Scans open PRs created by looper (matching the branch naming convention),
 * checks CI status, fetches failure logs, and optionally triggers auto-fixes.
 *
 * Usage:
 *   node check-prs.js                  # list & check all looper PRs
 *   node check-prs.js --fix            # fix CI failures + review comments
 *   node check-prs.js --fix-comments   # only fix review comment feedback
 *   node check-prs.js --author @me     # filter by author (default: @me)
 *   node check-prs.js --label checkout # filter by label
 */

require('dotenv').config();
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const OpenAI = require('openai');

const REPO_ROOT = process.env.LOOPER_REPO_ROOT || '/Users/aporter/Development/rocketship';
const MAIN_BRANCH = 'master';

const REPO_ENV = {
  ...process.env,
  PATH: `${REPO_ROOT}/node_modules/.bin:${REPO_ROOT}/bin:${process.env.PATH}`,
  HERMIT_BIN: `${REPO_ROOT}/bin`,
  HERMIT_ENV: REPO_ROOT,
};

// Branch patterns that indicate a looper-created PR
const LOOPER_BRANCH_PATTERNS = [
  /^feat\/.*\/static-i18n-keys-/,
  /^feat\/auto-fix-/,
  /^fix\/lint-/,
  /^feat\/core\/static-i18n-keys-/,
];

function isLooperBranch(branchName) {
  return LOOPER_BRANCH_PATTERNS.some(re => re.test(branchName));
}

async function runCommand(command, cwd = REPO_ROOT) {
  const env = (cwd === REPO_ROOT || cwd.startsWith(REPO_ROOT)) ? REPO_ENV : undefined;
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 1024 * 1024 * 10, timeout: 300000, env }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? error.message : null,
      });
    });
  });
}

// PR checklist (same as index.js)
const PR_CHECKLIST = [
  '',
  '**Checklist (all items to be checked before merging or put reason why in brackets):**',
  '- [ ] Changes are tested',
  '- [ ] Includes unit tests and feature flags (or not applicable)',
  "- [ ] I've masked consumer privacy data in Datadog by `MaskedElement` (e.g. credit card number, consumer name, email address), some fields may be masked by [Datadog](https://docs.datadoghq.com/real_user_monitoring/session_replay/privacy_options/) by default",
  "- [ ] I've adopted standard practices according to [these guidelines](https://github.com/AfterpayTouch/rocketship/blob/master/docs/standard-practices.md) and agree to monitor the [#rocketship-alerts-dev](https://square.slack.com/archives/C034LH11K4Y) channel for broken builds. Broken builds caused by this pull request merge should be fixed by the original contributor. Reach out to [#rocketship-dev-team](https://square.slack.com/archives/C033Q541WS2) if you have questions.",
  "- [ ] I've confirmed the changes do not affect regulatory product such as Pay Monthly. If it is Pay Monthly changes, it is an approved change and the changes are applied behind feature flags.",
].join('\n');

// Build a proper PR body for a looper branch
function buildPRBody(pr, changedFiles) {
  const fileListMarkdown = changedFiles.map(f => `- \`${f}\``).join('\n');
  return [
    '## Summary',
    '',
    'Replace dynamic i18n key construction with static string literals to satisfy the `@afterpay/i18n-only-static-keys` ESLint rule.',
    '',
    'All translation keys passed to `t()` are now statically analyzable, enabling reliable key extraction and dead-key detection.',
    '',
    '## Changes',
    '',
    fileListMarkdown || '- See commit diff',
    '',
    '## What was done',
    '',
    '- Replaced dynamic template literal keys with static string literals',
    '- Used declarative Record maps to enumerate all possible translation keys per enum/type',
    '- Removed corresponding entries from `eslint-suppressions.json`',
    '- Preserved all existing runtime behavior — no logic changes',
    '',
    '## Testing',
    '',
    '- ESLint passes with no `@afterpay/i18n-only-static-keys` violations',
    '- All existing tests pass',
    '- TypeScript type checking passes',
  ].join('\n') + PR_CHECKLIST;
}

// ─── Fix PR description ─────────────────────────────────────────────────────

async function fixPRDescription(pr) {
  console.log(chalk.yellow(`\n  📝 Fixing PR description for #${pr.number}...`));

  // Get the changed files for this PR
  const diffResult = await runCommand(
    `gh pr diff ${pr.number} --name-only`,
    REPO_ROOT
  );
  const changedFiles = diffResult.success
    ? diffResult.stdout.trim().split('\n').filter(Boolean)
    : [];

  const newBody = buildPRBody(pr, changedFiles);

  // Write to temp file to avoid shell escaping issues
  const bodyFile = path.join(__dirname, `.pr-body-fix-${pr.number}.md`);
  fs.writeFileSync(bodyFile, newBody, 'utf8');

  const editResult = await runCommand(
    `gh pr edit ${pr.number} --body-file "${bodyFile}"`,
    REPO_ROOT
  );

  try { fs.unlinkSync(bodyFile); } catch (_) {}

  if (editResult.success) {
    console.log(chalk.green(`  ✅ PR #${pr.number} description updated.`));

    // Re-run the failed checks by pushing an empty commit or requesting re-run
    const rerunResult = await runCommand(
      `gh pr checks ${pr.number} --json name,link --jq '.[] | select(.name == "Validate pull request") | .link' 2>/dev/null`,
      REPO_ROOT
    );
    const runLink = rerunResult.stdout.trim();
    const runIdMatch = runLink.match(/\/actions\/runs\/(\d+)/);
    if (runIdMatch) {
      const rerun = await runCommand(`gh run rerun ${runIdMatch[1]}`, REPO_ROOT);
      if (rerun.success) {
        console.log(chalk.green(`  🔄 Re-triggered "Validate pull request" check.`));
      } else {
        console.log(chalk.yellow(`  ⚠️ Could not re-trigger check. You may need to re-run manually or push a commit.`));
      }
    }
    return true;
  } else {
    console.log(chalk.red(`  ✗ Failed to update PR description: ${editResult.stderr.slice(0, 300)}`));
    return false;
  }
}

// Check if a failure is a "description too short" error
function isDescriptionTooShortFailure(check, logData) {
  const combined = `${check.name} ${check.description || ''} ${logData?.logs || ''}`.toLowerCase();
  return combined.includes('description') && (combined.includes('too short') || combined.includes('empty'));
}

// ─── List open looper PRs ───────────────────────────────────────────────────

async function listLooperPRs({ author, label }) {
  let cmd = `gh pr list --state open --json number,title,headRefName,url,statusCheckRollup,createdAt,author --limit 100`;
  if (author) cmd += ` --author "${author}"`;
  if (label) cmd += ` --label "${label}"`;

  const result = await runCommand(cmd, REPO_ROOT);
  if (!result.success) {
    console.error(chalk.red(`Failed to list PRs: ${result.stderr.slice(0, 500)}`));
    return [];
  }

  try {
    const allPRs = JSON.parse(result.stdout);
    // Filter to looper-created branches only (unless label is specified, in which case trust it)
    return label ? allPRs : allPRs.filter(pr => isLooperBranch(pr.headRefName));
  } catch (e) {
    console.error(chalk.red(`Failed to parse PR list: ${e.message}`));
    return [];
  }
}

// ─── Check CI status for a PR ───────────────────────────────────────────────

async function getPRChecks(prNumber) {
  const result = await runCommand(
    `gh pr checks ${prNumber} --json name,state,link,description --required 2>/dev/null || gh pr checks ${prNumber} --json name,state,link,description`,
    REPO_ROOT
  );

  if (!result.success) {
    // Fallback: use statusCheckRollup already fetched, or try alternative
    const viewResult = await runCommand(
      `gh pr view ${prNumber} --json statusCheckRollup`,
      REPO_ROOT
    );
    if (viewResult.success) {
      try {
        const data = JSON.parse(viewResult.stdout);
        return (data.statusCheckRollup || []).map(c => ({
          name: c.name || c.context || 'unknown',
          state: (c.conclusion || c.state || 'PENDING').toUpperCase(),
          link: c.targetUrl || c.detailsUrl || '',
          description: c.description || '',
        }));
      } catch (_) {}
    }
    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    return null;
  }
}

function classifyCheckState(state) {
  const s = (state || '').toUpperCase();
  if (['SUCCESS', 'PASS', 'NEUTRAL', 'SKIPPED'].includes(s)) return 'pass';
  if (['FAILURE', 'FAIL', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE'].includes(s)) return 'fail';
  return 'pending';
}

// ─── Fetch web page content (for CI failure pages) ─────────────────────────

function stripHtmlToText(html, maxChars = 30000) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')  // remove scripts
    .replace(/<style[\s\S]*?<\/style>/gi, '')    // remove styles
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')        // remove nav
    .replace(/<header[\s\S]*?<\/header>/gi, '')  // remove header
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')  // remove footer
    .replace(/<[^>]+>/g, ' ')                     // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')                      // collapse whitespace
    .replace(/(\n\s*){3,}/g, '\n\n')              // collapse blank lines
    .trim();
  return text.slice(0, maxChars);
}

async function fetchWebPageContent(url, maxChars = 30000) {
  if (!url) return null;
  try {
    console.log(chalk.dim(`      Fetching page: ${url.slice(0, 120)}...`));

    // For GitHub URLs, use `gh api` or `gh` CLI which inherits gh auth credentials
    if (url.includes('github.com')) {
      // Convert GitHub web URLs to API calls where possible
      const actionsRunMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
      if (actionsRunMatch) {
        const [, owner, repo, runId] = actionsRunMatch;
        // Fetch the run details via gh api (authenticated automatically)
        const result = await runCommand(
          `gh api repos/${owner}/${repo}/actions/runs/${runId} --jq '{status, conclusion, name: .name, html_url: .html_url, run_attempt: .run_attempt}'`,
          REPO_ROOT
        );
        // Also get the failed job logs
        const logsResult = await runCommand(
          `gh run view ${runId} --repo ${owner}/${repo} --log-failed 2>&1 | tail -300`,
          REPO_ROOT
        );
        const combined = [
          result.success ? result.stdout : '',
          logsResult.success ? logsResult.stdout : '',
        ].filter(Boolean).join('\n');
        if (combined.trim().length > 50) return combined.slice(0, maxChars);
      }

      // For other GitHub pages (e.g. check suite pages), use gh api with raw accept
      const apiPath = url.replace(/https?:\/\/github\.com/, '').replace(/^\/+/, '/');
      // Try fetching as API path — this won't always work but is worth trying
      const ghResult = await runCommand(
        `gh api "${apiPath}" 2>/dev/null | head -500`,
        REPO_ROOT
      );
      if (ghResult.success && ghResult.stdout.trim().length > 50) {
        return ghResult.stdout.slice(0, maxChars);
      }
    }

    // For Buildkite URLs, use BUILDKITE_TOKEN if available
    // For other CI providers, try common token env vars
    const authHeaders = {};
    if (url.includes('buildkite.com') && process.env.BUILDKITE_TOKEN) {
      authHeaders['Authorization'] = `Bearer ${process.env.BUILDKITE_TOKEN}`;
    } else if (url.includes('circleci.com') && process.env.CIRCLECI_TOKEN) {
      authHeaders['Circle-Token'] = process.env.CIRCLECI_TOKEN;
    } else if (process.env.GITHUB_TOKEN && url.includes('github.com')) {
      authHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    // Fallback: raw fetch (works for public pages and when tokens are provided)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html, application/json, text/plain',
        'User-Agent': 'looper-ci-checker/1.0',
        ...authHeaders,
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.log(chalk.dim(`      HTTP ${response.status} for ${url.slice(0, 80)}`));
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    if (contentType.includes('application/json')) {
      return body.slice(0, maxChars);
    }

    return stripHtmlToText(body, maxChars);
  } catch (err) {
    console.log(chalk.dim(`      Failed to fetch page: ${err.message}`));
    return null;
  }
}

// ─── Fetch GitHub Actions annotations (concise error summaries) ─────────────

async function getRunAnnotations(runId) {
  // Annotations are the most useful summaries — they contain the actual error lines
  const result = await runCommand(
    `gh api repos/{owner}/{repo}/actions/runs/${runId}/annotations --paginate --jq '.[] | {message: .message, annotation_level: .annotation_level, path: .path, start_line: .start_line, title: .title}' 2>/dev/null || echo ''`,
    REPO_ROOT
  );

  if (!result.success || !result.stdout.trim()) return [];

  const annotations = [];
  for (const line of result.stdout.trim().split('\n')) {
    try {
      const a = JSON.parse(line);
      if (a.message) annotations.push(a);
    } catch (_) {}
  }
  return annotations;
}

// ─── Fetch CI logs for a failing check ──────────────────────────────────────

async function getFailedRunLogs(prNumber, check) {
  // Try to get the run ID from the check link
  // GitHub Actions URLs look like: https://github.com/ORG/REPO/actions/runs/12345/job/67890
  const runIdMatch = (check.link || '').match(/\/actions\/runs\/(\d+)/);
  if (!runIdMatch) {
    // Not a GitHub Actions run (could be an external CI)
    // Try to fetch the actual web page for this check
    const pageContent = await fetchWebPageContent(check.link);
    if (pageContent && pageContent.length > 50) {
      return { source: 'web-page', logs: `Check: ${check.name}\nURL: ${check.link}\n\n${pageContent}` };
    }
    return { source: 'description', logs: check.description || 'No logs available (external check)' };
  }

  const runId = runIdMatch[1];

  // First, try to get annotations (most concise and useful error info)
  const annotations = await getRunAnnotations(runId);
  let annotationLogs = '';
  if (annotations.length > 0) {
    annotationLogs = '\n═══ Annotations ═══\n' + annotations.map(a =>
      `[${a.annotation_level}] ${a.path || ''}${a.start_line ? `:${a.start_line}` : ''} — ${a.title || ''}\n${a.message}`
    ).join('\n\n');
  }

  // Get the failed jobs for this run
  const jobsResult = await runCommand(
    `gh run view ${runId} --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name: .name, id: .databaseId}'`,
    REPO_ROOT
  );

  if (!jobsResult.success || !jobsResult.stdout.trim()) {
    // Fallback: get the full run log (truncated)
    const logResult = await runCommand(
      `gh run view ${runId} --log-failed 2>&1 | tail -200`,
      REPO_ROOT
    );
    let logs = logResult.stdout || logResult.stderr || 'No logs retrieved';

    // If CLI logs are thin, try the web page
    if (logs.trim().split('\n').length < 10) {
      const pageContent = await fetchWebPageContent(check.link);
      if (pageContent && pageContent.length > 100) {
        logs += '\n\n═══ Web Page Content ═══\n' + pageContent;
      }
    }

    return { source: 'run-log', logs: annotationLogs + '\n' + logs };
  }

  // Parse failed jobs and get their logs
  const lines = jobsResult.stdout.trim().split('\n');
  const allLogs = [];

  for (const line of lines) {
    try {
      const job = JSON.parse(line);
      const jobLogResult = await runCommand(
        `gh run view ${runId} --log-failed --job ${job.id} 2>&1 | tail -150`,
        REPO_ROOT
      );
      allLogs.push(`\n═══ Job: ${job.name} ═══\n${jobLogResult.stdout || jobLogResult.stderr}`);
    } catch (_) {
      // Might not be valid JSON; try to extract as plain text
      allLogs.push(line);
    }
  }

  if (allLogs.length === 0) {
    const fallbackLog = await runCommand(
      `gh run view ${runId} --log-failed 2>&1 | tail -300`,
      REPO_ROOT
    );
    let logs = fallbackLog.stdout || fallbackLog.stderr || 'No logs retrieved';

    // Supplement with web page if logs are sparse
    if (logs.trim().split('\n').length < 10) {
      const pageContent = await fetchWebPageContent(check.link);
      if (pageContent && pageContent.length > 100) {
        logs += '\n\n═══ Web Page Content ═══\n' + pageContent;
      }
    }

    return { source: 'run-log-fallback', logs: annotationLogs + '\n' + logs };
  }

  // Append annotation summaries to job logs
  return { source: 'job-logs', logs: annotationLogs + allLogs.join('\n') };
}

// ─── Fix a failing PR ───────────────────────────────────────────────────────

async function fixFailingPR(pr, failedChecks, failureLogs) {
  console.log(chalk.yellow(`\n  🔧 Attempting to fix PR #${pr.number}: ${pr.title}`));

  // Checkout the branch
  const branch = pr.headRefName;
  await runCommand(`git fetch origin ${branch}`, REPO_ROOT);
  await runCommand(`git checkout ${branch}`, REPO_ROOT);
  await runCommand(`git pull origin ${branch} --no-edit`, REPO_ROOT);

  // Determine what files were changed in this PR
  const changedResult = await runCommand(
    `git diff --name-only origin/${MAIN_BRANCH}...HEAD`,
    REPO_ROOT
  );
  const changedFiles = changedResult.stdout.trim().split('\n').filter(Boolean);
  const tsFiles = changedFiles.filter(f => /\.(tsx?|jsx?)$/.test(f));

  // Combine all failure context
  const failureContext = failedChecks.map((check, i) => {
    const logEntry = failureLogs[i];
    return `### Check: ${check.name} (${check.state})\nLink: ${check.link || 'N/A'}\n\n${logEntry?.logs || 'No logs'}\n`;
  }).join('\n---\n');

  // Use OpenAI to analyze and fix
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Read the changed files
  const fileContents = {};
  for (const f of tsFiles.slice(0, 10)) {
    const fullPath = path.join(REPO_ROOT, f);
    if (fs.existsSync(fullPath)) {
      fileContents[f] = fs.readFileSync(fullPath, 'utf8');
    }
  }

  const fileContentsSummary = Object.entries(fileContents)
    .map(([f, c]) => `--- ${f} ---\n${c}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `You are a Senior Software Engineer fixing CI failures on a TypeScript/React monorepo PR.

The PR branch is: ${branch}
Changed files: ${changedFiles.join(', ')}

Your job is to analyze the CI failure logs and determine what needs to be fixed.
Output a JSON object with this schema:
{
  "analysis": "Brief description of what's failing and why",
  "fixable": true/false,
  "fixes": [
    {
      "file": "relative/path/to/file.ts",
      "description": "What to change",
      "search": "exact text to find (multi-line ok)",
      "replace": "exact replacement text"
    }
  ]
}

RULES:
- Only output the JSON object, no markdown fences or commentary.
- "search" must be an exact substring of the current file content.
- If you can't determine a fix from the logs, set fixable to false with an explanation in analysis.
- Preserve runtime behavior; only fix the CI issue.
- Common issues: lint errors, type errors, test failures from changed translations/logic.`,
    },
    {
      role: 'user',
      content: `## CI Failure Logs\n\n${failureContext}\n\n## Changed File Contents\n\n${fileContentsSummary}`,
    },
  ];

  try {
    console.log(chalk.gray('  Analyzing failures with AI...'));
    const response = await client.chat.completions.create({
      model: 'gpt-5.2-2025-12-11',
      messages,
      temperature: 0,
      max_tokens: 4096,
    });

    const content = response.choices[0].message.content.trim();

    let result;
    try {
      // Strip markdown fences if present
      const jsonStr = content.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '');
      result = JSON.parse(jsonStr);
    } catch (e) {
      console.log(chalk.red(`  Failed to parse AI response: ${e.message}`));
      console.log(chalk.dim(`  Raw response: ${content.slice(0, 500)}`));
      return false;
    }

    console.log(chalk.cyan(`  Analysis: ${result.analysis}`));

    if (!result.fixable || !result.fixes || result.fixes.length === 0) {
      console.log(chalk.yellow(`  AI determined this is not auto-fixable.`));
      return false;
    }

    // Apply fixes
    let appliedCount = 0;
    for (const fix of result.fixes) {
      const filePath = path.join(REPO_ROOT, fix.file);
      if (!fs.existsSync(filePath)) {
        console.log(chalk.red(`  File not found: ${fix.file}`));
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes(fix.search)) {
        console.log(chalk.red(`  Search string not found in ${fix.file}: "${fix.search.slice(0, 80)}..."`));
        continue;
      }

      const newContent = content.replace(fix.search, fix.replace);
      fs.writeFileSync(filePath, newContent, 'utf8');
      console.log(chalk.green(`  ✅ Applied fix to ${fix.file}: ${fix.description}`));
      appliedCount++;
    }

    if (appliedCount === 0) {
      console.log(chalk.yellow(`  No fixes could be applied.`));
      return false;
    }

    // Re-run lint on changed files to validate
    console.log(chalk.yellow(`  Validating fixes...`));
    const eslintBin = path.join('node_modules', '.bin', 'eslint');
    for (const f of tsFiles) {
      const lintResult = await runCommand(`${eslintBin} "${f}" --quiet`, REPO_ROOT);
      if (!lintResult.success) {
        console.log(chalk.yellow(`  ⚠️ Lint still failing on ${f} — skipping commit`));
        await runCommand(`git checkout -- .`, REPO_ROOT);
        return false;
      }
    }

    // Commit and push
    await runCommand(`git add .`, REPO_ROOT);
    await runCommand(`git checkout HEAD -- package.json yarn.lock 2>/dev/null || true`, REPO_ROOT);
    const commitResult = await runCommand(
      `git commit --no-verify -m "fix: address CI failures" -m "Auto-fix applied by looper PR health checker based on CI failure logs."`,
      REPO_ROOT
    );
    if (!commitResult.success) {
      console.log(chalk.yellow(`  Nothing to commit (fixes may have been no-ops).`));
      return false;
    }

    const pushResult = await runCommand(
      `git push --no-verify origin HEAD:refs/heads/${branch}`,
      REPO_ROOT
    );
    if (pushResult.success) {
      console.log(chalk.bold.green(`  🚀 Fix pushed to ${branch}. CI should re-run.`));
      return true;
    } else {
      console.log(chalk.red(`  Push failed: ${pushResult.stderr.slice(0, 300)}`));
      return false;
    }
  } catch (e) {
    console.log(chalk.red(`  AI fix failed: ${e.message}`));
    return false;
  }
}

// ─── Fetch PR review comments ───────────────────────────────────────────────

async function fetchPRComments(prNumber) {
  // Get both review comments (on code) and issue comments (on the PR itself)
  const [reviewResult, issueResult] = await Promise.all([
    runCommand(
      `gh api repos/{owner}/{repo}/pulls/${prNumber}/comments --paginate --jq '.[] | {id: .id, path: .path, line: .line, body: .body, user: .user.login, created_at: .created_at, diff_hunk: .diff_hunk}' 2>/dev/null || echo '[]'`,
      REPO_ROOT
    ),
    runCommand(
      `gh pr view ${prNumber} --json comments --jq '.comments[] | {id: .id, body: .body, author: .author.login, createdAt: .createdAt}'`,
      REPO_ROOT
    ),
  ]);

  const comments = { review: [], issue: [] };

  // Parse review comments (line-level code comments)
  if (reviewResult.success && reviewResult.stdout.trim()) {
    for (const line of reviewResult.stdout.trim().split('\n')) {
      try {
        const c = JSON.parse(line);
        if (c.body) comments.review.push(c);
      } catch (_) {}
    }
  }

  // Parse issue-level comments
  if (issueResult.success && issueResult.stdout.trim()) {
    for (const line of issueResult.stdout.trim().split('\n')) {
      try {
        const c = JSON.parse(line);
        if (c.body) comments.issue.push(c);
      } catch (_) {}
    }
  }

  return comments;
}

// ─── Analyze and fix from PR review comments ────────────────────────────────

async function analyzeAndFixFromComments(pr, comments) {
  const allComments = [
    ...comments.review.map(c => ({
      type: 'code_review',
      file: c.path || null,
      line: c.line || null,
      author: c.user,
      body: c.body,
      diff_hunk: c.diff_hunk || null,
    })),
    ...comments.issue.map(c => ({
      type: 'pr_comment',
      file: null,
      line: null,
      author: c.author,
      body: c.body,
    })),
  ];

  if (allComments.length === 0) return { hasComments: false };

  // Filter out bot comments and our own automated comments
  const humanComments = allComments.filter(c => {
    const author = (c.author || '').toLowerCase();
    const body = (c.body || '').toLowerCase();
    // Skip bots, automated messages
    if (author.includes('bot') || author.includes('[bot]')) return false;
    if (body.startsWith('auto-fix applied') || body.startsWith('looper')) return false;
    return true;
  });

  if (humanComments.length === 0) return { hasComments: false };

  // Format comments for display and AI analysis
  const commentsSummary = humanComments.map(c => {
    const location = c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : 'PR-level';
    return `[${c.type}] @${c.author} on ${location}:\n${c.body}${c.diff_hunk ? `\nCode context:\n${c.diff_hunk}` : ''}`;
  }).join('\n\n---\n\n');

  return { hasComments: true, humanComments, commentsSummary };
}

async function fixFromComments(pr, commentData) {
  console.log(chalk.yellow(`\n  💬 Analyzing ${commentData.humanComments.length} review comment(s) on PR #${pr.number}...`));

  const branch = pr.headRefName;

  // Get changed files
  const diffResult = await runCommand(`gh pr diff ${pr.number} --name-only`, REPO_ROOT);
  const changedFiles = diffResult.success ? diffResult.stdout.trim().split('\n').filter(Boolean) : [];
  const tsFiles = changedFiles.filter(f => /\.(tsx?|jsx?)$/.test(f));

  // Use AI to triage which comments are actionable code fixes
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const triageResponse = await client.chat.completions.create({
    model: 'gpt-5.2-2025-12-11',
    temperature: 0,
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content: `You are a code review assistant. Analyze PR review comments and determine which ones are requesting actionable code changes that can be safely auto-fixed.

A comment is actionable if it:
- Requests a specific code change (rename, refactor, fix a bug, add handling)
- Points out incorrect logic, missing edge cases, or type errors
- Suggests style/formatting improvements
- Asks to revert an unintended behavior change

A comment is NOT actionable if it:
- Is just asking a question or seeking clarification
- Is giving a general approval (LGTM, looks good, etc.)
- Is about process (please rebase, add tests, etc.) without specific code changes
- Is a meta-comment about the PR itself

For each actionable comment, identify the file(s) affected.

Output JSON:
{
  "actionable": true/false,
  "summary": "Brief summary of what reviewers are asking for",
  "items": [
    {
      "comment_index": 0,
      "file": "path/to/file.ts",
      "description": "What needs to change",
      "safe_to_autofix": true/false,
      "reason": "Why it is/isn't safe"
    }
  ]
}

Only include items that are actionable. Set actionable to false if none are.`,
      },
      {
        role: 'user',
        content: `PR: ${pr.title}\nBranch: ${branch}\nChanged files: ${changedFiles.join(', ')}\n\n## Review Comments\n\n${commentData.commentsSummary}`,
      },
    ],
  });

  let triage;
  try {
    const raw = triageResponse.choices[0].message.content.trim();
    const jsonStr = raw.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '');
    triage = JSON.parse(jsonStr);
  } catch (e) {
    console.log(chalk.red(`  Failed to parse triage response: ${e.message}`));
    return false;
  }

  console.log(chalk.cyan(`  Triage: ${triage.summary}`));

  if (!triage.actionable || !triage.items || triage.items.length === 0) {
    console.log(chalk.dim(`  No actionable comments found.`));
    return false;
  }

  const safeItems = triage.items.filter(item => item.safe_to_autofix);
  if (safeItems.length === 0) {
    console.log(chalk.yellow(`  ${triage.items.length} actionable comment(s) found, but none deemed safe to auto-fix.`));
    for (const item of triage.items) {
      console.log(chalk.dim(`    ↳ ${item.file || 'general'}: ${item.description} (${item.reason})`));
    }
    return false;
  }

  console.log(chalk.green(`  ${safeItems.length} safe-to-fix comment(s) found:`));
  for (const item of safeItems) {
    console.log(chalk.green(`    ↳ ${item.file || 'general'}: ${item.description}`));
  }

  // Checkout the branch
  await runCommand(`git fetch origin ${branch}`, REPO_ROOT);
  await runCommand(`git checkout ${branch}`, REPO_ROOT);
  await runCommand(`git pull origin ${branch} --no-edit`, REPO_ROOT);

  // Write the review comments as context for the index.js fixer agent
  const contextLines = [
    'PR REVIEW FEEDBACK (from human reviewers — address these issues):',
    '',
    ...safeItems.map((item, i) => {
      const original = commentData.humanComments[item.comment_index];
      return [
        `--- Comment ${i + 1} ---`,
        `File: ${item.file || 'general'}`,
        `Reviewer says: ${original?.body || item.description}`,
        original?.diff_hunk ? `Code context:\n${original.diff_hunk}` : '',
        `Action needed: ${item.description}`,
        '',
      ].filter(Boolean).join('\n');
    }),
  ].join('\n');

  const contextFile = path.resolve(__dirname, 'server-error-context.txt');
  // Preserve any existing context
  const existingContext = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, 'utf8').trim() : '';
  const combinedContext = [existingContext, contextLines].filter(Boolean).join('\n\n');
  fs.writeFileSync(contextFile, combinedContext, 'utf8');

  // Determine which files to re-run through the fixer
  const filesToFix = [...new Set(safeItems.map(i => i.file).filter(Boolean))];

  let fixApplied = false;

  for (const filePath of filesToFix) {
    if (!tsFiles.includes(filePath)) {
      console.log(chalk.dim(`    Skipping ${filePath} (not in PR diff)`));
      continue;
    }

    console.log(chalk.yellow(`\n  🔧 Re-running fixer on ${filePath} with review context...`));

    // Spawn a child process using index.js's worker mode with LOOPER_REPO_ROOT pointing at our checkout
    const result = await new Promise((resolve) => {
      const child = require('child_process').spawn(
        process.execPath,
        [path.join(__dirname, 'index.js'), '--worker'],
        {
          env: {
            ...process.env,
            LOOPER_REPO_ROOT: REPO_ROOT,
            LOOPER_WORKER_FILE: filePath,
            LOOPER_WORKER_BRANCH: branch,
            LOOPER_WORKER_SCOPE: (() => {
              const parts = filePath.split('/');
              return (parts.length >= 2 && ['apps', 'libs', 'packages'].includes(parts[0])) ? parts[1] : 'core';
            })(),
            LOOPER_WORKER_COMPONENT: path.basename(filePath, path.extname(filePath)),
            LOOPER_MAIN_REPO: REPO_ROOT,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: __dirname,
        }
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => console.log(chalk.dim(`    ${line}`)));
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({ success: code === 0, stdout, stderr });
      });

      child.on('error', (err) => {
        resolve({ success: false, stdout: '', stderr: err.message });
      });
    });

    if (result.success) {
      console.log(chalk.green(`  ✅ Fixer completed for ${filePath}`));
      fixApplied = true;
    } else {
      console.log(chalk.red(`  ✗ Fixer failed for ${filePath}`));
    }
  }

  // Restore the context file
  if (existingContext) {
    fs.writeFileSync(contextFile, existingContext, 'utf8');
  } else {
    try { fs.unlinkSync(contextFile); } catch (_) {}
  }

  if (fixApplied) {
    // Leave a comment on the PR noting the fix
    await runCommand(
      `gh pr comment ${pr.number} --body "🤖 **Looper auto-fix**: Applied fixes based on review feedback. Please re-review the changes."`,
      REPO_ROOT
    );
  }

  return fixApplied;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const shouldFix = args.includes('--fix');
  const shouldFixComments = args.includes('--fix-comments') || shouldFix;
  const authorIdx = args.indexOf('--author');
  const author = authorIdx !== -1 ? args[authorIdx + 1] : '@me';
  const labelIdx = args.indexOf('--label');
  const label = labelIdx !== -1 ? args[labelIdx + 1] : null;
  const allBranches = args.includes('--all');

  console.log(chalk.bold.blue('\n🔍 Looper PR Health Checker\n'));
  console.log(chalk.gray(`  Repo: ${REPO_ROOT}`));
  console.log(chalk.gray(`  Author: ${author}`));
  if (label) console.log(chalk.gray(`  Label: ${label}`));
  console.log(chalk.gray(`  Auto-fix: ${shouldFix ? 'enabled' : 'disabled (use --fix to enable)'}`));
  console.log(chalk.gray(`  Fix comments: ${shouldFixComments ? 'enabled' : 'disabled (use --fix or --fix-comments)'}`));
  console.log();

  // Save current branch to restore later
  const currentBranchResult = await runCommand(`git branch --show-current`, REPO_ROOT);
  const originalBranch = currentBranchResult.stdout.trim();

  // Fetch PRs
  let prs = await listLooperPRs({ author, label });

  if (!allBranches && !label) {
    // Already filtered by isLooperBranch
  }

  if (prs.length === 0) {
    console.log(chalk.yellow('  No open looper PRs found.'));
    return;
  }

  console.log(chalk.bold(`Found ${prs.length} open looper PR(s):\n`));

  // Check each PR
  const summary = { pass: [], fail: [], pending: [], noChecks: [] };

  for (const pr of prs) {
    const prLabel = `#${pr.number}`;
    process.stdout.write(chalk.gray(`  Checking ${prLabel}... `));

    const checks = await getPRChecks(pr.number);

    if (!checks || checks.length === 0) {
      console.log(chalk.dim('no checks'));
      summary.noChecks.push(pr);
      continue;
    }

    const failed = checks.filter(c => classifyCheckState(c.state) === 'fail');
    const pending = checks.filter(c => classifyCheckState(c.state) === 'pending');
    const passed = checks.filter(c => classifyCheckState(c.state) === 'pass');

    if (failed.length > 0) {
      console.log(chalk.red(`✗ ${failed.length} failed`) +
        (pending.length > 0 ? chalk.yellow(` / ${pending.length} pending`) : '') +
        chalk.green(` / ${passed.length} passed`));

      pr._failedChecks = failed;
      summary.fail.push(pr);
    } else if (pending.length > 0) {
      console.log(chalk.yellow(`⏳ ${pending.length} pending`) + chalk.green(` / ${passed.length} passed`));
      summary.pending.push(pr);
    } else {
      console.log(chalk.green(`✓ all ${passed.length} checks passed`));
      summary.pass.push(pr);
    }
  }

  // ─── Detailed failure report ─────────────────────────────────────────────

  if (summary.fail.length > 0) {
    console.log(chalk.bold.red(`\n\n━━━ FAILING PRs (${summary.fail.length}) ━━━\n`));

    for (const pr of summary.fail) {
      console.log(chalk.bold.red(`\n  PR #${pr.number}: ${pr.title}`));
      console.log(chalk.dim(`  ${pr.url}`));
      console.log(chalk.dim(`  Branch: ${pr.headRefName}`));
      console.log();

      const failedChecks = pr._failedChecks;
      const failureLogs = [];

      for (const check of failedChecks) {
        console.log(chalk.red(`    ✗ ${check.name}`));
        if (check.link) console.log(chalk.dim(`      ${check.link}`));

        // Fetch logs
        process.stdout.write(chalk.gray(`      Fetching logs... `));
        const logData = await getFailedRunLogs(pr.number, check);
        failureLogs.push(logData);

        // Show a truncated preview
        const logPreview = logData.logs.split('\n').slice(-15).join('\n');
        console.log(chalk.dim(`(${logData.source})`));
        console.log(chalk.dim(logPreview.replace(/^/gm, '        ')));
        console.log();
      }

      // Save logs to file for reference
      const logFile = path.join(__dirname, `.pr-${pr.number}-logs.txt`);
      const fullLog = failedChecks.map((check, i) => {
        return `=== ${check.name} (${check.state}) ===\n${check.link || ''}\n\n${failureLogs[i]?.logs || 'No logs'}\n`;
      }).join('\n' + '─'.repeat(80) + '\n');
      fs.writeFileSync(logFile, fullLog, 'utf8');
      console.log(chalk.dim(`      Full logs saved to: ${logFile}`));

      // Auto-fix "PR description too short" errors
      const hasDescriptionError = failedChecks.some((check, i) => isDescriptionTooShortFailure(check, failureLogs[i]));
      if (hasDescriptionError) {
        const fixed = await fixPRDescription(pr);
        if (fixed) {
          pr._descriptionFixed = true;
        }
      }

      // Attempt auto-fix for code failures if enabled
      if (shouldFix) {
        const codeFailures = failedChecks.filter((check, i) => !isDescriptionTooShortFailure(check, failureLogs[i]));
        if (codeFailures.length > 0) {
          const codeFailureLogs = failedChecks.map((check, i) =>
            isDescriptionTooShortFailure(check, failureLogs[i]) ? null : failureLogs[i]
          ).filter(Boolean);
          await fixFailingPR(pr, codeFailures, codeFailureLogs);
        }
      }
    }
  }

  // ─── Review comment scanning (all PRs) ───────────────────────────────────

  if (shouldFixComments) {
    console.log(chalk.bold.cyan(`\n\n━━━ REVIEW COMMENTS ━━━\n`));

    for (const pr of prs) {
      process.stdout.write(chalk.gray(`  Checking comments on #${pr.number}... `));
      const comments = await fetchPRComments(pr.number);
      const commentData = await analyzeAndFixFromComments(pr, comments);

      if (!commentData.hasComments) {
        console.log(chalk.dim('none'));
        continue;
      }

      console.log(chalk.cyan(`${commentData.humanComments.length} comment(s)`));
      await fixFromComments(pr, commentData);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log(chalk.bold.blue('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold.blue('  PR HEALTH SUMMARY'));
  console.log(chalk.bold.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  if (summary.pass.length > 0) {
    console.log(chalk.green(`  ✅ Passing: ${summary.pass.length}`));
    summary.pass.forEach(pr => console.log(chalk.green(`     #${pr.number} ${pr.title}`)));
  }

  if (summary.pending.length > 0) {
    console.log(chalk.yellow(`\n  ⏳ Pending: ${summary.pending.length}`));
    summary.pending.forEach(pr => console.log(chalk.yellow(`     #${pr.number} ${pr.title}`)));
  }

  if (summary.fail.length > 0) {
    console.log(chalk.red(`\n  ❌ Failing: ${summary.fail.length}`));
    summary.fail.forEach(pr => {
      console.log(chalk.red(`     #${pr.number} ${pr.title}`));
      (pr._failedChecks || []).forEach(c => console.log(chalk.dim(`       ↳ ${c.name}`)));
    });
  }

  if (summary.noChecks.length > 0) {
    console.log(chalk.dim(`\n  ⚪ No checks: ${summary.noChecks.length}`));
    summary.noChecks.forEach(pr => console.log(chalk.dim(`     #${pr.number} ${pr.title}`)));
  }

  console.log();

  // Restore original branch if we switched during --fix or --fix-comments
  if ((shouldFix || shouldFixComments) && originalBranch) {
    await runCommand(`git checkout ${originalBranch}`, REPO_ROOT);
  }
}

main().catch(e => {
  console.error(chalk.red(`Fatal error: ${e.message}`));
  process.exit(1);
});
