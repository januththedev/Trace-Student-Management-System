"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, RefreshCw } from "lucide-react";
import { Alert, Button, inputCls } from "@/components/ui";
import { DatePicker, Dialog, Disclosure } from "@/components/ui/kit";
import { api, newIdemKey } from "@/lib/client-api";
import { formatBizDate } from "@/lib/time";

type Holiday = { day: string; label: string };
const endpoint = "/api/staff/calls/holidays";

export function Holidays({ initial }: { initial: Holiday[] }) {
  const [holidays, setHolidays] = useState(initial);
  const [day, setDay] = useState("");
  const [label, setLabel] = useState("");
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const keys = useRef(new Map<string, string>());
  const router = useRouter();
  const existing = holidays.find(holiday => holiday.day === day);

  async function refresh() {
    setBusy(true); setError("");
    try { setHolidays(await api<Holiday[]>(endpoint)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function save(remove?: Holiday) {
    if (!remove && (!day || !label.trim())) { setError("Choose a date and enter a holiday name."); return; }
    const body = remove
      ? { day: remove.day, label: remove.label, expectedLabel: remove.label }
      : { day, label: label.trim(), expectedLabel: existing?.label ?? null };
    const signature = JSON.stringify({ body, remove: Boolean(remove) });
    const key = keys.current.get(signature) ?? newIdemKey();
    keys.current.set(signature, key);
    setBusy(true); setError(""); setNotice("");
    try {
      await api(endpoint, { method: remove ? "DELETE" : "POST", body, idempotencyKey: key });
      keys.current.delete(signature);
      setRemoving(null); setDay(""); setLabel("");
      setNotice(remove ? "Holiday removed." : "Holiday saved.");
      setHolidays(await api<Holiday[]>(endpoint));
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(); }

  return <section className="mt-8 rounded-xl border border-line bg-card p-5 shadow-xs">
    <Disclosure title={<><CalendarDays aria-hidden="true" className="size-4 text-accent" />Business holidays</>}>
      <p className="mb-5 text-sm leading-6 text-muted">Working-day calculations skip these dates. Manage the calendar in Asia/Colombo; call history is retained.</p>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">{holidays.length} {holidays.length === 1 ? "holiday" : "holidays"}</p>
        <Button variant="secondary" onClick={() => void refresh()} disabled={busy}><RefreshCw aria-hidden="true" className="size-4" />Refresh holidays</Button>
      </div>
      {error && <div className="mb-4"><Alert tone="bad">{error} Refresh holidays if another staff member changed the calendar.</Alert></div>}
      {notice && <p role="status" className="mb-4 rounded-lg bg-ok-soft p-3 text-sm text-ok">{notice}</p>}
      {holidays.length ? <ul className="mb-6 divide-y divide-line">{holidays.map(holiday => <li key={holiday.day} className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0"><p className="break-words text-sm font-medium">{holiday.label}</p><p className="mt-1 text-xs text-muted">{formatBizDate(holiday.day)}</p></div>
        <Button variant="secondary" disabled={busy} onClick={() => setRemoving(holiday)} aria-label={`Remove ${holiday.label}`}>Remove</Button>
      </li>)}</ul> : <p className="mb-6 rounded-lg bg-bg p-4 text-sm text-muted">No holidays added. Standard working weekdays still apply.</p>}
      <form onSubmit={submit} aria-busy={busy} className="grid items-end gap-4 sm:grid-cols-[200px_1fr_auto]">
        <div><label htmlFor="holiday-day" className="mb-2 block text-sm font-medium">Holiday date</label><DatePicker id="holiday-day" value={day} onChange={value => { setDay(value); setLabel(holidays.find(holiday => holiday.day === value)?.label ?? ""); }} required /></div>
        <div><label htmlFor="holiday-label" className="mb-2 block text-sm font-medium">Holiday name</label><input id="holiday-label" value={label} onChange={event => setLabel(event.target.value)} maxLength={2000} required className={inputCls} placeholder="e.g. Public holiday" /></div>
        <Button type="submit" disabled={busy || !day || !label.trim()}>{busy ? "Saving…" : existing ? "Update holiday" : "Add holiday"}</Button>
      </form>
    </Disclosure>
    <Dialog open={Boolean(removing)} onOpenChange={open => { if (!open && !busy) setRemoving(null); }} title="Remove holiday">
      <p className="my-4 text-sm leading-6">Remove {removing?.label} from the business calendar? This date will use the standard working-weekday policy.</p>
      {error && <div className="mb-4"><Alert tone="bad">{error}</Alert></div>}
      <div className="flex justify-end gap-3"><Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => { if (removing) void save(removing); }}>{busy ? "Removing…" : "Remove holiday"}</Button></div>
    </Dialog>
  </section>;
}
