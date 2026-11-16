import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { enrolments, intakes, programmes, students } from "@/db/schema";
import { decryptNic } from "@/lib/crypto";
import { toCsv } from "@/lib/csv";
import { businessDate, formatInstant, isBizDate, now, type BizDate } from "@/lib/time";
import { can, isSuper, requireCap, requireSuper, intakeScopeWhere, type StaffPrincipal } from "@/server/auth/policy";
import { audit } from "@/server/audit";
import { fail } from "@/server/http";
import { freshPrincipal } from "@/server/auth/fresh";
import { COMMAND_METRIC_DEFINITIONS, getCommandCentreMetrics } from "./metrics";
import {
  allocationsByInstalment, collectionRateReport, enrolmentCredits, exemptionsReport,
  followUpOutcomes, outstandingAgeing, programmeIntakeTotals, receiptsByApprovalDate,
  receiptsByTransferDate, reviewThroughput, type ReportFilters,
} from "./reports";

/* ------------------------------------------------------------------ types */

export const EXPORT_REPORTS = [
  "dashboard", "students", "outstanding", "ageing", "credits", "receipts",
  "transfer-receipts", "allocations", "exemptions", "programme-totals",
  "review-throughput", "follow-up-outcomes", "collection-rate",
] as const;

export type ExportReport = (typeof EXPORT_REPORTS)[number];

export const ExportRequestSchema = z.object({
  report: z.enum(EXPORT_REPORTS),
  from: z.string().refine(isBizDate, "Use a valid business date.").optional(),
  to: z.string().refine(isBizDate, "Use a valid business date.").optional(),
  asOf: z.string().refine(isBizDate, "Use a valid business date.").optional(),
  programmeId: z.string().uuid().optional(),
  intakeId: z.string().uuid().optional(),
  groupBy: z.enum(["PROGRAMME", "INTAKE"]).optional(),
  /** Ignored (and rejected) unless the principal is a Super Admin. */
  fullIdentifiers: z.boolean().optional(),
});

export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export interface ExportResult {
  report: ExportReport;
  filename: string;
  csv: string;
  rowCount: number;
  fullIdentifiers: boolean;
  generatedAt: string;
  businessDate: BizDate;
}

interface Column {
  key: string;
  header: string;
  definition: string;
}

interface Table {
  columns: Column[];
  rows: Record<string, unknown>[];
}

/* ---------------------------------------------------------------- helpers */

const MONEY = "LKR minor units (1 LKR = 100)";
const money = (key: string, header: string): Column => ({ key, header, definition: MONEY });

function sanitiseFilename(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "export";
}

export function resolveExportDates(req: ExportRequest): { from: BizDate; to: BizDate; asOf: BizDate } {
  const asOf = req.asOf ?? businessDate();
  const from = req.from ?? asOf;
  const to = req.to ?? from;
  for (const [name, d] of [["from", from], ["to", to], ["asOf", asOf]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      throw fail.validation(`Export ${name} must be a YYYY-MM-DD business date.`);
    }
  }
  if (from > to) throw fail.validation("Export start date must be on or before the end date.");
  return { from, to, asOf };
}

function filtersOf(req: ExportRequest, dates: { from: BizDate; to: BizDate }): ReportFilters {
  return { from: dates.from, to: dates.to, programmeId: req.programmeId, intakeId: req.intakeId };
}

/**
 * Masked NICs come from `students.nic_masked`. Full decrypted identifiers are only
 * produced for a Super Admin who explicitly requested them, and the call is audited.
 */
async function nicMap(tx: DbOrTx, refs: string[], fullIdentifiers: boolean): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(refs.filter(Boolean))];
  if (!unique.length) return map;
  const rows = await tx
    .select({ ref: students.ref, nicMasked: students.nicMasked, nicEnc: students.nicEnc })
    .from(students)
    .where(inArray(students.ref, unique));
  for (const r of rows) {
    if (fullIdentifiers && r.nicEnc) map.set(r.ref, decryptNic(r.nicEnc));
    else map.set(r.ref, r.nicMasked ?? "");
  }
  return map;
}

async function studentTable(
  tx: DbOrTx,
  p: StaffPrincipal,
  filters: { programmeId?: string; intakeId?: string },
  fullIdentifiers: boolean,
): Promise<Table> {
  const conds = [intakeScopeWhere(p, intakes.id, intakes.programmeId)];
  if (filters.programmeId) conds.push(eq(intakes.programmeId, filters.programmeId));
  if (filters.intakeId) conds.push(eq(intakes.id, filters.intakeId));

  const rows = isSuper(p) && !filters.programmeId && !filters.intakeId
    ? await tx.select({ ref: students.ref, name: students.fullName, phone: students.phone, email: students.email, status: students.status, nicMasked: students.nicMasked })
      .from(students).orderBy(asc(students.fullName))
    : await tx
      .selectDistinct({ ref: students.ref, name: students.fullName, phone: students.phone, email: students.email, status: students.status, nicMasked: students.nicMasked })
      .from(students)
      .innerJoin(enrolments, eq(enrolments.studentId, students.id))
      .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
      .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
      .where(and(...conds))
      .orderBy(asc(students.fullName));

  const nics = fullIdentifiers ? await nicMap(tx, rows.map((r) => r.ref), true) : null;
  return {
    columns: [
      { key: "ref", header: "student_ref", definition: "Internal student reference (unique)" },
      { key: "nic", header: "nic", definition: fullIdentifiers ? "Full NIC (Super Admin authorized)" : "NIC masked to the last 3 characters" },
      { key: "name", header: "full_name", definition: "Student full name" },
      { key: "phone", header: "phone", definition: "Primary phone" },
      { key: "email", header: "email", definition: "Email address" },
      { key: "status", header: "status", definition: "Student account status" },
    ],
    rows: rows.map((r) => ({ ref: r.ref, nic: nics?.get(r.ref) ?? r.nicMasked ?? "", name: r.name, phone: r.phone, email: r.email, status: r.status })),
  };
}

async function buildTable(
  tx: DbOrTx,
  p: StaffPrincipal,
  req: ExportRequest,
  dates: { from: BizDate; to: BizDate; asOf: BizDate },
  fullIdentifiers: boolean,
): Promise<Table> {
  const f = filtersOf(req, dates);

  switch (req.report) {
    case "dashboard": {
      const m = await getCommandCentreMetrics(tx, p, { asOf: dates.asOf, periodFrom: dates.from, periodTo: dates.to });
      const values: [string, number, string][] = [
        ["totalRegisteredStudents", m.totalRegisteredStudents, "count"],
        ["activeStudents", m.activeStudents, "count"],
        ["activeEnrolments", m.activeEnrolments, "count"],
        ["activeProgrammes", m.activeProgrammes, "count"],
        ["freeSponsorStudents", m.freeSponsorStudents, "count"],
        ["pendingSlips", m.pendingSlips, "count"],
        ["rejectedSlips", m.rejectedSlips, "count"],
        ["historicalApprovals", m.historicalApprovals, "count"],
        ["historicalRejections", m.historicalRejections, "count"],
        ["studentsWithDues", m.studentsWithDues, "count"],
        ["outstanding", m.outstandingMinor, "money"],
        ["dueNow", m.dueNowMinor, "money"],
        ["overdue", m.overdueMinor, "money"],
        ["callsDueToday", m.callsDueToday, "count"],
        ["unansweredFollowUps", m.unansweredFollowUps, "count"],
        ["promisedPaymentsDue", m.promisedPaymentsDue, "count"],
        ["admissionsAwaitingDecision", m.admissionsAwaitingDecision, "count"],
      ];
      return {
        columns: [
          { key: "metric", header: "metric", definition: "Command-centre metric key" },
          { key: "label", header: "label", definition: "Human-readable metric label" },
          { key: "value", header: "value", definition: "Metric value; money metrics are LKR minor units" },
          { key: "unit", header: "unit", definition: "count or money" },
        ],
        rows: values.map(([key, value, unit]) => ({
          metric: key,
          label: COMMAND_METRIC_DEFINITIONS.find((d) => d.key === key)?.label ?? key,
          value,
          unit,
        })),
      };
    }
    case "students":
      return studentTable(tx, p, req, fullIdentifiers);
    case "outstanding":
    case "ageing": {
      const r = await outstandingAgeing(tx, p, { asOf: dates.asOf, programmeId: req.programmeId, intakeId: req.intakeId });
      const nics = await nicMap(tx, r.rows.map((x) => x.studentRef), fullIdentifiers);
      return {
        columns: [
          { key: "studentRef", header: "student_ref", definition: "Internal student reference" },
          { key: "nic", header: "nic", definition: fullIdentifiers ? "Full NIC (Super Admin authorized)" : "Masked NIC" },
          { key: "studentName", header: "student_name", definition: "Student full name" },
          { key: "programmeCode", header: "programme_code", definition: "Programme code" },
          { key: "intakeCode", header: "intake_code", definition: "Intake code" },
          { key: "enrolmentId", header: "enrolment_id", definition: "Enrolment identifier" },
          money("outstandingMinor", "outstanding_minor"),
          money("dueNowMinor", "due_now_minor"),
          money("overdueMinor", "overdue_minor"),
          money("b1", "ageing_1_30_minor"),
          money("b2", "ageing_31_60_minor"),
          money("b3", "ageing_61_90_minor"),
          money("b4", "ageing_91_plus_minor"),
        ],
        rows: r.rows.map((x) => ({
          studentRef: x.studentRef, nic: nics?.get(x.studentRef) ?? "", studentName: x.studentName,
          programmeCode: x.programmeCode, intakeCode: x.intakeCode, enrolmentId: x.enrolmentId,
          outstandingMinor: x.outstandingMinor, dueNowMinor: x.dueNowMinor, overdueMinor: x.overdueMinor,
          b1: x.buckets["1-30"], b2: x.buckets["31-60"], b3: x.buckets["61-90"], b4: x.buckets["91+"],
        })),
      };
    }
    case "credits": {
      const rows = await enrolmentCredits(tx, p, { asOf: dates.asOf, programmeId: req.programmeId, intakeId: req.intakeId });
      const nics = await nicMap(tx, rows.map((x) => x.studentRef), fullIdentifiers);
      return {
        columns: [
          { key: "studentRef", header: "student_ref", definition: "Internal student reference" },
          { key: "nic", header: "nic", definition: fullIdentifiers ? "Full NIC (Super Admin authorized)" : "Masked NIC" },
          { key: "studentName", header: "student_name", definition: "Student full name" },
          { key: "programmeCode", header: "programme_code", definition: "Programme code" },
          { key: "intakeCode", header: "intake_code", definition: "Intake code" },
          { key: "enrolmentId", header: "enrolment_id", definition: "Enrolment identifier" },
          money("collectedMinor", "collected_minor"),
          money("allocatedMinor", "allocated_minor"),
          money("creditMinor", "credit_minor"),
        ],
        rows: rows.map((x) => ({ ...x, nic: nics?.get(x.studentRef) ?? "" })),
      };
    }
    case "receipts":
    case "transfer-receipts": {
      const r = req.report === "receipts" ? await receiptsByApprovalDate(tx, p, f) : await receiptsByTransferDate(tx, p, f);
      return {
        columns: [
          { key: "date", header: "date", definition: r.basisLabel },
          { key: "receiptCount", header: "receipt_count", definition: "Number of approved receipts" },
          money("receiptMinor", "receipts_minor"),
          { key: "historicalCount", header: "historical_count", definition: "Historical imports" },
          money("historicalMinor", "historical_minor"),
          { key: "reversalCount", header: "reversal_count", definition: "Reversal events" },
          money("correctionsMinor", "corrections_minor"),
          money("claimedMinor", "claimed_minor"),
          money("netMinor", "net_collected_minor"),
        ],
        rows: r.rows as unknown as Record<string, unknown>[],
      };
    }
    case "allocations": {
      const rows = await allocationsByInstalment(tx, p, f);
      return {
        columns: [
          { key: "studentRef", header: "student_ref", definition: "Internal student reference" },
          { key: "studentName", header: "student_name", definition: "Student full name" },
          { key: "programmeCode", header: "programme_code", definition: "Programme code" },
          { key: "intakeCode", header: "intake_code", definition: "Intake code" },
          { key: "enrolmentId", header: "enrolment_id", definition: "Enrolment identifier" },
          { key: "instalmentId", header: "instalment_id", definition: "Instalment identifier" },
          { key: "sequence", header: "sequence", definition: "Instalment sequence" },
          { key: "periodLabel", header: "period_label", definition: "Instalment period label" },
          { key: "dueDate", header: "due_date", definition: "Due date" },
          money("activeAllocatedMinor", "active_allocated_minor"),
          money("reversedAllocatedMinor", "reversed_allocated_minor"),
          { key: "activeAllocationCount", header: "active_allocation_count", definition: "Active allocation rows" },
        ],
        rows: rows as unknown as Record<string, unknown>[],
      };
    }
    case "exemptions": {
      const r = await exemptionsReport(tx, p, f);
      return {
        columns: [
          { key: "studentRef", header: "student_ref", definition: "Internal student reference" },
          { key: "studentName", header: "student_name", definition: "Student full name" },
          { key: "programmeCode", header: "programme_code", definition: "Programme code" },
          { key: "intakeCode", header: "intake_code", definition: "Intake code" },
          { key: "type", header: "exemption_type", definition: "Free card, sponsorship, discount or arrears waiver" },
          { key: "basis", header: "basis", definition: "FIXED (minor units per instalment) or PERCENT (basis points, 10000 = 100%)" },
          { key: "value", header: "value", definition: "Basis-dependent value" },
          money("capMinor", "cap_minor"),
          { key: "sponsorName", header: "sponsor_name", definition: "Sponsor, when applicable" },
          { key: "status", header: "status", definition: "Award status" },
          { key: "effectiveFrom", header: "effective_from", definition: "Effective from (business date)" },
          { key: "effectiveTo", header: "effective_to", definition: "Effective to (business date, blank = open)" },
        ],
        rows: r.awards as unknown as Record<string, unknown>[],
      };
    }
    case "programme-totals": {
      const rows = await programmeIntakeTotals(tx, p, { asOf: dates.asOf, programmeId: req.programmeId, intakeId: req.intakeId, groupBy: req.groupBy });
      return {
        columns: [
          { key: "groupCode", header: req.groupBy === "INTAKE" ? "intake_code" : "programme_code", definition: "Group code" },
          { key: "groupLabel", header: "group_label", definition: "Group label" },
          { key: "programmeCode", header: "programme_code", definition: "Programme code" },
          { key: "intakeCode", header: "intake_code", definition: "Intake code (intake grouping only)" },
          { key: "studentCount", header: "student_count", definition: "Distinct students" },
          { key: "enrolmentCount", header: "enrolment_count", definition: "Active enrolments" },
          money("collectedMinor", "collected_minor"),
          money("outstandingMinor", "outstanding_minor"),
          money("dueNowMinor", "due_now_minor"),
          money("overdueMinor", "overdue_minor"),
          money("creditMinor", "credit_minor"),
        ],
        rows: rows as unknown as Record<string, unknown>[],
      };
    }
    case "review-throughput": {
      const r = await reviewThroughput(tx, p, f);
      return {
        columns: [
          { key: "date", header: "date", definition: "Business date (Asia/Colombo)" },
          { key: "kind", header: "action_kind", definition: "APPROVE, REJECT, UNDO or CORRECTION" },
          { key: "count", header: "count", definition: "Actions recorded" },
        ],
        rows: r.rows as unknown as Record<string, unknown>[],
      };
    }
    case "follow-up-outcomes": {
      const r = await followUpOutcomes(tx, p, f);
      return {
        columns: [
          { key: "outcome", header: "outcome", definition: "Recorded call outcome" },
          { key: "count", header: "count", definition: "Attempts with this outcome" },
        ],
        rows: r.rows as unknown as Record<string, unknown>[],
      };
    }
    case "collection-rate": {
      const r = await collectionRateReport(tx, p, { asOf: dates.asOf, programmeId: req.programmeId, intakeId: req.intakeId });
      return {
        columns: [
          { key: "asOf", header: "as_of", definition: "Obligations due through this business date" },
          money("numeratorMinor", "allocated_due_minor"),
          money("denominatorMinor", "net_due_minor"),
          { key: "rate", header: "rate", definition: "Allocated due / net due; blank/N/A when the denominator is zero" },
          { key: "display", header: "rate_display", definition: "Human-readable rate or N/A" },
          money("outstandingMinor", "all_plan_outstanding_minor"),
          money("collectedMinor", "all_plan_collected_minor"),
        ],
        rows: [{
          asOf: r.asOf, numeratorMinor: r.numeratorMinor, denominatorMinor: r.denominatorMinor,
          rate: r.rate === null ? "" : r.rate, display: r.display,
          outstandingMinor: r.settlement.outstandingMinor, collectedMinor: r.settlement.collectedMinor,
        }],
      };
    }
  }
}

/* -------------------------------------------------------------- public API */

/**
 * Generate an authorized, spreadsheet-injection-safe CSV. Admin principals need the
 * `exports.download` capability; full identifiers additionally require Super Admin and
 * an explicit flag. Every export (masked or full) is written to the audit log.
 */
export async function exportReportCsv(
  tx: DbOrTx,
  p0: StaffPrincipal,
  input: ExportRequest,
  opts: { requestId?: string } = {},
): Promise<ExportResult> {
  const req = ExportRequestSchema.parse(input);
  const p = await freshPrincipal(tx, p0); // current account state, capabilities and scope
  requireCap(p, "exports.download");
  const fullIdentifiers = req.fullIdentifiers === true;
  if (fullIdentifiers) requireSuper(p);

  const dates = resolveExportDates(req);
  const table = await buildTable(tx, p, req, dates, fullIdentifiers);
  const generatedAt = now().toISOString();

  const preamble = [
    `T2T Student Operations — ${req.report}`,
    `Generated: ${generatedAt} (${formatInstant(generatedAt)}, Asia/Colombo business date ${dates.asOf})`,
    "Timezone: Asia/Colombo (business dates YYYY-MM-DD)",
    "Currency: LKR — monetary columns are integer minor units (1 LKR = 100) unless stated otherwise",
    `Filters: from=${dates.from} to=${dates.to} asOf=${dates.asOf} programme=${req.programmeId ?? "all"} intake=${req.intakeId ?? "all"}`,
    `Identifiers: ${fullIdentifiers ? "full NIC (Super Admin authorized, audited)" : "NIC masked (default)"}`,
    "Field definitions:",
    ...table.columns.map((c) => `${c.header}: ${c.definition}`),
  ];

  const csv = toCsv(
    table.columns.map((c) => c.header),
    table.rows.map((row) => table.columns.map((c) => row[c.key])),
    { preamble },
  );

  await audit(tx, {
    actorType: "STAFF",
    actorId: p.id,
    action: fullIdentifiers ? "export.full_identifiers" : "export.download",
    entityType: "export",
    entityId: req.report,
    after: {
      report: req.report, from: dates.from, to: dates.to, asOf: dates.asOf,
      programmeId: req.programmeId ?? null, intakeId: req.intakeId ?? null,
      rowCount: table.rows.length, fullIdentifiers,
    },
    requestId: opts.requestId ?? null,
  });

  const stamp = generatedAt.replace(/[:.]/g, "-");
  return {
    report: req.report,
    filename: sanitiseFilename(`t2t-${req.report}-${dates.asOf}-${stamp}.csv`),
    csv,
    rowCount: table.rows.length,
    fullIdentifiers,
    generatedAt,
    businessDate: dates.asOf,
  };
}

/** Convenience: whether this principal may export full identifiers (Super Admin only). */
export function canExportFullIdentifiers(p: StaffPrincipal): boolean {
  return isSuper(p) && can(p, "exports.full_identifiers");
}
