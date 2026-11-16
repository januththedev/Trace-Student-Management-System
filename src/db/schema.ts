/**
 * T2T Student Operations System — authoritative PostgreSQL schema.
 *
 * Conventions
 *  - Money: integer minor units (LKR cents) in BIGINT columns, read as JS numbers.
 *    All values are asserted to be safe integers in src/lib/money.ts.
 *  - Business dates (due dates, transfer dates, promise dates): SQL DATE (Asia/Colombo).
 *  - Event instants: timestamptz (UTC).
 *  - Historical/financial tables use RESTRICT foreign keys (never cascade).
 *  - Ledger tables are append-only: reversals are new rows / reversal markers, never deletes.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, timestamp, date, jsonb,
  uniqueIndex, unique, index, foreignKey, check, primaryKey,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();

/* ------------------------------------------------------------------ enums */
export const staffRole = pgEnum("staff_role", ["SUPER_ADMIN", "ADMIN"]);
export const staffStatus = pgEnum("staff_status", ["ACTIVE", "DEACTIVATED"]);
export const recordStatus = pgEnum("record_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);
export const studentStatus = pgEnum("student_status", ["ACTIVE", "INACTIVE"]);
export const enrolmentStatus = pgEnum("enrolment_status", ["ACTIVE", "COMPLETED", "WITHDRAWN", "INACTIVE"]);
export const admissionState = pgEnum("admission_state", ["DRAFT", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "WAITLISTED", "WITHDRAWN"]);
export const submissionStatus = pgEnum("submission_status", ["PENDING_REVIEW", "APPROVED", "REJECTED"]);
export const reviewActionKind = pgEnum("review_action_kind", ["APPROVE", "REJECT", "UNDO", "CORRECTION"]);
export const paymentEventKind = pgEnum("payment_event_kind", ["RECEIPT", "REVERSAL", "HISTORICAL_IMPORT"]);
export const allocationSource = pgEnum("allocation_source", ["SUBMISSION", "CREDIT_APPLY", "EXEMPTION_REALLOCATION", "HISTORICAL_IMPORT"]);
export const adjustmentKind = pgEnum("adjustment_kind", ["MANUAL", "WITHDRAWAL_CANCEL", "FEE_CHANGE", "REACTIVATION"]);
export const exemptionType = pgEnum("exemption_type", ["FREE_CARD", "SPONSORSHIP", "DISCOUNT", "ARREARS_WAIVER"]);
export const exemptionBasis = pgEnum("exemption_basis", ["FIXED", "PERCENT"]);
export const awardStatus = pgEnum("award_status", ["ACTIVE", "REVOKED"]);
export const assetValidation = pgEnum("asset_validation", ["QUARANTINED", "CLEAN", "REJECTED"]);
export const scanStatus = pgEnum("scan_status", ["NOT_CONFIGURED", "PENDING", "CLEAN", "INFECTED", "ERROR"]);
export const uploadIntentStatus = pgEnum("upload_intent_status", ["PENDING", "FINALIZED", "EXPIRED", "CLEANED"]);
export const callOutcome = pgEnum("call_outcome", ["NO_ANSWER", "ANSWERED", "PROMISED_TO_PAY", "ALREADY_PAID", "NEEDS_ASSISTANCE", "NOT_CONTINUING", "FREE_CARD_SPONSORED", "WRONG_NUMBER", "CORRECTION"]);
export const promiseState = pgEnum("promise_state", ["OPEN", "PARTIALLY_FULFILLED", "FULFILLED", "BROKEN", "SUPERSEDED", "CANCELLED"]);
export const taskState = pgEnum("task_state", ["OPEN", "DONE", "CANCELLED"]);
export const taskType = pgEnum("task_type", ["COLLECTION_CALL", "CALLBACK", "ESCALATION", "VERIFY_PAYMENT", "ASSISTANCE", "STALE_REVIEW", "REFUND_CONSIDERATION", "EXEMPTION_APPROVAL", "IDENTITY_RESOLUTION"]);
export const purgeStatus = pgEnum("purge_status", ["NONE", "PENDING", "IN_PROGRESS", "PURGED", "FAILED"]);
export const outboxStatus = pgEnum("outbox_status", ["PENDING", "SENT", "FAILED", "SKIPPED"]);
export const jobStatus = pgEnum("job_status", ["RUNNING", "SUCCEEDED", "FAILED"]);
export const actorType = pgEnum("actor_type", ["STAFF", "STUDENT", "SYSTEM"]);

/* ------------------------------------------------------- governance & staff */

/** Single locked row (id = 1). Every staff lifecycle change affecting the
 *  Super Admin invariant takes SELECT ... FOR UPDATE on this row first. */
export const governanceLock = pgTable("governance_lock", {
  id: integer("id").primaryKey(),
  bootstrappedAt: ts("bootstrapped_at"),
  updatedAt: updatedAt(),
}, (t) => [check("governance_singleton", sql`${t.id} = 1`)]);

export const staffAccounts = pgTable("staff_accounts", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: staffRole("role").notNull(),
  status: staffStatus("status").notNull().default("ACTIVE"),
  passwordHash: text("password_hash"),
  /** Bumped on every role/scope/capability/status change: invalidates cached principals. */
  authVersion: integer("auth_version").notNull().default(1),
  capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
  trashedAt: ts("trashed_at"),
  trashedBy: uuid("trashed_by"),
  trashReason: text("trash_reason"),
  purgeAfter: ts("purge_after"),
  purgeStatus: purgeStatus("purge_status").notNull().default("NONE"),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("staff_email_uq").on(sql`lower(${t.email})`),
  index("staff_role_status_idx").on(t.role, t.status),
  index("staff_purge_idx").on(t.purgeAfter).where(sql`${t.trashedAt} is not null`),
]);

export const programmes = pgTable("programmes", {
  id: id(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  bannerPath: text("banner_path"),
  logoPath: text("logo_path"),
  status: recordStatus("status").notNull().default("ACTIVE"),
  isPublic: boolean("is_public").notNull().default(true),
  trashedAt: ts("trashed_at"),
  trashedBy: uuid("trashed_by"),
  trashReason: text("trash_reason"),
  purgeAfter: ts("purge_after"),
  purgeStatus: purgeStatus("purge_status").notNull().default("NONE"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("programme_code_uq").on(sql`lower(${t.code})`),
  index("programme_purge_idx").on(t.purgeAfter).where(sql`${t.trashedAt} is not null`),
]);

export const intakes = pgTable("intakes", {
  id: id(),
  programmeId: uuid("programme_id").notNull().references(() => programmes.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  label: text("label").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  bannerPath: text("banner_path"),
  status: recordStatus("status").notNull().default("ACTIVE"),
  isPublic: boolean("is_public").notNull().default(true),
  trashedAt: ts("trashed_at"),
  trashedBy: uuid("trashed_by"),
  trashReason: text("trash_reason"),
  purgeAfter: ts("purge_after"),
  purgeStatus: purgeStatus("purge_status").notNull().default("NONE"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("intake_code_uq").on(t.programmeId, sql`lower(${t.code})`),
  uniqueIndex("intake_label_uq").on(t.programmeId, sql`lower(${t.label})`),
  index("intake_programme_idx").on(t.programmeId),
  check("intake_dates_ck", sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
]);

export const staffScopes = pgTable("staff_scopes", {
  id: id(),
  staffId: uuid("staff_id").notNull().references(() => staffAccounts.id, { onDelete: "restrict" }),
  programmeId: uuid("programme_id").notNull().references(() => programmes.id, { onDelete: "restrict" }),
  /** null = all intakes of the programme */
  intakeId: uuid("intake_id").references(() => intakes.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
  createdBy: uuid("created_by"),
}, (t) => [
  uniqueIndex("staff_scope_uq").on(t.staffId, t.programmeId, sql`coalesce(${t.intakeId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  index("staff_scope_staff_idx").on(t.staffId),
]);

export const staffInvitations = pgTable("staff_invitations", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: staffRole("role").notNull(),
  capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
  scopes: jsonb("scopes").$type<{ programmeId: string; intakeId: string | null }[]>().notNull().default([]),
  tokenHash: text("token_hash").notNull(),
  invitedBy: uuid("invited_by").notNull().references(() => staffAccounts.id, { onDelete: "restrict" }),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  acceptedStaffId: uuid("accepted_staff_id"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("invitation_token_uq").on(t.tokenHash)]);

export const staffSessions = pgTable("staff_sessions", {
  id: id(),
  staffId: uuid("staff_id").notNull().references(() => staffAccounts.id, { onDelete: "restrict" }),
  tokenHash: text("token_hash").notNull(),
  authVersion: integer("auth_version").notNull(),
  csrfSecret: text("csrf_secret").notNull(),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  idleExpiresAt: ts("idle_expires_at").notNull(),
  absoluteExpiresAt: ts("absolute_expires_at").notNull(),
  revokedAt: ts("revoked_at"),
}, (t) => [uniqueIndex("staff_session_token_uq").on(t.tokenHash), index("staff_session_staff_idx").on(t.staffId)]);

/* ------------------------------------------------------------- students */

export const students = pgTable("students", {
  id: id(),
  ref: text("ref").notNull(),
  /** AES-256-GCM ciphertext of normalized NIC (src/lib/crypto.ts). */
  nicEnc: text("nic_enc"),
  /** HMAC-SHA256(lookup key, normalized NIC). Exact match + uniqueness. */
  nicLookup: text("nic_lookup"),
  nicMasked: text("nic_masked"),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  phoneVerifiedAt: ts("phone_verified_at"),
  phoneVerifiedBy: uuid("phone_verified_by"),
  emailVerifiedAt: ts("email_verified_at"),
  emailVerifiedBy: uuid("email_verified_by"),
  doNotCall: boolean("do_not_call").notNull().default(false),
  wrongNumber: boolean("wrong_number").notNull().default(false),
  status: studentStatus("status").notNull().default("ACTIVE"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("student_ref_uq").on(t.ref),
  uniqueIndex("student_nic_lookup_uq").on(t.nicLookup).where(sql`${t.nicLookup} is not null`),
  index("student_name_idx").on(sql`lower(${t.fullName})`),
]);

/** Legacy/import rows lacking a valid identifier land here instead of getting fabricated IDs. */
export const identityResolutions = pgTable("identity_resolutions", {
  id: id(),
  source: text("source").notNull(),
  reason: text("reason").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  programmeId: uuid("programme_id").references(() => programmes.id, { onDelete: "restrict" }),
  resolvedAt: ts("resolved_at"),
  resolvedBy: uuid("resolved_by"),
  resolution: text("resolution"),
  createdAt: createdAt(),
});

/* -------------------------------------------------------------- fee plans */

export const feePlanVersions = pgTable("fee_plan_versions", {
  id: id(),
  intakeId: uuid("intake_id").notNull().references(() => intakes.id, { onDelete: "restrict" }),
  versionNo: integer("version_no").notNull(),
  currency: text("currency").notNull().default("LKR"),
  notes: text("notes").notNull().default(""),
  isCurrent: boolean("is_current").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("fee_plan_version_uq").on(t.intakeId, t.versionNo),
  uniqueIndex("fee_plan_current_uq").on(t.intakeId).where(sql`${t.isCurrent}`),
]);

export const feePlanItems = pgTable("fee_plan_items", {
  id: id(),
  versionId: uuid("version_id").notNull().references(() => feePlanVersions.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  component: text("component").notNull().default("TUITION"),
  periodLabel: text("period_label").notNull(),
  amountMinor: money("amount_minor").notNull(),
  dueDate: date("due_date").notNull(),
}, (t) => [
  uniqueIndex("fee_plan_item_seq_uq").on(t.versionId, t.sequence),
  check("fee_item_amount_ck", sql`${t.amountMinor} >= 0`),
]);

/* ----------------------------------------------------- admissions/enrolment */

export const enrolments = pgTable("enrolments", {
  id: id(),
  studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "restrict" }),
  intakeId: uuid("intake_id").notNull().references(() => intakes.id, { onDelete: "restrict" }),
  feePlanVersionId: uuid("fee_plan_version_id").references(() => feePlanVersions.id, { onDelete: "restrict" }),
  status: enrolmentStatus("status").notNull().default("ACTIVE"),
  currency: text("currency").notNull().default("LKR"),
  termsSnapshot: jsonb("terms_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  activatedAt: ts("activated_at").notNull().defaultNow(),
  withdrawnAt: ts("withdrawn_at"),
  withdrawalEffectiveDate: date("withdrawal_effective_date"),
  withdrawalReason: text("withdrawal_reason"),
  completedAt: ts("completed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("enrolment_student_intake_uq").on(t.studentId, t.intakeId),
  index("enrolment_intake_status_idx").on(t.intakeId, t.status),
  index("enrolment_student_idx").on(t.studentId),
]);

export const admissions = pgTable("admissions", {
  id: id(),
  intakeId: uuid("intake_id").notNull().references(() => intakes.id, { onDelete: "restrict" }),
  applicantName: text("applicant_name").notNull(),
  nicEnc: text("nic_enc"),
  nicLookup: text("nic_lookup"),
  nicMasked: text("nic_masked"),
  phone: text("phone"),
  email: text("email"),
  state: admissionState("state").notNull().default("DRAFT"),
  sponsorshipRequested: text("sponsorship_requested"),
  notes: text("notes").notNull().default(""),
  decisionReason: text("decision_reason"),
  decidedBy: uuid("decided_by"),
  decidedAt: ts("decided_at"),
  studentId: uuid("student_id").references(() => students.id, { onDelete: "restrict" }),
  enrolmentId: uuid("enrolment_id").references(() => enrolments.id, { onDelete: "restrict" }),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("admission_enrolment_uq").on(t.enrolmentId).where(sql`${t.enrolmentId} is not null`),
  index("admission_state_idx").on(t.intakeId, t.state),
]);

export const admissionEvents = pgTable("admission_events", {
  id: id(),
  admissionId: uuid("admission_id").notNull().references(() => admissions.id, { onDelete: "restrict" }),
  fromState: admissionState("from_state"),
  toState: admissionState("to_state").notNull(),
  reason: text("reason"),
  actorId: uuid("actor_id"),
  createdAt: createdAt(),
});

export const instalments = pgTable("instalments", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  feePlanItemId: uuid("fee_plan_item_id").references(() => feePlanItems.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  component: text("component").notNull().default("TUITION"),
  periodLabel: text("period_label").notNull(),
  originalChargeMinor: money("original_charge_minor").notNull(),
  currency: text("currency").notNull().default("LKR"),
  dueDate: date("due_date").notNull(),
  createdAt: createdAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("instalment_seq_uq").on(t.enrolmentId, t.sequence),
  unique("instalment_id_enrolment_uq").on(t.id, t.enrolmentId),
  index("instalment_due_idx").on(t.dueDate),
  check("instalment_charge_ck", sql`${t.originalChargeMinor} >= 0`),
]);

export const chargeAdjustments = pgTable("charge_adjustments", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull(),
  instalmentId: uuid("instalment_id").notNull(),
  amountMinor: money("amount_minor").notNull(),
  kind: adjustmentKind("kind").notNull(),
  reason: text("reason").notNull(),
  effectiveDate: date("effective_date").notNull(),
  actorId: uuid("actor_id"),
  reversesId: uuid("reverses_id"),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ columns: [t.instalmentId, t.enrolmentId], foreignColumns: [instalments.id, instalments.enrolmentId], name: "adj_instalment_same_enrolment_fk" }).onDelete("restrict"),
  uniqueIndex("adj_reverses_uq").on(t.reversesId).where(sql`${t.reversesId} is not null`),
  index("adj_instalment_idx").on(t.instalmentId),
]);

export const exemptionAwards = pgTable("exemption_awards", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  type: exemptionType("type").notNull(),
  basis: exemptionBasis("basis").notNull(),
  /** FIXED: minor units per instalment; PERCENT: basis points (10000 = 100%). */
  value: bigint("value", { mode: "number" }).notNull(),
  capMinor: money("cap_minor"),
  reason: text("reason").notNull(),
  sponsorName: text("sponsor_name"),
  approverId: uuid("approver_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  status: awardStatus("status").notNull().default("ACTIVE"),
  revokedAt: ts("revoked_at"),
  revokedBy: uuid("revoked_by"),
  revokeReason: text("revoke_reason"),
  createdAt: createdAt(),
}, (t) => [
  check("award_value_ck", sql`${t.value} > 0 and (${t.basis} <> 'PERCENT' or ${t.value} <= 10000)`),
  index("award_enrolment_idx").on(t.enrolmentId),
]);

export const exemptionApplications = pgTable("exemption_applications", {
  id: id(),
  awardId: uuid("award_id").notNull().references(() => exemptionAwards.id, { onDelete: "restrict" }),
  enrolmentId: uuid("enrolment_id").notNull(),
  instalmentId: uuid("instalment_id").notNull(),
  amountMinor: money("amount_minor").notNull(),
  reversedAt: ts("reversed_at"),
  reversedBy: uuid("reversed_by"),
  reversalReason: text("reversal_reason"),
  createdAt: createdAt(),
}, (t) => [
  foreignKey({ columns: [t.instalmentId, t.enrolmentId], foreignColumns: [instalments.id, instalments.enrolmentId], name: "exapp_instalment_same_enrolment_fk" }).onDelete("restrict"),
  check("exapp_amount_ck", sql`${t.amountMinor} > 0`),
  index("exapp_instalment_idx").on(t.instalmentId),
]);

/* ------------------------------------------------------- receipts/uploads */

export const uploadIntents = pgTable("upload_intents", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull(),
  maxBytes: integer("max_bytes").notNull(),
  declaredMime: text("declared_mime").notNull(),
  status: uploadIntentStatus("status").notNull().default("PENDING"),
  expiresAt: ts("expires_at").notNull(),
  uploadedAt: ts("uploaded_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("upload_intent_key_uq").on(t.objectKey), index("upload_intent_status_idx").on(t.status, t.expiresAt)]);

export const receiptAssets = pgTable("receipt_assets", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  uploadIntentId: uuid("upload_intent_id").references(() => uploadIntents.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull(),
  previewKey: text("preview_key"),
  sha256: text("sha256").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  pages: integer("pages"),
  validation: assetValidation("validation").notNull().default("QUARANTINED"),
  scan: scanStatus("scan").notNull().default("NOT_CONFIGURED"),
  isHistoricalPlaceholder: boolean("is_historical_placeholder").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("asset_key_uq").on(t.objectKey),
  uniqueIndex("asset_intent_uq").on(t.uploadIntentId).where(sql`${t.uploadIntentId} is not null`),
  index("asset_sha_idx").on(t.sha256),
]);

export const paymentSubmissions = pgTable("payment_submissions", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull(),
  targetInstalmentId: uuid("target_instalment_id").notNull(),
  assetId: uuid("asset_id").references(() => receiptAssets.id, { onDelete: "restrict" }),
  claimedMinor: money("claimed_minor").notNull(),
  currency: text("currency").notNull().default("LKR"),
  transferDate: date("transfer_date").notNull(),
  bankReference: text("bank_reference"),
  studentNote: text("student_note"),
  status: submissionStatus("status").notNull().default("PENDING_REVIEW"),
  supersedesSubmissionId: uuid("supersedes_submission_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  flags: jsonb("flags").$type<string[]>().notNull().default([]),
  submittedAt: ts("submitted_at").notNull().defaultNow(),
  decidedAt: ts("decided_at"),
  decidedBy: uuid("decided_by"),
  leaseHolder: uuid("lease_holder"),
  leaseExpiresAt: ts("lease_expires_at"),
  isHistoricalImport: boolean("is_historical_import").notNull().default(false),
  version: integer("version").notNull().default(1),
}, (t) => [
  foreignKey({ columns: [t.targetInstalmentId, t.enrolmentId], foreignColumns: [instalments.id, instalments.enrolmentId], name: "sub_instalment_same_enrolment_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.enrolmentId], foreignColumns: [enrolments.id], name: "sub_enrolment_fk" }).onDelete("restrict"),
  uniqueIndex("sub_idem_uq").on(t.enrolmentId, t.idempotencyKey),
  /** Only one replacement per rejected submission. */
  uniqueIndex("sub_supersedes_uq").on(t.supersedesSubmissionId).where(sql`${t.supersedesSubmissionId} is not null`),
  index("sub_queue_idx").on(t.status, t.submittedAt),
  index("sub_enrolment_idx").on(t.enrolmentId),
  check("sub_claim_ck", sql`${t.claimedMinor} > 0`),
]);

export const reviewActions = pgTable("review_actions", {
  id: id(),
  submissionId: uuid("submission_id").notNull().references(() => paymentSubmissions.id, { onDelete: "restrict" }),
  kind: reviewActionKind("kind").notNull(),
  actorId: uuid("actor_id").notNull(),
  reason: text("reason"),
  submissionVersion: integer("submission_version").notNull(),
  priorActionId: uuid("prior_action_id"),
  confirmedMinor: money("confirmed_minor"),
  createdAt: createdAt(),
}, (t) => [
  /** A given submission version can only be decided once. */
  uniqueIndex("review_action_version_uq").on(t.submissionId, t.submissionVersion),
  index("review_action_actor_idx").on(t.actorId, t.createdAt),
]);

export const paymentEvents = pgTable("payment_events", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  submissionId: uuid("submission_id").references(() => paymentSubmissions.id, { onDelete: "restrict" }),
  kind: paymentEventKind("kind").notNull(),
  /** RECEIPT/HISTORICAL_IMPORT: positive confirmed amount. REVERSAL: positive amount reversed. */
  amountMinor: money("amount_minor").notNull(),
  claimedMinor: money("claimed_minor"),
  amountChangeReason: text("amount_change_reason"),
  currency: text("currency").notNull().default("LKR"),
  reversesEventId: uuid("reverses_event_id"),
  reviewActionId: uuid("review_action_id").references(() => reviewActions.id, { onDelete: "restrict" }),
  sourceReference: text("source_reference"),
  effectiveDate: date("effective_date").notNull(),
  actorId: uuid("actor_id"),
  createdAt: createdAt(),
}, (t) => [
  unique("pe_id_enrolment_uq").on(t.id, t.enrolmentId),
  uniqueIndex("pe_reverses_uq").on(t.reversesEventId).where(sql`${t.reversesEventId} is not null`),
  index("pe_enrolment_idx").on(t.enrolmentId),
  index("pe_created_idx").on(t.createdAt),
  check("pe_amount_ck", sql`${t.amountMinor} > 0`),
]);

export const paymentAllocations = pgTable("payment_allocations", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull(),
  instalmentId: uuid("instalment_id").notNull(),
  paymentEventId: uuid("payment_event_id").notNull(),
  amountMinor: money("amount_minor").notNull(),
  currency: text("currency").notNull().default("LKR"),
  source: allocationSource("source").notNull(),
  actorId: uuid("actor_id"),
  reason: text("reason"),
  createdAt: createdAt(),
  reversedAt: ts("reversed_at"),
  reversedBy: uuid("reversed_by"),
  reversalReason: text("reversal_reason"),
  /** Set when an exemption/fee reduction replaced this allocation with a smaller one. */
  replacedByAllocationId: uuid("replaced_by_allocation_id"),
}, (t) => [
  foreignKey({ columns: [t.instalmentId, t.enrolmentId], foreignColumns: [instalments.id, instalments.enrolmentId], name: "alloc_instalment_same_enrolment_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.paymentEventId, t.enrolmentId], foreignColumns: [paymentEvents.id, paymentEvents.enrolmentId], name: "alloc_event_same_enrolment_fk" }).onDelete("restrict"),
  check("alloc_amount_ck", sql`${t.amountMinor} > 0`),
  index("alloc_instalment_idx").on(t.instalmentId).where(sql`${t.reversedAt} is null`),
  index("alloc_event_idx").on(t.paymentEventId),
  index("alloc_enrolment_idx").on(t.enrolmentId),
]);

/* ------------------------------------------------------------ follow-ups */

export const followUpTasks = pgTable("follow_up_tasks", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  type: taskType("type").notNull(),
  state: taskState("state").notNull().default("OPEN"),
  ownerId: uuid("owner_id"),
  category: text("category"),
  priority: integer("priority").notNull().default(2),
  reason: text("reason"),
  dueAt: ts("due_at").notNull(),
  /** Business deduplication key, e.g. COLLECTION_CALL:<enrolment>:<yyyy-mm-dd>. */
  dedupeKey: text("dedupe_key").notNull(),
  leaseHolder: uuid("lease_holder"),
  leaseExpiresAt: ts("lease_expires_at"),
  closedAt: ts("closed_at"),
  closedBy: uuid("closed_by"),
  closeReason: text("close_reason"),
  paused: boolean("paused").notNull().default(false),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("task_dedupe_uq").on(t.dedupeKey),
  index("task_open_idx").on(t.state, t.dueAt),
  index("task_enrolment_idx").on(t.enrolmentId),
]);

export const paymentPromises = pgTable("payment_promises", {
  id: id(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  amountMinor: money("amount_minor").notNull(),
  promisedDate: date("promised_date").notNull(),
  targetInstalmentIds: uuid("target_instalment_ids").array().notNull(),
  /** Sum of approved allocations to targets at creation; fulfilment = current - baseline. */
  baselineAllocatedMinor: money("baseline_allocated_minor").notNull(),
  fulfilledMinor: money("fulfilled_minor").notNull().default(0),
  state: promiseState("state").notNull().default("OPEN"),
  notes: text("notes"),
  staffId: uuid("staff_id").notNull(),
  callAttemptId: uuid("call_attempt_id"),
  supersededById: uuid("superseded_by_id"),
  stateReason: text("state_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: integer("version").notNull().default(1),
}, (t) => [
  check("promise_amount_ck", sql`${t.amountMinor} > 0`),
  index("promise_date_idx").on(t.state, t.promisedDate),
  index("promise_enrolment_idx").on(t.enrolmentId),
]);

export const callAttempts = pgTable("call_attempts", {
  id: id(),
  /** Client-generated attempt id: replays of the same save are idempotent. */
  clientAttemptId: text("client_attempt_id").notNull(),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  operatorId: uuid("operator_id").notNull(),
  outcome: callOutcome("outcome").notNull(),
  notes: text("notes"),
  balanceSnapshot: jsonb("balance_snapshot").$type<Record<string, number>>().notNull(),
  taskId: uuid("task_id").references(() => followUpTasks.id, { onDelete: "restrict" }),
  promiseId: uuid("promise_id"),
  followUpTaskId: uuid("follow_up_task_id"),
  correctsAttemptId: uuid("corrects_attempt_id"),
  manualOverrideReason: text("manual_override_reason"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("call_attempt_client_uq").on(t.operatorId, t.clientAttemptId),
  index("call_attempt_enrolment_idx").on(t.enrolmentId, t.createdAt),
]);

export const businessHolidays = pgTable("business_holidays", {
  day: date("day").primaryKey(),
  label: text("label").notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

/* ----------------------------------------------------- student sessions */

export const studentSessions = pgTable("student_sessions", {
  id: id(),
  tokenHash: text("token_hash").notNull(),
  studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "restrict" }),
  enrolmentId: uuid("enrolment_id").notNull().references(() => enrolments.id, { onDelete: "restrict" }),
  csrfSecret: text("csrf_secret").notNull(),
  createdAt: createdAt(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  idleExpiresAt: ts("idle_expires_at").notNull(),
  absoluteExpiresAt: ts("absolute_expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  revokeReason: text("revoke_reason"),
}, (t) => [uniqueIndex("student_session_token_uq").on(t.tokenHash), index("student_session_enrolment_idx").on(t.enrolmentId)]);

export const rememberedDevices = pgTable("remembered_devices", {
  id: id(),
  tokenHash: text("token_hash").notNull(),
  studentId: uuid("student_id").notNull().references(() => students.id, { onDelete: "restrict" }),
  lastIntakeId: uuid("last_intake_id").references(() => intakes.id, { onDelete: "restrict" }),
  maskedNic: text("masked_nic").notNull(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
  lastUsedAt: ts("last_used_at"),
}, (t) => [uniqueIndex("device_token_uq").on(t.tokenHash)]);

/* ------------------------------------------------------ platform/infra */

export const auditEvents = pgTable("audit_events", {
  id: id(),
  actorType: actorType("actor_type").notNull(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  /** Programme scope of the entity for scoped audit visibility. */
  programmeId: uuid("programme_id"),
  intakeId: uuid("intake_id"),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown> | null>(),
  reason: text("reason"),
  requestId: text("request_id"),
  createdAt: createdAt(),
}, (t) => [index("audit_entity_idx").on(t.entityType, t.entityId), index("audit_created_idx").on(t.createdAt)]);

export const notifications = pgTable("notifications", {
  id: id(),
  recipientType: actorType("recipient_type").notNull(),
  /** STUDENT: enrolment id; STAFF: staff id */
  recipientId: uuid("recipient_id").notNull(),
  event: text("event").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  readAt: ts("read_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("notification_dedupe_uq").on(t.dedupeKey), index("notification_recipient_idx").on(t.recipientId, t.createdAt)]);

export const outboxEvents = pgTable("outbox_events", {
  id: id(),
  channel: text("channel").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: outboxStatus("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: createdAt(),
  sentAt: ts("sent_at"),
}, (t) => [uniqueIndex("outbox_dedupe_uq").on(t.dedupeKey), index("outbox_pending_idx").on(t.status, t.nextAttemptAt)]);

export const jobRuns = pgTable("job_runs", {
  id: id(),
  job: text("job").notNull(),
  status: jobStatus("status").notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  processed: integer("processed").notNull().default(0),
  error: text("error"),
  details: jsonb("details").$type<Record<string, unknown>>(),
}, (t) => [index("job_runs_job_idx").on(t.job, t.startedAt)]);

export const jobLeases = pgTable("job_leases", {
  job: text("job").primaryKey(),
  holder: text("holder"),
  expiresAt: ts("expires_at"),
});

export const idempotencyRecords = pgTable("idempotency_records", {
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  response: jsonb("response").$type<unknown>(),
  status: integer("status"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.scope, t.key] })]);

export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: ts("window_start").notNull(),
});

export const exportJobs = pgTable("export_jobs", {
  id: id(),
  staffId: uuid("staff_id").notNull().references(() => staffAccounts.id, { onDelete: "restrict" }),
  report: text("report").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  fullIdentifiers: boolean("full_identifiers").notNull().default(false),
  status: jobStatus("status").notNull().default("RUNNING"),
  objectKey: text("object_key"),
  rowCount: integer("row_count"),
  expiresAt: ts("expires_at"),
  error: text("error"),
  createdAt: createdAt(),
});
