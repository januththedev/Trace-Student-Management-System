import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { staffAccounts } from "./schema";

export const supportFeedback = pgTable("support_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorId: uuid("author_id").notNull().references(() => staffAccounts.id, { onDelete: "restrict" }),
  category: text("category").notNull(),
  area: text("area").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("OPEN"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date", precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date", precision: 3 }).notNull().defaultNow(),
}, t => [
  index("support_feedback_author_created_idx").on(t.authorId, t.createdAt),
  index("support_feedback_status_created_idx").on(t.status, t.createdAt),
  check("support_feedback_category_ck", sql`${t.category} in ('BUG','IMPROVEMENT','QUESTION')`),
  check("support_feedback_status_ck", sql`${t.status} in ('OPEN','IN_REVIEW','PLANNED','RESOLVED','CLOSED')`),
  check("support_feedback_version_ck", sql`${t.version} > 0`),
]);

export const supportReplies = pgTable("support_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedbackId: uuid("feedback_id").notNull().references(() => supportFeedback.id, { onDelete: "restrict" }),
  authorId: uuid("author_id").notNull().references(() => staffAccounts.id, { onDelete: "restrict" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date", precision: 3 }).notNull().defaultNow(),
}, t => [index("support_replies_feedback_idx").on(t.feedbackId, t.createdAt)]);
