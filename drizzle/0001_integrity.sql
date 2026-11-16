-- Integrity rules that cannot be expressed in the Drizzle schema DSL.

-- Governance singleton row used to serialize every Super Admin lifecycle change.
INSERT INTO governance_lock (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Append-only ledgers: block UPDATE/DELETE on immutable history.
CREATE OR REPLACE FUNCTION t2t_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION t2t_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER review_actions_append_only BEFORE UPDATE OR DELETE ON review_actions FOR EACH ROW EXECUTE FUNCTION t2t_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER call_attempts_append_only BEFORE UPDATE OR DELETE ON call_attempts FOR EACH ROW EXECUTE FUNCTION t2t_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION t2t_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER charge_adjustments_append_only BEFORE UPDATE OR DELETE ON charge_adjustments FOR EACH ROW EXECUTE FUNCTION t2t_forbid_mutation();
--> statement-breakpoint

-- Allocations: amounts/links are immutable; only the reversal markers may be set once.
CREATE OR REPLACE FUNCTION t2t_allocation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_allocations rows cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.instalment_id <> OLD.instalment_id
     OR NEW.payment_event_id <> OLD.payment_event_id OR NEW.enrolment_id <> OLD.enrolment_id THEN
    RAISE EXCEPTION 'allocation amounts and links are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'allocation already reversed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_guard BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION t2t_allocation_guard();
--> statement-breakpoint

-- Allocation currency must match the instalment and the payment event.
CREATE OR REPLACE FUNCTION t2t_allocation_currency() RETURNS trigger AS $$
DECLARE ic text; ec text;
BEGIN
  SELECT currency INTO ic FROM instalments WHERE id = NEW.instalment_id;
  SELECT currency INTO ec FROM payment_events WHERE id = NEW.payment_event_id;
  IF ic IS DISTINCT FROM NEW.currency OR ec IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'cross-currency allocation rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_currency BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION t2t_allocation_currency();
--> statement-breakpoint

-- One RECEIPT event per approving review action (with review_action_version_uq this blocks double approval).
CREATE UNIQUE INDEX pe_receipt_review_action_uq ON payment_events (review_action_id) WHERE kind = 'RECEIPT';
--> statement-breakpoint

-- Students' audit-facing NIC is never stored raw: only ciphertext/digest/masked columns exist.
COMMENT ON COLUMN students.nic_enc IS 'AES-256-GCM ciphertext (app-level). Never log/export raw.';
