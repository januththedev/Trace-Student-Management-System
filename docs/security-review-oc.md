# Security review — T2T Student Operations System

**Reviewer:** OpenCode (security lane)
**Date:** 2026-11-15
**Scope:** every route handler under `src/app/api/**` (42 handlers), the services they call under `src/server/**`, the shared foundations (`src/server/http.ts`, `src/server/auth/**`, `src/server/ratelimit.ts`, `src/server/idempotency.ts`, `src/lib/{crypto,nic,csv,files/validate}.ts`), plus `next.config.ts` and `public/sw*.js`.
**Reference:** `T2T_Coding_Agent_Master_Prompt.md` §4, §5, §14, §15 and `AGENTS.md`.

**Method:** static code reading only. No application was started, no request was issued, no test was executed, and no dependency advisory scan was run. Every finding below was confirmed by reading the exact lines cited and, where relevant, by tracing the call graph to the service that performs the check. Nothing is reported that I could not verify in source.

**No code was modified.** The only file written is this report.

---

## 1. Route inventory

Legend — **Auth**: `pub` public, `stu` student session, `stf` staff session, `cron` bearer secret.
**CSRF**: does the handler receive `req` so `requireStaff(req)` / `requireStudent(req)` can compare `x-csrf-token` and run the Origin/Host check.
**Body**: server-side zod schema via `parseBody`.
**Scope**: per-id scope enforcement (`enrolmentInScope` / `intakeScopeWhere` / `inScope` / `studentScope` / session-bound enrolment).
**Cap**: capability gate (`requireCap` / `requireSuper`).
**Idem**: `Idempotency-Key` enforced or otherwise replay-safe.
**Cache**: response cache policy.

| # | Route | Auth | CSRF | Body (zod) | Scope | Cap | Idem | Cache |
|---|---|---|---|---|---|---|---|---|
| 1 | `GET /api/public/courses` | pub | n/a | n/a | public metadata only | n/a | n/a | `public, max-age=60, SWR` (intentional) |
| 2 | `GET\|POST /api/cron/followups` | cron | n/a | n/a | system-wide job | n/a | job lease + cursors | private, no-store |
| 3 | `GET /api/cron/outbox` | cron | n/a | n/a | system-wide job | n/a | `SKIP LOCKED` | private, no-store |
| 4 | `POST /api/cron/purge` | cron | n/a | n/a | retention job | n/a | claim + `SKIP LOCKED` | private, no-store |
| 5 | `GET /api/cron/uploads-cleanup` | cron | n/a | n/a | orphan cleanup | n/a | grace period | private, no-store |
| 6 | `POST /api/student/entry` | pub | n/a (no session yet) | ✔ `body` | NIC+intake match, neutral 404 | n/a | n/a | private, no-store |
| 7 | `POST /api/student/device-entry` | pub | ✖ (no token) — see **L1** | ✔ `intakeId` | device token → enrolment | n/a | n/a | private, no-store |
| 8 | `POST /api/student/logout` | stu | ✖ (no token) — see **L1** | ✔ `forgetDevice` | session-bound | n/a | n/a | private, no-store + `Clear-Site-Data` |
| 9 | `GET /api/student/submissions` | stu | n/a (GET) | n/a | session enrolment only | n/a | n/a | private, no-store |
| 10 | `POST /api/student/submissions` | stu | ✔ | ✔ `submitInput` | intent bound to session enrolment | n/a | ✔ `Idempotency-Key` + unique index | private, no-store |
| 11 | `GET /api/student/submissions/[id]/evidence` | stu | n/a (GET) | n/a | ownership re-resolved from session | n/a | n/a | `private, no-store` + `nosniff` + CSP `sandbox` |
| 12 | `POST /api/student/uploads` | stu | ✔ | ✔ `intentInput` | intent bound to session enrolment | n/a | n/a | private, no-store |
| 13 | `PUT /api/student/uploads/[id]` | stu | ✔ | raw bytes | intent owner only | n/a | n/a | private, no-store — **H2** |
| 14 | `POST /api/student/notifications` | stu | ✔ | n/a | recipient = session enrolment | n/a | n/a | private, no-store |
| 15 | `POST /api/staff/auth/login` | pub | ✔ Origin/Host + `Sec-Fetch-Site` | ✔ `loginSchema` | n/a | n/a | ✔ `Idempotency-Key` | private, no-store |
| 16 | `POST /api/staff/auth/logout` | stf | ✔ | n/a | own session | n/a | ✔ `Idempotency-Key` | private, no-store |
| 17 | `GET /api/staff/review/queue` | stf | n/a (GET) | ✔ `queueFilters` | `intakeScopeWhere` | n/a | n/a | private, no-store |
| 18 | `GET /api/staff/review/[id]/[action]` | stf | n/a (GET) | ✔ preview query | `enrolmentInScope` | n/a | n/a | private, no-store; evidence `no-store`+`nosniff`+CSP |
| 19 | `POST /api/staff/review/[id]/[action]` | stf | ✔ | ✔ per action | `lockSubmission` → `enrolmentInScope` | approve/reject: scope only; correct: `review.correction` | ✔ approve/reject; ✖ undo/correct — **M7** | private, no-store |
| 20 | `GET /api/staff/calls` | stf | n/a (GET) | ✔ `queueSchema` | `intakeScopeWhere` + `freshPrincipal` | n/a | n/a | private, no-store |
| 21 | `GET /api/staff/calls/[id]` | stf | n/a (GET) | ✔ uuid | `enrolmentInScope` | n/a | n/a | private, no-store |
| 22 | `POST /api/staff/calls/attempts` | stf | ✔ | ✔ `attemptSchema` | `enrolmentInScope` | — | ✔ HTTP key + `clientAttemptId` | private, no-store |
| 23 | `GET /api/staff/calls/holidays` | stf | n/a (GET) | n/a | n/a | ✔ `requireSuper` | n/a | private, no-store |
| 24 | `POST\|PUT\|DELETE /api/staff/calls/holidays` | stf | ✔ | ✔ `holidaySchema` | n/a | ✔ `requireSuper` | ✔ `Idempotency-Key` | private, no-store |
| 25 | `POST /api/staff/calls/tasks/[id]/lease` | stf | ✔ | ✔ `leaseTaskSchema` | `enrolmentInScope` | n/a | ✔ | private, no-store |
| 26 | `POST /api/staff/calls/tasks/[id]/close` | stf | ✔ | ✔ `closeTaskSchema` | `enrolmentInScope` | n/a | ✔ | private, no-store |
| 27 | `GET /api/staff/students` | stf | n/a (GET) | ✔ `studentSearchInput` | `studentScope` | n/a | n/a | private, no-store — **H1** |
| 28 | `POST /api/staff/students` | stf | ✔ | ✔ `studentSearchInput` | `studentScope` | n/a | n/a | private, no-store |
| 29 | `GET /api/staff/students/[id]` | stf | n/a (GET) | ✔ uuid | `studentScope` | n/a | n/a | private, no-store |
| 30 | `PATCH /api/staff/students/[id]` | stf | ✔ | ✔ `contactInput` | `studentDetail` (scope) | ✔ `nic.correct` for NIC edits | ✔ `Idempotency-Key` + `expectedVersion` | private, no-store |
| 31 | `GET /api/staff/enrolments/[id]` | stf | n/a (GET) | ✔ uuid | `enrolmentInScope` | n/a | n/a | private, no-store |
| 32 | `POST /api/staff/enrolments/[id]/[action]` | stf | ✔ | ✔ per action | `enrolmentInScope` (route + service) | ✔ per action | ✔ except `correction` | private, no-store |
| 33 | `GET /api/staff/programmes` | stf | n/a (GET) | n/a | scope-derived | n/a | n/a | private, no-store |
| 34 | `POST /api/staff/programmes` | stf | ✔ | ✔ `programmeInput` | `programmeInScope` | ✔ `programme.create` | ✔ | private, no-store |
| 35 | `GET /api/staff/programmes/[id]` | stf | n/a (GET) | ✔ uuid | `programmeInScope` + `intakeScopeWhere` | n/a | n/a | private, no-store |
| 36 | `PATCH /api/staff/programmes/[id]` | stf | ✔ | ✔ `programmeInput` | `programmeInScope` | ✔ `programme.manage` | ✔ + `expectedVersion` | private, no-store |
| 37 | `POST /api/staff/programmes/[id]/intakes` | stf | ✔ | ✔ `intakeInput` | `programmeInScope` + `intakeScopeWhere` | ✔ `programme.manage`/`create` | ✔ | private, no-store |
| 38 | `POST /api/staff/programmes/[id]/fee-plans` | stf | ✔ | ✔ `feePlanInput` | `inScope` + `programmeDetail` | ✔ `fees.adjust` | ✖ — **M6** | private, no-store |
| 39 | `GET /api/staff/admissions` | stf | n/a (GET) | ✔ `state` enum | `intakeScopeWhere` | n/a | n/a | private, no-store |
| 40 | `POST /api/staff/admissions` | stf | ✔ | ✔ `admissionInput` | `inScope` | ✖ none required | ✖ — **M5** | private, no-store |
| 41 | `POST /api/staff/admissions/[id]` | stf | ✔ | ✔ `decisionInput` | `inScope` | ✔ `admissions.decide` | replay-safe (version + row lock) | private, no-store |
| 42 | `GET /api/staff/team` | stf | n/a (GET) | n/a | n/a | ✔ `freshSuper` | n/a | private, no-store |
| 43 | `POST /api/staff/team/invite` | stf | ✔ | ✔ `inviteSchema` | `validateScopes` | ✔ `freshSuper` | ✔ | private, no-store |
| 44 | `POST /api/staff/team/accept` | pub | ✔ Origin/Host | ✔ `acceptSchema` | invitation token only | n/a | ✔ | private, no-store |
| 45 | `POST /api/staff/team/edit` | stf | ✔ | ✔ `editStaffSchema` | n/a | ✔ `freshSuper` | ✔ + `expectedVersion` | private, no-store |
| 46 | `POST /api/staff/team/status` | stf | ✔ | ✔ `statusSchema` | n/a | ✔ `freshSuper` | ✔ + `expectedVersion` | private, no-store |
| 47 | `GET /api/staff/trash` | stf | n/a (GET) | n/a | n/a | ✔ `freshSuper` | n/a | private, no-store |
| 48 | `POST /api/staff/trash` | stf | ✔ | ✔ `trashSchema` | n/a | ✔ `freshSuper` | ✔ + `expectedVersion` | private, no-store |
| 49 | `POST /api/staff/reports/export` | stf | ✔ | ✔ `ExportRequestSchema` | `intakeScopeWhere` | ✔ `exports.download`; `exports.full_identifiers` = Super only | n/a (read) | private, no-store |
| 50 | `GET /api/staff/imports` | stf | n/a (GET) | n/a | n/a | ✔ `imports.run` | n/a | private, no-store |
| 51 | `POST /api/staff/imports` | stf | ✔ | ✔ `csv` ≤ 5 MB | ⚠ scope applied to intakes only — **M2** | ✔ `imports.run` | ✔ `batchKey` + content hash | private, no-store |

*(51 handlers across 42 route files.)*

---

## 2. Findings

### HIGH

#### H1 — Raw NIC accepted in a URL query string on `GET /api/staff/students`

**File:** `src/app/api/staff/students/route.ts:5` → `src/server/services/directory.ts:30,34-37`

The route's own comment states *"Exact NIC searches only travel in a private POST body"*, and the UI does use POST (`src/app/staff/students/private-search.tsx:9`). But the GET handler forwards the raw query string verbatim:

```ts
export const GET = route(async req => json(await searchStudents(db(), await requireStaff(req),
  Object.fromEntries(req.nextUrl.searchParams))));
```

`searchStudents` parses with `studentSearchInput`, whose schema includes `nic: z.string().trim().max(20).optional()` (`directory.ts:30`), and when `nic` is present it performs an exact lookup (`directory.ts:34-37`). The guard that forces NICs into the POST body is applied to `q` only (`directory.ts:40`), never to `nic`.

Therefore `GET /api/staff/students?nic=199912345678` is a working exact-NIC search, and the raw NIC lands in:

* the browser address bar and session history,
* the Next.js / reverse-proxy / CDN access log (Vercel and most ingress log the full request path),
* any operator copy-paste of the URL.

`next.config.ts:6` sets `Referrer-Policy: same-origin`, which limits cross-origin referrer leakage, but it does nothing for logs or history.

**Why it matters:** §5 requires that *"Logs, analytics, errors, URLs, exports by default, and browser caches must not contain raw NICs"*, and `AGENTS.md` states *"No raw NIC in logs/URLs/exports/client storage"* as a hard rule. A raw national identifier in an access log is a data-protection incident, and access logs are commonly shipped to third-party log aggregators with broader retention than the database.

**Fix:** strip `nic` from GET search params and reject it outright.

```ts
export const GET = route(async (req) => {
  const p = await requireStaff(req);
  const sp = new URL(req.url).searchParams;
  if (sp.has("nic")) throw fail.validation("Use the private exact NIC search field.");
  return json(await searchStudents(db(), p, Object.fromEntries(sp)));
});
```

Add a regression test asserting `GET /api/staff/students?nic=…` returns 400 and never reaches `students.nicLookup`.

---

#### H2 — Unbounded request-body buffering on the receipt upload endpoint

**File:** `src/app/api/student/uploads/[id]/route.ts:10-13`

```ts
const len = Number(req.headers.get("content-length") ?? 0);
if (len > MAX_BYTES()) throw fail.validation("The file is too large.");
const buf = Buffer.from(await req.arrayBuffer());
return json(await uploadToIntent(p, id, buf));
```

The size guard reads `content-length`, which is **optional** and **untrusted**. A request sent with `Transfer-Encoding: chunked` (or with a lying `content-length`) arrives with `len === 0`, passes the check, and is then fully materialised in memory by `req.arrayBuffer()`. The real limit is only enforced afterwards, inside `uploadToIntent` (`src/server/services/submissions.ts:75`), i.e. after the bytes are already resident.

Next.js route handlers have no built-in request-body cap — `serverActions.bodySizeLimit` applies only to Server Actions (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`). Nothing in `next.config.ts` adds a limit for route handlers.

**Why it matters:** impact is availability. Any student session — which anyone can mint by entering a known NIC and course — can send a single multi-gigabyte chunked PUT and force the Node process to allocate it. In a single-process deployment that is an OOM crash taking down the student portal and the staff console at once. The endpoint whose entire purpose is to accept up to 10 MiB has no working size enforcement.

**Fix:** stream the body and abort as soon as the cap is exceeded.

```ts
const limit = MAX_BYTES();
const reader = req.body?.getReader();
if (!reader) throw fail.validation("Upload body missing.");
const chunks: Buffer[] = [];
let total = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  total += value.byteLength;
  if (total > limit) { await reader.cancel(); throw fail.validation("The file is too large."); }
  chunks.push(Buffer.from(value));
}
const buf = Buffer.concat(chunks);
```

Also reject the request outright when `content-length` is present and greater than the limit (fail fast, before reading), and cap concurrent uploads per session.

---

### MEDIUM

#### M1 — Staff login is throttled by email only; there is no per-IP limit

**File:** `src/server/services/governance/auth.ts:19-34` (route: `src/app/api/staff/auth/login/route.ts:6-11`)

```ts
async function consumeLoginAttempt(email: string) { …
  const key = `staff-login:${hashToken(email, "login-rate")}`; … }
…
if (!await consumeLoginAttempt(v.email)) throw fail.throttled();
```

The bucket key contains only the email. There is no IP dimension anywhere in the login path.

**Why it matters (two distinct consequences):**

1. **Brute force / credential stuffing.** A single IP can attempt 10 passwords against *every* email it can enumerate, because each email gets its own bucket. There is no aggregate per-IP ceiling, so distributed spraying is unthrottled.
2. **Attacker-triggered lockout of a known staff account.** Ten bad attempts from anyone consume the target account's budget for 15 minutes. An attacker who repeats this every 14 minutes keeps a legitimate Super Admin locked out indefinitely. The 15-minute window is not "permanent", but the attacker controls the reset cadence, which makes the practical effect permanent. The spec requires *"no permanent account lockout an attacker can cause"* (§5, and the same principle in §4 for staff lifecycle).

Additionally, the counter is consumed by **successful** logins as well (`consumeLoginAttempt` runs before credential verification at `auth.ts:34`), so a legitimate operator who signs in 10 times in 15 minutes — normal for someone switching between the console and a tool — is throttled.

**Fix:** add a second, IP-keyed bucket applied to the same endpoint, and only charge the per-email bucket on failure.

```ts
const ip = clientIp(req);
const byIp = await hit("staff-login-ip", ip, 30, 900);
if (!byIp.allowed) throw fail.throttled();
```

Move `consumeLoginAttempt` to after credential verification and charge it only on the failure path, or keep charging it on both but reset the bucket on success. Both buckets must return the identical error body so they cannot be distinguished.

---

#### M2 — CSV import discloses the existence of out-of-scope students and intakes

**File:** `src/server/services/imports/students-import.ts:163-179` (`loadIntakes`), `:286-295` (intake error codes), `:331-344` (NIC duplicate check), `:345-358` (reference duplicate check)

Three scope leaks, all reachable by any staff member holding the delegable `imports.run` capability:

1. `loadIntakes(tx)` loads **every** intake in the system with no scope predicate, and the per-row error then distinguishes the two cases:

   ```ts
   const anyCode = intakesList.find((i) => i.intakeCode.trim().toLowerCase() === g.intakeCode.trim().toLowerCase());
   code: anyCode ? "INTAKE_OUT_OF_SCOPE" : "INTAKE_NOT_FOUND",
   message: anyCode ? "This intake exists but is not in your scope (or is in Trash)." : "Intake code was not found…"
   ```

   An Admin can enumerate intake codes and learn which exist outside their scope — the exact prohibition in §4 (*"An Admin assigned to course A cannot discover course B students through global search, guessed IDs, duplicate warnings, or aggregate counts"*) and in `AGENTS.md` (*"Out-of-scope records return `fail.notFound()` (never reveal existence)"*).

2. The NIC duplicate check queries `students.nic_lookup` **globally** (`:333`) and reports `NIC_ALREADY_REGISTERED` (*"This NIC already belongs to a student"*) regardless of the student's scope. §4 names *"duplicate warnings"* explicitly as a prohibited disclosure channel.

3. The student-reference duplicate check queries `students.ref` **globally** (`:347`) and reports `STUDENT_REF_EXISTS` in the same way.

**Fix:** scope all three lookups to the principal's visible intakes, and collapse the intake error into a single generic message.

```ts
async function loadIntakes(tx: DbOrTx, p: StaffPrincipal) {
  const rows = await tx.select({ … })
    .from(intakes).innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(intakeScopeWhere(p, intakes.id, intakes.programmeId),
               isNull(intakes.trashedAt), isNull(programmes.trashedAt)));
  …
}
```

Then return one code (`INTAKE_NOT_FOUND`) for both cases, and gate the NIC/reference duplicate checks on the referenced student's scope — an out-of-scope duplicate should be reported as "identifier unresolved", exactly as a duplicate *inside* scope is reported, so the two are indistinguishable.

---

#### M3 — Invitation bearer token travels in the URL path

**File:** `src/app/staff/invite/[token]/page.tsx:10,13,17`

The invitation token is a single-use bearer credential whose acceptance creates a staff account — potentially `SUPER_ADMIN` — and it is carried in the URL path and re-emitted into the page body (`<AcceptForm token={token} />`). It therefore appears in web-server access logs, CDN/edge logs and browser history. `metadata.referrer = "no-referrer"` (`:9`) limits referrer leakage only.

§15 requires: *"Do not leak access tokens through referrers or logs."*

`APP_BASE_URL` exists in `src/server/env.ts:16` and `.env.example` is described as *"used for invitation links"*, but `APP_BASE_URL` is referenced **nowhere** in the codebase (`rg APP_BASE_URL src/ scripts/` → only its own declaration). The intended server-generated invite link was never built, leaving the token-bearing URL as the only path.

**Fix:** make the landing page a plain static form and accept the code only in the POST body — the acceptance endpoint already does this (`POST /api/staff/team/accept` takes `token` in the body, `src/server/services/governance/index.ts:92`). The token can be pasted from the invitation message. Alternatively carry it in the URL **fragment** (`#token`), which the browser does not put in `Referer` or in the request line, and read it client-side before POSTing it in the body.

---

#### M4 — Financial and authorisation checks use the request-time principal, not a freshly reloaded one

**Files:**
`src/server/services/review.ts:76-79,144-147,197-199,242-244` ·
`src/server/services/enrolments.ts:96-100,127-131,150-155,211-216,321-327,253-257,287-291` ·
`src/server/services/imports/students-import.ts:412`

`requireCap(p, …)` and `enrolmentInScope(tx, p, …)` are evaluated against the `StaffPrincipal` snapshot captured when the request began. If a Super Admin demotes, deactivates, or narrows the scope of the acting Admin while that Admin's request is in flight, the mutation still commits with the old authority.

`AGENTS.md` requires *"fresh authorization inside the tx"* for every mutation, and the codebase already implements that pattern in three places — `freshPrincipal` (`src/server/services/followups/shared.ts:16`), `freshDirectoryPrincipal` (`src/server/services/directory.ts:19`) and `freshSuper` (`src/server/services/governance/invariant.ts:32`). The governance, follow-up and directory services use them; the **review** and **enrolment** services — the ones that move money — do not.

**Why it matters:** the window is short, but it is exactly the window in which a privilege revocation is expected to bite, and the affected actions are `approve`, `reject`, `undo`, `correct`, `grantExemption`, `revokeExemption`, `applyCredit`, `withdrawEnrolment`, `decideAdmission` and `createFeePlanVersion`.

**Fix:** reload the principal inside the existing transaction and use the reloaded object for both the capability check and the scope check, exactly as `followups/attempts.ts:38` already does:

```ts
return withTx(async (tx) => {
  const actor = await freshPrincipal(tx, p);   // re-reads status, role, capabilities, scopes
  requireCap(actor, "exemptions.manage");
  const ctx = await enrolmentInScope(tx, actor, input.enrolmentId);
  …
});
```

Apply the same change in `review.ts` and `enrolments.ts` (and pass the reloaded principal into `importStudents`).

---

#### M5 — `POST /api/staff/admissions` accepts no idempotency key

**File:** `src/app/api/staff/admissions/route.ts:7` → `src/server/services/enrolments.ts:287-306`

`createAdmission` unconditionally inserts an `admissions` row and an `admissionEvents` row. There is no `Idempotency-Key`, no uniqueness constraint and no replay guard. A double-click, a client retry after a timeout, or a replayed proxy request creates duplicate applicants. `decideAdmission` then treats those duplicates as independent people, and accepting one will either create a duplicate enrolment or hard-fail with *"This person is already enrolled in this intake"*.

§14: *"Critical mutations accept an idempotency key and expected record version."*

**Fix:** accept the header and wrap the insert in the project's existing `once()` helper, matching every other mutation in the codebase:

```ts
export const POST = route(async (req, ctx) => {
  const p = await requireStaff(req);
  const input = await parseBody(req, admissionInput);
  return json(await createAdmission(p, input, idempotencyKey(req), ctx.requestId));
});
```

```ts
return (await once(tx, `admission:${p.id}`, idemKey, input, async () => { … })).result;
```

---

#### M6 — `POST /api/staff/programmes/[id]/fee-plans` accepts no idempotency key

**File:** `src/app/api/staff/programmes/[id]/fee-plans/route.ts:7-10` → `src/server/services/enrolments.ts:253-266`

`createFeePlanVersion` unconditionally inserts a new immutable `fee_plan_versions` row with `versionNo = max + 1` and flips `isCurrent`. A retried request silently produces a second version. There is no `expectedVersion` on the intake either, so the operation cannot be made conditional on the caller's view of the intake. Fee-plan versions drive instalment generation for later acceptances (`decideAdmission` snapshots whatever version `isCurrent` at that moment), so a duplicated version changes which schedule future enrolments receive.

**Fix:** accept `Idempotency-Key` and wrap in `once(tx, 'feeplan:<staffId>:<intakeId>', key, input, …)`; add `expectedVersion` on the intake if the schedule must be conditional on a known state.

---

#### M7 — `undo` and `correct` review actions accept no idempotency key

**File:** `src/app/api/staff/review/[id]/[action]/route.ts:59-66`

`approve` (`:53`) and `reject` (`:57`) both call `idempotencyKey(req)` and their services wrap the work in `once(tx, 'review:<staffId>', key, input, …)` (`review.ts:76,144`). `undo` (`:61`) and `correct` (`:65`) do neither, although both are financial mutations: `undo` reverses allocations and appends a `REVERSAL` payment event (`review.ts:214,171`), and `correct` does the same plus a status change.

**Mitigating factor (verified):** the blast radius is limited. `undoDecision` requires `sub.version === last.submissionVersion + 1` and `last.id === input.actionId` (`review.ts:201,204`), and `correctApproval` requires `expectedVersion` to match (`review.ts:245`). A replay therefore fails with a 409 rather than reversing money twice. The real defect is that a retry after a network timeout returns a *conflict* instead of the original result, which is exactly the case idempotency keys exist to handle — §14 and `AGENTS.md` ("idempotency where retries are possible").

**Fix:** apply the same `idempotencyKey(req)` + `once(...)` pattern used by `approveSubmission`.

---

#### M8 — The student entry IP limit counts successful entries and is too low for shared NAT addresses

**File:** `src/server/ratelimit.ts:22-25`, applied at `src/app/api/student/entry/route.ts:18-20`

```ts
perIp: { limit: Number(process.env.RL_ENTRY_IP ?? 30), windowSec: 15 * 60 },
```

`hit("entry-ip", …)` is called on **every** entry attempt, including the ones that succeed. The bucket is keyed by IP only, so **all** students sharing one address share one budget of 30 entries per 15 minutes.

**Why it matters:** mobile carrier CGNAT, campus NAT and office Wi-Fi all collapse many students into a single source address. 30 successful entries per 15 minutes across an entire carrier NAT is a low ceiling, and the symptom is a legitimate student being told *"Too many attempts. Please wait and try again."* at the moment they are trying to pay. Conversely, an attacker sharing a victim's egress address can deliberately exhaust that victim's budget — a cheap, targeted denial of service against the entry flow.

**Fix:** charge the IP bucket only on **failed** matches (keep the per-identity bucket on all attempts), and raise the default (e.g. 120/15 min) with the per-identity limit doing the real anti-brute-force work. Document both knobs — they are currently absent from `.env.example` (see **L4**).

---

### LOW

#### L1 — Two student session-mutating endpoints rely only on `SameSite=Strict`

**Files:** `src/app/api/student/logout/route.ts:6-9` · `src/app/api/student/device-entry/route.ts:8-15`

Neither calls `requireStudent(req)`, so neither validates the `x-csrf-token` or the `Origin`/`Host` pair. Every other student mutation does (`submissions`, `uploads`, `notifications` all pass `req`).

`POST /api/student/logout` is the more consequential of the two: it revokes the session, optionally revokes the remembered-device token, and returns `Clear-Site-Data: "cache", "storage"`. `POST /api/student/device-entry` starts a new student session from the device cookie.

**Why it is only Low:** the student and device cookies are both `SameSite=Strict` (`src/server/auth/student.ts:71,83`), so a cross-site request will not carry them and the attack does not reach the handler. The protection is therefore real, but it is a single control with no defence in depth, and `assertPublicOrigin` (already written for the public staff endpoints, `src/server/services/governance/public-origin.ts:5-14`) is not applied.

**Fix:** apply `assertPublicOrigin(req)` to both handlers. Once a student session exists, `device-entry` can additionally use `requireStudent(req)` when a session is present.

---

#### L2 — Loose UUID validation in `enrolmentInScope` yields 500 instead of 404

**File:** `src/server/auth/policy.ts:90`

```ts
if (!/^[0-9a-f-]{36}$/i.test(enrolmentId)) throw fail.notFound();
```

The regex accepts any 36 characters drawn from `[0-9a-f-]`, including 36 dashes. `enrolments.id` is a real `uuid` column (`src/db/schema.ts:22,248-249`), so the subsequent `eq(enrolments.id, enrolmentId)` reaches PostgreSQL as an invalid uuid literal and raises `22P02`, which `route()` maps to a generic **500 INTERNAL** instead of the intended 404.

**Why it matters:** no data is exposed and the message is generic, but the contract in `AGENTS.md` is that out-of-scope or non-existent ids return `fail.notFound()`. A 500 also pollutes error dashboards and implies a server fault where the request was merely malformed. Reachable on `GET /api/staff/enrolments/[id]` and `POST /api/staff/enrolments/[id]/[action]`.

**Fix:** use `z.string().uuid().safeParse(enrolmentId).success` (or a strict `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` case-insensitive pattern) instead of the character-class test.

---

#### L3 — Internal private-storage object keys are returned to the staff client

**File:** `src/server/services/review.ts:352,371` (`asset` is the full `receiptAssets` row)

The review context response includes `receiptAssets.objectKey` and `receiptAssets.previewKey` — values of the form `receipts/<enrolmentId>/<24-hex>` and `…preview.webp`. The staff client even declares `previewKey` in its type (`src/app/staff/review/review-workspace.tsx:15`), though it does not render it.

**Why it matters:** low. These are storage keys, not URLs or credentials — the evidence route (`src/app/api/staff/review/[id]/[action]/route.ts:31-38`) re-checks session auth and scope on every request, and the local store writes outside `public/` (`src/server/storage.ts:57`). But the keys are unnecessary in the payload and disclose internal storage layout and the enrolment id, enlarging the blast radius if the storage root is ever exposed by an unrelated misconfiguration.

**Fix:** project the asset explicitly — `{ mime, pages, scan, validation, sizeBytes, width, height }` — instead of returning the whole row.

---

#### L4 — `env()` is never called, and the rate-limit knobs are undocumented

**Files:** `src/server/env.ts:21` · `src/server/ratelimit.ts:22-25` · `.env.example`

`src/server/env.ts` defines a validated environment schema (`DATABASE_URL`, the three 32-byte keys, `STORAGE_DRIVER`, `RECEIPT_MAX_BYTES`, …) behind `export function env()`, but `rg "env\." src/` shows **`env()` is never called anywhere in `src/`**. The schema therefore provides no fail-fast boot check: a deployment with a missing or short `NIC_ENCRYPTION_KEY` starts normally and only fails on the first request that touches `key()` (`src/lib/crypto.ts:8-14`). The individual `process.env` reads scattered across `auth/student.ts`, `storage.ts`, `ratelimit.ts` and `cron.ts` are not validated.

Separately, `RL_ENTRY_IP` and `RL_ENTRY_IDENTITY` are the documented-by-code knobs for the student entry limiter (§5 requires *"sensible configurable thresholds"*) but appear in neither `.env.example` nor `docs/`.

**Fix:** call `env()` once at module load in a server-only bootstrap module (or in `instrumentation.ts`) so a misconfigured deployment fails at boot, and add `RL_ENTRY_IP`, `RL_ENTRY_IDENTITY`, `REVIEW_UNDO_WINDOW_SECONDS` and `T2T_BUSINESS_WEEKDAYS` to `.env.example` with their defaults and meanings.

---

#### L5 — Student entry leaks NIC existence through response timing

**File:** `src/server/auth/student.ts:45-52`

```ts
const [s] = await db().select({ id: students.id }).from(students).where(eq(students.nicLookup, nicLookup(nic)));
if (!s) return null;
const e = await eligibleEnrolment(db(), s.id, intakeId);
```

A NIC that exists costs two database round trips; a NIC that does not exist costs one. The response **body and status are identical** in every failure mode, which satisfies §5's *"same neutral message"* requirement, but the timing differs by one round trip.

**Why it is only Low:** the effect is one query's latency (~1–5 ms) and it is heavily constrained by the per-IP and per-identity limits — 30 probes per IP per 15 minutes by default. It becomes practical only for an attacker with many source addresses, and even then the signal is weak.

**Fix:** perform the eligibility join in a single statement so that "no student" and "no eligible enrolment" cost the same — e.g. one query joining `students → enrolments → intakes → programmes` filtered by `nicLookup` and `intakeId`, returning a row or nothing.

---

## 3. Verified correct (checked, not reported as findings)

These were all explicitly in scope and all passed; they are listed so the reviewer knows they were examined rather than skipped.

* **Student entry neutrality.** Every failure mode — invalid format, unknown NIC, inactive student, inactive enrolment, trashed intake/programme, mismatched intake — returns the identical body `{ ok: false, message: "We could not find an eligible enrolment." }` with status 404 (`src/app/api/student/entry/route.ts:24`, `src/server/auth/student.ts:13,45-52`). Rate-limit keys are HMAC'd, so no raw NIC or IP is stored in `rate_limit_buckets` (`src/server/ratelimit.ts:11`).
* **CSRF.** `requireStaff(req)` compares `x-csrf-token` with `safeEqual` (constant-time) and adds an Origin/Host equality check on every non-GET method (`src/server/auth/staff.ts:69-89`); `requireStudent(req)` does the same for the student session (`src/server/auth/student.ts:124-131`). Every staff mutation passes `req`; every student mutation except the two noted in **L1** does. The public staff endpoints (`login`, `team/accept`) use `assertPublicOrigin`, which rejects `Sec-Fetch-Site: cross-site` and any cross-origin `Origin`.
* **Session cookies.** Staff: `HttpOnly`, `Secure` in production, `SameSite=Lax` (`src/server/auth/staff.ts:26-28`). Student and device: `HttpOnly`, `Secure` in production, `SameSite=Strict` (`src/server/auth/student.ts:71,83`). Both use `path="/"`; neither is readable from JavaScript.
* **Session revocation.** Staff sessions are revoked on deactivation, role change, scope change and Trash via `revokeAllStaffSessions` + an `authVersion` bump (`src/server/services/governance/index.ts:133,159`, `src/server/services/trash/index.ts:47`), and the authoritative account state is re-read on every request (`src/server/auth/staff.ts:47-50`). Student sessions are revoked on withdrawal (`src/server/services/enrolments.ts:228`) and on programme/intake Trash (`src/server/services/trash/index.ts:53`), and student eligibility is re-checked on every protected request (`src/server/auth/student.ts:112-117`).
* **Super Admin invariant.** Enforced under a locked singleton row shared by bootstrap, invite, accept, edit, status and Trash (`src/server/services/governance/invariant.ts:11-29`); every lifecycle writer acquires it *before* the staff row lock. Pending invitations are inactive and do not consume slots.
* **Error responses.** `errorBody` returns a uniform taxonomy with a generic INTERNAL message and a request id; internal errors are logged server-side only (`src/server/http.ts:34-41`). **No stack traces are returned to clients.**
* **XSS.** `rg "dangerouslySetInnerHTML|innerHTML|eval\(|new Function"` over `src/` returns **no matches**. All user-supplied content (names, notes, rejection reasons, labels, banners) is rendered through React's default escaping.
* **Open redirects.** Every `redirect()` target in `src/` is a literal path — no user-controlled destination exists.
* **CSV formula injection.** `neutralizeCell` prefixes a `'` to any cell beginning with `= + - @ TAB CR`, and is applied to every cell *and* to the header row (`src/lib/csv.ts:1-33`). All exports route through `toCsv` (`src/server/services/reports/exports.ts:392`). Export filenames are sanitised to `[A-Za-z0-9._-]` before being placed in `Content-Disposition` (`exports.ts:69-71`).
* **Evidence delivery.** Both evidence routes return `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Referrer-Policy: no-referrer` (`src/app/api/student/submissions/[id]/evidence/route.ts:12-18`, `src/app/api/staff/review/[id]/[action]/route.ts:34-37`). Ownership is re-resolved from the session or from `enrolmentInScope` on **every** request; a client-supplied enrolment or object key is never trusted.
* **Upload validation.** Magic bytes via `file-type`, MIME cross-checked against the declared type, real decode via sharp / pdf-lib, dimension and page caps, encrypted-PDF rejection, and an allowlist that excludes SVG and executables (`src/lib/files/validate.ts:149-192`). Previews are re-encoded to WebP, never the uploaded bytes. Uploads are quarantined behind a 30-minute intent TTL and an orphan-cleanup grace period (`src/server/services/submissions.ts:19-20,187-199`).
* **Private storage.** Receipts never live under `public/`; `LocalStore.file` enforces a key pattern plus a resolved-path containment check (`src/server/storage.ts:27-32`), and `STORAGE_DRIVER=local` refuses to start in production unless explicitly overridden (`storage.ts:54-56`). Media purge resolves symlinks and checks references across all rows, including trashed ones (`src/server/services/trash/purge.ts:20-40`).
* **NIC confidentiality.** `decryptNic` is referenced in exactly one place — the Super-Admin-only, audited full-identifier export (`src/server/services/reports/exports.ts:103`). Everywhere else only `students.nic_masked` is exposed. NICs are encrypted at rest with AES-256-GCM and matched with a keyed HMAC-SHA256 digest, never an unsalted hash (`src/lib/crypto.ts:17-35`). `audit.redact` strips any key matching `/nic|password|token|secret|hash/i` except `*masked*` (`src/server/audit.ts:5-18`). The client never persists a NIC: the entry form keeps it in React state only and stores just the public intake id in `localStorage` (`src/app/_entry/entry-form.tsx:8,42,56`).
* **Import validation.** Dry-run performs every check with no writes; commit is all-or-nothing for blocking errors and idempotent by `batchKey` plus a content hash (`src/server/services/imports/students-import.ts:437-451,551-557`). Duplicate NICs inside a file are never merged silently (`students-import.ts:274-284`).
* **Cron authentication.** All four cron routes require `Authorization: Bearer <CRON_SECRET>` compared with `safeEqual`; an unset secret fails closed (`src/server/cron.ts:6-11`, and the equivalent inline check in `src/app/api/cron/{followups,purge}/route.ts:8`).
* **Caching.** `next.config.ts` applies `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: same-origin` and a restrictive `Permissions-Policy` globally, and `private, no-store` on `/me`, `/staff`, `/api/student/*` and `/api/staff/*`. The service worker allowlist excludes every `/api/` path except `/api/public/courses` and all navigations (`public/sw-policy.js:14-34`), and additionally refuses any response carrying `no-store`/`private` (`public/sw.js:49-55`).
* **Money handling.** All monetary values are integer minor units end-to-end; no float arithmetic appears in the ledger or allocation paths.
* **Body validation.** Every mutating route parses its body with a zod schema through `parseBody`, which rejects non-JSON with a 400 (`src/server/http.ts:71-75`). Unknown/extra keys are ignored rather than passed through, and no route trusts a client-supplied balance, role or enrolment id.

---

## 4. Recommended order of work

1. **H1** — one-line change to the students GET handler; removes raw NICs from URLs and logs.
2. **H2** — stream the upload body with an early abort; removes a one-request process-kill.
3. **M1** + **M8** — add the per-IP login bucket, charge failure-only on both login and student entry, and document the knobs.
4. **M2** — scope the import duplicate checks and collapse the intake error codes.
5. **M4** — swap the request-time principal for a freshly reloaded one in `review.ts` and `enrolments.ts`.
6. **M5 / M6 / M7** — add `Idempotency-Key` to the three remaining mutation paths.
7. **M3**, **L1**–**L5** — invitation-token transport, CSRF defence-in-depth on the two student endpoints, strict uuid validation, asset projection, env validation.

---

## 5. Limitations of this review

* Static reading only. Nothing was executed; no runtime behaviour, header propagation through a real CDN, or browser cache inspection was observed. Items marked as "verified" were verified by reading the code, not by exercising it.
* No dependency or supply-chain scan was performed (`pnpm audit` was not run), so a vulnerable transitive package is not ruled out. `pnpm-lock.json` pins versions, but the lockfile was not analysed.
* The Playwright end-to-end suite and the vitest suites were not run; a finding could in principle be covered by a test that this static review missed.
* `src/components/**` was reviewed only for the XSS class of issue (no `dangerouslySetInnerHTML` exists); a full accessibility and client-side review of the UI was out of scope.
* The review covered the API surface and the server services it reaches. Client-side behaviour that could produce an attacker-controlled request — for example a compromised or malicious browser extension — is outside the trust boundary assumed throughout.
