# Interim status — QA triage

Date: 2026-11-15 · Environment: `t2t-postgres` docker up on 55432 · Commands run from repo root.
No source, test, or config files were modified.

## Summary

| # | Step | Result | Counts |
|---|---|---|---|
| 1 | `pnpm exec tsc --noEmit` | **PASS** | 0 errors |
| 2 | `pnpm exec eslint src tests scripts --max-warnings=10000` | **FAIL** | 7 errors, 3 warnings (3 error files); exit 1 |
| 3 | `pnpm exec vitest run tests/unit` | **PASS** | 5 files, 89/89 tests |
| 4 | `pnpm exec vitest run tests/integration` | **FAIL** | 9 files, 102/103 tests (1 failed file) |
| 5 | `pnpm build` | **PASS** | Compiled + TS check + 31/31 static pages; 1 warning |

Additional informational warnings: Vitest config CJS/ESM load warning on every vitest run; Turbopack dynamic-filesystem warning in `src/server/storage.ts:57`.

## Step 2 — ESLint failures (errors only)

| File | Line | Rule | Note |
|---|---|---|---|
| `src/app/_entry/entry-form.tsx` | 26 | `react-hooks/set-state-in-effect` | `setIntakeId(last)` synchronously in effect after reading `localStorage` |
| `src/app/staff/review/review-workspace.tsx` | 49 | `react-hooks/purity` | `useState(Date.now())` evaluates impure function during render |
| `src/app/staff/review/review-workspace.tsx` | 55 | `react-hooks/set-state-in-effect` | `setFilters`/`setSkipped` from `sessionStorage` inside mount effect |
| `src/app/staff/review/review-workspace.tsx` | 78 | `react-hooks/set-state-in-effect` | `void loadQueue()` in effect; `loadQueue` calls `setLoading` synchronously |
| `src/app/staff/review/review-workspace.tsx` | 88 | `react-hooks/set-state-in-effect` | effect calls `setCtx(null)`, `setMode("view")` when `current` changes |
| `src/app/staff/review/review-workspace.tsx` | 378 | `react-hooks/purity` | `Date.now()` in `onDone(...)` inside approve handler (same pattern at 415 not separately reported) |
| `src/app/staff/students/[id]/page.tsx` | 10 | `react/no-unescaped-entities` | literal `'` in "person's shared contact profile" |

Warnings (non-blocking):

| File | Line | Rule |
|---|---|---|
| `src/app/staff/programmes/page.tsx` | 11 | `@next/next/no-img-element` |
| `src/app/staff/programmes/programme-forms.tsx` | 7 | `@next/next/no-img-element` |
| `tests/integration/helpers.ts` | 79 | `@typescript-eslint/no-unused-vars` (`_n`) |

Diagnosis: all 7 errors are React-Compiler/JSX lint-rule conformance issues, not runtime/build breaks. The `review-workspace` effects are data-fetch/`sessionStorage` hydration patterns the compiler rules reject; `Date.now()` in render/state initializer is the one with a plausible real impact (non-idempotent render). The students page error is a trivial escaping fix. Build and tsc both pass with these present.

## Step 4 — Integration test failure

File: `tests/integration/directory.test.ts` · Test: `scenario 10: student directory scope > requires separate creation capability and atomically grants creator scope` · reproduces deterministically when run alone.

```
AssertionError: expected '{"id":"d97c3c22-…' to be '{"id":"d97c3c22-…' // Object.is equality
Expected: … "description":"","bannerPath":null,"logoPath":null,"status":"ACTIVE", … "version":1}
Received: … "status":"ACTIVE","version":1,"isPublic":true,"logoPath":null,"createdAt": … "description":"", …
❯ tests/integration/directory.test.ts:69:75
```

Diagnosis: the test compares `JSON.stringify(firstResult)` with `JSON.stringify(idempotentReplay)` — an order-sensitive comparison of objects with identical values but different key order. The first call returns the in-memory `saved` row; the replay returns `rec.response` from `idempotencyRecords.response`, a **jsonb** column, and Postgres jsonb normalizes key order. Product behaviour is correct; the assertion is wrong.

- Fix location (test): `tests/integration/directory.test.ts:69` — use `toEqual` (as the NIC-replay assertion already does at line 50).
- Evidence: `src/server/idempotency.ts:34` (`…::jsonb`), `src/db/schema.ts:690` (`jsonb("response")`).
- Service path is sound: `src/server/services/directory.ts:117-128`.

## Failures grouped by owning agent

| Owner | Failures |
|---|---|
| **Claude** (student portal, review) | Lint: `src/app/_entry/entry-form.tsx:26`; 5 lint errors in `src/app/staff/review/review-workspace.tsx` (49, 55, 78, 88, 378). Warning: `tests/integration/helpers.ts:79`. Build warning: `src/server/storage.ts:57`. |
| **Codex-C** (students/programmes UI, directory) | Lint error: `src/app/staff/students/[id]/page.tsx:10`. Warnings: `src/app/staff/programmes/page.tsx:11`, `src/app/staff/programmes/programme-forms.tsx:7`. Failing test: `tests/integration/directory.test.ts:69` (assertion bug, not product). |
| **Codex-A, Codex-B, Codex-D, Codex-E, OpenCode, OpenCode-PWA** | No failures observed. |

## Suggested fixes (not applied)

1. `directory.test.ts:69`: `expect(await saveProgramme(f.admin,v,"create-allowed")).toEqual(created)`.
2. `students/[id]/page.tsx:10`: escape the apostrophe (`person&apos;s`).
3. `review-workspace.tsx:49`: initialise `now` to `0`/`null` and set it in the existing interval effect; move `Date.now()` calls out of render-scoped code (or wrap in an event boundary the rule accepts).
4. `entry-form`/`review-workspace` hydration effects: read storage in a lazy client initializer or an event/subscription (`useSyncExternalStore`) instead of synchronous `setState` in an effect.
5. `programmes` banner previews: switch `<img>` to `next/image` (or add justified disables).
6. `tests/integration/helpers.ts:79`: drop the unused `_n` binding.

## Update 2026-11-16 (OpenCode) — lint findings resolved in source

The historical results above are preserved unchanged. Current source state, verified this session
by running the commands (evidence: `pnpm exec eslint src` exit 0, zero errors **and** zero
warnings; `pnpm exec eslint src/server/services/imports/students-import.ts` exit 0):

- All 7 ESLint errors listed in the Step 2 table are fixed in current source (`entry-form.tsx`,
  `review-workspace.tsx`, `students/[id]/page.tsx`). The table above is a historical record of the
  2026-11-15 run, not the current state.
- The 2 `@typescript-eslint/no-unused-vars` warnings in
  `src/server/services/imports/students-import.ts` (`isNull`, `visibleIntakeIds`) are also fixed:
  the unused bindings were removed from the two import lines. `eslint src` now reports nothing.
- The Step 4 test failure is fixed in the test file: `tests/integration/directory.test.ts:77` now
  compares with `toEqual(JSON.parse(JSON.stringify(created)))` (key-order-insensitive) instead of
  the previous order-sensitive `JSON.stringify` equality. Not re-run here.
- Not re-verified here: tsc/build/vitest results. An acceptance agent is running desktop/mobile
  Playwright e2e in an isolated DB, so no test runs were performed for this update.
