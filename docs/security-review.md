# Security and authorization acceptance review

- Reviewer: Codex-F, 2026-11-15.
- Requirements: master prompt sections 4, 5, 14, 15; acceptance scenarios 10, 12, 21, 22 (export injection), and the type-check portion of 24.
- Method: read every API route and service listed below, trace shared authentication/HTTP/audit/ledger helpers, and exercise services against isolated real PostgreSQL databases. Storage tests use real synthetic local objects. No external messages are sent; no application source is modified by this lane.
- Verdict: changes requested. Ordinary scope checks work across the tested surfaces, but the findings below prevent a clean security acceptance.

## Findings

File and line references identify the audited implementation; other agents are editing these files concurrently. Each finding has an executable reproduction in the two owned integration suites and a precise append-only handoff in `docs/agent-requests.md`. A remaining defect is marked `it.fails` with its finding number. This means the test verifies a known failure; it does **not** mean the security requirement passes.

| ID | Severity | Source | Defect and consequence | Reproduction / required change |
| --- | --- | --- | --- | --- |
| F-01 | High | `src/server/services/review.ts:73`, `:141`, `:196`, `:241`, `:261`; `src/server/services/enrolments.ts:95`, `:127`, `:150`, `:211`, `:253`, `:287`, `:321` | Review, financial, admission and fee-plan mutations use an incoming principal without reloading current account state, capabilities and grants inside their transaction. A deactivated/stale operator can still commit changes. Review replay returns cached results before checking current scope. Session checks on the next HTTP request do not close the in-flight transaction window. | `F-01 rejects revoked staff at the <action> transaction boundary` (eight actions); `F-01 denies approval replay after grants are revoked`. Lock/reload current authority before capability/scope checks and before idempotency replay. Apply to undo/correction/revocation as well. |
| F-02 | High | `src/server/services/enrolments.ts:337` | Admission acceptance looks up NIC globally, discloses a hidden B-only person with `needsConfirmation`, and permits linking that person when confirmed. The ordinary directory correctly hides that same person. | `F-02 hides out-of-scope admission duplicate-person warnings`. Use scoped identity visibility and a neutral `NOT_FOUND` for hidden matches. |
| F-03 | High | `src/server/services/imports/students-import.ts:287`, `:331`, `:345` | CSV dry-run distinguishes existing hidden intakes from nonexistent ones and reveals global NIC/reference collisions. `imports.run` does not grant global discovery. | Both `F-03` tests compare hidden/missing outcomes and probe a B-only NIC. Scope collision queries and return indistinguishable errors. OpenCode is repairing this file; coordinate with that owner. |
| F-04 | High | `src/server/services/imports/students-import.ts:412`, `:435` | Import capability is checked from the incoming principal, outside the commit transaction; the transaction and its replay path do not refresh authority. Deactivated staff can commit an import. | `F-04 rejects an import commit after deactivation`. Reload account, grants and capability inside the transaction before replay and writes. |
| F-05 | High (HTTP exposure mitigated during review) | `src/server/services/reports/exports.ts:366`; `src/app/api/staff/reports/export/route.ts:8` | Direct CSV generation trusts stale scope/capabilities/account. The original synchronous route also did so; Codex-G changed the route during this review to use a transaction plus `exportPrincipal`. Current HTTP callers and the export worker now refresh authority; the directly callable service still fails its requested authorization contract. | `F-05 rejects export after the account is deactivated`. Enforce or explicitly narrow the exported service contract. The newer background-export service independently rechecks authority and has positive regression coverage. |
| F-06 | Medium | `src/server/audit.ts:15` | Redaction walks objects but copies array entries unchanged. An audit payload such as `{ rows: [{ nic: value }] }` persists the raw identifier. This is a helper defect; the test does not assert that current financial payloads contain NICs. | `F-06 redacts identifiers inside persisted audit arrays`. Recurse into arrays while preserving date serialization and masked identifiers. |
| F-07 | Medium | `src/server/services/review.ts:276` | `releaseLease` checks only the lease holder, with no account or enrolment scope check. A former operator can mutate a now-invisible submission. | `F-07 rejects releasing a hidden submission lease after a scope change`. Reload authority and call `enrolmentInScope` in the transaction. |
| F-08 | Medium | `src/server/services/enrolments.ts:253`, `:335` | Fee-plan creation and admission acceptance omit parent-programme Trash checks. Acceptance checks only the intake's independent Trash flag. New enrolments/configuration can be created while the parent is suspended. | Both `F-08 suspends <action> when its parent programme is trashed` tests. Lock and check parent plus intake operational state. |
| F-09 | Medium | `src/app/api/cron/outbox/route.ts:15`, `:22` | `FOR UPDATE SKIP LOCKED` is an autocommit query, so its row locks expire before delivery updates. Portal updates use a `PENDING` predicate, which prevents duplicate persisted `SENT` transitions, but both workers unconditionally increment `sent`/job processed counts even when one updates zero rows. This is duplicate accounting, not evidence of duplicate external sends. | `F-09 concurrent outbox workers report a portal event SENT exactly once`. Four concurrent workers drain a real batch of 129 portal events; reported totals must equal the persisted transitions. Claim/process transactionally and count actual returned updates; mark failed runs on exceptions. |
| F-10 | Medium | `src/server/services/enrolments.ts:127`, `:253`, `:287`, `:321` | Several exported services rely on route validation instead of parsing input themselves. Direct server callers can save an empty applicant name or revoke an exemption without a reason. | Both `F-10 validates <action> inputs inside the service` tests. Parse at the service boundary for revocation, admissions, decisions and fee plans. |
| F-11 | Medium | `src/server/services/enrolments.ts:127`, `:147` | Credit application and exemption revocation lack expected-enrolment-version checks. Credit input strips an extra expected version, and both operations accept stale form state after a previous award changed the enrolment. | Both `F-11 rejects stale enrolment version for <action>` tests. Add/check/bump the expected version under lock and update route/UI contracts. |
| F-12 | Medium | `src/server/services/submissions.ts:99`, `:207` | Student submission replay compares only enrolment and idempotency key; changed amount, target or file payload returns the old success instead of an idempotency mismatch. The unique-violation retry path has the same issue. | `F-12 rejects changed student submission payload under an existing key`. Persist and compare a canonical request digest on all replay paths. |
| F-13 | Low | `src/server/auth/policy.ts:90` | The shared UUID character-class guard accepts 36 dashes. PostgreSQL then rejects the UUID and the route maps that error to `500 INTERNAL` rather than the intended neutral `NOT_FOUND`. No private existence is exposed. | `F-13 treats malformed guessed enrolment IDs as NOT_FOUND instead of an internal DB error`. Use strict UUID parsing before the lookup. |

Severity totals: **5 high, 7 medium, 1 low**; F-05's HTTP exposure was mitigated during the review. No critical finding is claimed. Historical requests remain append-only if another agent resolves a finding.

## Controls checked

### Authentication, CSRF and authorization

- Protected staff routes resolve `requireStaff`; staff mutations pass the request to enforce `x-csrf-token` and same-origin checks. Public login and invitation acceptance use the explicit origin guard. Cron routes require a configured bearer secret and fail closed when it is missing.
- Student evidence, submissions, uploads and notification operations use `requireStudent`, with CSRF on authenticated mutations. Public NIC entry has schema validation, neutral match failures and HMAC-backed distributed throttling. Device entry and logout do not use the session CSRF guard; their `SameSite=Strict` cookies are the existing cross-site control. No successful cross-site exploit was demonstrated by this service-level suite; this exception needs explicit product/security review (also recorded by the OpenCode static review).
- `loadStaffPrincipal` re-reads status, Trash state and `authVersion` on each request. Real existing-session tests cover deactivation, version changes, Trash, current grants, and restoration without reviving old credentials. This works independently of the F-01/F-04/F-05 service-transaction gaps.
- Admin A is tested against one person enrolled in A and B plus a B-only person. Queue rows, pending counts, history, search, metrics, every metric drill-down, all CSV report types, programme detail, enrolment operations and receipt bytes stay within A in normal cases. A narrower intake-only grant is also tested.
- Every delegable capability is denied to an Admin without flags: `fees.adjust`, `exemptions.manage`, `withdrawals.manage`, `exports.download`, `admissions.decide`, `programme.manage`, `programme.create`, `imports.run`. Team, Trash, NIC correction, full identifiers and holiday mutation remain Super Admin-only. Programme creation has its own capability and directory creation assigns the creator's scope transactionally.
- New background exports check owner, permission, role/scope fingerprint and expiry before private delivery, refresh authority during generation, and fail after revocation. Tests cover another operator guessing the export ID and scope loss after generation.

### Identifier privacy, evidence, injection and errors

- `decryptNic` usage is confined to the explicit full-identifier export path, guarded by `requireSuper` and audited. Ordinary export assertions reject either synthetic raw NIC and all hidden-person/programme markers.
- Normal directory responses project masked fields. The enrolment API projects a safe student subset even though its internal detail service returns the stored row. Review context returns private object keys to authorized staff; these are not public URLs or bearer credentials. Evidence delivery still uses the authenticated route.
- Staff and student evidence handlers explicitly set `Cache-Control: private, no-store`, `nosniff`, sandbox CSP and `Referrer-Policy: no-referrer`. `assetBytes` invokes the supplied scope callback before reading storage. Both preview and original variants are exercised with actual synthetic bytes.
- `src/lib/csv.ts:1` neutralizes user strings beginning with `=`, `+`, `-`, `@`, TAB or CR before CSV quoting. Export tests parse the generated CSV back and verify those prefixes, including embedded quotes and commas. No formula payload is executed.
- No `dangerouslySetInnerHTML` use or user-controlled server redirect destination was found in the inspected source. React renders names/notes as text. Queries use Drizzle parameters; reviewed raw SQL composes controlled predicates/columns and binds external values.
- `errorBody` returns a generic `INTERNAL` response and request ID without stack/SQL details; its regression test checks the returned body. Server logging still receives an exception message, so production telemetry redaction is not established by that test.
- Private APIs use shared `json`/`route` headers or explicit no-store CSV/evidence headers. Only intentionally public course metadata is cacheable. The service-worker policy allowlists public/static paths, excludes private APIs and navigation caching, and rejects private/no-store responses. Actual browser/CDN cache behavior was not exercised in this lane.

### Jobs and integrity

- Repeated and concurrent follow-up runs create one business task per dedupe key, release their lease, preserve notifications and preserve exact approved-submission/payment/allocation/ledger snapshots.
- Advancing fake Colombo time several days catches up broken promises, stale-review escalation and current collection tasks without rejecting a pending receipt or changing money. An expired worker lease recovers and marks its abandoned run failed.
- Retention replay/concurrency purges an eligible programme once, keeps immutable IDs and financial history, and records one purge audit. A real invalid media-path failure retains the original path, marks the record/job failed and leaves approved payments intact; a repaired disposable path can be retried safely.
- Concurrent orphan cleanup deletes an old unattached object once and preserves attached evidence even when its intent was still pending. Synthetic files created by these suites are removed by exact key in teardown.
- Concurrent `notify` calls produce one portal notification/outbox pair per key. Normal outbox retry changes `PENDING` to `SENT` once with `attempts=1`; disabled channels become `SKIPPED`, with no fabricated send and no reversal of a valid approval. F-09 documents the remaining concurrent accounting defect.
- A configured live provider is unavailable in this build. The tests exercise unavailable-channel behavior and a real retention storage failure, not a simulated successful SMS/email provider integration.

## Review inventory

All paths in the following tables are relative to the repository root. A path ending in `/route.ts` is a route file, not an assertion that every method on it is implemented. Source inventory was refreshed while other agents worked; additions after the final snapshot require their own review.

| API area | Route files read | Authorization / validation traced |
| --- | --- | --- |
| Public | `src/app/api/public/courses/route.ts` | Deliberately public metadata, public caching only. |
| Student entry/session | `src/app/api/student/entry/route.ts`, `device-entry/route.ts`, `logout/route.ts` | NIC/device match, neutral errors, throttling, session changes; CSRF exception described above. |
| Student receipts | `src/app/api/student/submissions/route.ts`, `submissions/[id]/evidence/route.ts`, `uploads/route.ts`, `uploads/[id]/route.ts`, `notifications/route.ts` | Session enrolment binding, schemas, idempotency, file limits, private bytes and notifications. |
| Staff auth | `src/app/api/staff/auth/login/route.ts`, `logout/route.ts` | Public-origin/login schema and rate limiting; authenticated CSRF logout. |
| Review | `src/app/api/staff/review/queue/route.ts`, `[id]/[action]/route.ts` | Queue filters, submission-to-enrolment scope, preview, evidence, decisions/corrections/leases. |
| Calls | `src/app/api/staff/calls/route.ts`, `[id]/route.ts`, `attempts/route.ts`, `holidays/route.ts`, `tasks/[id]/lease/route.ts`, `tasks/[id]/close/route.ts` | Fresh authority, task/enrolment/target binding, versions, dual attempt idempotency, Super-only calendar. |
| Directory | `src/app/api/staff/students/route.ts`, `search/route.ts`, `[id]/route.ts`, `export/route.ts` | Scoped search/detail, safe projections, capabilities, fresh contact mutation; exact search uses POST `/students/search`, and GET rejects a `nic` query parameter. |
| Enrolments | `src/app/api/staff/enrolments/[id]/route.ts`, `[id]/[action]/route.ts` | All action selectors, route/body ID binding, adjustment capabilities and corrections. |
| Programmes | `src/app/api/staff/programmes/route.ts`, `[id]/route.ts`, `[id]/intakes/route.ts`, `[id]/fee-plans/route.ts` | Delegated create/manage distinction, scope, banner allowlist, fee capabilities. |
| Admissions | `src/app/api/staff/admissions/route.ts`, `[id]/route.ts` | Scoped listing/creation, decision capability, optimistic version, existing-student confirmation. |
| Governance | `src/app/api/staff/team/route.ts`, `invite/route.ts`, `accept/route.ts`, `edit/route.ts`, `status/route.ts`, `src/app/api/staff/trash/route.ts` | Fresh Super authority, invitation origin, token hashing, lifecycle versions, invariant locking and replay. |
| Reports/imports | `src/app/api/staff/reports/export/route.ts`, `src/app/api/staff/imports/route.ts` | CSV schemas/capabilities, identifier export guard, scope predicates, import validation and transaction behavior. |
| Background exports | `src/app/api/staff/exports/route.ts`, `[id]/route.ts`, `src/app/api/cron/exports/route.ts` | Creation schema/key, owner-bound no-store download, fresh authority, authenticated worker. |
| Cron | `src/app/api/cron/followups/route.ts`, `purge/route.ts`, `uploads-cleanup/route.ts`, `outbox/route.ts` | Bearer authentication, bounded jobs, replay/lease/claim and failure behavior. |

| Services read under `src/server/services/` | Controls / result |
| --- | --- |
| `catalog.ts` | Public projection, active/live/public intake and programme predicates. |
| `directory.ts` | All search/detail/contact/programme/intake/admission/submission/history functions; scoped joins and fresh mutation authority. |
| `ledger.ts`, `hooks.ts` | Shared immutable ledger projection; financial-change promise/task reconciliation. These are internal helpers requiring caller authorization. |
| `review.ts` | All preview/approve/reject/undo/correction/lease/queue/context functions; F-01 and F-07 remain. |
| `enrolments.ts` | All exemption/revocation/credit/withdrawal/fee/admission/detail functions; F-01/F-02/F-08/F-10/F-11 remain. |
| `submissions.ts` | Dashboard, intent/upload/finalize, evidence, notifications and orphan cleanup; F-12 remains. |
| `followups/shared.ts`, `calendar.ts`, `queue.ts`, `attempts.ts`, `promises.ts`, `tasks.ts`, `jobs.ts` | Fresh authority, scope, target ownership, optimistic versions, replay, business dates, dedupe and persistent cursors. |
| `governance/index.ts`, `auth.ts`, `invariant.ts`, `idempotency.ts`, `public-origin.ts` | Fresh Super authority, lifecycle invariant, login/replay/session checks, origin guard. |
| `trash/index.ts`, `purge.ts` | Fresh Super authority, deadline, row locks, reference checks, contained paths, failure recovery and tombstones. |
| `reports/metrics.ts`, `reports.ts`, `exports.ts`, `balances.ts`, `export-jobs.ts` | Scoped metrics/drill-downs/reports/SQL projections, CSV encoding, masked identifiers, queued export generation and delivery; F-05 remains on the direct service. |
| `imports/students-import.ts` | Entire parser, group validation, duplicate queries, dry-run, commit and replay; F-03/F-04 remain pending owner repair. |

Shared files also read: `src/db/schema.ts`, `client.ts`, `src/server/http.ts`, `auth/policy.ts`, `auth/staff.ts`, `auth/student.ts`, `audit.ts`, `idempotency.ts`, `cron.ts`, `ratelimit.ts`, `storage.ts`, `src/domain/finance.ts`, `src/lib/csv.ts`, and `tests/integration/helpers.ts`. Next route-handler conventions were checked against the installed Next 16 documentation.

## Validation and limits

The expanded suite contains **82 cases: 56 normal assertions and 26 documented expected-failure cases**. Before the last guard adjustment, two complete runs reported 56 passes and 26 expected failures. A diagnostic run with the original expected-failure markers removed confirmed 23 security assertions failed for their documented causes. An invalid outbox test barrier was corrected; the standalone concurrent batch then reproduced **387 reported sends for 129 persisted once-only transitions**.

An additional **suite-level** check now prevents unrelated import runtime exceptions from being counted as successful security reproductions. Per-test hooks alone do not provide that safeguard under `it.fails` in this Vitest version. The focused current import run exits **1**: all four F-03/F-04 cases encounter `ReferenceError: inScope is not defined` from `src/server/services/imports/students-import.ts:187`, and the final suite check exposes those exceptions. This source file is explicitly reserved for OpenCode's active edits. Earlier F-03/F-04 behavior was reproduced before that intervening edit; their current acceptance must be rerun after the import implementation is repaired. No claim of a clean final suite is made while this blocker remains.

| Check | Latest observed result |
| --- | --- |
| `pnpm exec vitest run tests/integration/security-scope.test.ts tests/integration/jobs.test.ts` | Full guarded run recorded at final handoff below. |
| `pnpm exec vitest run tests/integration/security-scope.test.ts -t 'F-03\|F-04' --reporter=verbose` | Exit 1: suite-level guard reports four `inScope` ReferenceErrors; 4 expected-failure cases selected, 65 cases filtered out. |
| `pnpm exec tsc --noEmit` | Exit 1 during concurrent edits: `src/server/services/imports/students-import.ts:187:5` missing `inScope`, and `src/app/staff/admissions/admission-forms.tsx:14:688` invalid form-to-select cast. **No diagnostics in Codex-F files.** Earlier checks completed with exit 0; these are the latest observed errors. |
| `pnpm exec eslint tests/integration/security-scope.test.ts tests/integration/jobs.test.ts` | Exit 0. |

Application owners have the exact blockers and finding/test references in `docs/agent-requests.md`. Codex-F has changed only the two assigned test files, this review, and append-only requests. Clean global acceptance remains pending the owning agents' repairs.

This lane does not claim production-build, full-repository lint, clean/upgrade migration, full Playwright journey, deployment, dependency-advisory, live-provider or CDN verification. The suite's database setup runs the real checked-in migrations in its own per-file databases, but that is not a production upgrade rehearsal. Application fixes are deliberately left to the owning agents. The authoritative outstanding list is the numbered findings plus their linked expected-failure tests and requests.
