"use client";
import { Disclosure } from "@/components/ui/kit";
import clsx from "clsx";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, InstalmentBadge, Money, ReviewBadge, inputCls } from "@/components/ui";
import { Checkbox, DatePicker, Select } from "@/components/ui/kit";
import { api, ApiError, newIdemKey } from "@/lib/client-api";
import { formatMinor, parseMajorToMinor, minorToMajorString } from "@/lib/money";
import { formatBizDate, formatInstant } from "@/lib/time";
import { PdfEvidence } from "./pdf-evidence";

interface QueueItem { id: string; claimedMinor: number; transferDate: string; submittedAt: string; flags: string[]; version: number; studentName: string; studentRef: string; programmeName: string; intakeLabel: string; periodLabel: string }
interface Inst { id: string; periodLabel: string; dueDate: string; netObligationMinor: number; allocatedMinor: number; remainingMinor: number; pendingClaimedMinor: number; state: string }
interface Ctx {
  submission: { id: string; version: number; status: string; claimedMinor: number; transferDate: string; bankReference: string | null; studentNote: string | null; targetInstalmentId: string; flags: string[]; submittedAt: string; supersedesSubmissionId: string | null };
  student: { name: string; ref: string; nicMasked: string | null; phone: string | null };
  programmeName: string; intakeLabel: string;
  asset: { mime: string; previewKey: string | null; pages: number | null; scan: string; validation: string } | null;
  ledger: { instalments: Inst[]; summary: { outstandingMinor: number; overdueMinor: number; creditMinor: number; collectedMinor: number } };
  history: { id: string; status: string; claimedMinor: number; transferDate: string; submittedAt: string }[];
  chain: { id: string; status: string; claimedMinor: number }[];
  actions: { id: string; submissionId: string; kind: string; reason: string | null; actorName: string | null; createdAt: string }[];
  proposedPlan: { lines: { instalmentId: string; amountMinor: number }[]; creditMinor: number };
}
interface Plan { lines: { instalmentId: string; amountMinor: number }[]; creditMinor: number }
interface Decision { submissionId: string; actionId: string; status: string; at: number; label: string }

const FLAG_TEXT: Record<string, string> = {
  DUPLICATE_FILE: "Same file was uploaded before for this enrolment",
  DUPLICATE_FILE_ELSEWHERE: "Same file appears on another record (details restricted)",
  DUPLICATE_REFERENCE: "Bank reference used before on this enrolment",
  DUPLICATE_REFERENCE_ELSEWHERE: "Bank reference appears on another record (details restricted)",
  OLD_TRANSFER: "Transfer date is more than 90 days old",
  UNUSUAL_AMOUNT: "Amount is unusually large for this enrolment",
};
const SKIP_KEY = "t2t:review-skip";
const UNDO_MS = 60_000;
/** Event-time timestamp (called only from event handlers). */
const stamp = () => Date.now();

export function ReviewWorkspace({ intakes, isSuper, linkedSubmission = null, invalidLinkedSubmission = false }: { intakes: { id: string; label: string; programmeId: string; programmeName: string }[]; isSuper: boolean; linkedSubmission?: string | null; invalidLinkedSubmission?: boolean }) {
  const [filters, setFilters] = useState({ intakeId: "", programmeId: "", from: "", to: "", period: "", flagged: "any" });
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(linkedSubmission);
  const [linkedView, setLinkedView] = useState(Boolean(linkedSubmission) || invalidLinkedSubmission);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "approve" | "reject">("view");
  const [busy, setBusy] = useState(false);
  const [lastDecision, setLastDecision] = useState<Decision | null>(null);
  const [now, setNow] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const restored = useRef(false);
  const undoRequest = useRef<{ actionId: string; key: string } | null>(null);

  // filters persist for this tab during navigation (sessionStorage only exists client-side, so hydrate after mount)
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const f = sessionStorage.getItem("t2t:review-filters"); if (f) setFilters(previous => ({ ...previous, ...JSON.parse(f) }));
      const s = sessionStorage.getItem(SKIP_KEY); if (s) setSkipped(JSON.parse(s));
    } catch { /* ignore */ }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => { try { sessionStorage.setItem("t2t:review-filters", JSON.stringify(filters)); } catch { /* ignore */ } }, [filters]);

  const loadQueue = useCallback(async (append = false, after: string | null = null) => {
    setLoading(true); if (!linkedView) setErr(null);
    const q = new URLSearchParams();
    if (filters.intakeId) q.set("intakeId", filters.intakeId);
    if (filters.programmeId) q.set("programmeId", filters.programmeId);
    if (filters.from) q.set("from", filters.from);
    if (filters.to) q.set("to", filters.to);
    if (filters.period) q.set("period", filters.period);
    q.set("flagged", filters.flagged);
    if (append && after) q.set("cursor", after);
    skipped.forEach((s) => q.append("skip", s));
    try {
      const r = await api<{ items: QueueItem[]; nextCursor: string | null; totalPending: number }>(`/api/staff/review/queue?${q}`);
      setQueue((prev) => (append ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor); setTotal(r.totalPending); setRefreshedAt(new Date());
      if (!append && !linkedView) setCurrent((c) => (c && r.items.some((i) => i.id === c) ? c : r.items[0]?.id ?? null));
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not load the queue."); }
    finally { setLoading(false); }
  }, [filters, skipped, linkedView]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
  useEffect(() => { void loadQueue(); }, [loadQueue]);
  useEffect(() => {
    const onFocus = () => void loadQueue();
    window.addEventListener("focus", onFocus); window.addEventListener("online", onFocus);
    return () => { window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); };
  }, [loadQueue]);
  useEffect(() => { const tick = () => setNow(Date.now()); const t = setInterval(tick, 1000); return () => clearInterval(t); }, []);

  // load context + advisory lease for the current item
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the displayed server record when selection changes
    if (!current) { setCtx(null); return; }
    let alive = true;
    let leaseRequested = false;
    setMode("view"); setCtx(null); setErr(null);
    (async () => {
      try {
        const c = await api<Ctx>(`/api/staff/review/${current}/context`);
        if (!alive) return;
        setCtx(c);
        if (c.submission.status === "PENDING_REVIEW") {
          leaseRequested = true;
          void api(`/api/staff/review/${current}/lease`, { method: "POST", body: {} }).catch(() => null);
        }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : "Could not open this receipt."); }
    })();
    return () => { alive = false; if (leaseRequested) void api(`/api/staff/review/${current}/release`, { method: "POST", body: {} }).catch(() => null); };
  }, [current]);

  const idx = queue.findIndex((q) => q.id === current);
  const advance = useCallback(() => {
    setLinkedView(false);
    const rest = queue.filter((q) => q.id !== current);
    setQueue(rest);
    setCurrent(rest[idx] ? rest[idx].id : rest[0]?.id ?? null);
    setTotal((t) => Math.max(0, t - 1));
    if (rest.length < 3 && cursor) void loadQueue(true, cursor);
  }, [queue, current, idx, cursor, loadQueue]);

  const skip = useCallback(() => {
    if (!current || ctx?.submission.status !== "PENDING_REVIEW") return;
    const next = [...skipped, current];
    setSkipped(next);
    try { sessionStorage.setItem(SKIP_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    advance();
    setTotal((t) => t + 1); // skip does not change the real pending count
  }, [current, ctx, skipped, advance]);

  const undo = useCallback(async () => {
    if (!lastDecision || now - lastDecision.at > UNDO_MS) return;
    setBusy(true);
    try {
      if (undoRequest.current?.actionId !== lastDecision.actionId) undoRequest.current = { actionId: lastDecision.actionId, key: newIdemKey() };
      await api(`/api/staff/review/${lastDecision.submissionId}/undo`, { method: "POST", idempotencyKey: undoRequest.current.key, body: { actionId: lastDecision.actionId } });
      setLastDecision(null);
      await loadQueue();
      setCurrent(lastDecision.submissionId);
    } catch (e) { setErr(e instanceof Error ? e.message : "Undo failed."); }
    finally { setBusy(false); }
  }, [lastDecision, now, loadQueue]);

  const onDecided = (d: Decision) => { setLastDecision(d); setNow(d.at); setMode("view"); advance(); };

  // keyboard shortcuts (ignored while typing)
  const viewerRef = useRef<ViewerHandle>(null);
  const closePanel = useCallback(() => {
    const action = mode;
    setMode("view");
    requestAnimationFrame(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>(`[data-review-action="${action}"]`);
      Array.from(buttons).find((button) => button.getClientRects().length > 0)?.focus({ preventScroll: true });
    });
  }, [mode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode !== "view") { e.preventDefault(); closePanel(); return; }
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a" && ctx?.submission.status === "PENDING_REVIEW") { e.preventDefault(); setMode("approve"); }
      else if (k === "r" && ctx?.submission.status === "PENDING_REVIEW") { e.preventDefault(); setMode("reject"); }
      else if (k === "s") { e.preventDefault(); skip(); }
      else if (k === "u") { e.preventDefault(); void undo(); }
      else if (k === "+" || k === "=") viewerRef.current?.zoom(0.25);
      else if (k === "-") viewerRef.current?.zoom(-0.25);
      else if (k === "o") viewerRef.current?.rotate();
      else if (k === "escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx, skip, undo, closePanel, mode]);

  const undoLeft = lastDecision ? Math.max(0, Math.ceil((UNDO_MS - (now - lastDecision.at)) / 1000)) : 0;
  const programmeOptions = [...new Map(intakes.map(intake => [intake.programmeId, { value: intake.programmeId, label: intake.programmeName }])).values()];
  const extraFilterCount = [filters.programmeId, filters.from, filters.to].filter(Boolean).length;

  return (
    <main className="mx-auto w-full max-w-[1400px] min-w-0 px-4 py-6 pb-28 sm:px-6 lg:px-8 lg:pb-6">
      {linkedView ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-card p-4 text-sm"><p>{invalidLinkedSubmission ? "This receipt is unavailable." : ctx && ctx.submission.status !== "PENDING_REVIEW" ? "Receipt history · Read-only" : "Viewing the linked receipt"}</p><Button variant="secondary" onClick={() => { setLinkedView(false); setCurrent(null); setErr(null); }}>Return to pending queue</Button></div> : null}
      <div className="mb-4 grid min-w-0 grid-cols-2 items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] xl:flex xl:flex-wrap">
        <div className="col-span-2 min-w-0 text-sm md:col-span-1 xl:w-80">
          <label htmlFor="f-intake" className="mb-1.5 block font-medium text-ink-2">Programme / intake</label>
          <Select id="f-intake" value={filters.intakeId} onValueChange={(v) => setFilters({ ...filters, intakeId: v })}
            options={[{ value: "", label: "All in my scope" }, ...intakes.filter(i => !filters.programmeId || i.programmeId === filters.programmeId).map((i) => ({ value: i.id, label: `${i.programmeName} — ${i.label}` }))]} />
        </div>
        <label className="min-w-0 text-sm">
          <span className="mb-1 block font-medium">Period</span>
          <input className={inputCls} placeholder="e.g. March" value={filters.period} onChange={(e) => setFilters({ ...filters, period: e.target.value })} />
        </label>
        <div className="min-w-0 text-sm xl:w-48">
          <label htmlFor="f-flag" className="mb-1.5 block font-medium text-ink-2">Warnings</label>
          <Select id="f-flag" value={filters.flagged} onValueChange={(v) => setFilters({ ...filters, flagged: v })}
            options={[{ value: "any", label: "All" }, { value: "flagged", label: "Flagged only" }, { value: "clean", label: "No warnings" }]} />
        </div>
        <div aria-live="polite" className="col-span-2 text-sm text-muted md:col-span-3 xl:ml-auto xl:text-right">
          <div><span className="font-medium text-ink">{total}</span> pending in scope{skipped.length ? ` · ${skipped.length} skipped this session` : ""}</div>
          {refreshedAt ? <div>Updated {refreshedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div> : null}
          {skipped.length ? <button className="u-draw min-h-11 text-accent" onClick={() => { setSkipped([]); try { sessionStorage.removeItem(SKIP_KEY); } catch { /* */ } }}>Show skipped again</button> : null}
        </div>
      </div>

      <Card className="mb-4 p-4">
        <Disclosure title={`Programme and submission dates${extraFilterCount ? ` · ${extraFilterCount} active` : ""}`}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label htmlFor="f-programme" className="mb-2 block text-sm font-medium">Programme</label><Select id="f-programme" value={filters.programmeId} onValueChange={programmeId => setFilters({ ...filters, programmeId, intakeId: "" })} options={[{ value: "", label: "All programmes in scope" }, ...programmeOptions]} /></div>
            <div><label htmlFor="f-from" className="mb-2 block text-sm font-medium">Submitted from</label><DatePicker id="f-from" value={filters.from} max={filters.to || undefined} onChange={from => setFilters({ ...filters, from })} /></div>
            <div><label htmlFor="f-to" className="mb-2 block text-sm font-medium">Submitted to</label><DatePicker id="f-to" value={filters.to} min={filters.from || undefined} onChange={to => setFilters({ ...filters, to })} /></div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted">Submission dates use Asia/Colombo and include both selected days.</p>{extraFilterCount > 0 && <Button variant="ghost" onClick={() => setFilters({ ...filters, programmeId: "", from: "", to: "" })}>Clear extra filters</Button>}</div>
        </Disclosure>
      </Card>

      {lastDecision && undoLeft > 0 ? (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-inv px-4 py-3 text-sm text-inv-ink">
          <span>{lastDecision.label}</span>
          <Button variant="secondary" onClick={undo} disabled={busy}>Undo ({undoLeft}s)</Button>
        </div>
      ) : null}
      {err ? <div className="mb-4 space-y-2"><Alert tone="bad">{err}</Alert><Button variant="secondary" onClick={() => window.location.reload()}>Reload workspace</Button></div> : null}

      {queue.length ? <div className="mb-4 block min-w-0 text-sm xl:hidden"><label htmlFor="f-current" className="mb-1.5 block font-medium text-ink-2">Receipt in queue</label><Select id="f-current" value={current && queue.some(item => item.id === current) ? current : ""} onValueChange={(v) => { setLinkedView(false); setCurrent(v); }} options={queue.map((q) => ({ value: q.id, label: q.studentName, hint: `${formatMinor(q.claimedMinor)} · ${q.periodLabel}` }))} />{cursor ? <Button variant="ghost" onClick={() => loadQueue(true, cursor)}>Load more receipts</Button> : null}</div> : null}

      <div aria-busy={loading} className="grid min-w-0 gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="hidden max-h-[calc(100dvh-220px)] overflow-y-auto xl:block">
          <ul>
            {queue.map((q) => (
              <li key={q.id}>
                <button onClick={() => { setLinkedView(false); setCurrent(q.id); }} aria-current={q.id === current} className={clsx("block w-full border-b border-line px-3 py-3 text-left text-sm hover:bg-surface", q.id === current && "bg-accent-soft")}>
                  <div className="flex justify-between gap-2"><span className="truncate font-medium">{q.studentName}</span><Money minor={q.claimedMinor} /></div>
                  <div className="truncate text-muted">{q.programmeName} · {q.periodLabel}</div>
                  <div className="text-xs text-muted">{formatInstant(q.submittedAt)}{q.flags.length ? " · ⚑ flagged" : ""}</div>
                </button>
              </li>
            ))}
            {loading && !queue.length ? Array.from({ length: 5 }).map((_, i) => <li key={i} className="skeleton m-3 h-14 rounded-md" />) : null}
            {cursor ? <li className="p-3"><Button variant="ghost" className="w-full" onClick={() => loadQueue(true, cursor)}>Load more</Button></li> : null}
          </ul>
        </Card>

        {!loading && !current ? (
          <Card className="p-8 text-center"><p className="text-lg font-medium">{err ? "Receipts could not be loaded." : "No pending receipts match this view."}</p><p className="mt-2 text-sm text-muted">{err ? "Check your connection, then reload the workspace." : "Try another filter or show skipped receipts to continue."}</p></Card>
        ) : !ctx ? (
          err ? <Card className="p-8 text-sm text-muted">This receipt could not be opened. Reload the workspace to try again.</Card> : <div role="status" className="grid min-w-0 content-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"><p className="rounded-lg border border-line bg-card px-4 py-3 text-sm text-muted lg:col-span-2">Loading receipt and payment details…</p><div aria-hidden="true" className="skeleton h-[60vh] rounded-lg border border-line" /><div aria-hidden="true" className="skeleton h-[60vh] rounded-lg border border-line" /></div>
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Viewer ref={viewerRef} ctx={ctx} />
            <div className="min-w-0 space-y-4">
              <ContextPanel ctx={ctx} />
              {ctx.submission.status !== "PENDING_REVIEW" ? <Alert tone="info">This receipt has already been reviewed. Its evidence and history are available here; approval and rejection actions are disabled.</Alert> : mode === "approve" ? <ApprovePanel ctx={ctx} onCancel={closePanel} onDone={onDecided} onReload={() => loadQueue()} />
                : mode === "reject" ? <RejectPanel ctx={ctx} onCancel={closePanel} onDone={onDecided} onReload={() => loadQueue()} />
                : (
                  <div className="hidden gap-2 lg:flex">
                    <Button data-review-action="approve" onClick={() => setMode("approve")} className="flex-1">Approve (A)</Button>
                    <Button data-review-action="reject" variant="danger" onClick={() => setMode("reject")} className="flex-1">Reject (R)</Button>
                    <Button variant="secondary" onClick={skip}>Skip (S)</Button>
                  </div>
                )}
              {isSuper ? <p className="text-xs text-muted">Older decisions can be corrected from the student&apos;s enrolment page (Super Admin correction with reason).</p> : null}
            </div>
          </div>
        )}
      </div>

      {/* Mobile action bar: explicit buttons, no swipe-to-approve */}
      {ctx?.submission.status === "PENDING_REVIEW" && mode === "view" ? (
        <div aria-label="Receipt actions" className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_-8px_#1f303840] lg:hidden">
          <Button data-review-action="approve" onClick={() => setMode("approve")} className="flex-1">Approve…</Button>
          <Button data-review-action="reject" variant="danger" onClick={() => setMode("reject")} className="flex-1">Reject…</Button>
          <Button variant="secondary" onClick={skip}>Skip</Button>
        </div>
      ) : null}
    </main>
  );
}

/* ----------------------------------------------------------------- viewer */
interface ViewerHandle { zoom: (d: number) => void; rotate: () => void }

const Viewer = forwardRef<ViewerHandle, { ctx: Ctx }>(function Viewer({ ctx }, ref) {
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [fit, setFit] = useState(true);
  const [compare, setCompare] = useState(false);
  const [previousAsset, setPreviousAsset] = useState<{ id: string; mime: string } | { id: string; error: true } | null>(null);
  useImperativeHandle(ref, () => ({ zoom: (d) => { setFit(false); setZoom((z) => Math.min(4, Math.max(0.25, z + d))); }, rotate: () => setRot((r) => (r + 90) % 360) }));
  const id = ctx.submission.id;
  const isPdf = ctx.asset?.mime === "application/pdf";
  const prior = ctx.chain[0];
  useEffect(() => {
    if (!compare || !prior) return;
    const controller = new AbortController();
    let alive = true;
    void fetch(`/api/staff/review/${prior.id}/context`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the previous receipt.");
        const body = await response.json() as { asset: { mime: string } | null };
        if (alive) setPreviousAsset({ id: prior.id, mime: body.asset?.mime ?? "" });
      })
      .catch(() => { if (alive && !controller.signal.aborted) setPreviousAsset({ id: prior.id, error: true }); });
    return () => { alive = false; controller.abort(); };
  }, [compare, prior]);
  return (
    <Card className="flex min-h-[45vh] flex-col overflow-hidden lg:sticky lg:top-22 lg:self-start">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-3 text-sm">
        <Button variant="ghost" className="min-w-11 px-2" onClick={() => { setFit(false); setZoom((z) => Math.max(0.25, z - 0.25)); }} aria-label="Zoom out">−</Button>
        <span className="w-12 text-center font-mono">{fit ? "fit" : `${Math.round(zoom * 100)}%`}</span>
        <Button variant="ghost" className="min-w-11 px-2" onClick={() => { setFit(false); setZoom((z) => Math.min(4, z + 0.25)); }} aria-label="Zoom in">+</Button>
        <Button variant="ghost" className="px-2" onClick={() => { setFit(true); setZoom(1); }}>Fit</Button>
        <Button variant="ghost" className="px-2" onClick={() => setRot((r) => (r + 90) % 360)}>Rotate</Button>
        {prior ? <Button variant="ghost" aria-pressed={compare} className="ml-auto px-2" onClick={() => setCompare((c) => !c)}>{compare ? "Hide previous" : "Compare previous"}</Button> : null}
        <a href={`/api/staff/review/${id}/evidence?v=original`} target="_blank" rel="noreferrer noopener" className={clsx("u-draw inline-flex min-h-11 items-center text-accent", !prior && "ml-auto")}>Open original<span className="sr-only"> (opens in a new tab)</span></a>
      </div>
      <div className={clsx("grid min-w-0 flex-1", compare && prior && "gap-1 md:grid-cols-2")}>
        {isPdf ? <PdfEvidence key={id} src={`/api/staff/review/${id}/evidence?v=original`} zoom={zoom} rotation={rot} fit={fit} label={`Receipt from ${ctx.student.name}`} /> : <EvidenceFrame src={`/api/staff/review/${id}/evidence`} zoom={zoom} rot={rot} fit={fit} label={`Receipt from ${ctx.student.name}`} />}
        {compare && prior ? previousAsset?.id !== prior.id ? <p role="status" className="m-auto p-4 text-sm text-muted">Loading previous receipt…</p> : "error" in previousAsset ? <Alert tone="bad">Could not load the previous receipt.</Alert> : previousAsset.mime === "application/pdf" ? <PdfEvidence key={prior.id} src={`/api/staff/review/${prior.id}/evidence?v=original`} zoom={1} rotation={0} fit label="Previous rejected receipt" /> : <EvidenceFrame src={`/api/staff/review/${prior.id}/evidence`} zoom={1} rot={0} fit label="Previous rejected receipt" /> : null}
      </div>
      {ctx.asset?.scan === "NOT_CONFIGURED" ? <p className="border-t border-line px-3 py-2 text-xs text-muted">Malware scanning is not configured on this server. Files passed format validation only.</p> : null}
      {ctx.asset && ctx.asset.scan !== "NOT_CONFIGURED" ? <div className="border-t border-line px-3 py-2"><Badge tone={ctx.asset.scan === "CLEAN" ? "ok" : ctx.asset.scan === "PENDING" ? "info" : ctx.asset.scan === "INFECTED" ? "bad" : "warn"}>Malware scan: {ctx.asset.scan === "CLEAN" ? "Clean" : ctx.asset.scan === "PENDING" ? "Scanning" : ctx.asset.scan === "INFECTED" ? "Rejected" : "Unavailable"}</Badge></div> : null}
    </Card>
  );
});

function EvidenceFrame({ src, zoom, rot, fit, label }: { src: string; zoom: number; rot: number; fit: boolean; label: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label} className="relative h-[50vh] min-w-0 overflow-auto bg-[#2a3a41] lg:h-[min(65vh,680px)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={label} draggable={false}
        style={{ transform: `rotate(${rot}deg) scale(${fit ? 1 : zoom})`, transformOrigin: fit ? "center" : "top left" }}
        className={clsx("mx-auto select-none transition-transform", fit ? "h-full w-full object-contain" : "max-w-none")} />
    </div>
  );
}

/* ----------------------------------------------------------------- context */
function ContextPanel({ ctx }: { ctx: Ctx }) {
  const s = ctx.submission;
  const target = ctx.ledger.instalments.find((i) => i.id === s.targetInstalmentId);
  const prev = ctx.history.filter((h) => h.id !== s.id).slice(0, 5);
  return (
    <Card className="divide-y divide-line">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-tight">{ctx.student.name}</p>
            <p className="text-sm text-muted">{ctx.programmeName} · {ctx.intakeLabel}</p>
            <p className="font-mono text-xs text-muted">{ctx.student.ref} · {ctx.student.nicMasked}</p>
          </div>
          <ReviewBadge status={s.status} />
        </div>
        {s.flags.length ? <ul className="mt-3 space-y-1">{s.flags.map((f) => <li key={f}><Badge tone="warn" className="whitespace-normal">⚑ {FLAG_TEXT[f] ?? f}</Badge></li>)}</ul> : null}
        {s.flags.length ? <p className="mt-1 text-xs text-muted">Warnings are prompts to check, not findings of fraud.</p> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 bg-surface/40 p-5 text-sm">
        <dt className="text-muted">Claimed</dt><dd className="text-right"><Money minor={s.claimedMinor} strong /></dd>
        <dt className="text-muted">Transfer date</dt><dd className="text-right">{formatBizDate(s.transferDate)}</dd>
        <dt className="text-muted">Target period</dt><dd className="text-right">{target?.periodLabel ?? "—"}</dd>
        <dt className="text-muted">Its remaining</dt><dd className="text-right"><Money minor={target?.remainingMinor ?? 0} /></dd>
        <dt className="text-muted">Enrolment outstanding</dt><dd className="text-right"><Money minor={ctx.ledger.summary.outstandingMinor} /></dd>
        <dt className="text-muted">Overdue</dt><dd className="text-right text-bad"><Money minor={ctx.ledger.summary.overdueMinor} /></dd>
        <dt className="text-muted">Existing credit</dt><dd className="text-right"><Money minor={ctx.ledger.summary.creditMinor} /></dd>
        {s.bankReference ? <><dt className="text-muted">Bank reference</dt><dd className="truncate text-right font-mono">{s.bankReference}</dd></> : null}
        <dt className="text-muted">Submitted</dt><dd className="text-right">{formatInstant(s.submittedAt)}</dd>
      </dl>
      {s.studentNote ? <p className="p-4 text-sm"><span className="text-muted">Student note: </span>{s.studentNote}</p> : null}
      {ctx.chain.length ? <div className="p-4 text-sm"><p className="mb-1 font-medium">Replaces</p>{ctx.chain.map((c) => <p key={c.id} className="text-muted"><ReviewBadge status={c.status} /> <Money minor={c.claimedMinor} /></p>)}</div> : null}
      <Disclosure className="p-4 text-sm" title={<> Instalments ({ctx.ledger.instalments.length})</>} triggerClassName="cursor-pointer font-medium">
        <ul className="mt-2 space-y-1">
          {ctx.ledger.instalments.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0"><span>{i.periodLabel} · {formatBizDate(i.dueDate)}</span><span className="flex flex-wrap items-center gap-2"><Money minor={i.remainingMinor} /><InstalmentBadge state={i.state} /></span></li>
          ))}
        </ul>
      </Disclosure>
      {prev.length ? (
        <Disclosure className="p-4 text-sm" title={<> Previous receipts ({prev.length})</>} triggerClassName="cursor-pointer font-medium">
          <ul className="mt-2 space-y-1">{prev.map((h) => <li key={h.id} className="flex justify-between"><span>{formatBizDate(h.transferDate)} · <Money minor={h.claimedMinor} /></span><ReviewBadge status={h.status} /></li>)}</ul>
        </Disclosure>
      ) : null}
      {ctx.actions.filter((a) => a.submissionId === s.id).length ? (
        <div className="p-4 text-sm"><p className="mb-1 font-medium">Decision history</p>
          {ctx.actions.filter((a) => a.submissionId === s.id).map((a) => <p key={a.id} className="text-muted">{a.kind.toLowerCase()} by {a.actorName ?? "staff"} · {formatInstant(a.createdAt)}{a.reason ? ` — ${a.reason}` : ""}</p>)}
        </div>
      ) : null}
    </Card>
  );
}

/* ----------------------------------------------------------------- decisions */
function ApprovePanel({ ctx, onCancel, onDone, onReload }: { ctx: Ctx; onCancel: () => void; onDone: (d: Decision) => void; onReload: () => void }) {
  const s = ctx.submission;
  const [amount, setAmount] = useState(minorToMajorString(s.claimedMinor));
  const [reason, setReason] = useState("");
  const [spill, setSpill] = useState(false);
  const [plan, setPlan] = useState<Plan>(ctx.proposedPlan);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const idem = useRef(newIdemKey());
  const confirmed = parseMajorToMinor(amount);
  const changed = confirmed !== null && confirmed !== s.claimedMinor;
  const byId = useMemo(() => new Map(ctx.ledger.instalments.map((i) => [i.id, i])), [ctx]);

  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(async () => {
      try { const r = await api<{ plan: Plan }>(`/api/staff/review/${s.id}/preview?confirmed=${confirmed}&spill=${spill ? 1 : 0}`); setPlan(r.plan); }
      catch (e) { setErr(e instanceof Error ? e.message : "Preview failed."); }
    }, 250);
    return () => clearTimeout(t);
  }, [confirmed, spill, s.id]);

  async function go() {
    if (!confirmed) return setErr("Enter a valid amount.");
    if (changed && !reason.trim()) return setErr("Give a reason for changing the amount.");
    setBusy(true); setErr(null);
    try {
      const r = await api<{ actionId: string; status: string }>(`/api/staff/review/${s.id}/approve`, {
        method: "POST", idempotencyKey: idem.current,
        body: { expectedVersion: s.version, confirmedMinor: confirmed, amountChangeReason: changed ? reason : undefined, spillOver: spill },
      });
      onDone({ submissionId: s.id, actionId: r.actionId, status: r.status, at: stamp(), label: `Approved ${formatMinor(confirmed)} for ${ctx.student.name}.` });
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE") { setErr(`${e.message} Current status: ${String(e.details?.currentStatus ?? "")}${e.details?.decidedBy ? ` by ${String(e.details.decidedBy)}` : ""}.`); onReload(); }
      else setErr(e instanceof Error ? e.message : "Approval failed.");
    } finally { setBusy(false); }
  }

  return (
    <Card role="region" aria-labelledby="approve-heading" className="fixed inset-x-0 bottom-0 z-30 max-h-[80dvh] space-y-3 overflow-y-auto border-accent p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl lg:static lg:max-h-none lg:shadow-none">
      <h2 id="approve-heading" className="font-medium">Approve payment</h2>
      <label className="block text-sm"><span className="mb-1 block">Confirmed amount (LKR)</span>
        <input className={clsx(inputCls, "font-mono")} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus /></label>
      {changed ? <label className="block text-sm"><span className="mb-1 block">Reason for changing the claimed {formatMinor(s.claimedMinor)}</span>
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></label> : null}
      <Checkbox id="spill" checked={spill} onCheckedChange={setSpill} label="Apply any excess to the earliest other unpaid instalments" />
      <div className="rounded-md bg-surface p-3 text-sm">
        <p className="mb-1 font-medium">Allocation</p>
        {plan.lines.length ? plan.lines.map((l) => <p key={l.instalmentId} className="flex flex-wrap justify-between gap-x-3 py-1"><span>{byId.get(l.instalmentId)?.periodLabel}</span><Money minor={l.amountMinor} /></p>) : <p className="text-muted">Nothing to allocate.</p>}
        {plan.creditMinor > 0 ? <p className="flex flex-wrap justify-between gap-x-3 text-accent-strong"><span>Unapplied credit (this enrolment)</span><Money minor={plan.creditMinor} /></p> : null}
      </div>
      {err ? <Alert tone="bad">{err}</Alert> : null}
      <div className="flex flex-wrap gap-2"><Button onClick={go} disabled={busy} className="min-w-0 flex-1">{busy ? "Approving…" : `Confirm approve ${confirmed ? formatMinor(confirmed) : ""}`}</Button><Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button></div>
    </Card>
  );
}

function RejectPanel({ ctx, onCancel, onDone, onReload }: { ctx: Ctx; onCancel: () => void; onDone: (d: Decision) => void; onReload: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const idem = useRef(newIdemKey());
  const presets = ["Receipt is unreadable", "Amount does not match the slip", "Not a payment to T2T", "Duplicate of an earlier receipt"];
  async function go() {
    if (!reason.trim()) return setErr("A reason is required. The student will see it.");
    setBusy(true); setErr(null);
    try {
      const r = await api<{ actionId: string; status: string }>(`/api/staff/review/${ctx.submission.id}/reject`, { method: "POST", idempotencyKey: idem.current, body: { expectedVersion: ctx.submission.version, reason: reason.trim() } });
      onDone({ submissionId: ctx.submission.id, actionId: r.actionId, status: r.status, at: stamp(), label: `Rejected receipt from ${ctx.student.name}.` });
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE") onReload();
      setErr(e instanceof Error ? e.message : "Rejection failed.");
    } finally { setBusy(false); }
  }
  return (
    <Card role="region" aria-labelledby="reject-heading" className="fixed inset-x-0 bottom-0 z-30 max-h-[80dvh] space-y-3 overflow-y-auto border-bad p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl lg:static lg:max-h-none lg:shadow-none">
      <h2 id="reject-heading" className="font-medium">Reject receipt</h2>
      <div className="flex flex-wrap gap-2">{presets.map((p) => <button key={p} type="button" onClick={() => setReason(p)} className="btn min-h-11 rounded-md border border-line bg-surface px-3 py-2 text-left text-sm">{p}</button>)}</div>
      <label className="block text-sm"><span className="mb-1 block">Reason shown to the student</span>
        <textarea className={clsx(inputCls, "py-2")} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
      {err ? <Alert tone="bad">{err}</Alert> : null}
      <div className="flex gap-2"><Button variant="danger" onClick={go} disabled={busy} className="flex-1">{busy ? "Rejecting…" : "Confirm reject"}</Button><Button variant="secondary" onClick={onCancel}>Cancel</Button></div>
    </Card>
  );
}
