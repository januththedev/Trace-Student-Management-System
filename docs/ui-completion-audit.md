# UI and release handoff audit

Snapshot: 2026-11-16. This is a local implementation and verification summary, not a production
deployment certification. Root-run test evidence and artifact paths are recorded in
[`test-results.md`](test-results.md).

## Current application state

- Staff can copy/open a public intake-specific link from Programme intake details. `/join/<intake
  UUID>` shows a fixed programme and intake and asks for NIC only. It is available only for active,
  public, non-trashed programme/intake records; remembered-course state cannot change the target.
  Invalid links show an unavailable page and ineligible NICs receive the neutral entry response.
- Fee-plan changes have a selected-enrolment impact preview and explicit apply flow. The preview
  explains per-instalment changes, validates matching schedule structure, and expires on stale
  financial/version data. Apply requires a reason, fresh authorization, CSRF and idempotency; the
  service performs the selected batch atomically.
- The identity-resolution queue is Super Admin-only. Sanitized staged-row previews resolve missing
  or invalid identities into a student/enrolment and optional opening schedule in one transaction,
  preserving original import evidence and avoiding silent merges.
- Reports offer background CSV jobs; an end-to-end local browser flow created a job, ran the worker
  and downloaded the private CSV. The synchronous export route remains available.
- Student entry/dashboard, receipt review, follow-ups, programme/intake management, Trash, imports,
  identity resolution, reports and fee-plan application are implemented in the current source.

## Fee-plan UI browser QA

`.agents-logs/luna-fee-ui-qa.mjs` exercised the rendered application on the root development server
at 390×844 and 1440×900. Results are in `.agents-logs/fee-plan-qa-results.json`; screenshots are
`.agents-logs/fee-plan-{390,1440}-{selection,preview,stale,blocked}.png`.

- The live page returned 8 candidates, all disabled because the seeded current version had no
  eligible enrolments. Preview/error/stale/blocked UI states therefore used synthetic intercepted
  responses from the real API response shape. The financial apply request was intercepted; no
  demo financial data was changed.
- Candidate selection worked with pointer and keyboard. At both viewport widths document width
  equaled viewport width, full candidate rows met the 44px touch target, and there were no unlabeled
  textareas or browser console errors.
- Preview errors display a recoverable message. A stale response clears the expired preview and
  enables a fresh preview. Structurally blocked candidates cannot be confirmed.
- This browser check does not prove a real financial apply. Fee-plan service/integration tests are
  the database-level evidence for the actual apply transaction.

## Current verification and release boundaries

The latest root combined unit/integration run passed 395/395 across 26 files; Playwright passed
32/32 (16 desktop, 16 mobile). Fee-plan creation/idempotency, reconciliation and migration-upgrade checks are
included in the combined run. The read-only trace audit reported zero findings in its checked
categories. See [`test-results.md`](test-results.md) and its linked `.agents-logs` artifacts.

The final production build, TypeScript and lint passed after the PDF.js canvas renderer changes.
The real-upload two-page PDF browser gate passed on desktop and mobile. Deployed browser, CDN and infrastructure behavior remain
unverified. The S3 adapter was tested against ephemeral
MinIO, not a production bucket. A real ClamAV daemon/signature feed, deployed cron, hosted database,
production HTTPS/secrets, backup/restore rehearsal, and external email/SMS providers remain
operator setup. Portal notifications are the only live notification channel.

No production deployment or financial-data mutation was part of this audit.
