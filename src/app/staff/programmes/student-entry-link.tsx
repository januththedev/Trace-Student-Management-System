"use client";

import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";

export function StudentEntryLink({ intakeId, programmeName, intakeLabel }: { intakeId: string; programmeName: string; intakeLabel: string }) {
  const [copied, setCopied] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  async function copyLink() {
    const url = `${window.location.origin}/join/${encodeURIComponent(intakeId)}`;
    setCopied(false);
    setFallbackUrl(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setFallbackUrl(url);
    }
  }

  return (
    <section className="space-y-2 border-t border-line pt-3" aria-label={`Student entry link for ${programmeName}, ${intakeLabel}`}>
      <h4 className="text-sm font-medium">Student entry link</h4>
      <p className="text-xs text-muted">{programmeName} · {intakeLabel}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={copyLink} className="btn inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-card px-3 text-sm font-medium">
          <Copy aria-hidden className="size-4" /> Copy link
        </button>
        <a href={`/join/${encodeURIComponent(intakeId)}`} target="_blank" rel="noreferrer" className="btn inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-card px-3 text-sm font-medium">
          <ExternalLink aria-hidden className="size-4" /> Open link
        </a>
      </div>
      {copied ? <p role="status" className="text-sm text-ok">Link copied.</p> : null}
      {fallbackUrl ? <div className="space-y-1.5">
        <p role="status" className="text-sm text-muted">Copy is unavailable. Select and copy the link below.</p>
        <label className="sr-only" htmlFor={`student-entry-url-${intakeId}`}>Student entry URL</label>
        <input id={`student-entry-url-${intakeId}`} readOnly value={fallbackUrl} onFocus={(event) => event.currentTarget.select()} className="min-h-11 w-full rounded-md border border-line bg-surface px-3 font-mono text-sm text-ink" />
      </div> : null}
    </section>
  );
}
