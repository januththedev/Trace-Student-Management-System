import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertOctagon, ArrowRight, BookOpen, CalendarCheck, ClipboardCheck, GraduationCap, HandCoins, Hourglass, PhoneCall,
  PhoneMissed, ShieldAlert, UserPlus, Users, Wallet, XCircle,
} from "lucide-react";
import { db } from "@/db/client";
import { currentStaff } from "@/server/auth/staff";
import { getCommandCentreMetrics } from "@/server/services/reports/metrics";
import { pendingQueue } from "@/server/services/review";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, Money, PageBody, Stat } from "@/components/ui";
import { businessDate, formatBizDate, formatInstant, now } from "@/lib/time";
import { PageHeader } from "./_shell/page-header";
import { StorageCapacity } from "./_components/storage-capacity";
import { getStorageUsage } from "@/server/services/storage-usage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command centre" };

const STALE_MS = 48 * 60 * 60 * 1000;

export default async function CommandCentre() {
  const p = await currentStaff();
  if (!p) redirect("/staff/login");
  const today = businessDate();
  const [m, queue, storageUsage] = await Promise.all([
    getCommandCentreMetrics(db(), p, { asOf: today }),
    pendingQueue(db(), p, { limit: 6, flagged: "any", skip: [] }),
    p.role === "SUPER_ADMIN" ? getStorageUsage(p) : Promise.resolve(null),
  ]);
  const t = now().getTime();
  const stale = queue.items.filter((q) => t - new Date(q.submittedAt).getTime() > STALE_MS).length;
  const d = (k: string) => `/staff/metrics/${k}`;
  const first = p.name.split(" ")[0];
  const future = Math.max(0, m.outstandingMinor - m.dueNowMinor);
  const dueNotOver = Math.max(0, m.dueNowMinor - m.overdueMinor);
  const pct = (x: number) => (m.outstandingMinor > 0 ? Math.max(2, Math.round((x / m.outstandingMinor) * 100)) : 0);

  return (
    <>
      <PageHeader eyebrow={formatBizDate(today)} title={`Good to see you, ${first}`}
        sub={`${p.role === "SUPER_ADMIN" ? "All programmes" : "Your assigned programmes"} · Asia/Colombo business day`}
        actions={<ButtonLink href="/staff/review"><ClipboardCheck /> Start reviewing{m.pendingSlips ? ` (${m.pendingSlips})` : ""}</ButtonLink>} />
      <PageBody>
        {storageUsage ? <StorageCapacity usage={storageUsage} /> : null}
        <section aria-labelledby="now-h">
          <h2 id="now-h" className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-muted">Needs action now</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Pending review" value={m.pendingSlips} href={d("pendingSlips")} tone={m.pendingSlips ? "warn" : undefined} icon={<Hourglass />} hint={stale ? `${stale} waiting over 48h` : "Oldest first"} />
            <Stat label="Calls due today" value={m.callsDueToday} href={d("callsDueToday")} icon={<PhoneCall />} />
            <Stat label="Unanswered" value={m.unansweredFollowUps} href={d("unansweredFollowUps")} icon={<PhoneMissed />} />
            <Stat label="Promises due" value={m.promisedPaymentsDue} href={d("promisedPaymentsDue")} icon={<HandCoins />} />
            <Stat label="Admissions" value={m.admissionsAwaitingDecision} href={d("admissionsAwaitingDecision")} icon={<UserPlus />} hint="Awaiting decision" />
            <Stat label="Rejected slips" value={m.rejectedSlips} href={d("rejectedSlips")} icon={<XCircle />} />
          </div>
        </section>

        <div className="grid items-start gap-6 xl:grid-cols-[1.35fr_1fr]">
          <Card className="overflow-hidden">
            <CardHeader icon={<ClipboardCheck />} title="Oldest pending receipts" description={`${m.pendingSlips} waiting in your scope`}
              action={<Link href="/staff/review" className="u-draw inline-flex min-h-9 items-center gap-1 text-sm font-medium text-accent">Open workspace <ArrowRight className="size-4" /></Link>} />
            {queue.items.length === 0 ? (
              <div className="p-5"><EmptyState icon={<CalendarCheck />} title="Queue is clear">No receipts are waiting for review in your scope.</EmptyState></div>
            ) : (
              <ul className="divide-y divide-line">
                {queue.items.map((q) => {
                  const old = t - new Date(q.submittedAt).getTime() > STALE_MS;
                  return (
                    <li key={q.id}>
                      <Link href="/staff/review" className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-surface/60">
                        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface text-sm font-semibold text-ink-2">{q.studentName.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{q.studentName}</p>
                          <p className="truncate text-sm text-muted">{q.programmeName} · {q.periodLabel}</p>
                        </div>
                        <div className="text-right">
                          <Money minor={q.claimedMinor} strong />
                          <div className="mt-0.5 flex justify-end gap-1.5 text-xs text-muted">
                            {q.flags.length ? <Badge tone="warn">Check</Badge> : null}
                            {old ? <Badge tone="bad">48h+</Badge> : <span>{formatInstant(q.submittedAt)}</span>}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader icon={<Wallet />} title="Balances" description="Remaining obligations in your scope" />
            <div className="space-y-5 p-5">
              <div>
                <p className="text-sm text-muted">Outstanding (incl. future instalments)</p>
                <Link href={d("outstanding")} className="u-draw text-3xl font-semibold tracking-tight"><Money minor={m.outstandingMinor} /></Link>
              </div>
              <div className="flex h-3 overflow-hidden rounded-full bg-surface" aria-hidden>
                <div className="bg-bad" style={{ width: `${pct(m.overdueMinor)}%` }} />
                <div className="bg-warn" style={{ width: `${pct(dueNotOver)}%` }} />
                <div className="bg-accent/40" style={{ width: `${pct(future)}%` }} />
              </div>
              <dl className="space-y-2.5 text-sm">
                <Link href={d("overdue")} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-surface"><dt className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-bad" />Overdue</dt><dd><Money minor={m.overdueMinor} strong /></dd></Link>
                <Link href={d("dueNow")} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-surface"><dt className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-warn" />Due now (incl. overdue)</dt><dd><Money minor={m.dueNowMinor} strong /></dd></Link>
                <div className="flex items-center justify-between px-2 py-1.5"><dt className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-accent/40" />Not yet due</dt><dd><Money minor={future} /></dd></div>
              </dl>
              <Link href={d("studentsWithDues")} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2.5 text-sm hover:bg-line">
                <span className="flex items-center gap-2"><AlertOctagon className="size-4 text-bad" />Students with dues</span><span className="font-semibold">{m.studentsWithDues}</span>
              </Link>
            </div>
          </Card>
        </div>

        <section aria-labelledby="people-h">
          <h2 id="people-h" className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-muted">Students and programmes</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Stat label="Registered students" value={m.totalRegisteredStudents} href={d("totalRegisteredStudents")} icon={<Users />} />
            <Stat label="Active students" value={m.activeStudents} href={d("activeStudents")} icon={<GraduationCap />} hint={`${m.activeEnrolments} active enrolments`} />
            <Stat label="Free / sponsored" value={m.freeSponsorStudents} href={d("freeSponsorStudents")} icon={<ShieldAlert />} />
            <Stat label="Active programmes" value={m.activeProgrammes} href={d("activeProgrammes")} icon={<BookOpen />} />
            <Stat label="Decisions to date" value={`${m.historicalApprovals} / ${m.historicalRejections}`} icon={<ClipboardCheck />} hint="approved / rejected" />
          </div>
        </section>
        <p className="text-xs text-muted">Every figure opens the list it counts, using the same definition and your current scope. Generated {formatInstant(m.generatedAt)}.</p>
      </PageBody>
    </>
  );
}
