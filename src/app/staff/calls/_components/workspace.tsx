"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { CalendarClock, CheckCircle2, ClipboardList, History, ListChecks, MessageSquare, Phone, RefreshCw } from "lucide-react";
import { Alert, Button, EmptyState, inputCls } from "@/components/ui";
import { Select as KitSelect } from "@/components/ui/kit";
import { Check, Input, Select } from "../../students/form-parts";
import type { CallCard } from "@/server/services/followups/queue";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import { formatInstant } from "@/lib/time";

type Serialized<T> = T extends Date ? string : T extends readonly (infer U)[] ? Serialized<U>[] : T extends object ? { [K in keyof T]: Serialized<T[K]> } : T;
type Card = Serialized<CallCard>;
type Queue = { items: Card[]; nextCursor: string | null; refreshedAt: string };
const outcomes = ["NO_ANSWER", "ANSWERED", "PROMISED_TO_PAY", "ALREADY_PAID", "NEEDS_ASSISTANCE", "NOT_CONTINUING", "FREE_CARD_SPONSORED", "WRONG_NUMBER", "CORRECTION"] as const;
type Outcome = typeof outcomes[number];
const label = (s: string) => s.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
const button = "btn inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-card px-3 py-2 text-sm font-medium text-ink shadow-xs hover:border-line-strong hover:bg-surface disabled:opacity-50";
const inputClass = `${inputCls} mt-1 py-2`;
function subscribeOnline(callback: () => void) { window.addEventListener("online", callback); window.addEventListener("offline", callback); return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; }
async function request<T>(url: string, payload?: unknown, key?: string): Promise<T> {
  const response = await fetch(url, payload ? { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "", "Idempotency-Key": key ?? crypto.randomUUID() }, body: JSON.stringify(payload), cache: "no-store" } : { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "The request failed. Try again.");
  return body;
}
export function CallWorkspace({ initial }: { initial: Queue }) {
  const [queue, setQueue] = useState(initial); const [selected, setSelected] = useState<string | null>(initial.items[0]?.id ?? null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [detail, setDetail] = useState<Card | null>(null); const [outcome, setOutcome] = useState<Outcome | null>(null);
  const refresh = useCallback(async () => {
    try { const data = await request<Queue>("/api/staff/calls"); setQueue(data); setError(""); if (selected) setDetail(await request<Card>(`/api/staff/calls/${selected}`)); }
    catch (e) { setError((e as Error).message); }
  }, [selected]);
  useEffect(() => {
    const focus = () => { void refresh(); }; const connection = () => { void refresh(); };
    window.addEventListener("focus", focus); window.addEventListener("online", connection);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("online", connection); };
  }, [refresh]);
  async function choose(id: string) { setSelected(id); setOutcome(null); setBusy(true); try { setDetail(await request<Card>(`/api/staff/calls/${id}`)); setError(""); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  const card = detail?.id === selected ? detail : queue.items.find(c => c.id === selected);
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">Updated {formatInstant(queue.refreshedAt)} · Asia/Colombo · Contact hours 09:00–17:00</p><button className={button} onClick={() => void refresh()}><RefreshCw className="size-4" />Refresh</button></div>
    {!online && <Alert tone="warn">Offline. Reconnect before saving an outcome.</Alert>}
    {error && <Alert tone="bad">{error}</Alert>}
    <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
      <section aria-label="Enrolment call queue" className="min-w-0 space-y-3 xl:sticky xl:top-22 xl:max-h-[calc(100dvh-6.5rem)] xl:self-start xl:overflow-y-auto xl:pr-1">
        {queue.items.length > 0 && <div className="xl:hidden"><label htmlFor="call-enrolment" className="mb-1.5 block text-sm font-medium text-ink-2">Enrolment call queue</label><KitSelect id="call-enrolment" value={selected ?? ""} onValueChange={id => void choose(id)} options={queue.items.map(c=>({value:c.id,label:c.name,hint:`${formatMinor(c.ledger.summary.dueNowMinor)} due · ${c.programme}`}))} /></div>}
        <div className={queue.items.length ? "hidden space-y-3 xl:block" : "space-y-3"}>
        {!queue.items.length && <EmptyState icon={<CheckCircle2 />} title="No collectible cards in this batch.">All due obligations may be settled or held for review.</EmptyState>}
        {queue.items.map(c => <button key={c.id} onClick={() => void choose(c.id)} aria-pressed={selected === c.id} className={`btn w-full rounded-xl border p-4 text-left focus-visible:outline-2 focus-visible:outline-teal-700 ${selected === c.id ? "border-accent bg-accent-soft shadow-xs" : "border-line bg-card"}`}><span className="block font-semibold">{c.name}</span><span className="mt-1 block text-sm text-muted">{c.programme} · {c.intake}</span><span className="mt-3 block whitespace-nowrap text-lg font-semibold tabular">{formatMinor(c.ledger.summary.dueNowMinor)} due</span><span className="mt-1 block text-sm text-muted">{c.flags.join(" · ") || (c.deferred ? "Follow-up scheduled / paused" : "Ready for follow-up")}</span></button>)}
        </div>
        {queue.nextCursor && <button disabled={busy} className={`${button} w-full`} onClick={async () => { setBusy(true); try { const next = await request<Queue>(`/api/staff/calls?cursor=${queue.nextCursor}`); setQueue(q => ({ ...next, items: [...q.items, ...next.items] })); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>Load more enrolments</button>}
      </section>
      <section aria-label="Selected enrolment" aria-busy={busy} className="min-w-0 rounded-xl border border-line bg-card p-4 shadow-xs md:p-6">
        {!card ? <EmptyState icon={<Phone />} title="Select an enrolment">Select a card to view the account and record an outcome.</EmptyState> : <>
          <h2 className="text-xl font-semibold sm:text-2xl">{card.name}</h2><p className="mt-1 text-muted">{card.programme} · {card.intake}</p>
          <div className="my-5 grid grid-cols-2 gap-3"><Metric label="Outstanding" value={card.ledger.summary.outstandingMinor} /><Metric label="Overdue" value={card.ledger.summary.overdueMinor} /><Metric label="Pending claims" value={card.ledger.summary.pendingClaimedMinor} /><Metric label="Collectible due" value={card.dueInstalments.reduce((s, i) => s + i.remainingMinor, 0)} /></div>
          {card.phone && !card.flags.length && card.callable ? <a className={`${button} inline-flex items-center bg-accent-soft`} href={`tel:${card.phone}`}>Open dialer: {card.phone}</a> : <p className="rounded-lg bg-warn-soft p-3 text-warn">{card.flags.join(" · ") || (!card.eligible ? "No collectible due balance." : !card.windowOpen ? "Outside contact hours." : "Follow-up is deferred or paused.")} {card.phone}</p>}
          <p className="mt-2 text-xs text-muted">Opening the dialer is not proof of a call. Save the outcome explicitly.</p>
          <h3 className="mb-2 mt-6 flex items-center gap-2 text-[15px] font-semibold"><CalendarClock className="size-4 text-accent" />Due instalments</h3><ul className="divide-y divide-line">{card.ledger.instalments.filter(i => i.remainingMinor > 0).map(i => <li key={i.id} className="flex flex-wrap justify-between gap-2 py-3"><span>{i.periodLabel} <span className="text-sm text-muted">{i.dueDate}</span>{i.hasPendingEvidence && <span className="ml-2 rounded bg-warn-soft px-2 py-1 text-xs text-warn">Evidence held for review</span>}</span><strong className="whitespace-nowrap tabular">{formatMinor(i.remainingMinor)}</strong></li>)}</ul>
          {card.latestPromise && <div className="mt-5 rounded-lg bg-surface p-4"><span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-white">{label(card.latestPromise.state)}</span><p className="mt-2">{formatMinor(card.latestPromise.amountMinor)} promised by {card.latestPromise.promisedDate} · {formatMinor(card.latestPromise.fulfilledMinor)} fulfilled</p>{card.latestPromise.stateReason && <p className="mt-1 text-sm">{card.latestPromise.stateReason}</p>}</div>}
          <h3 className="mb-3 mt-6 flex items-center gap-2 text-[15px] font-semibold"><MessageSquare className="size-4 text-accent" />Record an outcome</h3><div className="flex flex-wrap gap-2">{outcomes.map(o => <button key={o} className={button} disabled={!online || busy || o !== "CORRECTION" && (!card.eligible || !!card.flags.length)} onClick={() => setOutcome(o)}>{label(o)}</button>)}</div>
          {outcome && <OutcomeForm key={`${card.id}:${outcome}`} card={card} outcome={outcome} online={online} onCancel={() => setOutcome(null)} onSaved={async () => { setOutcome(null); await refresh(); }} />}
          <h3 className="mb-2 mt-7 flex items-center gap-2 text-[15px] font-semibold"><ListChecks className="size-4 text-accent" />Open tasks</h3>{!card.openTasks.length && <p className="text-sm text-muted">No open tasks.</p>}{card.openTasks.map(task => <TaskRow key={`${task.id}:${task.version}`} task={task} online={online} refresh={refresh} />)}
          <h3 className="mb-2 mt-7 flex items-center gap-2 text-[15px] font-semibold"><History className="size-4 text-accent" />Contact history</h3>{!card.contactHistory.length && <p className="text-sm text-muted">No recorded calls.</p>}<ol className="space-y-3 border-l-2 border-line pl-4">{card.contactHistory.map(h => <li key={h.id}><p className="font-semibold">{label(h.outcome)} <time className="text-xs font-normal text-muted">{formatInstant(h.createdAt)}</time></p><p className="whitespace-pre-wrap text-sm text-ink-2">{h.notes}</p>{h.correctsAttemptId && <p className="text-xs">Appended correction to an earlier attempt.</p>}</li>)}</ol>
        </>}
      </section>
    </div>
  </>;
}
function Metric({ label: text, value }: { label: string; value: number }) { return <div className="min-w-0 rounded-lg border border-line bg-surface/50 p-3 sm:p-4"><p className="text-xs font-medium text-muted">{text}</p><p className="mt-1 whitespace-nowrap text-base font-semibold tabular sm:text-lg">{formatMinor(value)}</p></div>; }
function OutcomeForm({ card, outcome, online, onCancel, onSaved }: { card: Card; outcome: Outcome; online: boolean; onCancel: () => void; onSaved: () => Promise<void> }) {
  const form = useRef<HTMLFormElement>(null); const [error, setError] = useState(""); const [saving, setSaving] = useState(false); const [result, setResult] = useState<{ pointer: string | null; warning: string | null; submissions: { id: string; status: string; claimedMinor: number }[] } | null>(null);
  const pending = useRef<{ serialized: string; key: string } | null>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>("textarea,input,select,button")?.focus(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!navigator.onLine) return setError("Reconnect before saving.");
    const fields = new FormData(event.currentTarget); const text = (key: string) => String(fields.get(key) ?? "").trim();
    const body: Record<string, unknown> = { enrolmentId: card.id, expectedVersion: card.version, expectedStudentVersion: card.studentVersion, outcome, notes: text("notes") };
    if (text("manualOverrideReason")) body.manualOverrideReason = text("manualOverrideReason");
    if (outcome === "ANSWERED") { body.resolved = text("resolved") === "yes"; if (!body.resolved) { body.nextAction = text("nextAction"); body.nextDate = text("nextDate"); } }
    if (outcome === "PROMISED_TO_PAY") { body.amountMinor = parseMajorToMinor(text("amount")); body.promisedDate = text("promisedDate"); body.targetInstalmentIds = fields.getAll("targets"); }
    if (outcome === "NEEDS_ASSISTANCE") { body.category = text("category"); body.reason = text("reason"); body.priority = Number(text("priority")); body.dueDate = text("dueDate"); }
    if (outcome === "CORRECTION") body.correctsAttemptId = text("correctsAttemptId");
    const serialized = JSON.stringify(body);
    if (!pending.current || pending.current.serialized !== serialized) pending.current = { serialized, key: crypto.randomUUID() };
    body.clientAttemptId = pending.current.key;
    setSaving(true); setError("");
    try { const response = await request<NonNullable<typeof result>>("/api/staff/calls/attempts", body, pending.current.key); setResult(response); }
    catch(e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  const field = (name: string, title: string, type = "text", required = true) => <Input name={name} label={title} type={type} required={required} />;
  if (result) return <div className="mt-4 rounded-xl bg-accent-soft p-4" role="status"><p className="font-semibold">Outcome saved.</p>{result.warning && <p className="mt-2 text-warn">{result.warning}</p>}{result.pointer && <a className={`${button} mt-3 inline-flex items-center`} href={result.pointer}>Open {outcome === "NOT_CONTINUING" ? "withdrawal preview" : "exemption workflow"}</a>}{outcome === "ALREADY_PAID" && <><p className="mt-2">Verification task created. The balance has not changed.</p>{result.submissions.map(s => <p key={s.id}>{label(s.status)} · {formatMinor(s.claimedMinor)}</p>)}{!result.submissions.length && <p>No submissions yet. Request payment evidence from the student.</p>}</>}<button className={`${button} ml-2 mt-3`} onClick={() => void onSaved()}>Done and refresh</button></div>;
  return <form ref={form} onSubmit={submit} className="mt-4 space-y-4 rounded-xl border border-accent/30 bg-accent-soft p-4" aria-label={`${label(outcome)} outcome`}><h4 className="flex items-center gap-2 font-semibold"><ClipboardList className="size-4 text-accent" />{label(outcome)}</h4>
    <label className="block text-sm font-medium">Notes<textarea name="notes" maxLength={2000} required={["ANSWERED", "PROMISED_TO_PAY", "CORRECTION"].includes(outcome)} className={inputClass} rows={3} /></label>
    {outcome === "ANSWERED" && <><Select name="resolved" label="Next step" initial="yes" options={[{value:"yes",label:"Resolved — no follow-up"},{value:"no",label:"Schedule a next action"}]} />{field("nextAction", "Next action (when unresolved)", "text", false)}{field("nextDate", "Next action date (when unresolved)", "date", false)}</>}
    {outcome === "PROMISED_TO_PAY" && <>{field("amount", "Promised amount (LKR)")}{field("promisedDate", "Promised local date", "date")}<fieldset><legend className="text-sm font-medium">Target instalments</legend>{card.ledger.instalments.filter(i => i.remainingMinor > 0).map(i => <Check key={i.id} name="targets" value={i.id} checked={card.dueInstalments.some(d => d.id === i.id)} label={`${i.periodLabel} · ${formatMinor(i.remainingMinor)}`} />)}</fieldset><p className="text-sm">A promise does not change the balance. Amounts above current due will show a warning.</p></>}
    {outcome === "NEEDS_ASSISTANCE" && <>{field("category", "Category")}{field("reason", "Reason")}{field("dueDate", "Due date", "date")}<Select name="priority" label="Priority" initial="2" options={[{value:"2",label:"Normal"},{value:"1",label:"High"},{value:"3",label:"Low"}]} /><p className="text-sm">This assistance task will be assigned to you.</p></>}
    {outcome === "CORRECTION" && <Select name="correctsAttemptId" label="Original attempt" required options={card.contactHistory.map(a=>({value:a.id,label:`${label(a.outcome)} · ${formatInstant(a.createdAt)}`}))} />}
    {outcome === "NOT_CONTINUING" && <p className="text-sm">Save this outcome to open the withdrawal preview. Withdrawal requires its own confirmation.</p>}
    {outcome === "FREE_CARD_SPONSORED" && <p className="text-sm">Save to open exemptions, or request approval when you do not have permission.</p>}
    {field("manualOverrideReason", "Manual contact override reason (only when needed)", "text", false)}
    {error && <p role="alert" className="text-sm font-semibold text-bad">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={saving || !online} type="submit">{saving ? "Saving…" : "Save outcome"}</Button><button disabled={saving} className={button} type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
function TaskRow({ task, online, refresh }: { task: Card["openTasks"][number]; online: boolean; refresh: () => Promise<void> }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [closing, setClosing] = useState(false); const key = useRef(crypto.randomUUID());
  async function mutate(action: "lease" | "close", reason?: string) { setBusy(true); try { await request(`/api/staff/calls/tasks/${task.id}/${action}`, { expectedVersion: task.version, ...(reason ? { reason } : {}) }, key.current); await refresh(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="my-2 rounded-lg border border-line p-3"><p className="font-semibold">{label(task.type)} · {formatInstant(task.dueAt)}</p><p className="text-sm">{task.reason}</p>{task.ownerId && <p className="text-xs text-muted">Assigned · {task.leaseExpiresAt ? `Lease ends ${formatInstant(task.leaseExpiresAt)}` : "No active lease"}</p>}<div className="mt-2 flex flex-wrap gap-2"><button className={button} disabled={!online || busy} onClick={() => void mutate("lease")}>Assign to me · 5 min</button><button className={button} disabled={!online || busy} onClick={() => setClosing(!closing)}>Close task</button></div>{closing && <form className="mt-3" onSubmit={e => { e.preventDefault(); void mutate("close", String(new FormData(e.currentTarget).get("reason"))); }}><label className="text-sm">Closure reason<input name="reason" className={inputClass} required maxLength={2000} /></label><button className={`${button} mt-2`} disabled={!online || busy}>Confirm close</button></form>}{error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}</div>;
}
