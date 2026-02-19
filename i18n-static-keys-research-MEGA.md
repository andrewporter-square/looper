# Checkout Static i18n Keys: Comprehensive Research & Implementation Guide

> **Combined from:** High-Level Research + Detailed Per-File Analysis
> **Scope:** `apps/checkout` migration to static i18n keys (code as source-of-truth for extraction)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Baseline](#current-baseline)
3. [Architecture Findings](#architecture-findings)
4. [How the Lint Rule Works](#how-the-lint-rule-works)
5. [Classification of Dynamic Key Patterns](#classification-of-dynamic-key-patterns)
6. [Locale Inventory Signals](#locale-inventory-signals)
7. [Per-File Analysis (All 63 Files, 122 Violations)](#per-file-analysis)
8. [Verified Deep-Dive Findings](#verified-deep-dive-findings)
9. [Complete File Inventory](#complete-file-inventory)
10. [Complexity Summary & Ranked File List](#complexity-summary--ranked-file-list)
11. [Shared Helper Opportunities](#shared-helper-opportunities)
12. [Parameter Space Research](#parameter-space-research)
13. [What Migration Will Take](#what-migration-will-take)
14. [Test Coverage & Correctness Confidence](#test-coverage--correctness-confidence)
15. [E2E Research](#e2e-research)
16. [Route/Page Verification Matrix](#routepage-verification-matrix)
17. [Key Risks & Open Decisions](#key-risks--open-decisions)
18. [Recommended Approach for Implementer](#recommended-approach-for-implementer)

---

## Executive Summary

The migration is **feasible but not a mechanical lint fix**. Primary effort is in:

1. Converting dynamic key composition into finite static lookup domains
2. Deciding policy/tooling for `<Trans i18nKey>` staticity
3. Hardening tests around key selection in a few weak files
4. Validating high-risk flows on summary, terminal error, payment method, login, and post-checkout processing paths

**By the numbers:**

| Metric | Count |
|---|---|
| Total files with `i18n-only-static-keys` suppressions | 63 |
| Total violations | 122 |
| TRIVIAL fixes (ternary splits) | ~22 files, ~25 violations |
| LOW fixes (small enum switch/map) | ~22 files, ~30 violations |
| MODERATE fixes (medium enum + conditions) | ~8 files, ~20 violations |
| HIGH fixes (large enum/combinatorial/architectural) | ~5 files, ~26 violations |
| `i18n-no-dynamic-context` suppressions | 66 across 36 files |
| Dynamic `<Trans i18nKey={...}>` (non-test `.tsx`) | 32 files |

---

## Current Baseline

As of this analysis:

- `@afterpay/i18n-only-static-keys`: **50 suppressions across 15 files** in checkout (top hotspots listed below).
- `@afterpay/i18n-no-dynamic-context`: **66 suppressions across 36 files** in checkout.
- Dynamic `<Trans i18nKey={...}>` (non-test `.tsx`): **32 files**.
  - Important: `i18n-only-static-keys` only validates `t(...)` calls, not `<Trans i18nKey={...}>`.

### Top `i18n-only-static-keys` Hotspots

1. `apps/checkout/src/component/PostCheckout/PostCheckout.tsx` (7)
2. `apps/checkout/src/component/TerminalError/TerminalError.tsx` (6)
3. `apps/checkout/src/page/apple-paylater/summary/consumer-lending-summary/ApplePaylaterConsumerLendingSummary.tsx` (6)
4. `apps/checkout/src/page/summary-pay-monthly/PayMonthlySummary.tsx` (6)
5. `apps/checkout/src/component/SummaryNotification/SummaryNotification.tsx` (5)

---

## Architecture Findings

### 1) `convergence.tsx` wrapper — Compatible with static keys

- `apps/checkout/src/utils/convergence.tsx` wraps next-i18next, expands keys for Cash/AP cohorts, and supports legal-prefix handling.
- This wrapper is **not the blocker**. Static extraction depends on callsites passing literal key candidates.
- The convergence hook operates on the keys provided to it. The goal is to make those provided keys statically extractable.

### 2) `buildTranslationKey(...)` — Centralizes dynamic segment construction

- `apps/checkout/src/utils/locales.ts` builds keys from conditional segments.
- Great runtime behavior, but static extraction needs the finite output set made explicit at callsites (or through typed lookup registries).
- Each call site has a **finite, determinable set of possible outputs** based on the boolean conditions.
- Files using this utility (AutopayModal, EstimatedOrderBreakdown, SummaryNotification) need the output enumerated as static alternatives.

### 3) `useGetLocaleWithFallback(...)` — Creates dynamic fallback arrays

- `apps/checkout/src/utils/post-checkout.tsx` returns:
  - `${localeFile}:asset:${id}.${key}__${variant}-${flow}`
  - `${localeFile}:asset:${id}.${key}__${variant}`
  - `${localeFile}:asset:${id}.${key}`
- This is the **hardest static migration area** due to runtime `assetId + variant + flow` combinations.

### 4) Lint rule coverage gap

- `packages/lint-rules/src/rules/i18n-only-static-keys.ts` checks only `CallExpression` where callee is identifier `t`.
- It does **not** cover:
  - Dynamic `<Trans i18nKey={...}>`
  - Non-`t` translators
  - Helper-returned dynamic keys unless passed to `t` directly

---

## How the Lint Rule Works

The ESLint rule (`packages/lint-rules/src/rules/i18n-only-static-keys.ts`) checks that the first argument to `t()` is a **static string literal** (or a concatenation of static string literals). It rejects:

- Template literals with expressions (`` `prefix:${variable}` ``)
- Variables passed directly (`t(someVariable)`)
- Ternaries as arguments (`t(condition ? 'a' : 'b')`)
- Function return values (`t(getKey())`)

String concatenation with `+` of only string literals **IS** allowed.

---

## Classification of Dynamic Key Patterns

### Pattern A: Template literal with enum/known-finite variable

**Example:** `` t(`paymentMethod:cardType.${feature}`) `` where `feature` is `Feature.PBI | Feature.PCL | Feature.AFF`
**Fix Strategy:** Replace with explicit ternary/conditional chain using all static keys.
**Risk:** LOW — the set of possible values is fixed in an enum.

### Pattern B: Template literal with error code enum

**Example:** `` t(`terminalError:${errorKey}.description`) `` where `errorKey` comes from `TerminalErrorCode` enum
**Fix Strategy:** Replace with lookup map or conditional chain. For large enums, a `Record<EnumValue, string>` mapping enum values to full static keys is practical.
**Risk:** LOW-MEDIUM — enums are well-defined but large (40+ values for TerminalErrorCode).

### Pattern C: Ternary selecting between two static keys

**Example:** `t(condition ? 'key.a' : 'key.b')`
**Fix Strategy:** Extract to `const key = condition ? 'key.a' : 'key.b'` above, then `t(key)`. OR inline both keys explicitly (e.g., `condition ? t('key.a') : t('key.b')`).
**Risk:** VERY LOW — both keys are already known static strings.

### Pattern D: Fallback array from `useGetLocaleWithFallback`

**Example:** `t(localeWithFallback('subtitle'), '', { merchantDisplayName })`
**Fix Strategy:** This is the hardest pattern. Options: (1) enumerate all combinations of assetId × variant × flow for each localeKey, (2) refactor the hook to produce a static key registry, (3) build a separate extraction script that understands this pattern.
**Risk:** MEDIUM-HIGH — combinatorial explosion, but the set is bounded.

### Pattern E: Template literal with `buildTranslationKey` output

**Example:** `t(buildTranslationKey({ namespace: 'summary', segments: ['autopay', modelSegment] }))`
**Fix Strategy:** Enumerate all possible outputs from the segment conditions and replace with conditional `t()` calls using static keys.
**Risk:** LOW-MEDIUM — each call site's conditions are deterministic.

### Pattern F: Function parameter/return value as key

**Example:** `t(getErrorMessage(e))` where `getErrorMessage` returns one of 3 known static strings
**Fix Strategy:** Inline the switch/conditional and call `t()` with each static key directly.
**Risk:** LOW — return values are traced through helper functions.

---

## Locale Inventory Signals

Key locale files (en-AU) with high relevance to dynamic patterns:

| File | Leaf Keys | Notable Patterns |
|---|---|---|
| `postcheckout.json` | 54 | 45 under `asset.*`, 24 variant keys with `__` |
| `processing.json` | 39 | 12 under `asset.*`, 6 variant keys |
| `summary.json` | 224 | 63 `error.*`, 28 `autopay.*`, 8 `bankAccountErrors.*` |
| `terminalError.json` | 193 | 57 `.heading`, 28 `.option` |
| `paymentMethod.json` | 93 | 35 `errors.*`, 4 `threeDS.errors.*` |
| `donation.json` | 45 | 44 campaign-specific keys (`<campaignId>.title/body`) |
| `consumerLending.json` | 374 | Largest file |

**Implication:** Post-checkout assets, terminal errors, payment method errors, and donation campaign keys are the primary static-extraction risk domains.

---

## Per-File Analysis

### File 1: `Asset/component/CallToAction.tsx` (2 violations)

**Pattern:** D (useGetLocaleWithFallback)
**Lines:** `t(localeWithFallback('positiveCta'), translationOption)` and `t(localeWithFallback('negativeCta'), translationOption)`
**Dynamic source:** `localeWithFallback` generates 3-element fallback arrays combining assetId, variant, and flow
**Possible keys per call:** 3 keys × 6 asset IDs = 18 possible keys per call
**Conversion approach:** Either (a) enumerate all possible keys inline for each asset/variant/flow combo, or (b) restructure to move the `t()` call inside the `useGetLocaleWithFallback` hook and maintain a static registry of all asset keys.
**Complexity:** HIGH (part of PostCheckout infrastructure)

### File 2: `Asset/component/Subtitle.tsx` (1 violation)

**Pattern:** D (useGetLocaleWithFallback)
**Line:** `t(localeWithFallback('subtitle'), '', { merchantDisplayName })`
**Same approach as File 1**
**Complexity:** HIGH (part of PostCheckout infrastructure)

### File 3: `AutopayToggle/AutopayButtonToggleText.tsx` (1 violation)

**Pattern:** C (ternary)
**Line:** `t(isExperiment ? 'consumerLending:autopay.name' : 'summary:autopay.name', { context: isAFF ? 'aff' : '' })`
**Fix:** `isExperiment ? t('consumerLending:autopay.name', opts) : t('summary:autopay.name', opts)`
**Complexity:** TRIVIAL

### File 4: `AutopayToggle/AutopayModal.tsx` (4 violations)

**Pattern:** E (buildTranslationKey)
**Lines:**
1. `t(\`${localeKey}.description\`, { context: modalMode })` — `localeKey` = `buildTranslationKey(...)` output
2. `t(modalKey === AutoPayModalKey ? \`summary:autopay.modal.cta\` : \`${buildTranslationKey(...)}\`, { context: modalMode })`
3. `t(\`${localeKey}.heading\`, { context: modalMode })`
4. `t(\`${localeKey}.close\`)`

`localeKey` resolves to one of: `summary:autopay.modal`, `summary:autopay.modal_paymentMonthly`, `summary:autopay.modal_aff`

**Possible static keys (~12):**
- `summary:autopay.modal.description`, `summary:autopay.modal_paymentMonthly.description`, `summary:autopay.modal_aff.description`
- `summary:autopay.modal.heading`, `summary:autopay.modal_paymentMonthly.heading`, `summary:autopay.modal_aff.heading`
- `summary:autopay.modal.close`, `summary:autopay.modal_paymentMonthly.close`, `summary:autopay.modal_aff.close`
- CTA has additional branch for `AutopayConfirmationModalKey`

**Fix:** Replace `buildTranslationKey` call with explicit conditional producing one of the known static keys.
**Complexity:** MODERATE

### File 5: `CardEducation/CardEducation.tsx` (2 violations)

**Pattern:** Variable from a static array definition
**Lines:** `t(feature.titleKey)` and `t(feature.descriptionKey)` inside `.map()`
**Static values:** `features.shopOnline.title`, `features.shopOnline.description`, `features.planPurchase.title`, `features.planPurchase.description`, `features.flexiblePlans.title`, `features.flexiblePlans.description`
**Fix:** Unroll the `.map()` into explicit calls, or use `as const` on the array.
**Complexity:** LOW — just 3 known items

### File 6: `ConsumerLendingTagline/ConsumerLendingTagline.tsx` (1 violation)

**Pattern:** C (ternary)
**Line:** `t(hasZeroAprPromotion || isAFF ? 'consumerLending:payInMoreWithoutInterestTagLine' : 'consumerLending:payInMoreTagline')`
**Fix:** `(hasZeroAprPromotion || isAFF) ? t('consumerLending:payInMoreWithoutInterestTagLine') : t('consumerLending:payInMoreTagline')`
**Complexity:** TRIVIAL

### File 7: `CreatePassword/CreatePassword.tsx` (1 violation)

**Pattern:** B (error code enum)
**Line:** `t(\`createPassword:error:${code}\`, 'common:error:unknown'\])` — uses `t([...])` array fallback
**Static source:** `code` from `errorKeys` Record: `'weakPassword'`, `'identicalPassword'`, `'emptyPassword'`, or `undefined` (triggers `'common:error:unknown'`)
**Possible keys:** `createPassword:error:weakPassword`, `createPassword:error:identicalPassword`, `createPassword:error:emptyPassword`, `common:error:unknown`
**Fix:** Switch/conditional producing static key strings.
**Complexity:** LOW — 4 known values

### File 8: `Donation/Donation.tsx` (1 violation) ⚠️

**Pattern:** A — `campaignName` comes from `donationCampaignDetails?.campaignId` (API response)
**Line:** `t(\`donation:${campaignName}:title\`, { amount })`
**Risk:** **HIGH — `campaignId` is truly arbitrary from an API response** (`string` type in `DonationCampaignDetails`). There is no enum or finite set in the frontend code.
**Fix options:**
1. If campaign IDs are a known finite set, create a lookup map.
2. Change to use `campaignName` as an interpolation variable: `t('donation:campaign:title', { campaignName, amount })`
3. Accept as permanent suppression with documentation.
4. Build a separate campaign key registry mechanism.
**Complexity:** HIGH if campaign IDs are arbitrary (confirmed); LOW if finite set

### File 9: `FinanceFee/EstimatedOrderBreakdown.tsx` (1 violation)

**Pattern:** E (buildTranslationKey)
**Line:** `t(localeKey, { rate })` where `localeKey = buildTranslationKey({segments: [...]})`
**Possible keys:** `summary.sup.financeFee.tooltip` or `summary.giftCard.financeFee.tooltip`
**Fix:** `t(isAfterpayAppGiftCardFlow ? 'summary.giftCard.financeFee.tooltip' : 'summary.sup.financeFee.tooltip', { rate })`
**Complexity:** TRIVIAL

### File 10: `FinanceFee/SupHeader.tsx` (2 violations)

**Pattern:** Template literal with ternary-derived variable
**Lines:** `t(\`${namespace}.header.title\`)` and `t(\`${namespace}.header.content\`, { merchantName })`
**Possible keys:** `summary.header.title` / `til.header.title`, `summary.header.content` / `til.header.content`
**Fix:** `t(isSummaryPage ? 'summary.header.title' : 'til.header.title')` etc.
**Complexity:** TRIVIAL

### File 11: `LoginHelpLink/LoginHelpLink.tsx` (1 violation)

**Pattern:** C (ternary)
**Fix:** `isEnterPasswordRoute ? t('password:[REDACTED:password]') : t('login:helpArticleLinkText')`
**Complexity:** TRIVIAL

### File 12: `LoginIdentity/LoginIdentity.tsx` (3 violations)

**Pattern:** B (error code enum)
**Lines:**
1. `t(\`login:error:${LoginIdentityErrors[code] ?? 'unknown'}\`)` — maps to `'emailNotValid'` or `'registrationNotPermitted'`, fallback `'unknown'`
2. Same pattern in `doEmailLookup`
3. `t(\`login:error:${checkoutError.error}\`)` — `checkoutError.error` is `TerminalErrorCode.UnsupportedMerchantTradingCountry`

**Possible keys:** `login:error:emailNotValid`, `login:error:registrationNotPermitted`, `login:error:unknown`, `login:error:unsupportedMerchantTradingCountry`
**Fix:** Replace with explicit switch/if producing static strings.
**Complexity:** LOW

### File 13: `LoginPassword/LoginPassword.tsx` (2 violations)

**Pattern:** B + compound key construction
**Lines:**
1. `setErrorMessage(\`password:error.${errorKeys[errorCode] ?? 'unknown'}${setContext(errorCode)}\`)` — constructs key from `errorKeys` map + optional `_applepaylater` suffix
2. `t(\`${errorMessage}.heading\`)` / `t(\`${errorMessage}.description\`)`

**Error keys (7 entries + fallback):**

| ErrorCode | Key segment | Context suffix |
|---|---|---|
| AuthenticationFailure | `auth` | `''` |
| AuthenticationFailureMaxAttempts | `authMaxAttempt` | `''` or `'_applepaylater'` |
| AccountDisabled | `accountDisabled` | `''` |
| AccountClosed | `locked` | `''` |
| AccountSuspended | `locked` | `''` |
| PaywatchCheckFailed | `paywatchCheckFailed` | `''` |
| AccountLocked | `accountLocked` | `''` |
| *(fallback)* | `unknown` | `''` |

**Full set of errorMessage values (8):** `password:error.auth`, `password:error.authMaxAttempt`, `password:error.authMaxAttempt_applepaylater`, `password:error.accountDisabled`, `password:error.locked`, `password:error.paywatchCheckFailed`, `password:error.accountLocked`, `password:error.unknown`

Then `.heading` and `.description` are appended → **16 total static keys**.

**Fix:** Use a switch statement or lookup map that returns full static key strings.
**Complexity:** MODERATE — 16 key combinations

### File 14: `NewPaymentMethod/NewCardPayment.tsx` (2 violations)

**Pattern:** A (finite enum)
**Lines:** `t(\`paymentMethod:cardType.${feature}\`)` — `feature` is `Feature.PBI | Feature.PCL | Feature.AFF`
**Possible keys:** `paymentMethod:cardType.PBI`, `paymentMethod:cardType.PCL`, `paymentMethod:cardType.AFF`
**Fix:** Switch on `feature` enum.
**Complexity:** TRIVIAL

### File 15: `NewPaymentMethod/NewPaymentMethod.tsx` (3 violations)

**Pattern:** B (error code enum)
**Lines:**
1. `t(\`paymentMethod:errors.${errorReason}\`)` — from `paymentMethodThreeDSErrorReason` map or `PAYMENT_METHOD_ERROR_REASONS.Unknown`
2. `t(\`paymentMethod:errors.${errorReason}\`)` — from `paymentMethodTopazErrorReason` map
3. `t([\`paymentMethod:errors.${recoverableTerminalCurrentError.error}\`, 'paymentMethod:errors.unknown'])` — fallback array

**Fix:** Replace with switch/map returning static key strings.
**Complexity:** LOW-MODERATE (~15 key combinations)

### File 16: `NewPaymentMethod/utils.tsx` (2 violations)

**Pattern:** A (finite enum) and API-derived map
**Lines:**
1. `t(\`paymentMethod:errors:${errorKey}\`)` — `errorKey` from `binsToErrorsMap` (a `Record<string, CardErrorReason>`)
2. `t(\`paymentMethod:cardType:${feature}\`)` — same enum pattern as File 14

**Fix for feature:** Same as File 14. For `errorKey`: enumerate `CardErrorReason` values.
**Complexity:** LOW

### File 17: `NewPaymentMethod/validations.ts` (1 violation)

**Pattern:** Function parameter as key
**Line:** `t(\`paymentMethod:errors.default.${name}\`)` — `name` parameter
**Callers:** Called with `'cardHolderName'`, `'cardNumber'`, `'cardCvv'`, `'cardExpiry'`
**Possible keys:** `paymentMethod:errors.default.cardHolderName`, `paymentMethod:errors.default.cardNumber`, `paymentMethod:errors.default.cardCvv`, `paymentMethod:errors.default.cardExpiry`
**Fix:** Change callers to pass the result of `t()` with the static key directly.
**Complexity:** LOW

### File 18: `PaymentDay/PaymentDay.tsx` (1 violation)

**Pattern:** F (function return value)
**Line:** `t(getLocaleKeyFromDayNumber(selectedPreferredDay))`
**Possible keys:** `preferredDay.weekday.0` through `preferredDay.weekday.6`
**Fix:** Refactor `getLocaleKeyFromDayNumber` to accept `t` and return the translated string.
**Note:** This pattern recurs in `InlinePaymentDayList`, `PaymentDayList`, and `PreferredPaymentDayInline`.
**Complexity:** LOW but repetitive

### File 19: `PaymentDayList/InlinePaymentDayList.tsx` (1 violation)

**Same pattern as File 18** — `t(getLocaleKeyFromDayNumber(day))` inside `.map()`

### File 20: `PaymentDayList/PaymentDayList.tsx` (1 violation)

**Same pattern as File 18**

### File 21: `PaymentMethod/PaymentMethod.tsx` (1 violation)

**Pattern:** C (ternary)
**Line:** `t(cashTooltipExperiment.control ? 'paymentMethod:cashPayTooltip' : 'paymentMethod:cashPayTooltipExperiment')`
**Fix:** `cashTooltipExperiment.control ? t('paymentMethod:cashPayTooltip') : t('paymentMethod:cashPayTooltipExperiment')`
**Complexity:** TRIVIAL

### File 22: `PaymentMethodCard/PaymentMethodCard.tsx` (1 violation)

**Pattern:** B (error key variable)
**Line:** `t(\`paymentMethod:errors.${errorKey}\`, { selectedCardBrand, months })`
**Possible values of `errorKey`:** `CardErrorReason` type — `'expired'`, `'expireSoon'`, `'cardExpiryLimitInMonths'`, `'invalidBrand'`, `'creditCardNotAllowed'`, `'cashAppCardIneligible'`, etc.
**Fix:** Switch/map on `errorKey`.
**Complexity:** LOW-MODERATE (~10 key combinations)

### File 23: `PaymentMethodIcon/PaymentMethodIcon.tsx` (1 violation)

**Pattern:** A (finite enum transformation)
**Line:** `t(\`paymentMethod:${typeKey}\`)` where `typeKey = type.toLowerCase().replace(/_/g, '')`
**Possible keys:** `paymentMethod:mastercard`, `paymentMethod:visa`, `paymentMethod:amex`, `paymentMethod:dinersclub`, `paymentMethod:discover`, `paymentMethod:applepay`, `paymentMethod:achbankaccount`, `paymentMethod:cashapppay`
**Fix:** Switch on `type`.
**Complexity:** LOW

### File 24: `PaymentMethodList/PaymentMethodErrorMessage.tsx` (1 violation)

**Pattern:** B (error reason string)
**Line:** `t(\`paymentMethod:errors.${card.error}\`, { selectedCardBrand, months })`
**Same approach as File 22**
**Complexity:** LOW-MODERATE

### File 25: `PaymentOptionsErrorModal/PaymentOptionsErrorModal.tsx` (2 violations)

**Pattern:** B — `paymentOptionsError.error` is a `TerminalErrorCode`
**Lines:**
1. `t(\`consumerLending:paymentOptionsErrorModal.${paymentOptionsError?.error}.title\`)`
2. `t(\`consumerLending:paymentOptionsErrorModal.${paymentOptionsError?.error}.description\`, { interval })`

**Relevant values:** Only specific PCL-related codes trigger this modal: `ErrorPCL`, `RiskDeclinedPCL`, `AmountTooHighDeclinePCL`, `MaxActiveOrdersReachedDeclinePCL`
**Fix:** Switch on error code.
**Complexity:** LOW

### File 26: `PaymentTypes/PaymentTypesPBIRejected/helper.ts` (2 violations)

**Pattern:** F (function return value from switch)
**Lines:**
1. `t(\`consumerLending:paymentTypesB:${rejectedReasonCodeKey(...)}\`, { interval })` — returns one of 4 known strings
2. `t(\`consumerLending:paymentTypesPBIRejected.alertBanner.${getRedesignedHeadingErrorCode(...)}\`)` — returns one of 5 known strings

**Possible keys for line 1:** `consumerLending:paymentTypesB:tooManyOrdersSubheading`, `...accountLimitSubheading`, `...merchantLimitSubheading`, `...genericSubheading`
**Possible keys for line 2:** `consumerLending:paymentTypesPBIRejected.alertBanner.tooManyOrdersHeading`, `...accountLimitHeading`, `...merchantLimitHeading`, `...genericHeading`
**Fix:** Have helper functions accept `t` as param and use static key switches.
**Complexity:** LOW

### File 27: `PaymentTypes/helper.tsx` (1 violation)

**Pattern:** F — same switch function, different namespace
**Line:** `t(\`consumerLending:paymentTypesPBIDeclined:${rejectedReasonCodeKey(...)}\`, { interval })`
**Possible keys:** `consumerLending:paymentTypesPBIDeclined:maxActiveOrdersReached`, `...amountTooHigh`, `...merchantOrderAmountLimitExceeded`, `...genericDecline`
**Fix:** Same as File 26.
**Complexity:** LOW

### File 28: `PostCheckout/PostCheckout.tsx` (7 violations) ⚠️

**Pattern:** D (useGetLocaleWithFallback) — ALL 7 violations
**Lines:** All use `t(localeWithFallback('someKey'), '', { ...options })`
**Keys used:** `titlePrimary`, `titleSecondary`, `heroTitle`, `titleSuccess`, `finePrint`, `link`, `loaderTitle`

**AssetId enum (6 values, verified):**
- `'ap-asset-999999'` (Dummy)
- `'ap-asset-202303'` (Survey202303)
- `'ap-gift-card-202306'` (GiftCard202306)
- `'google-sso-202308'` (GoogleSSO)
- `'ap-marketing-opt-in-202308'` (MarketingOptIn202308)
- `'unicorn-order-servicing-message-20250327'` (CashAppOrderServicingMessage202503)

**`variant`** from `usePostCheckoutExperiment().value` — experiment variant like `'A'`, `'B'`, `'C'`, etc.
**`flow`** from `usePostCheckoutFlow()` — `PostCheckoutFlow.PreCapture` or `PostCheckoutFlow.PostCapture`

Each `localeWithFallback(key)` call produces 3 fallback keys:
```
${localeFile}:asset:${assetId}.${key}__${variant}-${flow}
${localeFile}:asset:${assetId}.${key}__${variant}
${localeFile}:asset:${assetId}.${key}
```

**Combinatorial space:** 6 assetIds × (unknown # of variants) × 2 flows × 7 keys × 3 fallback levels = hundreds to thousands of potential keys.

**Key architectural decision needed:** Since `variant` is an experiment value that can change over time, a static enumeration approach is fragile. Options:
1. Move the `t()` call inside `useGetLocaleWithFallback` and maintain a manifest of all used asset keys
2. Accept this pattern as inherently dynamic and exclude from static extraction
3. Restructure post-checkout i18n to use a single base key with variant/flow as interpolation variables

**Complexity:** HIGH

### File 29: `PreferredCardTopazError/PreferredCardTopazError.tsx` (1 violation)

**Pattern:** B — `reason` is a card error reason
**Line:** `t(\`summary:error:${reason}:message\`, { context: 'cannotSwitch' })`
**Possible values:** `'expired'`, `'expireSoon'`, `'invalidBrand'`, `'cardExpiryLimitInMonths'`, `'creditCardNotAllowed'`, `'cashAppCardIneligible'`
**Fix:** Switch on `reason`.
**Complexity:** LOW

### File 30: `PreferredPaymentDayInline/PreferredPaymentDayInline.tsx` (2 violations)

**Pattern:** F — same as File 18
**Lines:** `t(getLocaleKeyFromDayNumber(day))` and `t(getLocaleKeyFromDayNumber(selectedDay))`
**Complexity:** LOW

### File 31: `ProcessOrder/ProcessOrder.tsx` (1-2 violations)

**Pattern:** D + F — combines `useGetLocaleWithFallback` with `defaultLocale()` function
**Line:** `t(translation, { ...options })` where `translation` comes from `isPreCaptureFlow ? localeWithFallback(type) : defaultLocale(type)`

`defaultLocale` returns:
- `processing:applePaylater.heading`, `processing:applePaylater.description`, `processing:applePaylater.instruction`
- `processing:billingAgreementApproval.heading`, `processing:billingAgreementApproval.description`, `processing:billingAgreementApproval.instruction`
- `processing:supOrder.heading`, `processing:supOrder.description`, `processing:supOrder.instruction`
- `processing:heading`, `processing:description`, `processing:instruction`

**Total static keys from defaultLocale:** 12
**For `localeWithFallback` part:** same approach as File 28.
**Complexity:** MODERATE

### File 32: `RecoverableTerminalError/RecoverableTerminalError.tsx` (3 violations)

**Pattern:** B — `errorKey` from `CheckoutError.error`
**Lines:**
1. `t(\`recoverableTerminalError:${errorKey}.description\`)`
2. `t([\`recoverableTerminalError:${errorKey}.heading\`, 'recoverableTerminalError:default.heading'])`
3. `t(\`recoverableTerminalError:${errorKey}.description\`)` (in renderDescription)

**Possible errorKey values (5, verified):** `amountTooHigh`, `maxActiveOrdersReached`, `overduePaymentEligible`, `queryError`, `default`

**Possible static keys (10):**
- `recoverableTerminalError:amountTooHigh.heading`, `.description`
- `recoverableTerminalError:maxActiveOrdersReached.heading`, `.description`
- `recoverableTerminalError:overduePaymentEligible.heading`, `.description`
- `recoverableTerminalError:queryError.heading`, `.description`
- `recoverableTerminalError:default.heading`, `.description`

**Complexity:** LOW (only 5 enum values)

### File 33: `ShippingAddress/TooltipMessage/TooltipMessage.tsx` (1 violation)

**Pattern:** C (ternary)
**Fix:** `isPickup ? t('summary:pickUpTooltipHeading') : t('summary:shippingToAddressTooltipHeading')`
**Complexity:** TRIVIAL

### File 34: `ShippingAddressInline/ShippingAddressInline.tsx` (2 violations)

**Pattern:** Variable from hook return
**Lines:** `t(heading)` and `t(description)` — from `useShippingAddressInlineLabels()` hook

**Verified: `useShippingAddressInlineLabels()` returns exactly 3 combinations:**

| Condition | heading | description |
|---|---|---|
| Address invalid | `shippingAddress:noValidShippingAddress_inline.heading` | `shippingAddress:noValidShippingAddress_inline.description` |
| Valid + pickup | `common:pickupFrom_inline` | *(none)* |
| Valid + not pickup | `common:shipTo` | *(none)* |

**Possible static keys (4):** `shippingAddress:noValidShippingAddress_inline.heading`, `shippingAddress:noValidShippingAddress_inline.description`, `common:pickupFrom_inline`, `common:shipTo`

**Fix:** Move `t()` calls inside the hook or destructure at call site with conditional `t()`.
**Complexity:** LOW

### File 35: `ShippingAddressItem/ShippingAddressItem.tsx` (1 violation)

**Verified:** The `i18n-only-static-keys` violation is from **dead code** in the unreachable second `if (isArcadeDesignLanguage)` block (duplicate check after early return for same condition):
```typescript
const heading = isIntegratedShipping ? '...' : '...'
t(heading)  // ← heading is a variable, not a literal
```

**Possible keys (4):** `shippingAddress:noChosenShippingAddressMessage_integrated.heading`, `shippingAddress:noChosenShippingAddressMessage.heading`, `shippingAddress:noChosenShippingAddressMessage_integrated.description`, `shippingAddress:noChosenShippingAddressMessage.description`

**Fix:** Clean up dead code + replace `t(heading)` with inline ternary `t()`.
**Complexity:** TRIVIAL (includes dead code cleanup)

### File 36: `ShippingOption/hooks.tsx` (1 violation)

**Verified:** Violation in `useSummaryHeaderLabel`:
```typescript
const shippingOptionHeading = isPickup ? 'common:pickupDetails' : 'common:shippingOptions'
return t(shippingOptionHeading, { merchantName, count: ... })
```

**Possible keys (2):** `common:pickupDetails`, `common:shippingOptions`
**Fix:** `return isPickup ? t('common:pickupDetails', opts) : t('common:shippingOptions', opts)`
**Complexity:** TRIVIAL

### File 37: `ShippingOptionError/ShippingOptionError.tsx` (4 violations)

**Verified:** All 4 violations are in helper functions that accept `headerKey: string` and `errorKey: string` parameters:
1. `t(headerKey)` in `basicShippingOptionError`
2. `t(errorKey, ...)` in `basicShippingOptionError`
3. `t(headerKey)` in `errorWithRetry`
4. `t(errorKey)` in `errorWithRetry`

**ALL call sites pass static string literals:**
- `basicShippingOptionError('shippingOption:error.totalTooHigh.heading', 'shippingOption:error.totalTooHigh.message')`
- `basicShippingOptionError('shippingOption:error.pickup.heading', 'shippingOption:error.pickup.message')`
- `basicShippingOptionError('shippingOption:error.pickupTotalTooHigh.heading', 'shippingOption:error.pickupTotalTooHigh.message')`
- `basicShippingOptionError('shippingOption:error.default.heading', 'shippingOption:error.default.message')`
- `errorWithRetry('shippingOption:error.shippingOptionUpdateInvalid.heading', 'shippingOption:error.shippingOptionUpdateInvalid.message')`
- `errorWithRetry('shippingOption:error.unableToUpdate.heading', 'shippingOption:error.unableToUpdate.message')`

**Fix:** Inline `t()` calls at each call site. 6 call sites need inlining.
**Complexity:** LOW

### File 38: `SummaryNotification/SummaryNotification.tsx` (5 violations)

**Pattern:** B + E (error codes + buildTranslationKey)
**Lines:** Multiple uses of `t(\`summary:error.${reason}.heading\`)`, `t(\`summary:bankAccountErrors.${bankAccountReason}.heading\`)`, and `t(messageKey)` where `messageKey` from `buildTranslationKey`.

**Cross-product of error reasons × context options.** The `buildTranslationKey` calls have conditional `_aff` suffixes.
**Fix:** Enumerate all possible outputs and use conditional static key selection.
**Complexity:** MODERATE — multiple interacting conditions

### File 39: `TerminalError/TerminalError.tsx` (6 violations) ⚠️

**Pattern:** B (TerminalErrorCode enum — 47 values)
**Lines:**
1. **Line 202:** `` `terminalError:${errorKey}.description` `` — used in `<Trans i18nKey=...>`
2. **Line 245:** `` t(`terminalError:${errorKey}.option`, { returnObjects: true, ... }) ``
3. **Line 288:** `` t(`terminalError:${alternativeTitleKey}`, { context: altTitleContext }) ``
4. **Line 330:** `` t(`terminalError:${errorKey}.detail`) `` — only for `KYCRefreshPending`
5. **Line 356:** `` t(`terminalError:${errorKey}.subheading`) `` — only for amountTooHigh variants
6. **Line 375:** `` t(`terminalError:${errorKey}.cta`) `` — only for `IdentityVerificationFailedManual`

**Key insight:** While the enum has 47 values, NOT all values × all suffixes are used. Some suffixes (`.detail`, `.subheading`, `.cta`) are only used for specific error codes (guarded by conditionals). The `.heading`, `.description`, and `.option` suffixes are the only ones that apply to all 47 error codes.

**Context outputs are also finite:**
- `getAltTitleContext(...)` → `declinePCL | complianceDeclineBureau | recoverable | KYCRefreshPending | ''`
- `geti18nDescContext(...)` → `generic | payMonthlyOnly | recoverable | ''`

**Full TerminalErrorCode enum (47 values):**
`default`, `authenticationDeclined`, `passwordResetDeclined`, `accountClosed`, `accountDisabled`, `accountFrozen`, `amountTooHigh`, `accountPendingDeletion`, `chargebackPending`, `duplicateIdentity`, `highRiskNationality`, `duplicatePaymentCardError`, `ineligibleState`, `insufficientFunds`, `maxActiveOrdersReached`, `maxActiveOrdersReached_details`, `resetCodeMaxAttempts`, `identityCheckMaxAttempts`, `maxDobVerificationAttempts`, `identityDeclined`, `invalidPreorder`, `unsupportedOrder`, `merchantOrderAmountLimitExceeded`, `minimumNotMet`, `orderAmountTooHigh`, `overdue`, `overduePaymentEligible`, `riskDeclined`, `excessiveLateFeeAmount`, `excessiveLateFeeNumber`, `unsupportedMerchantTradingCountry`, `invalidPickupAddress`, `unableToUpdateCheckout`, `invalidAmount`, `stateRestrictionsPCL`, `giftCardIneligible`, `merchantLimitZero`, `identityVerificationFailedManual`, `identityVerificationTimeout`, `orderAmountExceedsSpendCap`, `errorPCL`, `riskDeclinedPCL`, `amountTooHighDeclinePCL`, `maxActiveOrdersReachedDeclinePCL`, `creditFreezeDeclinedPCL`, `extendedFraudAlert`, `identityVerificationDeclinedPCL`, `paywatchCheckFailed`, `blockSignUpFromFRITES`, `BiometricCheckMaxRetriesReached`, `identityVerificationMaxAttemptsAFF`, `exceededMaxAttemptsEnteringDetails`, `complianceDeclineBureauNoHit`, `complianceDeclineBureau`, `creditCheckFailure`, `limitInternalError`, `PasswordResetNotAllowed`, `KYCRefreshPending`, `shadowAccountIneligible`, `unsuitabilityDecline`

**Recommended approach:** Create a `Record<TerminalErrorCode, { heading: string; description: string; option: string }>` type-safe mapping at module level. For conditionally-used suffixes (`.detail`, `.subheading`, `.cta`), handle inline since they only apply to 1-2 error codes each.

**Complexity:** HIGH — largest single file

### File 40: `TotalAmountPayable/TotalAmountPayable.tsx` (1 violation)

**Pattern:** C (ternary assigned to variable)
**Line:** `t(i18nKey)` where `const i18nKey = isEstimatedTotal ? '...' : '...'`
**Fix:** `isEstimatedTotal ? t('orders:orderSummary.estimatedTotal') : t('orders:orderSummary.totalAmountPayable')`
**Complexity:** TRIVIAL

### File 41: `Verify/Verify.tsx` (2 violations)

**Pattern:** F (function return) + A (enum variable)
**Lines:**
1. `t(getErrorMessage(e), { context })` — returns `'verify:error:incorrectResetCode'`, `'verify:error:expiredCode'`, or `'verify:error:default'`
2. `t(\`verify:${method?.toLowerCase()}.sendOption\`, { mobile, email })` — `method` is `'SMS'` or `'EMAIL'`

**Fix:** Switch/conditional for each.
**Complexity:** LOW

### File 42: `VerifyIdentity/VerifyIdentity.tsx` (1 violation)

**Pattern:** A (finite enum)
**Line:** `t(\`verifyIdentity:document.${doc}\`)` — `doc` is `IdentityDocument` enum: `'licence'`, `'medicare'`, `'passport'`
**Fix:** Switch on doc enum.
**Complexity:** TRIVIAL

### File 43: `VerifyIdentity/utils.ts` (2 violations)

**Pattern:** A (finite enum)
**Lines:**
1. `t(\`verifyIdentity:document:${documentType}\`)`
2. `t(\`verifyIdentity:partialVerified:description:${documentType}\`)`
**Fix:** Switch on documentType.
**Complexity:** TRIVIAL

### File 44: `VerifyStart/VerifyStart.tsx` (1 violation)

**Line:** `t('verifyIdentity:start:documents', { returnObjects: true })` — returns an array of objects
**Complexity:** LOW

### File 45: `flow/apple-paylater/components/AddCard/AddCard.tsx` (1 violation)

**Pattern:** A — card type from API
**Line:** `t(\`alt.${addedCardType}\`)`
**Fix:** If card types are a known enum (visa, mastercard, amex, etc.), enumerate.
**Complexity:** LOW

### Files 46-50: Page Files (Duplicate Patterns)

| File | Count | Pattern | Notes |
|---|---|---|---|
| `page/add-payment-method/AddPaymentMethod.tsx` | 2 | Ternary (C) | Static keys selected by condition |
| `page/apple-paylater/contract-agreement/ApplePaylaterContractAgreement.tsx` | 2 | Variable from known set | `verifyIdentity:title/description`, `unsuitabilityQuestions:title/description` |
| `page/apple-paylater/initial-loading/ApplePaylaterInitialLoading.tsx` | 1 | Same as LoginIdentity | `LoginIdentityErrors` map pattern |
| `page/apple-paylater/logged-in/helper.ts` | 2 | Template literal with known values | `common:verifyIdentity:title`, etc. |
| `page/apple-paylater/summary/consumer-lending-summary/ApplePaylaterConsumerLendingSummary.tsx` | 6 | Error notification (B) | Same as PayMonthlySummary |
| `page/apple-paylater/summary/redesigned-summary/ApplePaylaterRedesignedSummary.tsx` | 1 | Ternary (C) | Tooltip key selection |
| `page/card-scan/CardScan.tsx` | 4 | Enum (A) | 7 CardScanError values × title/subtitle |
| `page/contract-agreement/ContractAgreement.tsx` | 2 | Same as ApplePaylaterContractAgreement | Same keys |
| `page/initial-loading/InitialLoading.tsx` | 1 | Same as LoginIdentity | Same pattern |
| `page/logged-in/helper.ts` | 2 | Same as apple-paylater helper | Same keys |
| `page/new-payment-method/NewPaymentMethodPage.tsx` | 1 | Ternary (C) | 2 static keys |
| `page/oh-no-error/OhNoError.tsx` | 1 | Fallback array (B) | RecoverableTerminalError keys + typo `.head` vs `.heading` |
| `page/preferred-payment-day/PreferredPaymentDay.tsx` | 1 | Function return (F) | 7 weekday keys |
| `page/profile-created/ProfileCreated.tsx` | 3 | Constant prefix (A) | Literal substitution — `t('profileCreated:disclaimers:item0')` etc. |
| `page/summary-arcade/ArcadeSummary.tsx` | 1 | Ternary (C) | Tooltip key selection |
| `page/summary-bronte/BronteSummary.tsx` | 1 | Ternary (C) | Tooltip key selection |
| `page/summary-pay-monthly/PayMonthlySummary.tsx` | 6 | Error notification (B) | TerminalErrorCode (47) + CardErrorReason (10+) + BankAccountErrorReason (3) |
| `state/checkout/useConfirmCheckoutFinaliser.ts` | 1 | Variable assignment (C) | Inline: `t('summary:complianceDeclineSystemError')` |

### Verified: ApplePaylaterConsumerLendingSummary (6 violations)

Same error notification patterns as PayMonthlySummary. There are 3 dynamic `t()` patterns to fix:

#### Pattern 1: `error?.error` (RecoverableErrorCode) — lines ~206-211

```typescript
// Guard: Object.values(RecoverableErrorCode).includes(error?.error as RecoverableErrorCode)
const heading = t(`summary:error.${error?.error}.heading`)
const message = t(`summary:error.${error?.error}.message`)
```

**Note:** The existing MEGA doc incorrectly said this was `TerminalErrorCode`. It is actually guarded by `RecoverableErrorCode` — the code checks `Object.values(RecoverableErrorCode).includes(...)` before reaching these lines.

**RecoverableErrorCode enum (7 values):**
| Enum Key | String Value | Translation Exists? |
|---|---|---|
| `UnsupportedCardIssuerBank` | `'unsupportedCardIssuerBank'` | ✅ |
| `UnsupportedCardIssuer` | `'foreignCard'` | ✅ |
| `UnsupportedCardType` | `'prepaidCard'` | ✅ |
| `AddPaymentActiveCardLimitExceeded` | `'activeCardLimitExceeded'` | ❌ no translation key |
| `AddPaymentInactiveCardLimitExceeded` | `'inactiveCardLimitExceeded'` | ❌ no translation key |
| `CreditCardProhibitedForPaymentType` | `'creditCardProhibitedForPaymentType'` | ✅ |
| `CashAppCardIneligible` | `'cashAppCardIneligible'` | ✅ |

**Fix:** Create a static map keyed by `RecoverableErrorCode`:
```typescript
const recoverableErrorNotifications: Record<RecoverableErrorCode, { heading: string; message: string }> = {
  [RecoverableErrorCode.UnsupportedCardIssuerBank]: {
    heading: t('summary:error.unsupportedCardIssuerBank.heading'),
    message: t('summary:error.unsupportedCardIssuerBank.message'),
  },
  [RecoverableErrorCode.UnsupportedCardIssuer]: {
    heading: t('summary:error.foreignCard.heading'),
    message: t('summary:error.foreignCard.message'),
  },
  [RecoverableErrorCode.UnsupportedCardType]: {
    heading: t('summary:error.prepaidCard.heading'),
    message: t('summary:error.prepaidCard.message'),
  },
  [RecoverableErrorCode.AddPaymentActiveCardLimitExceeded]: {
    heading: t('summary:error.activeCardLimitExceeded.heading'),
    message: t('summary:error.activeCardLimitExceeded.message'),
  },
  [RecoverableErrorCode.AddPaymentInactiveCardLimitExceeded]: {
    heading: t('summary:error.inactiveCardLimitExceeded.heading'),
    message: t('summary:error.inactiveCardLimitExceeded.message'),
  },
  [RecoverableErrorCode.CreditCardProhibitedForPaymentType]: {
    heading: t('summary:error.creditCardProhibitedForPaymentType.heading'),
    message: t('summary:error.creditCardProhibitedForPaymentType.message'),
  },
  [RecoverableErrorCode.CashAppCardIneligible]: {
    heading: t('summary:error.cashAppCardIneligible.heading'),
    message: t('summary:error.cashAppCardIneligible.message'),
  },
}
// Then: const { heading, message } = recoverableErrorNotifications[error.error as RecoverableErrorCode]
```

#### Pattern 2: `bankAccountReason` (BankAccountErrorReason) — lines ~258-261

```typescript
const heading = t(`summary:bankAccountErrors.${bankAccountReason}.heading`)
const message = t(`summary:bankAccountErrors.${bankAccountReason}.message`)
```

**BankAccountErrorReason type (3 values):**
| Value | Translation Exists? |
|---|---|
| `'unLinked'` | ❌ no translation key (missing from `summary.json`) |
| `'noValidCard'` | ✅ |
| `'checkingNotAllowed'` | ✅ |

Note: `'fraudCheckNotAllowed'` also exists in translations but is NOT in the `BankAccountErrorReason` type.

**Fix:** Create a static map keyed by `BankAccountErrorReason`:
```typescript
const bankAccountErrorNotifications: Record<BankAccountErrorReason, { heading: string; message: string }> = {
  unLinked: {
    heading: t('summary:bankAccountErrors.unLinked.heading'),
    message: t('summary:bankAccountErrors.unLinked.message'),
  },
  noValidCard: {
    heading: t('summary:bankAccountErrors.noValidCard.heading'),
    message: t('summary:bankAccountErrors.noValidCard.message'),
  },
  checkingNotAllowed: {
    heading: t('summary:bankAccountErrors.checkingNotAllowed.heading'),
    message: t('summary:bankAccountErrors.checkingNotAllowed.message'),
  },
}
// Then: const { heading, message } = bankAccountErrorNotifications[bankAccountReason]
```

#### Pattern 3: `reason` (CardErrorReason) with context — lines ~308-311

```typescript
const options = { context: switched ? 'switched' : 'cannotSwitch' }
const heading = t(`summary:error.${reason}.heading`, options)
const message = t(`summary:error.${reason}.message`, options)
```

This uses i18next context suffixes (`_switched` / `_cannotSwitch`). The `cardExpiryLimitInMonths` case is already handled separately with static keys above this code, so the remaining `CardErrorReason` values are:

**CardErrorReason values reaching this code path:**
| Value | Translation `.heading_switched`? | `.heading_cannotSwitch`? | `.message_switched`? | `.message_cannotSwitch`? |
|---|---|---|---|---|
| `'invalidBrand'` | ✅ | ✅ | ✅ | ✅ |
| `'cardExpiry'` | ✅ | ✅ | ✅ | ✅ |
| `'achNotAllowed'` | ❌ | ❌ | ❌ | ❌ |
| `'creditCardNotAllowed'` | ✅ | ✅ | ✅ | ✅ |
| `'cashAppCardIneligible'` | ✅ | ✅ | ✅ | ✅ |
| `'dssProhibitedPaymentMethod'` | ❌ | ❌ | ❌ | ❌ |
| `'fallbackGenericMessage'` | ✅ | ✅ | ✅ | ✅ |
| `'unacceptableIssuerRestrictedCard'` | ✅ | ✅ | ✅ | ✅ |
| `'unacceptableCard'` | ✅ | ✅ | ✅ | ✅ |

**Fix:** Two approaches work here:

**Option A (Preferred — declarative map with `t()` calls and context variants inline):**
```typescript
type CardErrorNotification = {
  heading_switched: string; heading_cannotSwitch: string;
  message_switched: string; message_cannotSwitch: string;
}
const cardErrorNotifications: Record<string, CardErrorNotification> = {
  invalidBrand: {
    heading_switched: t('summary:error.invalidBrand.heading_switched'),
    heading_cannotSwitch: t('summary:error.invalidBrand.heading_cannotSwitch'),
    message_switched: t('summary:error.invalidBrand.message_switched'),
    message_cannotSwitch: t('summary:error.invalidBrand.message_cannotSwitch'),
  },
  // ... repeat for each value
}
const suffix = switched ? '_switched' : '_cannotSwitch'
const entry = cardErrorNotifications[reason]
const heading = entry[`heading${suffix}`]
const message = entry[`message${suffix}`]
```

**Option B (Simpler — keep context param but enumerate keys):**
Since `reason` is a finite set, a `switch` or `if/else` over each value calling `t()` with static keys is also valid. This avoids the dynamic template literal while preserving the `context` option.

**Summary:**
- All 3 patterns are finite enumerations with known values
- Missing translation keys (`activeCardLimitExceeded`, `inactiveCardLimitExceeded`, `achNotAllowed`, `dssProhibitedPaymentMethod`, `unLinked`) will return the key string as-is via i18next — same behavior whether dynamic or static
- The fix is to build lookup maps and index into them
- Tests should assert the notification heading/message for each enum value

### Verified: CardScan (4 violations)

**CardScanError enum (7 values):** `unsupported`, `didnt_match`, `cannot_scan`, `too_many_tries`, `no_permission`, `user_canceled`, `terminal_error`
**Possible title keys (7):** `cardScan:error.title.<each value>`
**Possible subtitle keys (10):** 7 base subtitles + 3 browser-specific variants for `no_permission` (`chrome`/`safari`/`default`)
**Complexity:** LOW

### Verified: OhNoError (1 violation)

```typescript
const pageTitle = t([`recoverableTerminalError:${checkoutError?.error ?? ''}.head`, 'recoverableTerminalError:default.heading'])
```
Note the **typo**: `.head` instead of `.heading`. Same `TerminalErrorCode` enum but in practice only reached for recoverable errors (~5 values).
**Complexity:** LOW

### Verified: ProfileCreated (3 violations)

`disclaimersKey` is a **constant** with NO conditional logic:
```typescript
t(`${disclaimersKey}:item0`)  // → 'profileCreated:disclaimers:item0'
t(`${disclaimersKey}:item1`)  // → 'profileCreated:disclaimers:item1'
t(`${disclaimersKey}:item2`)  // → 'profileCreated:disclaimers:item2'
```
**Fix:** Literal substitution. **Complexity:** TRIVIAL

---

## Complexity Summary & Ranked File List

### Summary Table

| Complexity | Files | Violations | Description |
|---|---|---|---|
| **TRIVIAL** | ~22 | ~25 | Ternary → split `t()` call. Zero risk. |
| **LOW** | ~22 | ~30 | Small enums with known values, straightforward switch. |
| **MODERATE** | ~8 | ~20 | Medium enums + conditional combinations, bounded. |
| **HIGH** | ~5 | ~26 | Large enums, combinatorial patterns, or architectural decisions. |

### 🟢 TRIVIAL (~22 files, ~25 violations) — Mechanical ternary splits, zero risk

| File | Violations | Fix |
|---|---|---|
| `AutopayToggle/AutopayButtonToggleText.tsx` | 1 | Split ternary into `cond ? t('a') : t('b')` |
| `ConsumerLendingTagline/ConsumerLendingTagline.tsx` | 1 | Split ternary |
| `LoginHelpLink/LoginHelpLink.tsx` | 1 | Split ternary |
| `PaymentMethod/PaymentMethod.tsx` | 1 | Split ternary |
| `FinanceFee/SupHeader.tsx` | 2 | Replace `namespace` variable with inline ternaries |
| `FinanceFee/EstimatedOrderBreakdown.tsx` | 1 | Replace `buildTranslationKey` with single ternary (2 possible keys) |
| `page/profile-created/ProfileCreated.tsx` | 3 | Replace `${disclaimersKey}:itemN` with literal strings |
| `page/summary-arcade/ArcadeSummary.tsx` | 1 | Split ternary |
| `page/summary-bronte/BronteSummary.tsx` | 1 | Split ternary |
| `page/apple-paylater/summary/redesigned-summary/ApplePaylaterRedesignedSummary.tsx` | 1 | Split ternary |
| `page/new-payment-method/NewPaymentMethodPage.tsx` | 1 | Split ternary |
| `state/checkout/useConfirmCheckoutFinaliser.ts` | 1 | Split ternary |
| `page/add-payment-method/AddPaymentMethod.tsx` | 2 | Split ternary |
| `ShippingAddress/TooltipMessage/TooltipMessage.tsx` | 1 | Split ternary |
| `ShippingOptionError helpers` | 1 | Split ternary |
| `ShippingOption/hooks.tsx` | 1 | Split ternary |
| `ShippingAddressItem/ShippingAddressItem.tsx` | 1 | Split ternary (+ dead code cleanup) |
| `TotalAmountPayable/TotalAmountPayable.tsx` | 1 | Split ternary |
| `VerifyIdentity/VerifyIdentity.tsx` | 1 | Split ternary |
| `VerifyIdentity/utils.ts` | 2 | Split ternary |
| `NewCardPayment.tsx` | 2 | 3-value enum, trivial switch |

### 🟡 LOW (~22 files, ~30 violations) — Small enums, straightforward switch/map

| File | Violations | Key Count | Notes |
|---|---|---|---|
| **Weekday pattern (fix once, applies to 4+ files)** | | | |
| `PaymentDay/PaymentDay.tsx` | 1 | 7 | `getLocaleKeyFromDayNumber` — refactor to accept `t` |
| `PaymentDayList/InlinePaymentDayList.tsx` | 1 | 7 | Same pattern |
| `PaymentDayList/PaymentDayList.tsx` | 1 | 7 | Same pattern |
| `page/preferred-payment-day/PreferredPaymentDay.tsx` | 1 | 7 | Same pattern |
| **Small enum lookups** | | | |
| `NewPaymentMethod/utils.tsx` | 2 | 3+ | Feature enum + CardErrorReason |
| `NewPaymentMethod/validations.ts` | 1 | 4 | `cardHolderName`, `cardNumber`, `cardCvv`, `cardExpiry` |
| `PaymentMethodIcon/PaymentMethodIcon.tsx` | 1 | ~8 | CardBrand + PaymentMethodType |
| `CreatePassword/CreatePassword.tsx` | 1 | 4 | `weakPassword`, `identicalPassword`, `emptyPassword`, `unknown` |
| `LoginIdentity/LoginIdentity.tsx` | 3 | 4 | `emailNotValid`, `registrationNotPermitted`, `unknown`, `unsupportedMerchantTradingCountry` |
| `CardEducation/CardEducation.tsx` | 2 | 6 | 3 features × title/description |
| `page/card-scan/CardScan.tsx` | 4 | 17 | 7 CardScanError × title + 7 subtitle + 3 browser variants |
| `RecoverableTerminalError/RecoverableTerminalError.tsx` | 3 | 10 | 5 error keys × heading/description |
| `page/oh-no-error/OhNoError.tsx` | 1 | ~5 | Same RecoverableTerminalError keys |
| `PaymentOptionsErrorModal/PaymentOptionsErrorModal.tsx` | 2 | ~8 | 4 PCL error codes × title/description |
| `PaymentTypes/PaymentTypesPBIRejected/helper.ts` | 2 | ~9 | 4+5 known return values |
| `PaymentTypes/helper.tsx` | 1 | 4 | Same switch function |
| `Verify/Verify.tsx` | 2 | 5 | 3 error + 2 method keys |
| `VerifyStart/VerifyStart.tsx` | 1 | small | returnObjects pattern |
| `flow/apple-paylater/components/AddCard/AddCard.tsx` | 1 | ~3 | Card type alt text |
| **Known-set variable (2 values)** | | | |
| `page/contract-agreement/ContractAgreement.tsx` | 2 | 4 | `verifyIdentity` / `unsuitabilityQuestions` × title/description |
| `page/apple-paylater/contract-agreement/ApplePaylaterContractAgreement.tsx` | 2 | 4 | Same |
| `page/logged-in/helper.ts` | 2 | 4 | Same |
| `page/apple-paylater/logged-in/helper.ts` | 2 | 4 | Same |
| `page/initial-loading/InitialLoading.tsx` | 1 | 4 | LoginIdentityErrors map |
| `page/apple-paylater/initial-loading/ApplePaylaterInitialLoading.tsx` | 1 | 4 | Same |
| `ShippingAddressInline/ShippingAddressInline.tsx` | 2 | 4 | Hook return values |
| `ShippingOptionError/ShippingOptionError.tsx` | 4 | 12 | 6 call sites, all pass static strings |
| `PreferredCardTopazError/PreferredCardTopazError.tsx` | 1 | 6 | Card error reasons |

### 🟠 MODERATE (~8 files, ~20 violations) — Medium enums + conditional combinations

| File | Violations | Key Combos | Notes |
|---|---|---|---|
| `AutopayToggle/AutopayModal.tsx` | 4 | ~12 | `buildTranslationKey` with 3 possible base keys × heading/description/close/cta |
| `LoginPassword/LoginPassword.tsx` | 2 | 16 | 8 error keys × heading/description |
| `NewPaymentMethod/NewPaymentMethod.tsx` | 3 | ~15 | Multiple error reason maps (3DS, Topaz, recoverable) |
| `PaymentMethodCard/PaymentMethodCard.tsx` | 1 | ~10 | `CardErrorReason` values |
| `PaymentMethodList/PaymentMethodErrorMessage.tsx` | 1 | ~10 | Same CardErrorReason pattern |
| `SummaryNotification/SummaryNotification.tsx` | 5 | ~20 | CardErrorReason + BankAccountErrorReason + buildTranslationKey |
| `ProcessOrder/ProcessOrder.tsx` | 2 | 12+ | 12 static keys from `defaultLocale` + localeWithFallback dependency |
| `PreferredCardTopazError` | 1 | ~10 | Topaz error codes |

### 🔴 HIGH (~5 files, ~26 violations) — Large enums, combinatorial, or architectural decisions

| File | Violations | Challenge |
|---|---|---|
| `TerminalError/TerminalError.tsx` | 6 | 47 `TerminalErrorCode` enum values × multiple suffixes. Needs `Record<TerminalErrorCode, string>` map. |
| `PostCheckout/PostCheckout.tsx` + `Asset/CallToAction.tsx` + `Asset/Subtitle.tsx` | 10 | `useGetLocaleWithFallback` generates keys from assetId × variant × flow. Variant is experiment value — static enumeration is fragile. May need architectural restructuring. |
| `page/summary-pay-monthly/PayMonthlySummary.tsx` | 6 | Combines TerminalErrorCode (47) + CardErrorReason (10+) + BankAccountErrorReason (3). Consider shared error helper. |
| `page/apple-paylater/summary/consumer-lending-summary/ApplePaylaterConsumerLendingSummary.tsx` | 6 | Same pattern as PayMonthlySummary — duplicated error notification logic. |
| `Donation/Donation.tsx` | 1 | `campaignId` is truly arbitrary from API — **cannot be made static**. Must restructure or accept permanent suppression. |

---

## Shared Helper Opportunities

### 1. Weekday Key Helper (4+ files)

**Files:** PaymentDay, InlinePaymentDayList, PaymentDayList, PreferredPaymentDayInline, PreferredPaymentDay page
**Current:** `t(getLocaleKeyFromDayNumber(day))` — dynamic
**Proposed:** Refactor `getLocaleKeyFromDayNumber` to accept `t` and return the translated string internally using a switch with all 7 static key calls.

### 2. Error Notification Helper (3 files)

**Files:** PayMonthlySummary, ApplePaylaterConsumerLendingSummary, SummaryNotification
**Current:** Duplicated `t(\`summary:error.${reason}.heading\`)` patterns
**Proposed:** Create a `getErrorNotificationMessage(t, errorType, errorValue)` helper that uses switch/map to call `t()` with static keys.

### 3. Logged-in Loading Helper (4 files)

**Files:** logged-in/helper.ts (×2), ContractAgreement (×2)
**Current:** `t(\`common:${key}:title\`)` with `key` = `'verifyIdentity'` | `'unsuitabilityQuestions'`
**Proposed:** Inline the 2 possible static keys.

---

## Parameter Space Research

### Can we infer actual input values/permutations from code today?

| Component | Confidence | Notes |
|---|---|---|
| **TerminalError** | **High** | Strongly bounded by finite enums + context outputs (`declinePCL`, `complianceDeclineBureau`, `recoverable`, `KYCRefreshPending`, `''`) |
| **SummaryNotification + payment-method errors** | **High-Medium** | Finite domains (`CardErrorReason`, `BankAccountErrorReason`, topaz/3DS maps). Inline context behavior is finite/explicit. |
| **NewPaymentMethod** | **Medium-High** | Finite error maps, but more flow-state branching. |
| **Post-checkout asset fallback** | **Medium** | Core dimensions are finite (6 AssetIds × ExperimentValue × 2 flows), but LD payload determines reachability. |
| **Donation** | **Medium-Low** | `campaignId` is truly arbitrary. Locale files contain finite current set but evolves outside code. |
| **LoginPassword** | **High** | Explicit `errorKeys` map + narrow `_applepaylater` suffix. |

### Options For Analysis Before Test Authoring

1. **Static domain extraction** — Build analysis script reading enums/unions/mapping objects; output permutation matrix per domain.
2. **Runtime key tracing** — Mock `t`/`Trans` in tests to record resolved keys; compare against static matrix.
3. **Locale cross-checking** — Validate each enumerated key candidate exists in locale JSON.
4. **Decision-table testing** — For each complex hook/component, define input flags/states → expected key table using `test.each`.

### Permutation Coverage Verdict

| Status | Domains |
|---|---|
| **Good coverage confidence** | Terminal errors, Summary/payment method reason mappings, Login password error mappings |
| **Mostly yes, with caveats** | New payment method flows (more branching, but core domains finite) |
| **Not fully, needs registry/trace** | Post-checkout asset + variant + flow reachability, Donation campaign-id driven keys |

---

## What Migration Will Take

### A) Staticize `t(...)` in the suppressed files

Main patterns observed:

1. **Template keys from enum/error reason** — explicit maps/switches returning static literal unions.
   - Areas: `TerminalError`, `SummaryNotification`, `PayMonthlySummary`, `ApplePaylaterConsumerLendingSummary`, `NewPaymentMethod`, `LoginPassword`, `PaymentMethodCard`, `PaymentMethodErrorMessage`.

2. **`buildTranslationKey(...)` outputs** — derive finite key set up front and select from static map.
   - Area: `AutopayModal`.

3. **Runtime fallback arrays from post-checkout helper** — explicit registry of known keys by `assetId + variant + flow`, or generated registry file.
   - Areas: `PostCheckout`, `ProcessOrder`, `Asset/CallToAction`, `Asset/Subtitle`.

4. **Runtime API key segment** — `Donation.tsx` uses `donation:${campaignName}:...`.
   - Migration shape depends on whether campaign IDs are finite and controlled (confirmed: they are not).

### B) Address dynamic `<Trans i18nKey={...}>` (required)

Decision: static-key policy includes `<Trans i18nKey>` and is not limited to `t(...)`.

Options:
1. Extend lint/static checks to validate `<Trans i18nKey>` literal-ness.
2. Refactor dynamic `Trans` callsites to static key lookups.
3. Build extraction tooling that understands approved dynamic helper patterns.

### C) Decide static source strategy for dynamic domains

Need explicit decision for:
1. Post-checkout asset/variant/flow keys.
2. Donation campaign IDs.
3. Error-code-to-key mappings (terminal, summary, payment method).

### D) Tighten guardrails after migration

1. Burn down suppressions (or enforce zero-new suppressions).
2. Add CI check for dynamic `Trans i18nKey`.
3. Add extraction smoke test (key snapshot/diff).

---

## Test Coverage & Correctness Confidence

### Unit Tests

All 15 `i18n-only-static-keys` hotspot files have colocated unit tests.

**Stronger key-behavior coverage:**
1. `TerminalError/TerminalError.vitest.tsx`
2. `SummaryNotification/SummaryNotification.test.tsx`
3. `page/summary-pay-monthly/PayMonthlySummary.test.tsx`
4. `AutopayToggle/AutopayModal.test.tsx`
5. `PaymentMethodCard/PaymentMethodCard.test.tsx`
6. `PaymentMethodList/PaymentMethodErrorMessage.test.tsx`

**Weaker areas (high-value hardening targets):**
1. `Donation/Donation.test.tsx` — validates behavior, but little validation of campaign-key mapping semantics.
2. `Asset/component/CallToAction.vitest.tsx` — translation is mocked broadly; limited explicit key-shape assertions.
3. `Asset/component/Subtitle.vitest.tsx` — same broad mocking.
4. `ApplePaylaterConsumerLendingSummary.test.tsx` — includes multiple placeholder assertions (`expect(true).toBe(true)`), reducing confidence.
5. `PostCheckout/PostCheckout.test.tsx` — has fallback assertions, but expansion coverage for full asset/variant/flow matrix remains partial.

### Recommended Coverage Model

1. **Unit tests should own permutation completeness.**
   - Table-driven key-selection tests for `TerminalError`, `SummaryNotification`, `NewPaymentMethod`, `LoginPassword`, `ProcessOrder`, `PostCheckout`.
   - Assertions should target resolved key strings/contexts and fallback behavior, not only DOM visibility.

2. **Component tests should explicitly include `<Trans i18nKey>` paths.**
   - Assert rendered copy and critical link targets for `Trans` content blocks.

3. **E2E should own route-level integration confidence.**
   - Assert translation output by key (via locale helper) for a curated smoke set, not full permutation coverage.

4. **Add a registry consistency check in CI.**
   - Compare enumerated static key registry vs locale files and fail on drift.

---

## E2E Research

### How e2e works in this repo

1. Checkout e2e uses **Playwright** under `test/browser/scenarios/...` with page objects in `test/browser/pages/playwright/checkout/...`.
2. Test execution is **tag-driven** via `PLAYWRIGHT_TAGS`; without tags, the runner exits.
3. `test/scripts/run-playwright` requires `BROWSER_ENV` and loads env files from `test/env/checkout-${BROWSER_ENV}`.
4. Standard commands:
   - From root: `yarn test:playwright` (delegates to `test/scripts/run-playwright`)
   - From `test/`: `yarn test:checkout`, `yarn test:checkout:debug`, `yarn test:checkout:ui`
5. Typical local setup:
   - Create `test/.env` from `test/.env.template` (default `BROWSER_ENV=local`)
   - Run mocks (`yarn mocks`) and checkout app (`yarn checkout:start`)
   - Run tagged suite, e.g. `PLAYWRIGHT_TAGS=@checkout_local_regression_au_donation_and_puf BROWSER_ENV=local yarn test:checkout`
6. Local state shaping uses overrides:
   - Legacy file-based `loadOverrides(...)`
   - Object-based `loadVariationOverrides(...)` plus `interceptRequests(...)` for parallel-safe `mock-id`.

### Current e2e confidence for translation correctness

| Area | Scenarios | Copy Assertions |
|---|---|---|
| Terminal decline | 16 (`accountDecline`), 34 (`riskDecline`) | Mostly wrapper visibility + screenshot. Weak for copy. |
| Donation | 2 scenarios | Flow success only, no donation title/body assertion. |
| Post-checkout assets | 22 scenarios | Visibility/click paths only. No translation-string assertions. Many suites `@disabled_*`. |
| Payment method / login | Multiple suites | Assert error visibility / control state, not translation fidelity. |
| Consumer lending declines | Some suites | Assert text with hardcoded English strings. |
| Localization assertion pattern | 1 existing | `canadaFrench/newConsumerSignupFrenchFlow.pw.js` validates French labels. |

### CI pipeline tags currently wired

**Wired in:**
- `@checkout_local_regression_au_donation_and_puf`
- `@checkout_local_regression_payment_method`
- `@checkout_local_regression_au_login`
- `@checkout_local_regression_au_risk_decline_recovery`

**NOT wired in (requires pipeline update for protection):**
- `@checkout_local_regression_au_account_decline`
- `@checkout_local_regression_au_risk_decline_terminal`
- `@checkout_local_regression_us_risk_decline_recovery`
- `@checkout_local_pre_capture`
- `@checkout_local_regression_cl_us`

### Required changes for translation assertions

1. **Add shared translation assertion helper** at `test/browser/utils/i18n.ts`:
   - Load locale files from `apps/checkout/public/locales/<locale>/<namespace>.json`
   - Resolve key + context + interpolation with i18next-compatible behavior
   - Support fallback key arrays for post-checkout

2. **Add page-object accessors for copy fields** (instead of raw English in selectors):
   - `OhNo.js`, `Summary.js`, `RiskDecline.js`, `NewPaymentMethod.js`, `PaymentMethod.js`, `Password.js`, `CLSummary.js`
   - Expose getters by `data-testid`, compare against helper output

3. **Update high-risk scenarios** to assert text-by-key for route matrix hotspots

4. **Handle `<Trans i18nKey>` output** — for link-heavy `Trans` blocks, assert both rendered text and critical link targets

5. **Re-enable/retag disabled post-checkout suites** for CI protection

### Suggested e2e rollout

1. **Phase 1 (highest ROI):** Terminal errors + summary notification + donation + payment method error copy in local-enabled tags.
2. **Phase 2:** Post-checkout asset fallback text (`variant-flow` chain), including pre/post-capture flows.
3. **Phase 3:** Consumer lending/local-only decline copy assertions + CI pipeline tag expansion.

---

## Route/Page Verification Matrix

Use these routes to exercise the hardest transformation paths:

### 1. `/summary`
- **Hotspots:** `SummaryNotification`, `Donation`, `AutopayModal`, `ShippingOptionError`, processing modal (`PostCheckout` + `ProcessOrder`).
- **E2E anchors:** `test/browser/scenarios/checkout/summary/...`, `.../postCheckoutFlow/...`

### 2. `/apple-paylater/summary`
- **Hotspots:** `ApplePaylaterConsumerLendingSummary` or `ApplePaylaterRedesignedSummary`, plus `Donation`, `AutopayModal`, processing modal.
- **E2E anchors:** `test/browser/scenarios/checkout/consumerLending/...`, `.../summary/...`

### 3. `/oh-no` and `/apple-paylater/oh-no`
- **Hotspots:** `TerminalError` static error-key selection.
- **E2E anchors:** `test/browser/scenarios/checkout/accountDecline/...`, `.../riskDecline/...`, `.../consumerLending/.../declineMessages...`

### 4. `/oh-no/[error]` and `/apple-paylater/oh-no/[error]`
- **Hotspots:** Recoverable error content and fallback behavior linked to payment method/retry states.

### 5. `/new-payment-method`, `/add-payment-method`, `/apple-paylater/new-payment-method`
- **Hotspots:** `NewPaymentMethod` error reason mappings and fallback arrays.
- **E2E anchors:** `test/browser/scenarios/checkout/paymentMethod/creditCard/newPaymentMethod/...`

### 6. `/payment-method` and `/apple-paylater/payment-method`
- **Hotspots:** `PaymentMethodCard`, `PaymentMethodErrorMessage`.
- **E2E anchors:** `test/browser/scenarios/checkout/paymentMethod/creditCard/summary/...`

### 7. `/password` and `/apple-paylater/password`
- **Hotspots:** `LoginPassword` dynamic error key composition.
- **E2E anchors:** `test/browser/scenarios/checkout/login/...`

### 8. `/card-scan` and `/apple-paylater/card-scan`
- **Hotspots:** `PaymentMethodCard` error key rendering and processing transition.

**Note:** `ProcessOrder`/`PostCheckout` are not tied to one page; they surface via `ProcessingModal` in layout when `displayProcessingModal` is true.

---

## Key Risks & Open Decisions

### Risks

1. **TerminalError.tsx** — highest-risk file due to 47 error code values and cascading effect on heading, description, option, subheading, detail, and CTA keys. However, `.detail`, `.subheading`, and `.cta` are conditionally used for only 1-2 error codes each.

2. **PostCheckout.tsx + `useGetLocaleWithFallback`** — fundamentally different architecture where keys are generated combinatorially from runtime state. The `variant` value from experiments makes full static enumeration fragile.

3. **Donation.tsx** — **CONFIRMED:** `campaignId` is truly arbitrary from an API response. Cannot be made static without restructuring.

4. **PayMonthlySummary + ApplePaylaterConsumerLendingSummary + SummaryNotification** — shared error notification pattern duplicated across 3 files. A shared helper would reduce duplication.

5. **PaymentDay pattern** — recurs in 4+ files. The function already has a static lookup table internally — refactoring it to accept `t` would fix all files at once.

6. **Dead code in ShippingAddressItem.tsx** — duplicate `if (isArcadeDesignLanguage)` checks make the second block unreachable. Should be cleaned up.

### Open Decisions Before Planning

1. **Staticity scope:** Confirmed as both `t(...)` and `<Trans i18nKey>` callsites.
2. **Donation campaign IDs:** How should they be represented if campaign IDs remain runtime-driven?
3. **Post-checkout fallback keys:** Enumerate combinations in code, generate static key registry, or allow extractor-aware dynamic helpers?
4. **Dynamic `context` migration:** Should the 66 `i18n-no-dynamic-context` suppressions be included now or sequenced later?

---

## Recommended Approach for Implementer

1. **Start with TRIVIAL files (~22 files, ~25 violations)** — ternary patterns are mechanical transformations with zero risk. Can be done in parallel by multiple agents.

2. **Then LOW files (~22 files, ~30 violations)** — small enums with known values, straightforward switch statements. Create shared helpers for repeated patterns (weekday keys, logged-in loading).

3. **Then MODERATE files (~8 files, ~20 violations)** — require understanding the enum/condition space but are bounded. LoginPassword has 16 key combinations, AutopayModal has ~12.

4. **Leave HIGH files for last (~5 files, ~26 violations)** — TerminalError needs a type-safe `Record` mapping for 47 error codes; PostCheckout may need architectural discussion; Donation needs a restructuring decision.

5. **For each file:** verify the fix compiles, run `yarn lint:diff-all` to confirm the suppression can be removed, and run relevant tests with `yarn test:jest apps/checkout`.

6. **The `buildTranslationKey` utility** should be preserved for runtime use but its outputs should be pre-enumerated at each call site for the static key extractor.

7. **Create shared helpers** for the weekday key pattern, error notification pattern, and logged-in loading pattern to reduce duplication.

8. **Remove the `i18n-only-static-keys` suppression** from `eslint-suppressions.json` for each fixed file. After all fixes, the suppression should have count 0 and be removable.

9. **Address dead code** in ShippingAddressItem.tsx (duplicate `isArcadeDesignLanguage` check) as part of this work.

10. **For Donation.tsx**, make an architectural decision: either restructure translation keys to use interpolation, or accept a permanent suppression with documentation.