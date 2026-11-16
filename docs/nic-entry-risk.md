# NIC Entry Risk — Operator Brief

**Audience:** T2T staff and system owners.
**Purpose:** an honest, plain statement of the identity risk carried by the student entry flow,
what the system does about it, and what it does not.

> **Cross-check disclosure:** the source PDF was not available in the repository when this
> document was written. This brief is derived from `T2T_Coding_Agent_Master_Prompt.md` §5 and
> from the code in this repository. §N references point at that prompt.

---

## 1. The risk in one paragraph

A student enters **their NIC** and **their course/intake**. If both match an active enrolment,
they are let straight in. There is **no OTP, no password, no self-registration, and no
mandatory confirmation**. Anyone who knows a student's NIC **and** which course that student is
enrolled in can open that student's payment record — read the balance, view the receipt history,
and upload a receipt.

This is a deliberate, accepted design constraint, not an oversight. The master prompt records
it directly (§5):

> "The PDF explicitly accepts an impersonation risk: someone knowing NIC + course can access
> records. Rate limiting and protected storage reduce exposure but cannot solve that. Document
> this honestly for operators. Do not market the student entry as verified identity or introduce
> OTP against the requirement."

**This system must never be described to students, funders, or auditors as identity-verified.**

---

## 2. Why the risk cannot be engineered away here

| Requirement | Consequence |
| --- | --- |
| "No student OTP/password/self-registration" is a **mandatory proposal requirement** (§2) | Any second factor on the student path is out of scope until the owner changes the requirement. |
| The entry flow is NIC → course → immediate access (§5) | There is no step where a secret is exchanged. |
| Neutral errors are required (§5) | The system must not reveal whether a NIC exists, so it also cannot act as a verification oracle. |

A verification step (OTP to a phone, a one-time PIN, a document check) would remove most of
this risk. It is prohibited by the current requirement. If the operator wants it, that is an
explicit scope change with a new proposal decision — not something to add quietly.

---

## 3. Why the risk is worse than it first looks

Two properties of the Sri Lankan NIC make it a weaker secret than a password would be:

1. **It is a structured identifier, not a random token.** Both accepted formats
   (`9 digits + V/X` and `12 digits`, `src/lib/nic.ts:7-21`) embed the holder's date of birth and
   a serial number. The space of plausible values for a known birth year is small.
2. **It is widely shared.** Students routinely give their NIC to employers, banks, and other
   institutions, and it appears on paper forms.

Combined with a course name that is often advertised publicly, an attacker with a candidate list
of names and birth dates has a materially better position than the phrase "knowledge of NIC +
course" suggests. Rate limiting slows that down; it does not change the exposure.

---

## 4. Mitigations — what the system actually does

| # | Mitigation | What it does | What it does **not** do | Where |
| --- | --- | --- | --- | --- |
| M1 | **Rate limiting** on IP and on keyed identity/course attempts | Slows and blunts automated guessing; no permanent lockout an attacker could weaponise against a real student | Does not stop a determined, patient attacker, nor a single successful guess | `rate_limit_buckets` (`src/db/schema.ts:695`); thresholds are **proposed** and not yet tuned |
| M2 | **Neutral error message** | Invalid, inactive, unknown, and mismatched entries all return the same response, so the portal is not a "does this NIC exist?" oracle | Does not make a *correct* guess wrong | §5; `fail.notFound()` — `src/server/http.ts:28` |
| M3 | **Private receipt storage** | Receipt images/PDFs live in a private object store and are served only through an authenticated route that rechecks current scope; no public or durable links | Does not protect a record already opened by an impersonator | `receipt_assets.object_key` (`src/db/schema.ts:399`); delivery route is **not yet implemented** |
| M4 | **Session binding** | The session is bound to exactly **one** enrolment; ownership is always resolved from the server-side session, never from a client-supplied enrolment ID | Does not authenticate the human at the session's creation moment | `student_sessions.enrolment_id` (`src/db/schema.ts:601`) |
| M5 | **Remembered-device token** | A random, server-hashed, revocable, time-limited token replaces re-typing the NIC on the same device; only a **masked** NIC is retained client-side | Does not add a factor — it is a convenience credential, and a shared device is a risk (the option is **unchecked by default**) | `remembered_devices` (`src/db/schema.ts:611`); 30-day lifetime is **proposed** |
| M6 | **NIC encryption at rest + keyed lookup digest** | The raw NIC is never stored in clear text; lookups use a keyed HMAC so a predictable identifier is not brute-forceable from the stored digest | Does not help if an application key is compromised — see the backup/restore runbook | `students.nic_enc` / `nic_lookup` (`src/db/schema.ts:180-182`); `src/lib/crypto.ts:17-35` |
| M7 | **No raw NIC in observable surfaces** | Logs, URLs, analytics, errors, exports (by default), and browser caches must not contain raw NICs; exports use a masked value | Does not affect the entry screen itself, where the student types their own NIC | `redact()` (`src/server/audit.ts:8`); `neutralizeCell()` (`src/lib/csv.ts:1`) |
| M8 | **Short session lifetimes** | 30 minutes idle, 12 hours absolute (configurable), so an unattended device does not stay open for long | Does not help while the impersonator is actively using the session | `STUDENT_IDLE_MINUTES` / `STUDENT_ABSOLUTE_MINUTES` (`src/server/env.ts:14-15`) |
| M9 | **Continuous eligibility re-check** | Every protected request re-checks that the student, enrolment, intake, and programme are live — withdrawal, deactivation, or Trash invalidates access immediately, without waiting for the cookie to expire | Does not cancel a session that was valid when it was opened | §5 |
| M10 | **Access-attempt logging** | Student access attempts may be logged with privacy-preserving identifiers, so a pattern of guessing is visible to staff | Does not identify the attacker | `audit_events` with `actor_type = 'STUDENT'` (`src/db/schema.ts:49`) |
| M11 | **No self-registration** | An outsider cannot create a student account and escalate; enrolments exist only if staff admitted them | Does not affect the impersonation path itself | `students` rows originate from admissions/import (`src/db/schema.ts:177`) |

**M1, M3, M5, and M10 are not fully implemented yet** — see `docs/scheduler-storage-setup.md`
for the storage side and `docs/assumptions.md` for the status markers.

---

## 5. What this system is **not**

State this plainly whenever the portal is described:

| This is **not** | Because |
| --- | --- |
| **Verified identity** | Nothing verifies that the person at the keyboard is the person named on the enrolment. |
| **Authentication of the student** | There is no student password, PIN, or OTP. The session starts on a successful NIC + course match. |
| **Authorisation by identity** | Authorisation is by *knowledge of a pair of facts*, not by proof of who is asking. |
| **Protection against a determined insider** | A staff account, a database dump, or a leaked backup key can expose records regardless of this flow. |
| **Protection against a shared or borrowed device** | The "Remember on this device" option persists convenience; it is unchecked by default for exactly this reason. |
| **A fraud-detection system** | Duplicate detection on receipts flags suspicious evidence for a human. It never auto-rejects and never accuses anyone of fraud (§8). |
| **A payment-authentication system** | Manual bank-payment evidence plus human review is the core payment workflow (§2). There is no payment gateway and no automatic bank reconciliation. |

---

## 6. Residual risk table

| Scenario | Likelihood | Impact | Current control | Residual |
| --- | --- | --- | --- | --- |
| Someone guesses a NIC + course | Low–moderate (rate limited) | Full read of that enrolment's financial history | M1, M2, M10 | Accepted. Would require an OTP, which is prohibited |
| Someone is given a NIC by the student or a third party | Moderate | Same as above | M2 only | **Accepted and unmitigable in scope** |
| Shared or public device with a remembered session | Moderate | Access until the idle window closes | M5 (opt-in), M8 | Accepted; mitigated by a 30-minute idle timeout and an unchecked-by-default option |
| Staff account compromise | Low | Broad access within that account's scope | M-audit, session revocation, auth-version checks | Requires strong staff credentials and prompt deactivation |
| Leak of `NIC_ENCRYPTION_KEY` / `NIC_LOOKUP_KEY` | Low | All stored NICs become readable / lookups forgeable | Key escrow and rotation (`docs/backup-restore-runbook.md`) | Depends on operational key hygiene |
| Loss of the storage bucket without keys (or vice versa) | Low | Irrecoverable data | Documented escrow and drill (`docs/backup-restore-runbook.md`) | Depends on the drill actually being run |

---

## 7. Operator guidance

1. **Do not market the entry as secure or verified.** Use wording like "look up your enrolment
   with your NIC and course". Avoid "secure login", "verified student portal", or "identity
   confirmed".
2. **Tell students what to protect.** Ask them to use the entry on a private device, and to use
   "Forget this device" on a shared or public machine. The portal offers this explicitly.
3. **Explain that a wrong number is reported, not silently logged.** "Already Paid" and
   "Wrong Number" call outcomes exist so that a student who reaches the wrong person can have
   the record corrected (`call_outcome` — `src/db/schema.ts:42`).
4. **Watch the access log.** A rise in neutral "could not find an eligible enrolment" results
   from one IP, or repeated attempts against one course, is the signal worth investigating.
5. **Suspected impersonation?** Revoke the affected student sessions and remembered-device
   tokens, check `audit_events` for the pattern, and consider a NIC correction through the
   Super-Admin-only `nic.correct` path — which is itself audited.
6. **Do not weaken the neutral message** to "help" students who mistype a NIC. That message is a
   security control, not a UX inconvenience.
7. **Do not add an OTP "temporarily".** It contradicts a mandatory proposal requirement and
   would need an owner decision first.

---

## 8. Related controls that are *not* about identity

For completeness, so that these are not mistaken for identity protections:

| Control | Purpose |
| --- | --- |
| Duplicate receipt detection (exact file hash, repeated bank reference with context, optional perceptual similarity) | Flags suspicious **evidence** for a human. Never auto-rejects, never accuses (§8). |
| Cross-scope duplicate warnings | Shows a generic warning and routes to authorised staff without leaking unrelated student records (§8). |
| Review lease and optimistic version checks | Prevent two staff members from both crediting the same slip (§8). |
| Idempotency keys and unique constraints | Prevent a retry from creating a second payment (§7, §14). |

---

## 9. Review

| Item | Owner | Cadence |
| --- | --- | --- |
| Rate-limit thresholds (M1) | OpenCode (follow-ups/cron area owner to implement; thresholds to be agreed) | Before production launch, then quarterly |
| Realistic NIC-candidate-space assessment | OpenCode with the proposal owner | Before production launch |
| Student-facing wording on the entry screen | Product owner | Before production launch, and on any copy change |
| Key hygiene and escrow (`docs/backup-restore-runbook.md`) | System owner | Quarterly, and on every staff change |
