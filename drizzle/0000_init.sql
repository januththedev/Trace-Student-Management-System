CREATE TYPE "public"."actor_type" AS ENUM('STAFF', 'STUDENT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."adjustment_kind" AS ENUM('MANUAL', 'WITHDRAWAL_CANCEL', 'FEE_CHANGE', 'REACTIVATION');--> statement-breakpoint
CREATE TYPE "public"."admission_state" AS ENUM('DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."allocation_source" AS ENUM('SUBMISSION', 'CREDIT_APPLY', 'EXEMPTION_REALLOCATION', 'HISTORICAL_IMPORT');--> statement-breakpoint
CREATE TYPE "public"."asset_validation" AS ENUM('QUARANTINED', 'CLEAN', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."award_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('NO_ANSWER', 'ANSWERED', 'PROMISED_TO_PAY', 'ALREADY_PAID', 'NEEDS_ASSISTANCE', 'NOT_CONTINUING', 'FREE_CARD_SPONSORED', 'WRONG_NUMBER', 'CORRECTION');--> statement-breakpoint
CREATE TYPE "public"."enrolment_status" AS ENUM('ACTIVE', 'COMPLETED', 'WITHDRAWN', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."exemption_basis" AS ENUM('FIXED', 'PERCENT');--> statement-breakpoint
CREATE TYPE "public"."exemption_type" AS ENUM('FREE_CARD', 'SPONSORSHIP', 'DISCOUNT', 'ARREARS_WAIVER');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."payment_event_kind" AS ENUM('RECEIPT', 'REVERSAL', 'HISTORICAL_IMPORT');--> statement-breakpoint
CREATE TYPE "public"."promise_state" AS ENUM('OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'BROKEN', 'SUPERSEDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."purge_status" AS ENUM('NONE', 'PENDING', 'IN_PROGRESS', 'PURGED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."review_action_kind" AS ENUM('APPROVE', 'REJECT', 'UNDO', 'CORRECTION');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('NOT_CONFIGURED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('SUPER_ADMIN', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('ACTIVE', 'DEACTIVATED');--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('OPEN', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('COLLECTION_CALL', 'CALLBACK', 'ESCALATION', 'VERIFY_PAYMENT', 'ASSISTANCE', 'STALE_REVIEW', 'REFUND_CONSIDERATION', 'EXEMPTION_APPROVAL', 'IDENTITY_RESOLUTION');--> statement-breakpoint
CREATE TYPE "public"."upload_intent_status" AS ENUM('PENDING', 'FINALIZED', 'EXPIRED', 'CLEANED');--> statement-breakpoint
CREATE TABLE "admission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admission_id" uuid NOT NULL,
	"from_state" "admission_state",
	"to_state" "admission_state" NOT NULL,
	"reason" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_id" uuid NOT NULL,
	"applicant_name" text NOT NULL,
	"nic_enc" text,
	"nic_lookup" text,
	"nic_masked" text,
	"phone" text,
	"email" text,
	"state" "admission_state" DEFAULT 'DRAFT' NOT NULL,
	"sponsorship_requested" text,
	"notes" text DEFAULT '' NOT NULL,
	"decision_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"student_id" uuid,
	"enrolment_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"programme_id" uuid,
	"intake_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_holidays" (
	"day" date PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_attempt_id" text NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"outcome" "call_outcome" NOT NULL,
	"notes" text,
	"balance_snapshot" jsonb NOT NULL,
	"task_id" uuid,
	"promise_id" uuid,
	"follow_up_task_id" uuid,
	"corrects_attempt_id" uuid,
	"manual_override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charge_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"kind" "adjustment_kind" NOT NULL,
	"reason" text NOT NULL,
	"effective_date" date NOT NULL,
	"actor_id" uuid,
	"reverses_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"fee_plan_version_id" uuid,
	"status" "enrolment_status" DEFAULT 'ACTIVE' NOT NULL,
	"currency" text DEFAULT 'LKR' NOT NULL,
	"terms_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawal_effective_date" date,
	"withdrawal_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exemption_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"award_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exapp_amount_ck" CHECK ("exemption_applications"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "exemption_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"type" "exemption_type" NOT NULL,
	"basis" "exemption_basis" NOT NULL,
	"value" bigint NOT NULL,
	"cap_minor" bigint,
	"reason" text NOT NULL,
	"sponsor_name" text,
	"approver_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" "award_status" DEFAULT 'ACTIVE' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "award_value_ck" CHECK ("exemption_awards"."value" > 0 and ("exemption_awards"."basis" <> 'PERCENT' or "exemption_awards"."value" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"report" text NOT NULL,
	"filters" jsonb NOT NULL,
	"full_identifiers" boolean DEFAULT false NOT NULL,
	"status" "job_status" DEFAULT 'RUNNING' NOT NULL,
	"object_key" text,
	"row_count" integer,
	"expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"component" text DEFAULT 'TUITION' NOT NULL,
	"period_label" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"due_date" date NOT NULL,
	CONSTRAINT "fee_item_amount_ck" CHECK ("fee_plan_items"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fee_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"currency" text DEFAULT 'LKR' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"type" "task_type" NOT NULL,
	"state" "task_state" DEFAULT 'OPEN' NOT NULL,
	"owner_id" uuid,
	"category" text,
	"priority" integer DEFAULT 2 NOT NULL,
	"reason" text,
	"due_at" timestamp with time zone NOT NULL,
	"dedupe_key" text NOT NULL,
	"lease_holder" uuid,
	"lease_expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_reason" text,
	"paused" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_lock" (
	"id" integer PRIMARY KEY NOT NULL,
	"bootstrapped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_singleton" CHECK ("governance_lock"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "identity_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"programme_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"fee_plan_item_id" uuid,
	"sequence" integer NOT NULL,
	"component" text DEFAULT 'TUITION' NOT NULL,
	"period_label" text NOT NULL,
	"original_charge_minor" bigint NOT NULL,
	"currency" text DEFAULT 'LKR' NOT NULL,
	"due_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "instalment_id_enrolment_uq" UNIQUE("id","enrolment_id"),
	CONSTRAINT "instalment_charge_ck" CHECK ("instalments"."original_charge_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"programme_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"banner_path" text,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"trashed_at" timestamp with time zone,
	"trashed_by" uuid,
	"trash_reason" text,
	"purge_after" timestamp with time zone,
	"purge_status" "purge_status" DEFAULT 'NONE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "intake_dates_ck" CHECK ("intakes"."end_date" is null or "intakes"."end_date" >= "intakes"."start_date")
);
--> statement-breakpoint
CREATE TABLE "job_leases" (
	"job" text PRIMARY KEY NOT NULL,
	"holder" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"status" "job_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"processed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_type" "actor_type" NOT NULL,
	"recipient_id" uuid NOT NULL,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"payment_event_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'LKR' NOT NULL,
	"source" "allocation_source" NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	"replaced_by_allocation_id" uuid,
	CONSTRAINT "alloc_amount_ck" CHECK ("payment_allocations"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"submission_id" uuid,
	"kind" "payment_event_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"claimed_minor" bigint,
	"amount_change_reason" text,
	"currency" text DEFAULT 'LKR' NOT NULL,
	"reverses_event_id" uuid,
	"review_action_id" uuid,
	"source_reference" text,
	"effective_date" date NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pe_id_enrolment_uq" UNIQUE("id","enrolment_id"),
	CONSTRAINT "pe_amount_ck" CHECK ("payment_events"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"promised_date" date NOT NULL,
	"target_instalment_ids" uuid[] NOT NULL,
	"baseline_allocated_minor" bigint NOT NULL,
	"fulfilled_minor" bigint DEFAULT 0 NOT NULL,
	"state" "promise_state" DEFAULT 'OPEN' NOT NULL,
	"notes" text,
	"staff_id" uuid NOT NULL,
	"call_attempt_id" uuid,
	"superseded_by_id" uuid,
	"state_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "promise_amount_ck" CHECK ("payment_promises"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"target_instalment_id" uuid NOT NULL,
	"asset_id" uuid,
	"claimed_minor" bigint NOT NULL,
	"currency" text DEFAULT 'LKR' NOT NULL,
	"transfer_date" date NOT NULL,
	"bank_reference" text,
	"student_note" text,
	"status" "submission_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"supersedes_submission_id" uuid,
	"idempotency_key" text NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"lease_holder" uuid,
	"lease_expires_at" timestamp with time zone,
	"is_historical_import" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sub_claim_ck" CHECK ("payment_submissions"."claimed_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "programmes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"banner_path" text,
	"logo_path" text,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"trashed_at" timestamp with time zone,
	"trashed_by" uuid,
	"trash_reason" text,
	"purge_after" timestamp with time zone,
	"purge_status" "purge_status" DEFAULT 'NONE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"upload_intent_id" uuid,
	"object_key" text NOT NULL,
	"preview_key" text,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"pages" integer,
	"validation" "asset_validation" DEFAULT 'QUARANTINED' NOT NULL,
	"scan" "scan_status" DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"is_historical_placeholder" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remembered_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"student_id" uuid NOT NULL,
	"last_intake_id" uuid,
	"masked_nic" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" "review_action_kind" NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text,
	"submission_version" integer NOT NULL,
	"prior_action_id" uuid,
	"confirmed_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_status" DEFAULT 'ACTIVE' NOT NULL,
	"password_hash" text,
	"auth_version" integer DEFAULT 1 NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"trashed_at" timestamp with time zone,
	"trashed_by" uuid,
	"trash_reason" text,
	"purge_after" timestamp with time zone,
	"purge_status" "purge_status" DEFAULT 'NONE' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_staff_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"intake_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"auth_version" integer NOT NULL,
	"csrf_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "student_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"student_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"csrf_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"nic_enc" text,
	"nic_lookup" text,
	"nic_masked" text,
	"full_name" text NOT NULL,
	"phone" text,
	"email" text,
	"phone_verified_at" timestamp with time zone,
	"phone_verified_by" uuid,
	"email_verified_at" timestamp with time zone,
	"email_verified_by" uuid,
	"do_not_call" boolean DEFAULT false NOT NULL,
	"wrong_number" boolean DEFAULT false NOT NULL,
	"status" "student_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"max_bytes" integer NOT NULL,
	"declared_mime" text NOT NULL,
	"status" "upload_intent_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admission_events" ADD CONSTRAINT "admission_events_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_intake_id_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_task_id_follow_up_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."follow_up_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_adjustments" ADD CONSTRAINT "adj_instalment_same_enrolment_fk" FOREIGN KEY ("instalment_id","enrolment_id") REFERENCES "public"."instalments"("id","enrolment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_intake_id_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_fee_plan_version_id_fee_plan_versions_id_fk" FOREIGN KEY ("fee_plan_version_id") REFERENCES "public"."fee_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemption_applications" ADD CONSTRAINT "exemption_applications_award_id_exemption_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."exemption_awards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemption_applications" ADD CONSTRAINT "exapp_instalment_same_enrolment_fk" FOREIGN KEY ("instalment_id","enrolment_id") REFERENCES "public"."instalments"("id","enrolment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemption_awards" ADD CONSTRAINT "exemption_awards_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_staff_id_staff_accounts_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan_items" ADD CONSTRAINT "fee_plan_items_version_id_fee_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."fee_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan_versions" ADD CONSTRAINT "fee_plan_versions_intake_id_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_resolutions" ADD CONSTRAINT "identity_resolutions_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."programmes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_fee_plan_item_id_fee_plan_items_id_fk" FOREIGN KEY ("fee_plan_item_id") REFERENCES "public"."fee_plan_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intakes" ADD CONSTRAINT "intakes_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."programmes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "alloc_instalment_same_enrolment_fk" FOREIGN KEY ("instalment_id","enrolment_id") REFERENCES "public"."instalments"("id","enrolment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "alloc_event_same_enrolment_fk" FOREIGN KEY ("payment_event_id","enrolment_id") REFERENCES "public"."payment_events"("id","enrolment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_submission_id_payment_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."payment_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_review_action_id_review_actions_id_fk" FOREIGN KEY ("review_action_id") REFERENCES "public"."review_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_asset_id_receipt_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."receipt_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "sub_instalment_same_enrolment_fk" FOREIGN KEY ("target_instalment_id","enrolment_id") REFERENCES "public"."instalments"("id","enrolment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "sub_enrolment_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD CONSTRAINT "receipt_assets_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD CONSTRAINT "receipt_assets_upload_intent_id_upload_intents_id_fk" FOREIGN KEY ("upload_intent_id") REFERENCES "public"."upload_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_last_intake_id_intakes_id_fk" FOREIGN KEY ("last_intake_id") REFERENCES "public"."intakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_actions" ADD CONSTRAINT "review_actions_submission_id_payment_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."payment_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_invited_by_staff_accounts_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."staff_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_scopes" ADD CONSTRAINT "staff_scopes_staff_id_staff_accounts_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_scopes" ADD CONSTRAINT "staff_scopes_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."programmes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_scopes" ADD CONSTRAINT "staff_scopes_intake_id_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."intakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_staff_accounts_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_sessions" ADD CONSTRAINT "student_sessions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_sessions" ADD CONSTRAINT "student_sessions_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admission_enrolment_uq" ON "admissions" USING btree ("enrolment_id") WHERE "admissions"."enrolment_id" is not null;--> statement-breakpoint
CREATE INDEX "admission_state_idx" ON "admissions" USING btree ("intake_id","state");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "call_attempt_client_uq" ON "call_attempts" USING btree ("operator_id","client_attempt_id");--> statement-breakpoint
CREATE INDEX "call_attempt_enrolment_idx" ON "call_attempts" USING btree ("enrolment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "adj_reverses_uq" ON "charge_adjustments" USING btree ("reverses_id") WHERE "charge_adjustments"."reverses_id" is not null;--> statement-breakpoint
CREATE INDEX "adj_instalment_idx" ON "charge_adjustments" USING btree ("instalment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrolment_student_intake_uq" ON "enrolments" USING btree ("student_id","intake_id");--> statement-breakpoint
CREATE INDEX "enrolment_intake_status_idx" ON "enrolments" USING btree ("intake_id","status");--> statement-breakpoint
CREATE INDEX "enrolment_student_idx" ON "enrolments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "exapp_instalment_idx" ON "exemption_applications" USING btree ("instalment_id");--> statement-breakpoint
CREATE INDEX "award_enrolment_idx" ON "exemption_awards" USING btree ("enrolment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plan_item_seq_uq" ON "fee_plan_items" USING btree ("version_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plan_version_uq" ON "fee_plan_versions" USING btree ("intake_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plan_current_uq" ON "fee_plan_versions" USING btree ("intake_id") WHERE "fee_plan_versions"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "task_dedupe_uq" ON "follow_up_tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "task_open_idx" ON "follow_up_tasks" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "task_enrolment_idx" ON "follow_up_tasks" USING btree ("enrolment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instalment_seq_uq" ON "instalments" USING btree ("enrolment_id","sequence");--> statement-breakpoint
CREATE INDEX "instalment_due_idx" ON "instalments" USING btree ("due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_code_uq" ON "intakes" USING btree ("programme_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "intake_label_uq" ON "intakes" USING btree ("programme_id",lower("label"));--> statement-breakpoint
CREATE INDEX "intake_programme_idx" ON "intakes" USING btree ("programme_id");--> statement-breakpoint
CREATE INDEX "job_runs_job_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_uq" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_recipient_idx" ON "notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_uq" ON "outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "alloc_instalment_idx" ON "payment_allocations" USING btree ("instalment_id") WHERE "payment_allocations"."reversed_at" is null;--> statement-breakpoint
CREATE INDEX "alloc_event_idx" ON "payment_allocations" USING btree ("payment_event_id");--> statement-breakpoint
CREATE INDEX "alloc_enrolment_idx" ON "payment_allocations" USING btree ("enrolment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pe_reverses_uq" ON "payment_events" USING btree ("reverses_event_id") WHERE "payment_events"."reverses_event_id" is not null;--> statement-breakpoint
CREATE INDEX "pe_enrolment_idx" ON "payment_events" USING btree ("enrolment_id");--> statement-breakpoint
CREATE INDEX "pe_created_idx" ON "payment_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "promise_date_idx" ON "payment_promises" USING btree ("state","promised_date");--> statement-breakpoint
CREATE INDEX "promise_enrolment_idx" ON "payment_promises" USING btree ("enrolment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_idem_uq" ON "payment_submissions" USING btree ("enrolment_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_supersedes_uq" ON "payment_submissions" USING btree ("supersedes_submission_id") WHERE "payment_submissions"."supersedes_submission_id" is not null;--> statement-breakpoint
CREATE INDEX "sub_queue_idx" ON "payment_submissions" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "sub_enrolment_idx" ON "payment_submissions" USING btree ("enrolment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "programme_code_uq" ON "programmes" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "programme_purge_idx" ON "programmes" USING btree ("purge_after") WHERE "programmes"."trashed_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_key_uq" ON "receipt_assets" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_intent_uq" ON "receipt_assets" USING btree ("upload_intent_id") WHERE "receipt_assets"."upload_intent_id" is not null;--> statement-breakpoint
CREATE INDEX "asset_sha_idx" ON "receipt_assets" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "device_token_uq" ON "remembered_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "review_action_version_uq" ON "review_actions" USING btree ("submission_id","submission_version");--> statement-breakpoint
CREATE INDEX "review_action_actor_idx" ON "review_actions" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_email_uq" ON "staff_accounts" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "staff_role_status_idx" ON "staff_accounts" USING btree ("role","status");--> statement-breakpoint
CREATE INDEX "staff_purge_idx" ON "staff_accounts" USING btree ("purge_after") WHERE "staff_accounts"."trashed_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_uq" ON "staff_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_scope_uq" ON "staff_scopes" USING btree ("staff_id","programme_id",coalesce("intake_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "staff_scope_staff_idx" ON "staff_scopes" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_session_token_uq" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_session_staff_idx" ON "staff_sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_session_token_uq" ON "student_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "student_session_enrolment_idx" ON "student_sessions" USING btree ("enrolment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_ref_uq" ON "students" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "student_nic_lookup_uq" ON "students" USING btree ("nic_lookup") WHERE "students"."nic_lookup" is not null;--> statement-breakpoint
CREATE INDEX "student_name_idx" ON "students" USING btree (lower("full_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intent_key_uq" ON "upload_intents" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "upload_intent_status_idx" ON "upload_intents" USING btree ("status","expires_at");