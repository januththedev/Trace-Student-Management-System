"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check as CheckIcon, Eye, Loader2, Save } from "lucide-react";
import { Alert, Button, Field, inputCls } from "@/components/ui";
import { Checkbox as KitCheckbox, DatePicker, Select as KitSelect, toast } from "@/components/ui/kit";
import { api, ApiError, newIdemKey } from "@/lib/client-api";

export const value = (f: FormData, key: string) => String(f.get(key) ?? "").trim();

export function Input({ name, label, type = "text", initial = "", required = false, hint }: {
  name: string; label: string; type?: string; initial?: string; required?: boolean; hint?: string;
}) {
  const id = useId();
  if (type === "date") return <DateInput name={name} label={label} initial={initial} hint={hint} required={required} />;
  return <Field htmlFor={id} label={label} hint={hint}>
    <input id={id} name={name} type={type} defaultValue={initial} required={required} className={inputCls} />
  </Field>;
}

export function Select({ name, label, options, initial, required }: {
  name: string; label: string; options: { value: string; label: string }[]; initial?: string; required?: boolean;
}) {
  const id = useId();
  const [selected, setSelected] = useState(initial ?? options[0]?.value ?? "");
  return <Field htmlFor={id} label={label}>
    <KitSelect id={id} name={name} required={required} value={selected} onValueChange={setSelected} options={options} />
  </Field>;
}

export function DateInput({ name, label, initial = "", hint, required }: {
  name: string; label: string; initial?: string; hint?: string; required?: boolean;
}) {
  const id = useId();
  const [date, setDate] = useState(initial);
  const wrap = useRef<HTMLDivElement>(null);
  function change(v: string) {
    setDate(v);
    const form = wrap.current?.closest("form");
    if (form) setTimeout(() => form.dispatchEvent(new Event("change", { bubbles: true })), 0);
  }
  return <Field htmlFor={id} label={label} hint={hint}>
    <div ref={wrap}><DatePicker id={id} name={name} required={required} value={date} onChange={change} /></div>
  </Field>;
}

export function Check({ name, label, checked = false, value: checkValue }: {
  name: string; label: string; checked?: boolean; value?: string;
}) {
  const id = useId();
  const [on, setOn] = useState(checked);
  const wrap = useRef<HTMLDivElement>(null);
  function toggle(next: boolean) {
    setOn(next);
    const form = wrap.current?.closest("form");
    if (form) setTimeout(() => form.dispatchEvent(new Event("change", { bubbles: true })), 0);
  }
  return <div ref={wrap} className="min-h-11 py-1">
    <KitCheckbox id={id} checked={on} onCheckedChange={toggle} label={label} />
    {on ? <input type="hidden" name={name} value={checkValue ?? "on"} /> : null}
  </div>;
}

function message(e: unknown) {
  if (e instanceof ApiError && Array.isArray(e.details?.issues)) {
    return e.details.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`).join("; ");
  }
  return e instanceof Error ? e.message : "Unable to save. Try again.";
}

export function MutationForm({ url, method = "POST", build, label, children, previewUrl, renderPreview, onDone, livePreview = false }: {
  url: string; method?: string; build: (f: FormData) => unknown; label: string; children: ReactNode;
  previewUrl?: string; renderPreview?: (data: unknown) => ReactNode; onDone?: () => void; livePreview?: boolean;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const key = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [preview, setPreview] = useState<{ body: unknown; data: unknown } | null>(null);

  useEffect(() => () => { clearTimeout(timer.current); sequence.current++; }, []);

  async function fetchPreview(body: unknown, serial: number) {
    if (!previewUrl) return;
    setPreviewBusy(true);
    try {
      const data = await api<unknown>(previewUrl, { method: "POST", body });
      if (serial === sequence.current) { setPreview({ body, data }); setError(""); }
    } catch (e) {
      if (serial === sequence.current) setError(message(e));
    } finally {
      if (serial === sequence.current) setPreviewBusy(false);
    }
  }

  function change() {
    sequence.current++;
    clearTimeout(timer.current);
    setPreview(null);
    setPreviewBusy(false);
    key.current = undefined;
    setDone(false);
    setError("");
    if (livePreview && previewUrl) {
      const serial = sequence.current;
      timer.current = setTimeout(() => {
        if (!form.current?.checkValidity()) return;
        try { void fetchPreview(build(new FormData(form.current)), serial); }
        catch (e) { setError(message(e)); }
      }, 450);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    clearTimeout(timer.current);
    setError("");
    setDone(false);
    const fields = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const body = build(fields);
      if (previewUrl && !preview) { await fetchPreview(body, ++sequence.current); return; }
      key.current ??= newIdemKey();
      await api(url, { method, body: preview?.body ?? body, idempotencyKey: key.current });
      key.current = undefined;
      setPreview(null);
      setDone(true);
      toast.success("Saved successfully.");
      router.refresh();
      onDone?.();
    } catch (e) { const m = message(e); setError(m); toast.error(m); }
    finally { pending.current = false; setBusy(false); }
  }

  return <form method="post" autoComplete="off" ref={form} onSubmit={submit} onChange={change} className="space-y-4" aria-busy={busy || previewBusy}>
    <fieldset disabled={busy} className="space-y-4">{children}</fieldset>
    {error && <Alert tone="bad">{error}</Alert>}
    {done && <Alert tone="ok">Saved successfully.</Alert>}
    {previewBusy && <p role="status" className="text-sm text-muted">Updating impact preview…</p>}
    {preview && <div className="space-y-3 border-t border-line pt-4" aria-live="polite">
      {renderPreview?.(preview.data)}<p className="text-sm font-medium">Review this impact before confirming.</p>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || previewBusy}>
        {busy ? <Loader2 className="animate-spin" /> : preview ? <CheckIcon /> : previewUrl && !preview ? <Eye /> : <Save />}
        {busy ? "Please wait…" : previewUrl && !preview ? "Preview impact" : preview ? "Confirm change" : label}
      </Button>
      {preview && <Button type="button" variant="secondary" onClick={() => setPreview(null)}>Edit details</Button>}
    </div>
  </form>;
}
