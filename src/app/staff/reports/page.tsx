import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { currentStaff } from "@/server/auth/staff";
import { can, isSuper } from "@/server/auth/policy";
import {
  collectionRateReport, exemptionsReport, followUpOutcomes, outstandingAgeing, programmeIntakeTotals, receiptsByApprovalDate, receiptsByTransferDate, reviewThroughput,
} from "@/server/services/reports/reports";
import { Card, Money, EmptyState } from "@/components/ui";
import { Award, BookOpen, ClipboardCheck, Clock3, Percent, PhoneCall, Receipt } from "lucide-react";
import { addDays, businessDate, formatBizDate, isBizDate } from "@/lib/time";
import { PageHeader } from "../_shell/page-header";
import { ExportButtons } from "./export-buttons";
import { DateRange } from "./date-range";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted";
const td = "px-3 py-2";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const p = await currentStaff();
  if (!p) redirect("/staff/login");
  const sp = await searchParams;
  const today = businessDate();
  const to = sp.to && isBizDate(sp.to) ? sp.to : today;
  const from = sp.from && isBizDate(sp.from) && sp.from <= to ? sp.from : addDays(to, -29);
  const f = { from, to };
  const [rec, trf, ageing, rate, ex, totals, thr, fu] = await Promise.all([
    receiptsByApprovalDate(db(), p, f), receiptsByTransferDate(db(), p, f), outstandingAgeing(db(), p, { asOf: to }),
    collectionRateReport(db(), p, { asOf: to }), exemptionsReport(db(), p, f), programmeIntakeTotals(db(), p, { asOf: to }),
    reviewThroughput(db(), p, f), followUpOutcomes(db(), p, f),
  ]);

  return (
    <>
      <PageHeader title="Reports" sub={`Approved receipts (collections) — not accrual revenue. ${formatBizDate(from)} to ${formatBizDate(to)}, Asia/Colombo, LKR.`} />
      <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-end gap-6">
        <DateRange from={from} to={to} />
          {can(p, "exports.download") ? <ExportButtons key={`${from}:${to}:${isSuper(p)}`} from={from} to={to} allowFull={isSuper(p)} /> : <p className="text-sm text-muted">Report export needs the exports.download capability.</p>}
        </div>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base"><Percent className="size-4 text-accent" />Collection rate</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">Due through {formatBizDate(to)}</div><div className="mt-1 text-2xl font-medium">{rate.display}</div><div className="text-xs text-muted"><Money minor={rate.numeratorMinor} /> of <Money minor={rate.denominatorMinor} /></div></Card>
            <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">All-plan settled</div><div className="mt-1 text-xl"><Money minor={rate.settlement.approvedAllocatedMinor} /></div><div className="text-xs text-muted">of <Money minor={rate.settlement.netObligationMinor} /> net obligations</div></Card>
            <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">Unapplied credit</div><div className="mt-1 text-xl"><Money minor={rate.settlement.creditMinor} /></div><div className="text-xs text-muted">refunds are handled outside the system</div></Card>
          </div>
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base"><Receipt className="size-4 shrink-0 text-accent" />Approved receipts by approval date</h2>
          <Card className="overflow-hidden">
            <table role="table" className="responsive-table w-full text-sm">
              <caption className="sr-only">Approved receipts by approval date, in LKR</caption>
              <thead className="bg-surface"><tr><th className={th}>Date</th><th className={th}>Receipts</th><th className={th}>Gross approved</th><th className={th}>Corrections</th><th className={th}>Net</th></tr></thead>
              <tbody>
                {rec.rows.map((r) => <tr key={r.date} className="border-t border-line"><td data-label="Date" className={td}><span>{formatBizDate(r.date)}</span></td><td data-label="Receipts" className={td}><span>{r.receiptCount}</span></td><td data-label="Gross approved" className={td}><Money minor={r.receiptMinor} /></td><td data-label="Corrections" className={td}><Money minor={-r.correctionsMinor} /></td><td data-label="Net" className={td}><Money minor={r.netMinor} strong /></td></tr>)}
                <tr className="border-t-2 border-ink/30 bg-surface font-medium"><td data-label="Approval dates" className={td}><span>Total</span></td><td data-label="Receipts" className={td}><span>{rec.totals.receiptCount}</span></td><td data-label="Gross approved" className={td}><Money minor={rec.totals.receiptMinor} /></td><td data-label="Corrections" className={td}><Money minor={-rec.totals.correctionsMinor} /></td><td data-label="Net" className={td}><Money minor={rec.totals.netMinor} /></td></tr>
              </tbody>
            </table>
            {rec.rows.length === 0 ? <p className="p-4 text-sm text-muted">No approvals in this range.</p> : null}
          </Card>
          <p className="mt-2 text-xs text-muted">{trf.basisLabel}: net <Money minor={trf.totals.netMinor} /> across {trf.rows.length} transfer dates. Applying old credit is not counted as new collection.</p>
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base"><Clock3 className="size-4 shrink-0 text-accent" />Outstanding and ageing (as of {formatBizDate(to)})</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(["1-30", "31-60", "61-90", "91+"] as const).map((b) => <Card key={b} className="p-4"><div className="text-xs uppercase tracking-wide text-muted">{b} days overdue</div><div className="mt-1 text-lg"><Money minor={ageing.totals.buckets[b]} /></div></Card>)}
          </div>
          <p className="mt-2 text-sm">Outstanding <Money minor={ageing.totals.outstandingMinor} /> · due now <Money minor={ageing.totals.dueNowMinor} /> · overdue <Money minor={ageing.totals.overdueMinor} /></p>
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-base"><BookOpen className="size-4 text-accent" />Programme and intake totals</h2>
          {totals.length === 0 ? <EmptyState title="No programmes in scope" /> : (
            <Card className="overflow-hidden">
              <table role="table" className="responsive-table w-full text-sm">
                <caption className="sr-only">Programme and intake balances, in LKR</caption>
                <thead className="bg-surface"><tr><th className={th}>Programme / intake</th><th className={th}>Net obligation</th><th className={th}>Collected</th><th className={th}>Outstanding</th><th className={th}>Overdue</th><th className={th}>Credit</th></tr></thead>
                <tbody>{totals.map((r, i) => {
                  const row = r as unknown as Record<string, unknown>;
                  return <tr key={i} className="border-t border-line"><td data-label="Programme / intake" className={td}><span>{String(row.programmeCode ?? row.programmeName ?? "")}{row.intakeCode ? ` · ${String(row.intakeCode)}` : ""}</span></td><td data-label="Net obligation" className={td}><Money minor={Number(row.netObligationMinor ?? 0)} /></td><td data-label="Collected" className={td}><Money minor={r.collectedMinor} /></td><td data-label="Outstanding" className={td}><Money minor={r.outstandingMinor} /></td><td data-label="Overdue" className={td}><Money minor={r.overdueMinor} /></td><td data-label="Credit" className={td}><Money minor={r.creditMinor} /></td></tr>;
                })}</tbody>
              </table>
            </Card>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-3">
          <section><h2 className="mb-3 flex items-center gap-2 text-base"><Award className="size-4 text-accent" />Exemptions</h2><Card className="p-4 text-sm">
            {ex.byType.length ? ex.byType.map((t, i) => { const row = t as unknown as Record<string, unknown>; return <p key={i} className="flex justify-between"><span>{String(row.type)}</span><Money minor={t.activeMinor} /></p>; }) : <p className="text-muted">No awards in range.</p>}
            <p className="mt-2 text-xs text-muted">Waivers reduce obligations; they are never cash.</p></Card></section>
          <section><h2 className="mb-3 flex items-center gap-2 text-base"><ClipboardCheck className="size-4 text-accent" />Review throughput</h2><Card className="p-4 text-sm">
            {Object.keys(thr.totals).length ? Object.entries(thr.totals).map(([k, v]) => <p key={k} className="flex justify-between"><span>{k.toLowerCase()}</span><span className="font-mono">{v}</span></p>) : <p className="text-muted">No decisions in range.</p>}</Card></section>
          <section><h2 className="mb-3 flex items-center gap-2 text-base"><PhoneCall className="size-4 text-accent" />Follow-up outcomes</h2><Card className="p-4 text-sm">
            {fu.rows.length ? fu.rows.map((r) => <p key={r.outcome} className="flex justify-between"><span>{r.outcome.replace(/_/g, " ").toLowerCase()}</span><span className="font-mono">{r.count}</span></p>) : <p className="text-muted">No call attempts in range.</p>}</Card></section>
        </div>
      </main>
    </>
  );
}
