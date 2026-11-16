# Assumptions — T2T Student Operations System

Every implementation default below is a decision this codebase made where the source proposal
was silent or where the master prompt introduced an explicit default. They are **not** mandatory
proposal requirements; every one of them is expected to remain adjustable without a data model
rewrite.

**Cross-check disclosure:** the source PDF
(`T2T_Student_Operations_System_Updated_Proposal_v2.pdf`) was **not available** in the
repository at the time these documents were written. All defaults below are derived from
`T2T_Coding_Agent_Master_Prompt.md` and the code that exists in this repository. Section
references (§N) point at that prompt. Where the prompt is silent, the row says so.

**Status legend**

| Marker | Meaning |
| --- | --- |
| **Code** | Implemented and enforced in this repository today; the value is read from the cited file. |
| **Schema** | Encoded in `src/db/schema.ts` / `drizzle/`, but the service that uses it is not implemented yet. |
| **Proposed** | Not implemented. The value is a decision to be confirmed before the feature ships. |

---

## 1. Money, currency, and time

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Currency | `LKR` only; `CURRENCY` constant | `src/lib/money.ts:3` — code change | §3 default. Cross-currency allocation is rejected at the database level. |
| Money representation | Integer **minor units** (LKR cents) in `BIGINT` columns; no binary floating point anywhere in arithmetic | `src/db/schema.ts:18` (`money()`), `src/lib/money.ts` | §3 mandates integer minor units; `assertMinor()` rejects non-safe-integers. |
| Business timezone | `Asia/Colombo` | `src/lib/time.ts:2` (`BUSINESS_TZ`) — code change | §3 mandates it for business dates and display. Colombo has no DST, so `colomboInstant()` uses a fixed `+05:30` offset. |
| Business date type | `YYYY-MM-DD` string, stored as SQL `DATE` (due dates, promise dates, transfer dates) | `src/lib/time.ts` (`BizDate`) | §3. Enables date-only comparisons without timezone drift. |
| Event instants | `timestamptz` in UTC | `src/db/schema.ts:20` (`ts()`) | §3: UTC instants for events. |
| Test clock override | `T2T_FAKE_NOW` (ISO string) pins "now" | `src/lib/time.ts:13` (`now()`) | Required for deterministic date-derived tests without waiting. Not set in production. |
| Amount rounding for percentages | Half-up on basis points: `floor((amount × bp + 5000) / 10000)` | `src/lib/money.ts:40` (`percentOf`), `src/domain/finance.ts:151` | §9 requires "deterministic minor-unit rounding". Half-up matches normal accounting expectation for percentage awards. |
| Stored currency column | Every money-bearing row carries `currency`; allocation currency must match instalment **and** payment event | `src/db/schema.ts`; trigger `payment_allocations_currency` in `drizzle/0001_integrity.sql` | §3/§7: reject cross-currency allocation. |

## 2. Financial model defaults

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Net obligation | `original_charge + Σ signed adjustments − Σ active exemptions` | `src/domain/finance.ts:39` (`computeInstalment`) | §7 formula, verbatim. |
| Approved allocations | Sum of allocations whose `reversed_at IS NULL` and whose backing payment event is an approved `RECEIPT` | `src/server/services/ledger.ts:39-40` | §7: "active allocations backed by unreversed approved payments". |
| Remaining | `net_obligation − approved_allocations` | `src/domain/finance.ts:40` | §7 formula, verbatim. |
| Enrolment credit | `unreversed verified receipts − active allocations` (no refunds in MVP) | `src/domain/finance.ts:84` | §7. Credit is derived, never a mutable balance column. |
| Invariant enforcement | `net ≥ 0`, `allocations ≥ 0`, `remaining ≥ 0`, `credit ≥ 0`; violations throw `LedgerInvariantError` and are **not** clamped in the UI | `src/domain/finance.ts:36-45,85` | §7: "Do not hide bad accounting with UI-only clamping." |
| Partial payments | Permitted and expected: one instalment may carry many allocations | `src/db/schema.ts` (`payment_allocations`), §7 fixtures 2 and 6 | §7 fixture 2 requires a partial state. |
| Fee-plan versioning | A fee plan edit creates a new `fee_plan_versions` row; existing enrolments keep their snapshot | `src/db/schema.ts:219-231`; unique index `fee_plan_current_uq` | §7: later template edits must not rewrite existing obligations. |
| Fee change application | Material changes require an impact preview and explicit application to selected enrolments | Proposed — service not implemented | §7. Recorded as `charge_adjustments` rows with kind `FEE_CHANGE`. |
| Allocation default order | Selected target instalment first; **spill-over** to other instalments only after the reviewer confirms; any excess becomes enrolment credit | `src/domain/finance.ts:108` (`planAllocation`), `:131` (`validateAllocation`) | §7 default allocation rule. Spill-over is reviewer-confirmed, never automatic. |
| Over-allocation on award/fee reduction | The excess is released atomically into enrolment credit; payment history and source attribution are preserved | `src/domain/finance.ts:150` (exemption capping); `payment_allocations.replaced_by_allocation_id` | §7: an exemption that would make allocations exceed the obligation must release the excess to credit. |
| Pending and rejected submissions | Contribute **zero** approved money; pending claims are reported separately from approved money | `src/server/services/ledger.ts:42-43` | §7. |
| Free cards and sponsorships | Reduce obligations but contribute **zero** cash; a sponsor's actual transfer is recorded separately as payment evidence | `src/db/schema.ts` (`exemption_awards` has no money-in field); `payment_events` for real transfers | §7: "a waiver must never imply money arrived." |
| Refunds | Out of MVP. A refund requirement is surfaced as an unresolved staff task (`task_type = REFUND_CONSIDERATION`), never as a payment | `src/db/schema.ts:45` | §7: never pretend a credit was paid back. |
| Reversal semantics | Reversing an incorrectly approved receipt is a **correction**, not a refund | `payment_events.kind = REVERSAL` with `reverses_event_id` | §7 wording, adopted verbatim. |
| Currency of obligation | One enrolment's obligations are single-currency; money is never moved between programmes automatically, even for the same student | DB triggers + `alloc_event_same_enrolment_fk` | §7. |

## 3. Roles, scopes, and governance

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Exactly two staff roles | `SUPER_ADMIN`, `ADMIN` | `src/db/schema.ts:25` (`staffRole`), `src/server/auth/policy.ts:8` | Mandatory proposal requirement (§4). |
| Students | Separate session type (`student_sessions`), **not** a third staff role | `src/db/schema.ts:601` | Mandatory proposal requirement. |
| Capabilities | Deny by default; eight delegable flags, seven Super-Admin-only abilities | `src/server/auth/policy.ts:11-26` | §4: "Define explicit capabilities … deny by default." |
| Programme creation | `programme.create` is a **separate** flag from `programme.manage`; a creator's scope is assigned transactionally with the creation | `src/server/auth/policy.ts:13` | §4: managing an existing course must not imply creating arbitrary new ones. |
| Super Admin count invariant | Active Super Admins ∈ [1, 3]; the cap is a fixed code constant, not an editable platform setting | `src/db/schema.ts:55-59` (`governance_lock`) | Mandatory proposal requirement (§4). |
| Super Admin serialization | Every staff lifecycle operation that affects the invariant takes `SELECT … FOR UPDATE` on the `governance_lock` row (`id = 1`) first; a plain count is not sufficient | `drizzle/0001_integrity.sql:4`; `src/db/client.ts:36` (`withTx` retries 40001/40P01) | §4 explicitly rejects an unlocked count query. |
| Pending invitations | Inactive; they do not consume an active Super Admin slot | `src/db/schema.ts:146-160` (`acceptedAt`, `revokedAt` nullable) | §4. |
| Invitation tokens | Single-use, expiring, stored only as hashes | `staff_invitations.tokenHash` + `expires_at`; `hashToken()` in `src/lib/crypto.ts:42` | §4. |
| Staff session lifetimes | 8 hours idle, 7 days absolute | `src/server/auth/staff.ts:12-13` — code change (hard-coded constants, not env-driven) | §4 requires revocation on deactivation but does not fix staff session length; 8 h idle / 7 d absolute matches an operational working day. **Diverges from the student defaults below.** |
| Auth version | `staff_accounts.auth_version` is bumped on every role/scope/capability/status change; a session whose stored version differs is rejected | `src/db/schema.ts:69`; `src/server/auth/staff.ts:50` | §4: scope and role changes take effect on the next request. |
| Bootstrap | Runs once via an operator-controlled script; there is no public unauthenticated bootstrap endpoint; reruns cannot create a fourth active account | `governance_lock.bootstrapped_at`; planned `scripts/bootstrap-super-admin.ts` | §4 and mandatory proposal requirement. |

## 4. Student identity and access

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Entry flow | NIC → selectable course/intake → immediate access to exactly one enrolment. No OTP, password, or self-registration | §5 (mandatory proposal requirement) | Mandatory. |
| Session lifetime (student) | 30 minutes idle, 12 hours absolute | `STUDENT_IDLE_MINUTES`, `STUDENT_ABSOLUTE_MINUTES` (`src/server/env.ts:14-15`) | §5 states these defaults and requires them to be configurable within sensible bounds. `env.ts` clamps them to 5–240 min idle and 30–1440 min absolute. |
| Session binding | One opaque server-side session token, bound to exactly one `enrolment_id`; a client-supplied enrolment ID never overrides session scope | `student_sessions.enrolment_id` (`src/db/schema.ts:601`) | §5. |
| NIC storage | AES-256-GCM ciphertext at rest (`nic_enc`) + keyed HMAC lookup digest (`nic_lookup`) + masked display value (`nic_masked`); no raw NIC column exists | `src/db/schema.ts:180-182`; `src/lib/crypto.ts:17-35` | §5 default data protection. The digest is keyed, so a predictable NIC is not brute-forceable from the digest alone. |
| NIC normalisation | Trim whitespace, uppercase; accept 9-digit + `V`/`X` and 12-digit formats; format validation only | `src/lib/nic.ts:3-21` | §5. Note the 9-digit check also accepts day-of-year `501–866` (the pre-2000 range). |
| NIC format equivalence | Old and new NIC formats are **never** inferred to be the same person and never auto-merged | `src/lib/nic.ts:28` (`detectNicFormat` reports format only) | §5. |
| Legacy invalid identifiers | Routed to an admin resolution queue instead of fabricating an ID | `identity_resolutions` (`src/db/schema.ts:205`) | §5. |
| Neutral error message | Invalid, inactive, unknown, and mismatched entries all return "We could not find an eligible enrolment." | §5 | §5. Implemented as `fail.notFound()` → generic "Not found." in `src/server/http.ts:28`; the student-facing copy is a UI responsibility. |
| Rate limiting | Applied per IP and per keyed identity/course attempt; no permanent account lockout an attacker could trigger | `rate_limit_buckets` (`src/db/schema.ts:695`); thresholds **Proposed** | §5: "sensible configurable thresholds and no permanent account lockout". |
| Remembered device | Opt-in, unchecked by default; random token, hashed server-side, revocable, **30 days** | `remembered_devices` (`src/db/schema.ts:611`); lifetime **Proposed** | §5: default 30 days, and "do not silently create it on shared devices". |
| Remembered-device storage | Only a masked NIC suggestion and the last intake id are retained; raw NIC is never written to localStorage/sessionStorage/IndexedDB/service-worker cache or a readable cookie | `remembered_devices.masked_nic` | §5 and mandatory proposal requirement (no raw NIC client-side). |
| "Forget this device" | Revokes device tokens, ends the student session, clears remembered selection and in-memory sensitive data | §5; proposed endpoint under `src/app/api/student/**` | §5. |
| Impersonation risk | Accepted and documented, not solved | `docs/nic-entry-risk.md` | §5 states the PDF explicitly accepts this risk and forbids marketing the entry as verified identity. |

## 5. Receipts, uploads, and files

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Accepted file types | JPEG, PNG, WebP, PDF | `src/lib/files/validate.ts:50-54` | §6 default. SVG and executables are rejected by magic-byte sniffing. |
| Maximum file size | 10 MiB (10 485 760 bytes) | `RECEIPT_MAX_BYTES` (`src/server/env.ts:13`); ceiling 50 MiB | §6: "10 MiB maximum per file, configurable". |
| Image pixel ceiling | 50 000 000 px | `DEFAULT_MAX_PIXELS` (`src/lib/files/validate.ts:45`) | §6 requires dimension limits; the prompt does not set a number. |
| Minimum image dimensions | 50 × 50 px | `MIN_IMAGE_DIMENSION` (`src/lib/files/validate.ts:47`) | Rejects stub/placeholder images that cannot show a receipt. |
| PDF page ceiling | 20 pages | `DEFAULT_MAX_PDF_PAGES` (`src/lib/files/validate.ts:46`) | §6 requires page limits; the prompt does not set a number. |
| Encrypted PDFs | Rejected (`ENCRYPTED_PDF`) | `src/lib/files/validate.ts:123-127` | §6: reject password-protected PDFs. |
| MIME verification | Declared MIME must equal the magic-byte-detected type, else `MIME_MISMATCH` | `src/lib/files/validate.ts:182-187` | §6. |
| Preview derivatives | Images only: rotated, ≤1600 px wide, WebP q80 | `PREVIEW_MAX_WIDTH` (`src/lib/files/validate.ts:48`) | §6: generate sanitized preview derivatives. PDFs are not rasterised server-side. |
| Upload flow | Upload intent → private object upload → server finalization, with the intent bound to enrolment, size limit, expiry, and a random object key | `upload_intents` (`src/db/schema.ts:383`) | §6. |
| Abandoned-upload grace period | **Proposed** 24 hours after `expires_at` before an orphan intent/asset is cleaned | `upload_intents.status = EXPIRED / CLEANED` | §6 requires "a defined grace period"; the prompt sets no number. Cleanup must not touch assets already attached to a submission. |
| Malware scanning | Adapter interface with an honest status; the default adapter is `none`, surfaced to operators as `NOT_CONFIGURED` | `MALWARE_SCANNER` (`src/server/env.ts:12`); `receipt_assets.scan` (`src/db/schema.ts:408`) | §6: "support a malware scanner adapter with its actual configured status visible to operators" — never fabricate a clean scan. |
| Transfer date | Cannot be in the future in the business timezone; unusually old transfers or amounts raise a warning for manual review, never an invented conclusion | `payment_submissions.transfer_date` (`src/db/schema.ts:424`); flags column | §6. |
| Resubmission | A rejected submission is immutable; a replacement is a new row linked by `supersedes_submission_id`, and only one active replacement may exist per rejected submission | `sub_supersedes_uq` unique index (`src/db/schema.ts:443`) | §6. |
| Submission idempotency | `(enrolment_id, idempotency_key)` is unique, so a retried submit produces one business result | `sub_idem_uq` (`src/db/schema.ts:441`) | §6/§7. |

## 6. Review workspace

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Submission state machine | `PENDING_REVIEW → APPROVED \| REJECTED`; a validated undo returns it to `PENDING_REVIEW` while retaining the decision and reversal events | `submission_status` (`src/db/schema.ts:31`); `review_action_kind` (`:32`) | §7. |
| One decision per submission version | A unique index on `(submission_id, submission_version)` plus a unique index on `payment_events.review_action_id` for `RECEIPT` rows | `drizzle/0001_integrity.sql:59`; `src/db/schema.ts:461` | §7 acceptance scenario 7: two concurrent reviewers produce one payment and one controlled conflict. |
| Review states vs settlement states | Kept separate; a single "Paid" badge never hides a pending or partial situation | `src/domain/finance.ts:13` vs `src/db/schema.ts:31` | §6/§7. |
| Quick undo window | 60 seconds, own latest decision only, same receipt version, no dependent changes | **Proposed** constant; `review.correction` is the Super-Admin-only path outside it | §8 default undo window. |
| Correction flow | Outside the quick window, a Super Admin performs a reason-required correction with a dependency preview | `SuperOnly = "review.correction"` (`src/server/auth/policy.ts:25`) | §8. |
| Review lease | Advisory only (short-lived claim to reduce collisions); database locking and version checks remain authoritative | `payment_submissions.lease_holder/lease_expires_at` (`src/db/schema.ts:434-435`) | §8 explicitly makes leases advisory. |
| Duplicate detection | Exact SHA-256 file hash + repeated bank reference with contextual fields; optional perceptual similarity. Suspicious evidence is flagged for a human — never auto-rejected | `receipt_assets.sha256` (`src/db/schema.ts:401`); `payment_submissions.flags` | §8. |
| Confirmed amount | Defaults to the claimed amount; changing it requires a reviewer reason and retains both values | `review_actions.confirmed_minor` (`src/db/schema.ts:457`), `payment_events.amount_minor` (`:471`) + `claimed_minor` (`:472`) + `amount_change_reason` (`:473`) | §7: "changing it requires a reviewer reason and retains both values." |
| One transfer across instalments | The reviewer may split the allocation; the student selects the primary intended period | `payment_allocations` rows per instalment | §6. |
| Reject | Requires a trimmed non-empty reason | `review_actions.reason` (`src/db/schema.ts:454`) | §8. |
| Skip | No financial or status mutation; the item reappears in a later session and queue counts stay accurate | No row written | §8. |

## 7. Follow-ups, calls, and promises

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Queue scope | Only active enrolled students with a currently due/overdue positive collectible balance; withdrawn/inactive, fully exempt, paid, and trashed courses are excluded | §10; `enrolment_status` (`src/db/schema.ts:29`) | §10. |
| One card per enrolment | A card is one student-enrolment, never a merged multi-programme debt | `follow_up_tasks.enrolment_id` (`src/db/schema.ts:518`) | §10. |
| Retry policy | At most one scheduled collection attempt per enrolment per business day | `follow_up_tasks.dedupe_key` (`:529`), e.g. `COLLECTION_CALL:<enrolment>:<yyyy-mm-dd>` | §10 default retry policy. |
| Escalation | After three consecutive no-answer outcomes, create an escalation task and pause automatic retries pending staff action | `call_outcome = NO_ANSWER` (`src/db/schema.ts:42`); `task_type = ESCALATION` (`:45`) | §10. |
| Contact window | 09:00–17:00 local, business days only; holidays come from an explicit table, never inferred from weekday logic | `business_holidays` (`src/db/schema.ts:588`) | §10. |
| Manual override | Requires a reason | `call_attempts.manual_override_reason` (`src/db/schema.ts:581`) | §10. |
| Pending-evidence hold | An instalment under review is temporarily held from collection calls; other overdue instalments of the same enrolment stay eligible | §10; `ledger.ts:42-43` | §10. |
| Stale review | After 48 hours pending, escalate to a staff review task rather than pretending the payment was rejected | `task_type = STALE_REVIEW` (`src/db/schema.ts:45`); 48 h is the §10 default | §10. |
| Promise fulfilment | Based on approved allocations past the promise baseline toward its target obligations — never on upload or claimed amount | `payment_promises.baseline_allocated_minor` (`src/db/schema.ts:551`), `fulfilled_minor` (`:552`) | §10. |
| Promise states | `OPEN`, `PARTIALLY_FULFILLED`, `FULFILLED`, `BROKEN`, `SUPERSEDED`, `CANCELLED` | `promise_state` (`src/db/schema.ts:43`) | §10. |
| Promise expiry | Kept due on the due date; the unmet remainder is marked broken after the local day ends | §10 | §10. |
| Task de-duplication | Business dedupe key with an idempotent upsert | `task_dedupe_uq` (`src/db/schema.ts:539`) | §10. |
| Call attempt idempotency | `(operator_id, client_attempt_id)` is unique, so a retried save does not double-record | `call_attempt_client_uq` (`src/db/schema.ts:584`) | §10 and acceptance scenario 13. |
| `tel:` links | Opening the device dialer is **not** evidence a call happened; the operator explicitly saves the outcome | `call_attempts` requires an explicit outcome row | §10. |

## 8. Admissions, programmes, and enrolments

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Admission states | `DRAFT`, `UNDER_REVIEW`, `ACCEPTED`, `REJECTED`, `WAITLISTED`, `WITHDRAWN` | `admission_state` (`src/db/schema.ts:30`) | §9 default states. |
| Admission acceptance | Creates or reuses the confirmed student, creates one enrolment, snapshots the fee plan, and generates instalments + exemptions in a single idempotent transaction | `admissions.enrolment_id` (`src/db/schema.ts:285`) + unique index `admission_enrolment_uq` (`:292`) | §9: repeated acceptance must not create another enrolment or fee schedule. |
| Enrolment states | `ACTIVE`, `COMPLETED`, `WITHDRAWN`, `INACTIVE` — one canonical active representation, no parallel booleans | `enrolment_status` (`src/db/schema.ts:29`) | §9. |
| Enrolment uniqueness | One enrolment per (student, intake) | `enrolment_student_intake_uq` (`src/db/schema.ts:265`) | §9. Re-enrolment reactivates or follows a documented repeat-enrolment policy rather than duplicating history. |
| Fee-plan items | Monthly or custom instalments with an explicit amount, period label, due date, sequence, and fee component; instalment identifiers stay stable even when labels change | `fee_plan_items` (`src/db/schema.ts:233`); `instalments.fee_plan_item_id` (`:309`) | §9. |
| Instalment identity | `sequence` is unique within an enrolment; the id never changes | `instalment_seq_uq` (`src/db/schema.ts:319`) | §9. |
| Contact verification | Entering a phone or email does **not** mark it verified | `students.phone_verified_at` / `email_verified_at` nullable (`src/db/schema.ts:188-190`) | §9. |
| Duplicate student creation | Show a permitted existing match or a generic duplicate-resolution message; never auto-merge | `student_nic_lookup_uq` (`src/db/schema.ts:200`) | §9. |
| Withdrawal | Reason + effective business date; past and current dues are retained; unpaid future obligations whose due date falls after the effective date are cancelled via `WITHDRAWAL_CANCEL` adjustments; already-paid future obligations become enrolment credit plus an unresolved refund-consideration task | `charge_adjustments.kind = WITHDRAWAL_CANCEL` (`src/db/schema.ts:35`); `enrolments.withdrawal_*` (`:257-259`) | §9. |
| Waiver of retained arrears | Only via an explicit authorized exemption | `exemption_type = ARREARS_WAIVER` (`src/db/schema.ts:36`) | §9. |
| Reactivation | Requires a schedule preview; historical charges are never blindly regenerated | `adjustment_kind = REACTIVATION` (`src/db/schema.ts:35`) | §9. |
| Exemption award shape | Reason, approver, effective range, target instalments/components, type and value; fixed amount or percentage with a cap; overlapping awards are previewed and never stack above the charge | `exemption_awards` (`src/db/schema.ts:342`); `exemption_amount_for` (`src/domain/finance.ts:150`) | §9. |
| Exemption revocation | Auditable reversal (`exemption_applications.reversed_at`), never deletion | `src/db/schema.ts:371-374` | §9. |

## 9. Trash and retention

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Trash window | 30 days; `purge_after = trashed_at + 30 days`; restore is available strictly **before** that instant | `purge_after` on `programmes`/`intakes`/`staff_accounts` (`src/db/schema.ts:94,122,74`) | Mandatory proposal requirement (§12). |
| No permanent delete | There is no "Delete Permanently" button and no equivalent public destructive API | By design | Mandatory proposal requirement (§12). |
| Trash metadata | `trashed_at`, `trashed_by`, reason, `purge_after`, restore events, purge status | `purge_status` enum (`src/db/schema.ts:46`) | §12. |
| Trashed parent | Trashing a programme makes child intakes unavailable **without** overwriting each child's independent Trash state; restoring a parent does not resurrect an independently trashed intake | `intakes.trashed_at` independent of `programmes.trashed_at` (`src/db/schema.ts:120` vs `:93`) | §12. |
| Operational suspension | Mutations against trashed programmes/intakes fail with a conflict | `assertOperational()` (`src/server/auth/policy.ts:109`) | §12. |
| Obligations survive Trash | Trashing configuration does **not** cancel financial obligations | No code path links `trashed_at` to adjustments | §12. |
| Purge scope | Removes only eligible disposable configuration/media/personal account fields; tombstones keep immutable IDs and minimal historical labels; foreign keys from payments, enrolments, students, receipts, reviews, call attempts, and audit events never cascade | `onDelete: "restrict"` throughout `src/db/schema.ts` | §12. |
| Receipts and financial history | Not governed by the 30-day Trash rule | `payment_events`, `payment_allocations`, `receipt_assets` have no `trashed_at` | §12. |
| Asset deletion safety | Object reference checks before media deletion; purge claims due records transactionally, marks purge state, and retries external deletion idempotently | `purge_status` transitions (`src/db/schema.ts:46`) | §12. |
| Staff Trash | Immediately deactivates and revokes access; restore rechecks the authorizer, last-active rule, and the three-active cap transactionally | `staff_accounts.status`/`trashed_at` (`src/db/schema.ts:66,71`); `revokeAllStaffSessions()` (`src/server/auth/staff.ts:92`) | §12. |

## 10. Reporting and exports

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Money vocabulary | Collected money is "approved receipts" or "collections" — never formal accrual revenue | Reporting copy | §11: do not imply formal accrual revenue recognition. |
| Cash reporting basis | Recorded approval events **less** reversal events within the selected range, with gross approvals and corrections both visible | `payment_events.kind` + `effective_date` (`src/db/schema.ts:469,478`) | §11. |
| Credit application | Applying existing credit creates no new collection | `allocation_source = CREDIT_APPLY` (`src/db/schema.ts:34`) | §7/§11. |
| As-of reporting | Historical snapshots use effective event dates, never today's balances applied to a past date | `payment_events.effective_date` | §11. |
| Collection rate | `Σ min(allocated, net) for instalments due ≤ as-of ÷ Σ net for those same instalments`; future obligations and allocations are excluded; a zero denominator displays "N/A" | `src/domain/finance.ts:159` (`collectionRate`) | §11, verbatim. |
| Ageing buckets | 1–30, 31–60, 61–90, 91+ days past due; not-yet-due instalments are unassigned | `src/domain/finance.ts:170` (`ageingBucket`) | §11. |
| NIC masking in exports | Masked by default | `students.nic_masked` (`src/db/schema.ts:182`) | §11. |
| Full-identifier export | Super Admin only, and audited | `SuperOnly = "exports.full_identifiers"` (`src/server/auth/policy.ts:25`); `export_jobs.full_identifiers` (`src/db/schema.ts:706`) | §11 and §4. |
| Formula-injection neutralisation | Every user-controlled cell is prefixed when it begins with `=`, `+`, `-`, `@`, tab, or CR | `neutralizeCell()` (`src/lib/csv.ts:1`) | §15/§11. |
| Large exports | Run as a background job producing a short-lived private download, with permission rechecked at delivery | `export_jobs` (`src/db/schema.ts:703`) | §11. |
| Metric/drill-down parity | Counts and drill-downs use the same shared query definitions and the current scope | Proposed — reporting service not implemented | §11. |

## 11. API, caching, and background work

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Error taxonomy | `VALIDATION` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `STALE` 409, `THROTTLED` 429, `DEPENDENCY_UNAVAILABLE` 503, `IDEMPOTENCY_MISMATCH` 422, `INTERNAL` 500 | `src/server/http.ts:7-13` | §14. |
| Not-found semantics | Out-of-scope records return the same `NOT_FOUND` as genuinely missing records | `fail.notFound()` (`src/server/http.ts:28`); `enrolmentInScope()` (`src/server/auth/policy.ts:101`) | §4/§5: never reveal existence. |
| Idempotency header | `Idempotency-Key` is required on critical mutations, 8–200 characters | `idempotencyKey()` (`src/server/http.ts:77`) | §14. |
| Replay semantics | Replaying the same key and payload returns the original result; the same key with a different payload is a conflict | `idempotency_records` primary key `(scope, key)` + `request_hash` (`src/db/schema.ts:686`) | §14. |
| CSRF | Mutations send `x-csrf-token`, rendered by the staff layout as `<meta name="csrf-token">`; same-origin is asserted when an `Origin` header is present | `requireStaff()` (`src/server/auth/staff.ts:69`); `assertSameOrigin()` (`:80`) | §15. |
| Private caching | Financial, receipt, session, and export responses carry `Cache-Control: private, no-store, max-age=0` | `PRIVATE_HEADERS` (`src/server/http.ts:43`) | §14. |
| Static caching | Versioned assets, icons, fonts, sanitized public banners, and intentionally public course metadata only; an allowlisted service-worker strategy | Proposed — service worker not implemented | §14 (mandatory static-caching requirement). |
| PWA | Optional install; offline shows a cached public shell and a clear offline message; approvals, uploads, financial edits, and call submission are disabled offline | Proposed | §14. |
| Notification channel | In-portal by default; notifications and the outbox row are written in the **same transaction** as the business event, deduplicated by key | `notify()` (`src/server/audit.ts:44`); `notifications.dedupeKey` (`src/db/schema.ts:650`) | §14. |
| Email/SMS | Opt-in adapters only; disabled unless credentials **and** an operator-enabled flag are present; no fabricated delivery and no OTP | `EMAIL_ENABLED`, `SMS_ENABLED` (`.env.example:29-30`) | §14. |
| Background jobs | Scheduler-invoked with leases, bounded batches, retry backoff, idempotency, and visible failures; a missed job catches up safely and date-derived eligibility stays correct without it | `job_runs`, `job_leases` (`src/db/schema.ts:669,680`) | §14. |
| Scheduler transport | `Authorization: Bearer $CRON_SECRET` on every cron route; Vercel Cron sends this header automatically when `CRON_SECRET` is set on the project | `CRON_SECRET` (`src/server/env.ts:9`); `docs/scheduler-storage-setup.md` | §14. |
| Job batching | **Proposed** bounded batches per run with a lease per job; the prompt requires bounded batches but sets no size | `job_leases` | §14. |

## 12. Data model, security, and operations

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Append-only history | `audit_events`, `review_actions`, `call_attempts`, `payment_events`, `charge_adjustments` reject UPDATE and DELETE at the database level | `t2t_forbid_mutation()` triggers (`drizzle/0001_integrity.sql:8-23`) | §13: never delete history. |
| Allocation immutability | Amounts and links on `payment_allocations` are immutable; only a one-time reversal marker may be set | `t2t_allocation_guard()` (`drizzle/0001_integrity.sql:25-40`) | §13. |
| Student reference | Stable internal reference (`T2T-…`), unique | `student_ref_uq` (`src/db/schema.ts:199`) | §13. |
| Password hashing | scrypt with N=2^15, r=8, p=1, 16-byte salt, 32-byte output; stored as `scrypt$N$salt$hash` | `src/lib/crypto.ts:56-67` | §15. No default production password exists. |
| Secrets | Environment configuration only; `.env.example` holds names and explanations, never values | `.env.example` | §15. |
| Audit redaction | Keys matching `nic`, `password`, `token`, `secret`, `hash` are redacted unless they contain `masked` | `redact()` (`src/server/audit.ts:8`) | §15. |
| Audit is not tamper-proof | Audit rows are append-only and DB-guarded, but the platform does **not** claim cryptographic tamper-evidence | `docs/assumptions.md` §12 | §15: "do not claim cryptographic tamper-proofing unless actually implemented." |
| Verification scale | Performance checks target at least 10 000 students and 50 000 instalments, seeded as synthetic data isolated from production | §15 target, **Proposed** harness | §15. Numbers are a measurement target, not a measured result. |
| Backup scope | PostgreSQL (logical dump or provider point-in-time restore) **plus** private receipt objects **plus** the three application keys | `docs/backup-restore-runbook.md` | §15: "including private assets and encryption-key recovery". |
| Key escrow | `NIC_ENCRYPTION_KEY`, `NIC_LOOKUP_KEY`, and `SESSION_SECRET` are escrowed separately from the database backup, with a rotation procedure | `docs/backup-restore-runbook.md` | §15. |
| Currency of truth | The authoritative ledger is the event/allocation tables; any cached projection must be reconcilable and must never replace it | `src/server/services/ledger.ts` | §13. |
| Reconciliation | A read-only integrity/reconciliation command compares financial events, allocations, credits, instalment projections, and report totals and reports discrepancies without editing production history | Planned `scripts/reconcile.ts` (§16) | §16. |

## 13. Scope boundaries

| Assumption | Value | Where adjustable | Rationale |
| --- | --- | --- | --- |
| Not built | LMS, exam platform, attendance tracking, payroll, AI chatbot, payment gateway, automatic bank reconciliation, WhatsApp bot, call recording | Out of scope by design | §2 explicitly forbids expanding the system into these. |
| Manual payment evidence | Bank payment is evidenced by a human-uploaded receipt and reviewed by a human | `payment_submissions` workflow | §2: manual evidence plus human review is the core workflow. |
| No student self-service for money | Students cannot edit identity or fees in MVP | Staff-only corrections with audit | §9. |

---

## Change control

1. A row is edited in place when the value changes; the newest dated line wins.
2. Every row names the **exact** place to change the value (env var, schema constant, or
   `file.ts`).
3. If a value appears in code and in this document, the document is regenerated from the code —
   it is never used as the source of truth.
4. Conflicts with a mandatory proposal requirement are recorded here with the resolution, not
   silently deleted.
