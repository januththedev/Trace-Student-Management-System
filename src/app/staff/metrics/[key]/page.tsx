import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db/client";
import { currentStaff } from "@/server/auth/staff";
import { COMMAND_METRIC_DEFINITIONS, getMetricDrillDown, type CommandMetricKey, type DrillRow } from "@/server/services/reports/metrics";
import { Card, EmptyState, Money, PageBody } from "@/components/ui";
import { businessDate, formatBizDate, formatInstant, isBizDate } from "@/lib/time";
import { PageHeader } from "../../_shell/page-header";

export const dynamic = "force-dynamic";

function cells(r: DrillRow): { href?: string; labels: string[]; cols: React.ReactNode[] } {
  if ("submissionId" in r) return { href: `/staff/review`, labels: ["Student", "Programme / intake", "Claimed", "Transferred", "Review status"], cols: [r.studentName, `${r.programmeCode} · ${r.intakeCode}`, <Money key="m" minor={r.claimedMinor} />, formatBizDate(r.transferDate), r.status.replaceAll("_", " ").toLowerCase()] };
  if ("promiseId" in r) return { href: `/staff/enrolments/${r.enrolmentId}`, labels: ["Student", "Promised", "Fulfilled", "Promised date", "Status"], cols: [r.studentName, <Money key="a" minor={r.amountMinor} />, <Money key="f" minor={r.fulfilledMinor} />, formatBizDate(r.promisedDate), r.state.replaceAll("_", " ").toLowerCase()] };
  if ("taskId" in r) return { href: `/staff/calls`, labels: ["Student", "Task", "Due", "Latest outcome"], cols: [r.studentName, r.taskType.replaceAll("_", " ").toLowerCase(), formatInstant(r.dueAt), r.latestOutcome?.replaceAll("_", " ").toLowerCase() ?? "—"] };
  if ("outstandingMinor" in r) return { href: `/staff/enrolments/${r.enrolmentId}`, labels: ["Student", "Programme / intake", "Outstanding", "Due now", "Overdue"], cols: [r.studentName, `${r.programmeCode} · ${r.intakeCode}`, <Money key="o" minor={r.outstandingMinor} />, <Money key="d" minor={r.dueNowMinor} />, <Money key="v" minor={r.overdueMinor} />] };
  if ("admissionId" in r) return { href: `/staff/admissions`, labels: ["Applicant", "Programme / intake", "Status", "Created"], cols: [r.applicantName, `${r.programmeCode} · ${r.intakeCode}`, r.state.replaceAll("_", " ").toLowerCase(), formatInstant(r.createdAt)] };
  if ("studentId" in r && "ref" in r) return { href: `/staff/students/${r.studentId}`, labels: ["Student", "Reference", "Masked NIC", "Phone"], cols: [r.fullName, r.ref, r.nicMasked ?? "—", r.phone ?? "—"] };
  if ("programmeId" in r) return { href: `/staff/programmes/${r.programmeId}`, labels: ["Programme", "Code"], cols: [r.name, r.code] };
  return { labels: [], cols: [] };
}

export default async function MetricDrill({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const p = await currentStaff();
  if (!p) redirect("/staff/login");
  const { key } = await params;
  const def = COMMAND_METRIC_DEFINITIONS.find((d) => d.key === key);
  if (!def) notFound();
  const sp = await searchParams;
  const asOf = sp.asOf && isBizDate(sp.asOf) ? sp.asOf : businessDate();
  const dd = await getMetricDrillDown(db(), p, key as CommandMetricKey, { asOf });
  return (
    <>
      <PageHeader title={def.label} sub={`${def.description} As of ${formatBizDate(asOf)}.`} actions={<Link href="/staff" className="u-draw inline-flex min-h-11 items-center text-sm text-accent">Back to command centre</Link>} />
      <PageBody className="space-y-4">
        <p className="text-sm">Total: <span className="font-medium">{dd.unit === "money" ? <Money minor={dd.totalMinor ?? 0} /> : dd.count}</span>{dd.unit === "money" ? ` across ${dd.count} rows` : ""}</p>
        {dd.rows.length === 0 ? <EmptyState title="Nothing to show">No records match this figure in your scope.</EmptyState> : (
          <Card className="overflow-hidden">
            <table role="table" className="responsive-table w-full text-sm">
              <caption className="sr-only">{def.label} as of {formatBizDate(asOf)}</caption>
              <thead className="bg-surface"><tr>{cells(dd.rows[0]).labels.map((label) => <th key={label} scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted">{label}</th>)}</tr></thead>
              <tbody>
                {dd.rows.map((r, i) => {
                  const c = cells(r);
                  return (
                    <tr key={i} className="border-b border-line last:border-0 hover:bg-surface">
                      {c.cols.map((col, j) => <td key={j} data-label={c.labels[j]} className="px-4 py-3">{j === 0 && c.href ? <Link className="u-draw inline-flex min-h-11 items-center font-medium" href={c.href}>{col}</Link> : <span>{col}</span>}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </PageBody>
    </>
  );
}
