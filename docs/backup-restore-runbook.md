# Backup and Restore Runbook — T2T Student Operations System

Operational runbook for protecting and recovering the T2T Student Operations System. It covers
the database, the private receipt objects, and the application keys — **all three are required**
for a complete recovery. Losing any one of them produces an incomplete restore.

> **Cross-check disclosure:** the source PDF was not available in the repository when this
> document was written. This runbook is derived from `T2T_Coding_Agent_Master_Prompt.md` §15
> ("Database/application operators must have a clear backup and restore procedure, including
> private assets and encryption-key recovery") and from the code in this repository.

**This runbook describes the target production configuration. Several components it refers to
(private object storage, the reconciliation command) are not implemented in this repository
yet — they are marked as such.**

---

## 1. What must be backed up

| # | Asset | Why it is required to restore | Where it lives |
| --- | --- | --- | --- |
| A | **PostgreSQL database** | Every business record: students, enrolments, instalments, payments, reviews, calls, audit | Neon (production) or the `t2t-postgres` docker container (local) |
| B | **Private receipt objects** | The evidence behind every reviewed payment; the database stores only the object key | S3-compatible private bucket (`STORAGE_DRIVER=s3`) |
| C | **Application keys** | Without them the restored NIC ciphertext cannot be decrypted, NIC lookups cannot match, and no session or device token can be verified | Operator-controlled escrow (password manager + offline copy) |

**A database backup without B is not a backup** — every historical receipt would be a dead link.
**A backup without C is not a backup** — every student record would be unreadable and every
login would fail.

---

## 2. Targets

| Target | Value | Notes |
| --- | --- | --- |
| RPO (maximum acceptable data loss) | **Proposed 15 minutes** | Bounded by the provider's PITR window and the object-storage replication lag |
| RTO (maximum acceptable downtime) | **Proposed 4 hours** | Includes the drill-grade restore of a full environment |
| Database backup retention | **Proposed 30 days** of point-in-time plus 12 months of nightly logical dumps | Adjust to the operator's policy |
| Object backup retention | Match the database retention | A receipt must exist for as long as its financial record exists |
| Key escrow copies | **Proposed 3** — password manager, offline encrypted copy, sealed envelope | Never all three in the same place |
| Drill cadence | **Proposed quarterly** | Record the measured RTO each time (section 7) |

These targets are proposals, not measurements. Fill in the agreed values before go-live.

---

## 3. PostgreSQL backup

### 3.1 Layer 1 — provider point-in-time restore (Neon)

Neon maintains continuous point-in-time history. Use it for fast recovery of an accidental
deletion or corruption.

**Procedure**

1. In the Neon console, open the production branch and choose **Restore / Create a branch**.
2. Select the timestamp immediately **before** the known bad event.
3. Name the branch `restore-<YYYYMMDDTHHMMSSZ>`.
4. The new branch has its own connection string. **Never** point production at the branch by
   accident — record the branch URL separately and keep `DATABASE_URL` unchanged.
5. Run the verification in section 6 against the branch.
6. If the branch is good, plan the promotion (section 5.4). If not, pick an earlier timestamp.

The equivalent `neonctl` branch command exists; confirm the exact flags against the installed
CLI version before relying on it in an incident.

### 3.2 Layer 2 — logical dumps (`pg_dump`)

Logical dumps are the portable copy and the one that survives a provider change.

Run **nightly** (and on demand before any risky change):

```bash
# POSIX
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --no-owner --no-privileges \
        --file "t2t-${STAMP}.dump" "$DATABASE_URL"
pg_dump --schema-only --no-owner --file "schema-${STAMP}.sql" "$DATABASE_URL"
```

```powershell
# PowerShell
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
pg_dump --format=custom --no-owner --no-privileges --file "t2t-$Stamp.dump" $env:DATABASE_URL
```

Restore into an empty database:

```bash
createdb "$RESTORE_DB"
pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" "t2t-<stamp>.dump"
```

**Rules**

- The dump contains **no** encryption keys — those are environment secrets, not database data.
- The dump **does** contain NIC ciphertext, digests, payment amounts, and audit history. Treat
  the file as sensitive: encrypt it at rest, restrict access, and set a retention expiry.
- Keep at least one copy off the primary provider and off the primary cloud account.
- The schema-only dump is a convenience for diffing; the custom-format dump is the real backup.

### 3.3 Layer 3 — migrations

Checked-in migrations live in `drizzle/`. Apply them with:

```bash
pnpm exec tsx scripts/migrate.ts
```

(`package.json` does not currently define a `db:migrate` script — use the direct invocation
above, or add the script.)

**After restoring a dump, do not re-run migrations against the restored database**: the dump
already contains the migrated schema. Only run migrations when the dump predates a migration
that must be applied to a scratch copy.

---

## 4. Private receipt object backup

### 4.1 What is stored

Receipt objects are addressed by a random key stored in `receipt_assets.object_key` and
`upload_intents.object_key` (`src/db/schema.ts:399,386`). They must live in a **private**
bucket with **no public ACL** — see `docs/scheduler-storage-setup.md` for the bucket setup.

### 4.2 Backup options

| Option | Strength | Notes |
| --- | --- | --- |
| **A. Bucket versioning + replication** | Best | Versioning protects against accidental deletion; cross-region (or cross-account) replication protects against a provider or region event. **Recommended primary.** |
| **B. Nightly sync to a second private bucket** | Good | `aws s3 sync s3://$S3_BUCKET s3://$S3_BUCKET_BACKUP --only-show-errors`. Use a separate account if possible. |
| **C. Periodic `pg_dump` + object inventory** | Weak | An inventory of keys is not a copy. Acceptable only as a reconciliation aid, never as the object backup. |

### 4.3 Object/database consistency

The two systems are backed up on different schedules, so a restore can briefly mismatch. Handle
it explicitly:

1. After restoring the database, run the object-inventory reconciliation (section 6.3) to find
   `receipt_assets` rows whose object is missing from the restored bucket.
2. A missing object for a **historic** receipt is a data-loss incident: record it, do **not**
   silently clear the row, and report it to the operator.
3. A missing object for a **quarantined or orphaned** upload is expected and should be cleaned by
   the orphan-cleanup job, not restored.

---

## 5. Key escrow and rotation

### 5.1 The three keys

| Variable | Purpose | Stored as | Rotation impact |
| --- | --- | --- | --- |
| `NIC_ENCRYPTION_KEY` | AES-256-GCM encryption of the NIC at rest (`students.nic_enc`, `admissions.nic_enc`) | Base64, ≥ 32 bytes | Existing ciphertext must be re-encrypted or the old key must be retained |
| `NIC_LOOKUP_KEY` | HMAC-SHA256 lookup digest and uniqueness key (`students.nic_lookup`, `admissions.nic_lookup`) | Base64, ≥ 32 bytes | Every digest must be recomputed; the unique index must be rebuilt |
| `SESSION_SECRET` | HMAC key for staff sessions, student sessions, remembered-device tokens, and invitation tokens | Base64, ≥ 32 bytes | **All sessions and tokens die** — everyone signs in again |

`CRON_SECRET` is also a secret but is not required for data recovery; rotate it whenever a
scheduler credential may have leaked.

### 5.2 Escrow

1. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Store the value in the organisation password manager as a secret entry, with the production
   environment name and a rotation date.
3. Store a second copy on encrypted removable media in a physically separate location.
4. Store a third copy in a sealed envelope with the operator's designated custodian.
5. **Never** store these values in the repository, in a shared drive, in a chat message, in a
   ticket, or alongside the database dump.
6. Record *where* the escrows live and *who* holds them in the operations handover — not the
   values.

### 5.3 Rotation procedures

#### 5.3.1 `NIC_LOOKUP_KEY`

The lookup digest is the primary lookup path, so the unique index
`student_nic_lookup_uq` (`src/db/schema.ts:200`) must be moved atomically with the value.

**Maintenance-window procedure** (application stopped or writes paused):

```sql
BEGIN;
-- 1. Remove the constraint that the old key would break.
DROP INDEX IF EXISTS student_nic_lookup_uq;
-- 2. Recompute every digest from the ciphertext using the NEW key.
UPDATE students
   SET nic_lookup = encode(hmac('nic:' || convert_from(
         decrypt_iv(nic_enc, <new-key>, <iv>), 'UTF8'), <new-key>, 'sha256'), 'base64')
 WHERE nic_enc IS NOT NULL;
-- The exact SQL depends on the application-side crypto implementation; the safest and
-- canonical route is to run a one-off Node script that uses src/lib/crypto.ts, because the
-- application key version and IV layout are defined there.
COMMIT;
```

**Preferred, application-backed procedure** (avoids re-implementing crypto in SQL):

1. Write a one-off script that uses `decryptNic()` and `nicLookup()` from `src/lib/crypto.ts`,
   reads every student row with a non-null `nic_enc`, and writes the new digest in batches.
2. Run it with the **new** `NIC_LOOKUP_KEY` set in the environment.
3. Detect collisions before switching: two students whose digests now match indicate a
   pre-existing duplicate that was previously hidden. Resolve it in `identity_resolutions`
   rather than merging silently.
4. After the backfill completes and counts match, drop `student_nic_lookup_uq` and recreate it
   on the new column values (or add the new column, backfill, switch the index, then drop the
   old column).
5. Deploy with the new key.

**Note:** `nicLookup()` in `src/lib/crypto.ts:33` accepts only the current key. Adding key
versioning to the lookup digest (as is already done for the ciphertext with the `v1` prefix) is
a code change — request it through `docs/agent-requests.md` if a zero-downtime rotation is
required.

#### 5.3.2 `NIC_ENCRYPTION_KEY`

Ciphertext format: `v1.<iv>.<tag>.<ciphertext>` (base64url), and `decryptNic()` accepts only
the `v1` key id (`src/lib/crypto.ts:17-27`). Rotation therefore needs a code change plus a
re-encryption pass.

**Procedure**

1. Generate the new key; escrow it; keep the old key escrowed and retrievable.
2. Code change: teach `decryptNic()` to accept the previous key id while writing the new id
   (dual-read), and to write `v2.<…>` for new values. Raise that request in
   `docs/agent-requests.md` — `src/lib/crypto.ts` is a shared foundation owned elsewhere.
3. Deploy the dual-read build with **both** keys present in the environment.
4. Run a re-encryption pass over `students.nic_enc` and `admissions.nic_enc` using the
   application helper, in batches.
5. Verify: every row decrypts under the new key and the old key is no longer needed.
6. Remove the old key from the environment and from escrow (keep it offline until the
   verification in section 6 passes and the retention window closes).

**Never** delete the old key before the re-encryption pass is verified. Without it, every
stored NIC becomes permanently unreadable.

#### 5.3.3 `SESSION_SECRET`

`hashToken()` (`src/lib/crypto.ts:42`) HMACs every bearer token with this key, so changing it
invalidates, in one step:

- all staff sessions (`staff_sessions.token_hash`),
- all student sessions (`student_sessions.token_hash`),
- all remembered-device tokens (`remembered_devices.token_hash`),
- all pending staff invitations (`staff_invitations.token_hash`).

**Procedure**

1. Choose a window: end of business, or accept forced re-login.
2. Set the new `SESSION_SECRET` in the production environment and deploy.
3. Immediately revoke all live sessions server-side (`revokeAllStaffSessions()`,
   `src/server/auth/staff.ts:92`) so no stale cookie survives.
4. Re-issue pending staff invitations — their tokens are gone.
5. Ask students to re-enter their NIC on their next visit. Their remembered-device token is
   gone, so they cannot use the masked suggestion until they sign in again.
6. Record the rotation in the operations log.

A dual-key grace period (accepting the old and new secret for a few hours) would avoid the
forced re-login, but it requires a code change to `hashToken()`. Raise it in
`docs/agent-requests.md` if the operator wants it.

#### 5.3.4 `CRON_SECRET`

Set the new value in the project environment and redeploy. Scheduler calls made with the old
value fail with `401` until the redeploy completes. Do this in a quiet window so no job is
skipped.

---

## 6. Verification after any restore

### 6.1 Structural checks

```sql
-- Table count and migration state
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';

-- The governance singleton must exist and be untouched
SELECT id, bootstrapped_at FROM governance_lock;

-- Append-only ledgers must still be intact and non-empty
SELECT 'payment_events', count(*) FROM payment_events
UNION ALL SELECT 'payment_allocations', count(*) FROM payment_allocations
UNION ALL SELECT 'review_actions', count(*) FROM review_actions
UNION ALL SELECT 'audit_events', count(*) FROM audit_events
UNION ALL SELECT 'students', count(*) FROM students
UNION ALL SELECT 'enrolments', count(*) FROM enrolments;
```

### 6.2 Financial integrity checks

These must return **zero rows**:

```sql
-- Allocations must never exceed the net obligation of their instalment
-- (net = original_charge + adjustments − active exemptions).
-- Compare against the application projection rather than re-deriving the whole
-- formula in SQL; scripts/reconcile.ts is the canonical tool for this.

-- Every payment event must be a RECEIPT or a REVERSAL with a valid pointer
SELECT * FROM payment_events WHERE kind = 'REVERSAL' AND reverses_event_id IS NULL;

-- Every allocation must point at a payment event of the same enrolment
SELECT a.id FROM payment_allocations a
  JOIN payment_events e ON e.id = a.payment_event_id
 WHERE e.enrolment_id <> a.enrolment_id;

-- No allocation may reference an instalment of another enrolment
SELECT a.id FROM payment_allocations a
  JOIN instalments i ON i.id = a.instalment_id
 WHERE i.enrolment_id <> a.enrolment_id;
```

### 6.3 Object inventory reconciliation

For every row in `receipt_assets`, confirm the object exists in the restored bucket and that
its SHA-256 matches the stored `sha256` (`src/db/schema.ts:401`). Report:

- objects referenced by the database but missing from the bucket → **data-loss incident**;
- objects present in the bucket but not referenced → orphan, handled by the cleanup job;
- hash mismatches → **integrity incident**; treat the object as untrusted and quarantine it.

### 6.4 Reconciliation command

```bash
pnpm exec tsx scripts/reconcile.ts
```

The reconciliation command is **read-only**: it compares financial events, allocations,
credits, instalment projections, and report totals, and reports discrepancies **without
silently editing production financial history** (§16). A documented authorized correction
procedure handles anything it finds.

> This command is planned (it is the OpenCode-owned `scripts/reconcile.ts`) and **is not
> implemented yet**. Until it exists, run the SQL checks in sections 6.1–6.2 by hand.

---

## 7. Restore drill (run quarterly)

The drill restores into an **isolated scratch environment** and must never touch production.

**Drill 0 — Prepare**

1. Create a scratch database: `createdb t2t_restore_drill`.
2. Create a scratch private bucket, or point the scratch environment at a copy of the backup
   bucket.
3. Retrieve the three keys from escrow into the scratch environment's secret store.
4. Record the start time — this is the RTO measurement.

**Drill A — Database**

```bash
pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" "t2t-<stamp>.dump"
# or, for a Neon PITR drill, take the branch connection string as $RESTORE_URL
```

**Drill B — Objects**

Restore the backup bucket copy (or verify that the replication target is already current) and
make it reachable under the scratch bucket name.

**Drill C — Keys**

Set `NIC_ENCRYPTION_KEY`, `NIC_LOOKUP_KEY`, and `SESSION_SECRET` in the scratch environment
from escrow. Confirm each decodes to ≥ 32 bytes.

**Drill D — Application smoke test**

1. Apply no migrations; the dump already has the schema. Confirm `drizzle` versions are
   consistent.
2. Start the application against the scratch database:
   `DATABASE_URL=$RESTORE_URL pnpm dev` (with the scratch keys and storage configured).
3. Sign in as a staff user (seed a Super Admin through the operator bootstrap path for the
   drill environment only — **never** re-run bootstrap against production).
4. Verify:
   - a student can be found by NIC entry (proves the ciphertext **and** the lookup digest both
     restored correctly — this is the single most important check in the drill);
   - a receipt thumbnail renders (proves objects restored);
   - a payment history shows the expected totals (proves financial rows restored);
   - the review queue loads and a submission's decision history is intact.
5. Run the verification SQL (section 6) and the reconciliation command (section 6.4).
6. Destroy the scratch environment and the restored copies of the keys. Record the elapsed
   time.

**Drill record template**

| Field | Value |
| --- | --- |
| Date | |
| Operator(s) | |
| Backup source (dump file / PITR timestamp) | |
| Object source (bucket, version) | |
| Key escrow source | |
| RTO measured | |
| Checks passed / failed | |
| Discrepancies found and how they were resolved | |
| Follow-up actions | |

---

## 8. Restore decision tree

| Situation | Action |
| --- | --- |
| Accidental deletion of one record | Do **not** restore the whole database. Use the append-only design: write a correction (adjustment, reversal, exemption) and record it in the audit trail. |
| Accidental deletion of many records / bad migration | Restore to a branch at a timestamp before the event, reconcile, then promote (§5.4). |
| Database corruption | PITR to the last known-good timestamp; verify with section 6; promote. |
| Lost receipt object | Check bucket versioning and replication for an earlier version; if unrecoverable, record a data-loss incident — do not clear the row. |
| Suspected key compromise | Rotate the compromised key immediately using section 5.3, then force a full re-login (`SESSION_SECRET`) and re-encrypt (`NIC_ENCRYPTION_KEY`). |
| Suspected bucket credential compromise | Rotate the storage credentials, review bucket access logs, re-sync objects, and rotate `CRON_SECRET` if it was stored in the same place. |

### 8.4 Promotion of a restored branch

1. Restore into a branch; verify (section 6).
2. Announce a maintenance window and stop writes (put the app into a read-only posture or stop
   the deployment).
3. Promote the restored branch to production — the exact command sequence depends on the
   provider and the chosen branch topology; **confirm it against the provider's current
   documentation before the incident**, not during.
4. Update `DATABASE_URL` if the promotion changes it, and redeploy.
5. Re-run section 6 against production.
6. If any writes happened after the PITR timestamp, they are lost. Reconcile them by hand from
   the audit trail and outbox records, and tell the operator exactly what was lost.

---

## 9. Rules that hold during any restore

1. **Never delete history.** Corrections are new rows (adjustments, reversals, exemptions). The
   database triggers reject `UPDATE`/`DELETE` on `audit_events`, `review_actions`,
   `call_attempts`, `payment_events`, and `charge_adjustments`
   (`drizzle/0001_integrity.sql:8-23`).
2. **Never silently edit production financial history.** A discrepancy is reported and then
   corrected through the authorized correction procedure.
3. **Never restore over production in place.** Restore to a branch or a scratch database,
   verify, then promote.
4. **Never treat a missing key as a lost row.** Missing keys mean unreadable data, not deleted
   data.
5. **Never run migrations against a restored dump.** Only against a scratch copy that predates
   them.
6. **Record every restore** — who, when, from what backup, what was lost, what was corrected.

---

## 10. Cross-references

| Document | Relevance |
| --- | --- |
| `docs/scheduler-storage-setup.md` | Bucket setup (private, no public ACL), storage driver configuration, cron secret |
| `docs/nic-entry-risk.md` | What a compromised key or a leaked backup exposes |
| `docs/assumptions.md` | Key-related defaults and where they are adjustable |
| `docs/import-cutover-guide.md` | Reconciliation used before and after a cutover |
