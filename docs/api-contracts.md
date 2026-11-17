# HTTP API contracts

Source snapshot: 2026-11-16; routes under `src/app/api/**/route.ts`. This documents implemented behavior and remaining deployment boundaries. Route path `[id]` is a UUID unless otherwise stated. Next 16 route params are promises and handlers await them. Source links are relative to this document.

## Common transport, auth and errors

JSON bodies use `Content-Type: application/json`. Monetary fields ending `Minor` are positive/nonnegative integer LKR cents as specified, not decimal LKR. Dates are `YYYY-MM-DD` in Asia/Colombo; serialized Date values are ISO instants. `?` below means optional, `=value` is a default; explicit null is permitted only where stated. Unknown Zod object properties are stripped unless a schema overrides that behavior.

| Auth label | Implemented check |
|---|---|
| Public | No existing session required. Entry/login have rate limits. Staff login and invitation acceptance validate public request origin. Student logout is also callable without a valid session. |
| Student | HttpOnly `t2t_student` opaque session, checked against active student/enrolment/intake/programme and expiry/revocation on each request. Mutating protected requests need `x-csrf-token` from the session meta token. |
| Staff | HttpOnly `t2t_staff` opaque session; active account, current auth version and current scope. Protected writes require `x-csrf-token` (staff layout renders `<meta name="csrf-token">`) and same-origin validation. Capabilities and scope are checked server-side; out-of-scope IDs return NOT_FOUND. |
| Super | Staff plus SUPER_ADMIN. Admin capability flags cannot grant staff/Trash/global-correction authority. |
| Cron | `Authorization: Bearer <CRON_SECRET>`, server configuration required. No staff/student cookie can replace this. |

`Idempotency-Key` is required only where **K** appears below: 8–200 characters. Reuse it for a retry of the same logical payload; use a new key after editing data. Header lookup is case-insensitive. Replay helpers reject changed data with IDEMPOTENCY_MISMATCH. Student finalization compares the intent, target, amount, transfer date, reference, note and replacement link before replaying. Admission creation fingerprints the normalized NIC through its keyed lookup digest, never through a plain identifier hash. Endpoints without K may have state-based replay but do not universally support header-based idempotency. Expected versions are explicit in the schemas below; missing version fields are documented gaps.

`src/server/http.ts` wraps most routes with an `x-request-id` and `Cache-Control: private, no-store, max-age=0`, `Pragma: no-cache`, `Vary: Cookie`. Public courses is an intentional cacheable exception. JSON successes have no universal `{data:...}` envelope; shapes below are the actual top-level returns. Default success is 200 unless stated. Evidence/export endpoints return bytes/CSV. Framework unsupported-method responses (405) are outside the JSON wrapper.

Error body:

```json
{"error":{"code":"STALE","message":"This record changed.","details":{},"requestId":"..."}}
```

`details` can be omitted. Zod errors use `details.issues: [{path,message}]`. No stack trace is returned.

| Code | HTTP | Typical cause |
|---|---|---|
| VALIDATION | 400 | Invalid JSON/fields, missing K, invalid file/date/allocation |
| UNAUTHENTICATED | 401 | Missing/expired/revoked session, inactive/stale staff auth, invalid cron secret |
| FORBIDDEN | 403 | Capability/CSRF/origin failure |
| NOT_FOUND | 404 | Missing **or out-of-scope** record, unknown action |
| CONFLICT | 409 | Decided/settled record, expired upload, cap/deadline/dependency conflict |
| STALE | 409 | Expected version differs; review errors may include currentStatus/currentVersion/decidedBy/decidedAt |
| THROTTLED | 429 | Postgres-backed entry/login rate limit |
| DEPENDENCY_UNAVAILABLE | 503 | Taxonomy exists; adapters currently often throw and become INTERNAL instead |
| IDEMPOTENCY_MISMATCH | 422 | Same operation/key reused with different payload |
| INTERNAL | 500 | Unexpected failures; server logs request ID and error message |

Every protected route can return auth/scope errors; writes can return validation/conflict/stale errors where their schemas and service checks apply. Purge returns HTTP 503 with its **result object**, not the error envelope, when individual cleanup records fail. Student entry mismatch is a deliberate 404 exception: `{ok:false,message:"We could not find an eligible enrolment."}` for invalid/unknown/inactive/mismatched credentials alike.

## Public and student routes

| Method and path | Auth / K | Input | Response |
|---|---|---|---|
| GET `/api/public/courses` | Public | None | `{courses:[{intakeId,programmeCode,programmeName,intakeLabel,bannerPath,logoPath}]}`. Only active/public/live intakes and parents. Public max-age=60, stale-while-revalidate=300. |
| POST `/api/student/entry` | Public | `{nic:string(max40),intakeId:string(max40),remember?:boolean=false}` | `{ok:true}` + session cookie; optional remembered-device cookie. Neutral mismatch 404 above. |
| POST `/api/student/device-entry` | Public + device cookie | `{intakeId:string(max40)}` | Same successful session and neutral mismatch. Uses HttpOnly device token; never accepts a student ID. |
| POST `/api/student/logout` | Public/session cleanup | `{forgetDevice?:boolean=false}` | `{ok:true}`; expires/revokes session; forget also revokes device. Clear-Site-Data cache; forget adds storage. |
| GET `/api/student/submissions` | Student | None | `StudentDashboard` below. |
| POST `/api/student/uploads` | Student | `intentInput` | `{intentId,expiresAt,maxBytes}`. Intent TTL 30 minutes, default max 10 MiB. |
| PUT `/api/student/uploads/[id]` | Student | Raw binary body, not multipart/JSON. Content-Length checked if present, actual size checked too. | `{ok:true}` after private object write. Missing/foreign intent is 404; expired/completed intent is 409. |
| POST `/api/student/submissions` | Student, K | `submitInput` | 201 `{submissionId,status,warnings:string[],replayed:false}`; replay 200 with replayed=true. Validation checks stored bytes; bad file may clean the upload and return VALIDATION. |
| GET `/api/student/submissions/[id]/evidence` | Student | `v=original` or default preview | Receipt bytes and detected MIME; private/no-store, nosniff, sandbox CSP, no-referrer. Preview falls back to original for PDFs. |
| POST `/api/student/notifications` | Student | No body | `{ok:true}`; marks this enrolment's notifications read. |

Schemas: [submissions.ts](../src/server/services/submissions.ts), [student auth](../src/server/auth/student.ts), [catalog](../src/server/services/catalog.ts).

- `intentInput`: `{mime:"image/jpeg"|"image/jpg"|"image/png"|"image/webp"|"application/pdf",sizeBytes:positiveInt}`. Size must not exceed configured maximum; jpg normalizes to jpeg.
- `submitInput`: `{intentId:uuid,targetInstalmentId:uuid,claimedMinor:positiveInt(max 100000000000),transferDate:bizDate,bankReference?:trimmedString(max80),studentNote?:trimmedString(max500),supersedesSubmissionId?:uuid}`. Empty optional reference/note becomes null. Future transfer dates fail. Replacement requires a rejected predecessor in the same enrolment; one successor only. File flags include OLD_TRANSFER, UNUSUAL_AMOUNT, DUPLICATE_FILE/ELSEWHERE and DUPLICATE_REFERENCE/ELSEWHERE; cross-scope flags do not include another student's identity.
- `StudentDashboard`: `{student:{name,ref,nicMasked},programme:{name,code,bannerPath,logoPath},intake:{label},enrolmentStatus,ledger,suggested:InstalmentView|null,submissions:[{id,periodLabel,targetInstalmentId,claimedMinor,transferDate,bankReference,status,submittedAt,supersedesSubmissionId,hasAsset,decisions:[{kind,reason,confirmedMinor,at}]}],notifications:[{id,title,body,createdAt,read}]}`. History is capped at 100 submissions and 20 notifications; private staff notes are not included. Ledger shape is defined below.

Entry rate defaults: 30 attempts/IP and 8/identity+intake in 15 minutes, configurable `RL_ENTRY_IP`, `RL_ENTRY_IDENTITY`. Buckets store HMACs, not raw identity/IP. Device entry uses the IP bucket. File validation defaults: JPEG/PNG/WebP/PDF, 10 MiB, 50 million pixels, minimum image side 50px, 20 PDF pages; corrupt/encrypted PDFs and unsupported/mismatched content fail. Receipt validation codes in details include TOO_LARGE, EMPTY, UNSUPPORTED_TYPE, MIME_MISMATCH, CORRUPT, ENCRYPTED_PDF, TOO_MANY_PAGES and DIMENSIONS.

### Shared intake entry link

`GET /join/[intakeId]` is a page route, not an API endpoint. Staff copy/open controls on Programme intake details construct `/join/<intake UUID>`. The page uses the public catalogue, which includes only active, public, non-trashed intakes and programmes. It displays that fixed programme/intake and passes a fixed intake to the NIC form, so remembered-course state cannot switch the link's target. Invalid links use the same unavailable page. The page is dynamic and private/no-store. `POST /api/student/entry` returns the same neutral 404 message for unknown, invalid, inactive or mismatched NIC/intake pairs.

## Staff authentication, governance and Trash

| Method and path | Auth / K | Input | Response |
|---|---|---|---|
| POST `/api/staff/auth/login` | Public, K | `loginSchema` | `{ok:true}` + staff cookie; generic bad-credential 401. Rate limit: 10 attempts/email/15 min. |
| POST `/api/staff/auth/logout` | Staff, K | No body | `{ok:true}`; revokes current session and clears cookie. |
| GET `/api/staff/team` | Super | None | `{staff:[PublicStaff & {scopes}],programmes:[{id,name}],intakes:[{id,programmeId,label}]}` |
| POST `/api/staff/team/invite` | Super, K | `inviteSchema` | 201 `{id,expiresAt,token}`. Token must be handled as a credential; delivery is operator-driven, not a live email integration. |
| POST `/api/staff/team/accept` | Public invitation token, K | `acceptSchema` | `PublicStaff`; **does not sign in automatically**. Seven-day expiry and single use; active Super cap is checked atomically. |
| POST `/api/staff/team/edit` | Super, K | `editStaffSchema` | `PublicStaff`; bumps auth version and revokes sessions. |
| POST `/api/staff/team/status` | Super, K | `statusSchema` | `PublicStaff`; deactivation/activation rechecks last/max Super invariant. |
| GET `/api/staff/trash` | Super | None | `{serverNow,records,candidates,jobs}`; records include kind/deadline/status, jobs include run/error summary. |
| POST `/api/staff/trash` | Super, K | `trashSchema` | `{id,version,action}`. Restore deadline is strict; restore-as-admin is staff-only. |

Schemas from [governance](../src/server/services/governance/index.ts), [auth](../src/server/services/governance/auth.ts), [Trash](../src/server/services/trash/index.ts):

- `loginSchema`: `{email:email(max254),password:string(1..256)}`; email lowercased/trimmed after validation.
- Identity-resolution APIs additionally require `nic.correct`, a Super Admin-only capability.
- `Scope`: `{programmeId:uuid,intakeId?:uuid|null=null}`; `Capability` is one of programme.manage, programme.create, fees.adjust, exemptions.manage, withdrawals.manage, exports.download, admissions.decide, imports.run.
- `inviteSchema`: `{email:email(max254),name:trimmedString(1..150),role:"SUPER_ADMIN"|"ADMIN",capabilities?:Capability[](max20)=[],scopes?:Scope[](max200)=[]}`.
- `acceptSchema`: `{token:string(32..200),password:string(12..256)}`.
- `editStaffSchema`: `{id:uuid,version:positiveInt,role,capabilities:Capability[](max20),scopes:Scope[](max200),reason:trimmedString(1..1000)}`.
- `statusSchema`: `{id:uuid,version:positiveInt,action:"deactivate"|"reactivate",reason:trimmedString(1..1000)}`.
- `trashSchema`: `{kind:"programme"|"intake"|"staff",id:uuid,version:positiveInt,action:"trash"|"restore"|"restore-as-admin",reason:trimmedString(1..1000)}`.
- `PublicStaff`: `{id,name,email,role,status,capabilities,version,trashedAt}`. Password hash/session/token internals are excluded.

## Staff directory, admissions and enrolment finance

| Method and path | Auth / K | Input | Response |
|---|---|---|---|
| GET `/api/staff/students` | Staff | `studentSearchInput` query without nic; any nic query key is rejected with VALIDATION | `{count,rows:[Student & {enrolments:[{id,studentId,status,programmeName,intakeLabel}]}],nextCursor}` |
| POST `/api/staff/students` | Staff | `studentSearchInput` JSON (private exact NIC search) | Same search shape; read-only despite POST. |
| POST `/api/staff/students/search` | Staff | `{nic:trimmedString(1..20)}` | Same scoped search shape. This newly added route currently validates exact NIC only; use the full-body POST above for q/cursor fields. |
| GET `/api/staff/students/[id]` | Staff | None | `{student:Student,enrolments:[{id,status,programmeName,intakeLabel,summary}]}` scoped to visible enrolments. |
| GET `/api/staff/students/export` | Staff + exports.download | None | Scoped student CSV attachment with masked NIC. Re-authorizes within a transaction and audits the export. |
| PATCH `/api/staff/students/[id]` | Staff, K | `contactInput` minus studentId | `Student`; NIC correction requires Super. |
| GET `/api/staff/programmes` | Staff | None | Programme rows in programme scope. |
| POST `/api/staff/programmes` | Staff + programme.create, K | `programmeInput` minus id/expectedVersion | Saved Programme row; delegated creator scope granted atomically. |
| GET `/api/staff/programmes/[id]` | Staff | None | `{programme,intakes:[Intake & {versions:[FeePlanVersion & {items:FeePlanItem[]}]}]}` in scope. |
| PATCH `/api/staff/programmes/[id]` | Staff + programme.manage, K | `programmeInput` minus id | Saved Programme row; expectedVersion required by service when editing. |
| POST `/api/staff/programmes/[id]/intakes` | Staff + programme.create/manage, K | `intakeInput` minus programmeId | Saved Intake row. Body id/expectedVersion edits existing intake; otherwise creates. |
| POST `/api/staff/programmes/[id]/fee-plans` | Staff + fees.adjust, K | `feePlanInput`; CSRF + `Idempotency-Key` | `{versionId,versionNo}`; creates a version without rewriting existing schedules; retries replay the same creation, while changed payloads conflict. |
| GET `/api/staff/fee-plan-application?versionId=uuid&after=uuid?` | Staff + fees.adjust | Current version UUID and optional enrolment cursor | `{items:[{id,name,ref,version,planVersionId}],nextCursor}`; active enrolments only, at most 100 per page. |
| POST `/api/staff/fee-plan-application` | Staff + fees.adjust; preview or apply | Preview: `{action:"preview",versionId,enrolmentIds}` (1–50 distinct IDs). Apply: `{action:"apply",versionId,reason,selections:[{enrolmentId,previewHash}]}` (1–50). | Preview returns `{versionId,versionNo,rows:[{enrolmentId,studentName,studentRef,expectedVersion,blocked,lines,previewHash}]}`. Apply returns `{applied,versionId}` and requires CSRF plus `Idempotency-Key`. Stale hashes return `STALE`; the batch is checked before any writes. Automatic mapping requires identical schedule count, sequence, due dates, components and period labels; structural differences block apply. |
| GET `/api/staff/admissions` | Staff | `state?` enum below | `{rows,choices}`; up to 200 admissions with masked NIC, decision/sponsorship fields and version; choices are live scoped intakes. |
| POST `/api/staff/admissions` | Staff, K | `admissionInput` | `{id,version}`; concurrent same-key retries return the original application without another event/audit. Fresh scope and non-trashed intake/parent checks precede replay. |
| POST `/api/staff/admissions/[id]` | Staff + admissions.decide, K | `decisionInput` minus admissionId | `{enrolmentId,replayed}`; same-key decisions replay without duplicate history. Reusing a key with a changed decision/reason/version conflicts. Accepted repeat with another key still returns the existing enrolment. |
| GET `/api/staff/imports/identity?status=open\|resolved\|all` | Super (`nic.correct`) | `status` defaults to `open`; invalid values default to `open` | `{items:[sanitized staged identity rows]}`; raw payload is not returned. |
| GET `/api/staff/imports/identity/[id]` | Super (`nic.correct`) | Staged-row UUID | Sanitized preview fields plus `expectedHash`; malformed or missing IDs return NOT_FOUND. |
| POST `/api/staff/imports/identity/[id]/resolve` | Super (`nic.correct`), K | `{nic,reason,ref?,schedule?,expectedHash}`; optional schedule amounts are decimal LKR strings | `{resolutionId,studentId,studentRef,enrolmentId,instalmentsCreated,replayed}`. Creates the student, enrolment and optional opening schedule, then marks the staged row resolved in one transaction; original source evidence remains unchanged. |
| GET `/api/staff/enrolments/[id]` | Staff | None | `{ctx,enrolment,student:{id,ref,fullName,nicMasked},intake,programme,ledger,awards,events,today}`. Events capped at 100. |
| POST `/api/staff/enrolments/[id]/exemption-preview` | Staff + exemptions.manage | `awardInput` minus enrolmentId | `{lines:[{instalmentId,periodLabel,netBefore,exemption,netAfter,releasedToCredit}],totalExemption,totalReleased}` |
| POST `/api/staff/enrolments/[id]/exemptions` | Staff + exemptions.manage, K | Same award body | `{awardId,lines}` |
| POST `/api/staff/enrolments/[id]/credit` | Staff + fees.adjust, K | `creditInput` minus enrolmentId | `{applied,lines:[{paymentEventId,amountMinor}]}`; **no expected version field** currently. |
| POST `/api/staff/enrolments/[id]/withdrawal-preview` | Staff + withdrawals.manage | `withdrawalInput` minus enrolmentId | `{cancel,retained,retainedArrearsMinor,creditAfterMinor,refundConsiderationMinor,openTasks}` |
| POST `/api/staff/enrolments/[id]/withdrawal` | Staff + withdrawals.manage, K | Same withdrawal body | `{enrolmentId,cancelled,creditMinor,retainedArrearsMinor}` |
| POST `/api/staff/enrolments/[id]/revoke-exemption` | Staff + exemptions.manage, K | `{awardId:uuid,reason:trimmedString(3..1000),expectedEnrolmentVersion:positiveInt}` | `{awardId}`; same-key replay returns the original result. Award must belong to path enrolment; changed payload conflicts. |
| POST `/api/staff/enrolments/[id]/correction-preview` | Super | `correctionInput` including submissionId | Correction preview below; submission must belong to path enrolment. |
| POST `/api/staff/enrolments/[id]/correction` | Super, K | Same correction body | Correction result below; same-key replay returns the original reversal result without another event. |

Schemas: [directory](../src/server/services/directory.ts), [enrolments](../src/server/services/enrolments.ts).

- `Student`: `{id,ref,fullName,phone,email,nicMasked,status,version,doNotCall,wrongNumber}`. Raw NIC/ciphertext/digest are excluded from these directory projections.
- `studentSearchInput`: `{q?:trimmedString(max200)="",nic?:trimmedString(max20),cursor?:uuid,limit?:int(1..100)=30}`. Name/ref/phone substring search; exact NIC requires format validation. Search total is independent of cursor. GET now rejects a nic query key; keep all identifiers in private POST bodies.
- `contactInput`: `{studentId:uuid,expectedVersion:positiveInt,fullName:trimmedString(2..200),phone:string(max30)|null,email:email(max200)|null,doNotCall:boolean,wrongNumber:boolean,nic?:string(max20),reason:trimmedString(3..500)}`. Changing contact information clears verification metadata; duplicate NICs conflict, never merge.
- `RecordFields`: `{code:string(1..40,letters/digits/_/-),bannerPath?:string(max200)|null=null,status:"DRAFT"|"ACTIVE"|"ARCHIVED",isPublic:boolean}`. Banner must resolve to an existing allowed file under public/banners.
- `programmeInput`: `RecordFields & {name:string(2..200),description?:string(max2000)="",id?:uuid,expectedVersion?:positiveInt}`.
- `intakeInput`: `RecordFields & {programmeId:uuid,label:string(1..100),startDate:bizDate,endDate:bizDate|null,id?:uuid,expectedVersion?:positiveInt}`; end >= start.
- `feePlanInput`: `{intakeId:uuid,notes?:string(max500)="",items:[{periodLabel:string(1..80),component?:string(1..40)="TUITION",amountMinor:nonnegativeInt,dueDate:bizDate}](1..120)}`.
- `admissionInput`: `{intakeId:uuid,applicantName:string(2..200),nic?:string(max20),phone?:string(max30),email?:email(max200)|"",sponsorshipRequested?:string(max500),notes?:string(max2000)}`. NIC, if provided, must normalize to a valid format. Missing identity blocks acceptance, not creation.
- Admission state filter: DRAFT, UNDER_REVIEW, ACCEPTED, REJECTED, WAITLISTED, WITHDRAWN. `decisionInput`: `{admissionId:uuid,decision:"ACCEPTED"|"REJECTED"|"WAITLISTED"|"WITHDRAWN"|"UNDER_REVIEW",reason?:string(max 1000),expectedVersion:positiveInt,confirmExistingStudent?:boolean=false}`; rejection/withdrawal needs reason, existing person reuse needs confirmation.
- `awardInput`: `{enrolmentId:uuid,type:"FREE_CARD"|"SPONSORSHIP"|"DISCOUNT"|"ARREARS_WAIVER",basis:"FIXED"|"PERCENT",value:positiveInt,capMinor?:positiveInt,reason:string(3..1000),sponsorName?:string(max200),effectiveFrom:bizDate,effectiveTo?:bizDate,instalmentIds:uuid[](1..120),expectedEnrolmentVersion:positiveInt}`. PERCENT max=10000 basis points; end >= start.
- `creditInput`: `{enrolmentId:uuid,instalmentId:uuid,amountMinor:positiveInt,reason:string(3..500),expectedEnrolmentVersion:positiveInt}`. The HTTP mutation requires the expected enrolment version.
- `withdrawalInput`: `{enrolmentId:uuid,effectiveDate:bizDate,reason:string(3..1000),expectedVersion:positiveInt}`.

## Review workspace

`[action]` is dispatched by the route below; unknown actions return NOT_FOUND.

| Method and path | Auth / K | Input | Response |
|---|---|---|---|
| GET `/api/staff/review/queue` | Staff | `queueFilters` query; repeated skip query keys allowed | `{items,nextCursor,totalPending}`. Items include submission/enrolment IDs, amount/date/flags/version, studentName/ref, programme/intake/period and lease. |
| GET `/api/staff/review/[id]/context` | Staff | None | `{submission,ctx,student:{name,ref,nicMasked,phone},programmeName,intakeLabel,asset,ledger,history,chain,actions,proposedPlan,isSuper,myLatestUndoable}` |
| GET `/api/staff/review/[id]/preview` | Staff | `confirmed?:positiveInt`, `spill=1` enables spill | `{amountMinor,plan:{lines:[{instalmentId,amountMinor}],creditMinor}}` |
| GET `/api/staff/review/[id]/evidence` | Staff | `v=original` or preview default | Private receipt bytes/MIME, nosniff/sandbox/no-referrer headers. |
| GET `/api/staff/review/[id]/correction-preview` | Super | None | `{submission,event:PaymentEvent|null,allocations:[PaymentAllocation & {periodLabel}]}`; event=null and empty allocations when no active receipt event exists. |
| POST `/api/staff/review/[id]/approve` | Staff, K | `approveInput` minus submissionId | Decision result including actionId/paymentEventId/plan/replayed. |
| POST `/api/staff/review/[id]/reject` | Staff, K | `rejectInput` minus submissionId | Decision result with actionId/replayed; retains evidence. |
| POST `/api/staff/review/[id]/undo` | Staff, own quick-window decision, K | `{actionId:uuid}` | Decision result; reversals preserve history. A committed same-key undo replays even after the quick window, with current authorization still required. |
| POST `/api/staff/review/[id]/correct` | Super, K | `correctionInput` minus submissionId | Correction result; reason/version required, same-key replay and changed-payload conflict. |
| POST `/api/staff/review/[id]/lease` | Staff | No body | `{leased:boolean,heldBy:string|null,until:ISOInstant}`. Short coordination lease; does not authorize approval. |
| POST `/api/staff/review/[id]/release` | Staff | No body | `{ok:true}` |

Schemas/results: [review.ts](../src/server/services/review.ts).

- `queueFilters`: `{programmeId?:uuid,intakeId?:uuid,period?:string(max100),from?:datePattern,to?:datePattern,flagged?:"any"|"flagged"|"clean"="any",cursor?:string(max200),limit?:int(1..50)=20,skip?:uuid[](max500)=[]}`. Cursor is `submittedAtISO|uuid`; oldest first. TotalPending is the scoped live pending total, not necessarily the filtered page count.
- `approveInput`: `{submissionId:uuid,expectedVersion:positiveInt,confirmedMinor?:positiveInt,amountChangeReason?:string(max500),spillOver?:boolean=false,allocations?:[{instalmentId:uuid,amountMinor:positiveInt}](max60)}`. Changed confirmed amount requires a reason; same-enrolment targets only and no over-allocation.
- `rejectInput`: `{submissionId:uuid,expectedVersion:positiveInt,reason:trimmedString(1..1000)}`.
- `correctionInput`: `{submissionId:uuid,reason:trimmedString(5..1000),expectedVersion:positiveInt}`.
- `DecisionResult`: `{submissionId,status:"APPROVED"|"REJECTED"|"PENDING_REVIEW",version,actionId,paymentEventId?,plan?}`; approve/reject add replayed. Quick undo defaults to 60 seconds (`REVIEW_UNDO_WINDOW_SECONDS`) and blocks dependent financial changes.

## Calls, promises and calendar

| Method and path | Auth / K | Input | Response |
|---|---|---|---|
| GET `/api/staff/calls` | Staff | `queueSchema` query | `{items:CallCard[],nextCursor,refreshedAt}`; cursor tracks examined rows, so a page can have fewer eligible cards. |
| GET `/api/staff/calls/[id]` | Staff | Enrolment UUID | `CallCard`, freshly scoped. |
| POST `/api/staff/calls/attempts` | Staff, K | `attemptSchema` | `{attempt,pointer,warning,submissions,version}`. Saves a record, never dials a phone. |
| POST `/api/staff/calls/tasks/[id]/close` | Staff, K | `{expectedVersion:positiveInt,reason:string(1..2000)}` | Updated FollowUpTask row. |
| POST `/api/staff/calls/tasks/[id]/lease` | Staff, K | `{expectedVersion:positiveInt}` | Updated FollowUpTask row with short lease. |
| GET `/api/staff/calls/holidays` | Super | None | BusinessHoliday rows ordered by day. |
| POST, PUT `/api/staff/calls/holidays` | Super, K | `{day:bizDate,label:string(1..2000),expectedLabel:string|null}` | `{day,removed:false}`; expectedLabel=null creates, existing label must match to update. |
| DELETE `/api/staff/calls/holidays` | Super, K | Same holiday body | `{day,removed:true}` |

Schemas from [attempts](../src/server/services/followups/attempts.ts), [queue](../src/server/services/followups/queue.ts), [tasks](../src/server/services/followups/tasks.ts), [calendar](../src/server/services/followups/calendar.ts).

- `queueSchema`: `{cursor?:uuid,limit?:int(1..50)=20}`.
- `attemptSchema` base: `{enrolmentId:uuid,expectedVersion:positiveInt,expectedStudentVersion?:positiveInt,clientAttemptId:string(8..200),outcome,notes?:string(max2000),manualOverrideReason?:string(1..2000),taskId?:uuid,correctsAttemptId?:uuid,resolved?:boolean,nextAction?:string(1..2000),nextDate?:bizDate,amountMinor?:positiveSafeInt,promisedDate?:bizDate,targetInstalmentIds?:uuid[](1..100),category?:string(1..100),reason?:string(1..2000),priority?:int(1..3),dueDate?:bizDate}`.

| Outcome | Additional validation and behavior |
|---|---|
| NO_ANSWER | Next business-day retry; third consecutive no-answer creates escalation and pauses automatic retries. |
| ANSWERED | Notes plus resolved=true, or resolved=false + nextAction + nextDate. |
| PROMISED_TO_PAY | Notes + amount + promisedDate + target IDs; no past date, no settled targets. Promise baseline records current approved allocations; no money change. |
| ALREADY_PAID | Verification task and recent submissions; does not mark paid. |
| NEEDS_ASSISTANCE | category/reason/priority/dueDate required; creates owned task. |
| NOT_CONTINUING | Returns withdrawal preview pointer; does not withdraw automatically. |
| FREE_CARD_SPONSORED | Returns authorized exemption pointer or approval task. |
| WRONG_NUMBER | expectedStudentVersion required; sets wrong-number flag. |
| CORRECTION | correctsAttemptId + notes required; appends history, never overwrites attempt. Only this outcome may reference correctsAttemptId. |

Call eligibility checks active/live enrolment, due collectible remaining balance, pending-evidence holds, contact flags, leases, prior daily attempts, escalation and future/deferred tasks. Manual override reason bypasses contact-window/deferred policy, not contact flags or debt/scope requirements. Defaults: weekdays Mon–Fri (`T2T_BUSINESS_WEEKDAYS` comma-separated JS weekday numbers), 09:00–17:00 Colombo, explicit holiday table. CallCard includes contact/status/version, ledger/dueInstalments/pendingEvidence, history/latestPromise/openTasks/nextAction and callable/windowOpen/deferred/flags. Promise edits are produced through call outcomes and recomputation; there is no separate promise CRUD route.

## Imports, reports and jobs

| Method and path | Auth / K | Input | Response |
|---|---|---|---|
| GET `/api/staff/imports` | Staff + imports.run | None | Private CSV template attachment. |
| POST `/api/staff/imports` | Staff + imports.run, K | `{csv:string(1..5000000),dryRun:boolean}` | `StudentImportResult` below; dry-run performs no commit. |
| POST `/api/staff/reports/export` | Staff + exports.download; Super for fullIdentifiers | `ExportRequestSchema` plus `format?:"csv"\|"pdf"` (default csv) | Private CSV or PDF attachment, Content-Disposition and X-Row-Count; synchronous generation, format audited. PDF amounts use decimal LKR; CSV keeps integer minor units. No K. |
| POST `/api/staff/exports` | Staff + exports.download; Super for fullIdentifiers, K | `ExportRequestSchema` | 202 `ExportJob` below. Queue creation is transactional, audited and payload-bound replayable. |
| GET `/api/staff/exports/[id]` | Staff, requesting owner only | Job UUID | 202 `ExportJob` + Retry-After: 5 while RUNNING; successful job returns a streamed CSV attachment with X-Row-Count. Failed/expired/foreign/scope-changed jobs are 404; current permissions are rechecked. |
| GET, POST `/api/cron/followups` | Cron | No body | `{skipped:true,processed:0}` or `{skipped:false,processed,scheduled,stale,hasMore}` |
| GET `/api/cron/outbox` | Cron | No body | `{sent,skipped}`; portal accounting only. |
| GET `/api/cron/exports` | Cron | No body | `{processed,failed,cleaned}`; worker defaults to 5 queued jobs plus cleanup of up to 100 expired objects. |
| GET `/api/cron/uploads-cleanup` | Cron | No body | `{scanned,cleaned}` |
| GET, POST `/api/cron/purge` | Cron | No body | `{jobId,processed,failed}`; 503 if failed>0. GET alias now matches Vercel Cron. |

- [Import result](../src/server/services/imports/students-import.ts): `{batchKey,dryRun,committed,replayed,totalRows,studentRows,studentsCreated,enrolmentsCreated,instalmentsCreated,identityResolutionsCreated,errors:[{row,field?,code,message,severity:"error"|"identity"}],warnings:string[]}`. CSV required columns: full_name, nic, intake_code, instalment_sequence, amount, due_date. Optional student_ref, phone, email, programme_code, period_label. Amount is decimal LKR in CSV and parsed to minor units server-side. One row per instalment; invalid identity is quarantined, not silently fabricated. Header mapping is normalized names, not arbitrary visual mapping.
- [ExportRequestSchema](../src/server/services/reports/exports.ts): `{report:"dashboard"|"students"|"outstanding"|"ageing"|"credits"|"receipts"|"transfer-receipts"|"allocations"|"exemptions"|"programme-totals"|"review-throughput"|"follow-up-outcomes"|"collection-rate",from?:string,to?:string,asOf?:string,programmeId?:uuid,intakeId?:uuid,groupBy?:"PROGRAMME"|"INTAKE",fullIdentifiers?:boolean}`. Dates have additional service validation. CSV uses explicit definitions/basis, masks NIC by default, audits full-identifier exports and neutralizes formula-like cells.
- [ExportJob](../src/server/services/reports/export-jobs.ts): `{id,report,status:"RUNNING"|"SUCCEEDED"|"FAILED",rowCount:number|null,expiresAt:ISOInstant|null,downloadUrl:string|null}`. Queued jobs expire after 24 hours; generated files after 15 minutes. GET on the same job URL polls while running and downloads when ready; no public/signed URL bypasses session/owner/current-capability checks. Role/scope changes invalidate prior authority; create a new job after those changes. Worker claims with SKIP LOCKED, retries dependency errors with 1/2-minute exponential delays (up to three attempts), and fails authorization/validation errors immediately. CSV generation still builds a complete in-memory CSV before private storage; the background boundary does not make it constant-memory. The worker requires an external scheduler invocation; provision its cadence separately from endpoint availability.

Dashboard/drilldowns/reports are server components calling `services/reports` directly; there are no JSON routes for every metric. Bootstrap and reconciliation are operator CLIs, not public endpoints. There is no student signup, OTP, payment gateway or refund-disbursement API.

## Shared ledger shape and known limits

`EnrolmentLedger = {enrolmentId,instalments:InstalmentView[],summary}`. Summary fields: netObligationMinor, approvedAllocatedMinor, pendingClaimedMinor, creditMinor, outstandingMinor, dueNowMinor, overdueMinor, collectedMinor, settled. Instalment fields: id, sequence, periodLabel, component, dueDate, originalChargeMinor, adjustmentsMinor, cancelledByAdjustment, exemptionsMinor, allocatedMinor, pendingClaimedMinor, netObligationMinor, remainingMinor, state, hasPendingEvidence. Settlement states and review states are intentionally separate.

Enrolment, review and import mutations refresh authoritative staff state inside their transactions. Admissions, exemption revocations, quick undo and approval corrections require payload-bound idempotency keys in addition to the existing version/state checks. Real malware-provider delivery, backup recovery and deployed scheduler/storage behavior require separate environment verification. Background exports have service/API implementations; their presence alone is not proof of a deployed worker or completed load test. See [architecture](architecture.md), [traceability](traceability.md) and `docs/agent-requests.md` for validation status.


### Storage capacity extension

POST `/api/staff/storage/refresh`: current Super Admin, session CSRF and Idempotency-Key required; body is a strict empty object. Returns `{state:"refreshed"|"cached"|"busy"|"failed",usage:{status,driver,budgetBytes,usedBytes,remainingBytes,objectCount,percentageUsed,measuredAt,stale,lastCheckFailed,savedBytes,archivedOriginals}}`. Unknown usage has null used/remaining values; provider errors are sanitized and retain prior successful totals. Global totals never reach ordinary Admins.

GET `/api/cron/storage`: Bearer CRON_SECRET required; Node runtime, maxDuration=300. Runs up to four bounded archival batches then forces actual inventory measurement. Returns `{batches,archiveFailed,storage}` with 503 on failed work. Inventory is attempted even when missing provider setup prevents archival. Original/preview evidence endpoints retain MIME/private/no-store/security headers; archived originals are transparently decoded to exact source bytes.
