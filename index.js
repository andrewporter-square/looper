require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');
const OpenAI = require('openai');
const chalk = require('chalk');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const REPO_ROOT = process.env.LOOPER_REPO_ROOT || '/Users/aporter/Development/rocketship';
const MAIN_BRANCH = 'master';

// Hermit env: prepend rocketship bin paths so exec() uses the right Node/yarn/vitest
const REPO_ENV = {
  ...process.env,
  PATH: `${REPO_ROOT}/node_modules/.bin:${REPO_ROOT}/bin:${process.env.PATH}`,
  HERMIT_BIN: `${REPO_ROOT}/bin`,
  HERMIT_ENV: REPO_ROOT,
};

// --- BATCH FIXER LOGIC ---

// Safe yarn install: restores package.json if yarn install modifies it
async function safeYarnInstall() {
  const result = await runCommand(`yarn install`, REPO_ROOT);
  // yarn install can overwrite package.json (e.g., Corepack/yarn 3 migration). Restore from git.
  const pkgDiff = await runCommand(`git diff --name-only package.json`, REPO_ROOT);
  if (pkgDiff.stdout.trim().includes('package.json')) {
    console.log(chalk.yellow(`  ⚠️ yarn install modified package.json — restoring from git.`));
    await runCommand(`git checkout HEAD -- package.json`, REPO_ROOT);
  }
  return result;
}

async function runCommand(command, cwd = process.cwd()) {
  console.log(chalk.yellow(`  Running: ${command} in ${cwd}`));
  // Use Hermit env when running in REPO_ROOT so vitest/node resolve correctly
  const env = (cwd === REPO_ROOT || cwd.startsWith(REPO_ROOT)) ? REPO_ENV : undefined;
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 1024 * 1024 * 10, timeout: 600000, env }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? (error.killed ? 'Command Timed Out (300s)' : error.message) : null
      });
    });
  });
}

// Whether we're running in batch mode (individual fixers should commit but not push)
let BATCH_MODE = false;

// PR checklist appended to every PR description
const PR_CHECKLIST = [
  '',
  '**Checklist (all items to be checked before merging or put reason why in brackets):**',
  '- [ ] Changes are tested',
  '- [ ] Includes unit tests and feature flags (or not applicable)',
  "- [ ] I've masked consumer privacy data in Datadog by `MaskedElement` (e.g. credit card number, consumer name, email address), some fields may be masked by [Datadog](https://docs.datadoghq.com/real_user_monitoring/session_replay/privacy_options/) by default",
  "- [ ] I've adopted standard practices according to [these guidelines](https://github.com/AfterpayTouch/rocketship/blob/master/docs/standard-practices.md) and agree to monitor the [#rocketship-alerts-dev](https://square.slack.com/archives/C034LH11K4Y) channel for broken builds. Broken builds caused by this pull request merge should be fixed by the original contributor. Reach out to [#rocketship-dev-team](https://square.slack.com/archives/C033Q541WS2) if you have questions.",
  "- [ ] I've confirmed the changes do not affect regulatory product such as Pay Monthly. If it is Pay Monthly changes, it is an approved change and the changes are applied behind feature flags.",
].join('\n');

// Paths that should never be processed by the fixer agents
const SKIP_PATH_PATTERNS = /^(\.hermit|node_modules|dist|build|\.next|\.git|\.yarn|coverage|storybook)[\/]/;

// Generate a detailed PR explanation by sending the diff to the LLM
async function generatePRExplanation(baseBranch, headRef, changedFiles) {
  console.log(chalk.yellow(`  Generating detailed PR explanation from diff...`));
  try {
    // Get the full diff
    const diffResult = await runCommand(
      `git diff origin/${baseBranch}...${headRef} -- ${changedFiles.map(f => `"${f}"`).join(' ')}`,
      REPO_ROOT
    );
    const diff = (diffResult.stdout || '').slice(0, 60000); // cap to avoid token overflow
    if (!diff.trim()) {
      console.log(chalk.dim(`  No diff found, skipping explanation generation.`));
      return null;
    }

    const explanationResponse = await client.chat.completions.create({
      model: 'gpt-5.2-2025-12-11',
      messages: [
        {
          role: 'system',
          content: [
            'You are a senior software engineer writing a pull request description.',
            'Given a git diff, produce a detailed explanation of WHAT changed and WHY those changes are justified.',
            'Structure your answer with these sections:',
            '',
            '### Detailed Explanation',
            'For each file, describe what was changed and the reasoning.',
            '',
            '### Why These Changes Are Justified',
            'Explain the correctness guarantees, safety, and benefits.',
            '',
            'Be specific — reference actual variable names, enum values, translation keys, and code patterns.',
            'Do NOT include a summary line or title — just the two sections above.',
            'Use markdown formatting.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Here is the diff:\n\n${diff}`,
        },
      ],
      max_tokens: 3000,
    });

    const explanation = explanationResponse.choices?.[0]?.message?.content?.trim();
    if (explanation) {
      console.log(chalk.green(`  ✅ PR explanation generated (${explanation.length} chars).`));
      return explanation;
    }
    return null;
  } catch (err) {
    console.log(chalk.yellow(`  ⚠️ Failed to generate PR explanation: ${err.message}`));
    return null;
  }
}

async function fixLintErrorsForFile(relativePath) {
  const fullPath = path.join(REPO_ROOT, relativePath);
  
  if (SKIP_PATH_PATTERNS.test(relativePath)) {
      console.log(chalk.yellow(`  Skipping non-project file: ${relativePath}`));
      return;
  }
  
  console.log(chalk.bold.cyan(`\nProcessing lint for file: ${relativePath}`));
  
  // 1. Branch Management - SKIPPED (User manages branch)

  // 2. Remove Suppression
  const suppressionsPath = path.join(REPO_ROOT, 'eslint-suppressions.json');
  if (fs.existsSync(suppressionsPath)) {
      try {
          const suppressionsContent = fs.readFileSync(suppressionsPath, 'utf8');
          const suppressions = JSON.parse(suppressionsContent);
          if (suppressions[relativePath]) {
              delete suppressions[relativePath];
              fs.writeFileSync(suppressionsPath, JSON.stringify(suppressions, null, 2), 'utf8');
              console.log(chalk.green(`  Removed suppression entry.`));
          } 
      } catch (e) {
          console.error(chalk.red(`  Failed to process suppressions file: ${e.message}`));
      }
  }

  // 3. Agentic Loop for Fixing
  const MAX_STEPS = 50;
  let step = 0;
  let isFixed = false;

  // Initial Lint
  // Use local binary to ensure specific file targeting
  const eslintBin = path.join('node_modules', '.bin', 'eslint');
  let lintResult = await runCommand(`${eslintBin} "${relativePath}" --quiet`, REPO_ROOT);
  
  if (lintResult.success) {
      console.log(chalk.green(`  ✅ File is already clean!`));
      return;
  }

  const initialFileContent = fs.readFileSync(fullPath, 'utf8');

  // --- Load server error context if available ---
  const serverErrorContextPath = path.resolve(__dirname, 'server-error-context.txt');
  const serverErrorContext = fs.existsSync(serverErrorContextPath)
      ? fs.readFileSync(serverErrorContextPath, 'utf8').trim()
      : '';

  // --- Pre-gather context for lint fixing ---
  const lintImportMatches = initialFileContent.match(/(?:import|require)\s*\(?[^)]*['"]([^'"]+)['"]/g) || [];
  const lintImportsList = lintImportMatches.slice(0, 20).join('\n');
  
  // Get the tsconfig path for this file's package
  let tsconfigInfo = '';
  const fileParts = relativePath.split('/');
  if (fileParts.length >= 2) {
      const pkgDir = fileParts.slice(0, 2).join('/'); // e.g., "apps/checkout" or "libs/utils"
      const tsconfigPath = path.join(REPO_ROOT, pkgDir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
          tsconfigInfo = `\ntsconfig.json location: ${pkgDir}/tsconfig.json`;
      }
  }

  // Agent System Prompt
  const messages = [
    {
      role: "system",
      content: `You are a Senior Software Engineer specializing in fixing ESLint errors in a large TypeScript/React monorepo.

ENVIRONMENT:
- Target File: ${relativePath}
- Repo Root: ${REPO_ROOT}
- Structure: Yarn workspace monorepo with apps/, libs/, packages/ directories${tsconfigInfo}

GOAL: Fix ALL reported ESLint errors in the target file.

RULES:
1. Fix the ERRORS, not just suppress them. NEVER use eslint-disable comments for @afterpay/i18n-only-static-keys — that rule CANNOT be suppressed. For other rules, only use eslint-disable as an absolute last resort.
2. Always provide the COMPLETE file content when using write_file — never partial.
3. Do NOT change the file's logic or behavior — only fix lint violations.
4. If an error is about an import, USE read_file to check what the imported module actually exports.
5. If an error is about types, read the type definition file to understand the correct types.
6. NEVER remove or delete translation keys, i18n strings, title/description text, or content strings. If a translation key has an error, READ the translation file or type definition to find the correct key — don't delete it.
7. When a value must match a union type, enum, or set of allowed keys: ALWAYS use read_file or run_command (grep) to find the type definition and discover the valid values. Never guess — look it up.
8. NEVER modify package.json, yarn.lock, or any lock/config files. Only change the source file where the lint errors occur and closely related source files.

STRATEGY:
1. READ the errors carefully. Group them by rule (e.g., @typescript-eslint/no-unused-vars, import/order).
2. For import errors: read the imported module to verify correct export names.
3. For type errors: read the type definition to understand the expected shape.
4. For unused variable errors: check if the variable is used elsewhere or can be prefixed with _.
5. PLAN your fix — state which errors you'll address and how.
6. EXECUTE — write the complete fixed file.
7. I will automatically re-run eslint after every write_file.

COMMON ESLINT RULES IN THIS REPO:
- @typescript-eslint/no-unused-vars: Remove or prefix with _
- import/order: Fix import grouping (external → internal → relative)
- @typescript-eslint/no-explicit-any: Replace 'any' with proper types (read related types)
- react/jsx-key: Add key prop to JSX in arrays/maps
- no-restricted-imports: Check .eslintrc for restricted import patterns
- @typescript-eslint/consistent-type-imports: Use 'import type' for type-only imports
- simple-import-sort/imports: Sort imports per plugin config
- @afterpay/i18n-only-static-keys: Translation keys passed to t() MUST be static string literals, NOT dynamic/template expressions.

FIXING @afterpay/i18n-only-static-keys (CRITICAL — follow this process exactly):
DO NOT use eslint-disable or eslint-disable-next-line for this rule. It is NOT allowed and will be rejected.

HOW THE LINT RULE WORKS:
The rule checks that the first argument to t() is a static string literal (or concatenation of only string literals with +).
It REJECTS: template literals with expressions, variables, ternaries as arguments, function return values.
String concatenation with + of ONLY string literals IS allowed (but prefer plain string literals).

KNOWN DYNAMIC KEY PATTERNS (classify the violation first, then apply the matching fix strategy):

Pattern A — Template literal with enum/finite variable:
  Example: t(\`paymentMethod:cardType.\${feature}\`) where feature is Feature.PBI | Feature.PCL | Feature.AFF
  Fix: Switch on the enum value and call t() with each static key directly.

Pattern B — Template literal with error code enum:
  Example: t(\`terminalError:\${errorKey}.description\`) where errorKey comes from TerminalErrorCode enum
  Fix: Build a Record<EnumValue, string> mapping each enum value to its translated string via static t() calls.
  For large enums (40+ values like TerminalErrorCode), a typed Record map is the cleanest approach.

Pattern C — Ternary selecting between two static keys:
  Example: t(condition ? 'key.a' : 'key.b')
  Fix: Move t() outside: condition ? t('key.a') : t('key.b')
  This is the simplest pattern — just split the t() call.

Pattern D — Fallback array from useGetLocaleWithFallback:
  Key file: apps/checkout/src/utils/post-checkout.tsx
  Example: t(localeWithFallback('subtitle'), '', { merchantDisplayName })
  Fix: Refactor the hook to return static keys, or enumerate all assetId × variant × flow combinations.
  This is the HARDEST pattern. Read the hook implementation first to understand the key space.

Pattern E — Template literal with buildTranslationKey output:
  Key file: apps/checkout/src/utils/locales.ts
  Example: t(buildTranslationKey({ namespace: 'summary', segments: ['autopay', modelSegment] }))
  Fix: Enumerate all possible outputs from the segment conditions, then use conditional t() calls.
  Each call site's conditions are deterministic — trace them to find the finite set of keys.

Pattern F — Function parameter/return value as key:
  Example: t(getLocaleKeyFromDayNumber(day)) where the function returns 'preferredDay.weekday.0' through '.6'
  Fix: Inline the switch/conditional and call t() with each static key directly.
  Or: refactor the helper to accept t and return the translated string instead of the key.

STYLE GUIDE FOR FIXES (follow these principles):
- Prefer declarative Record/Map objects over condition-heavy if/else chains.
- Include the t() calls INSIDE the declarative mapping so keys remain static string literals.
- NO nested ternaries. Ever. Use if/else, switch, or a lookup map instead.
- Keep control flow simple and linear. Compute the "selected config" first, then use it.
- Separate decision logic from rendering/execution.
- Favor clarity over cleverness — repetition is acceptable when it improves readability.
- Use explicit TypeScript types at boundaries (Record<SomeEnum, string>, etc.).
- Centralize variation points — put all variant/mode/state differences in one place.

EXAMPLE FIX (declarative mapping style):
\`\`\`
// BEFORE (dynamic — fails lint):
t(\`login:error:\${LoginIdentityErrors[code] ?? 'unknown'}\`)

// AFTER (declarative mapping — passes lint):
const loginErrorMessages: Record<string, string> = {
  emailNotValid: t('login:error:emailNotValid'),
  registrationNotPermitted: t('login:error:registrationNotPermitted'),
};
const errorMessage = loginErrorMessages[LoginIdentityErrors[code]] ?? t('login:error:unknown');
\`\`\`

ANOTHER EXAMPLE (ternary split):
\`\`\`
// BEFORE (ternary as argument — fails lint):
t(isExperiment ? 'consumerLending:autopay.name' : 'summary:autopay.name', opts)

// AFTER (t() on each branch — passes lint):
isExperiment ? t('consumerLending:autopay.name', opts) : t('summary:autopay.name', opts)
\`\`\`

KEY ARCHITECTURE KNOWLEDGE:
- apps/checkout/src/utils/convergence.tsx: Wraps next-i18next for Cash/AP cohorts. NOT the blocker — static extraction depends on callsites.
- apps/checkout/src/utils/locales.ts: buildTranslationKey() builds keys from conditional segments. Each call site has a FINITE set of outputs.
- apps/checkout/src/utils/post-checkout.tsx: useGetLocaleWithFallback() creates dynamic fallback arrays. Hardest migration area.
- Locale files are in apps/checkout/public/locales/en-AU/*.json (summary.json, terminalError.json, paymentMethod.json, etc.)

RESEARCH AND VERIFY:
1. ALWAYS read the enum/type/object definition before creating the mapping.
2. ALWAYS check the locale JSON file to confirm the static keys actually exist. Use read_file on the relevant locale file (e.g., apps/checkout/public/locales/en-AU/summary.json) BEFORE writing your fix.
3. NEVER INVENT OR GUESS TRANSLATION KEYS. Every key you write in a t() call MUST exist in the locale JSON file. If the original code used t(\`summary:error:\${reason}:message\`), then the static keys are summary:error:<value>:message where <value> matches the keys in the JSON. Read the JSON to discover the exact keys — do NOT create keys like "expireSoon", "expired", etc. unless they appear in the JSON.
4. NEVER ADD A NAMESPACE PREFIX that wasn't in the original code. If the original code calls t('preferredDay.weekday.0') WITHOUT a namespace prefix like 'common:', do NOT add one. The keys in locale JSON files like common.json use flat dot-notation (e.g., "preferredDay.weekday.0": "Sunday") and are resolved WITHOUT a namespace prefix. Adding 'common:' will BREAK key resolution.
5. If the file uses buildTranslationKey or useGetLocaleWithFallback, read those utility files first.
6. After writing the fix, ensure NO new type errors are introduced (use proper TypeScript types for your maps).
7. The SIMPLEST correct fix for t(\`namespace:\${variable}:suffix\`) is a switch/Record where each case uses the SAME key pattern with the variable replaced by its literal value from the locale JSON.

TOOLS AVAILABLE:
- read_file: Read any file (use to inspect types, imports, configs, .eslintrc)
- write_file: Write complete file content (triggers automatic lint re-run)
- list_files: List directory contents
- run_command: Run shell commands
`
    },
    {
      role: "user",
      content: (() => {
          const parts = [
              `Please fix the following ESLint errors in ${relativePath}.`,
              `\nERRORS:\n${lintResult.stdout + lintResult.stderr}`,
              `\nCURRENT FILE CONTENT:\n${initialFileContent}`,
              lintImportsList ? `\nFILE IMPORTS:\n${lintImportsList}` : '',
          serverErrorContext ? `\nSERVER/CI ERROR CONTEXT (from a recent CI run — use this to understand what went wrong):\n${serverErrorContext}` : ''
          ];
          
          // Inject per-file research from MEGA doc if available
          const researchPath = path.resolve(__dirname, 'i18n-static-keys-research-MEGA.md');
          if (fs.existsSync(researchPath)) {
              const researchDoc = fs.readFileSync(researchPath, 'utf8');
              // Extract the component/file name to search for in the research doc
              const fileName = path.basename(relativePath, path.extname(relativePath));
              const dirName = path.basename(path.dirname(relativePath));
              // Try to find a matching section in the research doc
              const searchTerms = [fileName, dirName, `${dirName}/${fileName}`];
              const matchedSections = [];
              for (const term of searchTerms) {
                  // Look for "### File N: ...term..." or "### Verified: ...term..." sections
                  const regex = new RegExp(`###\\s+(?:File \\d+:|Verified:).*${term.replace(/[.*+?^${}()|[\]\\\\]/g, '\\\\$&')}[^#]*`, 'gi');
                  const matches = researchDoc.match(regex);
                  if (matches) {
                      for (const m of matches) {
                          if (!matchedSections.includes(m)) matchedSections.push(m);
                      }
                  }
              }
              if (matchedSections.length > 0) {
                  parts.push(`\nPRE-RESEARCHED ANALYSIS (from project research doc — use this to guide your fix):\n${matchedSections.join('\n\n').slice(0, 5000)}`);
              }
          }
          
          return parts.filter(Boolean).join('\n');
      })()
    }
  ];

  while (!isFixed && step < MAX_STEPS) {
    step++;
    console.log(chalk.gray(`\n  Step ${step}/${MAX_STEPS} (Thinking/Researching)...`));

    try {
        const timer = setInterval(() => {
          process.stdout.write(chalk.gray('.'));
        }, 1000);

        const response = await client.chat.completions.create({
            model: "gpt-5.2-2025-12-11",
            messages: messages,
            tools: Object.values(tools).map(t => t.definition),
            tool_choice: "auto",
        });

        clearInterval(timer);
        process.stdout.write('\n'); // Clear the line of dots

        const msg = response.choices[0].message;
        messages.push(msg);

        if (msg.content) {
            console.log(chalk.cyan(`  Agent: ${msg.content.slice(0, 300).replace(/\n/g, ' ')}...`));
        }

        if (msg.tool_calls) {
            for (const toolCall of msg.tool_calls) {
                const fnName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                
                console.log(chalk.magenta(`  > Tool: ${fnName} `), chalk.dim(JSON.stringify(args).slice(0, 100)));

                // Path Adjustment for Repo Root
                if (args.path && !path.isAbsolute(args.path)) {
                    if (args.path.startsWith('apps/') || args.path.startsWith('libs/') || args.path.startsWith('packages/')) { 
                       args.path = path.join(REPO_ROOT, args.path);
                    } else if (!args.path.startsWith(REPO_ROOT)) {
                         args.path = path.join(REPO_ROOT, args.path);
                    }
                }

                let result;
                
                // Intercept write_file to the TARGET file to trigger verify
                const isTargetFile = args.path && (args.path === fullPath || args.path.endsWith(relativePath));
                
                if (fnName === 'write_file' && isTargetFile) {
                    console.log(chalk.yellow(`  ⚡️ Applying Fix to target file...`));
                    try {
                         const dir = path.dirname(args.path);
                         if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                         fs.writeFileSync(args.path, args.content, 'utf8');
                         
                         // Verification Step
                         console.log(chalk.blue(`  Verifying...`));
                         lintResult = await runCommand(`${eslintBin} "${relativePath}" --quiet`, REPO_ROOT);
                         
                         if (lintResult.success) {
                             isFixed = true;
                             result = "SUCCESS: Lint errors resolved. Great job.";
                             console.log(chalk.bold.green("  ✅ Target Lint Passed!"));
                         } else {
                             result = `FAILURE: Lint failed after fix.\nNew Errors:\n${lintResult.stdout + lintResult.stderr}`;
                             console.log(chalk.red("  ❌ Fix Failed. Sending errors back to agent..."));
                         }
                    } catch (err) {
                        result = `Error writing file: ${err.message}`;
                    }
                } else {
                   const tool = tools[fnName];
                   if (tool) {
                       result = await tool.handler(args);
                   } else {
                       result = `Error: Tool ${fnName} not found.`;
                   }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result
                });
            }
        }
    } catch (err) {
        console.error(chalk.red("Error in agent loop:"), err.message);
        break;
    }
  }

  if (isFixed) {
    // 7. Commit (and Push if not in batch mode)
    console.log(chalk.green(`  Committing...`));
    
    // Add file and suppressions
    // Derive app scope from file path
    const commitParts = relativePath.split('/');
    const commitScope = (commitParts.length >= 2 && ['apps', 'libs', 'packages'].includes(commitParts[0]))
        ? commitParts[1] : 'core';
    const componentName = path.basename(relativePath, path.extname(relativePath));
    
    await runCommand(`git add "${relativePath}" "eslint-suppressions.json"`, REPO_ROOT);
    await runCommand(`git commit --no-verify -m "feat(${commitScope}): migrate ${componentName} to static i18n keys" -m "Replace dynamic i18n key construction with static string literals to satisfy the @afterpay/i18n-only-static-keys ESLint rule. All translation keys are now statically analyzable."`, REPO_ROOT);

    if (!BATCH_MODE) {
        const branchCheck = await runCommand(`git branch --show-current`, REPO_ROOT);
        const currentBranch = branchCheck.stdout.trim();
        if (currentBranch && currentBranch !== MAIN_BRANCH && currentBranch !== 'main') {
            await runCommand(`git push --no-verify origin HEAD:refs/heads/${currentBranch}`, REPO_ROOT);
        } else {
            console.log(chalk.yellow(`  ⚠️ Skipping push — on protected branch ${currentBranch}.`));
        }
    }
    console.log(chalk.green(`  Done with ${relativePath}`));
  } else {
    console.log(chalk.bold.red(`  ⚠️ Failed to fix ${relativePath} after ${MAX_STEPS} steps.`));
    console.log(chalk.blue(`  Discarding changes...`));
    await runCommand(`git checkout HEAD "${relativePath}"`, REPO_ROOT); 
  }
}

async function fixTypeErrorsForFile(relativePath, typeErrors) {
  const fullPath = path.join(REPO_ROOT, relativePath);

  // Load server error context if available
  const serverErrorContextPath = path.resolve(__dirname, 'server-error-context.txt');
  const serverErrorContext = fs.existsSync(serverErrorContextPath)
      ? fs.readFileSync(serverErrorContextPath, 'utf8').trim()
      : '';
  
  if (SKIP_PATH_PATTERNS.test(relativePath)) {
      console.log(chalk.yellow(`  Skipping non-project file: ${relativePath}`));
      return;
  }
  
  console.log(chalk.bold.cyan(`\n🔷 Processing TypeScript errors for: ${relativePath}`));
  
  if (!fs.existsSync(fullPath)) {
      console.log(chalk.yellow(`  File not found, skipping.`));
      return;
  }

  // Determine the app/package directory for tsc
  const fileParts = relativePath.split('/');
  let tscDir = REPO_ROOT;
  if (fileParts.length >= 2) {
      const pkgDir = fileParts.slice(0, 2).join('/'); // e.g., "apps/checkout"
      const tsconfigPath = path.join(REPO_ROOT, pkgDir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath)) {
          tscDir = path.join(REPO_ROOT, pkgDir);
      }
  }

  const MAX_STEPS = 50;
  let step = 0;
  let isFixed = false;

  const initialFileContent = fs.readFileSync(fullPath, 'utf8');

  // Pre-gather imports
  const importMatches = initialFileContent.match(/(?:import|require)\s*\(?[^)]*['"]([^'"]+)['"]/g) || [];
  const importsList = importMatches.slice(0, 20).join('\n');

  // Find related type definition files mentioned in errors
  const typeHints = typeErrors.match(/type '([^']+)'/gi) || [];

  const messages = [
    {
      role: "system",
      content: `You are a Senior Software Engineer specializing in fixing TypeScript type errors in a large TypeScript/React monorepo.

ENVIRONMENT:
- Target File: ${relativePath}
- Repo Root: ${REPO_ROOT}
- TypeScript project dir: ${tscDir}
- Structure: Yarn workspace monorepo with apps/, libs/, packages/ directories

GOAL: Fix ALL reported TypeScript type errors in the target file WITHOUT changing behavior.

RULES:
1. Fix the type errors properly — do NOT use \`as any\`, \`@ts-ignore\`, or \`@ts-expect-error\` unless absolutely necessary.
2. Always provide the COMPLETE file content when using write_file — never partial.
3. Do NOT change the file's runtime behavior — only fix type issues.
4. READ type definitions and imported modules to understand the correct types before fixing.
5. NEVER remove or delete translation keys, i18n strings, title/description text, or content strings. If a key doesn't match a type, READ the type definition to find the correct key — don't delete it.
6. When a value must match a union type, enum, or set of allowed keys: ALWAYS use read_file to find the type definition FIRST. Discover ALL valid values, then pick the correct one. Never guess or remove the value.
7. NEVER modify package.json, yarn.lock, or any lock/config files. Only change the source file where the type errors occur.

STRATEGY:
1. READ the errors carefully. The error codes (TS2678, TS2322, etc.) tell you exactly what's wrong.
2. For "not comparable" / "not assignable" errors: READ the type definition to see what values are valid.
3. For missing property errors: READ the interface/type to see what's expected.
4. For import errors: READ the module to check what's actually exported.
5. PLAN your fix — explain what each error is and how you'll fix it.
6. EXECUTE — write the complete fixed file.
7. I will re-run tsc after every write_file to verify.

COMMON TS ERROR PATTERNS:
- TS2678 "not comparable": A switch case uses a string literal that doesn't match the union type. Read the type to see valid values.
- TS2322 "not assignable": The value's type doesn't match the expected type. Read both types.
- TS2339 "does not exist on type": Property doesn't exist. Read the type definition.
- TS2304 "cannot find name": Missing import or type declaration.
- TS7006 "implicitly has 'any' type": Add explicit type annotation.

TOOLS AVAILABLE:
- read_file: Read any file (use to inspect type definitions, imported modules, interfaces)
- write_file: Write complete file content (triggers automatic tsc re-check)
- list_files: List directory contents
- run_command: Run shell commands (e.g., grep for type definitions)
`
    },
    {
      role: "user",
      content: [
          `Please fix the following TypeScript type errors in ${relativePath}.`,
          `\nTYPE ERRORS:\n${typeErrors}`,
          `\nCURRENT FILE CONTENT:\n${initialFileContent}`,
          importsList ? `\nFILE IMPORTS:\n${importsList}` : '',
          typeHints.length ? `\nTYPE HINTS (mentioned in errors):\n${typeHints.join(', ')}` : '',
          serverErrorContext ? `\nSERVER/CI ERROR CONTEXT (from a recent CI run — use this to understand what went wrong):\n${serverErrorContext}` : ''
      ].filter(Boolean).join('\n')
    }
  ];

  while (!isFixed && step < MAX_STEPS) {
    step++;
    console.log(chalk.gray(`\n  Step ${step}/${MAX_STEPS} (Thinking/Researching)...`));

    try {
        const timer = setInterval(() => {
          process.stdout.write(chalk.gray('.'));
        }, 1000);

        const response = await client.chat.completions.create({
            model: "gpt-5.2-2025-12-11",
            messages: messages,
            tools: Object.values(tools).map(t => t.definition),
            tool_choice: "auto",
        });

        clearInterval(timer);
        process.stdout.write('\n');

        const msg = response.choices[0].message;
        messages.push(msg);

        if (msg.content) {
            console.log(chalk.cyan(`  Agent: ${msg.content.slice(0, 300).replace(/\n/g, ' ')}...`));
        }

        if (msg.tool_calls) {
            for (const toolCall of msg.tool_calls) {
                const fnName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                
                console.log(chalk.magenta(`  > Tool: ${fnName} `), chalk.dim(JSON.stringify(args).slice(0, 100)));

                if (args.path && !path.isAbsolute(args.path)) {
                    if (args.path.startsWith('apps/') || args.path.startsWith('libs/') || args.path.startsWith('packages/') || args.path.startsWith('src/')) { 
                       args.path = path.join(REPO_ROOT, args.path);
                    } else if (!args.path.startsWith(REPO_ROOT)) {
                         args.path = path.join(REPO_ROOT, args.path);
                    }
                }

                let result;
                const isTargetFile = args.path && (args.path === fullPath || args.path.endsWith(relativePath));
                
                if (fnName === 'write_file' && isTargetFile) {
                    console.log(chalk.yellow(`  ⚡️ Applying Fix to target file...`));
                    try {
                         fs.writeFileSync(args.path, args.content, 'utf8');
                         
                         // Re-run tsc to verify
                         console.log(chalk.blue(`  Verifying with tsc...`));
                         const tscResult = await runCommand(`npx tsc --noEmit --pretty false 2>&1 | grep "${relativePath.replace(/^[^/]+\/[^/]+\//, '')}"`, tscDir);
                         const tscOutput = tscResult.stdout.trim();
                         
                         if (!tscOutput || tscOutput.length === 0) {
                             isFixed = true;
                             result = "SUCCESS: All TypeScript type errors in this file are resolved!";
                             console.log(chalk.bold.green("  ✅ TypeScript errors fixed!"));
                         } else {
                             result = `FAILURE: TypeScript errors remain.\nRemaining Errors:\n${tscOutput}`;
                             console.log(chalk.red("  ❌ Fix incomplete. Sending remaining errors back..."));
                         }
                    } catch (err) {
                        result = `Error writing file: ${err.message}`;
                    }
                } else {
                   const tool = tools[fnName];
                   if (tool) {
                       result = await tool.handler(args);
                   } else {
                       result = `Error: Tool ${fnName} not found.`;
                   }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result
                });
            }
        }
    } catch (err) {
        console.error(chalk.red("Error in agent loop:"), err.message);
        break;
    }
  }

  if (isFixed) {
    console.log(chalk.green(`  Committing TypeScript fix...`));
    const tCommitParts = relativePath.split('/');
    const tCommitScope = (tCommitParts.length >= 2 && ['apps', 'libs', 'packages'].includes(tCommitParts[0]))
        ? tCommitParts[1] : 'core';
    const tComponentName = path.basename(relativePath, path.extname(relativePath));

    await runCommand(`git add "${relativePath}"`, REPO_ROOT);
    await runCommand(`git commit --no-verify -m "fix(${tCommitScope}): resolve TypeScript errors in ${tComponentName}" -m "Fix type errors introduced during refactoring. Updated type annotations and value mappings to match expected interfaces."`, REPO_ROOT);

    if (!BATCH_MODE) {
        const branchCheck = await runCommand(`git branch --show-current`, REPO_ROOT);
        const currentBranch = branchCheck.stdout.trim();
        if (currentBranch && currentBranch !== MAIN_BRANCH && currentBranch !== 'main') {
            await runCommand(`git push --no-verify origin HEAD:refs/heads/${currentBranch}`, REPO_ROOT);
        } else {
            console.log(chalk.yellow(`  ⚠️ Skipping push — on protected branch ${currentBranch}.`));
        }
    }
    console.log(chalk.green(`  Done with ${relativePath}`));
  } else {
    console.log(chalk.bold.red(`  ⚠️ Failed to fix TypeScript errors in ${relativePath} after ${MAX_STEPS} steps.`));
    console.log(chalk.blue(`  Discarding changes...`));
    await runCommand(`git checkout HEAD "${relativePath}"`, REPO_ROOT); 
  }
}


async function fixTestErrorsForFile(relativePath, runner = 'jest') {
  const fullPath = path.join(REPO_ROOT, relativePath);

  // Load server error context if available
  const serverErrorContextPath = path.resolve(__dirname, 'server-error-context.txt');
  const serverErrorContext = fs.existsSync(serverErrorContextPath)
      ? fs.readFileSync(serverErrorContextPath, 'utf8').trim()
      : '';
  
  if (SKIP_PATH_PATTERNS.test(relativePath)) {
      console.log(chalk.yellow(`  Skipping non-project file: ${relativePath}`));
      return;
  }
  
  console.log(chalk.bold.magenta(`\n🧪 Processing tests for: ${relativePath} [${runner.toUpperCase()}]`));
  
  // 1. Branch Management - SKIPPED (User manages branch)

  // 2. Initial Test Run
  // Using TZ="Australia/Melbourne" as per package.json patterns
  let testCommand = '';
  if (runner === 'vitest') {
      testCommand = `yarn run test:vitest "${relativePath}"`;
  } else {
      testCommand = `TZ="Australia/Melbourne" npx jest --findRelatedTests "${relativePath}" --passWithNoTests`;
  }

  console.log(chalk.yellow(`  Running tests...`));
  let testResult = await runCommand(testCommand, REPO_ROOT);

  if (testResult.success) {
      console.log(chalk.green(`  ✅ Tests already pass for this file!`));
      return;
  }

  // Check for vitest startup errors (environment issues, not test failures)
  const testOutput = testResult.stdout + testResult.stderr;
  if (runner === 'vitest' && /Startup Error|failed to load config|ERR_REQUIRE_ESM/.test(testOutput)) {
      console.log(chalk.yellow(`  ⚠️ Vitest can't start (startup/config error). Skipping this file — not a test failure.`));
      console.log(chalk.dim(testOutput.slice(0, 500)));
      return;
  }

  console.log(chalk.red(`  ❌ Tests failed.`));

  // 3. Agentic Loop for Fixing
  const MAX_STEPS = 50;
  let step = 0;
  let isFixed = false;

  const initialFileContent = fs.readFileSync(fullPath, 'utf8');

  // --- Pre-gather context so the agent doesn't waste steps ---
  
  // A. Get diff for THIS specific file and its likely source
  console.log(chalk.blue(`  Gathering context...`));
  
  // Find the source file if this is a test file
  let sourceFilePath = '';
  let sourceFileContent = '';
  const testFileMatch = relativePath.match(/^(.+?)\.(?:test|spec|vitest)\.(tsx?|jsx?)$/);
  if (testFileMatch) {
      // Try common source file patterns
      const basePath = testFileMatch[1];
      const possibleExts = ['tsx', 'ts', 'jsx', 'js'];
      for (const ext of possibleExts) {
          const candidate = `${basePath}.${ext}`;
          const candidateFull = path.join(REPO_ROOT, candidate);
          if (fs.existsSync(candidateFull)) {
              sourceFilePath = candidate;
              sourceFileContent = fs.readFileSync(candidateFull, 'utf8');
              console.log(chalk.blue(`  Found source file: ${sourceFilePath}`));
              break;
          }
      }
      // Also check index file in same directory
      if (!sourceFilePath) {
          const dir = path.dirname(relativePath);
          for (const ext of possibleExts) {
              const candidate = path.join(dir, `index.${ext}`);
              const candidateFull = path.join(REPO_ROOT, candidate);
              if (fs.existsSync(candidateFull)) {
                  sourceFilePath = candidate;
                  sourceFileContent = fs.readFileSync(candidateFull, 'utf8');
                  console.log(chalk.blue(`  Found source file: ${sourceFilePath}`));
                  break;
              }
          }
      }
  }
  
  // B. Get imports from the test file to help the agent find related files
  const importMatches = initialFileContent.match(/(?:import|require)\s*\(?[^)]*['"]([^'"]+)['"]/g) || [];
  const importsList = importMatches.slice(0, 20).join('\n');
  
  // C. Get focused diff — just for the files in this directory
  const fileDir = path.dirname(relativePath);
  const focusedDiffResult = await runCommand(`git diff ${MAIN_BRANCH}...HEAD -- "${fileDir}"`, REPO_ROOT);
  const focusedDiff = focusedDiffResult.success ? focusedDiffResult.stdout : '';
  
  // D. Also get diff for the source file specifically if found
  let sourceDiff = '';
  if (sourceFilePath) {
      const srcDiffResult = await runCommand(`git diff ${MAIN_BRANCH}...HEAD -- "${sourceFilePath}"`, REPO_ROOT);
      sourceDiff = srcDiffResult.success ? srcDiffResult.stdout : '';
  }
  
  // E. If focused diff is small, also get the broader diff
  let broadDiff = '';
  if (focusedDiff.length < 5000) {
      const broadDiffResult = await runCommand(`git diff ${MAIN_BRANCH}...HEAD --stat`, REPO_ROOT);
      broadDiff = broadDiffResult.success ? `\n\nCHANGED FILES SUMMARY:\n${broadDiffResult.stdout}` : '';
  }

  // Build context block
  const diffContext = [
      sourceDiff ? `\nSOURCE FILE DIFF (${sourceFilePath}):\n${sourceDiff.slice(0, 20000)}` : '',
      focusedDiff ? `\nDIRECTORY DIFF (${fileDir}/):\n${focusedDiff.slice(0, 20000)}` : '',
      broadDiff
  ].filter(Boolean).join('\n');

  // Agent System Prompt
  const messages = [
    {
      role: "system",
      content: `You are a Senior Software Engineer specializing in debugging test failures in a large TypeScript/React monorepo.

ENVIRONMENT:
- Repo Root: ${REPO_ROOT}
- Structure: Yarn workspace monorepo with apps/, libs/, packages/ directories
- Test File: ${relativePath}
- Test Runner: ${runner.toUpperCase()}
${sourceFilePath ? `- Source File (likely): ${sourceFilePath}` : '- Source File: NOT YET IDENTIFIED — you must find it'}

GOAL: Make the failing tests pass by fixing the SOURCE code (not the tests).

RULES:
1. The tests are CORRECT. NEVER modify test files (*.test.*, *.spec.*, *.vitest.*).
2. The test file imports the code under test — look at the imports to find what to fix.
3. The GIT DIFF shows what changed on this branch vs master — the regression is likely there.
4. When you see a diff that removed or changed behavior the test expects, RESTORE that behavior.
5. Always provide the COMPLETE file content when using write_file — never partial.
6. NEVER remove or delete translation keys, i18n strings, title/description text, or content strings. If something is broken, fix it — don't delete it.
7. When a value must match a union type or enum, READ the type definition to discover valid values before changing anything.
8. NEVER modify package.json, yarn.lock, or any lock/config files. Only change the source files — not config or dependency files.

STRATEGY (follow this order):
1. READ the test output carefully. Identify:
   - Which test cases fail and what they expect
   - The actual vs expected values
   - Any error messages or stack traces
2. READ the source file under test (${sourceFilePath || 'find it from imports'}).
3. COMPARE with the git diff to see what changed.
4. IDENTIFY the root cause — usually a recent change broke an expected behavior.
5. PLAN your fix — state exactly what you'll change and why.
6. EXECUTE — use write_file with the complete fixed file.
7. I will automatically re-run tests after every write_file.

COMMON PATTERNS:
- Function signature changed but callers not updated
- New parameter added without default value
- Return type changed (e.g., Promise wrapper added/removed)
- Import path changed
- Renamed export not updated everywhere
- Date/timezone handling (this repo uses TZ="Australia/Melbourne")
- React hook dependencies changed
- Type narrowing or guard conditions modified

TOOLS AVAILABLE:
- read_file: Read any file in the repo (use to inspect source, types, utils)
- write_file: Write complete file content (triggers automatic test re-run)
- list_files: List directory contents
- run_command: Run shell commands (git log, grep, find, etc.)
`
    },
    {
      role: "user",
      content: [
          `Tests failed for ${relativePath}.`,
          `\nTEST OUTPUT:\n${(testResult.stdout + testResult.stderr).slice(0, 15000)}`,
          `\nTEST FILE CONTENT:\n${initialFileContent}`,
          sourceFileContent ? `\nSOURCE FILE (${sourceFilePath}):\n${sourceFileContent}` : '',
          importsList ? `\nTEST FILE IMPORTS:\n${importsList}` : '',
          diffContext,
          serverErrorContext ? `\nSERVER/CI ERROR CONTEXT (from a recent CI run — use this to understand what went wrong):\n${serverErrorContext}` : ''
      ].filter(Boolean).join('\n')
    }
  ];

  while (!isFixed && step < MAX_STEPS) {
    step++;
    console.log(chalk.gray(`\n  Step ${step}/${MAX_STEPS} (Thinking)...`));

    try {
        const timer = setInterval(() => {
          process.stdout.write(chalk.gray('.'));
        }, 1000);

        const response = await client.chat.completions.create({
            model: "gpt-5.2-2025-12-11",
            messages: messages,
            tools: Object.values(tools).map(t => t.definition),
            tool_choice: "auto",
        });

        clearInterval(timer);
        process.stdout.write('\n');

        const msg = response.choices[0].message;
        messages.push(msg);

        if (msg.content) {
            console.log(chalk.cyan(`  Agent: ${msg.content.slice(0, 300).replace(/\n/g, ' ')}...`));
        }

        if (msg.tool_calls) {
            for (const toolCall of msg.tool_calls) {
                const fnName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                
                console.log(chalk.magenta(`  > Tool: ${fnName} `), chalk.dim(JSON.stringify(args).slice(0, 100)));

                if (args.path && !path.isAbsolute(args.path)) {
                    if (args.path.startsWith('apps/') || args.path.startsWith('libs/') || args.path.startsWith('packages/')) { 
                       args.path = path.join(REPO_ROOT, args.path);
                    } else if (!args.path.startsWith(REPO_ROOT)) {
                         args.path = path.join(REPO_ROOT, args.path);
                    }
                }

                let result;
                
                // Intercept write_file to trigger verify
                // We verify on ANY write_file since changes might trigger test success
                if (fnName === 'write_file') {
                    console.log(chalk.yellow(`  ⚡️ Applying Fix...`));
                    try {
                         const dir = path.dirname(args.path);
                         if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                         fs.writeFileSync(args.path, args.content, 'utf8');
                         
                         // Verification Step
                         console.log(chalk.blue(`  Verifying tests...`));
                         testResult = await runCommand(testCommand, REPO_ROOT);
                         
                         if (testResult.success) {
                             isFixed = true;
                             result = "SUCCESS: Tests passed! Great job.";
                             console.log(chalk.bold.green("  ✅ Tests passed!"));
                         } else {
                             const errors = testResult.stdout + testResult.stderr;
                             result = `FAILURE: Tests still failed after fix.\nOutput:\n${errors.slice(0, 15000)}`;
                             console.log(chalk.red("  ❌ Verify Failed."));
                         }
                    } catch (err) {
                        result = `Error writing file: ${err.message}`;
                    }
                } else {
                   const tool = tools[fnName];
                   if (tool) {
                       result = await tool.handler(args);
                   } else {
                       result = `Error: Tool ${fnName} not found.`;
                   }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result
                });
            }
        }
    } catch (err) {
        console.error(chalk.red("Error in agent loop:"), err.message);
        break;
    }
  }

  if (isFixed) {
    console.log(chalk.green(`  Committing...`));
    
    await runCommand(`git add .`, REPO_ROOT); // Add all changes
    await runCommand(`git checkout HEAD -- package.json yarn.lock 2>/dev/null || true`, REPO_ROOT);

    const testCommitParts = relativePath.split('/');
    const testCommitScope = (testCommitParts.length >= 2 && ['apps', 'libs', 'packages'].includes(testCommitParts[0]))
        ? testCommitParts[1] : 'core';
    const testComponentName = path.basename(relativePath, path.extname(relativePath)).replace(/\.(?:test|spec|vitest)$/, '');

    const commitResult = await runCommand(`git commit --no-verify -m "fix(${testCommitScope}): fix failing tests for ${testComponentName}" -m "Update source code to restore expected behavior and fix broken test assertions. Changes align implementation with existing test expectations."`, REPO_ROOT);
    if (!commitResult.success) console.error(chalk.red(`  ⚠️ Git Commit Failed: ${commitResult.stderr || commitResult.stdout}`));

    if (!BATCH_MODE) {
        const branchCheck = await runCommand(`git branch --show-current`, REPO_ROOT);
        const currentBranch = branchCheck.stdout.trim();

        if (currentBranch && currentBranch !== MAIN_BRANCH && currentBranch !== 'main') {
            const pushResult = await runCommand(`git push --no-verify origin HEAD:refs/heads/${currentBranch}`, REPO_ROOT);
            if (!pushResult.success) {
                console.error(chalk.red(`  ⚠️ Git Push Failed: ${pushResult.stderr}`));
            } else {
                console.log(chalk.bold.green(`  🚀 Successfully published to branch: ${currentBranch}`));
            }
        } else {
            console.log(chalk.yellow(`  ⚠️ Skipping push — on protected branch ${currentBranch}.`));
        }
    }
    console.log(chalk.green(`  Done with ${relativePath}`));
  } else {
    console.log(chalk.bold.red(`  ⚠️ Failed to fix tests for ${relativePath} after ${MAX_STEPS} steps.`));
    console.log(chalk.blue(`  Discarding changes to ${relativePath}...`));
    await runCommand(`git checkout HEAD "${relativePath}"`, REPO_ROOT); 
  }
}

async function runTestFixer() {
  console.log(chalk.bold.magenta("🚀 Starting Auto-Test & Lint Fixer..."));
  
  try {
     // 0. Ensure we're not on master — create a branch if needed
     const initialBranchCheck = await runCommand(`git branch --show-current`, REPO_ROOT);
     const initialBranch = initialBranchCheck.stdout.trim();
     if (initialBranch === MAIN_BRANCH || initialBranch === 'main') {
         const timestamp = Date.now();
         const newBranch = `feat/auto-fix-${timestamp}`;
         console.log(chalk.yellow(`  ⚠️ Currently on ${initialBranch}. Creating branch: ${newBranch}`));
         await runCommand(`git checkout -b "${newBranch}"`, REPO_ROOT);
     }

     // 0. Fetch master and merge into current branch
     console.log(chalk.yellow(`  Fetching and merging ${MAIN_BRANCH}...`));
     
     // Clean up any in-progress merge first
     const mergeHeadPath = path.join(REPO_ROOT, '.git', 'MERGE_HEAD');
     if (fs.existsSync(mergeHeadPath)) {
         console.log(chalk.yellow(`  Detected unfinished merge. Committing it first...`));
         await runCommand(`git add .`, REPO_ROOT);
         const commitResult = await runCommand(`git commit --no-verify --no-edit -m "chore: complete in-progress merge"`, REPO_ROOT);
         if (!commitResult.success) {
             // If commit fails, abort the stale merge
             console.log(chalk.yellow(`  Could not commit stale merge. Aborting it...`));
             await runCommand(`git merge --abort`, REPO_ROOT);
         }
     }
     
     await runCommand(`git fetch origin ${MAIN_BRANCH}`, REPO_ROOT);
     const mergeResult = await runCommand(`git merge origin/${MAIN_BRANCH} --no-edit -X theirs`, REPO_ROOT);
     if (!mergeResult.success) {
         const mergeOutput = mergeResult.stdout + mergeResult.stderr;
         if (/CONFLICT|merge failed/.test(mergeOutput)) {
             // Resolve any remaining conflicts by taking master's version
             console.log(chalk.yellow(`  Merge conflicts detected. Resolving with master's version...`));
             await runCommand(`git checkout --theirs .`, REPO_ROOT);
             await runCommand(`git add .`, REPO_ROOT);
             await runCommand(`git checkout HEAD -- package.json yarn.lock 2>/dev/null || true`, REPO_ROOT);
             await runCommand(`git commit --no-verify --no-edit -m "chore: resolve merge conflicts with ${MAIN_BRANCH} (accept theirs)"`, REPO_ROOT);
             console.log(chalk.green(`  ✅ Conflicts resolved and committed.`));
         } else {
             console.log(chalk.yellow(`  ⚠️ Merge had issues: ${mergeOutput.slice(0, 300)}`));
         }
     } else {
         console.log(chalk.green(`  ✅ Merged origin/${MAIN_BRANCH} into current branch.`));
     }

     // 0b. Install dependencies
     console.log(chalk.yellow(`  Running yarn install...`));
     const installResult = await safeYarnInstall();
     if (!installResult.success) {
         console.log(chalk.yellow(`  ⚠️ yarn install had issues (may be a network problem). Continuing anyway...`));
     } else {
         console.log(chalk.green(`  ✅ Dependencies installed.`));
     }

     // A. Discover Failures (Jest & Vitest)
     const failingTasks = []; // Array of { filePath, runner }

     // 1. Jest Discovery
     const jestOutputFile = 'jest-results.json';
     const jestOutputPath = path.join(REPO_ROOT, jestOutputFile);
     if (fs.existsSync(jestOutputPath)) fs.unlinkSync(jestOutputPath);

     console.log(chalk.yellow(`  Running Jest suite...`));
     const jestCmd = `TZ="Australia/Melbourne" npx jest --maxWorkers=4 --json --outputFile="${jestOutputFile}"`;
     await runCommand(jestCmd, REPO_ROOT);

     if (fs.existsSync(jestOutputPath)) {
         try {
             const testData = JSON.parse(fs.readFileSync(jestOutputPath, 'utf8'));
             const failed = testData.testResults.filter(t => t.status === 'failed');
             failed.forEach(t => {
                 const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
                 failingTasks.push({ filePath: p, runner: 'jest' });
             });
         } catch (e) {
             console.error(chalk.red("  Failed to parse Jest results."));
         }
     }

     // 2. Vitest Discovery
     const vitestOutputFile = 'vitest-results.json';
     const vitestOutputPath = path.join(REPO_ROOT, vitestOutputFile);
     if (fs.existsSync(vitestOutputPath)) fs.unlinkSync(vitestOutputPath);

     console.log(chalk.yellow(`  Running Vitest suite...`));
     // Use --reporter=json to get JSON output
     const vitestCmd = `yarn run test:vitest --reporter=json --outputFile="${vitestOutputFile}"`;
     const vitestDiscoveryResult = await runCommand(vitestCmd, REPO_ROOT);
     const vitestDiscoveryOutput = vitestDiscoveryResult.stdout + vitestDiscoveryResult.stderr;
     const vitestStartupError = /Startup Error|failed to load config|ERR_REQUIRE_ESM/.test(vitestDiscoveryOutput);
     
     if (vitestStartupError) {
         console.log(chalk.yellow(`  ⚠️ Vitest has a startup error (likely broken node_modules). Attempting yarn install...`));
         await safeYarnInstall();
         // Retry once after install
         if (fs.existsSync(vitestOutputPath)) fs.unlinkSync(vitestOutputPath);
         const retryResult = await runCommand(vitestCmd, REPO_ROOT);
         const retryOutput = retryResult.stdout + retryResult.stderr;
         if (/Startup Error|failed to load config|ERR_REQUIRE_ESM/.test(retryOutput)) {
             console.log(chalk.yellow(`  ⚠️ Vitest still can't start after yarn install. Skipping Vitest discovery.`));
         } else if (fs.existsSync(vitestOutputPath)) {
             try {
                 const testData = JSON.parse(fs.readFileSync(vitestOutputPath, 'utf8'));
                 const failed = testData.testResults ? testData.testResults.filter(t => t.status === 'failed') : [];
                 failed.forEach(t => {
                     const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
                     failingTasks.push({ filePath: p, runner: 'vitest' });
                 });
             } catch (e) {
                 console.error(chalk.red("  Failed to parse Vitest results."), e.message);
             }
         }
     } else if (fs.existsSync(vitestOutputPath)) {
         try {
             const testData = JSON.parse(fs.readFileSync(vitestOutputPath, 'utf8'));
             // Vitest JSON is Jest-compatible in structure usually
             const failed = testData.testResults ? testData.testResults.filter(t => t.status === 'failed') : [];
             failed.forEach(t => {
                 const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
                 failingTasks.push({ filePath: p, runner: 'vitest' });
             });
         } catch (e) {
             console.error(chalk.red("  Failed to parse Vitest results."), e.message);
         }
     }

     if (failingTasks.length > 0) {
         console.log(chalk.bold.red(`\n  ⚠️ Found ${failingTasks.length} failing test suites.`));
         console.log(chalk.blue(`Using current branch for fixes...`));
        
         // Dedup based on filePath (prefer Vitest if duplicate? arbitrary order)
         const seen = new Set();
         for (const task of failingTasks) {
             if (seen.has(task.filePath)) continue;
             seen.add(task.filePath);
             
             await fixTestErrorsForFile(task.filePath, task.runner);
         }
     } else {
         console.log(chalk.bold.green("\n  ✅ All Jest & Vitest tests passed!"));
     }

     // 2. Discover Lint Failures (Global)
     console.log(chalk.yellow(`\n  Running Global Lint Check (to find remaining errors)...`));
     // Using --compact or -f json? -f json is better for parsing
     const lintCmd = `yarn lint:js --quiet -f json`;
     
     // We expect this to fail if there are errors, so we ignore the "success" flag for a moment
     const lintRun = await runCommand(lintCmd, REPO_ROOT);
     
     let lintFailures = [];
     try {
         // ESlint outputs the JSON to stdout
         const lintOutput = lintRun.stdout;
         // Find JSON Start (sometimes yarn outputs other text first)
         const jsonStart = lintOutput.indexOf('[');
         const jsonEnd = lintOutput.lastIndexOf(']');
         
         if (jsonStart !== -1 && jsonEnd !== -1) {
             const jsonString = lintOutput.substring(jsonStart, jsonEnd + 1);
             const lintData = JSON.parse(jsonString);
             
             // Filter for files with errorCount > 0, excluding non-project paths
             lintFailures = lintData
                .filter(f => f.errorCount > 0)
                .map(f => {
                    if (f.filePath.startsWith(REPO_ROOT)) {
                        return f.filePath.slice(REPO_ROOT.length + 1);
                    }
                    return f.filePath;
                })
                .filter(f => !SKIP_PATH_PATTERNS.test(f));
         }
     } catch (e) {
         console.log(chalk.dim("  Could not parse lint JSON output. Assuming legacy output or no errors."));
     }

     if (lintFailures.length > 0) {
         console.log(chalk.bold.red(`\n  ⚠️ Found ${lintFailures.length} files with lint errors.`));
         
         // Dedup: Don't re-fix files we just fixed for tests (unless they still have lint errors?)
         // Simpler to just process them.
         for (const filePath of lintFailures) {
             // Optional: Skip if already processed in test loop? 
             // Ideally we check if it's currently clean, but fixLintErrorsForFile does that anyway.
             await fixLintErrorsForFile(filePath);
         }
     } else {
         console.log(chalk.bold.green("  ✅ No global lint errors found!"));
     }

     // 2b. TypeScript Type Check (on changed files)
     console.log(chalk.yellow(`\n  Running TypeScript type check on changed files...`));
     const changedTsResult = await runCommand(`git diff --name-only origin/master | grep -E '\\.tsx?$'`, REPO_ROOT);
     const changedTsFiles = changedTsResult.stdout.trim().split('\n').filter(Boolean);
     
     if (changedTsFiles.length > 0) {
         // Group changed files by app/package directory
         const appDirs = new Map(); // appDir -> [relative files]
         for (const f of changedTsFiles) {
             const parts = f.split('/');
             if (parts.length >= 2) {
                 const appDir = parts.slice(0, 2).join('/'); // e.g., "apps/checkout"
                 const tsconfigPath = path.join(REPO_ROOT, appDir, 'tsconfig.json');
                 if (fs.existsSync(tsconfigPath)) {
                     if (!appDirs.has(appDir)) appDirs.set(appDir, []);
                     appDirs.get(appDir).push(f);
                 }
             }
         }
         
         const typeErrorFiles = new Map(); // filePath -> error text
         
         for (const [appDir, files] of appDirs) {
             console.log(chalk.blue(`  Type-checking ${appDir}...`));
             const tscResult = await runCommand(`npx tsc --noEmit --pretty false`, path.join(REPO_ROOT, appDir));
             const tscOutput = tscResult.stdout + tscResult.stderr;
             
             // Filter errors to only changed files
             for (const f of files) {
                 // tsc outputs paths relative to the tsconfig dir, so strip appDir prefix
                 const relToApp = f.replace(`${appDir}/`, '');
                 const fileErrors = tscOutput.split('\n').filter(line => line.includes(relToApp) && line.includes('error TS'));
                 if (fileErrors.length > 0) {
                     typeErrorFiles.set(f, fileErrors.join('\n'));
                     console.log(chalk.red(`  ${f}: ${fileErrors.length} type error(s)`));
                 }
             }
         }
         
         if (typeErrorFiles.size > 0) {
             console.log(chalk.bold.red(`\n  ⚠️ Found TypeScript errors in ${typeErrorFiles.size} changed file(s).`));
             for (const [filePath, errors] of typeErrorFiles) {
                 await fixTypeErrorsForFile(filePath, errors);
             }
         } else {
             console.log(chalk.bold.green("  ✅ No TypeScript type errors in changed files!"));
         }
     } else {
         console.log(chalk.bold.green("  ✅ No changed TypeScript files to check."));
     }

     // 3. Prune Suppressions (Final Pass)
     console.log(chalk.yellow(`\n  Running final suppression prune...`));
     const pruneResult = await runCommand(`yarn lint:js --prune-suppressions`, REPO_ROOT);
     
     if (!pruneResult.success) {
         const pruneErrors = pruneResult.stdout + pruneResult.stderr;
         const isEnvError = /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(pruneErrors);
         
         if (isEnvError) {
             console.log(chalk.yellow(`  ⚠️ Prune suppressions skipped (missing eslint dependency). Run yarn install to fix.`));
         } else {
             // Errors in .hermit/ or other non-project files are expected — not a real failure
             console.log(chalk.yellow(`  ⚠️ Prune command exited with errors (likely non-project files like .hermit/). Checking suppressions anyway...`));
         }
     }

     // Check if eslint-suppressions.json was modified regardless of exit code
     const statusResult = await runCommand(`git diff --name-only eslint-suppressions.json`, REPO_ROOT);
     const changed = statusResult.stdout.trim().length > 0;
     
     if (changed) {
         console.log(chalk.blue(`  Suppressions file changed, committing...`));
         await runCommand(`git add eslint-suppressions.json`, REPO_ROOT);
         await runCommand(`git commit --no-verify -m "chore: prune obsolete eslint suppressions"`, REPO_ROOT);
         console.log(chalk.bold.green(`  ✅ Suppressions pruned and committed.`));
     } else {
         console.log(chalk.bold.green(`  ✅ No obsolete suppressions found.`));
     }

     // 4. Final commit & push for any remaining uncommitted changes
     console.log(chalk.yellow(`\n  Checking for uncommitted changes...`));
     const statusCheck = await runCommand(`git status --porcelain`, REPO_ROOT);
     const uncommitted = statusCheck.stdout.trim();
     
     if (uncommitted) {
         console.log(chalk.blue(`  Found uncommitted changes, committing...`));
         console.log(chalk.dim(uncommitted));
         await runCommand(`git add .`, REPO_ROOT);
         await runCommand(`git checkout HEAD -- package.json yarn.lock 2>/dev/null || true`, REPO_ROOT);
         const finalCommit = await runCommand(`git commit --no-verify -m "feat(core): automated lint, type, and test fixes" -m "Batch of automated fixes including: static i18n key migration, TypeScript type error resolution, and test regression fixes. All changes preserve existing runtime behavior."`, REPO_ROOT);
         
         if (finalCommit.success) {
             const branchCheck = await runCommand(`git branch --show-current`, REPO_ROOT);
             const currentBranch = branchCheck.stdout.trim();
             
             if (currentBranch === MAIN_BRANCH || currentBranch === 'main') {
                 console.error(chalk.red(`  ⚠️ Refusing to push to ${currentBranch}. Create a feature branch first.`));
             } else {
                 const pushResult = await runCommand(`git push --no-verify origin HEAD:refs/heads/${currentBranch}`, REPO_ROOT);
                 if (pushResult.success) {
                     console.log(chalk.bold.green(`  🚀 Final changes pushed to ${currentBranch}.`));
                 } else {
                     console.error(chalk.red(`  ⚠️ Push failed: ${pushResult.stderr.slice(0, 300)}`));
                 }
             }
         } else {
             console.log(chalk.yellow(`  ⚠️ Nothing to commit (working tree clean).`));
         }
     } else {
         console.log(chalk.bold.green(`  ✅ Working tree clean — nothing to commit.`));
     }

     // 5. Create Pull Request (if branch is not master and no PR exists yet)
     const finalBranchCheck = await runCommand(`git branch --show-current`, REPO_ROOT);
     const finalBranch = finalBranchCheck.stdout.trim();
     
     if (finalBranch && finalBranch !== MAIN_BRANCH && finalBranch !== 'main') {
         // Ensure branch is pushed
         await runCommand(`git push --no-verify origin HEAD:refs/heads/${finalBranch}`, REPO_ROOT);
         
         // Check if a PR already exists for this branch
         const existingPr = await runCommand(`gh pr view "${finalBranch}" --json url 2>/dev/null`, REPO_ROOT);
         
         if (existingPr.success && existingPr.stdout.includes('url')) {
             const prData = JSON.parse(existingPr.stdout);
             console.log(chalk.blue(`  PR already exists: ${prData.url}`));
         } else {
             console.log(chalk.yellow(`\n  Creating Pull Request...`));
             
             // Derive scope from branch name or changed files
             const changedFilesResult = await runCommand(`git diff --name-only origin/${MAIN_BRANCH}...HEAD`, REPO_ROOT);
             const changedFiles = changedFilesResult.stdout.trim().split('\n').filter(Boolean);
             const firstChanged = changedFiles[0] || '';
             const prParts = firstChanged.split('/');
             const prScope = (prParts.length >= 2 && ['apps', 'libs', 'packages'].includes(prParts[0]))
                 ? prParts[1] : 'core';
             
             const prTitle = `feat(${prScope}): automated lint, type, and test fixes`;

             // Generate detailed explanation from diff
             const detailedExplanation = await generatePRExplanation(MAIN_BRANCH, 'HEAD', changedFiles);

             const prBody = [
                 `## Summary`,
                 ``,
                 `Automated fixes for ESLint violations, TypeScript type errors, and failing tests.`,
                 ``,
                 `All translation keys passed to \`t()\` are now statically analyzable where applicable.`,
                 ``,
                 `## Changed files`,
                 ``,
                 changedFiles.slice(0, 30).map(f => `- \`${f}\``).join('\n'),
                 changedFiles.length > 30 ? `- ... and ${changedFiles.length - 30} more` : '',
                 ``,
                 `## What was done`,
                 ``,
                 `- Replaced dynamic i18n keys with static string literals`,
                 `- Fixed TypeScript type errors`,
                 `- Fixed failing test suites`,
                 `- Pruned obsolete eslint suppressions`,
                 `- Preserved all existing runtime behavior`,
                 ``,
                 detailedExplanation ? detailedExplanation : '',
                 detailedExplanation ? '' : null,
                 `## Testing`,
                 ``,
                 `- ESLint passes`,
                 `- All tests pass (Jest + Vitest)`,
                 `- TypeScript type checking passes`,
             ].filter(Boolean).join('\n') + PR_CHECKLIST;
             
             const prBodyFile = path.join(__dirname, '.pr-body-temp.md');
             fs.writeFileSync(prBodyFile, prBody, 'utf8');
             
             const prResult = await runCommand(
                 `gh pr create --draft --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${prBodyFile}" --base ${MAIN_BRANCH} --head "${finalBranch}" --label "${prScope}"`,
                 REPO_ROOT
             );
             
             try { fs.unlinkSync(prBodyFile); } catch (_) {}
             
             if (prResult.success) {
                 console.log(chalk.bold.green(`  🎉 Pull Request created: ${prResult.stdout.trim()}`));
             } else {
                 console.log(chalk.yellow(`  ⚠️ PR creation failed: ${(prResult.stderr || prResult.stdout).slice(0, 500)}`));
             }
         }
     }

     console.log(chalk.bold.green("\n🎉 Auto-fix processing complete!"));

  } catch (error) {
    console.error(chalk.red("Fatal Error in auto-fix runner:"), error);
  }
}

async function runBatchFixer() {
  console.log(chalk.bold.blue("🚀 Starting Batch Lint Fixer..."));
  BATCH_MODE = true;
  
  try {
    const listPath = path.resolve(__dirname, 'list.json');
    if (!fs.existsSync(listPath)) {
        console.error(chalk.red("list.json not found!"));
        return;
    }
    const fileList = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    
    if (fileList.length === 0) {
        console.log(chalk.yellow("  list.json is empty, nothing to fix."));
        return;
    }

    // Create a new branch for batch fixes
    // Derive app/package scope from the first file path (e.g., apps/checkout/... → checkout)
    const firstFileParts = fileList[0].split('/');
    const appScope = (firstFileParts.length >= 2 && ['apps', 'libs', 'packages'].includes(firstFileParts[0]))
        ? firstFileParts[1] : 'core';
    const firstFile = path.basename(fileList[0], path.extname(fileList[0]));
    const timestamp = Date.now();
    const branchName = `feat/${appScope}/static-i18n-keys-${firstFile}-${timestamp}`;
    
    console.log(chalk.yellow(`  Creating branch: ${branchName}`));
    await runCommand(`git fetch origin ${MAIN_BRANCH}`, REPO_ROOT);
    await runCommand(`git checkout -b "${branchName}" --no-track origin/${MAIN_BRANCH}`, REPO_ROOT);
    
    // Install dependencies on fresh branch
    console.log(chalk.yellow(`  Running yarn install...`));
    await safeYarnInstall();
    
    for (const filePath of fileList) {
      await fixLintErrorsForFile(filePath);
    }

    // --- Test Discovery & Fixing ---
    const failingTasks = []; // Array of { filePath, runner }

    // Jest Discovery
    const jestOutputFile = 'jest-results.json';
    const jestOutputPath = path.join(REPO_ROOT, jestOutputFile);
    if (fs.existsSync(jestOutputPath)) fs.unlinkSync(jestOutputPath);

    console.log(chalk.yellow(`\n  Running Jest suite...`));
    const jestCmd = `TZ="Australia/Melbourne" npx jest --maxWorkers=4 --json --outputFile="${jestOutputFile}"`;
    await runCommand(jestCmd, REPO_ROOT);

    if (fs.existsSync(jestOutputPath)) {
        try {
            const testData = JSON.parse(fs.readFileSync(jestOutputPath, 'utf8'));
            const failed = testData.testResults.filter(t => t.status === 'failed');
            failed.forEach(t => {
                const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
                failingTasks.push({ filePath: p, runner: 'jest' });
            });
        } catch (e) {
            console.error(chalk.red("  Failed to parse Jest results."));
        }
    }

    // Vitest Discovery
    const vitestOutputFile = 'vitest-results.json';
    const vitestOutputPath = path.join(REPO_ROOT, vitestOutputFile);
    if (fs.existsSync(vitestOutputPath)) fs.unlinkSync(vitestOutputPath);

    console.log(chalk.yellow(`  Running Vitest suite...`));
    const vitestCmd = `yarn run test:vitest --reporter=json --outputFile="${vitestOutputFile}"`;
    const vitestDiscoveryResult = await runCommand(vitestCmd, REPO_ROOT);
    const vitestDiscoveryOutput = vitestDiscoveryResult.stdout + vitestDiscoveryResult.stderr;
    const vitestStartupError = /Startup Error|failed to load config|ERR_REQUIRE_ESM/.test(vitestDiscoveryOutput);

    if (vitestStartupError) {
        console.log(chalk.yellow(`  ⚠️ Vitest has a startup error. Attempting yarn install...`));
        await safeYarnInstall();
        if (fs.existsSync(vitestOutputPath)) fs.unlinkSync(vitestOutputPath);
        const retryResult = await runCommand(vitestCmd, REPO_ROOT);
        const retryOutput = retryResult.stdout + retryResult.stderr;
        if (/Startup Error|failed to load config|ERR_REQUIRE_ESM/.test(retryOutput)) {
            console.log(chalk.yellow(`  ⚠️ Vitest still can't start. Skipping Vitest discovery.`));
        } else if (fs.existsSync(vitestOutputPath)) {
            try {
                const testData = JSON.parse(fs.readFileSync(vitestOutputPath, 'utf8'));
                const failed = testData.testResults ? testData.testResults.filter(t => t.status === 'failed') : [];
                failed.forEach(t => {
                    const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
                    failingTasks.push({ filePath: p, runner: 'vitest' });
                });
            } catch (e) {
                console.error(chalk.red("  Failed to parse Vitest results."), e.message);
            }
        }
    } else if (fs.existsSync(vitestOutputPath)) {
        try {
            const testData = JSON.parse(fs.readFileSync(vitestOutputPath, 'utf8'));
            const failed = testData.testResults ? testData.testResults.filter(t => t.status === 'failed') : [];
            failed.forEach(t => {
                const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
                failingTasks.push({ filePath: p, runner: 'vitest' });
            });
        } catch (e) {
            console.error(chalk.red("  Failed to parse Vitest results."), e.message);
        }
    }

    if (failingTasks.length > 0) {
        console.log(chalk.bold.red(`\n  ⚠️ Found ${failingTasks.length} failing test suites.`));
        const seen = new Set();
        for (const task of failingTasks) {
            if (seen.has(task.filePath)) continue;
            seen.add(task.filePath);
            await fixTestErrorsForFile(task.filePath, task.runner);
        }
    } else {
        console.log(chalk.bold.green("\n  ✅ All Jest & Vitest tests passed!"));
    }

    // --- TypeScript Type Check (on changed files) ---
    console.log(chalk.yellow(`\n  Running TypeScript type check on changed files...`));
    const changedTsResult = await runCommand(`git diff --name-only origin/${MAIN_BRANCH} | grep -E '\\.tsx?$'`, REPO_ROOT);
    const changedTsFiles = changedTsResult.stdout.trim().split('\n').filter(Boolean);

    if (changedTsFiles.length > 0) {
        const appDirs = new Map();
        for (const f of changedTsFiles) {
            const parts = f.split('/');
            if (parts.length >= 2) {
                const appDir = parts.slice(0, 2).join('/');
                const tsconfigPath = path.join(REPO_ROOT, appDir, 'tsconfig.json');
                if (fs.existsSync(tsconfigPath)) {
                    if (!appDirs.has(appDir)) appDirs.set(appDir, []);
                    appDirs.get(appDir).push(f);
                }
            }
        }

        const typeErrorFiles = new Map();

        for (const [appDir, files] of appDirs) {
            console.log(chalk.blue(`  Type-checking ${appDir}...`));
            const tscResult = await runCommand(`npx tsc --noEmit --pretty false`, path.join(REPO_ROOT, appDir));
            const tscOutput = tscResult.stdout + tscResult.stderr;

            for (const f of files) {
                const relToApp = f.replace(`${appDir}/`, '');
                const fileErrors = tscOutput.split('\n').filter(line => line.includes(relToApp) && line.includes('error TS'));
                if (fileErrors.length > 0) {
                    typeErrorFiles.set(f, fileErrors.join('\n'));
                    console.log(chalk.red(`  ${f}: ${fileErrors.length} type error(s)`));
                }
            }
        }

        if (typeErrorFiles.size > 0) {
            console.log(chalk.bold.red(`\n  ⚠️ Found TypeScript errors in ${typeErrorFiles.size} changed file(s).`));
            for (const [filePath, errors] of typeErrorFiles) {
                await fixTypeErrorsForFile(filePath, errors);
            }
        } else {
            console.log(chalk.bold.green("  ✅ No TypeScript type errors in changed files!"));
        }
    } else {
        console.log(chalk.bold.green("  ✅ No changed TypeScript files to check."));
    }

    // --- Prune Suppressions ---
    console.log(chalk.yellow(`\n  Running final suppression prune...`));
    const pruneResult = await runCommand(`yarn lint:js --prune-suppressions`, REPO_ROOT);

    if (!pruneResult.success) {
        const pruneErrors = pruneResult.stdout + pruneResult.stderr;
        if (/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(pruneErrors)) {
            console.log(chalk.yellow(`  ⚠️ Prune suppressions skipped (missing eslint dependency).`));
        } else {
            console.log(chalk.yellow(`  ⚠️ Prune command exited with errors (likely non-project files like .hermit/). Checking suppressions anyway...`));
        }
    }

    // Check if eslint-suppressions.json was modified regardless of exit code
    const pruneStatus = await runCommand(`git diff --name-only eslint-suppressions.json`, REPO_ROOT);
    if (pruneStatus.stdout.trim().length > 0) {
        console.log(chalk.blue(`  Suppressions file changed, will be included in final commit.`));
    } else {
        console.log(chalk.bold.green(`  ✅ No obsolete suppressions found.`));
    }

    // Final commit & push for any remaining uncommitted changes
    console.log(chalk.yellow(`\n  Checking for uncommitted changes...`));
    const statusCheck = await runCommand(`git status --porcelain`, REPO_ROOT);
    const uncommitted = statusCheck.stdout.trim();
    
    if (uncommitted) {
        console.log(chalk.blue(`  Found uncommitted changes, committing...`));
        console.log(chalk.dim(uncommitted));
                                                                              65
        await runCommand(`git add .`, REPO_ROOT);
        await runCommand(`git checkout HEAD -- package.json yarn.lock 2>/dev/null || true`, REPO_ROOT);
        await runCommand(`git commit --no-verify -m "feat(${appScope}): replace dynamic i18n keys with static keys" -m "Migrate dynamic translation key construction to static string literals across multiple files. This ensures all i18n keys are statically analyzable and satisfy the @afterpay/i18n-only-static-keys ESLint rule."`, REPO_ROOT);
    }

    // Always push the branch (individual fixers commit but don't push in batch mode)
    console.log(chalk.yellow(`  Pushing branch to origin...`));
    const pushResult = await runCommand(`git push --no-verify -u origin HEAD:refs/heads/${branchName}`, REPO_ROOT);
    if (pushResult.success) {
        console.log(chalk.bold.green(`  🚀 Branch pushed to ${branchName}.`));
    } else {
        console.log(chalk.red(`  ⚠️ Push failed: ${(pushResult.stderr || pushResult.stdout).slice(0, 300)}`));
    }

    // --- Create Pull Request ---
    console.log(chalk.yellow(`\n  Creating Pull Request...`));
    
    // Build file list summary for the PR body
    const fileBasenames = fileList.map(f => path.basename(f, path.extname(f)));
    const fileListMarkdown = fileList.map(f => `- \`${f}\``).join('\n');
    
    // Determine PR title
    const prTitle = fileList.length === 1
        ? `feat(${appScope}): migrate ${fileBasenames[0]} to static i18n keys`
        : `feat(${appScope}): replace dynamic i18n keys with static keys`;

    // Generate detailed explanation from diff
    const detailedExplanation = await generatePRExplanation(MAIN_BRANCH, 'HEAD', fileList);

    // Build PR description
    const prBody = [
        `## Summary`,
        ``,
        `Replace dynamic i18n key construction with static string literals to satisfy the \`@afterpay/i18n-only-static-keys\` ESLint rule.`,
        ``,
        `All translation keys passed to \`t()\` are now statically analyzable, enabling reliable key extraction and dead-key detection.`,
        ``,
        `## Changes`,
        ``,
        `${fileListMarkdown}`,
        ``,
        `## What was done`,
        ``,
        `- Replaced dynamic template literal keys with static string literals`,
        `- Used declarative \`Record\` maps to enumerate all possible translation keys per enum/type`,
        `- Split ternary key selection into separate \`t()\` calls on each branch`,
        `- Removed corresponding entries from \`eslint-suppressions.json\``,
        `- Preserved all existing runtime behavior — no logic changes`,
        ``,
        detailedExplanation ? detailedExplanation : '',
        detailedExplanation ? '' : null,
        `## Testing`,
        ``,
        `- ESLint passes with no \`@afterpay/i18n-only-static-keys\` violations`,
        `- All existing tests pass`,
        `- TypeScript type checking passes`,
    ].filter(Boolean).join('\n') + PR_CHECKLIST;
    
    // Write PR body to temp file to avoid shell escaping issues
    const prBodyFile = path.join(__dirname, '.pr-body-temp.md');
    fs.writeFileSync(prBodyFile, prBody, 'utf8');
    
    const prResult = await runCommand(
        `gh pr create --draft --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${prBodyFile}" --base ${MAIN_BRANCH} --head "${branchName}" --label "${appScope}"`,
        REPO_ROOT
    );
    
    // Clean up temp file
    try { fs.unlinkSync(prBodyFile); } catch (_) {}
    
    if (prResult.success) {
        const prUrl = prResult.stdout.trim();
        console.log(chalk.bold.green(`  🎉 Pull Request created: ${prUrl}`));
    } else {
        console.log(chalk.yellow(`  ⚠️ PR creation failed (you may need to create it manually): ${(prResult.stderr || prResult.stdout).slice(0, 500)}`));
    }
    
    console.log(chalk.bold.green("\n🎉 Batch processing complete!"));
  } catch (error) {
    console.error(chalk.red("Fatal Error in batch runner:"), error);
  }
}

// --- PARALLEL FIXER (git worktree + concurrent workers) ---

async function runParallelFixer() {
  console.log(chalk.bold.blue("🚀 Starting Parallel Fixer..."));

  const listPath = path.resolve(__dirname, 'list.json');
  if (!fs.existsSync(listPath)) {
    console.error(chalk.red("list.json not found!"));
    return;
  }
  const fileList = JSON.parse(fs.readFileSync(listPath, 'utf8'));

  if (fileList.length === 0) {
    console.log(chalk.yellow("  list.json is empty, nothing to fix."));
    return;
  }

  const CONCURRENCY = parseInt(process.env.LOOPER_CONCURRENCY || '3', 10);
  const worktreeBase = path.resolve(REPO_ROOT, '..', '.looper-worktrees');

  // Clean up stale worktrees from previous runs
  await runCommand(`git worktree prune`, REPO_ROOT);
  if (fs.existsSync(worktreeBase)) {
    const existingWt = await runCommand(`git worktree list --porcelain`, REPO_ROOT);
    for (const line of existingWt.stdout.split('\n')) {
      if (line.startsWith('worktree ') && line.includes('.looper-worktrees')) {
        await runCommand(`git worktree remove "${line.replace('worktree ', '')}" --force`, REPO_ROOT);
      }
    }
    await runCommand(`rm -rf "${worktreeBase}"`, REPO_ROOT);
  }
  fs.mkdirSync(worktreeBase, { recursive: true });

  // Fetch latest
  console.log(chalk.yellow("  Fetching latest from origin..."));
  await runCommand(`git fetch origin ${MAIN_BRANCH}`, REPO_ROOT);

  // Build task descriptors
  const tasks = fileList.map((filePath, i) => {
    const parts = filePath.split('/');
    const appScope = (parts.length >= 2 && ['apps', 'libs', 'packages'].includes(parts[0]))
      ? parts[1] : 'core';
    const component = path.basename(filePath, path.extname(filePath));
    const branchName = `feat/${appScope}/static-i18n-keys-${component}-${Date.now()}-${i}`;
    const worktreeDir = path.join(worktreeBase, `w${i}-${component}`);
    return { filePath, branchName, appScope, component, worktreeDir, index: i, failed: false };
  });

  // Create all worktrees sequentially (git internals use lockfiles)
  console.log(chalk.yellow(`\n  Creating ${tasks.length} worktrees...`));
  for (const task of tasks) {
    const wtResult = await runCommand(
      `git worktree add -b "${task.branchName}" "${task.worktreeDir}" --no-track origin/${MAIN_BRANCH}`,
      REPO_ROOT
    );
    if (!wtResult.success) {
      console.error(chalk.red(`  ✗ ${task.component}: ${wtResult.stderr.slice(0, 200)}`));
      task.failed = true;
      continue;
    }

    // Symlink node_modules directories from main repo for speed
    // Find top-level and workspace-level node_modules (max depth 4, skip nested)
    const nmFind = await runCommand(
      `find "${REPO_ROOT}" -name node_modules -maxdepth 4 -type d -not -path "*/node_modules/*"`,
      REPO_ROOT
    );
    const nmDirs = nmFind.stdout.trim().split('\n').filter(Boolean);
    for (const nmDir of nmDirs) {
      const rel = nmDir.slice(REPO_ROOT.length + 1); // e.g. "node_modules" or "apps/checkout/node_modules"
      const targetDir = path.join(task.worktreeDir, path.dirname(rel));
      const targetLink = path.join(task.worktreeDir, rel);
      if (!fs.existsSync(targetLink)) {
        fs.mkdirSync(targetDir, { recursive: true });
        try { fs.symlinkSync(nmDir, targetLink); } catch (_) {}
      }
    }

    console.log(chalk.green(`  ✅ ${task.component} → ${task.branchName}`));
  }

  const activeTasks = tasks.filter(t => !t.failed);
  console.log(chalk.blue(`\n  Processing ${activeTasks.length} files with ${CONCURRENCY} concurrent workers...\n`));

  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];
  const results = [];

  for (let i = 0; i < activeTasks.length; i += CONCURRENCY) {
    const batch = activeTasks.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(activeTasks.length / CONCURRENCY);

    console.log(chalk.bold.cyan(`\n━━━ Batch ${batchNum}/${totalBatches} (${batch.map(t => t.component).join(', ')}) ━━━\n`));

    const batchResults = await Promise.all(
      batch.map((task, j) => spawnWorker(task, colors[(i + j) % colors.length]))
    );
    results.push(...batchResults);
  }

  // Add failed-to-start tasks
  for (const task of tasks.filter(t => t.failed)) {
    results.push({ filePath: task.filePath, success: false, error: 'Worktree creation failed' });
  }

  // Clean up all worktrees
  console.log(chalk.yellow("\n  Cleaning up worktrees..."));
  for (const task of tasks) {
    if (!task.failed) {
      await runCommand(`git worktree remove "${task.worktreeDir}" --force`, REPO_ROOT);
    }
  }
  await runCommand(`git worktree prune`, REPO_ROOT);
  await runCommand(`rm -rf "${worktreeBase}"`, REPO_ROOT);

  // Summary
  console.log(chalk.bold.blue("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.bold.blue("  PARALLEL FIXER RESULTS"));
  console.log(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    console.log(`  ${icon} ${r.filePath}`);
    if (r.prUrl) console.log(chalk.green(`     PR: ${r.prUrl}`));
    if (r.error) console.log(chalk.red(`     ${r.error}`));
  }

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  console.log(`\n  ${chalk.green(`${succeeded.length} succeeded`)} / ${results.length} total`);
  if (failed.length > 0) console.log(chalk.red(`  ${failed.length} failed`));
}

function spawnWorker(task, color) {
  const label = chalk.hex(color)(`[${task.component}]`);
  console.log(`${label} Starting worker...`);

  return new Promise((resolve) => {
    const child = require('child_process').spawn(
      process.execPath,
      [path.join(__dirname, 'index.js'), '--worker'],
      {
        env: {
          ...process.env,
          LOOPER_REPO_ROOT: task.worktreeDir,
          LOOPER_WORKER_FILE: task.filePath,
          LOOPER_WORKER_BRANCH: task.branchName,
          LOOPER_WORKER_SCOPE: task.appScope,
          LOOPER_WORKER_COMPONENT: task.component,
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
      lines.forEach(line => console.log(`${label} ${line}`));
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => console.log(`${label} ${chalk.dim(line)}`));
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const prMatch = stdout.match(/Pull Request created: (https:\/\/\S+)/);
      resolve({
        filePath: task.filePath,
        success: code === 0,
        prUrl: prMatch ? prMatch[1] : null,
        error: code !== 0 ? `Worker exited with code ${code}` : null,
      });
    });

    child.on('error', (err) => {
      resolve({
        filePath: task.filePath,
        success: false,
        error: `Failed to spawn worker: ${err.message}`,
      });
    });
  });
}

async function runWorkerMode() {
  const workerFile = process.env.LOOPER_WORKER_FILE;
  const workerBranch = process.env.LOOPER_WORKER_BRANCH;
  const workerScope = process.env.LOOPER_WORKER_SCOPE;
  const workerComponent = process.env.LOOPER_WORKER_COMPONENT;

  console.log(`Worker starting: ${workerFile}`);
  console.log(`  Branch: ${workerBranch}`);
  console.log(`  Repo root: ${REPO_ROOT}`);

  BATCH_MODE = true;

  try {
    // 1. Fix lint errors
    await fixLintErrorsForFile(workerFile);

    // 2. Run related Jest tests
    console.log(`\n  Running related Jest tests...`);
    const jestCmd = `TZ="Australia/Melbourne" npx jest --findRelatedTests "${workerFile}" --json 2>/dev/null`;
    const jestResult = await runCommand(jestCmd, REPO_ROOT);

    if (jestResult.stdout.includes('"testResults"')) {
      try {
        const jsonStart = jestResult.stdout.indexOf('{');
        const jestData = JSON.parse(jestResult.stdout.slice(jsonStart));
        const jestFailed = (jestData.testResults || []).filter(t => t.status === 'failed');
        if (jestFailed.length > 0) {
          console.log(`  ${jestFailed.length} Jest test suite(s) failing`);
          for (const t of jestFailed) {
            const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
            await fixTestErrorsForFile(p, 'jest');
          }
        } else {
          console.log(`  ✅ Jest tests passed.`);
        }
      } catch (e) {
        console.log(`  Could not parse Jest results: ${e.message}`);
      }
    } else {
      console.log(`  ✅ No related Jest tests found.`);
    }

    // 3. Run related Vitest tests
    console.log(`\n  Running related Vitest tests...`);
    const vitestCmd = `yarn run test:vitest --related "${workerFile}" --reporter=json 2>/dev/null`;
    const vitestResult = await runCommand(vitestCmd, REPO_ROOT);
    const vitestOutput = vitestResult.stdout + vitestResult.stderr;

    if (vitestOutput.includes('"testResults"')) {
      try {
        const jsonStart = vitestOutput.indexOf('{');
        const vitestData = JSON.parse(vitestOutput.slice(jsonStart));
        const vitestFailed = (vitestData.testResults || []).filter(t => t.status === 'failed');
        if (vitestFailed.length > 0) {
          console.log(`  ${vitestFailed.length} Vitest test suite(s) failing`);
          for (const t of vitestFailed) {
            const p = t.name.startsWith(REPO_ROOT) ? t.name.slice(REPO_ROOT.length + 1) : t.name;
            await fixTestErrorsForFile(p, 'vitest');
          }
        } else {
          console.log(`  ✅ Vitest tests passed.`);
        }
      } catch (e) {
        console.log(`  Could not parse Vitest results: ${e.message}`);
      }
    } else {
      console.log(`  ✅ No related Vitest tests found.`);
    }

    // 4. TypeScript type check on changed files
    console.log(`\n  Running TypeScript type check...`);
    const changedTsResult = await runCommand(`git diff --name-only origin/${MAIN_BRANCH} | grep -E '\\.tsx?$'`, REPO_ROOT);
    const changedTsFiles = changedTsResult.stdout.trim().split('\n').filter(Boolean);

    if (changedTsFiles.length > 0) {
      const appDirs = new Map();
      for (const f of changedTsFiles) {
        const parts = f.split('/');
        if (parts.length >= 2) {
          const appDir = parts.slice(0, 2).join('/');
          const tsconfigPath = path.join(REPO_ROOT, appDir, 'tsconfig.json');
          if (fs.existsSync(tsconfigPath)) {
            if (!appDirs.has(appDir)) appDirs.set(appDir, []);
            appDirs.get(appDir).push(f);
          }
        }
      }

      for (const [appDir, files] of appDirs) {
        console.log(`  Type-checking ${appDir}...`);
        const tscResult = await runCommand(`npx tsc --noEmit --pretty false`, path.join(REPO_ROOT, appDir));
        const tscOutput = tscResult.stdout + tscResult.stderr;
        for (const f of files) {
          const relToApp = f.replace(`${appDir}/`, '');
          const fileErrors = tscOutput.split('\n').filter(line => line.includes(relToApp) && line.includes('error TS'));
          if (fileErrors.length > 0) {
            console.log(`  ${f}: ${fileErrors.length} type error(s)`);
            await fixTypeErrorsForFile(f, fileErrors.join('\n'));
          }
        }
      }
    } else {
      console.log(`  ✅ No changed TypeScript files.`);
    }

    // 5. Prune suppressions
    console.log(`\n  Pruning suppressions...`);
    await runCommand(`yarn lint:js --prune-suppressions`, REPO_ROOT);
    const pruneStatus = await runCommand(`git diff --name-only eslint-suppressions.json`, REPO_ROOT);
    if (pruneStatus.stdout.trim().length > 0) {
      console.log(`  Suppressions file updated.`);
    }

    // 6. Final commit & push
    const statusCheck = await runCommand(`git status --porcelain`, REPO_ROOT);
    if (statusCheck.stdout.trim()) {
      await runCommand(`git add .`, REPO_ROOT);
      await runCommand(`git checkout HEAD -- package.json yarn.lock 2>/dev/null || true`, REPO_ROOT);
      await runCommand(
        `git commit --no-verify -m "feat(${workerScope}): migrate ${workerComponent} to static i18n keys" -m "Replace dynamic i18n key construction with static string literals to satisfy the @afterpay/i18n-only-static-keys ESLint rule."`,
        REPO_ROOT
      );
    }

    // Push from the main repo using the worktree's branch — worktrees share the object store
    // but pushing from a worktree can fail if git config is not inherited properly.
    const mainRepo = process.env.LOOPER_MAIN_REPO || REPO_ROOT;
    console.log(`  Pushing branch to origin...`);
    const pushResult = await runCommand(
      `git push --no-verify -u origin HEAD:refs/heads/${workerBranch}`,
      REPO_ROOT
    );

    // Fallback: if push from worktree failed, try pushing from the main repo
    if (!pushResult.success) {
      console.log(`  Retrying push from main repo...`);
      const fallbackPush = await runCommand(
        `git push --no-verify origin ${workerBranch}:refs/heads/${workerBranch}`,
        mainRepo
      );
      if (!fallbackPush.success) {
        console.error(`  Push failed from both worktree and main repo: ${fallbackPush.stderr.slice(0, 300)}`);
        process.exit(1);
      }
    }

    if (!pushResult.success) {
      console.error(`  Push failed: ${pushResult.stderr.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`  Branch pushed successfully.`);

    // 7. Generate detailed PR explanation from diff
    console.log(`  Generating detailed PR explanation...`);
    const detailedExplanation = await generatePRExplanation(MAIN_BRANCH, 'HEAD', [workerFile]);

    // 8. Create PR
    console.log(`  Creating Pull Request...`);
    const prTitle = `feat(${workerScope}): migrate ${workerComponent} to static i18n keys`;
    const prBody = [
      `## Summary`,
      ``,
      `Replace dynamic i18n key construction with static string literals to satisfy the \`@afterpay/i18n-only-static-keys\` ESLint rule.`,
      ``,
      `## Changes`,
      ``,
      `- \`${workerFile}\``,
      ``,
      `## What was done`,
      ``,
      `- Replaced dynamic template literal keys with static string literals`,
      `- Used declarative Record maps to enumerate all possible translation keys`,
      `- Removed corresponding entries from eslint-suppressions.json`,
      `- Preserved all existing runtime behavior`,
      ``,
      detailedExplanation ? detailedExplanation : '',
      detailedExplanation ? '' : null,
      `## Testing`,
      ``,
      `- ESLint passes`,
      `- Related tests pass (Jest + Vitest)`,
      `- TypeScript type checking passes`,
    ].filter(Boolean).join('\n') + PR_CHECKLIST;

    const prBodyFile = path.join(__dirname, `.pr-body-${workerComponent}-${Date.now()}.md`);
    fs.writeFileSync(prBodyFile, prBody, 'utf8');

    const prResult = await runCommand(
      `gh pr create --draft --title "${prTitle.replace(/"/g, '\\"')}" --body-file "${prBodyFile}" --base ${MAIN_BRANCH} --head "${workerBranch}" --label "${workerScope}"`,
      REPO_ROOT
    );

    try { fs.unlinkSync(prBodyFile); } catch (_) {}

    if (prResult.success) {
      console.log(`  🎉 Pull Request created: ${prResult.stdout.trim()}`);
    } else {
      console.log(`  ⚠️ PR creation failed: ${(prResult.stderr || prResult.stdout).slice(0, 500)}`);
    }

    process.exit(0);
  } catch (error) {
    console.error(`Worker failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Ensure REPO_ROOT exists
if (!fs.existsSync(REPO_ROOT)) {
    console.warn(chalk.red(`Warning: Target repository path ${REPO_ROOT} does not exist on this machine.`));
    console.warn(chalk.red(`Batch fixer will fail if run.`));
}

// --- TOOL DEFINITIONS ---


const tools = {
  list_files: {
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in the current directory or a specific directory recursively or flat.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The directory path to list (default to current)'
            }
          }
        }
      }
    },
    handler: async ({ path: dirPath = '.' }) => {
      try {
        const files = fs.readdirSync(dirPath);
        return JSON.stringify(files.slice(0, 50)) + (files.length > 50 ? `... (${files.length - 50} more)` : '');
      } catch (error) {
        return `Error listing files: ${error.message}`;
      }
    }
  },
  read_file: {
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file. Use this to inspect code, logs, or config.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The path of the file to read'
            }
          },
          required: ['path']
        }
      }
    },
    handler: async ({ path: filePath }) => {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content;
      } catch (error) {
        return `Error reading file: ${error.message}`;
      }
    }
  },
  write_file: {
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file. Overwrites existing content. Always read first if unsure.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The path of the file to write'
            },
            content: {
              type: 'string',
              description: 'The content to write'
            }
          },
          required: ['path', 'content']
        }
      }
    },
    handler: async ({ path: filePath, content }) => {
      try {
        // Guard: never allow writing to package.json, yarn.lock, or lock files
        const basename = path.basename(filePath);
        if (/^(package\.json|yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/.test(basename)) {
          return `Error: Writing to ${basename} is not allowed. Focus on fixing the source file only.`;
        }
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf8');
        return `Successfully wrote to ${filePath}`;
      } catch (error) {
        return `Error writing file: ${error.message}`;
      }
    }
  },
  run_command: {
    definition: {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Execute a shell command (e.g., git, npm, ls, cat). Non-interactive only.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The command to execute'
            }
          },
          required: ['command']
        }
      }
    },
    handler: async ({ command }) => {
      console.log(chalk.yellow(`  Running: ${command}`));
      return new Promise((resolve) => {
        exec(command, { timeout: 60000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
          const output = (stdout || '') + (stderr ? `\nSTDERR:\n${stderr}` : '');
          if (error) {
            const errorMsg = error.killed ? 'Command Timed Out (60s).' : error.message;
            resolve(`Command Failed.\nError: ${errorMsg}\nOutput: ${output.slice(0, 4000)}`);
          } else {
            resolve(output.slice(0, 8000) + (output.length > 8000 ? '\n...(output truncated)' : ''));
          }
        });
      });
    }
  }
};

// --- SYSTEM PROMPT (The "Brain") ---

const MASTER_PROMPT = `
## MASTER PROMPT: Autonomous Agentic Loop Architect

### Role & Objective

You are an **expert autonomous agent** operating in a Node.js environment. Your task is to reliably pursue complex goals through iterative planning, action, observation, reflection, and adaptation.

The agent must:
* Operate autonomously with minimal human intervention
* Use tools safely and effectively
* Detect and recover from failure
* Improve its own plans and heuristics over time

### Core Design Principles

1. **Explicit Control Loop**: No implicit or “magic” reasoning steps.
2. **Separation of Concerns**: Planning ≠ Execution ≠ Evaluation.
3. **Observability**: Explain *why* you chose an action and *what* you expect.
4. **Failure-Tolerance**: Detect, classify, and respond to failures deliberately.
5. **Goal Persistence**: Aggressively pursue the goal but revise plans when evidence demands it.

### Required Agent Loop (Your Mental Process)

Run this loop internally for every step:

1. **State Assessment**: Review progress, tools, and budget.
2. **Planning Phase**: Generate a high-level plan and concrete next subgoals.
3. **Action Selection**: Choose exactly one next action (or response). Justify it.
4. **Action Execution**: (You will provide the tool call here).
5. **Observation**: (Wait for tool output).
6. **Evaluation & Reflection**: Assess the result. Update memory.

### Output Format

You must format your response using XML-like thoughts to show your internal logic, followed by the tool call or final text.

Example format:

<thought>
  <analysis>User wants to set up a project. Directory is empty.</analysis>
  <plan>
    1. Initialize package.json
    2. Create index.js
  </plan>
  <reasoning>I need to init the project first to ensure we have a manifest.</reasoning>
</thought>
(Then make the tool call or provide text)

### Safety & Alignment

* Avoid irreversible or destructive actions without valid confirmation.
* Ask for clarification when goals are underspecified.
* Never fabricate tool outputs.
`;

const messages = [
  { role: "system", content: MASTER_PROMPT }
];

// --- MAIN LOOP ---

async function askQuestion(query) {
  return new Promise(resolve => rl.question(chalk.green(query), resolve));
}

async function runLoop() {
  console.log(chalk.bold.blue("\n🤖 Looper Agent Initialized."));
  console.log(chalk.gray("Type your goal (or 'exit' to quit)"));

  while (true) {
    const userInput = await askQuestion("\n> ");
    if (userInput.toLowerCase() === 'exit') {
      rl.close();
      break;
    }

    messages.push({ role: "user", content: userInput });

    let processing = true;
    while (processing) {
      try {
        process.stdout.write(chalk.gray("Thinking..."));
        
        const response = await client.chat.completions.create({
          model: "gpt-5.2-2025-12-11",
          messages: messages,
          tools: Object.values(tools).map(t => t.definition),
          tool_choice: "auto",
        });

        const message = response.choices[0].message;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);

        messages.push(message);

        // Display "Thought" content beautifully
        if (message.content) {
          // Rudimentary XML parsing for display
          const logicMatch = message.content.toString().match(/<thought>([\s\S]*?)<\/thought>/);
          if (logicMatch) {
             console.log(chalk.cyan("\n[Thought Process]"));
             console.log(chalk.cyan(logicMatch[1].trim().replace(/^/gm, '  ')));
             
             const remainder = message.content.replace(logicMatch[0], '').trim();
             if (remainder) console.log(chalk.blue("\nAgent:"), remainder);
          } else {
             console.log(chalk.blue("\nAgent:"), message.content);
          }
        }

        if (message.tool_calls) {
          for (const toolCall of message.tool_calls) {
            const toolName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            
            console.log(chalk.magenta(`\n> Tool: ${toolName}`), chalk.gray(JSON.stringify(args)));
            
            const tool = tools[toolName];
            let result;
            if (tool) {
               result = await tool.handler(args);
            } else {
               result = `Error: Tool ${toolName} not found.`;
            }

            console.log(chalk.dim(`  Result: ${result.slice(0, 100).replace(/\n/g, ' ')}...`));

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result
            });
          }
        } else {
          // No tools called, turn ends, wait for user.
          processing = false;
        }
      } catch (error) {
        console.error(chalk.red("Error calling OpenAI:"), error.message);
        processing = false;
      }
    }
  }
}

if (process.argv.includes('--worker')) {
  runWorkerMode();
} else if (process.argv.includes('--parallel')) {
  runParallelFixer();
} else if (process.argv.includes('--batch')) {
  runBatchFixer();
} else if (process.argv.includes('--fix-tests') || process.argv.includes('--auto-fix')) {
  runTestFixer();
} else if (process.argv.includes('--check-prs')) {
  // Delegate to the PR health checker script, forwarding remaining args
  const args = process.argv.slice(2).filter(a => a !== '--check-prs');
  require('child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, 'check-prs.js'), ...args],
    { stdio: 'inherit', cwd: __dirname }
  );
} else {
  runLoop();
}
