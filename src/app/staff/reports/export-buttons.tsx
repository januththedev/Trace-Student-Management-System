"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Checkbox, Select } from "@/components/ui/kit";
import { newIdemKey } from "@/lib/client-api";

const REPORTS = [
  ["receipts", "Receipts (approval date)"], ["transfer-receipts", "Receipts (transfer date)"], ["allocations", "Allocations"], ["outstanding", "Outstanding"],
  ["ageing", "Ageing"], ["credits", "Credits"], ["exemptions", "Exemptions"], ["programme-totals", "Programme totals"], ["students", "Students"],
  ["review-throughput", "Review throughput"], ["follow-up-outcomes", "Follow-up outcomes"], ["collection-rate", "Collection rate"],
] as const;

export function ExportButtons({ from, to, allowFull }: { from: string; to: string; allowFull: boolean }) {
  const [report, setReport] = useState<string>("receipts");
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const pendingKeys = useRef(new Map<string, string>());
  useEffect(() => () => controller.current?.abort(), []);
  const [err, setErr] = useState<string | null>(null);

  async function download(background = false, resumeId?: string, format: "csv" | "pdf" = "csv") {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true); setErr(null); setMessage("");
    try {
      const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
      const payload = JSON.stringify({ report, from, to, asOf: to, fullIdentifiers: allowFull && full ? true : undefined, format: background ? undefined : format });
      const signature = `${background}:${payload}`;
      const key = pendingKeys.current.get(signature) ?? newIdemKey();
      pendingKeys.current.set(signature, key);
      let res = resumeId ? null : await fetch(background ? "/api/staff/exports" : "/api/staff/reports/export", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrf, "Idempotency-Key": key }, body: payload, cache: "no-store", signal: request.signal });
      if (res) pendingKeys.current.delete(signature);
      if (background) {
        if (res && !res.ok) { const result = await res.json().catch(() => null); throw new Error(result?.error?.message ?? "Could not prepare the export."); }
        const id = resumeId ?? (await res!.json()).id;
        if (typeof id !== "string") throw new Error("The export could not be created. Please try again.");
        setJobId(id);
        setMessage("Preparing your CSV. Large exports may take several minutes. Keep this page open to download automatically.");
        for (let attempt = 0; attempt < 120; attempt++) {
          res = await fetch(`/api/staff/exports/${encodeURIComponent(id)}`, { cache: "no-store", signal: request.signal });
          if (res.status !== 202) break;
          if (attempt === 119) { setMessage("Your export is still preparing. Check again in a few minutes."); return; }
          const retry = Number(res.headers.get("Retry-After"));
          await new Promise<void>((resolve, reject) => {
            const finish = () => { request.signal.removeEventListener("abort", abort); resolve(); };
            const timer = window.setTimeout(finish, Number.isFinite(retry) && retry > 0 ? Math.min(30, Math.max(5, retry)) * 1000 : 5000);
            const abort = () => { window.clearTimeout(timer); reject(new DOMException("Stopped checking", "AbortError")); };
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) abort();
          });
        }
      }
      if (!res) throw new Error("Export is unavailable. Please create a new export.");
      if (background && res.status === 404) { setJobId(null); throw new Error("This export is unavailable or has expired. Prepare a new CSV to try again."); }
      if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(j?.error?.message ?? "Export failed."); }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `t2t-export.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setJobId(null); setMessage(`Your ${format.toUpperCase()} download is ready.`);
    } catch (e) {
      if (request.signal.aborted) { setMessage("Automatic checking stopped. Your export may still be preparing; use Check export to resume."); }
      else { setErr(e instanceof Error ? e.message : "Export failed."); setMessage(""); }
    } finally { if (controller.current === request) { controller.current = null; setBusy(false); } }
  }

  return (
    <div className="flex w-full min-w-0 flex-wrap items-end gap-3 xl:ml-auto xl:w-auto">
      <label className="w-full min-w-0 text-sm sm:w-auto"><span className="mb-1 block font-medium">Export report</span>
        <Select aria-label="Export report" value={report} disabled={busy} onValueChange={value => { setReport(value); setJobId(null); setMessage(""); }} options={REPORTS.map(([k, l]) => ({ value: k, label: l }))} className="sm:w-60" /></label>
      {allowFull ? <div className="flex min-h-11 items-center"><Checkbox id="full-nic" checked={full} disabled={busy} onCheckedChange={value => { setFull(value); setJobId(null); setMessage(""); }} label="Full NIC (audited)" /></div> : null}
      <Button type="button" variant="secondary" onClick={() => download()} disabled={busy} className="w-full sm:w-auto">{busy ? "Preparing…" : "Download CSV"}</Button>
      <Button type="button" onClick={() => download(false, undefined, "pdf")} disabled={busy} className="w-full sm:w-auto">Download PDF</Button>
      <Button type="button" variant="secondary" onClick={() => download(true, jobId ?? undefined)} disabled={busy} className="w-full sm:w-auto">{jobId ? "Check export" : "Prepare large CSV"}</Button>
      {busy && jobId ? <Button type="button" variant="ghost" onClick={() => controller.current?.abort()} className="w-full sm:w-auto">Stop checking</Button> : null}
      {message ? <p role="status" className="w-full text-sm text-muted">{message}</p> : null}
      {err ? <p role="alert" className="w-full text-sm text-bad">{err}</p> : null}
    </div>
  );
}
