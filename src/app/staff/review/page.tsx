import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { intakes, programmes } from "@/db/schema";
import { currentStaff } from "@/server/auth/staff";
import { intakeScopeWhere } from "@/server/auth/policy";
import { PageHeader } from "../_shell/page-header";
import { ReviewWorkspace } from "./review-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Receipt review" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ submission?: string | string[] }> }) {
  const p = await currentStaff();
  if (!p) redirect("/staff/login");
  const { submission } = await searchParams;
  const linkedSubmission = typeof submission === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submission) ? submission : null;
  const scopeIntakes = await db().select({ id: intakes.id, label: intakes.label, programmeId: programmes.id, programmeName: programmes.name })
    .from(intakes).innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(intakeScopeWhere(p, intakes.id, intakes.programmeId), isNull(intakes.trashedAt), isNull(programmes.trashedAt)))
    .orderBy(asc(programmes.name), asc(intakes.label));
  return (
    <>
      <PageHeader title="Receipt review" sub="Oldest pending receipts first. Keyboard: A approve · R reject · S skip · U undo · + / − zoom · O rotate." />
      <ReviewWorkspace key={submission === undefined ? "queue" : linkedSubmission ?? "unavailable"} intakes={scopeIntakes} isSuper={p.role === "SUPER_ADMIN"} linkedSubmission={linkedSubmission} invalidLinkedSubmission={submission !== undefined && !linkedSubmission} />
    </>
  );
}
