# Scheduler and Storage Setup — T2T Student Operations System

How to configure the background scheduler and the private receipt storage for production.

> **Cross-check disclosure:** the source PDF was not available in the repository when this
> document was written. This guide is derived from `T2T_Coding_Agent_Master_Prompt.md` §3, §6,
> §12, §14 and from the code in this repository. §N references point at that prompt.

> **2026-11-16 refresh (source-checked):** the code side of this document is now **implemented** —
> daily `vercel.json` plus the authenticated background-job routes, the S3 storage adapter
> (`src/server/storage/s3.ts`), and the ClamAV INSTREAM malware-scanner client
> (`src/server/malware.ts`) all exist in the repository. What remains is **operator setup**:
> the real bucket, private-bucket hardening, IAM, encryption/versioning/backup, `CRON_SECRET`,
> and an actual (non-harness) scanner endpoint. Verified-so-far evidence is distinguished from
> operator work throughout.

**Implementation status (2026-11-16, re-checked against source):** the environment contract exists
(`src/server/env.ts`, `.env.example`), the job-run and lease tables exist (`job_runs`,
`job_leases`, `src/db/schema.ts:669,680`), and the file-validation pipeline exists
(`src/lib/files/validate.ts`). The cron routes, the S3 storage adapter, and the malware-scanner
adapter are **implemented**; earlier versions of this document stated "not implemented" — that is
historical. Operator setup (real bucket/credentials, deployed cron, a real scanner daemon) is
still pending and no production configuration has been verified.

---

## 1. The two production prerequisites

| Prerequisite | Why it is required | Status (2026-11-16) |
| --- | --- | --- |
| **A real scheduler** | Trash purge, orphan-upload cleanup, retry/escalation scheduling, stale-review escalation, notification delivery, exports, and reconciliation checks all need a trigger (§14) | **Code done** — `vercel.json` and the five `/api/cron/*` routes exist (`src/app/api/cron/{exports,followups,outbox,uploads-cleanup,purge}/route.ts`). Deployed cron + `CRON_SECRET` remain operator setup |
| **Private object storage** | Receipts are private evidence; they must not be publicly readable (§3, §15) | **Code done** — `STORAGE_DRIVER=s3` selects a real S3 adapter (`src/server/storage/s3.ts`; verified 20/20 against an ephemeral MinIO + unit checks). Bucket creation, public-block, IAM, encryption and backups remain operator setup |

Nothing in this system depends on a process-local timer surviving a serverless shutdown (§14).
A missed job must catch up safely, and date-derived eligibility must stay correct without any
job running at all.

---

## 2. Scheduler

### 2.1 Transport

All scheduler calls are authenticated with a shared secret:

```
Authorization: Bearer $CRON_SECRET
```

| Item | Value |
| --- | --- |
| Env var | `CRON_SECRET` (`src/server/env.ts:9`, optional in the schema, minimum 16 characters) |
| Header | `Authorization: Bearer <CRON_SECRET>` |
| Comparison | Constant-time (`safeEqual()`, `src/lib/crypto.ts:50`) — never a plain string compare |
| Failure response | `401` with no body detail |
| Rotation | Change the value in the project environment and redeploy — see `docs/backup-restore-runbook.md` §5.3.4 |

**Vercel Cron** sends this header automatically when `CRON_SECRET` is defined as a project
environment variable. When calling the routes by hand (a drill, a one-off catch-up), send the
header explicitly.

### 2.2 Hobby-compatible schedules

Vercel Hobby accepts daily schedules only. `vercel.json` now contains only these daily jobs; frequent work uses `.github/workflows/background-jobs.yml` instead.

| Route | Scheduler | Cadence (UTC) | Work |
|---|---|---|---|
| `/api/cron/exports` | GitHub Actions | `2-57/5 * * * *` | Generate queued private CSV exports and remove expired export files |
| `/api/cron/followups` | GitHub Actions | same | Bounded durable collection/promise/escalation work; local contact window still enforced |
| `/api/cron/outbox` | GitHub Actions | same | Portal delivery accounting; external channels remain disabled |
| `/api/cron/uploads-cleanup` | Vercel | `15 20 * * *` | Abandoned uploads after their grace period |
| `/api/cron/purge` | Vercel | `30 20 * * *` | Eligible Trash cleanup preserving history |
| `/api/cron/storage` | Vercel | `45 20 * * *` | Up to four archival batches of 25, recovery-copy cleanup and actual storage inventory |

All calls require `Authorization: Bearer <CRON_SECRET>`. The GitHub repository variable `T2T_CRON_BASE_URL` is the production HTTPS origin; the repository secret `CRON_SECRET` must match the Vercel project secret. The workflow has no checkout or repository permissions and logs only job names/statuses. It can also be manually dispatched for a catch-up.

GitHub scheduled workflows are best effort and can be delayed or disabled after repository inactivity; they are not a precise five-minute service guarantee. Monitor workflow runs and job_runs, and manually dispatch after downtime. Daily Vercel jobs also have Hobby timing imprecision. Domain state is authoritative; durable jobs safely catch up on later invocations. Frequent invocations also consume Neon/Vercel resources independently of R2 quotas.

### 2.3 `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/uploads-cleanup", "schedule": "15 20 * * *" },
    { "path": "/api/cron/purge", "schedule": "30 20 * * *" },
    { "path": "/api/cron/storage", "schedule": "45 20 * * *" }
  ]
}
```

Cloudflare and Neon keys remain server-side secrets. Never place credentials in this file, workflow YAML, GitHub variables or documentation.

### 2.4 Route contract

Every cron route follows the same shape:

```
GET /api/cron/<job>
Authorization: Bearer $CRON_SECRET
```

| Response | Meaning |
| --- | --- |
| `200` with a JSON summary | The job ran. The summary lists what was processed. |
| `401` | Missing or wrong `CRON_SECRET`. |
| `409` | Another instance holds the job lease. The job is already running; the caller should back off, not retry immediately. |
| `500` | The job failed. The failure is recorded in `job_runs` and is visible to operators. |

Suggested JSON summary shape:

```json
{
  "job": "followups",
  "runId": "<job_runs.id>",
  "processed": 42,
  "skipped": 3,
  "failed": 0,
  "durationMs": 812,
  "details": { "tasksCreated": 7, "escalations": 1, "staleReviews": 2 }
}
```

### 2.5 Required behaviour for every cron route

| Requirement | Implementation guidance |
| --- | --- |
| **Lease before work** | Take a lease row in `job_leases` (primary key `job`) so two concurrent invocations cannot process the same work. Return `409` when the lease is held. |
| **Bounded batches** | Process a bounded number of records per run and return; the next run continues. Never scan the whole table in one request. |
| **Idempotency** | Re-running a job must not duplicate tasks, notifications, or payments. `follow_up_tasks.dedupe_key` is unique (`src/db/schema.ts:539`); `notifications.dedupe_key` is unique (`:650`); `outbox_events.dedupe_key` is unique (`:667`). |
| **Record the run** | One `job_runs` row per invocation: `job`, `status`, `started_at`, `finished_at`, `processed`, `error`, `details` (`src/db/schema.ts:669`). A failed job must be visible, not swallowed. |
| **Safe catch-up** | A missed run catches up on the next invocation. Date-derived eligibility (overdue, due today) is computed from the business date at read time, so it is correct even if no job has run for a day. |
| **Re-check state inside the transaction** | Eligibility is re-evaluated inside the transaction, not only when the queue was built. A payment approved since the queue was built removes the call task. |
| **No user-visible side effects from tests** | No live email or SMS may be sent by a test or a development run. |

### 2.6 What each job must and must not do

**`/api/cron/followups`**

- Creates at most **one** scheduled collection attempt per enrolment per business day
  (dedupe key `COLLECTION_CALL:<enrolment>:<yyyy-mm-dd>`).
- After **three** consecutive `NO_ANSWER` outcomes, creates an escalation task and pauses
  automatic retries pending staff action.
- Raises a `STALE_REVIEW` task for evidence pending for **48 hours** — it does not treat the
  payment as rejected.
- Suspends tasks for withdrawn, inactive, trashed, paid, or fully exempt enrolments.
- Does not remove financial history.

**`/api/cron/purge`**

- Only purges records whose `purge_after` (trashed_at + 30 days) has **passed**. Restore is
  available strictly before that instant, even if the cleanup worker is delayed.
- Leaves **tombstones** with immutable IDs and minimal historical labels.
- Never cascades into payments, enrolments, students, receipts, reviews, call attempts, or audit
  events — those tables use `onDelete: "restrict"`.
- Checks object references before deleting media: a banner or file still referenced by any
  active or historical record survives.
- Claims due records transactionally, marks the purge state, and retries external object
  deletion idempotently. **It must not report a complete purge while external deletion
  failed.**

**`/api/cron/uploads-cleanup`**

- Deletes only upload intents past their expiry and the grace period, and objects that are not
  attached to any submission.
- **Never** touches evidence attached to a submission.
- Never deletes a `receipt_assets` row that a `payment_submissions` row references.

**`/api/cron/outbox`**

- Delivers pending `outbox_events` rows to the configured channel.
- The **default channel is the in-portal inbox**, and the portal notification is already
  written in the business transaction (`notify()`, `src/server/audit.ts:44`). This job only
  handles the optional outbound adapters.
- Email and SMS adapters require configured credentials **and** an operator-enabled channel
  (`EMAIL_ENABLED`, `SMS_ENABLED`). No fabricated delivery, no unsolicited live sends, and
  **never an OTP**.
- Excludes raw NIC and receipt contents from outbound messages.
- Retries with backoff and records the attempt count and last error.

### 2.7 Running a job by hand (a drill or a catch-up)

```bash
curl -sS -X GET http://localhost:3000/api/cron/followups \
  -H "Authorization: Bearer $CRON_SECRET"
```

In production, call the production deployment URL. Because the schedule is in UTC and the
eligibility rules use `Asia/Colombo`, a hand-run job at an unusual local time may legitimately
do nothing (for example, outside the 09:00–17:00 contact window) — that is correct behaviour,
not a failure.

### 2.8 If Vercel Cron is not used

The contract above is scheduler-agnostic. Any scheduler that can make an HTTPS request with a
custom `Authorization` header works — a platform cron, an external cron service, a container
scheduler, or a GitHub Actions schedule. The requirements stay the same: authenticated
invocation, a lease, bounded batches, idempotency, visible failures, and safe catch-up.

---

## 3. Private object storage

### 3.1 Driver selection

| Env var | Values | Meaning |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` \| `s3` | Default `local`. In production the `local` driver throws unless `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true` (`src/server/storage.ts:54`) |
| `LOCAL_STORAGE_DIR` | path | Default `./.private-storage` (dev only) |
| `S3_ENDPOINT` | URL | Optional. S3-compatible endpoint (AWS S3, Cloudflare R2, MinIO, Backblaze B2, …). Must be an HTTP(S) URL without credentials/query/fragment; **HTTPS required in production** |
| `S3_REGION` | string | Required for `s3` |
| `S3_BUCKET` | string | Required for `s3` |
| `S3_ACCESS_KEY_ID` | string | Required for `s3` |
| `S3_SECRET_ACCESS_KEY` | string | Required for `s3` |
| `S3_FORCE_PATH_STYLE` | `true` \| `false` | Optional. Defaults to `true` when a custom `S3_ENDPOINT` is set, `false` otherwise |
| `S3_SESSION_TOKEN` | string | Optional. Adds a temporary STS session token to the credentials |

Source: `src/server/storage/s3.ts:54-78` (checked 2026-11-16). The adapter implements
put/get/exists/delete with no ACL header (compatible with bucket-owner-enforced buckets) and
never creates public URLs. It is marked `productionReady = true`; the `local` adapter is
development-only. Scope validation recorded 2026-11-16: `tests/unit/storage.test.ts` +
`tests/integration/storage-s3.test.ts` — 20/20 passed against a real dedicated ephemeral MinIO
(private anonymous 403, round-trips, idempotent deletion, auth/network/bucket errors, unsafe
keys, production local guard). No production bucket or credentials have been configured or
verified — that remains operator setup.

### 3.2 The `local` driver is DEVELOPMENT ONLY

> **The `local` driver writes to a directory on the machine's disk. It is not durable across
> deployments, it is not shared between instances, and it is not backed up by the storage
> backup procedure in `docs/backup-restore-runbook.md`. Use it for local development and
> nothing else.** In production the adapter now enforces this in code: it throws unless
> `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true` (`src/server/storage.ts:54`).

| Check | Required for `local` |
| --- | --- |
| The directory sits **outside** `public/` so files can never be served statically | **Yes** — `./.private-storage` is the default and is already in `.gitignore` |
| The directory is not committed to the repository | **Yes** — `.gitignore` already lists `.private-storage/` |
| The UI shows the driver as "development only" | **Yes** — the staff UI must state that receipts are stored on a local disk |
| Receipt access still goes through an authenticated route | **Yes** — never a direct file path |

**Production must set `STORAGE_DRIVER=s3`.** If production is ever observed running the local
driver, treat it as an incident: the receipt store is not durable and is not backed up.

### 3.3 S3 bucket setup checklist

The bucket must be **private**. Public receipt URLs are explicitly forbidden (§18: do not claim
production readiness while using "public receipt URLs").

| # | Requirement | How | Why |
| --- | --- | --- | --- |
| 1 | **No public access at all** | Block all public access at the bucket level; keep "Object ownership → Bucket owner enforced"; ACLs disabled | A public bucket exposes every receipt to anyone with the key |
| 2 | **No public ACL on any object** | Never grant `public-read`; let the bucket policy govern | Defence in depth against a mis-set per-object ACL |
| 3 | **Block public access** | Enable "Block all public access" on the bucket and the account | Prevents a policy mistake from becoming a disclosure |
| 4 | **Encryption at rest** | SSE-S3 or SSE-KMS (or the provider's equivalent) | §15 |
| 5 | **Encryption in transit** | HTTPS only; the provider's TLS requirement | §15 |
| 6 | **Versioning** | Enable object versioning | Allows recovery of a deleted or overwritten receipt |
| 7 | **Replication / backup** | Cross-region or cross-account replication to a second private bucket | `docs/backup-restore-runbook.md` §4 |
| 8 | **Least-privilege credentials** | A dedicated key limited to `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on this bucket only; no `s3:*` on `*` | Limits the blast radius of a leaked credential |
| 9 | **No credentials in the client** | The browser never receives the bucket credentials | A public browser credential is a public bucket |
| 10 | **Access logging** | Enable bucket access logs for audit | Detects unusual access patterns |

### 3.4 Object keys

| Rule | Detail |
| --- | --- |
| Randomness | The object key is a random value (`upload_intents.object_key` and `receipt_assets.object_key` are unique, `src/db/schema.ts:393,412`). Never derive it from the student reference, the name, or the NIC. |
| No personal data in the key | A key that contains a NIC or a name leaks into bucket listings, logs, and backups. |
| Environment prefix | **Proposed:** prefix keys with the environment (`prod/…`, `staging/…`) so a bucket is never shared across environments by accident. |
| Stable layout | The prefix layout must be stable, because the backup tooling in `docs/backup-restore-runbook.md` §4 mirrors it. |

### 3.5 Upload path

The flow is **upload intent → private object upload → server finalization** (§6):

1. The client asks for an upload intent. The server creates a row bound to the enrolment, the
   size limit, an expiry, and a random object key.
2. The client uploads the bytes. Two shapes are possible:
   - **Server-proxy (recommended for the first release):** the bytes stream through the server,
     which can run magic-byte checks, decoding, dimension checks, PDF parsing, hashing, and
     quarantine in one place. No bucket CORS configuration is needed and the credentials never
     leave the server.
   - **Presigned direct upload:** the client PUTs straight to the bucket with a short-lived
     presigned URL. This reduces server load but **requires** bucket CORS configuration and a
     finalization step that re-verifies the object's ownership, size, type, and hash before it
     can be attached. The browser must never be able to attach another enrolment's object.
3. The server finalizes: it verifies the object exists, re-runs validation, records the asset
   (`receipt_assets`, including `sha256`, `mime`, `size_bytes`, dimensions or page count,
   `validation`, `scan`), and only then attaches it to a submission.
4. The submission is written in a transaction, and the UI shows "submitted" only after that
   transaction commits.

### 3.6 Receipt delivery

| Rule | Detail |
| --- | --- |
| Authenticated route | Receipts are served through an authenticated delivery route that **re-checks the current scope** at delivery time (§15). |
| No durable links | If signed object URLs are used internally, they must be short-lived. A durable URL in a log, a referrer header, or a browser history is a disclosure. |
| No token leakage | Access tokens must not appear in URLs, referrers, or logs (§15). |
| Caching | Receipt responses are `Cache-Control: private, no-store` (`PRIVATE_HEADERS`, `src/server/http.ts:43`). Receipts must never be cached by the CDN, the service worker, or the browser (§14). |
| Preview derivatives | Previews are sanitized, generated server-side, and stored as separate objects (`receipt_assets.preview_key`, `src/db/schema.ts:400`). |

---

## 4. Malware scanner adapter

### 4.1 Contract

**Current status (2026-11-16):** the adapter is implemented in `src/server/malware.ts`. It speaks
the real ClamAV clamd `zINSTREAM` protocol over TCP: sends `zINSTREAM\0`, streams the bytes in
64 KiB length-prefixed chunks, ends with a zero-length chunk, and requires an exact complete
`stream: OK` reply for CLEAN; a `stream: … FOUND` reply maps to INFECTED; every other reply,
timeout, transport error or oversized reply is a `MalwareScanError` (treated as unavailable —
failure closed). No filenames or paths are ever sent.

| Env var | Values / default | Meaning (actual defaults from `src/server/malware.ts:18-30`) |
| --- | --- | --- |
| `MALWARE_SCANNER` | `none` \| `clamav` (default `none`) | `none` → no scanning; `clamav` → clamd TCP client |
| `CLAMAV_HOST` | default `127.0.0.1` | IP address or hostname of the clamd endpoint |
| `CLAMAV_PORT` | default `3310` (range 1–65535) | clamd TCP port |
| `CLAMAV_TIMEOUT_MS` | default `10000` (range 50–60000) | Absolute deadline covering connect, upload, daemon scan and response |
| `CLAMAV_MAX_BYTES` | default falls back to `RECEIPT_MAX_BYTES`, else `10485760` (10 MiB; range 1–100 MiB) | Rejects scan payloads above the limit with a LIMIT error |

The TCP connection must stay on a trusted private network: clamd provides no TLS or
authentication (`src/server/malware.ts:37-40`).

**What has been verified vs what has not (be honest):** the INSTREAM client is exercised by
`tests/unit/malware.test.ts` and `tests/integration/malware.test.ts` against a **local mock clamd
server (a protocol harness on 127.0.0.1)** — the wire protocol, CLEAN/INFECTED/unavailable
mappings and failure-closed behaviour are verified there (55 focused scanner tests passed at
root level on 2026-11-16, followed by 23 upload/malware integration tests; these are included
within, not additive to, the consolidated integration baseline). **No real daemon or hosted
scanner has been connected or verified.** Pointing `MALWARE_SCANNER=clamav` at a real clamd
endpoint is operator setup, not yet done.

| `scan_status` value | Meaning |
| --- | --- |
| `NOT_CONFIGURED` | No scanner is configured (`MALWARE_SCANNER=none` or unset). The file was validated for type, size, dimensions, and decodability — **but not scanned for malware**. Stored on assets and surfaced in the review UI. |
| `PENDING` | Defined in the `scan_status` enum (`src/db/schema.ts:40`) but the current finalization flow never persists it — the scan completes before the asset row is written. |
| `CLEAN` | The scanner reported no threats. |
| `INFECTED` | The scanner reported a threat. The object is deleted, the intent is marked `CLEANED`, the event is audited (`receipt.malware_rejected`), and the submission is refused. |
| `ERROR` | Defined in the enum but never persisted by the current flow: a scanner failure fails the finalization request instead (see §4.2). |

`receipt_assets.scan` (`src/db/schema.ts:408`) stores the status; its default is `NOT_CONFIGURED`.

### 4.2 Honest status — the rule

> **The configured scanner status must be visible to operators exactly as it is.** Never present
> an unscanned file as clean, and never present `NOT_CONFIGURED` as "safe" (§6: "support a
> malware scanner adapter with its actual configured status visible to operators").

| Situation | What the UI shows |
| --- | --- |
| `MALWARE_SCANNER=none` (the default) | "Malware scanning is **not configured**. Files are type-checked and quarantined until validation completes." (`scannerStatus()` returns `NOT_CONFIGURED`; the review workspace renders it verbatim, `review-workspace.tsx:318`) |
| `MALWARE_SCANNER=clamav` and the scan passed | "Scanned — clean." |
| `MALWARE_SCANNER=clamav` and the scan failed to run | The submission finalization **fails closed**: the request returns **503 `DEPENDENCY_UNAVAILABLE`** ("Receipt safety checks are unavailable…", `submissions.ts:114-118`, `http.ts:13`) and no asset is attached. A configured-but-failed scan is **never recorded as clean or not-clean**. |

**Historical note (preserved):** an earlier revision said "the clamav adapter is not implemented
in this repository — do not set `MALWARE_SCANNER=clamav`". The adapter now exists (see §4.1);
the caution that remains is: do not point it at a production clamd endpoint before an operator
verifies that endpoint, since only the local protocol harness has been exercised so far.

**Downstream gates (current behaviour):** student submission finalization runs the scan and
fails closed on scanner errors; staff approval additionally refuses any asset whose stored
`scan` is not `CLEAN` or `NOT_CONFIGURED` (`src/server/services/review.ts:88`, and the
replacement path at `review.ts:232`).

### 4.3 Quarantine

Regardless of the scanner, an uploaded file starts in `QUARANTINED` validation state
(`src/db/schema.ts:407`) and is only promoted to `CLEAN` after validation (and scanning, if
configured) passes. Uploaded content is never executed, and PDF rendering is isolated.

---

## 5. Verification checklist

Run this before going live and after any change to the scheduler or storage configuration.

### Scheduler

- [ ] `vercel.json` exists with the five cron paths and schedules the plan supports (it does, as committed).
- [ ] `CRON_SECRET` is set in the production environment and is at least 16 characters.
- [ ] A request with **no** header returns `401`.
- [ ] A request with a **wrong** header returns `401`.
- [ ] A request with the correct header returns `200` with a JSON summary.
- [ ] Two concurrent requests for the same job produce one run and one `409`.
- [ ] Each job has written a `job_runs` row with `status`, `processed`, and `details`.
- [ ] Running a job twice produces no duplicate tasks, notifications, or outbox rows.
- [ ] A missed run catches up safely on the next invocation.

### Storage

- [ ] `STORAGE_DRIVER=s3` in production.
- [ ] The bucket blocks all public access; an unauthenticated GET of a known object key fails.
- [ ] A receipt opens through the authenticated delivery route for a staff member **with** scope.
- [ ] The same route returns `404` (not `403`) for a staff member **without** scope.
- [ ] No receipt URL is durable: a signed URL, if used, expires quickly.
- [ ] An abandoned upload is cleaned by the cleanup job; an attached receipt is not.

### Scanner

- [ ] The operator-facing scan status matches the configured scanner — `NOT_CONFIGURED` when no
      scanner is configured; a configured scanner that cannot be reached fails the upload
      finalization with `503 DEPENDENCY_UNAVAILABLE` (never recorded as clean).
- [ ] If `MALWARE_SCANNER=clamav`, the endpoint is a **real clamd the operator has verified** —
      the repository evidence covers only a local TCP protocol harness, not a production daemon.

---

## 6. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Cron returns `401` in production | `CRON_SECRET` is not set on the project, or the app and the scheduler disagree | Set the same value in both; redeploy. Vercel Cron reads the project's `CRON_SECRET`. |
| Cron returns `409` repeatedly | A previous run's lease was never released (for example, the instance was killed) | The lease must expire; confirm `job_leases.expires_at` is in the future and that the lease is released on completion. |
| A job "does nothing" at an odd local time | Correct behaviour: outside the 09:00–17:00 Colombo window, or on a holiday in `business_holidays` | Check the business-date window and the holiday table before treating it as a bug. |
| Receipts 404 in production | The `s3` driver is not configured, or the object key prefix differs between environments | Check `STORAGE_DRIVER` and the bucket prefix. |
| A receipt is publicly readable | The bucket or object ACL allows public access | **Incident.** Remove the public grant immediately, then audit `access_logs` for who fetched it. |
| A purge job reports success but objects remain | External deletion failed while the record was marked purged | The job must not claim a complete purge while external deletion failed; check `purge_status` and the job's `details`. |
| Uploads vanish after a redeploy | The `local` driver is in use | Expected — the local driver is development only. Move to the `s3` driver. |

---

## 7. Cross-references

| Document | Relevance |
| --- | --- |
| `docs/backup-restore-runbook.md` | Backing up and restoring the receipt objects; key escrow and rotation |
| `docs/nic-entry-risk.md` | What a public or leaked object store exposes |
| `docs/finance-rules.md` | The ledger the reconciliation job and the report totals depend on |
| `docs/import-cutover-guide.md` | Reconciliation before and after a cutover |
| `docs/assumptions.md` | Every configurable default referenced here (retries, escalations, grace periods) |


## 8. Neon, R2 capacity and 30-day archival

- Runtime uses the pooled Neon `DATABASE_URL` (`prepare:false`); migrations prefer `DATABASE_URL_UNPOOLED`, with fallback to `DATABASE_URL`. For private local cloud configuration, use `node --env-file=.env.neon.local --import tsx scripts/migrate.ts`. Never put URLs with passwords in shell arguments or commit the private file.
- On 2026-11-16 the previously empty user-provided Neon database was migrated through 0003 using the direct TLS connection. Hosted PostgreSQL reported18.7. Synthetic developer students, receipts and staff were not copied. Bootstrap the first production Super Admin using the README instructions and private production keys.
- Create a private Standard-class R2 bucket, e.g. `trace-student-receipts`, with public development URLs/custom-domain access disabled. Create an R2 S3 token scoped to that bucket with Object Read & Write and object-list permissions. Configure `STORAGE_DRIVER=s3`, `S3_REGION=auto`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. The current provider setup is incomplete until the bucket/credentials exist; Cloudflare CLI is not authenticated on this machine.
- `STORAGE_BUDGET_BYTES=10000000000` is a configurable app-bucket budget, not Cloudflare account billing telemetry. Super Admin dashboard snapshots list all actual physical object metadata, including previews, unfinished uploads, export files and both copies during archival grace. Ordinary Admins cannot access these global totals. Refresh uses an idempotency key, current authorization and a concurrency lock; unknown/provider-failed usage never displays as zero.
- Each receipt is considered at least 30 elapsed days after every linked approval/rejection. Pending, reopened, young, quarantined, scan-error and placeholder receipts are excluded. Gzip is retained only when smaller; already compressed JPEG/WebP/PDF files may save very little. No fixed savings ratio is promised.
- The worker verifies exact original size/SHA-256 before compression and verifies stored gzip by bounded decompression and matching the original checksum before changing the DB pointer. Original logical size/hash/MIME, decisions and financial history stay unchanged. Protected staff/student routes transparently recover exact original bytes.
- Original physical bytes remain for 24 hours after archival, then are deleted only after another successful archive verification and reference check. Failures retain recoverable state; unique temporary objects and persisted staging records support crash recovery. Dashboard savings count only size differences after confirmed original deletion; actual inventory may temporarily increase while both copies exist.
- Default receipt limit10 MiB is within the20 MiB archival safety bound. Increasing upload limits above20 MiB requires separate consideration; oversized files remain intact and are not archived automatically.
- Sizing assumption:500-750 students, maximum 1000. Measure actual originals plus previews; storage retention accumulates and the budget is not a fresh10 GB upload allowance every month.
