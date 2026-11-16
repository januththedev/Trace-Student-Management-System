-- Custom SQL migration file, put your code below! --
-- Cover live ledger aggregates and scoped enrolment joins without changing the schema.
CREATE INDEX perf_enrolment_active_intake_idx ON enrolments (intake_id, id) INCLUDE (student_id) WHERE status = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX perf_instalment_balance_idx ON instalments (enrolment_id, due_date) INCLUDE (id, original_charge_minor);
--> statement-breakpoint
CREATE INDEX perf_adjustment_enrolment_idx ON charge_adjustments (enrolment_id, instalment_id) INCLUDE (amount_minor);
--> statement-breakpoint
CREATE INDEX perf_exemption_active_enrolment_idx ON exemption_applications (enrolment_id, instalment_id) INCLUDE (amount_minor) WHERE reversed_at IS NULL;
--> statement-breakpoint
CREATE INDEX perf_allocation_active_enrolment_idx ON payment_allocations (enrolment_id, instalment_id) INCLUDE (amount_minor) WHERE reversed_at IS NULL;
--> statement-breakpoint
CREATE INDEX perf_event_enrolment_balance_idx ON payment_events (enrolment_id) INCLUDE (kind, amount_minor);
--> statement-breakpoint
CREATE INDEX perf_pending_enrolment_idx ON payment_submissions (enrolment_id, target_instalment_id) INCLUDE (claimed_minor) WHERE status = 'PENDING_REVIEW';
--> statement-breakpoint
CREATE INDEX perf_call_latest_idx ON call_attempts (enrolment_id, created_at DESC) INCLUDE (outcome);
--> statement-breakpoint
CREATE INDEX perf_export_pending_idx ON export_jobs (created_at, id) WHERE status = 'RUNNING';
--> statement-breakpoint
CREATE INDEX perf_export_expiry_idx ON export_jobs (expires_at) WHERE object_key IS NOT NULL;
