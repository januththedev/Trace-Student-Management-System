# Import and Cutover Guide — T2T Student Operations System

How to move existing T2T data (students, enrolments, fee schedules, and prior receipts) into
this system safely, without fabricating evidence and without silently altering payment history.

> **Cross-check disclosure:** the source PDF was not available in the repository when this
> document was written. This guide is derived from `T2T_Coding_Agent_Master_Prompt.md` §16 and
> from the code in this repository. §N references point at that prompt.

**Implementation status:** the CSV parsing and neutralisation primitives exist
(`src/lib/csv.ts`), and the schema has everything the import needs (NIC encryption columns,
`identity_resolutions`, `is_historical_placeholder`, `is_historical_import`,
`HISTORICAL_IMPORT` event and allocation sources). The import **service**
(`src/server/services/imports/**`), the staff import UI/API route, and the reconciliation
command (`scripts/reconcile.ts`) are **not implemented yet**. This guide specifies their
contract so they can be built against it.

---

## 1. Rules that never bend

| Rule | Detail |
| --- | --- |
| Authorisation | Bulk imports are controlled by the **Super Admin by default**. An `ADMIN` may run an import only with the explicit `imports.run` capability (`src/server/auth/policy.ts:19`). Every run is audited with the operator, the file, the row counts, and the mode. |
| Never merge silently | A NIC collision produces a **duplicate-detection error** and a resolution prompt. Records are never auto-merged, and old/new NIC formats are never inferred to be the same person (§5, §9). |
| Never overwrite payment history | An import never edits, deletes, or re-dates an existing payment, allocation, or review decision. Corrections are append-only (§13). |
| Separate historical mode | Importing prior approved receipts or opening balances requires the **explicit historical-import mode** with a source reference, an effective date, an operator, and validation (§16). |
| No counterfeit evidence | An import never creates a fake uploaded slip. Where a historical receipt has no original image, the record is labelled honestly (§5). |
| Dry run first | Every import is validated in dry-run mode and must be reviewed before a commit. The commit is a separate, explicit action. |
| Idempotent commits | Committing the same file twice produces one business result, never two (§14). |

---

## 2. Import modes

| Mode | Purpose | Creates financial records? |
| --- | --- | --- |
| `STUDENTS` | Create or quarantine student records | No |
| `ENROLMENTS` | Create enrolments and their instalments | No (installments only) |
| `OPENING_SCHEDULES` | Create fee-plan versions and fee-plan items for an intake | No |
| `HISTORICAL` | Import prior approved receipts / opening balances | **Yes** — `payment_events` of kind `HISTORICAL_IMPORT` |

`HISTORICAL` is a separate mode with a separate template, separate confirmation wording, and
additional required fields. It is never reachable from the ordinary import screen without an
explicit, visible selection.

---

## 3. CSV conventions

| Rule | Detail |
| --- | --- |
| Encoding | UTF-8. A leading BOM is tolerated (`parseCsv`, `src/lib/csv.ts:40`). |
| Line endings | CRLF or LF; both are parsed. |
| Header row | Required, and must match the template header exactly (case-insensitive, order-insensitive). |
| Delimiter | Comma. Fields containing commas, quotes, or newlines must be quoted (`""` escapes a quote inside a quoted field). |
| Blank lines | Ignored. |
| Column order | Free — map by header name, not position. |
| Money | **Major units** with up to two decimals, e.g. `4000`, `4000.50`. Parsed with `parseMajorToMinor()` (`src/lib/money.ts:11`), which strips thousands separators, a leading `LKR`, and whitespace. Never a float. Values are stored as minor units. Negative amounts are rejected. |
| Dates | `YYYY-MM-DD` (business dates, `Asia/Colombo`). |
| Instants | ISO-8601 with an explicit offset. |
| Booleans | `true` / `false` / `yes` / `no` / `1` / `0`. |
| Empty cell | Means "not provided" — it never silently becomes a default that changes money. Defaults are documented per field below. |
| Spreadsheet formulas | A cell beginning with `=`, `+`, `-`, `@`, tab, or CR is preserved on **import** but is always neutralised on **export** (`neutralizeCell()`, `src/lib/csv.ts:1`). If your source spreadsheet has a formula in a text column, paste its **value** before importing. |

---

## 4. Templates

### 4.1 Students — `STUDENTS`

| Column | Required | Format | Default | Notes |
| --- | --- | --- | --- | --- |
| `full_name` | **yes** | text | — | 1–200 characters |
| `nic` | **yes** | 9 digits + `V`/`X`, or 12 digits | — | Whitespace trimmed and upper-cased. **Format validation only** — this is not identity verification. |
| `ref` | no | text | generated | Internal reference, unique. Leave blank to let the system allocate one. |
| `phone` | no | text | — | Prefer E.164 (`+947XXXXXXXX`). Entering a phone does **not** mark it verified. |
| `email` | no | text | — | Entering an email does **not** mark it verified. |
| `status` | no | `ACTIVE` \| `INACTIVE` | `ACTIVE` | |
| `programme_code` | no | text | — | When present, links the student to that programme's intake context for the operator's convenience. It does **not** create an enrolment. |
| `intake_code` | no | text | — | Requires `programme_code`. |
| `note` | no | text | — | Free text; stored, never rendered as HTML. |

**Row outcomes**

| Outcome | Condition | Result |
| --- | --- | --- |
| Created | NIC is unique across `students.nic_lookup` | A student row is inserted with `nic_enc`, `nic_lookup`, and `nic_masked`. The raw NIC is never stored. |
| Duplicate | `nic_lookup` already exists | **Row error**, with a permitted existing match shown to an operator who is allowed to see that student, or a generic duplicate-resolution message otherwise. No merge. |
| Quarantined | NIC is missing or fails format validation | A row is written to `identity_resolutions` (`src/db/schema.ts:205`) for staff resolution. **No fabricated identifier is created.** |

### 4.2 Enrolments — `ENROLMENTS`

| Column | Required | Format | Default | Notes |
| --- | --- | --- | --- | --- |
| `programme_code` | **yes** | text | — | Must already exist. |
| `intake_code` | **yes** | text | — | Must exist and belong to `programme_code`. |
| `student_ref` | one of | text | — | The internal reference of an existing student. |
| `student_nic` | one of | NIC format | — | Used when the reference is unknown. Exactly one of `student_ref` / `student_nic`. |
| `status` | no | `ACTIVE` \| `COMPLETED` \| `WITHDRAWN` \| `INACTIVE` | `ACTIVE` | One canonical active representation; no parallel booleans. |
| `activated_at` | no | ISO-8601 | now | |
| `fee_plan_version` | no | integer | current version of the intake | The version the instalments are generated from. |
| `note` | no | text | — | |

**Rules**

- One enrolment per (student, intake) is enforced by the database
  (`enrolment_student_intake_uq`, `src/db/schema.ts:265`). A duplicate row is an **error**, not
  a second enrolment. Explicit re-enrolment reactivates or follows the documented
  repeat-enrolment policy — it never silently duplicates history (§9).
- An enrolment created by import snapshots the intake's current fee-plan version and generates
  its instalments in the same transaction.
- The operator must have scope for the target programme/intake, or the row is rejected with
  `SCOPE_DENIED`.

### 4.3 Opening schedules — `OPENING_SCHEDULES`

Fee-plan items for an intake. These define what every future enrolment of that intake owes.

| Column | Required | Format | Default | Notes |
| --- | --- | --- | --- | --- |
| `programme_code` | **yes** | text | — | |
| `intake_code` | **yes** | text | — | |
| `sequence` | **yes** | integer ≥ 1 | — | Unique within the version. Instalment identifiers stay stable even if labels change. |
| `component` | no | text | `TUITION` | Fee component, e.g. `TUITION`, `MATERIALS`, `REGISTRATION`. |
| `period_label` | **yes** | text | — | Human label, e.g. `2026-03`. |
| `amount` | **yes** | major units, ≥ 0 | — | |
| `due_date` | **yes** | `YYYY-MM-DD` | — | Business date in `Asia/Colombo`. |
| `fee_plan_notes` | no | text | — | Version-level note. |

**Rules**

- Editing a schedule creates a **new `fee_plan_versions` row**; existing enrolments keep their
  snapshot and their obligations are never rewritten (§7).
- Only one version per intake is current (`fee_plan_current_uq`, `src/db/schema.ts:230`).
- A new version does not change existing student obligations. Applying it to selected
  enrolments is a separate, explicit action with an impact preview (§7).

### 4.4 Prior receipts and opening balances — `HISTORICAL`

Use this mode **only** to bring across money that was already received before the system went
live.

| Column | Required | Format | Notes |
| --- | --- | --- | --- |
| `student_ref` / `student_nic` | one of | as above | The student must already exist (import students first). |
| `programme_code` | **yes** | text | |
| `intake_code` | **yes** | text | |
| `payment_kind` | **yes** | `OPENING_BALANCE` \| `PRIOR_RECEIPT` | `OPENING_BALANCE` is money already allocated to specific instalments; `PRIOR_RECEIPT` is cash received but not yet allocated (it becomes enrolment credit). |
| `amount` | **yes** | major units, > 0 | |
| `effective_date` | **yes** | `YYYY-MM-DD` | The date the money was received. Used for as-of reporting — **not** today's date. |
| `source_reference` | **yes** | text | Free-text but mandatory: e.g. `Bank statement 2025-03, ref 88213, paid by cash`. This is the operator's provenance. |
| `allocate_to_period` | conditional | `sequence` or `period_label` | Required for `OPENING_BALANCE`: which instalment the money covers. Optional for `PRIOR_RECEIPT`. |
| `note` | no | text | |

**How historical money is recorded**

| Object | Effect |
| --- | --- |
| `payment_events` | One row with `kind = 'HISTORICAL_IMPORT'`, `amount_minor` = the amount, `effective_date` as given, `source_reference` as given, `actor_id` = the operator, and `claimed_minor` = the same amount (no reviewer adjusted it). |
| `payment_allocations` | For `OPENING_BALANCE`, one allocation per covered instalment with `source = 'HISTORICAL_IMPORT'`. For `PRIOR_RECEIPT`, **no** allocation — the amount stays as enrolment credit until staff apply it. |
| `receipt_assets` | **Not created**, unless an operator explicitly uploads the original slip. If a placeholder row is created, `is_historical_placeholder = true` (`src/db/schema.ts:409`) and the UI must label it as *"historical record — original evidence not on file"*. |
| `payment_submissions` | Not created. A historical import is **not** a student submission, so it does not appear in the review queue. |
| `audit_events` | One row per import, plus one per financial record, with the operator, the source reference, and the request id. |

**Honesty rules for historical mode**

- A historical import is **never** presented as newly collected money. Reporting labels it
  separately from current-period collections; a historical amount contributes to *collections*
  for its own effective period and never to "collected today".
- Never create an uploaded slip that the student did not upload. Absence of original evidence is
  stated, not papered over (§16).
- Applying historical credit to an instalment is an **audited credit application**
  (`allocation_source = 'CREDIT_APPLY'`), and it is never counted as a new collection (§7, §11).

---

## 5. Workflow

```
1. Download the template   →  2. Fill it in        →  3. Dry run
                                                          │
                            6. Audit + confirmation  ←  5. Commit
```

### Step 1 — Download the template

The template is generated with the same primitives as exports (`toCsv()`,
`src/lib/csv.ts:15`), so the header row and the field-definition preamble match exactly what
the parser expects.

### Step 2 — Fill it in

Use the field definitions in section 4. Keep every row's meaning stable; do not merge two
students into one row, and do not split one student across rows.

### Step 3 — Dry run

The dry run parses and validates every row and **writes nothing** to the database. It returns:

| Part | Content |
| --- | --- |
| Summary | Rows read, rows valid, rows invalid, rows quarantined, rows skipped as duplicates |
| Per-row errors | Row number, column, error code, message, and the offending value |
| Duplicate report | The conflicting NIC/ref, the existing record's reference, and what the operator can do about it — with a **permitted existing match** only if the operator is authorised to see it |
| Warnings | Rows that would import but deserve a human look (unusually old effective date, unusually large amount, a student with several enrolments) |
| Preview of effect | Counts of students / enrolments / instalments / payment events that a commit would create |

**Row error codes**

| Code | Meaning |
| --- | --- |
| `MISSING_REQUIRED_FIELD` | A required column is empty |
| `INVALID_NIC_FORMAT` | The NIC is not 9 digits + `V`/`X` and not 12 digits (after normalisation) |
| `INVALID_AMOUNT` | Not a valid non-negative major-unit amount |
| `INVALID_DATE` | Not a valid `YYYY-MM-DD` date, or a date the business timezone rejects |
| `INVALID_ENUM` | The value is not one of the allowed values for the column |
| `UNKNOWN_PROGRAMME` / `UNKNOWN_INTAKE` | The referenced programme or intake does not exist |
| `UNKNOWN_STUDENT` | Neither `student_ref` nor `student_nic` matched a student |
| `AMBIGUOUS_STUDENT` | The NIC matched more than one candidate |
| `DUPLICATE_NIC` | The NIC already exists — no merge |
| `DUPLICATE_ENROLMENT` | An enrolment already exists for this (student, intake) |
| `DUPLICATE_SEQUENCE` | The `sequence` is already used in the target fee-plan version |
| `SCOPE_DENIED` | The operator lacks scope for the referenced programme/intake |
| `FUTURE_EFFECTIVE_DATE` | `effective_date` is in the future in `Asia/Colombo` |
| `ALLOCATION_EXCEEDS_REMAINING` | A historical allocation would exceed the instalment's remaining amount |

### Step 4 — Fix and re-dry-run

Correct the source file and run the dry run again. A file that produces zero errors is ready to
commit. Warnings do not block a commit but must be read.

### Step 5 — Commit

The commit is explicit and separate from the dry run:

1. The operator confirms the mode, the file, and the summary counts.
2. The commit runs inside a transaction (`withTx()` — `src/db/client.ts:36`), with the
   authorization re-checked inside the transaction.
3. **Idempotency**: the commit is keyed on the operator, the mode, and a hash of the file
   content (`idempotency_records`, `src/db/schema.ts:686`). Re-committing the same file returns
   the original result instead of creating a second set of rows. The same key with a different
   file is a conflict.
4. An `audit_events` row is written for the import as a whole, and one row per created or
   changed record.
5. The result lists what was created, what was quarantined, and the IDs of everything touched.

### Step 6 — Verify

Run the reconciliation command (section 6) and the sample reconciliation (section 5 of
`docs/finance-rules.md`).

---

## 6. Reconciliation command

```bash
pnpm exec tsx scripts/reconcile.ts [options]
```

**Purpose:** a **read-only** integrity check comparing financial events, allocations, credits,
instalment projections, and report totals. It reports discrepancies and **never** silently edits
production financial history (§16).

**Proposed options**

| Option | Effect |
| --- | --- |
| `--url <DATABASE_URL>` | Target database. Defaults to `DATABASE_URL` from the environment. |
| `--scope <programme-code>` | Restrict the check to one programme (and its intakes). |
| `--as-of YYYY-MM-DD` | Evaluate the projection as of a business date, using effective event dates. |
| `--json` | Emit machine-readable output for CI or a scheduled check. |
| `--strict` | Exit non-zero on warnings as well as errors. |

**Proposed exit codes**

| Code | Meaning |
| --- | --- |
| `0` | Consistent — no discrepancies |
| `1` | Discrepancies found (reported in the output) |
| `2` | The check could not run (missing database, missing key, unexpected error) |

**Checks it should perform**

1. Every `payment_allocations` row points at a payment event and an instalment of the **same**
   enrolment, and at the same currency.
2. No instalment has active allocations exceeding its net obligation.
3. No enrolment has a negative credit (receipts − allocations).
4. Every `REVERSAL` event points at an existing event and reverses at most one.
5. Every `payment_events` row of kind `RECEIPT` has exactly one approving `review_actions` row
   (except `HISTORICAL_IMPORT` rows, which carry a `source_reference` instead).
6. No allocation is marked reversed twice; no reversal is missing its reason.
7. The instalment projection recomputed from events matches the stored projections.
8. Report totals equal the sum of the underlying records for each reporting period.

> The command is planned and **not implemented yet**. Until it exists, the SQL checks in
> `docs/backup-restore-runbook.md` §6.1–6.2 cover items 1–3 and 6 manually.

**When a discrepancy is found**

1. Do not edit the production financial history.
2. Record the discrepancy with the affected IDs and the expected versus actual amounts.
3. Correct it through the authorized correction procedure: a reversal event, a charge
   adjustment, an exemption application, or a credit application — each audited, each
   append-only.
4. Re-run the reconciliation until it reports consistent.

---

## 7. Sample reconciliation before cutover

Reconcile a **sample** of students and programme totals against the legacy spreadsheets before
going live. A full manual reconciliation is not required; a representative sample plus
programme totals is.

### 7.1 Choosing the sample

| Stratum | Minimum |
| --- | --- |
| Each programme | 5 students |
| Each intake | 5 students |
| Students with multiple enrolments | 5 students |
| Students with a partial payment | 5 students |
| Students with a pending receipt | 3 students |
| Students with a rejected receipt | 3 students |
| Students with a free card or sponsorship | 3 students |
| Students with an overdue balance | 5 students |
| Students who withdrew | 3 students |

### 7.2 What to compare, per student

| Check | Legacy source | System |
| --- | --- | --- |
| Total owed | Legacy spreadsheet total | Net obligation (`Σ instalments.net_obligation`) |
| Total paid | Legacy payments column | Collected (unreversed verified receipts) |
| Outstanding | Legacy balance | `outstandingMinor` |
| Credit | Legacy credit column | `creditMinor` |
| Instalment count and labels | Legacy schedule rows | Instalments in the enrolment |
| Due dates | Legacy schedule | `instalments.due_date` |
| Receipt history | Legacy slip register | Approved submissions and their payment events |

Any difference is resolved **before** cutover, not after. The expected difference is zero: the
system is being given the same facts, so any mismatch means a mapping error in the import.

### 7.3 Programme totals

For each programme, compare the legacy total outstanding and total collected against the
system's report for the same scope and as-of date. Totals must match to the rupee. A
difference is usually one of:

- a student imported twice under two references,
- an enrolment created against the wrong intake,
- a historical amount imported with today's effective date (so it lands in the wrong period),
- an allocation applied to the wrong instalment.

---

## 8. Cutover checklist

Print this. Work top to bottom. Do not skip a line.

### Before

- [ ] The database is migrated on a clean environment and the migration state is verified.
- [ ] A backup of the current (empty or partial) production database has been taken and a
      restore drill has been executed at least once — `docs/backup-restore-runbook.md`.
- [ ] `NIC_ENCRYPTION_KEY`, `NIC_LOOKUP_KEY`, and `SESSION_SECRET` are set in production and
      escrowed.
- [ ] Programmes, intakes, and fee-plan versions are created and reviewed by a second person.
- [ ] Every import template has been dry-run with **zero** errors on the real data.
- [ ] The sample reconciliation in section 7 is complete and every difference is resolved.
- [ ] `scripts/reconcile.ts` (or the manual SQL checks) report **no discrepancies**.
- [ ] A Super Admin account exists and is confirmed; the active Super Admin count is within
      1–3.
- [ ] The staff team has accounts, the right capabilities, and the right scopes.
- [ ] Private object storage is configured and private (`docs/scheduler-storage-setup.md`).
- [ ] The scheduler is configured and the cron routes answer with `Authorization: Bearer
      $CRON_SECRET` (`docs/scheduler-storage-setup.md`).
- [ ] A decision is recorded about what happens to the legacy spreadsheets: they become
      read-only references, or they are archived. They are **not** kept in parallel as a second
      source of truth.

### The cutover window

- [ ] Staff are told the system is live and the legacy sheets are frozen.
- [ ] Imports are executed in this order: **students → opening schedules → enrolments →
      historical receipts**, with a dry run before each.
- [ ] Each import's summary and audit record is saved.
- [ ] `scripts/reconcile.ts` (or the manual checks) run after the last import and report no
      discrepancies.
- [ ] The sample reconciliation is repeated on the live system.

### After

- [ ] The first batch of real student submissions is reviewed by staff.
- [ ] The first collection-call queue is reviewed: only due/overdue positive collectible
      balances appear, and no waived or pending case has appeared.
- [ ] A first cron run has completed successfully for each of the four jobs.
- [ ] Notifications reach the in-portal inbox; no live email/SMS was sent without an explicit
      operator enablement.
- [ ] The backup job has run and a dump exists.
- [ ] The operator has a copy of this guide, the backup runbook, and the NIC risk brief.
- [ ] The deferred items are recorded rather than silently dropped: refunds, email/SMS
      delivery, malware scanning, and any optional feature that was not built.

---

## 9. Common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every NIC row is `DUPLICATE_NIC` | The students were imported before | Import once. Do not "re-run to fix" — the duplicate error is the protection against double-creating a student. |
| `DUPLICATE_ENROLMENT` on every row | Enrolments were imported before, or the source has one row per instalment | Aggregate the source to one row per (student, intake) before re-importing. |
| Historical totals do not appear in the right period | `effective_date` was left as today's date | Re-import into a scratch database with the correct `effective_date`; never edit the imported event in place — reverse it and re-import with a reason. |
| A student has two records | Two NIC spellings of the same person, or an old/new NIC format pair | Resolve in `identity_resolutions`. The system will not merge for you, and the old/new format pair is **not** proof of the same person (§5). |
| A receipt cannot be shown to a student | A historical import with no original slip | Expected. The record is labelled as historical with no original evidence on file. Do not upload a substitute slip. |
| `ALLOCATION_EXCEEDS_REMAINING` | The historical amount exceeds the instalment's obligation | Reduce the allocation, and record the excess as enrolment credit. |
| The commit did nothing | The same file was already committed | Expected and correct — the import is idempotent. Use the original result. |

---

## 10. Cross-references

| Document | Relevance |
| --- | --- |
| `docs/finance-rules.md` | The formulas the import must satisfy, and the worked fixtures |
| `docs/permission-matrix.md` | `imports.run`, scope rules, and the audit trail |
| `docs/backup-restore-runbook.md` | Backup before cutover, and the restore drill |
| `docs/scheduler-storage-setup.md` | Private storage needed for any uploaded evidence |
| `docs/assumptions.md` | Every default that affects import validation and reporting |
