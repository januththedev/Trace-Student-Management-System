"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { listTrash, TrashKind } from "@/server/services/trash";
import { Checkbox, Dialog, Select } from "@/components/ui/kit";
import { EmptyState, inputCls } from "@/components/ui";
import { ArchiveRestore, History, Trash2 } from "lucide-react";
import { postStaff } from "../login/request";

type TrashData = Awaited<ReturnType<typeof listTrash>>;
type Selection = { kind: TrashKind; id: string; label: string; version: number; action: "trash" | "restore" | "restore-as-admin" };
const inputClass = inputCls;
const buttonClass = "btn min-h-11 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink hover:bg-bg focus-visible:ring-4 focus-visible:ring-accent/30 disabled:opacity-50";
function countdown(seconds: number) {
  if (seconds <= 0) return "Restore window closed";
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h remaining` : hours ? `${hours}h ${minutes}m remaining` : "Less than 1 hour remaining";
}

function Confirm({ selected, onClose, onSaved }: { selected: Selection; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [confirmed, setConfirmed] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    try { await postStaff("/api/staff/trash", { kind: selected.kind, id: selected.id, version: selected.version, action: selected.action, reason: new FormData(e.currentTarget).get("reason") }); onSaved(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title={selected.action === "trash" ? "Move to Trash" : selected.action === "restore-as-admin" ? "Restore with the Admin role" : "Restore record"}><p className="my-4 font-semibold">{selected.label}</p><p className="mb-5 text-sm leading-6 text-muted">{selected.action === "trash" ? "This record will be unavailable immediately. You will have 30 days to restore it. Existing financial history stays available." : selected.action === "restore-as-admin" ? "Confirm that this staff member should return as an Admin, with their retained assignments. They will need to sign in again. This role change will be audited." : selected.kind === "staff" ? "Restore this staff member with the previous role. Super Admin capacity will be checked again. Old sessions remain revoked." : "Restore the retained settings and banner. Independently trashed intakes remain in Trash."}</p>
    <form onSubmit={submit} className="space-y-4" aria-busy={busy}><label className="block text-sm font-semibold">Reason<textarea name="reason" required maxLength={1000} className={`${inputClass} mt-2 min-h-24 py-3`} /></label>{selected.action === "restore-as-admin" && <Checkbox id="confirm-restore-admin" checked={confirmed} onCheckedChange={setConfirmed} required label="I confirm restoration as Admin." />}{error && <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">{error}</p>}<div className="flex justify-end gap-3"><button type="button" onClick={onClose} disabled={busy} className={buttonClass}>Cancel</button><button disabled={busy} className="btn min-h-11 rounded-lg bg-accent px-5 font-semibold text-inv-ink focus-visible:ring-4 focus-visible:ring-accent/30 disabled:opacity-50">{busy ? "Saving…" : "Confirm"}</button></div></form>
  </Dialog>;
}

export default function TrashClient({ data }: { data: TrashData }) {
  const [selected, setSelected] = useState<Selection | null>(null); const [notice, setNotice] = useState(""); const [candidate, setCandidate] = useState(""); const router = useRouter();
  // Periodic server refresh updates both the countdown and the authoritative restore action.
  useEffect(() => { const timer = window.setInterval(() => router.refresh(), 30000); return () => clearInterval(timer); }, [router]);
  function saved() { setSelected(null); setNotice("The change has been recorded."); router.refresh(); }
  return <div className="space-y-6">
    <section className="rounded-lg border border-line bg-card p-5"><h2 className="flex items-center gap-2 text-[15px] font-semibold"><Trash2 className="size-4 text-accent" />Move a programme or intake to Trash</h2><div className="mt-4 flex flex-col gap-3 sm:flex-row"><div className="min-w-0 flex-1"><Select aria-label="Choose a programme or intake" value={candidate} onValueChange={setCandidate} options={[{value:"",label:"Choose a record…"},...data.candidates.map(c=>({value:c.id,label:`${c.kind === "programme" ? "Programme" : "Intake"} · ${c.label}`}))]} /></div><button disabled={!candidate} className={buttonClass} onClick={() => { const c = data.candidates.find(c => c.id === candidate); if (c) setSelected({ ...c, action: "trash" }); }}>Move to Trash</button></div><p className="mt-3 text-sm text-muted">Manage staff Trash from the Team page.</p></section>
    {notice && <p role="status" className="rounded-lg bg-accent-soft p-4 text-ink">{notice}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold">In Trash <span className="font-normal text-muted">({data.records.length})</span></h2><button className={buttonClass} onClick={() => router.refresh()}>Refresh countdowns</button></div>
    {!data.records.length ? <EmptyState icon={<ArchiveRestore />} title="Trash is empty">Records moved here can be restored for 30 days.</EmptyState> : <div className="grid gap-4 lg:grid-cols-2">{data.records.map(r => <article key={`${r.kind}:${r.id}`} className="rounded-lg border border-line bg-card p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-muted">{r.kind}</p><h3 className="mt-2 break-words text-lg font-semibold">{r.label}</h3></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${r.purgeStatus === "FAILED" ? "bg-bad-soft text-bad" : "bg-surface text-muted"}`}>{r.purgeStatus === "FAILED" ? "Cleanup needs attention" : r.purgeStatus === "PURGED" ? "Retained tombstone" : "In Trash"}</span></div><p className="mt-4 text-sm font-semibold text-accent-strong">{countdown(r.remainingSeconds)}</p>{r.purgeAfter && <p className="mt-1 text-xs text-muted">Restore before {new Date(r.purgeAfter).toLocaleString("en-GB", { timeZone: "Asia/Colombo" })} (Colombo)</p>}{r.reason && <p className="mt-3 break-words text-sm text-muted">Reason: {r.reason}</p>}{r.canRestore && <div className="mt-5 flex flex-wrap gap-2"><button className={buttonClass} onClick={() => setSelected({ ...r, action: "restore" })}>Restore</button>{r.kind === "staff" && r.role === "SUPER_ADMIN" && <button className={buttonClass} onClick={() => setSelected({ ...r, action: "restore-as-admin" })}>Restore as Admin…</button>}</div>}</article>)}</div>}
    <section className="rounded-lg border border-line bg-card p-5"><h2 className="flex items-center gap-2 text-[15px] font-semibold"><History className="size-4 text-accent" />Recent retention jobs</h2>{!data.jobs.length ? <p className="mt-3 text-sm text-muted">No retention jobs have run yet.</p> : <ul className="mt-3 divide-y divide-line">{data.jobs.map(j => <li key={j.id} className="py-3 text-sm"><p className="font-medium">{j.status === "SUCCEEDED" ? "Completed" : j.status === "FAILED" ? "Needs attention" : "Running"} · {j.processed} records processed</p><p className="mt-1 text-muted">{new Date(j.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Colombo" })}</p>{j.error && <p className="mt-2 text-bad">{j.error}</p>}</li>)}</ul>}</section>
    <p className="text-xs text-muted">Countdowns checked at {new Date(data.serverNow).toLocaleTimeString("en-GB", { timeZone: "Asia/Colombo" })} (Colombo). Financial and operational history is retained.</p>
    {selected && <Confirm selected={selected} onClose={() => setSelected(null)} onSaved={saved} />}
  </div>;
}
