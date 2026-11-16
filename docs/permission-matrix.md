# Permission Matrix — T2T Student Operations System

Authoritative source: `src/server/auth/policy.ts` (capabilities, scope rules, invariant
helpers) and `src/db/schema.ts` (role, scope, and session tables). Section references (§N)
point at `T2T_Coding_Agent_Master_Prompt.md`.

> **Cross-check disclosure:** the source PDF was not available in the repository when this
> document was written. It is derived from the master prompt and the code in this repository.

---

## 1. Roles

There are **exactly two staff roles**. Students authenticate through a separate session type
(`student_sessions`) and are **not** a third staff role.

| Role | Stored as | Source of authority |
| --- | --- | --- |
| `SUPER_ADMIN` | `staff_accounts.role = 'SUPER_ADMIN'` | `src/db/schema.ts:25` (`staffRole` enum) |
| `ADMIN` | `staff_accounts.role = 'ADMIN'` | `src/db/schema.ts:25` |

```ts
export const isSuper = (p: StaffPrincipal) => p.role === "SUPER_ADMIN";   // policy.ts:43
```

A `SUPER_ADMIN` implicitly holds **every** capability. An `ADMIN` holds only the delegable
capabilities explicitly granted to them, and nothing else.

```ts
export function can(p: StaffPrincipal, cap: Capability | SuperOnly): boolean {
  if (isSuper(p)) return true;
  return (CAPABILITIES as readonly string[]).includes(cap) && p.capabilities.has(cap as Capability);
}
```
`src/server/auth/policy.ts:45-48` — deny by default: a capability name that is not in
`CAPABILITIES` can never be held by an `ADMIN`, whatever the database contains.

---

## 2. Delegable capabilities (ADMIN)

Source: `CAPABILITIES` in `src/server/auth/policy.ts:11-20`. Stored per staff member in
`staff_accounts.capabilities` (`text[]`, `src/db/schema.ts:70`).

| Capability | Grants | Notes |
| --- | --- | --- |
| `programme.manage` | Edit **existing** programmes and intakes within the holder's scope | Does **not** permit creating a new programme or intake. |
| `programme.create` | Create new programmes/intakes | The creator's scope assignment happens **in the same transaction** as the creation, so a created record is never briefly unscoped. |
| `fees.adjust` | Fee-plan versions, charge adjustments, and application of enrolment credit | Financial capability; still limited by scope. |
| `exemptions.manage` | Free-card and sponsorship awards, arrears waivers | Awards require an approver and a reason; revocation is an audited reversal, never a delete. |
| `withdrawals.manage` | Withdrawal execution and reactivation | Withdrawal always previews affected obligations before committing. |
| `exports.download` | CSV exports | NIC is **masked** by default for this capability. |
| `admissions.decide` | Accept, reject, or waitlist applicants | Acceptance is idempotent: repeated acceptance reuses the same enrolment. |
| `imports.run` | Run bulk CSV imports | Super Admin controls bulk imports **by default**; this flag allows an Admin to run an import explicitly delegated to them. |

### Capability-flag separation that matters

- `programme.manage` ≠ `programme.create`. A permission to manage an existing course must not
  automatically allow the creation of arbitrary new courses (§4).
- `exports.download` ≠ `exports.full_identifiers`. The latter is Super-Admin-only (§4, §11).
- `fees.adjust` ≠ `exemptions.manage`. A waiver is an exemption, not a fee edit.

---

## 3. Super-Admin-only abilities (never delegable)

Source: `SuperOnly` in `src/server/auth/policy.ts:24-26`. There is **no** path by which an
`ADMIN` can hold one of these, because `can()` filters on `CAPABILITIES` membership.

| Ability | Grants | Why it is not delegable |
| --- | --- | --- |
| `staff.manage` | Invitations, role assignment, deactivation, restoration | Staff lifecycle (§4). |
| `trash.manage` | Moving programmes/intakes and staff to Trash, and restoring them | 30-day Trash (§12). |
| `platform.settings` | Platform-wide settings and role policy | §4: "Platform settings/role policy/global audit — Super Admin only." |
| `audit.global` | Audit visibility across all programmes and intakes | §4/§15: restrict audit visibility. |
| `nic.correct` | Correcting a stored NIC | §4: "restrict NIC corrections to Super Admin by default." |
| `exports.full_identifiers` | Exporting unmasked NIC values | §11: "Explicit full-identifier export is Super Admin-only and audited." |
| `review.correction` | Reason-required correction of a receipt decision outside the quick undo window | §8: a Super Admin may use the correction workflow with a dependency preview; there is no unrestricted rollback of another reviewer's work. |

Enforcement helpers:

```ts
export function requireCap(p: StaffPrincipal, cap: Capability | SuperOnly): void {
  if (!can(p, cap)) throw fail.forbidden();
}
export function requireSuper(p: StaffPrincipal): void {
  if (!isSuper(p)) throw fail.forbidden();
}
```
`src/server/auth/policy.ts:50-56`

---

## 4. Proposal capability table mapped to the implementation

| Capability area (§4) | Super Admin | Admin | Implementation |
| --- | --- | --- | --- |
| Dashboard / reports | All programmes | Assigned programmes/intakes only | Scope predicate on every query; `intakeScopeWhere()` |
| Student / enrolment operations | All | Assigned scope | `enrolmentInScope()` → `fail.notFound()` when out of scope |
| Receipt reviews / call queues | All | Assigned scope | Same scope predicate on queue queries and on every row action |
| Programme / fee / banner edits | All | Only with explicit delegation | `programme.manage`, `fees.adjust` (+ `programme.create` separately) |
| Exemptions / withdrawal adjustments | All | Explicit capability within assigned scope | `exemptions.manage`, `withdrawals.manage` |
| Staff invitations / roles / deactivation / restoration | Yes | Never | `staff.manage` (Super-Admin-only) |
| Programme / intake Trash and restore | Yes | Never | `trash.manage` (Super-Admin-only) |
| Platform settings / role policy / global audit | Yes | Never | `platform.settings`, `audit.global` (Super-Admin-only) |
| Operational history | All | Only records visible within scope | `audit_events.programme_id` / `intake_id` scope columns (`src/db/schema.ts:633-634`) |

---

## 5. Scope model

### 5.1 Grant shape

```ts
export interface ScopeGrant { programmeId: string; intakeId: string | null }
```
`src/server/auth/policy.ts:28`

Stored in `staff_scopes` (`src/db/schema.ts:133-144`):

- `intake_id = NULL` → the grant covers **every intake of that programme**.
- `intake_id = <uuid>` → the grant covers **only that intake**.
- Unique per `(staff_id, programme_id, coalesce(intake_id, sentinel))` — a grant cannot be added twice.

A staff member may hold several grants, covering several programmes and, within a programme,
specific intakes.

### 5.2 Resolution rules

| Rule | Behaviour | Source |
| --- | --- | --- |
| Super Admin | No scope restriction at all. Includes records that are not assigned to any programme or intake. | `intakeScopeWhere()` returns `sql\`true\`` — `policy.ts:64` |
| Admin with **no** grants | Matches **nothing**. Queries return empty sets, not "everything". | `intakeScopeWhere()` returns `sql\`false\`` — `policy.ts:65` |
| Admin with grants | Programme-wide grants OR specific intake grants, combined with `OR`. | `policy.ts:66-71` |
| Object-level check | `inScope(p, programmeId, intakeId)` — a programme-wide grant matches any intake of that programme. | `policy.ts:74-77` |
| Programme-level check | `programmeInScope(p, programmeId)` — true for any grant naming that programme. | `policy.ts:79-81` |
| Visible intake list | `visibleIntakeIds()` returns `null` for Super Admin (meaning "no restriction"), `[]` for an Admin with no grants, and the concrete list otherwise. | `policy.ts:114-123` |

### 5.3 Non-disclosure of out-of-scope records

```ts
if (!row || !inScope(p, row.programmeId, row.intakeId)) throw fail.notFound();
```
`src/server/auth/policy.ts:101`

An out-of-scope record returns the **same** `NOT_FOUND` response as a record that does not
exist. This applies to detail pages, lists, searches, aggregate counts, exports, receipt
delivery, and duplicate warnings — a guessed ID must not confirm that a record exists (§4).

### 5.4 Trashed configuration

```ts
export function assertOperational(ctx: EnrolmentContext): void {
  if (ctx.intakeTrashed || ctx.programmeTrashed) throw fail.conflict("This programme or intake is in Trash. Restore it before making changes.");
}
```
`src/server/auth/policy.ts:109-111`

Scope and operational state are **separate** checks: a record can be inside an Admin's scope
but still be unmodifiable because its programme or intake is in Trash (§12).

---

## 6. Super Admin invariant (1–3 active)

> After successful bootstrap, the number of **active** Super Admins must always remain between
> one and three inclusive. The cap is fixed, not an editable platform setting. (§4)

### 6.1 Rules

| Rule | Behaviour |
| --- | --- |
| Serialization point | Every staff lifecycle operation that can affect the count takes `SELECT … FOR UPDATE` on the `governance_lock` row (`id = 1`) **first**. A count query without a lock is explicitly insufficient (§4). |
| Operations covered | Bootstrap, create/activate, invite acceptance, promotion, demotion, deactivation, Trash, and restore. |
| Pending invitations | Inactive, and do **not** consume an active slot. |
| Capacity check | Checked before inviting (helpful UX) and **rechecked atomically** at acceptance/activation. |
| Failed activation | If capacity filled in the meantime, return a clear error. Never silently assign a different role. |
| Last Super Admin | Removal, demotion, or deactivation of the last active Super Admin is refused — including when the actor is acting on themself. |
| Bootstrap | Runs once through an operator-controlled script. There is no permanent unauthenticated public endpoint, and a rerun cannot create a fourth active account. |
| No default password | No default production password exists in any code path. |
| Restore | Staff restore rechecks the authorizer, the last-active rule, and the three-active cap **transactionally**. If the cap is full, restoring as Super Admin fails clearly; a separately confirmed, audited Super-Admin-authorized "restore as Admin" may be offered. |

### 6.2 Supporting schema

| Object | Purpose | Source |
| --- | --- | --- |
| `governance_lock` | Singleton row `id = 1` (enforced by a `CHECK (id = 1)` constraint) plus `bootstrapped_at` | `src/db/schema.ts:55-59`; seeded in `drizzle/0001_integrity.sql:4` |
| `staff_accounts.status` | `ACTIVE` / `DEACTIVATED`; only `ACTIVE` accounts count toward the cap | `src/db/schema.ts:26` |
| `staff_accounts.trashed_at` | A trashed staff member is deactivated and no longer counts as active | `src/db/schema.ts:71` |
| `withTx()` | Retries serialization failures (`40001`) and deadlocks (`40P01`) with jittered backoff, so a losing concurrent transaction re-runs and re-checks the invariant | `src/db/client.ts:36-53` |

---

## 7. Session, deactivation, and scope changes

| Behaviour | Rule | Source |
| --- | --- | --- |
| Session cookie | `t2t_staff`; `HttpOnly`, `Secure` in production, `SameSite=Lax`, path `/` | `src/server/auth/staff.ts:11,27` |
| Session storage | Only a keyed hash of the token is stored (`staff_sessions.token_hash`) | `src/db/schema.ts:165`; `hashToken()` in `src/lib/crypto.ts:42` |
| Authoritative check | Every request re-reads the session and the account, and compares `session.auth_version` with `account.auth_version` | `src/server/auth/staff.ts:40-50` |
| Deactivation | Revokes all sessions immediately (`revokeAllStaffSessions()`) | `src/server/auth/staff.ts:92-94` |
| Role / scope / capability change | Bumps `auth_version`; the mismatch makes the session invalid on the **next** request | `src/db/schema.ts:69`; `src/server/auth/staff.ts:50` |
| Restore | Never restores old sessions or expired invitation tokens | §4; `staff_sessions.revoked_at` stays set |
| CSRF on mutations | `requireStaff(req)` requires the `x-csrf-token` header to match the session's `csrf_secret`, and asserts same-origin when an `Origin` header is present | `src/server/auth/staff.ts:69-83` |
| Student sessions | Bound to exactly one enrolment; ownership is always resolved from the session, never from a client-supplied enrolment ID | `src/db/schema.ts:601`; §5 |

---

## 8. Enforcement checklist

Every one of the following must consult the current principal and the current scope — no
component may rely on the UI having hidden a control:

- Endpoint handlers and server actions
- File and receipt delivery
- Export generation and export download
- Counts, aggregates, and drill-down lists
- Search and duplicate warnings
- Job-triggered mutations (the job re-checks authorization as the acting principal)
- Notification recipients

Service-layer pattern (as used by the ledger and review services):

```ts
const ctx = await enrolmentInScope(tx, principal, enrolmentId);  // 404 when out of scope
requireCap(principal, "fees.adjust");                             // 403 when not permitted
assertOperational(ctx);                                           // 409 when trashed
```

---

## 9. What an `ADMIN` can never do

Even with every delegable capability granted and a wide scope:

- Manage staff accounts, invitations, roles, deactivation, or restoration.
- Move a programme, intake, or staff member to Trash, or restore one.
- Change platform settings or role policy.
- Read audit events outside their scope.
- Correct a stored NIC.
- Export unmasked NIC values.
- Perform a receipt correction outside the quick undo window.
- Discover records outside their scope — including their existence, counts, or search results.
