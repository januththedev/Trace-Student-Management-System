import Image from "next/image";
import { redirect } from "next/navigation";
import { AlertCircle, ArrowDown, ArrowUpRight, Bell, CalendarClock, CheckCircle2, Clock, CreditCard, FileText, Hourglass, PiggyBank, Receipt, Wallet } from "lucide-react";
import { currentStudent } from "@/server/auth/student";
import { studentDashboard } from "@/server/services/submissions";
import { Badge, Card, CardHeader, EmptyState, InstalmentBadge, Money, ReviewBadge, Stat } from "@/components/ui";
import { formatBizDate, formatInstant } from "@/lib/time";
import { formatMinor } from "@/lib/money";
import { StudentActions } from "./student-actions";
import { UploadReceipt } from "./upload-receipt";

export const dynamic = "force-dynamic";
export const metadata = { title: "My payments" };

export default async function StudentHome() {
  const p = await currentStudent();
  if (!p) redirect("/");
  const d = await studentDashboard(p);
  const s = d.ledger.summary;
  const open = d.ledger.instalments.filter((i) => i.remainingMinor > 0);
  const period = d.suggested?.periodLabel;
  const nextPeriod = period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
    ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "Asia/Colombo" }).format(new Date(`${period}-01T12:00:00Z`))
    : period;
  const banner = d.programme.bannerPath ?? "/banners/fallback.webp";
  const paidPct = s.netObligationMinor > 0 ? Math.min(100, Math.round((s.approvedAllocatedMinor / s.netObligationMinor) * 100)) : 100;

  return (
    <div className="min-h-dvh bg-bg">
      <meta name="csrf-token" content={p.csrfSecret} />
      <header className="on-dark relative isolate overflow-hidden bg-inv text-inv-ink">
        <Image src={banner} alt="" fill priority sizes="100vw" className="-z-10 object-cover opacity-30" />
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-r from-[#102e32] via-[#102e32]/90 to-[#102e32]/50" />
        <div className="mx-auto max-w-6xl px-4 pb-10 pt-5 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Image src={d.programme.logoPath ?? "/brand/t2t-logo.png"} alt="" width={30} height={30} className="rounded-md bg-white p-0.5" />
              <span className="text-sm font-semibold">T2T Student Portal</span>
            </div>
            <StudentActions />
          </div>
          <div className="mt-10 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#8fe3e9]">{d.programme.name} · {d.intake.label}</p>
              <p className="mb-2 mt-6 text-sm text-white/60">Your payment overview</p>
              <h1 className="display mt-1 text-3xl text-white sm:text-5xl">{d.student.name}</h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-inv-muted">
                <span>{d.student.nicMasked}</span><span aria-hidden>·</span><span>{d.student.ref}</span>
                <Badge tone={d.enrolmentStatus === "ACTIVE" ? "ok" : "neutral"} className="font-sans">{d.enrolmentStatus.toLowerCase()}</Badge>
              </p>
            </div>
            <div className="w-full max-w-xs rounded-lg border border-white/20 bg-[#102e32] p-5">
              <div className="flex items-baseline justify-between text-sm"><span className="text-inv-muted">Fees settled</span><span className="font-semibold text-white">{paidPct}%</span></div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-[#5fd0d8]" style={{ width: `${paidPct}%` }} /></div>
              <p className="mt-2 text-xs text-inv-muted"><Money minor={s.approvedAllocatedMinor} /> of <Money minor={s.netObligationMinor} /></p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-7 px-4 py-7 sm:px-6">
        <section aria-label="Your next payment" className="overflow-hidden rounded-xl border border-line bg-card shadow-xs">
          <div className="grid gap-6 p-5 sm:p-7 md:grid-cols-[1fr_auto] md:items-center">
            <div className="min-w-0">
              <p className="eyebrow mb-3 text-accent">{s.settled ? "Fee plan complete" : "Your next step"}</p>
              <h2 className="text-2xl tracking-tight sm:text-3xl">{s.settled ? "Your fee plan is settled." : d.suggested ? nextPeriod : "Your payment schedule"}</h2>
              {d.suggested && !s.settled ? <div className="mt-3 flex flex-wrap items-center gap-3 text-sm"><span className="inline-flex items-center gap-2 text-muted"><CalendarClock className="size-4" />Due {formatBizDate(d.suggested.dueDate)}</span><InstalmentBadge state={d.suggested.state} partial={d.suggested.allocatedMinor > 0 && d.suggested.remainingMinor > 0} /></div> : <p className="mt-2 text-sm text-muted">{s.settled ? "Your receipts and payment decisions are always available below." : "Check your instalment timeline for the full breakdown."}</p>}
              {d.suggested?.hasPendingEvidence ? <p className="mt-3 inline-flex items-start gap-2 text-sm text-warn"><Hourglass className="mt-0.5 size-4 shrink-0" />Evidence for this instalment is awaiting review. Its balance stays visible until approval.</p> : null}
            </div>
            <div className="min-w-0 md:border-l md:border-line md:pl-8">
              {d.suggested && !s.settled ? <><p className="mb-1 text-sm text-muted">Remaining on this instalment</p><p className="mb-4 text-[28px] font-semibold tracking-[-0.04em] sm:text-[34px]"><Money minor={d.suggested.remainingMinor} /></p></> : null}
              <a href={s.settled || d.enrolmentStatus !== "ACTIVE" ? "#hist-h" : "#pay-h"} className="btn inline-flex min-h-12 items-center justify-center gap-3 rounded-md bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-strong">{s.settled || d.enrolmentStatus !== "ACTIVE" ? <>View receipt history <ArrowDown className="size-4" /></> : <>Upload a receipt <ArrowUpRight className="size-4" /></>}</a>
            </div>
          </div>
          {s.creditMinor > 0 ? <div className="flex items-center gap-3 border-t border-line bg-accent-soft px-5 py-3 text-sm text-accent-strong sm:px-7"><PiggyBank className="size-4 shrink-0" /><p>You have <Money minor={s.creditMinor} strong /> credit on this course. Ask staff to apply it before making another transfer.</p></div> : null}
        </section>
        <section aria-labelledby="summary-h">
          <h2 id="summary-h" className="sr-only">Payment summary</h2>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-3">
            <Stat label="Outstanding" minor={s.outstandingMinor} icon={<Wallet />} />
            <Stat label="Overdue" minor={s.overdueMinor} tone={s.overdueMinor > 0 ? "bad" : undefined} icon={<AlertCircle />} />
            <Stat label="Approved payments" minor={s.approvedAllocatedMinor} tone="ok" icon={<CheckCircle2 />} />
            <Stat label="Pending review" minor={s.pendingClaimedMinor} tone={s.pendingClaimedMinor > 0 ? "warn" : undefined} icon={<Hourglass />} hint="Not counted as paid until approved" />
            <Stat label="Credit on this course" minor={s.creditMinor} icon={<PiggyBank />} />
            <Stat label="Total fees (net)" minor={s.netObligationMinor} icon={<CreditCard />} />
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-8 lg:contents">
            <section aria-labelledby="pay-h">
              <h2 id="pay-h" className="section-heading mb-4 scroll-mt-8">Upload a payment receipt</h2>
              {s.settled ? (
                <Card className="flex items-center gap-4 p-6"><span className="grid size-12 place-items-center rounded-full bg-ok-soft text-ok"><CheckCircle2 className="size-6" /></span>
                  <div><p className="font-semibold">All fees for this enrolment are settled.</p><p className="text-sm text-muted">There is nothing more to pay. Your receipt history is below.</p></div></Card>
              ) : d.enrolmentStatus !== "ACTIVE" ? (
                <Card className="p-6 text-sm text-muted">Uploads are closed for this enrolment.</Card>
              ) : (
                <UploadReceipt
                  suggestedId={d.suggested?.id ?? null}
                  creditMinor={s.creditMinor}
                  options={open.map((i) => ({ id: i.id, label: `${i.periodLabel} — due ${formatBizDate(i.dueDate)}`, remainingMinor: i.remainingMinor, pendingMinor: i.pendingClaimedMinor }))}
                  rejected={d.submissions.filter((x) => x.status === "REJECTED" && !d.submissions.some((y) => y.supersedesSubmissionId === x.id)).map((x) => ({ id: x.id, label: `${x.periodLabel} · ${formatMinor(x.claimedMinor)} · ${formatBizDate(x.transferDate)}` }))}
                />
              )}
            </section>

            <section aria-labelledby="plan-h" className="min-w-0 lg:col-span-2">
              <Card className="overflow-hidden">
                <CardHeader icon={<CalendarClock />} title={<span id="plan-h">Instalment timeline</span>} description="Settlement status is separate from receipt review status." />
                {d.ledger.instalments.length === 0 ? <p className="px-5 py-8 text-sm text-muted">No instalments have been set up for this enrolment yet.</p> : (
                  <table className="responsive-table w-full text-sm">
                    <thead className="bg-surface/70 text-left text-xs font-medium uppercase tracking-wide text-muted">
                      <tr><th className="px-5 py-3">Period</th><th className="px-3 py-3">Due</th><th className="px-3 py-3 text-right">Fee</th><th className="px-3 py-3 text-right">Adj. / exempt</th><th className="px-3 py-3 text-right">Paid</th><th className="px-3 py-3 text-right">Remaining</th><th className="px-5 py-3">Status</th></tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {d.ledger.instalments.map((i) => (
                        <tr key={i.id} className="hover:bg-surface/50">
                          <td data-label="Period" className="px-5 py-3.5"><span className="whitespace-nowrap font-medium">{i.periodLabel}</span>{i.hasPendingEvidence ? <Badge tone="warn" className="ml-2">Receipt pending</Badge> : null}</td>
                          <td data-label="Due" className="whitespace-nowrap px-3 py-3.5 text-muted">{formatBizDate(i.dueDate)}</td>
                          <td data-label="Fee" className="px-3 py-3.5 text-right"><Money minor={i.originalChargeMinor} /></td>
                          <td data-label="Adj. / exempt" className="px-3 py-3.5 text-right text-muted"><Money minor={i.adjustmentsMinor - i.exemptionsMinor} /></td>
                          <td data-label="Paid" className="px-3 py-3.5 text-right"><Money minor={i.allocatedMinor} /></td>
                          <td data-label="Remaining" className="px-3 py-3.5 text-right"><Money minor={i.remainingMinor} strong /></td>
                          <td data-label="Status" className="px-5 py-3.5"><InstalmentBadge state={i.state} partial={i.allocatedMinor > 0 && i.remainingMinor > 0} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </section>

            <section aria-labelledby="hist-h" className="min-w-0 lg:col-span-2">
              <h2 id="hist-h" className="section-heading mb-4 scroll-mt-8">Receipt history</h2>
              {d.submissions.length === 0 ? <EmptyState icon={<Receipt />} title="No receipts yet">Receipts you upload for this course will appear here with their review decisions.</EmptyState> : (
                <ul className="space-y-3">
                  {d.submissions.map((x) => (
                    <li key={x.id}>
                      <Card className="flex flex-wrap items-start gap-4 p-4">
                        {x.hasAsset ? (
                          <a href={`/api/student/submissions/${x.id}/evidence?v=original`} target="_blank" rel="noreferrer noopener" className="lift block size-20 shrink-0 overflow-hidden rounded-lg border border-line bg-surface">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/api/student/submissions/${x.id}/evidence`} alt={`Receipt for ${x.periodLabel}`} className="size-full object-cover" loading="lazy" />
                          </a>
                        ) : <span className="grid size-20 shrink-0 place-items-center rounded-lg border border-line bg-surface"><FileText className="size-6 text-muted" /></span>}
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">{x.periodLabel}</span>
                            <ReviewBadge status={x.status} />
                            {x.supersedesSubmissionId ? <Badge>Replacement</Badge> : null}
                            <span className="ml-auto text-base font-semibold tabular">{formatMinor(x.claimedMinor)}</span>
                          </div>
                          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted"><span>Transferred {formatBizDate(x.transferDate)}</span><span className="inline-flex items-center gap-1"><Clock className="size-3.5" />Sent {formatInstant(x.submittedAt)}</span></p>
                          {x.decisions.map((dcs, k) => (
                            <p key={k} className="rounded-md bg-surface/70 px-3 py-2 text-sm">
                              {dcs.kind === "APPROVE" ? <>Approved <Money minor={dcs.confirmedMinor ?? 0} strong /></> : dcs.kind === "REJECT" ? <>Not accepted: <span className="text-bad">{dcs.reason}</span></> : dcs.kind === "UNDO" ? "Decision withdrawn — back under review" : "Decision corrected — back under review"}
                              <span className="text-muted"> · {formatInstant(dcs.at)}</span>
                            </p>
                          ))}
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1">
            <Card className="overflow-hidden lg:sticky lg:top-6">
              <CardHeader icon={<Bell />} title="Notifications" description="Review outcomes for this course" />
              {d.notifications.length ? (
                <ul className="divide-y divide-line">{d.notifications.map((n) => (
                  <li key={n.id} className="px-5 py-3.5">
                    <p className="flex items-center gap-2 text-sm font-medium">{n.title}{!n.read ? <Badge tone="accent">New</Badge> : null}</p>
                    <p className="mt-0.5 text-sm text-muted">{n.body}</p>
                    <p className="mt-1 text-xs text-muted">{formatInstant(n.createdAt)}</p>
                  </li>))}</ul>
              ) : <p className="px-5 py-6 text-sm text-muted">No notifications yet.</p>}
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}
