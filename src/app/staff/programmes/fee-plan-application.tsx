"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Money, inputCls } from "@/components/ui";
import { Checkbox, Disclosure } from "@/components/ui/kit";
import { ApiError, api, newIdemKey } from "@/lib/client-api";
import type { feePlanCandidates, previewFeePlan } from "@/server/services/fee-plan-application";

type Candidates = Awaited<ReturnType<typeof feePlanCandidates>>;
type Preview = Awaited<ReturnType<typeof previewFeePlan>>;
const url = "/api/staff/fee-plan-application";

export function FeePlanApplication({ versionId }: { versionId: string }) {
  const router = useRouter();
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [key, setKey] = useState<string | null>(null);
  async function load(more = false) {
    setBusy(true); setError("");
    try {
      const r = await api<Candidates>(`${url}?${new URLSearchParams({ versionId, ...(more && candidates?.nextCursor ? { after: candidates.nextCursor } : {}) })}`);
      setCandidates(old => more && old ? { ...r, items: [...old.items, ...r.items] } : r);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load enrolments."); }
    finally { setBusy(false); }
  }
  async function makePreview() {
    setBusy(true); setError(""); setNotice(""); setPreview(null);
    try { setPreview(await api<Preview>(url, { method: "POST", body: { action: "preview", versionId, enrolmentIds: selected } })); setKey(newIdemKey()); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not preview the changes."); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || !key) return;
    setBusy(true); setError("");
    try {
      await api(url, { method: "POST", idempotencyKey: key, body: { action: "apply", versionId, reason, selections: preview.rows.map(row => ({ enrolmentId: row.enrolmentId, previewHash: row.previewHash })) } });
      setNotice(`Fee changes applied to ${preview.rows.length} selected enrolments.`); setPreview(null); setSelected([]); setCandidates(null); setReason(""); setKey(null); router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE") { setPreview(null); setKey(null); }
      setError(e instanceof Error ? e.message : "Could not apply changes. Preview again if the financial details changed.");
    }
    finally { setBusy(false); }
  }
  return <Disclosure title="Apply fee amounts to existing enrolments" triggerClassName="min-h-11 text-sm font-medium">
    <div className="space-y-4 py-3" aria-busy={busy}>
      <p className="text-sm leading-6 text-muted">Future enrolments use this version automatically. Existing students change only after you select them, review each instalment and confirm. Individual adjustments and exemptions remain. Dates, components, sequence and period labels must match exactly; structural changes require separate schedule correction.</p>
      {!candidates ? <Button variant="secondary" disabled={busy} onClick={() => load()}>Choose existing enrolments</Button> : <>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line p-3">
          {!candidates.items.length ? <p className="p-2 text-sm text-muted">No active enrolments in this intake.</p> : candidates.items.map(item => {
            const id = `fee-${versionId}-${item.id}`;
            const checked = selected.includes(item.id);
            const disabled = busy || item.planVersionId === versionId || (!checked && selected.length >= 50);
            return <div key={item.id} className="[&>div]:w-full [&>div>label]:flex [&>div>label]:min-h-11 [&>div>label]:flex-1 [&>div>label]:items-center [&>div>label]:leading-snug">
              <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={next => { setSelected(prev => next ? [...prev, item.id] : prev.filter(selectedId => selectedId !== item.id)); setPreview(null); setKey(null); setNotice(""); }} label={`${item.name} · ${item.ref}${item.planVersionId === versionId ? " · Already on this version" : ""}`} />
            </div>;
          })}
        </div>
        {candidates.nextCursor ? <Button variant="ghost" disabled={busy} onClick={() => load(true)}>Load more enrolments</Button> : null}
        <p className="text-xs text-muted">{selected.length} selected · Maximum 50 per batch. No enrolment is selected automatically.</p>
        <Button variant="secondary" disabled={busy || !selected.length} onClick={makePreview}>{busy ? "Working…" : "Preview selected fee changes"}</Button>
      </>}
      {preview ? <section className="space-y-4" aria-label="Fee change impact preview">
        <h5 className="font-semibold">Impact of version {preview.versionNo}</h5>
        {preview.rows.map(row => <div key={row.enrolmentId} className="space-y-3 rounded-lg border border-line p-4">
          <p className="font-medium">{row.studentName} <span className="text-sm text-muted">{row.studentRef}</span></p>
          {row.blocked ? <Alert tone="warn">{row.blocked}</Alert> : row.lines.map(line => <div key={line.instalmentId} className="space-y-1 border-t border-line pt-3 text-sm">
            <p className="font-medium">{line.sequence}. {line.periodLabel} · {line.component} · {line.dueDate}</p>
            <p>Template amount: <Money minor={line.acceptedTemplateMinor} /> → <Money minor={line.nextTemplateMinor} /></p>
            <p>Obligation: <Money minor={line.netBeforeMinor} /> → <Money minor={line.netAfterMinor} /> · Change: <Money minor={line.deltaMinor} /></p>
            <p className="text-muted">Released to enrolment credit: <Money minor={line.releasedToCreditMinor} /></p>
          </div>)}
        </div>)}
        <label className="block text-sm font-medium">Reason for applying fee changes<textarea required minLength={5} maxLength={1000} value={reason} onChange={event => { setReason(event.target.value); setKey(newIdemKey()); }} disabled={busy} className={`${inputCls} mt-2 min-h-24 py-3`} /></label>
        <p className="text-sm text-muted">Only the selected enrolments above will change. Original charges and receipt history remain. Stale previews are rejected; preview again after any financial change.</p>
        <Button disabled={busy || reason.trim().length < 5 || preview.rows.some(row => row.blocked)} onClick={apply}>{busy ? "Applying…" : "Confirm fee changes for selected enrolments"}</Button>
      </section> : null}
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {notice ? <p role="status" className="rounded-md bg-ok-soft p-3 text-sm text-ok">{notice}</p> : null}
    </div>
  </Disclosure>;
}
