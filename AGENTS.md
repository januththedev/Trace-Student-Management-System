# AGENTS.md — T2T Student Operations System

Requirements: `T2T_Coding_Agent_Master_Prompt.md` (authoritative). Several agents work here in parallel.
**Only edit files inside your assigned ownership area.** If you need a change in someone else's file,
write the request into `docs/agent-requests.md` instead of editing it.

## Stack
Next.js 16 (App Router, `src/`), TypeScript strict, Tailwind v4, Drizzle ORM + postgres-js, PostgreSQL 17
(docker `t2t-postgres`, port 55432), vitest (unit + integration against real Postgres), Playwright (e2e).
Next 16 notes: route `params` is a Promise (`await ctx.params`); `middleware.ts` is named `proxy.ts`.

## Shared foundations (owner: Claude — do not edit, import them)
- `src/db/schema.ts` — all tables. Need a new column/table? add a request to `docs/agent-requests.md`.
- `src/db/client.ts` — `db()`, `withTx(fn)` (retries 40001/40P01), `isUniqueViolation`, `pgCode`.
- `src/lib/money.ts` (integer minor units only), `src/lib/time.ts` (Asia/Colombo `BizDate` strings; `now()` honours `T2T_FAKE_NOW`),
  `src/lib/crypto.ts`, `src/lib/nic.ts`, `src/lib/csv.ts`, `src/lib/files/validate.ts`.
- `src/server/http.ts` — `route(handler)`, `json()`, `parseBody(req, zod)`, `fail.*` errors, `idempotencyKey(req)`.
- `src/server/auth/policy.ts` — `StaffPrincipal`, `can/requireCap/requireSuper`, `enrolmentInScope`, `intakeScopeWhere`, `assertOperational`, `visibleIntakeIds`.
- `src/server/auth/staff.ts` — `requireStaff(req)` (session + CSRF header `x-csrf-token`), `currentStaff()`, `createStaffSession`, `revokeAllStaffSessions`.
- `src/server/audit.ts` — `audit(tx, …)`, `notify(tx, …)` (in-portal notification + outbox, same tx).
- `src/domain/finance.ts` — ALL money math (net/remaining/credit/states/allocation plans/collection rate/ageing).
- `src/server/services/ledger.ts` — `loadLedger(tx, enrolmentId, {lock})`, `loadLedgers(tx, ids)` (batched, no N+1).
- `tests/integration/helpers.ts` — `resetDb()`, `makeProgramme/makeIntake/makeStudent/makeEnrolment/makeStaff/principalOf`, `pinNow`.

## Rules
- Every mutation: zod-validated, `withTx`, fresh authorization inside the tx, `audit()`, expected `version` checks, idempotency where retries are possible.
- Out-of-scope records return `fail.notFound()` (never reveal existence). Admin scope via `enrolmentInScope` / `intakeScopeWhere`.
- Never float money. Never delete history. No raw NIC in logs/URLs/exports/client storage.
- UI: Tailwind, accessible (labels, focus, 44px targets), responsive, solid high-contrast financial surfaces, skeleton/empty/error states. Staff UI lives under `src/app/staff/`, shared UI primitives under `src/components/ui/` (owner: Claude; create your own components in your area folder if needed).
- Layout preference: fit simple small pages within one screen where practical. Every sidebar item and section heading must stay visible without scrolling, using normal-size text/icons and height-aware whitespace rather than an overly compact appearance. Preserve 44px targets, readable financial values and scrolling for long page content, errors or zoom. Do not clip content to suppress scrollbars. Reports support PDF and CSV downloads.
- Client mutations send `x-csrf-token` (rendered by the staff layout as `<meta name="csrf-token">`) and `Idempotency-Key` headers.
- Tests: `pnpm exec vitest run tests/integration/<file>` — each integration file calls `resetDb()` in `beforeEach`.

## Ownership
| Area | Owner | Paths |
| --- | --- | --- |
| Foundations, finance ledger, receipt review, student portal, admissions/enrolments/exemptions/withdrawals | Claude | `src/server/services/{ledger,review,submissions,enrolments,exemptions,withdrawals,admissions}*`, `src/app/(student)/**`, `src/app/staff/review/**`, `src/app/api/student/**`, `src/app/api/staff/review/**` |
| Follow-ups: call cards, attempts, promises, tasks, business calendar, retry/escalation jobs | Codex-A | `src/server/services/followups/**`, `src/app/staff/calls/**`, `src/app/api/staff/calls/**`, `tests/integration/followups*.test.ts` |
| Staff governance + Trash/retention: bootstrap, login/logout, invitations, Super Admin invariant, deactivation, staff & programme/intake Trash/restore/purge job | Codex-B | `src/server/services/governance/**`, `src/server/services/trash/**`, `scripts/bootstrap-super-admin.ts`, `src/app/staff/login/**`, `src/app/staff/team/**`, `src/app/staff/trash/**`, `src/app/api/staff/{auth,team,trash}/**`, `tests/integration/{governance,trash}*.test.ts` |
| Reports, dashboards metrics, CSV exports/imports, reconciliation command | OpenCode | `src/server/services/reports/**`, `src/server/services/imports/**`, `scripts/reconcile.ts`, `tests/integration/{reports,imports}*.test.ts` |
| Docs | OpenCode | `docs/**` except `docs/agent-requests.md` (shared append-only) |

## Design tokens (dealt via the design-taste-frontend skill)
Tailwind v4 theme in `src/app/globals.css`: `bg-bg`, `bg-surface`, `bg-card`, `text-ink`, `text-muted`, `border-line`,
`bg-accent`/`text-accent` (teal #0d7480), `bg-inv` (slate), status `ok/warn/bad/info` + `-soft`. Sharp radius
(`rounded-sm|md|lg` = 2/4/6px). Font Host Grotesk, numbers `font-mono`. Classes `.btn` (hover step/press), `.lift`
(linked card lifts 2px), `.u-draw` (underline draws). No violet. Shared primitives: `src/components/ui/*`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Added ownership (round 2)
| Students/enrolments/admissions/programmes/imports UI + `src/server/services/directory.ts` | Codex-C | see `.agents-logs/prompt-codex-C.md` |
| PWA: `public/{manifest.webmanifest,sw.js,sw-policy.js,offline.html}`, `src/components/pwa/**` | OpenCode-PWA | |
| Command centre `/staff` page, `/staff/metrics/**`, `/staff/reports/**`, `/api/staff/reports/**`, seed script, e2e | Claude | |
| Seed, perf, README, traceability, api/architecture docs | Codex-D | scripts/seed*.ts, scripts/perf-check.ts, README.md, docs/{traceability,api-contracts,architecture,test-results}.md |
| Acceptance tests (student access, uploads, Playwright e2e) | Codex-E | tests/integration/{student-access,uploads}.test.ts, tests/e2e/**, playwright.config.ts |
| Perf of metrics/reports, background exports, perf migration | Codex-G | src/server/services/reports/**, exports routes, drizzle/0002_perf_indexes.sql |
| Visual QA: student portal, review, command centre, reports UI | Codex-H | see prompt-codex-H.md |
