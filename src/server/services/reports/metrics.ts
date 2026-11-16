import "server-only";
import { and, asc, eq, gte, isNull, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  admissions, enrolments, exemptionAwards, followUpTasks, intakes,
  paymentPromises, paymentSubmissions, programmes, reviewActions, students,
} from "@/db/schema";
import { intakeScopeWhere, isSuper, type StaffPrincipal } from "@/server/auth/policy";
import { balanceMetrics, loadBalanceInstalments, loadBalanceSummaries } from "./balances";
import type { EnrolmentSummary, InstalmentView } from "@/domain/finance";
import { addDays, businessDate, colomboInstant, now, type BizDate } from "@/lib/time";

/* ------------------------------------------------------------------ types */

/**
 * Every command-centre metric in spec §11. The metric value and its drill-down list are
 * produced by the same loader functions, so the total always equals the filtered list.
 */
export type CommandMetricKey =
  | "totalRegisteredStudents"
  | "activeStudents"
  | "activeEnrolments"
  | "activeProgrammes"
  | "freeSponsorStudents"
  | "pendingSlips"
  | "rejectedSlips"
  | "studentsWithDues"
  | "outstanding"
  | "dueNow"
  | "overdue"
  | "callsDueToday"
  | "unansweredFollowUps"
  | "promisedPaymentsDue"
  | "admissionsAwaitingDecision";

export interface CommandMetricDefinition {
  key: CommandMetricKey;
  label: string;
  description: string;
  unit: "count" | "money";
}

export const COMMAND_METRIC_DEFINITIONS: readonly CommandMetricDefinition[] = [
  { key: "totalRegisteredStudents", label: "Total registered students", description: "Distinct people visible within scope; Super Admin includes unassigned records.", unit: "count" },
  { key: "activeStudents", label: "Active students", description: "Distinct people with at least one visible active enrolment.", unit: "count" },
  { key: "activeEnrolments", label: "Active enrolments", description: "Visible active enrolments (counted separately from people).", unit: "count" },
  { key: "activeProgrammes", label: "Active programmes", description: "Active programmes with applicable visible scope.", unit: "count" },
  { key: "freeSponsorStudents", label: "Free / sponsored students", description: "Distinct students with an effective free-card or sponsorship award in the selected period.", unit: "count" },
  { key: "pendingSlips", label: "Pending slips", description: "Payment submissions currently awaiting review.", unit: "count" },
  { key: "rejectedSlips", label: "Rejected slips", description: "Payment submissions whose current state is rejected (historical decision counts are reported separately).", unit: "count" },
  { key: "studentsWithDues", label: "Students with dues", description: "Distinct students with a visible due-now or overdue remaining balance.", unit: "count" },
  { key: "outstanding", label: "Outstanding amount", description: "All active remaining obligations, including future dues.", unit: "money" },
  { key: "dueNow", label: "Due now", description: "Visible remaining obligations with a due date on or before the as-of date.", unit: "money" },
  { key: "overdue", label: "Overdue", description: "Visible remaining obligations with a due date strictly before the as-of date.", unit: "money" },
  { key: "callsDueToday", label: "Calls due today", description: "Open collection tasks due on or before the end of the selected business day.", unit: "count" },
  { key: "unansweredFollowUps", label: "Unanswered follow-ups", description: "Open call tasks whose most recent recorded attempt was NO_ANSWER.", unit: "count" },
  { key: "promisedPaymentsDue", label: "Promised payments due", description: "Active promises due on the selected business date and not yet fulfilled or cancelled.", unit: "count" },
  { key: "admissionsAwaitingDecision", label: "Admissions awaiting decision", description: "Under-review applicants in scope.", unit: "count" },
] as const;

export interface MetricOptions {
  /** Business date used for balances and due/overdue definitions. Defaults to today in Colombo. */
  asOf?: BizDate;
  /** Optional award/report period start (defaults to asOf for award metrics). */
  periodFrom?: BizDate;
  /** Optional award/report period end (defaults to asOf for award metrics). */
  periodTo?: BizDate;
}

export interface CommandCentreMetrics {
  asOf: BizDate;
  generatedAt: string;
  totalRegisteredStudents: number;
  activeStudents: number;
  activeEnrolments: number;
  activeProgrammes: number;
  freeSponsorStudents: number;
  pendingSlips: number;
  rejectedSlips: number;
  /** Historical review decisions, kept separate from current submission state. */
  historicalApprovals: number;
  historicalRejections: number;
  studentsWithDues: number;
  outstandingMinor: number;
  dueNowMinor: number;
  overdueMinor: number;
  callsDueToday: number;
  unansweredFollowUps: number;
  promisedPaymentsDue: number;
  promisedPaymentsDueMinor: number;
  admissionsAwaitingDecision: number;
}

export interface StudentDrillRow {
  studentId: string;
  ref: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  nicMasked: string | null;
}

export interface ProgrammeDrillRow {
  programmeId: string;
  code: string;
  name: string;
}

export interface SlipDrillRow {
  submissionId: string;
  enrolmentId: string;
  studentRef: string;
  studentName: string;
  intakeCode: string;
  programmeCode: string;
  claimedMinor: number;
  transferDate: BizDate;
  status: string;
  submittedAt: Date;
}

export interface EnrolmentDuesDrillRow {
  enrolmentId: string;
  studentId: string;
  studentRef: string;
  studentName: string;
  intakeId: string;
  intakeCode: string;
  programmeId: string;
  programmeCode: string;
  outstandingMinor: number;
  dueNowMinor: number;
  overdueMinor: number;
  creditMinor: number;
}

export interface CallTaskDrillRow {
  taskId: string;
  enrolmentId: string;
  studentId: string;
  studentRef: string;
  studentName: string;
  taskType: string;
  dueAt: Date;
  priority: number;
  latestOutcome: string | null;
}

export interface PromiseDrillRow {
  promiseId: string;
  enrolmentId: string;
  studentId: string;
  studentRef: string;
  studentName: string;
  amountMinor: number;
  fulfilledMinor: number;
  remainingMinor: number;
  promisedDate: BizDate;
  state: string;
}

export interface AdmissionDrillRow {
  admissionId: string;
  applicantName: string;
  intakeId: string;
  intakeCode: string;
  programmeId: string;
  programmeCode: string;
  state: string;
  createdAt: Date;
}

export type DrillRow =
  | StudentDrillRow
  | ProgrammeDrillRow
  | SlipDrillRow
  | EnrolmentDuesDrillRow
  | CallTaskDrillRow
  | PromiseDrillRow
  | AdmissionDrillRow;

export interface MetricDrillDown {
  key: CommandMetricKey;
  label: string;
  unit: "count" | "money";
  /** The metric value using the identical definition as the dashboard total. */
  count: number;
  /** For money metrics: the matching total in integer minor units. */
  totalMinor?: number;
  asOf: BizDate;
  rows: DrillRow[];
}

/* ----------------------------------------------------------------- helpers */

const num = (v: unknown): number => Number(v ?? 0);

function resolveAsOf(opts: MetricOptions): BizDate {
  const d = opts.asOf ?? businessDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("asOf must be a business date (YYYY-MM-DD)");
  return d;
}

const liveIntake = () => and(isNull(intakes.trashedAt), isNull(programmes.trashedAt));

const CALL_TASK_TYPES = ["COLLECTION_CALL", "CALLBACK"] as const;

/* ------------------------------------------------------------- projections */

export interface EnrolmentProjectionRow {
  enrolmentId: string;
  studentId: string;
  studentRef: string;
  studentName: string;
  phone: string | null;
  email: string | null;
  nicMasked: string | null;
  intakeId: string;
  intakeCode: string;
  intakeLabel: string;
  programmeId: string;
  programmeCode: string;
  programmeName: string;
  status: string;
  summary: EnrolmentSummary;
  instalments: InstalmentView[];
}

/**
 * Load visible enrolments with their authoritative ledger projection (batched, no N+1).
 * This is the single source for every balance metric and drill-down.
 */
export async function loadEnrolmentProjection(
  tx: DbOrTx,
  p: StaffPrincipal,
  opts: { asOf: BizDate; statuses?: readonly string[]; includeTrashed?: boolean; instalments?: boolean },
): Promise<EnrolmentProjectionRow[]> {
  const statuses = opts.statuses ?? ["ACTIVE"];
  const filters: SQL[] = [
    sql`${enrolments.status} in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`,
    intakeScopeWhere(p, intakes.id, intakes.programmeId),
  ];
  if (!opts.includeTrashed) filters.push(liveIntake() as SQL);

  const rows = await tx
    .select({
      enrolmentId: enrolments.id,
      studentId: students.id,
      studentRef: students.ref,
      studentName: students.fullName,
      phone: students.phone,
      email: students.email,
      nicMasked: students.nicMasked,
      intakeId: intakes.id,
      intakeCode: intakes.code,
      intakeLabel: intakes.label,
      programmeId: programmes.id,
      programmeCode: programmes.code,
      programmeName: programmes.name,
      status: enrolments.status,
    })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(...filters))
    .orderBy(asc(students.fullName), asc(enrolments.id));

  const summaries = await loadBalanceSummaries(tx, p, opts.asOf, opts);
  const details = opts.instalments ? await loadBalanceInstalments(tx, p, opts.asOf, opts) : null;
  return rows.map((r) => {
    return { ...r, summary: summaries.get(r.enrolmentId)!, instalments: details?.get(r.enrolmentId) ?? [] };
  });
}

/* --------------------------------------------------------------- students */

function loadRegisteredStudents(tx: DbOrTx, p: StaffPrincipal) {
  if (isSuper(p)) {
    return tx
      .select({ studentId: students.id, ref: students.ref, fullName: students.fullName, phone: students.phone, email: students.email, nicMasked: students.nicMasked })
      .from(students)
      .orderBy(asc(students.fullName));
  }
  return tx
    .selectDistinct({ studentId: students.id, ref: students.ref, fullName: students.fullName, phone: students.phone, email: students.email, nicMasked: students.nicMasked })
    .from(students)
    .innerJoin(enrolments, eq(enrolments.studentId, students.id))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(intakeScopeWhere(p, intakes.id, intakes.programmeId))
    .orderBy(asc(students.fullName));
}

function loadProgrammes(tx: DbOrTx, p: StaffPrincipal) {
  if (isSuper(p)) {
    return tx
      .select({ programmeId: programmes.id, code: programmes.code, name: programmes.name })
      .from(programmes)
      .where(and(eq(programmes.status, "ACTIVE"), isNull(programmes.trashedAt)))
      .orderBy(asc(programmes.name));
  }
  return tx
    .select({ programmeId: programmes.id, code: programmes.code, name: programmes.name })
    .from(programmes)
    .innerJoin(intakes, eq(intakes.programmeId, programmes.id))
    .where(and(eq(programmes.status, "ACTIVE"), isNull(programmes.trashedAt), isNull(intakes.trashedAt), intakeScopeWhere(p, intakes.id, intakes.programmeId)))
    .groupBy(programmes.id, programmes.code, programmes.name)
    .orderBy(asc(programmes.name));
}

function loadAwardedStudents(
  tx: DbOrTx,
  p: StaffPrincipal,
  opts: { from: BizDate; to: BizDate },
) {
  return tx
    .selectDistinct({
      studentId: students.id, ref: students.ref, fullName: students.fullName,
      phone: students.phone, email: students.email, nicMasked: students.nicMasked,
    })
    .from(exemptionAwards)
    .innerJoin(enrolments, eq(enrolments.id, exemptionAwards.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      eq(exemptionAwards.status, "ACTIVE"),
      sql`${exemptionAwards.type} in ('FREE_CARD', 'SPONSORSHIP')`,
      lte(exemptionAwards.effectiveFrom, opts.to),
      or(isNull(exemptionAwards.effectiveTo), gte(exemptionAwards.effectiveTo, opts.from)),
      liveIntake() as SQL,
      intakeScopeWhere(p, intakes.id, intakes.programmeId),
    ))
    .orderBy(asc(students.fullName));
}

/* ------------------------------------------------------------------ slips */

function loadSlips(tx: DbOrTx, p: StaffPrincipal, status: "PENDING_REVIEW" | "REJECTED") {
  return tx
    .select({
      submissionId: paymentSubmissions.id,
      enrolmentId: paymentSubmissions.enrolmentId,
      studentRef: students.ref,
      studentName: students.fullName,
      intakeCode: intakes.code,
      programmeCode: programmes.code,
      claimedMinor: paymentSubmissions.claimedMinor,
      transferDate: paymentSubmissions.transferDate,
      status: paymentSubmissions.status,
      submittedAt: paymentSubmissions.submittedAt,
    })
    .from(paymentSubmissions)
    .innerJoin(enrolments, eq(enrolments.id, paymentSubmissions.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(eq(paymentSubmissions.status, status), intakeScopeWhere(p, intakes.id, intakes.programmeId)))
    .orderBy(asc(paymentSubmissions.submittedAt));
}

async function loadDecisionCounts(tx: DbOrTx, p: StaffPrincipal): Promise<{ approvals: number; rejections: number }> {
  const rows = await tx
    .select({ kind: reviewActions.kind, n: sql<string>`count(*)` })
    .from(reviewActions)
    .innerJoin(paymentSubmissions, eq(paymentSubmissions.id, reviewActions.submissionId))
    .innerJoin(enrolments, eq(enrolments.id, paymentSubmissions.enrolmentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(intakeScopeWhere(p, intakes.id, intakes.programmeId))
    .groupBy(reviewActions.kind);
  const get = (k: string) => num(rows.find((r) => r.kind === k)?.n);
  return { approvals: get("APPROVE"), rejections: get("REJECT") };
}

/* ------------------------------------------------------------------- dues */

function duesRows(projection: EnrolmentProjectionRow[]): EnrolmentDuesDrillRow[] {
  return projection
    .filter((r) => r.summary.outstandingMinor > 0)
    .map((r) => ({
      enrolmentId: r.enrolmentId,
      studentId: r.studentId,
      studentRef: r.studentRef,
      studentName: r.studentName,
      intakeId: r.intakeId,
      intakeCode: r.intakeCode,
      programmeId: r.programmeId,
      programmeCode: r.programmeCode,
      outstandingMinor: r.summary.outstandingMinor,
      dueNowMinor: r.summary.dueNowMinor,
      overdueMinor: r.summary.overdueMinor,
      creditMinor: r.summary.creditMinor,
    }))
    .sort((a, b) => b.outstandingMinor - a.outstandingMinor);
}

/* ------------------------------------------------------------------ calls */

const latestAttemptOutcome = sql<string | null>`(
  select ca.outcome::text from call_attempts ca
  where ca.enrolment_id = ${followUpTasks.enrolmentId}
  order by ca.created_at desc
  limit 1
)`;

function loadCallTasks(
  tx: DbOrTx,
  p: StaffPrincipal,
  opts: { today: BizDate; unansweredOnly?: boolean },
) {
  const endOfDay = colomboInstant(addDays(opts.today, 1), 0, 0);
  const filters: SQL[] = [
    eq(followUpTasks.state, "OPEN"),
    sql`${followUpTasks.type} in (${sql.join(CALL_TASK_TYPES.map((t) => sql`${t}`), sql`, `)})`,
    sql`${followUpTasks.dueAt} < ${endOfDay.toISOString()}::timestamptz`,
    intakeScopeWhere(p, intakes.id, intakes.programmeId),
    liveIntake() as SQL,
  ];
  if (opts.unansweredOnly) filters.push(sql`${latestAttemptOutcome} = 'NO_ANSWER'`);

  return tx
    .select({
      taskId: followUpTasks.id,
      enrolmentId: followUpTasks.enrolmentId,
      studentId: students.id,
      studentRef: students.ref,
      studentName: students.fullName,
      taskType: followUpTasks.type,
      dueAt: followUpTasks.dueAt,
      priority: followUpTasks.priority,
      latestOutcome: latestAttemptOutcome,
    })
    .from(followUpTasks)
    .innerJoin(enrolments, eq(enrolments.id, followUpTasks.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(...filters))
    .orderBy(asc(followUpTasks.dueAt), asc(followUpTasks.priority));
}

/* --------------------------------------------------------------- promises */

function promiseRows(tx: DbOrTx, p: StaffPrincipal, today: BizDate) {
  return tx
    .select({
      promiseId: paymentPromises.id,
      enrolmentId: paymentPromises.enrolmentId,
      studentId: students.id,
      studentRef: students.ref,
      studentName: students.fullName,
      amountMinor: paymentPromises.amountMinor,
      fulfilledMinor: paymentPromises.fulfilledMinor,
      promisedDate: paymentPromises.promisedDate,
      state: paymentPromises.state,
    })
    .from(paymentPromises)
    .innerJoin(enrolments, eq(enrolments.id, paymentPromises.enrolmentId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(intakes, eq(intakes.id, enrolments.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(
      sql`${paymentPromises.state} in ('OPEN', 'PARTIALLY_FULFILLED')`,
      eq(paymentPromises.promisedDate, today),
      intakeScopeWhere(p, intakes.id, intakes.programmeId),
      liveIntake() as SQL,
    ))
    .orderBy(asc(paymentPromises.promisedDate), asc(students.fullName));
}

async function loadPromises(tx: DbOrTx, p: StaffPrincipal, today: BizDate): Promise<PromiseDrillRow[]> {
  return (await promiseRows(tx, p, today)).map(r => ({ ...r, remainingMinor: Math.max(0, r.amountMinor - r.fulfilledMinor) }));
}

/* -------------------------------------------------------------- admissions */

function loadAdmissionsAwaitingDecision(tx: DbOrTx, p: StaffPrincipal) {
  return tx
    .select({
      admissionId: admissions.id,
      applicantName: admissions.applicantName,
      intakeId: intakes.id,
      intakeCode: intakes.code,
      programmeId: programmes.id,
      programmeCode: programmes.code,
      state: admissions.state,
      createdAt: admissions.createdAt,
    })
    .from(admissions)
    .innerJoin(intakes, eq(intakes.id, admissions.intakeId))
    .innerJoin(programmes, eq(programmes.id, intakes.programmeId))
    .where(and(eq(admissions.state, "UNDER_REVIEW"), intakeScopeWhere(p, intakes.id, intakes.programmeId)))
    .orderBy(asc(admissions.createdAt));
}

/* ---------------------------------------------------------------- metrics */

/** Count the identical scoped query used by drill-downs, without returning every
 * student's profile or task to the application just to count it. */
async function countQuery(tx: DbOrTx, query: SQLWrapper) {
  const [r] = await tx.execute<{ n: string }>(sql`select count(*) n from (${query}) metric_rows`);
  return Number(r.n);
}

async function promiseTotals(tx: DbOrTx, p: StaffPrincipal, today: BizDate) {
  const [r] = await tx.execute<{ n: string; amount: string }>(sql`select count(*) n,
    coalesce(sum(greatest(amount_minor - fulfilled_minor, 0)), 0) amount from (${promiseRows(tx, p, today)}) promise_rows`);
  return { count: Number(r.n), amount: Number(r.amount) };
}

/**
 * Command-centre totals. Every value is computed from the same loaders used by
 * {@link getMetricDrillDown}; no metric re-implements money math.
 */
export async function getCommandCentreMetrics(tx: DbOrTx, p: StaffPrincipal, opts: MetricOptions = {}): Promise<CommandCentreMetrics> {
  const asOf = resolveAsOf(opts);
  const awardFrom = opts.periodFrom ?? asOf;
  const awardTo = opts.periodTo ?? asOf;

  const [registered, programmes, awards, pending, rejected, decisions, balances, calls, unanswered, promises, pendingAdmissions] = await Promise.all([
    countQuery(tx, loadRegisteredStudents(tx, p)),
    countQuery(tx, loadProgrammes(tx, p)),
    countQuery(tx, loadAwardedStudents(tx, p, { from: awardFrom, to: awardTo })),
    countQuery(tx, loadSlips(tx, p, "PENDING_REVIEW")),
    countQuery(tx, loadSlips(tx, p, "REJECTED")),
    loadDecisionCounts(tx, p),
    balanceMetrics(tx, p, asOf),
    countQuery(tx, loadCallTasks(tx, p, { today: asOf })),
    countQuery(tx, loadCallTasks(tx, p, { today: asOf, unansweredOnly: true })),
    promiseTotals(tx, p, asOf),
    countQuery(tx, loadAdmissionsAwaitingDecision(tx, p)),
  ]);

  return {
    asOf,
    generatedAt: now().toISOString(),
    totalRegisteredStudents: registered,
    activeStudents: balances.activeStudents,
    activeEnrolments: balances.activeEnrolments,
    activeProgrammes: programmes,
    freeSponsorStudents: awards,
    pendingSlips: pending,
    rejectedSlips: rejected,
    historicalApprovals: decisions.approvals,
    historicalRejections: decisions.rejections,
    studentsWithDues: balances.studentsWithDues,
    outstandingMinor: balances.summary.outstandingMinor,
    dueNowMinor: balances.summary.dueNowMinor,
    overdueMinor: balances.summary.overdueMinor,
    callsDueToday: calls,
    unansweredFollowUps: unanswered,
    promisedPaymentsDue: promises.count,
    promisedPaymentsDueMinor: promises.amount,
    admissionsAwaitingDecision: pendingAdmissions,
  };
}

function definition(key: CommandMetricKey): CommandMetricDefinition {
  const d = COMMAND_METRIC_DEFINITIONS.find((x) => x.key === key);
  if (!d) throw new Error(`Unknown metric ${key}`);
  return d;
}

/**
 * Filtered list backing a dashboard metric. Uses the exact same loader as the total so
 * a drill-down cannot disagree with the number on the command centre.
 */
export async function getMetricDrillDown(
  tx: DbOrTx,
  p: StaffPrincipal,
  key: CommandMetricKey,
  opts: MetricOptions = {},
): Promise<MetricDrillDown> {
  const asOf = resolveAsOf(opts);
  const awardFrom = opts.periodFrom ?? asOf;
  const awardTo = opts.periodTo ?? asOf;
  const def = definition(key);
  const base = { key, label: def.label, unit: def.unit, asOf };

  switch (key) {
    case "totalRegisteredStudents": {
      const rows = await loadRegisteredStudents(tx, p);
      return { ...base, count: rows.length, rows };
    }
    case "activeProgrammes": {
      const rows = await loadProgrammes(tx, p);
      return { ...base, count: rows.length, rows };
    }
    case "freeSponsorStudents": {
      const rows = await loadAwardedStudents(tx, p, { from: awardFrom, to: awardTo });
      return { ...base, count: rows.length, rows };
    }
    case "pendingSlips": {
      const rows = await loadSlips(tx, p, "PENDING_REVIEW");
      return { ...base, count: rows.length, rows };
    }
    case "rejectedSlips": {
      const rows = await loadSlips(tx, p, "REJECTED");
      return { ...base, count: rows.length, rows };
    }
    case "admissionsAwaitingDecision": {
      const rows = await loadAdmissionsAwaitingDecision(tx, p);
      return { ...base, count: rows.length, rows };
    }
    case "callsDueToday": {
      const rows = await loadCallTasks(tx, p, { today: asOf });
      return { ...base, count: rows.length, rows };
    }
    case "unansweredFollowUps": {
      const rows = await loadCallTasks(tx, p, { today: asOf, unansweredOnly: true });
      return { ...base, count: rows.length, rows };
    }
    case "promisedPaymentsDue": {
      const rows = await loadPromises(tx, p, asOf);
      return { ...base, count: rows.length, totalMinor: rows.reduce((a, r) => a + r.remainingMinor, 0), rows };
    }
    case "activeStudents": {
      const projection = await loadEnrolmentProjection(tx, p, { asOf });
      const seen = new Map<string, StudentDrillRow>();
      for (const r of projection) {
        if (!seen.has(r.studentId)) {
          seen.set(r.studentId, { studentId: r.studentId, ref: r.studentRef, fullName: r.studentName, phone: r.phone, email: r.email, nicMasked: r.nicMasked });
        }
      }
      const rows = [...seen.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
      return { ...base, count: rows.length, rows };
    }
    case "activeEnrolments": {
      const projection = await loadEnrolmentProjection(tx, p, { asOf });
      const rows = projection.map((r) => ({
        enrolmentId: r.enrolmentId, studentId: r.studentId, studentRef: r.studentRef, studentName: r.studentName,
        intakeId: r.intakeId, intakeCode: r.intakeCode, programmeId: r.programmeId, programmeCode: r.programmeCode,
        outstandingMinor: r.summary.outstandingMinor, dueNowMinor: r.summary.dueNowMinor, overdueMinor: r.summary.overdueMinor,
        creditMinor: r.summary.creditMinor,
      }));
      return { ...base, count: rows.length, rows };
    }
    case "studentsWithDues": {
      const projection = await loadEnrolmentProjection(tx, p, { asOf });
      const rows = duesRows(projection).filter((r) => r.dueNowMinor > 0);
      const students = new Set(rows.map((r) => r.studentId));
      return { ...base, count: students.size, totalMinor: rows.reduce((a, r) => a + r.dueNowMinor, 0), rows };
    }
    case "outstanding":
    case "dueNow":
    case "overdue": {
      const projection = await loadEnrolmentProjection(tx, p, { asOf });
      const rows = duesRows(projection).filter((r) => (key === "outstanding" ? r.outstandingMinor > 0 : key === "dueNow" ? r.dueNowMinor > 0 : r.overdueMinor > 0));
      const totalMinor = rows.reduce((a, r) => a + (key === "outstanding" ? r.outstandingMinor : key === "dueNow" ? r.dueNowMinor : r.overdueMinor), 0);
      return { ...base, count: rows.length, totalMinor, rows };
    }
  }
}

/** Convenience wrapper used by dashboard pages: metrics plus a drill-down for one metric. */
export async function getCommandCentre(
  tx: DbOrTx,
  p: StaffPrincipal,
  drillKey: CommandMetricKey,
  opts: MetricOptions = {},
): Promise<{ metrics: CommandCentreMetrics; drillDown: MetricDrillDown }> {
  const [metrics, drillDown] = await Promise.all([
    getCommandCentreMetrics(tx, p, opts),
    getMetricDrillDown(tx, p, drillKey, opts),
  ]);
  return { metrics, drillDown };
}
