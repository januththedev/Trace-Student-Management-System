CREATE TABLE "support_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"category" text NOT NULL,
	"area" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_feedback_category_ck" CHECK ("support_feedback"."category" in ('BUG','IMPROVEMENT','QUESTION')),
	CONSTRAINT "support_feedback_status_ck" CHECK ("support_feedback"."status" in ('OPEN','IN_REVIEW','PLANNED','RESOLVED','CLOSED')),
	CONSTRAINT "support_feedback_version_ck" CHECK ("support_feedback"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "support_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_feedback" ADD CONSTRAINT "support_feedback_author_id_staff_accounts_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."staff_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_feedback_id_support_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."support_feedback"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_author_id_staff_accounts_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."staff_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_feedback_author_created_idx" ON "support_feedback" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "support_feedback_status_created_idx" ON "support_feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "support_replies_feedback_idx" ON "support_replies" USING btree ("feedback_id","created_at");