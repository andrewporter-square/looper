/**
 * fix-history.js — Persistent fix-attempt tracking for Looper
 *
 * Tracks what was tried on each branch/file, what errors were seen, and the
 * outcome. This history is injected into AI prompts so the agent doesn't
 * repeat the same failed approaches.
 *
 * State is persisted to .looper-history.json (gitignored).
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '.looper-history.json');
const MAX_ATTEMPTS_PER_KEY = 20;   // Keep last N attempts per branch/file
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Expire entries older than 7 days

/**
 * Load the full history from disk.
 * @returns {Object} History keyed by branch → file → attempts[]
 */
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[fix-history] Failed to load: ${err.message}`);
  }
  return {};
}

/**
 * Save the full history to disk.
 * @param {Object} history
 */
function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error(`[fix-history] Failed to save: ${err.message}`);
  }
}

/**
 * Prune old entries beyond MAX_AGE_MS and cap per-key entries.
 * @param {Object} history
 * @returns {Object} Pruned history
 */
function pruneHistory(history) {
  const now = Date.now();
  const pruned = {};

  for (const [branch, files] of Object.entries(history)) {
    pruned[branch] = {};
    for (const [file, attempts] of Object.entries(files)) {
      const fresh = attempts
        .filter(a => (now - (a.timestamp || 0)) < MAX_AGE_MS)
        .slice(-MAX_ATTEMPTS_PER_KEY);
      if (fresh.length > 0) {
        pruned[branch][file] = fresh;
      }
    }
    if (Object.keys(pruned[branch]).length === 0) {
      delete pruned[branch];
    }
  }
  return pruned;
}

/**
 * Record a fix attempt.
 *
 * @param {object} opts
 * @param {string} opts.branch     - Git branch name
 * @param {string} opts.file       - File path (relative) or '_e2e' for E2E attempts
 * @param {string} opts.fixType    - 'lint' | 'test' | 'type' | 'e2e'
 * @param {string} opts.approach   - Description of what was tried
 * @param {string} opts.errors     - Error output / what went wrong
 * @param {boolean} opts.success   - Whether the fix worked
 * @param {string[]} [opts.filesChanged] - List of files that were modified
 */
function recordAttempt({ branch, file, fixType, approach, errors, success, filesChanged }) {
  const history = loadHistory();

  if (!history[branch]) history[branch] = {};
  if (!history[branch][file]) history[branch][file] = [];

  history[branch][file].push({
    timestamp: Date.now(),
    fixType,
    approach: (approach || '').slice(0, 2000),
    errors: (errors || '').slice(0, 3000),
    success: !!success,
    filesChanged: filesChanged || [],
  });

  saveHistory(pruneHistory(history));
}

/**
 * Get previous attempts for a branch+file combo, formatted for injection
 * into an AI system prompt.
 *
 * @param {string} branch - Git branch name
 * @param {string} file   - File path (relative) or '_e2e'
 * @returns {string} Formatted history text, or '' if none
 */
function getHistoryForPrompt(branch, file) {
  const history = loadHistory();
  const attempts = (history[branch] && history[branch][file]) || [];

  if (attempts.length === 0) return '';

  const failedAttempts = attempts.filter(a => !a.success);
  if (failedAttempts.length === 0) return '';

  const lines = [
    `\n⚠️ PREVIOUS FIX ATTEMPTS (${failedAttempts.length} failed attempt(s) on this branch for this target):`,
    `DO NOT repeat these approaches — they already failed. Try something fundamentally different.\n`,
  ];

  for (let i = 0; i < failedAttempts.length; i++) {
    const a = failedAttempts[i];
    const age = Math.round((Date.now() - a.timestamp) / 60000);
    lines.push(`--- Attempt ${i + 1} (${age} min ago, type: ${a.fixType}) ---`);
    if (a.approach) lines.push(`What was tried: ${a.approach}`);
    if (a.errors) lines.push(`Why it failed: ${a.errors.slice(0, 1500)}`);
    if (a.filesChanged && a.filesChanged.length > 0) {
      lines.push(`Files modified: ${a.filesChanged.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(
    `IMPORTANT: Based on the above history, you MUST use a different strategy. ` +
    `If the same approach keeps failing, consider:`,
    `- The error might be in a DIFFERENT file than previously modified`,
    `- The fix might require changes to multiple files at once`,
    `- A previous assumption about the root cause may be wrong`,
    `- Consider reading more context (type definitions, related files, test expectations) before writing`,
    ``
  );

  return lines.join('\n');
}

/**
 * Get a summary of all attempts on a branch (for check-prs.js reporting).
 * @param {string} branch
 * @returns {object} { totalAttempts, failedAttempts, files: { [file]: { attempts, failures } } }
 */
function getBranchSummary(branch) {
  const history = loadHistory();
  const branchHistory = history[branch] || {};
  let total = 0;
  let failed = 0;
  const files = {};

  for (const [file, attempts] of Object.entries(branchHistory)) {
    const failures = attempts.filter(a => !a.success).length;
    total += attempts.length;
    failed += failures;
    files[file] = { attempts: attempts.length, failures };
  }

  return { totalAttempts: total, failedAttempts: failed, files };
}

/**
 * Clear history for a branch (e.g., after a successful full fix).
 * @param {string} branch
 */
function clearBranchHistory(branch) {
  const history = loadHistory();
  delete history[branch];
  saveHistory(history);
}

module.exports = {
  recordAttempt,
  getHistoryForPrompt,
  getBranchSummary,
  clearBranchHistory,
  loadHistory,
};
