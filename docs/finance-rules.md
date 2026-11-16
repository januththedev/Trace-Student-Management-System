# Finance Rules — T2T Student Operations System

All money arithmetic for this system lives in **one** place: `src/domain/finance.ts`
(pure functions) and `src/server/services/ledger.ts` (the projection that reads the
authoritative tables). Dashboards, exports, queues, and detail screens all derive from these,
so they cannot disagree (§3).

> **Cross-check disclosure:** the source PDF was not available in the repository when this
> document was written. It is derived from `T2T_Coding_Agent_Master_Prompt.md` §7 and §11 and
> from the code in this repository. §N references point at that prompt.

---

## 1. Ground rules

| Rule | Value |
| --- | --- |
| Representation | Integer **minor units** (LKR cents) everywhere — persistence and arithmetic. `assertMinor()` rejects anything that is not a safe integer (`src/lib/money.ts:5`). |
| No floats | No binary floating-point currency arithmetic, ever. User input is parsed with `BigInt` (`parseMajorToMinor`, `src/lib/money.ts:11`). |
| Currency | Explicit `currency` column on every money-bearing row. Cross-currency allocation is rejected by a database trigger (`drizzle/0001_integrity.sql:44-55`). |
| Business dates | `YYYY-MM-DD` in `Asia/Colombo` (`src/lib/time.ts:2`). Due dates, transfer dates, and promise dates are SQL `DATE`. |
| Authoritative ledger | `payment_events` + `payment_allocations` + `charge_adjustments` + `exemption_applications`. Any cached projection must be reconcilable and never replaces the ledger (§13). |
| Append-only | Money history is never deleted or edited. Corrections are new rows (`drizzle/0001_integrity.sql:8-40`). |
| Not clamped | A negative net obligation, allocation, remaining, or credit is an error (`LedgerInvariantError`), never a value quietly adjusted for display (§7). |

---

## 2. Core formulas

For each instalment:

```
net_obligation       = original_charge + Σ signed_charge_adjustments − Σ active_exemptions
approved_allocations = Σ allocations (reversed_at IS NULL) backed by unreversed approved payments
remaining            = net_obligation − approved_allocations
```

For the enrolment:

```
enrolment_credit = Σ unreversed verified receipts − Σ active allocations
```

Source: `src/domain/finance.ts:38-45` (`computeInstalment`) and `:77-90` (`summarize`).

Enforced invariants — each throws `LedgerInvariantError` if violated:

| Invariant | Check |
| --- | --- |
| `net_obligation ≥ 0` | `finance.ts:41` |
| `approved_allocations ≥ 0` | `finance.ts:42` |
| `remaining ≥ 0` | `finance.ts:43` |
| `enrolment credit ≥ 0` | `finance.ts:85` (allocations may never exceed receipts) |

### 2.1 Which rows count as what

| Quantity | Included | Excluded |
| --- | --- | --- |
| Original charge | `instalments.original_charge_minor` (≥ 0, DB check) | — |
| Adjustments | Every `charge_adjustments` row for the instalment, signed; `reverses_id IS NULL` rows counted, the reversal row itself is what cancels the original | A reversed adjustment contributes 0 net |
| Exemptions | `exemption_applications` where `reversed_at IS NULL` | Revoked awards and reversed applications |
| Allocations | `payment_allocations` where `reversed_at IS NULL` | Reversed allocations |
| Pending claimed | `payment_submissions` with `status = 'PENDING_REVIEW'`, summed by `claimed_minor` over the target instalment | Approved, rejected, and historical-import rows |
| Receipts (cash) | `payment_events` where `kind IN ('RECEIPT','HISTORICAL_IMPORT')` minus `kind = 'REVERSAL'` | Pending and rejected submissions contribute **nothing** |

Ledger query: `src/server/services/ledger.ts:28-49`.

---

## 3. Instalment states

Seven derived states (`InstalmentState`, `src/domain/finance.ts:13`). They are **derived**, not
stored, and are computed for any business date without a nightly job (§7).

| State | Meaning |
| --- | --- |
| `UPCOMING` | Not yet due, nothing allocated, positive remaining. |
| `DUE_TODAY` | Business date **equals** the due date and remaining > 0. Due today is **not** overdue. |
| `OVERDUE` | Business date is **strictly later** than the due date and remaining > 0. |
| `PARTIALLY_PAID` | Something is allocated, remaining > 0, and the instalment is not yet due. |
| `PAID` | Remaining = 0, or net obligation = 0 with no exemption-only classification. |
| `EXEMPT` | Net obligation = 0 because of an exemption, with nothing allocated and no cancellation adjustment. |
| `CANCELLED` | Net obligation = 0 because of a cancellation adjustment (for example a withdrawal). |

### 3.1 Exact derivation order

`deriveState()` in `src/domain/finance.ts:47-58` evaluates in this order. The first match wins:

1. `net === 0`:
   - a cancellation adjustment is present → `CANCELLED`
   - otherwise exemptions > 0 **and** allocations === 0 → `EXEMPT`
   - otherwise → `PAID`
2. `remaining === 0` → `PAID`
3. `today > dueDate` → `OVERDUE`
4. `today === dueDate` → `DUE_TODAY`
5. `allocated > 0` → `PARTIALLY_PAID`
6. otherwise → `UPCOMING`

### 3.2 Consequences operators must know

- **An overdue partial payment shows as `OVERDUE`, not `PARTIALLY_PAID`.** Both facts remain
  available through the separate helpers `isPartial()`, `isDueNow()`, and `isOverdue()`
  (`src/domain/finance.ts:61-63`). Any UI that shows a single badge must not let "Overdue"
  hide that part of the amount is already paid.
- **A fully waived instalment that already had an allocation reads `PAID`, not `EXEMPT`**, because
  the excess was released into enrolment credit — see fixture 6.
- **A withdrawn future instalment reads `CANCELLED`** (a `WITHDRAWAL_CANCEL` adjustment), not
  `PAID` — the two are financially different and must not be conflated.
- Review state and settlement state are **separate dimensions**. A submission may be
  `PENDING_REVIEW` while the instalment it targets still shows `PARTIALLY_PAID`; a single "Paid"
  badge must never hide a pending or partial situation (§6).

---

## 4. Enrolment summary values

`summarize()` — `src/domain/finance.ts:77-90`. Each value is distinct and is displayed
separately; they are not collapsed into one "balance".

| Value | Definition |
| --- | --- |
| `netObligationMinor` | Σ net obligations across the enrolment's instalments. |
| `approvedAllocatedMinor` | Σ active allocations. |
| `pendingClaimedMinor` | Σ claimed amounts of submissions still `PENDING_REVIEW`. |
| `creditMinor` | Unreversed verified receipts − active allocations. Never negative. |
| `outstandingMinor` | Σ remaining across **all** instalments, including future dues. |
| `dueNowMinor` | Σ remaining where `dueDate <= today`. |
| `overdueMinor` | Σ remaining where `dueDate < today`. |
| `collectedMinor` | Unreversed verified receipts (cash actually recognised). |
| `settled` | `outstanding === 0` — the whole plan is settled; the UI shows a completed state rather than inventing another charge (§6). |

Money already sitting in **credit** is shown to the student before they upload more evidence,
and applying credit is never counted as newly collected money (§7).

---

## 5. Review state machine

```
                 ┌─────────────── UNDO (validated, ≤60 s quick window)
                 │
PENDING_REVIEW ──┼──► APPROVED   (payment + allocations + decision + audit + notification, atomically)
                 │
                 └──► REJECTED   (reason required; original evidence preserved immutably)
```

| Transition | Rules |
| --- | --- |
| `PENDING_REVIEW → APPROVED` | Validates fresh state and evidence readiness, confirms the allocation, then commits the payment event, the allocations, the decision, the audit row, and the notification outbox event in **one** transaction. |
| `PENDING_REVIEW → REJECTED` | Requires a trimmed, non-empty reason. The original evidence is preserved. The item advances in the review queue. |
| `APPROVED → PENDING_REVIEW` (undo) | Reverse through append-only events. Never delete the original action. The decision history is retained. |
| `REJECTED → new submission` | A resubmission creates a **new** row linked by `supersedes_submission_id`; only one active replacement may exist per rejected submission (unique index `sub_supersedes_uq`, `src/db/schema.ts:443`). The whole chain is shown. |

Supporting guarantees:

- **One decision per submission version** — unique index `review_action_version_uq` on
  `(submission_id, submission_version)` (`src/db/schema.ts:461`).
- **One receipt per approval** — unique index `pe_receipt_review_action_uq` on
  `payment_events(review_action_id) WHERE kind = 'RECEIPT'` (`drizzle/0001_integrity.sql:59`).
- **Skip** performs no financial or status mutation. The item reappears in a later session and
  queue counts remain accurate.
- **"Not Submitted"** is a presentation state for an obligation that has no submission. It is
  never a fabricated submission row.

---

## 6. Allocation rules

### 6.1 Default allocation

`planAllocation()` — `src/domain/finance.ts:108-128`.

1. Allocate to the **selected target instalment first**, up to its remaining amount.
2. Only if the reviewer confirms **spill-over**, continue to the other eligible instalments of
   the same enrolment, ordered by due date then sequence.
3. Any amount left over becomes **enrolment credit** for that enrolment, clearly labelled as
   unapplied.

Money is never moved across programmes automatically, even for the same student (§7).

### 6.2 Reviewer-edited allocation

`validateAllocation()` — `src/domain/finance.ts:131-147` rejects:

- a line pointing at an instalment outside the enrolment,
- a duplicated instalment line,
- a non-positive line amount,
- a line exceeding that instalment's remaining amount,
- a total exceeding the confirmed amount.

### 6.3 Confirmed amount

The confirmed amount defaults to the claimed amount. Changing it requires a reviewer reason and
**retains both values** — `payment_events.amount_minor` (confirmed) alongside
`payment_events.claimed_minor` and `payment_events.amount_change_reason`
(`src/db/schema.ts:471-473`).

### 6.4 Allocation sources

`allocation_source` (`src/db/schema.ts:34`): `SUBMISSION`, `CREDIT_APPLY`,
`EXEMPTION_REALLOCATION`, `HISTORICAL_IMPORT`. Only `SUBMISSION` and `HISTORICAL_IMPORT`
represent cash received; `CREDIT_APPLY` moves money already received, and
`EXEMPTION_REALLOCATION` moves an existing allocation to a smaller obligation.

### 6.5 Allocations are immutable

Amounts and links on `payment_allocations` cannot be updated or deleted; only a one-time
reversal marker may be set (`drizzle/0001_integrity.sql:25-40`).

---

## 7. Exemptions and waivers

### 7.1 Amount

`exemptionAmountFor()` — `src/domain/finance.ts:150-156`:

```
FIXED :  raw = value
PERCENT: raw = floor((charge_base × basis_points + 5000) / 10000)     // half-up, deterministic
capped : amount = min(raw, charge_base − already_exempted, cap)      // never exceeds the charge
```

`PERCENT` values are stored in basis points (10 000 = 100%); the database rejects a percentage
above 100 (`src/db/schema.ts:361`).

### 7.2 Rules

| Rule | Detail |
| --- | --- |
| Shape | Reason, approver, effective range (`effective_from` / `effective_to`), target instalments/components, type and value. Types: `FREE_CARD`, `SPONSORSHIP`, `DISCOUNT`, `ARREARS_WAIVER` (`src/db/schema.ts:36`). |
| Overlap | Previewed before committing; awards never stack above the charge. |
| Revocation | Auditable reversal (`exemption_applications.reversed_at` + `reversal_reason`), never deletion. |
| After payment | Releasing allocation to credit or restoring an obligation is shown as an impact preview before it commits. |
| Cash | A free card or sponsorship reduces the obligation but contributes **zero cash**. A sponsor's actual transfer is recorded separately as payment evidence if it arrives. A waiver must never imply money arrived. |

### 7.3 Release of excess into credit

When an exemption or fee reduction would make existing allocations exceed the new obligation,
the excess is **released atomically into that enrolment's credit**, preserving payment history
and source attribution. Concretely: net obligation = 10 000, allocations = 4 000, then an
8 000 waiver ⇒ net = 2 000, the allocation is reduced to 2 000, and 2 000 moves to credit.
See fixture 6.

---

## 8. Withdrawal

| Aspect | Rule |
| --- | --- |
| Inputs | Reason and effective business date (`enrolments.withdrawal_effective_date`, `withdrawal_reason` — `src/db/schema.ts:258-259`). |
| Preview | Affected obligations and calls are previewed before anything commits. |
| Past and current dues | **Retained** by default. |
| Future unpaid obligations | Cancelled only when the due date falls **after** the effective date, via a recorded `WITHDRAWAL_CANCEL` adjustment — never by deleting rows. |
| Future obligations already paid | The resulting enrolment credit and the unresolved refund consideration are shown explicitly. Cash is never erased. |
| Retained arrears | Waivable **only** through an explicit authorized exemption (`ARREARS_WAIVER`). |
| Access and tasks | Student access is suspended and reminder tasks are paused as appropriate. |
| Reactivation | Requires a schedule preview. Historical charges are never blindly regenerated (`adjustment_kind = REACTIVATION`). |

---

## 9. Reversals, undo, and correction

| Concept | Meaning |
| --- | --- |
| **Reversal** | A `payment_events` row with `kind = 'REVERSAL'` and `reverses_event_id` pointing at the original event. It is a **correction of an incorrectly approved receipt**, not a refund (§7). |
| **Reversal of an allocation** | The allocation keeps its amount and link; only `reversed_at` / `reversed_by` / `reversal_reason` are set. The row is never deleted. |
| **Quick undo** | Default window **60 seconds**; only the reviewer's own latest decision; the same receipt version; no dependent changes. |
| **Controlled correction** | Outside the quick window, a Super Admin (`review.correction`) performs a reason-required correction with a dependency preview. There is no unrestricted rollback of another reviewer's subsequent work. |
| **Undo with a downstream dependency** | If the credit produced by an approval has since been allocated elsewhere, the quick undo is **blocked**; the correction preview must include those linked allocations, or the controlled correction flow is required. |
| **Atomicity** | Reversing allocations and the credited amount happens in one transaction. The original evidence and the audit trail are kept. |

Refunds are **outside MVP**. Any refund or reconciliation requirement is surfaced as an
unresolved staff task (`task_type = REFUND_CONSIDERATION`); a credit is never presented as
having been paid back.

---

## 10. Worked fixtures (§7) and expected numbers

These are the acceptance targets from §7. The amounts below are LKR; the minor-unit value is
given in parentheses. The expected values are produced by `computeInstalment()`,
`summarize()`, `planAllocation()`, and `exemptionAmountFor()`.

### Fixture 1 — obligation 10 000, claim 10 000 pending

| Value | Expected |
| --- | --- |
| Net obligation | 10 000 (1 000 000) |
| Approved allocations | 0 |
| Remaining | 10 000 (1 000 000) |
| Pending claimed | 10 000 (1 000 000) |
| Collected | 0 |
| Credit | 0 |

A pending submission contributes no approved money.

### Fixture 2 — approve 4 000

| Value | Expected |
| --- | --- |
| Collected | 4 000 (400 000) |
| Approved allocations | 4 000 (400 000) |
| Remaining | 6 000 (600 000) |
| Credit | 0 |
| State | Partial. `PARTIALLY_PAID` while the instalment is not yet due; `OVERDUE` if the due date has passed, with `isPartial()` still true. |

### Fixture 3 — reject a further 6 000

| Value | Expected |
| --- | --- |
| Remaining | **6 000** — unchanged |
| Collected | 4 000 — unchanged |
| Approved allocations | 4 000 — unchanged |
| Credit | 0 |

A rejected submission contributes zero approved money and does not touch the balance.

### Fixture 4 — approve 7 000 against a remaining of 6 000

| Value | Expected |
| --- | --- |
| Allocated | 6 000 (600 000) |
| Credit | 1 000 (100 000) |
| Total collected | 11 000 (1 100 000) = 4 000 + 7 000 |
| Net obligation | 10 000 |
| Remaining | 0 — obligation settled |
| State | `PAID` |

The 1 000 excess is **unapplied credit within that enrolment**, not a refund and not revenue.

### Fixture 5 — fully waive a new 10 000 obligation

| Value | Expected |
| --- | --- |
| Net obligation | 0 |
| Cash collected | 0 |
| Credit | 0 |
| State | `EXEMPT` |
| Collection call | **None** — a fully covered exemption is excluded from collection queues |

### Fixture 6 — allocate 4 000 to a 10 000 obligation, then waive 8 000

| Value | Expected |
| --- | --- |
| Net obligation | 2 000 (200 000) = 10 000 − 8 000 |
| Retained allocation | 2 000 (200 000) — reduced from 4 000 |
| Released to enrolment credit | 2 000 (200 000) |
| Collected (cash) | **4 000** (400 000) — unchanged by the waiver |
| Remaining | 0 |
| Credit | 2 000 = receipts 4 000 − allocations 2 000 |

### Fixture 7 — undo an approval

| Requirement | Expected |
| --- | --- |
| Active allocations of that approval | Reversed atomically |
| Credited amount | Reversed atomically |
| Original evidence | Retained (the submission and its asset are immutable history) |
| Audit | Retained; the undo is an appended `review_actions` row of kind `UNDO`, not a delete |
| Downstream dependency | If the credit has since been allocated, the quick undo is blocked and the correction preview must include those linked allocations, or the controlled correction flow is used |

---

## 11. Reporting definitions

### 11.1 Vocabulary

Collected money is called **"approved receipts"** or **"collections"**. It is never described as
formal accrual revenue, and the platform does not perform revenue recognition (§11).

### 11.2 Cash reporting basis

Default cash reporting = **recorded approval events minus reversal events** within the selected
range, with **gross approvals and corrections both visible**. Applying old credit creates no
new collection.

| Report | Basis |
| --- | --- |
| Payment receipts by approval date | `payment_events` with `kind = 'RECEIPT'` (and `HISTORICAL_IMPORT`, labelled) grouped by approval date |
| Cash corrections by reversal date | `payment_events` with `kind = 'REVERSAL'` grouped by reversal date |
| Transfer-date view | Clearly labelled as a **transfer date** view, separate from the approval-date view |
| Allocations by instalment | `payment_allocations` grouped by instalment, excluding reversed rows |
| Enrolment credit | receipts − allocations per enrolment |
| Outstanding / overdue balances | From the ledger projection (§2) |
| Ageing buckets | 1–30, 31–60, 61–90, 91+ days past due; not-yet-due instalments are unassigned (`src/domain/finance.ts:170-177`) |
| Exemptions | `exemption_awards` / `exemption_applications` by type and period |
| Programme / intake totals | Sum of the above, within the current scope |
| Review throughput | Approve / reject / undo counts over a period |
| Follow-up outcomes | `call_attempts.outcome` distribution over a period |

Historical / as-of reports must use **effective event dates**, never today's balances applied
to a past date.

### 11.3 Collection rate

```
collection_rate = Σ min(approved_allocations, net_obligation)   for instalments with due_date ≤ as_of
                ÷ Σ net_obligation                              for those same instalments
```

Source: `collectionRate()` — `src/domain/finance.ts:159-167`.

- Future obligations **and** future allocations are excluded from both sides of the ratio.
- A **zero denominator displays "N/A"** — the function returns `rate: null`. Never divide by
  zero, never display `NaN`, and never display `0%` for an empty obligation set.
- Advance payments against a not-yet-due instalment do not inflate the rate for obligations that
  are already due.
- An all-plan settlement view may be offered separately; it is not a substitute for the rate.

### 11.4 Dashboard metric definitions

| Metric | Definition |
| --- | --- |
| Total registered students | Distinct people visible **within scope**. A Super Admin's total includes unassigned records; a scoped Admin's does not. |
| Active students | Distinct people with at least one visible active enrolment; the enrolment count is shown separately. |
| Active programmes | Distinct active programmes with applicable visible scope. |
| Free / sponsored students | Distinct students with effective awards in the selected period and scope. |
| Pending / rejected slips | Submission counts by current review state. Historical decision counts are retained separately. |
| Students with dues | Distinct students with visible due/overdue remaining balances, listing the relevant enrolments. |
| Outstanding amount | All active remaining obligations, **including future dues**; due-now and overdue totals shown separately. |
| Calls due today / unanswered follow-ups | **Actionable** tasks — not all historic call attempts. |
| Promised payments due | Active promises due on the selected local date, not yet fulfilled or cancelled. |
| Admissions awaiting decisions | Under-review applicants in scope. |

Every metric drills into a filtered list and then into programme/intake detail, and counts and
drill-downs must use the same shared query definitions and the current scope (§11).

### 11.5 Exports

- Masked NIC by default.
- Full-identifier export is Super-Admin-only and audited.
- Exports carry the active filters, timezone, currency, generation timestamp, and field
  definitions.
- All user-controlled cells are neutralised against spreadsheet-formula injection
  (`neutralizeCell()`, `src/lib/csv.ts:1`).
- Large exports run as a background job producing a short-lived private download, with permission
  rechecked at delivery.

---

## 12. Concurrency and integrity controls

| Control | Where |
| --- | --- |
| Transaction around every financial mutation | `withTx()` — `src/db/client.ts:36` (retries `40001` / `40P01`) |
| Fresh permissions checked inside the transaction | `enrolmentInScope()` + `requireCap()` — `src/server/auth/policy.ts:89,50` |
| Deterministic lock ordering | `loadLedger(..., { lock: true })` locks instalment rows ordered by `(enrolment, sequence)` — `src/server/services/ledger.ts:27-28` |
| Expected version checks | `version` columns on `instalments`, `payment_submissions`, `enrolments`, `programmes`, `intakes`, `staff_accounts`, `follow_up_tasks`, `payment_promises` |
| Unique constraints | NIC lookup, student/intake enrolment, admission→enrolment, one receipt per approval, one decision per submission version, one replacement per rejected submission, idempotency keys |
| Idempotency | `idempotency_records` keyed `(scope, key)` with a request hash — replaying a key with a different payload is a conflict |

No approval can credit money twice, even if a browser retries after a timeout.

---

## 13. Where to change a rule

| Rule | Location |
| --- | --- |
| Formula | `src/domain/finance.ts` |
| Ledger projection (which rows count) | `src/server/services/ledger.ts` |
| DB-level guards | `drizzle/0001_integrity.sql` and the `check` constraints in `src/db/schema.ts` |
| Business defaults that are configurable | `docs/assumptions.md` §2, §6, §7 |

This file is documentation, not a source of truth: if a formula changes in code, this document
is regenerated from the code.
