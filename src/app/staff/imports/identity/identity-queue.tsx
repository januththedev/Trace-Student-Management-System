"use client";
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, inputCls } from "@/components/ui";
import { DatePicker, Dialog, Tabs, toast } from "@/components/ui/kit";
import { api, newIdemKey, ApiError } from "@/lib/client-api";
import { minorToMajorString } from "@/lib/money";
import { formatInstant } from "@/lib/time";
import { ShieldQuestion, UserRoundCheck } from "lucide-react";
import type { IdentityPreview } from "@/server/services/imports/identity-resolution";

export interface IdentityRow {
  id: string;
  source: string;
  reason: string;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
  resolution: string | null;
  fullName: string | null;
  nicMasked: string | null;
  ref: string | null;
  phone: string | null;
  email: string | null;
  intakeCode: string | null;
  programmeCode: string | null;
  programmeName?: string | null;
  fileRows: number[] | null;
  schedule: { sequence: number; periodLabel: string; amountMinor: number; dueDate: string }[];
}

interface ScheduleLine { sequence: string; periodLabel: string; amount: string; dueDate: string }

function fmtRow(r: IdentityRow): string {
  const when = formatInstant(new Date(r.createdAt));
  return `${when} — ${r.fullName ?? "Unnamed"}${r.nicMasked ? ` (NIC ${r.nicMasked})` : " (no identifier)"}`;
}

export function IdentityQueue({ initialOpen }: { initialOpen: IdentityRow[] }) {
  const [tab, setTab] = useState("open");
  const [open, setOpen] = useState(initialOpen);
  const [resolved, setResolved] = useState<IdentityRow[] | null>(null);
  const [listError, setListError] = useState("");
  const [listBusy, setListBusy] = useState(false);

  const items = tab === "open" ? open : (resolved ?? []);
  const count = useMemo(() => open.length, [open]);

  async function switchTab(next: string) {
    setTab(next);
    if (next === "resolved" && resolved === null) {
      setListBusy(true);
      setListError("");
      try {
        const r = await api<{ items: IdentityRow[] }>("/api/staff/imports/identity?status=resolved");
        setResolved(r.items);
      } catch (e) {
        setListError(e instanceof Error ? e.message : "Could not load resolved rows.");
      } finally {
        setListBusy(false);
      }
    }
  }

  async function refreshOpen() {
    setListBusy(true);
    setListError("");
    try {
      const r = await api<{ items: IdentityRow[] }>("/api/staff/imports/identity?status=open");
      setOpen(r.items);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Could not reload the queue.");
    } finally {
      setListBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Tabs value={tab} onValueChange={(v) => void switchTab(v)} items={[
        { value: "open", label: "Awaiting resolution", count },
        { value: "resolved", label: "Resolved", count: resolved?.length },
      ]} />
      {listError && <Alert tone="bad">{listError}</Alert>}
      {listBusy ? (
        <Card className="space-y-3 p-5" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-11 animate-pulse rounded-md bg-surface" />)}
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          title={tab === "open" ? "Nothing awaiting resolution" : "No resolved rows yet"}
          icon={tab === "open" ? <UserRoundCheck /> : <ShieldQuestion />}>
          {tab === "open"
            ? "Import rows with a missing or invalid identifier will appear here for a Super Admin to correct."
            : "Rows corrected and imported by a Super Admin are listed here with their outcome."}
        </EmptyState>
      ) : (
        <Card>
          <CardHeader icon={<ShieldQuestion />} title={tab === "open" ? "Staged import rows" : "Resolved rows"}
            description={tab === "open" ? "Original evidence is preserved; resolving creates a real student, enrolment and schedule." : undefined} />
          <ul className="divide-y divide-line">
            {items.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{fmtRow(r)}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {[r.programmeCode, r.intakeCode].filter(Boolean).join(" / ") || "No intake"} · {r.reason}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.resolvedAt ? (
                    <Badge tone="ok">Resolved {formatInstant(new Date(r.resolvedAt))}</Badge>
                  ) : (
                    <ResolveDialog row={r} onDone={refreshOpen} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ResolveDialog({ row, onDone }: { row: IdentityRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<IdentityPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nic, setNic] = useState("");
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [lines, setLines] = useState<ScheduleLine[]>([]);
  const [idemKey, setIdemKey] = useState(newIdemKey());

  async function loadPreview() {
    setBusy(true);
    setError("");
    try {
      const pr = await api<IdentityPreview>(`/api/staff/imports/identity/${row.id}`);
      setPreview(pr);
      setRef(pr.ref ?? "");
      setLines(pr.schedule.length
        ? pr.schedule.map((s) => ({ sequence: String(s.sequence), periodLabel: s.periodLabel, amount: minorToMajorString(s.amountMinor), dueDate: s.dueDate }))
        : []);
      setIdemKey(newIdemKey());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this row.");
    } finally {
      setBusy(false);
    }
  }

  function openDialog() {
    setOpen(true);
    setPreview(null);
    setNic("");
    setReason("");
    void loadPreview();
  }

  function setLine(i: number, patch: Partial<ScheduleLine>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (busy) return;
    if (!preview) return;
    const incomplete = lines.findIndex(line => !line.amount.trim() || !line.dueDate);
    if (incomplete !== -1) {
      setError(`Complete the amount and due date for instalment ${incomplete + 1}, or remove that instalment.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        nic: nic.trim(),
        reason: reason.trim(),
        expectedHash: preview.expectedHash,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        schedule: lines.map((l, i) => ({ sequence: i + 1, periodLabel: l.periodLabel || undefined, amount: l.amount, dueDate: l.dueDate })),
      };
      const r = await api<{ studentRef: string; instalmentsCreated: number }>(`/api/staff/imports/identity/${row.id}/resolve`, {
        method: "POST", body, idempotencyKey: idemKey,
      });
      toast.success(`Imported as ${r.studentRef}.`);
      setOpen(false);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE") {
        setError("This row changed since you opened it. Reloading the latest version.");
        await loadPreview();
      } else {
        setError(e instanceof Error ? e.message : "Resolution failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={openDialog}>Resolve</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(""); }}
        title="Correct identifier and import"
        description="The corrected NIC creates a real student, enrolment and opening schedule. The staged evidence is kept unchanged."
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy || !preview || !nic.trim() || reason.trim().length < 8} onClick={() => void submit()}>
            {busy ? "Importing…" : "Import corrected record"}
          </Button>
        </>}>
        {error && <div className="mb-4"><Alert tone="bad">{error}</Alert></div>}
        {!preview ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="h-11 animate-pulse rounded-md bg-surface" />)}
          </div>
        ) : (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line bg-surface/60 p-4 text-sm">
              <dt className="text-muted">Staged name</dt><dd>{preview.fullName ?? "—"}</dd>
              <dt className="text-muted">Staged identifier</dt><dd>{preview.nicMasked ?? "None recorded"}</dd>
              <dt className="text-muted">Programme / intake</dt>
              <dd>{[preview.programmeCode, preview.intakeCode].filter(Boolean).join(" / ") || "—"}</dd>
              <dt className="text-muted">Imported from</dt><dd>{preview.source} · rows {(preview.fileRows ?? []).join(", ") || "—"}</dd>
            </dl>
            <Field htmlFor="res-nic" label="Corrected NIC" hint="Must be a valid Sri Lankan NIC (old 9-digit+V/X or new 12-digit). Never merged with existing records.">
              <input id="res-nic" className={inputCls} value={nic} onChange={(e) => setNic(e.target.value)} autoComplete="off" spellCheck={false} required />
            </Field>
            <Field htmlFor="res-reason" label="Reason for the correction" hint={`At least 8 characters. Stored with the resolution history.${" "}`}>
              <textarea id="res-reason" className={`${inputCls} py-3`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required />
            </Field>
            {!preview.ref && (
              <Field htmlFor="res-ref" label="Student reference (optional)" hint="Leave blank to let the system generate a unique internal reference.">
                <input id="res-ref" className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" />
              </Field>
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium text-ink-2">Opening schedule</p>
              {!lines.length && <p className="text-sm text-muted">This record will be imported without opening instalments. Add an instalment if an opening obligation is required.</p>}
              {preview.schedule.length > 0 && (
                <p className="text-xs text-muted">The staged schedule is kept. Adjust amounts or dates below if the correction changes them.</p>
              )}
              {lines.map((l, i) => (
                <div key={i} className="space-y-2 rounded-md border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">Instalment {i + 1}</span>
                    <Button type="button" variant="ghost" size="sm" aria-label={`Remove instalment ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[7rem_11rem_1fr]">
                    <input aria-label={`Instalment ${i + 1} amount in LKR`} className={inputCls} placeholder="0.00" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} inputMode="decimal" />
                    <div>
                      <label className="sr-only" htmlFor={`instalment-${i + 1}-due-date`}>Instalment {i + 1} due date</label>
                      <DatePicker id={`instalment-${i + 1}-due-date`} value={l.dueDate} onChange={(v) => setLine(i, { dueDate: v })} placeholder="Due date" />
                    </div>
                    <input aria-label={`Instalment ${i + 1} label`} className={inputCls} placeholder="Label (e.g. Term 1)" value={l.periodLabel} onChange={(e) => setLine(i, { periodLabel: e.target.value })} />
                  </div>
                </div>
              ))}
              <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { sequence: String(ls.length + 1), periodLabel: "", amount: "", dueDate: "" }])}>
                Add instalment
              </Button>
            </div>
            <Alert tone="warn">Conflicts are blocked: if the corrected NIC or reference already belongs to a student, nothing is imported and the row stays open for a manual decision.</Alert>
          </div>
        )}
      </Dialog>
    </>
  );
}
