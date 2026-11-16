# T2T Student Operations System — Coding Agent Master Prompt

Source: T2T_Student_Operations_System_Updated_Proposal_v2.pdf, version 2.0, 10 pages.

## 1. Your assignment

Act as the lead full-stack engineer, product engineer, and QA owner. Implement the T2T Student Operations System described below and in the attached proposal. Deliver a working, responsive application with persistent data, real authorization, private receipt storage, correct financial calculations, operational queues, and tested recovery workflows. Do not stop at a plan, a static dashboard, or a frontend that pretends to save data.

Read the full proposal first if available. Inspect the repository, AGENTS.md instructions, existing architecture, migrations, authentication, deployment configuration, and tests before making changes. Preserve useful existing code and unrelated work. If this is a new repository, scaffold the project. If the PDF is unavailable, this prompt contains the implementation requirements; disclose that you could not cross-check the attachment.

Work autonomously through implementation and verification. Make routine engineering decisions yourself and record assumptions. Ask only when a missing credential, external access, irreversible operation, or genuinely unresolved business decision blocks progress. Continue independent work while blocked. Never invent credentials, successful integrations, test results, or deployment URLs.

Do not treat a missing production integration as permission to ship fake functionality. Use explicitly labelled development adapters and report the exact production setup still required. Do not deploy to production, send real notifications, or run destructive migrations merely because implementation is complete; prepare a reviewable result and respect the operator's existing authorization.

## 2. Product purpose and requirement precedence

Build one central T2T platform replacing student spreadsheets, receipt forms, and isolated calling trackers.

Core principle: one person record, separate programme enrolments, and a clear next action for staff.

There are two experiences:

- Students: enter NIC, choose a course/intake, view only that enrolment's payment obligations/history, upload payment evidence, and see review decisions.
- Staff: manage students, admissions, programmes, instalments, receipts, follow-ups, reports, scoped access, and recoverable deletion.

Precedence: explicit later owner instructions > mandatory proposal requirements > implementation defaults in this prompt. Mark any conflict and resolve it without quietly deleting a requirement.

**Mandatory proposal requirements:** no student OTP/password/self-registration; course-specific banners; exactly two staff roles; maximum three active Super Admins; protected enrolment-level access; receipt review cards; reminder-call cards; financial history; 30-day programme/intake and staff Trash; static caching; PostgreSQL-backed production data.

**Additional implementation defaults introduced here:** precise money/allocation rules, partial payments, enrolment credit, auditable reversals, concurrency controls, operational retry defaults, admissions states, CSV migration, notification outbox, health monitoring, and detailed acceptance tests. Implement these unless they conflict with existing agreed requirements. Document them in `docs/assumptions.md` so they remain visible and adjustable.

Do not expand this into an LMS, exam platform, attendance tracker, payroll system, AI chatbot, payment gateway, automatic bank reconciliation product, WhatsApp bot, or call-recording service. Manual bank-payment evidence and human review are the core payment workflow.

## 3. Architecture and implementation conventions

Preferred starting architecture from the proposal:

- Next.js with TypeScript and Tailwind for responsive student and staff experiences.
- PostgreSQL, suitable for Neon deployment, with checked-in migrations.
- A maintained ORM/query builder appropriate to the existing repository.
- Secure staff authentication integrated with application-owned staff roles and scopes.
- Private object storage for receipts; separate public, sanitized programme banner assets.
- Vercel-compatible deployment, with a real supported scheduler/worker mechanism for background jobs.

Use compatible stable dependencies, verify relevant official documentation during implementation, and pin versions in the lockfile. Do not infer package versions from this prompt. Avoid rewriting a healthy existing stack solely to match a preference.

Separate UI components, request validation, authorization policy, business services, data access, storage adapters, notifications, and background jobs. Centralize payment calculations and eligibility rules so dashboards, exports, queues, and detail screens cannot disagree.

Use server-side schemas for all mutations. Client validation improves UX but grants no authority. Treat URL parameters, submitted role values, object IDs, and client-calculated balances as untrusted.

Defaults: currency LKR; integer minor units throughout persistence and calculations; `Asia/Colombo` for business dates and display; UTC instants for events; SQL DATE for due dates and promise dates. Never use binary floating-point currency arithmetic. Serialize large integer amounts safely to the client. Store the currency explicitly and reject cross-currency allocation.

## 4. Roles, scopes, and staff governance

Exactly two staff roles: `SUPER_ADMIN` and `ADMIN`. Students have a separate session type, not a third staff role. Permission flags are capabilities attached to these roles, not new role names.

| Capability | Super Admin | Admin |
| --- | --- | --- |
| Dashboard/reports | All programmes | Assigned programmes/intakes only |
| Student/enrolment operations | All | Assigned scope |
| Receipt reviews/call queues | All | Assigned scope |
| Programme/fee/banner edits | All | Only with explicit delegation |
| Exemptions/withdrawal adjustments | All | Explicit capability within assigned scope |
| Staff invitations/roles/deactivation/restoration | Yes | Never |
| Programme/intake Trash and restore | Yes | Never |
| Platform settings/role policy/global audit | Yes | Never |
| Operational history | All | Only records visible within scope |

Define explicit capabilities such as `programme.manage`, `fees.adjust`, `exemptions.manage`, and `exports.download`; deny by default. A permission to manage an existing course must not automatically allow creation of arbitrary new courses. If delegated creation is supported, require a separate capability and assign the creator's scope transactionally.

Every endpoint, server action, file access, export, count, search, and job-triggered mutation must check current authorization. An Admin assigned to course A cannot discover course B students through global search, guessed IDs, duplicate warnings, or aggregate counts. Where a student has multiple enrolments, show only authorized enrolment details. Shared core-profile changes must be audited and must not reveal other enrolments; restrict NIC corrections to Super Admin by default.

### Super Admin invariant

After successful bootstrap, active Super Admin count must always remain between one and three inclusive. The cap is fixed, not an editable platform setting.

Enforce using a common database transaction boundary and lock shared by every staff lifecycle operation affecting the invariant: bootstrap, create/activate, invite acceptance, promotion, demotion, deactivation, Trash, and restore. A count query without locking is insufficient. Use a locked governance row or equivalent PostgreSQL serialization strategy. Retry serialization failures safely.

Pending invitations are inactive and do not consume active slots. Check capacity before inviting for helpful UX, and recheck atomically at acceptance/activation. Invitations may fail activation if capacity filled meanwhile; return a clear error, never silently assign another role. Use expiring, single-use invitations and persist only token hashes.

Prevent removal, demotion, or deactivation of the last active Super Admin, including self-directed actions. Bootstrap runs once using an operator-controlled process, has no permanent unauthenticated public endpoint, and cannot create a fourth active account on rerun. No default production password.

Staff deactivation revokes sessions immediately. Check active state and an authorization/session version against authoritative storage on requests; do not trust stale role claims until JWT expiry. Scope and role changes take effect on the next request. Restoring a staff record never restores its old sessions or invitation tokens.

## 5. Student identity and access

Required flow: NIC → selectable course/intake → match an active enrolment → open that enrolment immediately. No OTP, student password, student self-registration, or additional mandatory confirmation.

Make each selector option identify a concrete intake, e.g. programme name + batch label. If a course has several intakes, expose them in this normal selector; do not fetch matching private enrolments after NIC entry. The public list contains only intentionally public programme metadata, never student names or counts.

NIC normalization: trim whitespace and normalize letter case. Support configured Sri Lankan NIC formats, including 9 digits plus V/X and 12 digits. Do not infer identity equivalence across old/new NIC formats or automatically merge students. Use format validation only, not claims of identity verification. For legacy invalid/missing identifiers, send records to an admin resolution queue rather than fabricating IDs.

Default data protection: store normalized NIC encrypted at rest at application level where feasible, plus a keyed lookup digest for exact matching and uniqueness. Do not use an unsalted ordinary hash of a predictable NIC. Keep keys server-side and document rotation/migration. Logs, analytics, errors, URLs, exports by default, and browser caches must not contain raw NICs.

Invalid, inactive, unknown, and mismatched entries return the same neutral message: “We could not find an eligible enrolment.” Apply distributed rate limits to IP and keyed identity/course attempts, with sensible configurable thresholds and no permanent account lockout an attacker can cause. Avoid distinguishable response bodies that disclose whether an NIC exists.

On match, issue an opaque, revocable, server-managed student session bound to exactly one enrolment. Use Secure, HttpOnly cookies and appropriate SameSite/CSRF protections. Default student expiry: 30 minutes idle and 12 hours absolute; configurable within sensible bounds. A change of course requires a new eligible match. Never let a client-supplied enrolment ID override session scope.

Check active student, enrolment, intake, and programme eligibility on every protected request. Withdrawal, deactivation, or Trash invalidates access without waiting for the cookie to expire. Student reads/uploads/file access must always resolve ownership from the session.

### Remembered-device behavior

Remember the last public course selection and a masked NIC suggestion. Do not store raw NIC in localStorage, sessionStorage, IndexedDB, service-worker caches, or a readable cookie. To avoid repeat typing, use an optional opaque, revocable, HttpOnly device token mapped server-side to the prior student identity; selecting its masked suggestion can perform the same NIC/course eligibility check. This token is a credential and must be random, hashed server-side, revocable, and time-limited (default 30 days). Do not silently create it on shared devices; provide an unchecked “Remember on this device” option.

“Forget this device” revokes device tokens, ends the student session, clears remembered selection and sensitive in-memory data, and returns to entry. Standard logout ends the session; clearly explain whether remembering remains enabled. On logout/account change, prevent previous financial content reappearing through navigation or back-forward cache.

The PDF explicitly accepts an impersonation risk: someone knowing NIC + course can access records. Rate limiting and protected storage reduce exposure but cannot solve that. Document this honestly for operators. Do not market the student entry as verified identity or introduce OTP against the requirement.

## 6. Student UI and receipt submission

Entry: full-viewport selected banner with blur, vignette, dark overlay, sharp accessible glass-style form, course logo/name, two clear inputs, Continue, remembered suggestion, and Forget this device. Provide a neutral banner fallback. Mobile must remain readable with keyboard open and slow image loading.

Student dashboard must include:

- Student name, masked NIC, internal student reference, selected programme/intake, and enrolment status.
- Summary of net obligations, approved allocated payments, pending claimed amounts, credit, outstanding, and overdue balances as distinct values.
- Explicit instalment timeline: period, due date, original fee, adjustments/exemptions, approved allocations, remaining amount, and status.
- Earliest outstanding payment suggestion, upload action, complete receipt history, decisions/reasons, previews, and resubmission chains.
- In-portal notifications for review outcomes. Private staff notes are never student-visible.

Keep financial surfaces solid and high-contrast; use banners subtly in the header. Label submission review status separately from instalment settlement status. A single “Paid” badge must never hide a pending or partial situation.

Preselection algorithm: order active collectible instalments by due date then stable sequence; choose the first with positive remaining amount. If it has pending evidence, keep it visible and explicitly warn that review is pending; do not silently treat it as paid. Allow selecting a later unpaid instalment for advance payment. A fully settled plan shows a clear completed state instead of inventing another charge.

Submission form: target instalment, positive claimed amount, actual transfer date, receipt attachment, optional bank reference and student note. Default to one receipt file per submission. If one transfer covers several instalments, the reviewer can split its allocation; the student selects the primary intended period. Explain this behavior.

Default file support: JPEG, PNG, WebP and PDF; 10 MiB maximum per file, configurable. Validate magic bytes, actual decoding, dimensions/page limits, MIME, and size server-side. Reject executables, SVG, corrupt documents, and password-protected PDFs. Preserve submitted evidence privately and generate sanitized preview derivatives. Do not execute uploaded content; isolate PDF preview/rendering. Quarantine until checks complete, and support a malware scanner adapter with its actual configured status visible to operators.

Use an upload-intent → private object upload → server finalization flow. Bind intent to enrolment, file limits, expiry, and a random object key. Finalization verifies object ownership, metadata and validation; the browser cannot attach another enrolment's object. Submission idempotency prevents duplicates caused by retries. Do not show “submitted” until the database transaction commits. Safely clean abandoned uploads after a defined grace period without touching attached evidence.

Transfer dates cannot be in the future in the business timezone. Unusually old transfers or amounts require a warning/manual review, not invented conclusions. A rejected submission is immutable evidence: resubmit by creating a new submission linked through `supersedes_submission_id`; show its entire chain. Prevent simultaneous active replacements of the same rejected item.

## 7. Financial model and invariants

Use explicit instalments attached to enrolments. A programme fee template generates a versioned schedule; later template edits do not rewrite existing student obligations. Material changes require an impact preview and explicit application to selected enrolments.

For each instalment:

`net_obligation = original_charge + signed_charge_adjustments - active_exemptions`

`approved_allocations = sum(active allocations backed by unreversed approved payments)`

`remaining = net_obligation - approved_allocations`

Enforce `net_obligation >= 0`, `approved_allocations >= 0`, and `remaining >= 0`. Do not hide bad accounting with UI-only clamping. An exemption/fee reduction that would make existing allocations exceed the obligation must atomically release the excess into that enrolment's credit, preserving payment history and source attribution.

An approved submission creates one verified payment event with its confirmed amount and one or more allocations. Confirmed amount defaults to claimed amount; changing it requires a reviewer reason and retains both values. Allocations may cover only instalments of the same enrolment and currency. Do not transfer money across programmes automatically, even for the same student.

Default allocation: selected instalment first, then earliest remaining eligible obligations only after reviewer preview/confirmation. Any excess remains clearly labelled unapplied credit within that enrolment. Staff with appropriate scope may apply credit to an unpaid or future instalment through an audited transaction. Existing credit is shown before a student uploads more evidence; never count applying credit as newly collected money.

Enrolment credit equals unreversed verified receipts minus active allocations, assuming no refunds. Refund disbursement is outside MVP: show any refund/reconciliation requirement as an unresolved staff task; never pretend a credit was paid back. Reversing an incorrectly approved receipt is a correction, not a refund.

Pending and rejected submissions contribute zero approved money. Free cards and sponsorship waivers reduce obligations but contribute zero cash. A sponsor's actual transfer is recorded separately as payment evidence if received; a waiver must never imply money arrived.

Derived instalment states: upcoming, due today, overdue, partially paid, paid, exempt, cancelled. Review states are separate. Overdue means business date is later than due date and remaining is positive. Due today is not overdue. The database must not require a nightly job to make date-based balances correct.

Submission state machine: `PENDING_REVIEW → APPROVED | REJECTED`; a validated undo can return it to `PENDING_REVIEW` while retaining decisions and financial reversal events. “Not Submitted” is a presentation state for an obligation with no submission, not a fabricated submission row.

All financial mutations use a transaction, fresh permissions, deterministic lock ordering, expected version checks, uniqueness constraints, and idempotency keys. Protect the same enrolment/instalments against simultaneous approvals, waivers, withdrawals, credit allocation, and undo. No approval can credit money twice, even if a browser retries after a timeout.

### Worked fixtures to implement and test

1. Obligation LKR 10,000; claim LKR 10,000 pending: collected 0, remaining 10,000, pending 10,000.
2. Approve LKR 4,000: collected 4,000, allocated 4,000, remaining 6,000, partial status.
3. Reject a further LKR 6,000: remaining stays 6,000.
4. Approve LKR 7,000 against remaining 6,000: allocate 6,000; credit 1,000; total collected 11,000; obligation settled.
5. Fully waive a new LKR 10,000 obligation: net obligation 0; cash collected 0; no collection call.
6. After allocating LKR 4,000 to a LKR 10,000 obligation, waive LKR 8,000: net obligation 2,000; retain allocation 2,000; move 2,000 to credit; collected remains 4,000.
7. Undo an approval: reverse its active allocations and credited amount atomically; keep original evidence and audit. If its credit has since been allocated, include those linked allocations in a deliberate correction preview or block quick undo and require the controlled correction flow.

## 8. Fast receipt-review workspace

Default queue: all pending submissions within current scope, oldest first. Filters: programme, intake, target period, submission date, warning flags; preserve filters during navigation. Support cursor pagination and bounded prefetch rather than loading hundreds of full receipts at once.

Desktop layout: large evidence viewer on the left; student/enrolment context and decision controls on the right. Show claimed/confirmed amounts, transfer date, target period, outstanding balance, previous receipts, related decisions, duplicate warnings, and proposed allocation/credit outcome. Viewer supports zoom, rotate, fit, PDF page navigation, and prior submission comparison.

Mobile: stack viewer/context and provide a reachable action bar. Gestures supplement visible buttons. An accidental swipe must not silently approve money; require a deliberate gesture threshold and clear final action/confirmation behavior. Keyboard shortcuts must ignore typing fields, be discoverable, and remain accessible.

Actions:

- Approve: validate fresh state and evidence readiness; confirm allocation; commit payment, allocations, decision, audit, and notification outbox event atomically; then advance.
- Reject: require a trimmed nonempty reason; preserve original evidence; record decision; notify; advance.
- Skip: no financial/status mutation; advance for this review session. Items reappear on later sessions and queue counts remain accurate.
- Undo: default quick window 60 seconds, own latest decision only, same receipt version, no dependent changes. Reverse through append-only events; never delete original actions. Outside that window, a Super Admin can use a reason-required correction workflow with dependency preview. No unrestricted rollback of someone else's subsequent work.

Use a short advisory review lease to reduce staff collision if practical, but database locking/version checks remain authoritative. A stale decision returns a conflict with current status and reviewer; it must never overwrite the other decision. Release or expire leases after navigation and crashes.

Duplicate checks: exact file hash, repeated reference with contextual fields, and optionally perceptual similarity. Flag suspicious evidence for humans, never auto-reject or accuse fraud. Cross-scope matches must show a generic warning and route to authorized staff without leaking unrelated student records.

## 9. Students, admissions, programmes, and enrolments

Students: searchable internal ID, name, NIC, phone, email where available, contact verification metadata, status, timestamps, and authorized enrolment summaries. Do not mark a contact verified merely because it was entered. Students cannot edit identity or fees themselves in MVP. Support corrections by staff with an audit trail.

Use a unique normalized NIC lookup key. On attempted duplicate creation, show a permitted existing match or a generic duplicate-resolution message; do not automatically merge records. Multiple enrolments reuse the same person after explicit confirmation. Imports quarantine conflicting records.

Admissions is staff-managed; no student signup. Default states: draft, under review, accepted, rejected, waitlisted, withdrawn. Store applicant details, intended intake, decision reason/operator/time, and requested sponsorship. Acceptance creates/reuses the confirmed student, creates one enrolment, snapshots its fee plan, generates instalments and applicable exemptions in a single idempotent transaction. Repeated acceptance must not create another enrolment or fee schedule.

Programmes contain descriptive metadata, status and default branding; intakes contain batch labels, dates, fee-plan versions and optional banner override. Course picker displays eligible active intakes, respecting parent status. Enforce sensible dates and unique human-readable labels/codes within parent scope.

Fee plans support monthly and custom instalments, explicit amount, period label, due date, sequence and fee component. Installment identifiers must remain stable even if labels change. No assumption that an enrolment's next payment is this calendar month.

Enrolment states: enrolled/active, completed, withdrawn, inactive. Choose one canonical active-state representation and document transitions; do not maintain conflicting booleans. Default uniqueness is one enrolment per student/intake; explicit re-enrolment should reactivate or follow a documented repeat-enrolment policy, not silently duplicate history.

Withdrawal workflow: reason and effective business date; preview affected obligations and calls; retain past/current dues by default; cancel unpaid future obligations whose due dates fall after the effective date using recorded adjustments. For already-paid future obligations, show the resulting enrolment credit and unresolved refund consideration; do not erase cash. Staff can waive retained arrears only using an explicit authorized exemption. Suspend reminder tasks and access as appropriate. Reactivation requires a schedule preview; never blindly regenerate historical charges.

Free-card/sponsored awards require reason, approver, effective range, specific instalments/components, type and value. Support fixed amount or percentage with deterministic minor-unit rounding and caps. Preview overlap; do not stack exemptions above the charge. Revoke through auditable reversal, not deletion. Changing an award after payment may release allocation to credit or restore an obligation; show the impact before committing.

## 10. Follow-up and call cards

One card represents one student-enrolment, showing name, intake, phone/click-to-call, due instalments, outstanding and overdue amounts, pending evidence, contact history, latest promise and next action. Do not combine multiple programmes into a universal student debt.

Only queue active enrolled students with currently due/overdue positive collectible balances. Exclude withdrawn/inactive enrolments, fully covered exemptions, paid obligations, and trashed courses/intakes. Future instalments appear in account details but are not default collection calls.

Pending-evidence default: temporarily hold the affected instalment from collection calls while under review; other overdue instalments remain eligible. After 48 hours pending, create/escalate a staff review task rather than pretending the payment is rejected. Show pending balances distinctly. Always recheck queue eligibility before displaying/acting on a card and after financial changes.

Outcomes:

- No Answer: append attempt, increment derived unanswered count, schedule default next-business-day retry.
- Answered: require concise outcome notes and choose resolved/no follow-up or a next action/date.
- Promised to Pay: record positive amount, business date, target obligation scope, notes and staff member; do not alter balance. Permit partial promises; warn if amount exceeds current due.
- Already Paid: show existing submissions; request evidence or create verification task. Never mark paid from the call outcome.
- Needs Assistance: create owned staff task with category, reason, priority and due date.
- Not Continuing: open the withdrawal preview and confirmation; do not instantly erase obligations from a gesture.
- Free Card / Sponsored: open the authorized exemption workflow, or create an approval request when the caller lacks capability.

Call attempts are immutable: operator, timestamp, outcome, notes, relevant balance snapshot and linked follow-up/promise. Corrections are appended. Clicking `tel:` opens the device dialer; it is not proof that a call happened or was answered. Staff explicitly save the outcome.

Default retry policy: at most one scheduled collection attempt per enrolment per business day; after three consecutive no-answer outcomes, create an escalation task and pause automatic retries pending staff action. Configure business days, 09:00–17:00 local contact window, and holidays; do not infer holidays from weekday logic. Manual override requires a reason. Respect wrong-number and do-not-call flags.

Promise states: open, partially fulfilled, fulfilled, broken, superseded, cancelled. Fulfilment is based on approved allocations after the promise baseline toward its target obligations, not upload or claimed amount. On due date keep it due; after the local day's end mark unmet remainder broken. New promises supersede old open promises without deleting them. Waivers/withdrawals that eliminate the target debt cancel/resolve the follow-up with a reason; they are not cash fulfilment. Payment reversals trigger recomputation.

Avoid duplicate tasks with unique business keys and idempotent upserts. Two staff members must not unknowingly save the same attempt twice on retry. Use assignment/short leases for coordination, and permit legitimate separate attempts with distinct IDs.

## 11. Admin command centre and reporting

Landing page prioritizes pending review, due promises, overdue callbacks, admissions decisions, stale pending evidence and exceptions. Provide clear owners and direct actions.

Every metric drills into a filtered list and then programme/intake detail. Counts and drill-downs must use the same shared query definitions and current scope.

Define metrics precisely:

- Total registered students: distinct people visible within scope; global Super Admin includes unassigned records, while scoped Admin does not.
- Active students: distinct people with at least one visible active enrolment; show enrolment count separately.
- Active programmes: distinct active programmes with applicable visible scope.
- Free/sponsored students: distinct students with effective awards in the selected period/scope.
- Pending/rejected slips: submission counts by current review state; retain historical decision counts separately.
- Students with dues: distinct students with visible due/overdue remaining balances; list the relevant enrolments.
- Outstanding amount: all active remaining obligations, including future dues; separately show due-now and overdue totals.
- Calls due today/unanswered follow-ups: actionable tasks, not all historic call attempts.
- Promised payments due: active promises due on the selected local date, not yet fulfilled/cancelled.
- Admissions awaiting decisions: under-review applicants in scope.

Reports: payment receipts by approval date, cash corrections by reversal date, transfer-date view clearly labelled, allocations by instalment, enrolment credit, outstanding/overdue balances, ageing buckets (1–30, 31–60, 61–90, 91+ days), exemptions, programme/intake totals, review throughput and follow-up outcomes.

Call collected money “approved receipts” or “collections”; do not imply formal accrual revenue recognition. Default cash reporting uses recorded approval events less reversal events within the selected range, with gross approvals and corrections visible. Applying old credit creates no new collection. Historical snapshots/as-of reports must use effective event dates rather than silently applying today's balances to a past date.

Collection rate for obligations due through an as-of date = approved allocations against those net obligations / those net obligations. Exclude future obligations/allocations from this ratio. Zero denominator displays “N/A”; do not divide by zero. Offer a separate all-plan settlement view if useful.

Support authorized CSV exports with active filters, timezone, currency, generation timestamp and field definitions. Mask NIC by default. Explicit full-identifier export is Super Admin-only and audited. Neutralize spreadsheet-formula injection in all user-controlled cells. Large exports use background jobs and short-lived private downloads, rechecking current permission before delivery.

## 12. Thirty-day Trash and retention

Only Super Admin can move programmes/intakes and staff to Trash or restore them. Never provide a “Delete Permanently” button or an equivalent public destructive API.

Track `trashed_at`, `trashed_by`, reason, `purge_after`, restore events and final purge status. Countdown derives from server time. Restore is available strictly before `purge_after = trashed_at + 30 days`; after the deadline it is unavailable even if the cleanup worker is delayed.

Course/intake Trash removes public selection and prevents enrolment creation and student entry/uploads immediately. Administrative history stays readable within scope. Default: operational queues and mutations for trashed courses are suspended until restore; explicitly authorized historical correction can use a Super Admin flow. Do not cancel financial obligations solely because configuration was trashed.

Trashing a programme makes child intakes effectively unavailable without overwriting each child's independent Trash state. Restore of a parent must not resurrect a previously independently trashed intake. Restore reinstates retained banners/settings and relevant active assignments; never resurrect deactivated staff or expired sessions.

Staff Trash immediately deactivates and revokes access. Restore rechecks authorizer, last-active rule, and three-active cap transactionally. If cap is full, restoration as Super Admin fails clearly; a separately confirmed Super Admin-authorized restore-as-Admin action may be offered and audited.

After 30 days, a scheduled retention job removes only eligible disposable configuration/media/personal account fields, leaving tombstones with immutable IDs and minimal historical labels. Foreign keys from payments, enrolments, students, receipts, reviews, call attempts and audit events must not cascade-delete. Receipts and financial history are not governed by this 30-day Trash rule.

Use object reference checks before media deletion. A banner or file still referenced by another active or historical record must survive. Coordinate purge and restore with locks; claim due records transactionally, mark purge state, and retry external object deletion idempotently. Worker failures must be visible and recoverable. Do not claim complete purge while external deletion failed.

## 13. Data model and database integrity

Design normalized tables with immutable primary IDs, appropriate timestamps, indexed foreign keys, explicit state constraints and `version` where optimistic concurrency is needed. Suggested minimum entities:

| Entity | Essential data/relationship |
| --- | --- |
| Student | internal reference, encrypted NIC/lookup key, name, contacts, verification metadata, status |
| Programme | code/name, description, banner, state, Trash metadata |
| Intake | programme FK, label, dates, banner override, status, Trash metadata |
| FeePlan / FeePlanVersion / FeePlanItem | immutable schedule versions, amount/component/period/deadline rules |
| Admission | applicant data, intended intake, decision state/history, accepted enrolment link |
| Enrolment | student/intake FKs, status, terms snapshot, activation/withdrawal dates |
| Instalment | enrolment FK, sequence, component, period label, original charge, due date, status |
| ChargeAdjustment | instalment FK, signed amount, reason, effective date, actor, reversal reference |
| ExemptionAward / ExemptionApplication | scope/type/value, approver/reason, effective period, per-instalment amounts/reversals |
| UploadIntent / ReceiptAsset | private object key, owner, content hash, validation state, size/type, expiry |
| PaymentSubmission | enrolment/target FK, claim, transfer date, asset, status, replacement link, version |
| ReviewAction | append-only decision/undo, submission version, actor, reason, timestamp, prior action link |
| PaymentEvent / PaymentAllocation | confirmed amount, source submission, currency, allocated instalments, reversal/source links |
| CallAttempt | enrolment, operator, immutable outcome/notes, attempt ID/time, linked task/promise |
| PaymentPromise | enrolment, target obligations, amount/baseline, date/state, supersession link |
| FollowUpTask | enrolment, owner, type, due time, state, business deduplication key |
| StaffAccount / StaffScope | auth identity, one of two roles, active state, capabilities, scope, auth version, Trash metadata |
| StaffInvitation / Session / RememberedDevice | hashed tokens, principal binding, expiry, revocation |
| AuditEvent | actor/type, action, entity, redacted before/after, reason, request ID, timestamp |
| Notification / OutboxEvent | recipient/scope, event, dedupe key, delivery state, retry metadata |
| JobRun / GovernanceLock / IdempotencyRecord | execution status, invariant serialization, mutation replay protection |

Credit may be derived from payment/allocation events rather than a mutable standalone balance. Cached projections must be reconcilable and never replace the authoritative ledger.

Enforce same-enrolment allocation through database constraints where practical and a single service transaction. Uniqueness constraints cover NIC lookup, student/intake enrolment, admission acceptance link, active payment per submission, and idempotency keys. Index pending queues, due instalments, scope joins, open tasks, promise dates, event timelines and purge deadlines. Use restrictive foreign keys for historical records. Never rely solely on form validation to preserve invariants.

## 14. API contracts, caching, and background work

Implement REST endpoints or equivalent typed server actions for public course listing/student entry, sessions/logout/device forgetting, student summary/history/uploads, scoped staff CRUD, admissions, fee changes, exemptions, withdrawals, receipt queues/decisions/undo, call attempts/promises/tasks, staff lifecycle, Trash, reports and exports.

Document request/response schemas and errors. Distinguish validation, unauthenticated, forbidden, missing, stale/conflict, throttled, and dependency-unavailable conditions without exposing private existence. Critical mutations accept an idempotency key and expected record version. Replaying the same key/payload returns the original result; reusing it with a different payload returns conflict. Do not expose internal stack traces.

Static caching: versioned app assets, icons, fonts, sanitized public banners, and intentionally public course metadata only. Use an allowlisted service-worker strategy. Exclude authenticated HTML/RSC responses, financial APIs, receipt endpoints, signed/private URLs, sessions and exports from browser/service-worker/CDN caches. Set appropriate private no-store headers and verify the actual framework/CDN behavior.

Short-lived in-memory query caching must key on principal, scope/version, enrolment and filters. Clear on logout/principal change. Invalidate summary, balances, reports, review/call queues, tasks and notifications after dependent mutations. Refetch on focus and after reconnect; show last-refresh/stale indicators where useful.

PWA installation is optional and must not block access. Offline mode displays a cached public shell and clear offline message. Disable approvals, uploads, financial edits and call submission offline; do not silently queue financial actions for later. Do not cache receipts for offline review.

Background jobs: Trash cleanup, upload-orphan cleanup, promise/retry task scheduling, stale-review escalation, notification delivery, exports and reconciliation checks. Use authenticated scheduler invocations, leases/locks, bounded batches, retry backoff, idempotency and error visibility. Do not depend on process-local timers surviving serverless shutdown. A missed job should catch up safely; date-derived eligibility remains correct without it.

Default notification channel is the in-app portal. Write notifications/outbox in the same transaction as the business event. Optional email/SMS adapters require configured credentials and an operator-enabled channel; no fabricated delivery, unsolicited live sends from tests, or OTP requirement. Exclude raw NIC and receipt contents from outbound messages.

## 15. Security, usability, and operational quality

Protect against IDOR, privilege escalation, SQL injection, XSS in notes/labels, CSRF, malicious file content, duplicate requests, unsafe redirects, and export injection. Escape user content; never render untrusted HTML. Keep secrets in environment configuration and provide `.env.example` containing names and explanations only.

Private receipt access should use an authenticated delivery route that rechecks current scope; if internally using signed object URLs, keep them short-lived and avoid exposing durable links. Do not leak access tokens through referrers or logs. Redact sensitive telemetry and apply sensible access-log retention. Database/application operators must have a clear backup and restore procedure, including private assets and encryption-key recovery.

Append-only audit records capture actor, action, entity, time, reason, redacted change details and request ID for fee edits, programme state, exemptions, withdrawals, receipt decisions/corrections, scope changes, staff lifecycle, exports and Trash. Student access attempts may be logged with privacy-preserving identifiers. Restrict audit visibility; do not claim cryptographic tamper-proofing unless actually implemented.

Design a polished operational product: consistent spacing/type, restrained branding, clear hierarchy, responsive tables/cards, readable contrast, large touch targets, skeletons, empty/error states, inline validation, accessible dialogs and keyboard focus. Use motion sparingly and honor reduced-motion preferences. Full receipt review and call workflows must work without gestures.

Handle slow connections, failed uploads, permission changes while a page is open, expired sessions during submission, stale queue cards, missing banners, missing phone numbers, empty datasets, and network retries gracefully. Preserve safe unsent form context in memory where possible, never persist raw receipt/NIC data to unrestricted browser storage.

Use pagination and optimized queries; avoid N+1 reads and full-dataset browser filtering. Define and measure performance budgets against seeded realistic volumes (at least 10,000 students and 50,000 instalments for query checks), while keeping production build/test fixtures isolated. Target quick page shells and sub-second common operational queries under documented test conditions, then report measured results rather than promises.

## 16. Migration and reconciliation

Provide staff-authorized CSV imports for students, enrolments and opening schedules with template download, field mapping where practical, dry-run validation, row-level errors, duplicate detection, explicit commit and audit. Super Admin controls bulk imports by default. Never silently merge NICs or overwrite payment history.

If importing prior approved receipts/opening balances, require a separate explicit historical-import mode, source reference, effective date, operator and validation. Label missing original evidence honestly. Do not create counterfeit uploaded slips or represent imported totals as newly collected today. Reconcile sample students and programme totals before production cutover.

Include a read-only integrity/reconciliation command comparing financial events, allocations, credits, instalment projections and report totals. Report discrepancies without silently editing production financial history. Document an authorized correction procedure.

## 17. Verification and acceptance tests

Use meaningful unit tests for business math/policies, integration tests against real PostgreSQL for locks and constraints, and end-to-end browser tests for core flows. Mock external providers only at adapter boundaries. Verify at mobile and desktop widths. Test authorization through direct API calls, not only hidden UI controls.

Required scenarios:

1. Matching active NIC/intake enters immediately without OTP/password; all invalid variants give the same neutral result.
2. A student with two programmes cannot access the other enrolment by changing IDs, file keys or query parameters.
3. Masked remember-device selection works without storing raw NIC client-side; Forget revokes access and removes private remnants.
4. Earliest unpaid instalment is suggested across month/year boundaries; pending evidence stays visible; advance selection works.
5. Valid upload survives reload; oversized/mismatched/corrupt uploads fail; abandoned uploads are cleaned safely.
6. Submission/review retries and double-clicks cause one business result, not duplicated payment.
7. Two reviewers concurrently approving one slip produce one payment and one controlled conflict/replay result.
8. All numerical fixtures in section 7 pass; exemptions, credits and pending/rejected submissions are correctly separated.
9. Reject requires a reason; resubmission retains old evidence/decision; undo preserves audit and handles dependencies.
10. Scope tests cover detail/list/search/count/export/receipt/duplicate-warning routes, including a shared multi-programme student.
11. Concurrent promotions/restores/activation cannot create a fourth active Super Admin. Concurrent removals cannot leave zero. Bootstrap is single-use.
12. Staff deactivation and scope changes take effect on already-open sessions; restore never revives old tokens.
13. Each call outcome creates the right immutable record/task; already-paid and promised-to-pay never change money.
14. Paid/exempt/withdrawn/held obligations leave collection queues; unrelated overdue obligations remain actionable.
15. Promise partial/full fulfilment, broken dates, supersession, waiver and approval reversal behave correctly in Colombo time.
16. Withdrawal preserves historical dues/cash/calls; future cancellation and paid-future credit are explicit and correct.
17. Trash removes entry immediately; restore works before deadline; cap/parent-child rules hold; purge at/after deadline preserves history.
18. Restore-versus-purge race cannot delete a restored banner; retries do not purge referenced assets.
19. Dashboard totals equal filtered drilldowns and reports; collection rate handles zero denominator and advance payments.
20. Service-worker/browser/CDN inspection finds no cached private receipt, raw NIC, authenticated page or financial response. Account switching never flashes prior data.
21. Job replay, downtime catch-up, outbox retries and provider failure do not duplicate tasks/notifications or roll back valid payment decisions.
22. CSV import dry-run catches duplicate NICs, invalid amounts/dates and scope errors; repeated commits are idempotent; exports neutralize formulas.
23. Access, upload and decision flows work with keyboard/screen-reader labels, reduced motion, narrow mobile screens, slow network and expired sessions.
24. Production build, lint, type checks, migrations on a clean database, upgrade migrations, and the main student-to-review-to-follow-up journey pass.

Seed only synthetic identities/contacts and sample receipt fixtures, with multiple programmes, mixed intakes, partial payments, pending/rejected receipts, sponsorships, overdue promises and Trash items. Do not seed real credentials or send notifications to real numbers.

## 18. Delivery sequence and completion criteria

Follow the proposal's frontend-first sequence, but continue through the entire working system:

1. Inspect repository/source; write requirement traceability, assumptions and implementation checklist; select compatible stack.
2. Build responsive student/staff screens and card interactions with isolated development fixtures, real domain types and complete loading/error states.
3. Implement PostgreSQL migrations, staff bootstrap/auth/scopes, NIC-course sessions, private storage and audit foundations.
4. Connect admissions, fee schedules, student receipts, review accounting, exemptions/withdrawals, calls/promises, Trash and background jobs.
5. Finish reporting, migration tools, notifications, static-only PWA caching, performance and production configuration.
6. Run tests and manual browser verification, repair discovered issues, and prepare deployment/operations handoff.

Keep a traceability file mapping PDF pages 2–10 and every major requirement here to implementation locations and acceptance tests. Explicitly record deferred optional features; do not quietly omit required modules because the UI looks finished.

Deliver source code, migrations, seed fixtures, useful tests, README setup/run instructions, `.env.example`, architecture/data-model documentation, permission matrix, assumptions, finance rules, endpoint contracts, scheduler/storage setup, backup/restore runbook, import/cutover guide, and test results. Include the documented NIC-entry risk and the exact production prerequisites still missing.

Your final implementation report should state what works, what changed, tests actually run and their outcomes, measured limitations, local run/preview instructions, and any genuine blockers. Do not claim production readiness while using mock auth, public receipt URLs, localStorage as the database, missing job scheduling, untested financial concurrency, or incomplete required workflows.

Start by inspecting the repository and proposal, then implement. The desired outcome is a complete, maintainable T2T operations system, not another proposal.
