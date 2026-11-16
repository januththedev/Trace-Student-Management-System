ALTER TABLE "receipt_assets" ADD COLUMN "archive_encoding" text;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD COLUMN "archive_original_key" text;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD COLUMN "archive_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD COLUMN "archive_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD COLUMN "archive_original_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipt_assets" ADD CONSTRAINT "asset_archive_metadata_ck" CHECK (
    ("receipt_assets"."archive_encoding" is null and "receipt_assets"."archive_original_key" is null
      and "receipt_assets"."archive_size_bytes" is null and "receipt_assets"."archived_at" is null
      and "receipt_assets"."archive_original_deleted_at" is null)
    or
    ("receipt_assets"."archive_encoding" is not null and "receipt_assets"."archive_encoding" = 'gzip' and "receipt_assets"."archive_original_key" is not null
      and "receipt_assets"."archive_original_key" <> "receipt_assets"."object_key" and "receipt_assets"."archive_size_bytes" is not null
      and "receipt_assets"."archive_size_bytes" >= 0 and "receipt_assets"."archive_size_bytes" < "receipt_assets"."size_bytes"
      and "receipt_assets"."archived_at" is not null)
  );