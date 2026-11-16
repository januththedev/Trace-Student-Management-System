# T2T Student Operations System

T2T manages people, programme enrolments, fee schedules, manual bank-payment receipts, staff reviews and collection follow-ups in PostgreSQL. Students enter with NIC + a concrete programme/intake; staff use scoped sessions with exactly two roles, Admin and Super Admin. This is an operations application, not an LMS or payment gateway.

Stack: Next.js 16 App Router, React 19, strict TypeScript, Tailwind v4, Drizzle ORM + postgres-js, PostgreSQL 17, Vitest and Playwright. Money is integer LKR minor units; business dates use Asia/Colombo. [Requirements](T2T_Coding_Agent_Master_Prompt.md) are authoritative. The referenced source proposal PDF was unavailable and has not been cross-checked.

## Local setup

Install Node.js compatible with the pinned Next release (Node 22 LTS or newer), pnpm 11.5.1, Docker Desktop with Linux containers and Git.

```powershell
pnpm install --frozen-lockfile
docker run --name t2t-postgres -e POSTGRES_USER=t2t -e POSTGRES_PASSWORD=t2t_dev_password -e POSTGRES_DB=t2t -p 55432:5432 -v t2t-postgres-data:/var/lib/postgresql/data -d postgres:17
docker exec t2t-postgres psql -U t2t -d postgres -c "CREATE DATABASE t2t_test;"
Copy-Item .env.example .env
```

If the named container already exists, use `docker start t2t-postgres`. Existing databases do not need another CREATE DATABASE. The password above is for disposable local development only.

Edit `.env`: verify `DATABASE_URL` and `TEST_DATABASE_URL`. Generate a **different** random 32-byte base64 value for each of `NIC_ENCRYPTION_KEY`, `NIC_LOOKUP_KEY`, `SESSION_SECRET` and `CRON_SECRET`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
pnpm exec tsx scripts/migrate.ts
```

Keep `.env` and the private receipt directory out of Git and web serving. Existing encrypted NICs require the original keys; do not regenerate them casually after importing data. `.env.example` documents storage, receipt limits, session expiry, disabled outbound channels and `APP_BASE_URL`.

On a new operator database bootstrap the first Super Admin once, with a private password of at least 12 characters:

```powershell
$env:T2T_BOOTSTRAP_PASSWORD = 'replace-with-your-private-password'
node --conditions=react-server --import tsx scripts/bootstrap-super-admin.ts --email operator@example.test --name "Local Operator"
Remove-Item Env:T2T_BOOTSTRAP_PASSWORD
```

For a synthetic demo, **seed instead of bootstrapping**: the seed creates its own accounts. `--reset` discards all public-table development data except the governance singleton and resets its bootstrap marker. Production mode always refuses seeding, including resets. Old stored receipt objects are not recursively removed by reset.

```powershell
$env:T2T_SEED_PASSWORD = 'replace-with-your-development-password'
pnpm seed
# Rebuild an existing disposable demo database:
pnpm seed --reset
pnpm dev
```

Open `http://localhost:3000` and `/staff/login`. Accounts: `superadmin@t2t.example.test` and `admin@t2t.example.test`. The Admin sees Software Engineering only and holds `exports.download` and `exemptions.manage`. If `T2T_SEED_PASSWORD` is absent, the seed warns and uses `T2T-development-only!`. Never use this default outside a local demo.

The seed creates 4 branded programmes, 9 intakes, 60 people, 61 enrolments and six monthly instalments per enrolment from October 2026 through March 2027. Fixtures include settled/partial/overdue accounts, validated receipts, rejection/replacement history, overpayment credit and credit application, free-card/sponsorship waivers, withdrawal, open/broken promises, no-answer attempts, accepted/pending admissions and an intake in Trash. The fixture clock is 2026-11-15 inside the script; the app uses its normal clock. All names, contacts and identifiers are synthetic. NIC syntax does not certify that an identifier is unassigned in the real world. No external messages or calls are sent.

| Synthetic NIC | Programme | Intake |
|---|---|---|
| `990010001V` | Software Engineering | Demo 1 · Oct 2026 |
| `199900100002` | Software Engineering | Demo 2 · Oct 2026 |
| `990010003V` | Business Management | Demo 1 · Oct 2026 |
| `990010005V` | Graphic Design | Demo 1 · Oct 2026 |

The first person also has a Business Management enrolment in Demo 2. The seed prints further login pairs after verifying the ledgers.

## Verification

```powershell
pnpm exec vitest run tests/unit
pnpm exec vitest run tests/integration/finance-fixtures.test.ts
pnpm exec vitest run tests/integration/reports.test.ts
pnpm exec vitest run tests/integration/followups.test.ts
pnpm test:int
pnpm exec tsc --noEmit
pnpm lint
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Integration helpers create/migrate a real disposable Postgres database per test filename (`t2t_test_<file>`) and truncate it in `beforeEach`; the role needs CREATE DATABASE. They do not wipe the demo database. Different files have separate databases, but **concurrent invocations of the same file share its database** and can interfere. Coordinate those runs across agents/CI jobs. Browser setup and isolated database/storage configuration are in `playwright.config.ts` and `tests/e2e`. Commands above are instructions, not claims of passing results; see [actual verification](docs/test-results.md).

Read-only financial reconciliation:

```powershell
node --conditions=react-server --import tsx scripts/reconcile.ts
```

## Performance database

Use a new, migrated database. Bulk seeding refuses the development database (including localhost aliases), non-`_perf` names, existing student/staff data and production mode; it never resets data. Fixtures bypass services but respect SQL constraints, money invariants and attribution. Submissions are labelled synthetic historical imports with missing evidence, not usable uploaded receipts.

```powershell
docker exec t2t-postgres psql -U t2t -d postgres -c "CREATE DATABASE t2t_perf;"
pnpm exec tsx scripts/migrate.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf
node --conditions=react-server --import tsx scripts/seed-perf.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf
node --conditions=react-server --import tsx scripts/perf-check.ts --url postgres://t2t:t2t_dev_password@127.0.0.1:55432/t2t_perf
```

Dataset: 10,000 students, 10,000 enrolments, 60,000 instalments, 10,000 submissions, 5,000 payment events and 7,500 allocations. The benchmark measures 20 sequential warm runs per operation and prints p50/p95/max, machine details and the sub-second target result. It checks 50 ledgers, pending reviews, Super/scoped Admin metrics and the call queue. This is not a concurrent production load test.

## Jobs and production prerequisites

Cron calls require `Authorization: Bearer <CRON_SECRET>`. Responses are private/no-store.

| Endpoint | Methods at this snapshot | Work |
|---|---|---|
| `/api/cron/followups` | GET, POST | Bounded collection/promise/stale-review work; persistent cursors and lease |
| `/api/cron/outbox` | GET | Portal delivery accounting; other channels skipped |
| `/api/cron/exports` | GET | Bounded private CSV generation and expired-file cleanup |
| `/api/cron/uploads-cleanup` | GET | Expired abandoned uploads after a 24-hour grace |
| `/api/cron/purge` | GET, POST | 30-day Trash cleanup preserving financial history |
| `/api/cron/storage` | GET | 30-day post-decision lossless archival, recovery cleanup and storage measurement |

`vercel.json` now uses only daily, Hobby-compatible upload cleanup, Trash purge and storage/archive jobs. Frequent exports/follow-ups/outbox work uses the authenticated GitHub Actions workflow. Configure repository variable `T2T_CRON_BASE_URL` and matching secret `CRON_SECRET`; schedules are best effort. See [scheduler and R2 setup](docs/scheduler-storage-setup.md).

Production is incomplete:

- The provided empty Neon database was migrated through 0003 with direct TLS on 2026-11-16; pooled runtime/direct migration connections are supported. No synthetic development records were copied. First Super Admin bootstrap, backup/restore rehearsal and key recovery remain operator setup.
- Local storage is development-only and normally refuses production. An S3-compatible adapter is implemented and was verified against an ephemeral MinIO service. Configure `STORAGE_DRIVER=s3` and provision the private bucket, least-privilege credentials, public-access blocking, encryption, versioning and backups before production; no production bucket or credentials were configured here.
- File magic/decode/size validation and sanitized image previews work. The ClamAV `zINSTREAM` client is implemented and fails closed when a configured scanner is unavailable; `MALWARE_SCANNER=none` remains visibly `NOT_CONFIGURED`. A real ClamAV daemon, signatures and private network connection remain operator setup and have not been verified.
- Staff PDF evidence is rendered in an app-owned canvas viewer with pinned, self-hosted PDF.js 6.5.438 assets. `postinstall` and `build` run `scripts/prepare-pdfjs.mjs`; no worker, fonts, maps, WASM or ICC assets are fetched from a CDN. The original evidence endpoint retains the strict sandbox CSP.
- Email/SMS transport is disabled/unimplemented. Portal notifications are transactional. Outbox bookkeeping does not prove external delivery.
- Background exports are available through POST `/api/staff/exports` with an idempotency key, authenticated GET polling/download at `/api/staff/exports/[id]`, and the cron worker above. Generated files expire after 15 minutes; the original `/api/staff/reports/export` endpoint remains synchronous. Generation still assembles CSV in memory. Verify the deployed worker, large-file limits and storage behavior; deployed CDN inspection, full provider-failure coverage and monitoring remain gaps. See [API contracts](docs/api-contracts.md) and [traceability](docs/traceability.md).
- Complete browser acceptance, production build/lint, HTTPS, secure cookies, private secrets and least-privilege DB/storage configuration before release.

Staff can copy or open a public intake-specific entry link from **Programmes**. The link shows only its fixed programme/intake and asks for a NIC; remembered-course state cannot switch it to another intake. Links are available only for active, public, non-trashed intakes and programmes. Invalid links show the same unavailable page, and an ineligible NIC receives the neutral eligibility message.

NIC + intake entry intentionally allows impersonation by someone who knows both. Encryption, rate limits and scoped sessions reduce exposure but do not verify identity. Read the [NIC-entry risk](docs/nic-entry-risk.md); the required flow has no OTP/student password.

Latest local verification: 428/428 unit/integration tests across 30 files, 34/34 Playwright cases (17 desktop,17 mobile), final production build/TypeScript and lint passed after archival/capacity changes. See [test results](docs/test-results.md). Neon schema migration is verified; actual R2 access awaits the bucket credentials.

Documentation: [architecture](docs/architecture.md), [API contracts](docs/api-contracts.md), [traceability](docs/traceability.md), [finance](docs/finance-rules.md), [permissions](docs/permission-matrix.md), [scheduler/storage](docs/scheduler-storage-setup.md), [backup/restore](docs/backup-restore-runbook.md), [import/cutover](docs/import-cutover-guide.md), [assumptions](docs/assumptions.md).


Super Admin dashboards show measured app storage used/remaining against `STORAGE_BUDGET_BYTES` (default10 GB), last check time, file count and actual archival savings. Approved/rejected evidence is eligible for lossless compression after 30 days; the original checksum and exact recoverable bytes remain unchanged. Already compressed files may save little. R2 bucket creation and credentials are still required; usage is not fabricated while unconfigured.
