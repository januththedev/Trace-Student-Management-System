"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, newIdemKey } from "@/lib/client-api";
import { Alert, Badge, Button, EmptyState, Field, inputCls } from "@/components/ui";
import { Dialog, Select } from "@/components/ui/kit";
import { formatInstant } from "@/lib/time";
import type { listFeedback } from "@/server/services/support/feedback";

export type FeedbackData = Awaited<ReturnType<typeof listFeedback>>;
type Ticket = FeedbackData["items"][number];
export const STATUS_LABELS: Record<string, string> = { OPEN: "Sent", IN_REVIEW: "In review", PLANNED: "Planned", RESOLVED: "Resolved", CLOSED: "Closed" };
const AREAS = ["GENERAL", "STUDENTS", "ADMISSIONS", "PROGRAMMES", "RECEIPTS", "CALLS", "REPORTS", "IMPORTS", "TEAM", "TRASH", "STORAGE", "SUPPORT"];
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function FeedbackForm({ area, onSent }: { area: string; onSent: () => void }) {
  const [category, setCategory] = useState("IMPROVEMENT");
  const [selectedArea, setSelectedArea] = useState(area);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ payload: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const body = { category, area: selectedArea, title: String(form.get("title") ?? "").trim(), message: String(form.get("message") ?? "").trim() };
    const payload = JSON.stringify(body);
    if (pending.current?.payload !== payload) pending.current = { payload, key: newIdemKey() };
    setBusy(true); setError("");
    try { await api("/api/staff/support/feedback", { method: "POST", body, idempotencyKey: pending.current.key }); onSent(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not send your feedback. Please retry."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
    <div className="grid gap-4 sm:grid-cols-2"><Field htmlFor="feedback-kind" label="What would you like to send?"><Select id="feedback-kind" value={category} onValueChange={setCategory} disabled={busy} options={[{ value: "IMPROVEMENT", label: "Suggest an improvement" }, { value: "BUG", label: "Report a problem" }, { value: "QUESTION", label: "Ask a question" }]} /></Field>
      <Field htmlFor="feedback-area" label="Which area?"><Select id="feedback-area" value={selectedArea} onValueChange={setSelectedArea} disabled={busy} options={AREAS.map(value => ({ value, label: value === "GENERAL" ? "General / not sure" : titleCase(value) }))} /></Field></div>
    <Field htmlFor="feedback-title" label="Short title"><input id="feedback-title" name="title" required minLength={5} maxLength={120} disabled={busy} placeholder="For example: make the receipt queue easier to filter" className={inputCls} /></Field>
    <Field htmlFor="feedback-message" label="Tell us more"><textarea id="feedback-message" name="message" required minLength={10} maxLength={3000} disabled={busy} rows={5} className={`${inputCls} py-3`} placeholder="What were you trying to do? What happened, or what would make it easier?" /></Field>
    <p className="text-xs leading-relaxed text-muted">Include the steps and what you expected. Leave out student NICs, passwords and bank details. Your feedback is visible to you and Super Admins.</p>
    {error ? <Alert tone="bad">{error}</Alert> : null}
    <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send feedback"}</Button>
  </form>;
}

export function FeedbackPanel({ view, initial }: { view: "mine" | "all"; initial?: FeedbackData }) {
  const [data, setData] = useState<FeedbackData | undefined>(initial);
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = `/api/staff/support/feedback?view=${view}${status !== "all" ? `&status=${status}` : ""}`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(query, { cache: "no-store", credentials: "same-origin", signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? "Could not load feedback.");
      if (!controller.signal.aborted) setData(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load feedback."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, refresh]);
  function refreshList() { setLoading(true); setError(""); setRefresh(n => n + 1); }
  const ticket = data?.items.find(t => t.id === selected);
  async function loadMore() {
    if (!data?.nextCursor || moreBusy) return;
    setMoreBusy(true); setError("");
    try { const next = await api<FeedbackData>(`${query}&cursor=${encodeURIComponent(data.nextCursor)}`); if (mounted.current) setData(previous => previous ? { ...next, items: [...previous.items, ...next.items.filter(t => !previous.items.some(p => p.id === t.id))] } : next); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Could not load more feedback."); }
    finally { if (mounted.current) setMoreBusy(false); }
  }
  return <section aria-label={view === "all" ? "Feedback inbox" : "My feedback"} className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg">{view === "all" ? "Feedback from the team" : "Your feedback"}</h2><p className="mt-1 text-sm text-muted">{view === "all" ? "Review requests, keep the status clear and reply with the next step." : "Check the progress of your requests and read responses here."}</p></div>
      <label><span className="sr-only">Filter feedback status</span><Select aria-label="Filter feedback status" disabled={moreBusy} value={status} onValueChange={value => { setLoading(true); setError(""); setStatus(value); setSelected(null); }} options={[{ value: "all", label: "All statuses" }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))]} /></label></div>
    {error ? <Alert tone="bad">{error}<Button variant="ghost" onClick={refreshList}>Retry</Button></Alert> : null}
    {loading ? <div className="space-y-3" aria-label="Loading feedback"><div className="skeleton h-24" /><div className="skeleton h-24" /></div> : !data?.items.length ? <EmptyState title={view === "all" ? "No feedback in this view" : "No feedback yet"}>Use Send feedback to tell us what could work better.</EmptyState> : <div className="space-y-3">{data.items.map(t => <button key={t.id} onClick={() => setSelected(t.id)} className="lift block w-full rounded-xl border border-line bg-card p-5 text-left">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base">{t.title}</h3><Badge tone={t.status === "RESOLVED" ? "ok" : t.status === "PLANNED" ? "info" : "neutral"}>{STATUS_LABELS[t.status]}</Badge></div>
      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">{t.message}</p><p className="mt-3 text-xs text-muted">{titleCase(t.category)} · {titleCase(t.area)} · {formatInstant(t.createdAt)}{view === "all" ? ` · ${t.authorName}` : ""} · #{t.id.slice(0, 8).toUpperCase()}{t.replies.length ? ` · ${t.replies.length} response${t.replies.length === 1 ? "" : "s"}` : ""}</p>
    </button>)}</div>}
    {!loading && data?.nextCursor ? <Button variant="secondary" disabled={moreBusy} onClick={loadMore}>{moreBusy ? "Loading…" : "Load more feedback"}</Button> : null}
    <Dialog open={Boolean(ticket)} onOpenChange={open => { if (!open) setSelected(null); }} title={ticket?.title ?? "Feedback"} size="lg">
      {ticket ? <div className="space-y-4"><p className="text-xs text-muted">Reference #{ticket.id.slice(0, 8).toUpperCase()} · {STATUS_LABELS[ticket.status]} · {formatInstant(ticket.createdAt)}</p><p className="whitespace-pre-wrap text-sm leading-relaxed">{ticket.message}</p>
        {ticket.replies.map(reply => <div key={reply.id} className="rounded-lg border border-line bg-surface p-4"><p className="text-xs font-medium text-muted">{reply.authorName} · {formatInstant(reply.createdAt)}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{reply.message}</p></div>)}
        {data?.canManage && view === "all" ? <ReplyForm key={`${ticket.id}:${ticket.version}`} ticket={ticket} onSaved={refreshList} /> : null}
      </div> : null}
    </Dialog>
  </section>;
}

function ReplyForm({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const [status, setStatus] = useState(ticket.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const pending = useRef<{ payload: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const reply = String(new FormData(event.currentTarget).get("reply") ?? "").trim();
    const body = { expectedVersion: ticket.version, status, reply: reply || undefined };
    const payload = JSON.stringify(body);
    if (pending.current?.payload !== payload) pending.current = { payload, key: newIdemKey() };
    setBusy(true); setError(""); setSaved(false);
    try { await api(`/api/staff/support/feedback/${ticket.id}`, { method: "PATCH", body, idempotencyKey: pending.current.key }); setSaved(true); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the response."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-4 border-t border-line pt-4" aria-busy={busy}>
    <h3 className="text-base">Respond to this feedback</h3><Field htmlFor="feedback-status" label="Status"><Select id="feedback-status" value={status} onValueChange={setStatus} disabled={busy} options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} /></Field>
    <Field htmlFor="feedback-reply" label="Response (optional)"><textarea id="feedback-reply" name="reply" rows={3} maxLength={2000} className={`${inputCls} py-3`} disabled={busy} placeholder="Explain the next step or what has changed." /></Field>
    {error ? <Alert tone="bad">{error}</Alert> : null}{saved ? <p role="status" className="text-sm text-ok">Response saved.</p> : null}<Button disabled={busy}>{busy ? "Saving…" : "Save response"}</Button>
  </form>;
}
