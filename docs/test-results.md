# Verification log

Append-only evidence log. Each entry identifies its executing agent and artifact where available. Times use Asia/Colombo unless noted. No source proposal PDF was available for cross-checking.

## Current handoff status — 2026-11-16

Latest root verification: **428/428 unit/integration tests across 30 files**, 495.75 seconds (`.agents-logs/storage-final-tests.log`); **34/34 Playwright**,17 desktop and17 mobile,8.2 minutes (`.agents-logs/storage-final-e2e.log`). Final build/TypeScript and lint passed after the archival/storage changes. The provided empty Neon database was migrated through 0003 over direct TLS; actual R2 bucket access remains pending user configuration. Earlier snapshots below are historical.

## 2026-11-15 — development seed and type check

- `pnpm exec tsc --noEmit` — exit 0, no diagnostics, on the concurrent workspace snapshot at this run.
- `node --conditions=react-server --import tsx scripts/seed.ts --reset` — exit 0 against the development `DATABASE_URL`. Warned about the development default password. Verified 4 programmes, 9 intakes (1 in Trash), 60 students, 61 enrolments, 366 instalments and 2 staff through real services. All 61 ledgers loaded successfully; overpayment credit and fully waived obligation assertions passed. Receipt fixture bytes went through private upload, validation, preview generation and finalization. Printed six synthetic NIC/intake entry pairs.
- Read-only reconnaissance: `rg` with a shell brace-list failed to parse in PowerShell; retried with ordinary directory paths. Some candidate paths (`src/server/jobs.ts`, `src/proxy.ts`, `src/server/services/imports/index.ts`) do not exist; located actual implementations via `rg --files`. These were inspection mistakes, not application verification failures.

Seed fixture clock is fixed to 2026-11-15 inside the seed process and restored afterward. The application uses its normal clock. No real external messages or phone calls were sent.

## 2026-11-15 — initial performance dataset and benchmark

- `docker exec t2t-postgres psql -U t2t -d postgres -c "CREATE DATABASE t2t_perf;"` — exit 0, CREATE DATABASE.
- `pnpm exec tsx scripts/migrate.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf` — exit 0, migrations applied to the new database.
- `node --conditions=react-server --import tsx scripts/seed-perf.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf` — started before the usage interruption; output showed 2,500 students prepared in its transaction. Final process exit/output was unavailable after resumption. A subsequent real SQL count verified the transaction committed 10,000 students, 60,000 instalments, 10,000 submissions, 5,000 payment events and 7,500 allocations. Do not infer an observed exit status for the interrupted tool session.
- `docker exec t2t-postgres psql -U t2t -d t2t_perf -c "select (select count(*) from students) students, (select count(*) from instalments) instalments, (select count(*) from payment_submissions) submissions, (select count(*) from payment_events) payments, (select count(*) from payment_allocations) allocations;"` — exit 0; returned the counts above.
- `node --conditions=react-server --import tsx scripts/perf-check.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf` — exit 0; all query-result assertions passed. Sub-second p95 target NOT MET for Super Admin metrics.

Machine reported by benchmark: DESKTOP-9UCOKAU; Windows win32 10.0.29704 x64; Intel Core i5-1135G7 @ 2.40 GHz; 8 logical CPUs; 32 GiB RAM; Node v24.12.0. PostgreSQL 17 in Docker, localhost TCP port 55432. One warmup per query, 20 sequential measured runs, nearest-rank p50/p95, warm DB/OS caches, no application result cache, fixed as-of 2026-11-15, service-result assertions included. Other agents were active on the same machine; this is neither an idle-machine baseline nor a concurrent load test. Only migrations 0000/0001 were registered at this measurement.

| Operation | Runs | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| loadLedgers, 50 enrolments | 20 | 39.08 | 47.66 | 63.67 |
| pendingQueue, first 50 | 20 | 78.91 | 110.84 | 121.51 |
| metrics, Super Admin | 20 | 1466.35 | 2983.45 | 3687.63 |
| metrics, scoped Admin | 20 | 394.11 | 688.12 | 811.69 |
| call queue, first 50 scanned | 20 | 86.70 | 103.91 | 104.51 |

The aggregate metric path projects all scoped enrolments; optimization is assigned to Codex-G. Future measurements must be logged as separate runs rather than replacing this result.

## 2026-11-15 — integration retry after concurrent-run interference

- `pnpm exec vitest run tests/integration/finance-fixtures.test.ts tests/integration/reports.test.ts tests/integration/followups.test.ts` at 16:39 — exit 1: 20 passed / 18 failed (reports passed; finance 3 failed; follow-ups 15 failed). Failures included TRUNCATE deadlocks (40P01), missing fixture foreign keys and unexpected row counts, consistent with another process running the same per-file databases concurrently. This run is not a passing financial verification.
- `pnpm exec vitest run tests/integration/finance-fixtures.test.ts` at 17:15 — exit 0: 8/8 passed, 10.48 seconds. Isolated rerun verifies numerical fixtures, approval concurrency/replay, undo dependencies, withdrawal accounting and scope.
- `pnpm exec tsc --noEmit` after resumption — exit 0, no diagnostics.
- A reports/follow-ups test run started before a second usage interruption; its final output was unavailable after resumption, so no pass/fail result is claimed for that invocation.

## 2026-11-15 — final seed postconditions and safeguards

- `pnpm exec vitest run tests/integration/finance-fixtures.test.ts tests/integration/reports.test.ts tests/integration/followups.test.ts` at 17:25 — exit 0: all 3 files, 38/38 tests passed; 98.13 seconds under concurrent machine load. Vitest emitted the existing CJS/ESM config-loader advisory.
- `pnpm exec tsc --noEmit` — exit 0, no diagnostics, on the resumed workspace snapshot.
- `pnpm exec eslint scripts/seed.ts scripts/seed-perf.ts scripts/perf-check.ts` — exit 0, no diagnostics.
- `node --conditions=react-server --import tsx scripts/seed.ts --reset` on the first resumed attempt — exit 1 on initial `select count(*) from students`; the handler reported only the failed query, so no root cause is asserted. No reset had begun. A read-only psql check afterward showed the original 60 demo students intact.
- Repeated `node --conditions=react-server --import tsx scripts/seed.ts --reset` — exit 0, printed the verified demo summary and six synthetic NIC/intake pairs. New executable checks passed for paid/partial/pending/credit/free-card/sponsorship/withdrawal/credit-application balances and exact workflow counts: 60 people, 366 instalments, 1 active Super, 1 staff scope, 1 open and 1 broken promise, 8 no-answer attempts, 1 under-review and 61 accepted admissions, 1 trashed intake, 7 validated image receipts with previews and 1 replacement chain.
- `$env:NODE_ENV='production'; node --conditions=react-server --import tsx scripts/seed.ts --reset` — expected exit 1: development seed including reset forbidden in production; no database mutation.
- `node --conditions=react-server --import tsx scripts/seed-perf.ts --url postgres://t2t:t2t_dev_password@localhost:55432/t2t` — expected exit 1: performance DB must differ from DATABASE_URL. Confirms localhost/127.0.0.1 identity protection before opening a target connection.
- Read-only Node connectivity probe using CommonJS `require('postgres')` failed because the installed package exposes an ES module namespace; it did not reach the database. Seed retry above is the successful application connectivity check.
- `pnpm exec tsx scripts/migrate.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf` after the new migration journal entry appeared — exit 0, migrations applied. At invocation, 0002_perf_indexes.sql contained only a placeholder comment; do not claim that later edits to this already-journalled file were applied to this database.

## 2026-11-15 — SQL metrics summary, before performance indexes

- `node --conditions=react-server --import tsx scripts/perf-check.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf` — exit 0; result assertions passed; sub-second target NOT MET. This run used the new services/reports/balances.ts SQL summary but preceded actual creation of the perf_* indexes (the migration had been recorded while its source was a placeholder). Same machine/dataset, one warmup and 20 sequential measured runs as the initial benchmark; other agents/builds active.

| Operation | Runs | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| loadLedgers, 50 enrolments | 20 | 46.67 | 97.48 | 349.86 |
| pendingQueue, first 50 | 20 | 102.55 | 157.16 | 168.66 |
| metrics, Super Admin | 20 | 1677.97 | 2164.73 | 2186.49 |
| metrics, scoped Admin | 20 | 421.38 | 576.02 | 589.03 |
| call queue, first 50 scanned | 20 | 128.96 | 153.32 | 153.78 |

- `pnpm exec tsc --noEmit` followed by `pnpm exec eslint scripts/seed.ts scripts/seed-perf.ts scripts/perf-check.ts` after seed postconditions were added — both completed without diagnostics; shell exit 0.

## 2026-11-15 — index application and evolving reports tests

- Read-only `pg_indexes` inspection on t2t_perf confirmed no perf_* indexes before applying the completed migration source.
- `Get-Content -Raw -LiteralPath drizzle/0002_perf_indexes.sql | docker exec -i t2t-postgres psql -v ON_ERROR_STOP=1 -U t2t -d t2t_perf` — exit 0, ten CREATE INDEX confirmations. Only the disposable performance database was changed; source migration was not edited by Codex-D.
- `docker exec t2t-postgres psql -v ON_ERROR_STOP=1 -U t2t -d t2t_perf -c "ANALYZE;"` — exit 0, ANALYZE complete.
- `pnpm exec vitest run tests/integration/reports.test.ts` at 17:32 — exit 1: 6/7 passed; newly added SQL ledger-equivalence test failed in resetDb's initial pg_tables query with `connect ETIMEDOUT 127.0.0.1:55432`. Failure was connection setup, not a ledger assertion. Do not replace this with the earlier six-test report pass.
- `node --conditions=react-server --import tsx scripts/seed.ts` without reset against the populated demo — expected exit 1: database already has students; use --reset only for disposable development data. No reset performed.

## 2026-11-15 — SQL summary plus completed indexes

- `node --conditions=react-server --import tsx scripts/perf-check.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf` after ten perf_* indexes and ANALYZE — exit 0; all query-result assertions passed; all five p95 values below 1,000 ms. Same 10,000 students / 60,000 instalments and machine as above; one warmup plus 20 sequential runs per operation; other agents active. This measures the balances.ts implementation and the explicitly applied index SQL, not only the migration journal state.

| Operation | Runs | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| loadLedgers, 50 enrolments | 20 | 46.18 | 54.90 | 64.59 |
| pendingQueue, first 50 | 20 | 66.41 | 139.97 | 141.94 |
| metrics, Super Admin | 20 | 482.47 | 886.95 | 923.68 |
| metrics, scoped Admin | 20 | 191.53 | 276.06 | 287.72 |
| call queue, first 50 scanned | 20 | 148.59 | 188.76 | 193.42 |

Target PASS for these local warm sequential conditions. This does not establish production or concurrent-load latency. Earlier failed-target measurements remain above to preserve the evidence.

## 2026-11-15 — documentation and final validation snapshot

- Read-only documentation inventory after export APIs were added: 46 src/app/api route files, no undocumented path prefixes in docs/api-contracts.md. README, API and architecture Markdown links all resolve locally. The first naive link regex treated inline schema notation as Markdown links; stripping inline code removed those false positives. This is a path/link check, not an HTTP behavior test.
- `pnpm exec vitest run tests/integration/reports.test.ts` at 17:34 — exit 1: 6/7 passed, collection-rate advance-payment assertion returned zero denominator instead of 100,000 while report source was being edited. No fix to another owner's source was made by Codex-D.
- Same reports command at 17:36 — exit 0: 7/7 passed, including SQL ledger equivalence, 21.67 seconds. The final passing rerun does not erase the earlier failures.
- `pnpm exec tsc --noEmit` latest workspace snapshot — exit 1 with three diagnostics outside Codex-D: TS2322 at src/app/api/staff/enrolments/[id]/[action]/route.ts:12:121 and src/app/api/staff/programmes/[id]/intakes/route.ts:6:59 (ZodDefault<ZodString> not assignable to never); TS2304 at src/server/services/imports/students-import.ts:187:5 (inScope missing). No seed/performance script diagnostics. Reported in shared agent requests; protected files left untouched.

Codex-D changed scripts/seed.ts, scripts/seed-perf.ts, scripts/perf-check.ts, README.md, docs/api-contracts.md, docs/architecture.md and this append-only log, plus appended coordination requests. docs/traceability.md is actively owned by OpenCode under the user's latest instruction and was not edited by Codex-D. New background export source/API contracts are documented, but Codex-D did not run their dedicated tests or claim a deployed scheduler. Build, full lint and Playwright are not claimed as Codex-D results.

## 2026-11-15 - Codex-G: set-based metrics and background exports

Performance dataset: the existing `t2t_perf` database, 10,000 students / 60,000 instalments; same Windows machine and Node v24.12.0 as Codex-D's baseline. No application-result caching. Commands ran via `node --conditions=react-server --import tsx scripts/perf-check.ts --url <t2t_perf connection URL>`: one warmup and 20 sequential measured runs per operation. Other agents were working concurrently; these are local measurements, not production load-test results.

| Metric | Codex-D original p95 ms | First optimized run p95 ms | Latest final-source run p50 ms | Latest final-source run p95 ms | Latest max ms |
|---|---:|---:|---:|---:|---:|
| Super Admin metrics | 2983.45 | 408.38 | 639.96 | 861.69 | 1123.34 |
| Scoped Admin metrics | 688.12 | 123.74 | 257.23 | 297.31 | 321.87 |

The sub-second p95 target passes for both roles. The first optimized run also met the optional 500 ms target; the latest run overlapped this agent's EXPLAIN, integration tests and TypeScript/lint checks, so the optional target was not met for Super Admin under that contention. Latest additional p95 values: loadLedgers/50 = 121.17 ms; pendingQueue/50 = 240.74 ms; call queue/50 scanned = 390.75 ms. Every result assertion passed and the performance script reported PASS.

`--explain` now runs EXPLAIN (ANALYZE, BUFFERS) on the exact SQL used by balanceMetrics. Before the final fixes, a text cast on enrolment status caused an estimate of 50 rows for 10,000 actual enrolments, 10,000 instalment index probes, 41,302 shared buffer hits, temporary writes and 1384.000 ms financial-query execution. The typed enum predicate restores the 10,000-row estimate; charges are inlined and child ledgers aggregate separately, avoiding join fan-out. Final exact-query execution was 834.002 ms (Super Admin) / 312.972 ms (Admin) during concurrent checks; the scoped plan uses perf_enrolment_active_intake_idx and both plans use perf_pending_enrolment_idx. Dashboard counts now wrap the same scoped SQL queries used by drill-downs instead of returning full lists for counting.

Migration 0002 was generated with `pnpm exec drizzle-kit generate --custom --name perf_indexes`. Because Codex-D had already journalled the placeholder version on t2t_perf, Codex-G explicitly applied its final statements there with CREATE INDEX IF NOT EXISTS; catalog verification found all 10 perf_* indexes. The fresh exports-job integration database also has all 10 indexes through the normal migration chain. No schema.ts changes were made.

Background export contracts: POST /api/staff/exports accepts the existing export request plus session CSRF and Idempotency-Key headers; returns 202 with a job ID. Authenticated GET /api/cron/exports processes up to five queued jobs, with row locks/SKIP LOCKED, current authorization, bounded retries and private objectStore writes. GET /api/staff/exports/[id] returns 202 while queued or streams CSV with private no-store headers; checks current capability, ownership, role/scope fingerprint and 15-minute expiry. Scope changes invalidate previously generated files. Cron cleanup deletes expired objects and preserves job/audit history; unfinished jobs expire after 24 hours so objects left before a crash also get cleaned. Vercel cron is configured every five minutes. The synchronous small-report route remains available and now re-authorizes within its audit transaction.

Production limitation inherited from src/server/storage.ts: only the real local development adapter is implemented; the shared S3 adapter must be supplied before production object storage can run. Export workers expose dependency failures through persisted job status and job_runs instead of claiming success.

Final Codex-G validation:
- `pnpm exec vitest run tests/integration/reports.test.ts tests/integration/exports-job.test.ts` - exit 0; 2 files / 17 tests passed, 24.02 seconds. This includes full SQL-summary and instalment-state equivalence to loadLedgers for partial payments, pending evidence, credit, active/reversed exemptions, withdrawal cancellation and receipt reversal. Background tests use real PostgreSQL and the real private local objectStore: idempotency mismatch, overlapping workers, capability removal before/after generation, scope removal, ownership, stale auth/deactivation, Super Admin demotion for full identifiers, exact 15-minute expiry, crash-object cleanup and cron authentication.
- Scoped ESLint over reports services/routes, exports routes/cron, both integration files and scripts/perf-check.ts - exit 0, no diagnostics.
- `pnpm exec tsc --noEmit` was run repeatedly; the most recent completed run at this entry returned exit 1 on three concurrent changes outside Codex-G ownership: enrolments/[id]/[action]/route.ts:12 and programmes/[id]/intakes/route.ts:6 (ZodDefault<ZodString> / never), imports/students-import.ts:187 (missing inScope). No diagnostics point to Codex-G files. Exact requests are in docs/agent-requests.md; those files were left to their owners.
- Final `pnpm exec tsc --noEmit` rerun - exit 1; the two route-schema errors above were fixed concurrently by their owners. The remaining diagnostics are outside Codex-G ownership: src/app/staff/admissions/admission-forms.tsx:14 (HTMLFormElement cast to HTMLSelectElement) and src/server/services/imports/students-import.ts:187 (missing inScope). No Codex-G file diagnostics.

## 2026-11-16 — root-run consolidated integration suite and functional QA (recorded by root)

- `pnpm exec vitest run tests/integration` — exit 0: 12 files / 203 tests passed, duration 161.84 s, finished 11:01:45 on 2026-11-16. The run was executed at root level and the root process directly inspected the output. This is the single consolidated green integration run after the F-01…F-13 fixes that `docs/ui-completion-audit.md` §C.3 asked for.
- `.agents-logs/team-functional-qa.mjs` — passed password reveal/mask and mobile team search/reset checks against the running app.
- `.agents-logs/holiday-functional-qa.mjs` — passed against the real mobile rendered UI with intercepted HTTP only: date picker, add/remove holiday flow, expectedLabel/CSRF/idempotency headers. No real holidays were modified.
- `.agents-logs/export-real-qa.mjs` — passed end to end with no HTTP mocking: background export job creation → local export worker → private CSV download, driven through the mobile Reports UI.
- Current visual audit `.agents-logs/shots-current/audit.json` — 60 screenshots, all HTTP 200, no page errors, no document-level overflow (desktop 1440 and mobile 390 widths).
- Final Playwright e2e rerun and production build were still in progress at the time of this entry; no pass/fail is claimed for them.

## 2026-11-16 — interim handoff snapshot (recorded by root; superseded by the following update)

- `pnpm exec vitest run tests/unit` — 7 files / 123 tests passed. Kept separate from the integration run below.
- `.agents-logs/final-integration.log` — `pnpm exec vitest run tests/integration` exit 0: 17 files / 267 tests passed in 152.43 seconds.
- `.agents-logs/final-e2e.log` — Playwright exit 0: 30 passed in 5.1 minutes, desktop 15/15 and mobile 15/15. Includes identity-resolution and shared-intake-link flows.
- `pnpm exec vitest run tests/integration/reconciliation.test.ts` — exit 0: 2/2. The actual CLI passes with active, withdrawn and trashed enrolments in its isolated test database; a broken withdrawn ledger still fails the CLI without data repair.
- `.agents-logs/migration-upgrade-test.log` — focused migration-upgrade check exit 0: 1/1.
- `.agents-logs/final-trace-audit.json` — `env: 0`, `private_storage: 0`, `agent_logs: 0`, `tests: 0`, `fixtures: 0`, after supported Next.js output tracing exclusions were added.
- Read-only `pnpm exec tsx scripts/reconcile.ts` against the developer database — exit 0: 61 stored ledgers audited across all statuses/Trash; 60 active, non-trashed enrolments compared to report balances and collection rate; no discrepancies. Global event and cash-history checks remain enabled.
- At this snapshot the build predated the PDF viewer edit and no combined Vitest result was available. The following final gate update supersedes this status.

## 2026-11-16 — earlier combined gate snapshot (superseded by current verification above)

- `.agents-logs/final-tests.log` — combined unit + integration command exit 0: 393/393 tests across 26 files in 175.60 seconds. This run includes the focused reconciliation and migration-upgrade cases; it supersedes the earlier separate snapshot counts above for current status.
- `.agents-logs/final-e2e.log` — Playwright exit 0: 30/30, desktop 15/15 and mobile 15/15, 5.1 minutes.
- After the combined run, fee-plan version creation received fresh authorization and idempotency-key checks; its focused integration file passed 19/19. Keep this separate; do not report 395 as a combined total.
- The earlier production build returned exit 0 before the fee-plan creation and PDF viewer changes. Rebuild is pending. The review PDF viewer's sandboxed native iframe had a page-navigation rendering defect; a source correction is being verified, so no current PDF-navigation pass is claimed in this entry.


## 2026-11-16 - final renderer and handoff verification (Codex)

- Combined unit/integration: 395/395 across 26 files, 205.65 seconds; `.agents-logs/final-tests.log`. Includes the later fee-plan creation checks; supersedes the earlier 393 snapshot.
- Full Playwright: 32/32, desktop 16/16 and mobile 16/16, 4.9 minutes, exit 0; `.agents-logs/final-e2e.log`. Real PDF uploads render red/blue pages with pixel assertions; previous/next, zoom, rotate, fit, browser errors and document overflow are checked. Programme links retain their fixed intake and ask only NIC.
- `pnpm build`: exit 0 after the final renderer source; `.agents-logs/final-build.log`. TypeScript passed within that build; separate `pnpm typecheck` also exited 0.
- `pnpm exec eslint src tests/e2e scripts/prepare-pdfjs.mjs`: exit 0 without warnings; `.agents-logs/final-lint.log`.
- Final deployment trace inspection: zero env, private storage, agent logs, tests or fixtures; `.agents-logs/final-trace-audit.json`. Next still emits its dynamic filesystem tracing warning; the actual resulting traces were inspected after the build.
- Production dependency audit against the official npm registry: exit 0, no known vulnerabilities.
- Desktop/mobile PDF screenshots inspected in `tests/e2e/.artifacts/results/review-pdf-*/pdf-review.png`; root preview HTTP 200 with no-store at http://localhost:3005/.
- Local/emulated verification does not certify physical-phone behavior or production infrastructure. Hosted Postgres/backup rehearsal, private cloud bucket/IAM/encryption, real ClamAV/signatures, deployed scheduler, HTTPS/secrets and external notification providers remain operator prerequisites documented in README and the setup runbooks.


## 2026-11-16 - post-decision archival, storage dashboard and hosting (Codex)

- Canonical combined unit/integration:428/428 across 30 files, exit 0,495.75 seconds; `.agents-logs/storage-final-tests.log`. Includes new schema/CLI migration, archival concurrency/recovery, snapshots/authorization and physical local/S3 inventory gates.
- Canonical Playwright:34/34 (17 desktop,17 mobile), exit 0,8.2 minutes; `.agents-logs/storage-final-e2e.log`. The new case measures actual local object storage through the rendered Super Admin dashboard, checks exact remaining budget math and no document overflow, then demotes the account and verifies the card disappears and refresh API returns 403. Screenshots in `tests/e2e/.artifacts/results/storage-capacity-*/storage-capacity.png`.
- Final `pnpm build` exit 0 with TypeScript passed; `.agents-logs/storage-final-build.log`. Scoped/full-src ESLint passed; `.agents-logs/storage-final-lint.log`.
- Storage boundary gate:6/6 across inventory unit and real ephemeral MinIO integration; `.agents-logs/inventory-tests.log`. Metadata pagination includes originals,previews,temporary files and zero-byte files; unavailable providers do not report free capacity.
- Direct TLS Neon connectivity verified against PostgreSQL 18.7. Empty public schema migrated through 0003; no synthetic students/staff/receipts copied. Local development database retained. Runtime Neon integration already existed in the Vercel project; application secrets and storage-budget configuration were added without committing values.
- Daily-only Vercel schedule validation and GitHub workflow YAML parsing passed. Matching GitHub/Vercel scheduler secret and production origin configured. Real scheduled executions are only verifiable after the new deployment is live.
- R2 bucket is not yet created; user chose to add credentials in Vercel. No claim of real Cloudflare upload/download/inventory validation. Existing S3-compatible behavior is verified against MinIO; private R2 remains an external configuration dependency.
- Lossless savings are measured, not assumed; typical JPEG/PDF files may already be compressed. Archive savings count only after verified physical original removal, following24 hour grace.
