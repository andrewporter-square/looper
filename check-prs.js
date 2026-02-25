#!/usr/bin/env node

/**
 * check-prs.js — Looper PR Health Checker
 *
 * Scans open PRs created by looper (matching the branch naming convention),
 * checks CI status, fetches failure logs, and optionally triggers auto-fixes.
 *
 * Usage:
 *   node check-prs.js                  # list & check all looper PRs
 *   node check-prs.js --fix            # run full fix pipeline per failing PR (same as index.js --auto-fix)
 *   node check-prs.js --fix-comments   # only fix review comment feedback
 *   node check-prs.js --author @me     # filter by author (default: @me)
 *   node check-prs.js --label checkout # filter by label
 *   node check-prs.js --run-tests      # run playwright tests locally for failing PRs
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

// ─── Load pr.json branch filter ─────────────────────────────────────────────

function loadPRFilter() {
  const filterPath = path.join(__dirname, 'pr.json');
  try {
    const data = JSON.parse(fs.readFileSync(filterPath, 'utf8'));
    if (Array.isArray(data) && data.length > 0) return data;
  } catch (_) {}
  return null;
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

    // If pr.json exists and has entries, use it as the branch filter
    const prFilter = loadPRFilter();
    if (prFilter) {
      console.log(chalk.gray(`  Using pr.json filter (${prFilter.length} branch(es))`));
      return allPRs.filter(pr => prFilter.includes(pr.headRefName));
    }

    // Otherwise fall back to looper branch pattern matching (unless label is specified)
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

// ─── Buildkite API helpers ──────────────────────────────────────────────────

const BUILDKITE_API = 'https://api.buildkite.com/v2';

async function buildkiteApiFetch(apiPath, maxChars = 30000) {
  const token = process.env.BUILDKITE_TOKEN;
  if (!token) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const response = await fetch(`${BUILDKITE_API}${apiPath}`, {
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.log(chalk.dim(`      Buildkite API ${response.status}: ${apiPath.slice(0, 80)}`));
      if (response.status === 403 || response.status === 401) {
        console.log(chalk.dim(`      Token prefix: ${token.slice(0, 8)}... — check token scopes (needs read_builds)`));
        console.log(chalk.dim(`      Response: ${errBody.slice(0, 200)}`));
      }
      return null;
    }
    const body = await response.text();
    return body.slice(0, maxChars);
  } catch (err) {
    console.log(chalk.dim(`      Buildkite API error: ${err.message}`));
    return null;
  }
}

/**
 * Parse a Buildkite web URL and fetch structured logs via the REST API.
 * Supports these URL patterns:
 *   https://buildkite.com/{org}/{pipeline}/builds/{buildNumber}
 *   https://buildkite.com/{org}/{pipeline}/builds/{buildNumber}#job-uuid
 */
async function fetchBuildkiteLogs(url, maxChars = 30000) {
  // Match: buildkite.com/{org}/{pipeline}/builds/{number}
  const buildMatch = url.match(/buildkite\.com\/([^/]+)\/([^/]+)\/builds\/(\d+)/);
  if (!buildMatch) return null;

  const [, org, pipeline, buildNumber] = buildMatch;
  const jobAnchor = url.match(/#([0-9a-f-]{36})/);  // optional #job-uuid anchor

  console.log(chalk.dim(`      Fetching Buildkite build: ${org}/${pipeline}#${buildNumber}`));

  // 1. Fetch the build summary (response can be large due to embedded job data)
  const buildJson = await buildkiteApiFetch(
    `/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}`,
    500000  // build responses can be very large; don't truncate before parsing
  );
  if (!buildJson) return null;

  let build;
  try { build = JSON.parse(buildJson); } catch { return null; }

  const sections = [];
  sections.push(`═══ Buildkite Build #${buildNumber} ═══`);
  sections.push(`Pipeline: ${build.pipeline?.name || pipeline}`);
  sections.push(`State: ${build.state}  |  Branch: ${build.branch}  |  Commit: ${(build.commit || '').slice(0, 12)}`);
  sections.push(`Message: ${build.message || '(none)'}`);
  sections.push(`URL: ${build.web_url || url}`);

  // 2. Find failed jobs (or a specific job if anchor present)
  const jobs = (build.jobs || []).filter(j => j.type === 'script');
  const failedJobs = jobs.filter(j =>
    j.state === 'failed' || j.state === 'timed_out' || j.state === 'canceled'
  );

  // If URL has a #job-uuid anchor, prioritize that specific job
  let targetJobs = failedJobs;
  if (jobAnchor) {
    const anchorJob = jobs.find(j => j.id === jobAnchor[1]);
    if (anchorJob) targetJobs = [anchorJob];
  }

  if (targetJobs.length === 0 && failedJobs.length === 0) {
    sections.push('\nNo failed jobs found in this build.');
    return sections.join('\n').slice(0, maxChars);
  }

  // 3. Fetch logs for each failed job (cap at 5 jobs to avoid excessive API calls)
  const jobsToFetch = targetJobs.slice(0, 5);
  for (const job of jobsToFetch) {
    sections.push(`\n═══ Job: ${job.name || job.label || job.id} (${job.state}) ═══`);

    // Fetch the job log (plain text)
    const logText = await buildkiteApiFetch(
      `/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}/jobs/${job.id}/log`,
      60000  // logs can be big, grab more then truncate
    );

    if (logText) {
      try {
        const logData = JSON.parse(logText);
        const content = logData.content || logData.output || '';
        // Take the last portion of logs (failures are usually at the end)
        const logLines = content.split('\n');
        const tail = logLines.slice(-300).join('\n');
        // Strip ANSI escape codes for readability
        const cleaned = tail.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        sections.push(cleaned);
      } catch {
        // If not JSON, it might be raw text
        const cleaned = logText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        const lines = cleaned.split('\n');
        sections.push(lines.slice(-300).join('\n'));
      }
    } else {
      sections.push('(Could not retrieve job log)');
    }

    // Also include the job's exit status and signal if available
    if (job.exit_status != null) sections.push(`Exit status: ${job.exit_status}`);
    if (job.soft_failed) sections.push('(soft-failed — allowed to fail)');
  }

  if (failedJobs.length > 5) {
    sections.push(`\n... and ${failedJobs.length - 5} more failed jobs (not shown)`);
  }

  return sections.join('\n').slice(0, maxChars);
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

    // For Buildkite URLs, use the Buildkite REST API to get structured build/job data
    if (url.includes('buildkite.com') && process.env.BUILDKITE_TOKEN) {
      const bkResult = await fetchBuildkiteLogs(url, maxChars);
      if (bkResult && bkResult.length > 50) return bkResult;
      // Fall through to generic fetch if API approach didn't work
    }

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

// ─── Playwright test failure detection & analysis ─────────────────────────────

/**
 * Detect whether a CI check failure is a Playwright test failure.
 * Returns the parsed info if it is, or null otherwise.
 */
function isPlaywrightFailure(check, logData) {
  const checkName = (check.name || '').toLowerCase();
  const logs = (logData?.logs || '').toLowerCase();
  const combined = `${checkName} ${logs}`;

  // Detect playwright-related CI jobs
  const isPlaywright = combined.includes('playwright') ||
    combined.includes('.pw.js') ||
    combined.includes('.pw.ts') ||
    combined.includes('playwright-local-tests') ||
    combined.includes('playwright-artefact-wrapper');

  if (!isPlaywright) return null;

  // Extract test file(s) and failure info from logs
  const fullLogs = logData?.logs || '';
  const result = {
    isPlaywright: true,
    checkName: check.name,
    link: check.link,
    failedTests: [],
    tags: null,
    browserEnv: null,
    appName: null,
    timedOut: false,
    errorContextPaths: [],
  };

  // Extract PLAYWRIGHT_TAGS from logs
  const tagsMatch = fullLogs.match(/PLAYWRIGHT_TAGS:\s*(@[\w_]+)/i);
  if (tagsMatch) result.tags = tagsMatch[1];

  // Extract BROWSER_ENV from check name or logs  
  const envMatch = fullLogs.match(/BROWSER_ENV[=:]\s*['"]?([\w-]+)/i);
  if (envMatch) result.browserEnv = envMatch[1];

  // Extract APP_NAME from container name or check name
  const containerMatch = fullLogs.match(/rocketship-ci-(\w+)-/i);
  if (containerMatch) result.appName = containerMatch[1];

  // Extract failed test files
  const testFilePattern = /\d+\s+(browser\/scenarios\/[^\s]+\.pw\.[jt]s):(\d+):\d+\s*›\s*(.+?)\s*›\s*(.+)/g;
  let testMatch;
  while ((testMatch = testFilePattern.exec(fullLogs)) !== null) {
    result.failedTests.push({
      file: testMatch[1],
      line: parseInt(testMatch[2]),
      suite: testMatch[3].trim(),
      name: testMatch[4].trim(),
    });
  }

  // Deduplicate tests (retries produce duplicates)
  const seen = new Set();
  result.failedTests = result.failedTests.filter(t => {
    const key = `${t.file}:${t.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Check for timeout
  result.timedOut = fullLogs.includes('timeout') && fullLogs.includes('exceeded');

  // Extract error-context.md paths
  const contextPattern = /Error Context:\s*([^\n]+error-context\.md)/g;
  let ctxMatch;
  while ((ctxMatch = contextPattern.exec(fullLogs)) !== null) {
    result.errorContextPaths.push(ctxMatch[1].trim());
  }

  // Infer tags from check name if not in logs
  if (!result.tags) {
    const nameTagMatch = checkName.match(/@([\w_]+)/i);
    if (nameTagMatch) result.tags = `@${nameTagMatch[1]}`;
  }

  // Infer app name from tags or check name
  if (!result.appName) {
    if (result.tags?.includes('checkout') || checkName.includes('checkout')) result.appName = 'checkout';
    else if (result.tags?.includes('portal') || checkName.includes('portal')) result.appName = 'portal';
  }

  // Infer browser env
  if (!result.browserEnv) {
    if (result.tags?.includes('_local_')) result.browserEnv = 'ci-local';
  }

  return result;
}

/**
 * Download Buildkite build artifacts for a playwright failure.
 * Returns { errorContexts, testResults } with parsed content.
 */
async function fetchPlaywrightArtifacts(check) {
  const bkMatch = (check.link || '').match(/buildkite\.com\/([^/]+)\/([^/]+)\/builds\/(\d+)/);
  if (!bkMatch || !process.env.BUILDKITE_TOKEN) return null;

  const [, org, pipeline, buildNumber] = bkMatch;
  console.log(chalk.cyan(`      📦 Fetching Playwright artifacts from Buildkite build #${buildNumber}...`));

  // List artifacts for this build
  const artifactListJson = await buildkiteApiFetch(
    `/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}/artifacts`,
    500000
  );
  if (!artifactListJson) {
    console.log(chalk.dim(`      Could not list artifacts.`));
    return null;
  }

  let artifacts;
  try { artifacts = JSON.parse(artifactListJson); } catch { return null; }

  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    console.log(chalk.dim(`      No artifacts found.`));
    return null;
  }

  console.log(chalk.dim(`      Found ${artifacts.length} artifact(s).`));

  const result = { errorContexts: [], testResults: null, traceFiles: [] };

  // Find error-context.md files
  const errorContextArtifacts = artifacts.filter(a =>
    a.filename?.endsWith('error-context.md') || a.path?.includes('error-context.md')
  );

  // Find test-results.json
  const testResultsArtifact = artifacts.find(a =>
    a.filename === 'test-results.json' || a.path?.includes('test-results.json')
  );

  // Find trace files (informational, we can't easily view them but know they exist)
  const traceArtifacts = artifacts.filter(a =>
    a.filename?.endsWith('trace.zip') || a.path?.includes('trace.zip')
  );
  result.traceFiles = traceArtifacts.map(a => a.path || a.filename);

  // Download error-context.md files
  for (const artifact of errorContextArtifacts.slice(0, 5)) {
    const downloadUrl = artifact.download_url;
    if (!downloadUrl) continue;

    try {
      const token = process.env.BUILDKITE_TOKEN;
      const response = await fetch(downloadUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
        redirect: 'follow',
      });
      if (response.ok) {
        const content = await response.text();
        result.errorContexts.push({
          path: artifact.path || artifact.filename,
          content: content.slice(0, 15000),
        });
        console.log(chalk.green(`      ✓ Downloaded: ${artifact.path || artifact.filename}`));
      }
    } catch (err) {
      console.log(chalk.dim(`      Failed to download ${artifact.filename}: ${err.message}`));
    }
  }

  // Download test-results.json
  if (testResultsArtifact?.download_url) {
    try {
      const token = process.env.BUILDKITE_TOKEN;
      const response = await fetch(testResultsArtifact.download_url, {
        headers: { 'Authorization': `Bearer ${token}` },
        redirect: 'follow',
      });
      if (response.ok) {
        const content = await response.text();
        try {
          result.testResults = JSON.parse(content);
          console.log(chalk.green(`      ✓ Downloaded test-results.json`));
        } catch {
          console.log(chalk.dim(`      test-results.json was not valid JSON`));
        }
      }
    } catch (err) {
      console.log(chalk.dim(`      Failed to download test-results.json: ${err.message}`));
    }
  }

  return result;
}

/**
 * Parse a Playwright test-results.json into a human-readable failure summary.
 */
function summarizePlaywrightResults(testResults) {
  if (!testResults?.suites) return null;

  const failures = [];

  function walkSuites(suites, parentTitle = '') {
    for (const suite of suites) {
      const title = parentTitle ? `${parentTitle} › ${suite.title}` : suite.title;
      if (suite.specs) {
        for (const spec of suite.specs) {
          const failedTests = (spec.tests || []).filter(t =>
            t.status === 'unexpected' || t.status === 'failed' || t.status === 'timedOut'
          );
          for (const test of failedTests) {
            const lastResult = test.results?.[test.results.length - 1];
            failures.push({
              title: `${title} › ${spec.title}`,
              file: spec.file || suite.file,
              line: spec.line,
              status: test.status,
              duration: lastResult?.duration,
              error: lastResult?.error?.message || lastResult?.error?.snippet || null,
              retries: (test.results?.length || 1) - 1,
            });
          }
        }
      }
      if (suite.suites) walkSuites(suite.suites, title);
    }
  }

  walkSuites(testResults.suites);

  if (failures.length === 0) return null;

  const lines = [`\n═══ Playwright Test Results Summary ═══`, `${failures.length} test(s) failed:\n`];
  for (const f of failures) {
    lines.push(`  ✗ ${f.title}`);
    if (f.file) lines.push(`    File: ${f.file}${f.line ? `:${f.line}` : ''}`);
    lines.push(`    Status: ${f.status} | Retries: ${f.retries} | Duration: ${f.duration ? Math.round(f.duration / 1000) + 's' : 'unknown'}`);
    if (f.error) {
      const errorPreview = f.error.split('\n').slice(0, 5).join('\n');
      lines.push(`    Error: ${errorPreview}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Run playwright tests locally for a PR branch.
 * Returns { success, output, testResults }
 */
async function runPlaywrightTestsLocally(pwInfo, branch) {
  console.log(chalk.bold.yellow(`\n  🎭 Running Playwright tests locally...`));

  const tags = pwInfo.tags || '@checkout_local_regression_preferred_day';
  const browserEnv = pwInfo.browserEnv || 'ci-local';
  const appName = pwInfo.appName || 'checkout';

  console.log(chalk.gray(`    Tags: ${tags}`));
  console.log(chalk.gray(`    Browser env: ${browserEnv}`));
  console.log(chalk.gray(`    App: ${appName}`));
  console.log(chalk.gray(`    Branch: ${branch}`));

  // Ensure we're on the right branch
  await runCommand(`git fetch origin ${branch}`, REPO_ROOT);
  await runCommand(`git checkout ${branch}`, REPO_ROOT);
  await runCommand(`git pull origin ${branch} --no-edit`, REPO_ROOT);

  // Check Docker is running
  const dockerCheck = await runCommand(`docker info`, REPO_ROOT);
  if (!dockerCheck.success) {
    console.log(chalk.red(`    Docker is not running. Attempting to start...`));
    await runCommand(`open -a Docker`, REPO_ROOT);
    // Wait for Docker to start
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await runCommand(`docker info`, REPO_ROOT);
      if (check.success) break;
      if (i === 29) {
        console.log(chalk.red(`    Docker failed to start after 90s. Cannot run tests.`));
        return { success: false, output: 'Docker not available', testResults: null };
      }
    }
  }

  // Check ECR auth (the images are from a private registry)
  const ecrCheck = await runCommand(`aws sts get-caller-identity`, REPO_ROOT);
  if (!ecrCheck.success) {
    console.log(chalk.yellow(`    ⚠️  AWS credentials not available. Attempting ECR login...`));
    // Try to login via the ecr plugin approach used in CI
    const ecrLogin = await runCommand(
      `aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 361053881171.dkr.ecr.ap-southeast-2.amazonaws.com 2>&1`,
      REPO_ROOT
    );
    if (!ecrLogin.success) {
      console.log(chalk.red(`    Cannot authenticate to ECR. Run 'aws configure' or set AWS credentials first.`));
      console.log(chalk.dim(`    The playwright tests need Docker images from ECR (checkout, mocks, landing).`));
      console.log(chalk.dim(`    Alternatively, use 'make playwright-local-tests-build' to build images locally.`));
      return { success: false, output: 'ECR auth failed', testResults: null };
    }
  }

  // Run the tests
  console.log(chalk.yellow(`    Running: make playwright-local-tests ...`));
  console.log(chalk.dim(`    This typically takes 2-5 minutes.\n`));

  const testResult = await runCommand(
    `BROWSER_ENV=${browserEnv} PLAYWRIGHT_TAGS='${tags}' APP_NAME=${appName} /usr/bin/make playwright-local-tests 2>&1`,
    REPO_ROOT
  );

  const output = testResult.stdout + testResult.stderr;

  // Try to read test-results.json from the output directory
  let testResults = null;
  const resultsPath = path.join(REPO_ROOT, 'test/__output__/playwright/test-results.json');
  if (fs.existsSync(resultsPath)) {
    try {
      testResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    } catch (_) {}
  }

  // Try to read error-context.md files
  const errorContexts = [];
  const resultsDir = path.join(REPO_ROOT, 'test/__output__/playwright/results');
  if (fs.existsSync(resultsDir)) {
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(fullPath);
        else if (entry.name === 'error-context.md') {
          try {
            errorContexts.push({
              path: path.relative(REPO_ROOT, fullPath),
              content: fs.readFileSync(fullPath, 'utf8').slice(0, 15000),
            });
          } catch (_) {}
        }
      }
    };
    walkDir(resultsDir);
  }

  if (testResult.success) {
    console.log(chalk.bold.green(`\n  ✅ Playwright tests PASSED locally!`));
  } else {
    console.log(chalk.bold.red(`\n  ❌ Playwright tests FAILED locally.`));

    // Show test results summary
    if (testResults) {
      const summary = summarizePlaywrightResults(testResults);
      if (summary) console.log(chalk.red(summary));
    }

    // Show error contexts
    if (errorContexts.length > 0) {
      console.log(chalk.cyan(`\n  📋 Error Context(s):`));
      for (const ctx of errorContexts) {
        console.log(chalk.dim(`\n  --- ${ctx.path} ---`));
        console.log(chalk.dim(ctx.content.replace(/^/gm, '    ')));
      }
    }

    // Show output tail
    const outputLines = output.split('\n');
    const tail = outputLines.slice(-30).join('\n');
    console.log(chalk.dim(`\n  --- Last 30 lines of output ---`));
    console.log(chalk.dim(tail.replace(/^/gm, '    ')));
  }

  return {
    success: testResult.success,
    output,
    testResults,
    errorContexts,
  };
}

/**
 * Format a full Playwright failure report for a failing check.
 * Combines CI logs, downloaded artifacts, and local test results.
 */
function formatPlaywrightReport(pwInfo, artifacts, localResults) {
  const sections = [];

  sections.push(`\n${'═'.repeat(60)}`);
  sections.push(`🎭 PLAYWRIGHT TEST FAILURE REPORT`);
  sections.push(`${'═'.repeat(60)}`);
  sections.push(`Check: ${pwInfo.checkName}`);
  if (pwInfo.tags) sections.push(`Tags: ${pwInfo.tags}`);
  if (pwInfo.appName) sections.push(`App: ${pwInfo.appName}`);
  if (pwInfo.browserEnv) sections.push(`Browser Env: ${pwInfo.browserEnv}`);
  if (pwInfo.timedOut) sections.push(`⏰ Test timed out`);

  if (pwInfo.failedTests.length > 0) {
    sections.push(`\nFailed tests (${pwInfo.failedTests.length}):`);
    for (const t of pwInfo.failedTests) {
      sections.push(`  ✗ ${t.suite} › ${t.name}`);
      sections.push(`    ${t.file}:${t.line}`);
    }
  }

  // Artifact error contexts
  if (artifacts?.errorContexts?.length > 0) {
    sections.push(`\n${'─'.repeat(40)}`);
    sections.push(`📋 Error Context from CI Artifacts:`);
    for (const ctx of artifacts.errorContexts) {
      sections.push(`\n--- ${ctx.path} ---`);
      sections.push(ctx.content);
    }
  }

  // Test results summary from artifacts
  if (artifacts?.testResults) {
    const summary = summarizePlaywrightResults(artifacts.testResults);
    if (summary) sections.push(summary);
  }

  // Trace file references
  if (artifacts?.traceFiles?.length > 0) {
    sections.push(`\n🔍 Trace files available:`);
    for (const t of artifacts.traceFiles.slice(0, 5)) {
      sections.push(`  ${t}`);
    }
  }

  // Local test results
  if (localResults) {
    sections.push(`\n${'─'.repeat(40)}`);
    sections.push(`🏠 Local Test Run: ${localResults.success ? 'PASSED ✅' : 'FAILED ❌'}`);

    if (localResults.testResults) {
      const summary = summarizePlaywrightResults(localResults.testResults);
      if (summary) sections.push(summary);
    }

    if (localResults.errorContexts?.length > 0) {
      sections.push(`\n📋 Local Error Contexts:`);
      for (const ctx of localResults.errorContexts) {
        sections.push(`\n--- ${ctx.path} ---`);
        sections.push(ctx.content);
      }
    }
  }

  sections.push(`\n${'═'.repeat(60)}`);
  return sections.join('\n');
}

// ─── Fix a failing PR (full pipeline — same as index.js --auto-fix) ─────────

async function fixFailingPR(pr, failedChecks, failureLogs) {
  console.log(chalk.bold.yellow(`\n  🔧 Fixing PR #${pr.number}: ${pr.title}`));
  console.log(chalk.cyan(`  Running full fix pipeline (lint → tests → types → suppressions → format → push)...`));

  const branch = pr.headRefName;

  // 1. Check out the PR branch
  await runCommand(`git fetch origin ${branch}`, REPO_ROOT);
  await runCommand(`git checkout ${branch}`, REPO_ROOT);
  await runCommand(`git pull origin ${branch} --no-edit`, REPO_ROOT);

  // 2. Write CI failure context so the AI agent inside index.js has full context
  const contextFile = path.resolve(__dirname, 'server-error-context.txt');
  const existingContext = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, 'utf8').trim() : '';

  const ciContext = failedChecks.map((check, i) => {
    const logEntry = failureLogs[i];
    return [
      `### CI Check: ${check.name} (${check.state})`,
      `Link: ${check.link || 'N/A'}`,
      '',
      (logEntry?.logs || 'No logs').slice(0, 8000),
    ].join('\n');
  }).join('\n\n---\n\n');

  const fullContext = [
    existingContext,
    '',
    '## CI FAILURE CONTEXT (injected by check-prs.js)',
    '',
    ciContext,
  ].filter(Boolean).join('\n');
  fs.writeFileSync(contextFile, fullContext, 'utf8');

  // 3. Spawn the full fix pipeline: index.js --auto-fix --skip-e2e
  //    This runs the same pipeline as a single-branch fix:
  //    merge master → yarn install → gather CI context → Jest/Vitest → fix tests →
  //    global lint check → fix lint → type check → fix types → prune suppressions →
  //    format branch files → commit → push
  const startTime = Date.now();

  const result = await new Promise((resolve) => {
    const child = require('child_process').spawn(
      process.execPath,
      [path.join(__dirname, 'index.js'), '--auto-fix', '--skip-e2e'],
      {
        env: {
          ...process.env,
          LOOPER_REPO_ROOT: REPO_ROOT,
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
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => console.log(chalk.dim(`    ${line}`)));
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, code, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ success: false, code: -1, error: err.message, stdout: '', stderr: '' });
    });
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  // 4. Restore the context file
  if (existingContext) {
    fs.writeFileSync(contextFile, existingContext, 'utf8');
  } else {
    try { fs.unlinkSync(contextFile); } catch (_) {}
  }

  if (result.success) {
    console.log(chalk.bold.green(`  ✅ Full fix pipeline completed for PR #${pr.number} (${elapsed}s)`));

    // Check if any commits were pushed
    const pushMatch = result.stdout.match(/pushed to|Branch pushed|Push.*success/i);
    if (pushMatch) {
      console.log(chalk.green(`  🚀 Changes pushed to ${branch}. CI should re-run.`));
    }
    return true;
  } else {
    console.log(chalk.red(`  ❌ Fix pipeline exited with code ${result.code} after ${elapsed}s`));

    // Show last few lines of output for debugging
    const allOutput = result.stdout + result.stderr;
    const lastLines = allOutput.split('\n').filter(Boolean).slice(-10).join('\n');
    if (lastLines) {
      console.log(chalk.dim(`  Last output:`));
      console.log(chalk.dim(lastLines.replace(/^/gm, '    ')));
    }

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
    max_completion_tokens: 2048,
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
  const shouldRunTests = args.includes('--run-tests');
  const authorIdx = args.indexOf('--author');
  const author = authorIdx !== -1 ? args[authorIdx + 1] : '@me';
  const labelIdx = args.indexOf('--label');
  const label = labelIdx !== -1 ? args[labelIdx + 1] : null;
  const allBranches = args.includes('--all');

  console.log(chalk.bold.blue('\n🔍 Looper PR Health Checker\n'));
  console.log(chalk.gray(`  Repo: ${REPO_ROOT}`));
  console.log(chalk.gray(`  Author: ${author}`));
  if (label) console.log(chalk.gray(`  Label: ${label}`));
  console.log(chalk.gray(`  Auto-fix: ${shouldFix ? 'enabled (full pipeline per PR)' : 'disabled (use --fix to enable)'}`));
  console.log(chalk.gray(`  Fix comments: ${shouldFixComments ? 'enabled' : 'disabled (use --fix or --fix-comments)'}`));
  console.log(chalk.gray(`  Run tests: ${shouldRunTests ? 'enabled' : 'disabled (use --run-tests to enable)'}`));
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

      // Detect and report Playwright failures
      const playwrightFailures = [];
      for (let i = 0; i < failedChecks.length; i++) {
        const pwInfo = isPlaywrightFailure(failedChecks[i], failureLogs[i]);
        if (pwInfo) {
          playwrightFailures.push({ check: failedChecks[i], logData: failureLogs[i], pwInfo, index: i });

          console.log(chalk.bold.magenta(`\n    🎭 Playwright test failure detected!`));
          if (pwInfo.failedTests.length > 0) {
            for (const t of pwInfo.failedTests) {
              console.log(chalk.magenta(`      ✗ ${t.suite} › ${t.name}`));
              console.log(chalk.dim(`        ${t.file}:${t.line}`));
            }
          }
          if (pwInfo.timedOut) console.log(chalk.yellow(`      ⏰ Test timed out`));

          // Fetch artifacts from Buildkite
          const artifacts = await fetchPlaywrightArtifacts(failedChecks[i]);
          pwInfo._artifacts = artifacts;

          if (artifacts?.errorContexts?.length > 0) {
            console.log(chalk.cyan(`\n      📋 Error Context from CI:`));
            for (const ctx of artifacts.errorContexts) {
              console.log(chalk.dim(`      --- ${ctx.path} ---`));
              console.log(chalk.dim(ctx.content.split('\n').slice(0, 20).join('\n').replace(/^/gm, '        ')));
            }
          }

          if (artifacts?.testResults) {
            const summary = summarizePlaywrightResults(artifacts.testResults);
            if (summary) console.log(chalk.dim(summary.replace(/^/gm, '      ')));
          }

          // Print full report
          const report = formatPlaywrightReport(pwInfo, artifacts, null);
          const reportFile = path.join(__dirname, `.pr-${pr.number}-playwright-report.txt`);
          fs.writeFileSync(reportFile, report, 'utf8');
          console.log(chalk.dim(`      Full Playwright report saved to: ${reportFile}`));

          // Run tests locally if --run-tests
          if (shouldRunTests) {
            const localResults = await runPlaywrightTestsLocally(pwInfo, pr.headRefName);
            pwInfo._localResults = localResults;

            // Update report with local results
            const fullReport = formatPlaywrightReport(pwInfo, artifacts, localResults);
            fs.writeFileSync(reportFile, fullReport, 'utf8');
          }
        }
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
