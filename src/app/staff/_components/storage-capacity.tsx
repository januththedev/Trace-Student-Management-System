"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, HardDrive, RefreshCw } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader } from "@/components/ui";
import { api, newIdemKey } from "@/lib/client-api";
import { formatInstant } from "@/lib/time";
import type { StorageUsageSummary } from "@/server/services/storage-usage";

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toLocaleString("en-GB", { maximumFractionDigits: 2 })} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 1 })} MB`;
  if (value >= 1_000) return `${(value / 1_000).toLocaleString("en-GB", { maximumFractionDigits: 1 })} KB`;
  return `${value} B`;
}

export function StorageCapacity({ usage }: { usage: StorageUsageSummary }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);
  const full = (usage.percentageUsed ?? 0) >= 100;
  const near = (usage.percentageUsed ?? 0) >= 80;
  const tone = full ? "bad" : near || usage.stale ? "warn" : "ok";

  async function refresh() {
    setBusy(true);
    setError(null);
    setNotice(null);
    retryKey.current ??= newIdemKey();
    try {
      const result = await api<{ state: "refreshed" | "cached" | "busy" | "failed" }>("/api/staff/storage/refresh", {
        method: "POST", body: {}, idempotencyKey: retryKey.current,
      });
      retryKey.current = null;
      if (result.state === "failed") setError("Storage usage could not be checked. Any last verified figures remain below.");
      else setNotice(result.state === "busy" ? "A storage check is already running. Try again shortly." : result.state === "cached" ? "Storage was checked within the last ten minutes." : "Storage usage updated.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh storage usage.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden" role="region" aria-label="Storage capacity">
      <CardHeader icon={<HardDrive />} title={usage.driver === "local" ? "Development storage" : "Private object storage"}
        description="App bucket usage against its configured storage budget"
        action={<Button variant="secondary" disabled={busy} onClick={refresh} className="min-h-11" aria-label="Refresh storage usage"><RefreshCw className={busy ? "animate-spin" : undefined} />{busy ? "Checking…" : "Refresh"}</Button>} />
      <div className="space-y-4 p-5" aria-busy={busy}>
        {usage.status === "ready" && usage.usedBytes !== null && usage.remainingBytes !== null ? <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><p className="text-sm text-muted">Remaining storage</p><p className="mt-1 font-mono text-3xl font-semibold tracking-tight">{bytes(usage.remainingBytes)}</p></div>
            <Badge tone={tone}>{full ? "Budget exceeded" : near ? "Approaching budget" : usage.stale ? "Needs a fresh check" : "Within budget"}</Badge>
          </div>
          <div>
            <div role="progressbar" aria-label="App storage budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(usage.percentageUsed ?? 0))} aria-valuetext={`${bytes(usage.usedBytes)} used of ${bytes(usage.budgetBytes)}`} className="h-2 overflow-hidden rounded-full bg-surface">
              <div className={`h-full rounded-full ${full ? "bg-bad" : near ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.min(100, usage.percentageUsed ?? 0)}%` }} />
            </div>
            <p className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted"><span><span className="font-mono text-ink">{bytes(usage.usedBytes)}</span> used of {bytes(usage.budgetBytes)}</span><span>{usage.objectCount?.toLocaleString("en-GB")} stored files</span></p>
          </div>
          <p className="text-xs text-muted">Last checked {formatInstant(usage.measuredAt!)}. Includes originals, previews, unfinished uploads and exports.</p>
          {usage.stale ? <Alert tone="warn">{usage.lastCheckFailed ? "The latest check failed. These are the last verified figures." : "These figures are over 36 hours old. Refresh to check current usage."}</Alert> : null}
        </> : <div className="rounded-lg border border-dashed border-line p-4">
          <p className="font-medium">{usage.status === "unavailable" ? "Storage usage is unavailable" : "Storage has not been checked yet"}</p>
          <p className="mt-1 text-sm text-muted">Refresh to measure the files stored for this app. Your configured budget is {bytes(usage.budgetBytes)}.</p>
        </div>}
        <div className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3">
          <div className="flex items-start gap-2"><Archive className="mt-0.5 size-4 shrink-0 text-accent" /><div><p className="text-sm font-medium">Space saved by archival</p><p className="mt-1 font-mono text-lg font-semibold">{bytes(usage.savedBytes)}</p></div></div>
          <p className="max-w-sm text-xs text-muted">{usage.archivedOriginals.toLocaleString("en-GB")} originals archived. Savings count after the recovery copy has been removed. Already compressed files may save little.</p>
        </div>
        <p className="text-xs text-muted">This budget covers this app’s storage, rather than your whole Cloudflare account allowance.</p>
        {error ? <Alert tone="bad">{error}</Alert> : null}
        {notice ? <p role="status" className="text-sm text-muted">{notice}</p> : null}
      </div>
    </Card>
  );
}
