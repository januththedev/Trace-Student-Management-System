import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { intakes, programmes } from "@/db/schema";

/** Intentionally public course metadata only — never student names or counts. */
export interface PublicIntake {
  intakeId: string;
  programmeCode: string;
  programmeName: string;
  intakeLabel: string;
  bannerPath: string | null;
  logoPath: string | null;
}

export async function publicIntakes(): Promise<PublicIntake[]> {
  const rows = await db().select({
    intakeId: intakes.id, programmeCode: programmes.code, programmeName: programmes.name, intakeLabel: intakes.label,
    intakeBanner: intakes.bannerPath, programmeBanner: programmes.bannerPath, logoPath: programmes.logoPath,
  }).from(intakes).innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      eq(intakes.status, "ACTIVE"), eq(programmes.status, "ACTIVE"), eq(intakes.isPublic, true), eq(programmes.isPublic, true),
      isNull(intakes.trashedAt), isNull(programmes.trashedAt),
    ))
    .orderBy(asc(programmes.name), asc(intakes.startDate), asc(intakes.label));
  return rows.map((r) => ({
    intakeId: r.intakeId, programmeCode: r.programmeCode, programmeName: r.programmeName, intakeLabel: r.intakeLabel,
    bannerPath: r.intakeBanner ?? r.programmeBanner ?? null, logoPath: r.logoPath,
  }));
}
