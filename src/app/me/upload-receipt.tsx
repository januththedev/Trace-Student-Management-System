"use client";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Send, Wallet } from "lucide-react";
import { Alert, Button, Card, Field, inputCls } from "@/components/ui";
import { DatePicker, FileDrop, Select, toast } from "@/components/ui/kit";
import { api, ApiError, newIdemKey } from "@/lib/client-api";
import { formatMinor, parseMajorToMinor } from "@/lib/money";

interface Opt { id: string; label: string; remainingMinor: number; pendingMinor: number }
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const MAX = 10 * 1024 * 1024;

function todayColombo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
}

export function UploadReceipt({ options, suggestedId, creditMinor, rejected }: { options: Opt[]; suggestedId: string | null; creditMinor: number; rejected: { id: string; label: string }[] }) {
  const router = useRouter();
  const [target, setTarget] = useState(suggestedId ?? options[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayColombo());
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [replaces, setReplaces] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<"idle" | "uploading" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const idem = useRef(newIdemKey()); // stable across retries of the same submission
  const sel = useMemo(() => options.find((o) => o.id === target), [options, target]);

  function pickFile(f: File | null) {
    setError(null);
    if (f && !ACCEPT.split(",").includes(f.type)) { setError("Use a JPEG, PNG, WebP or PDF file."); return; }
    if (f && f.size > MAX) { setError("The file must be 10 MB or smaller."); return; }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const claimed = parseMajorToMinor(amount);
    if (!target) return setError("Choose the instalment you paid for.");
    if (!claimed || claimed <= 0) return setError("Enter the amount you transferred, e.g. 4000 or 4,000.00.");
    if (!date || date > todayColombo()) return setError("The transfer date cannot be in the future.");
    if (!file) return setError("Attach the receipt file.");
    try {
      setStep("uploading");
      const intent = await api<{ intentId: string }>("/api/student/uploads", { method: "POST", body: { mime: file.type, sizeBytes: file.size } });
      await api(`/api/student/uploads/${intent.intentId}`, { method: "PUT", raw: file, contentType: file.type });
      setStep("saving");
      const res = await api<{ warnings: string[] }>("/api/student/submissions", {
        method: "POST", idempotencyKey: idem.current,
        body: { intentId: intent.intentId, targetInstalmentId: target, claimedMinor: claimed, transferDate: date, bankReference: ref || undefined, studentNote: note || undefined, supersedesSubmissionId: replaces || undefined },
      });
      setWarnings(res.warnings ?? []);
      setStep("done");
      toast.success("Receipt submitted for review");
      idem.current = newIdemKey();
      setAmount(""); setRef(""); setNote(""); setFile(null); setReplaces("");
      router.refresh();
    } catch (err) {
      setStep("idle");
      if (err instanceof ApiError && err.status === 401) { setError("Your session ended before the upload finished. Please enter again; nothing was submitted."); return; }
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    }
  }

  if (step === "done") {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-ok-soft text-ok"><CheckCircle2 className="size-7" /></span>
        <p className="text-lg font-semibold">Receipt submitted. Staff will review it.</p>
        <p className="max-w-sm text-sm text-muted">{warnings.length ? "Our team may contact you to confirm some details." : "You will see the decision here and in your notifications."}</p>
        <Button variant="secondary" onClick={() => setStep("idle")}>Upload another receipt</Button>
      </Card>
    );
  }

  return (
    <Card className="p-5 sm:p-6">
      {creditMinor > 0 ? <div className="mb-5"><Alert tone="accent" title="You have credit on this course">{formatMinor(creditMinor)} is already held for you. Staff can apply it to an instalment — check with the office before paying more.</Alert></div> : null}
      <form onSubmit={submit} className="grid gap-5 md:grid-cols-2" noValidate>
        <div className="md:col-span-2">
          <Field label="Instalment you paid for" htmlFor="target" hint="If one transfer covers several instalments, choose the first one. The reviewer splits it.">
            <Select id="target" value={target} onValueChange={setTarget}
              options={options.map((o) => ({ value: o.id, label: `${o.label}${o.id === suggestedId ? " · suggested" : ""}`, hint: `${formatMinor(o.remainingMinor)} remaining` }))} />
          </Field>
          {sel && sel.pendingMinor > 0 ? <div className="mt-2"><Alert tone="warn">A receipt of {formatMinor(sel.pendingMinor)} for this instalment is still under review. It is not counted as paid yet.</Alert></div> : null}
        </div>
        <Field label="Amount transferred (LKR)" htmlFor="amount">
          <div className="relative">
            <Wallet className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={sel ? (sel.remainingMinor / 100).toFixed(2) : "0.00"} className={`${inputCls} pl-9 tabular`} />
          </div>
        </Field>
        <Field label="Transfer date" htmlFor="date">
          <DatePicker id="date" value={date} onChange={setDate} max={todayColombo()} />
        </Field>
        <Field label="Bank reference (optional)" htmlFor="ref">
          <input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} className={inputCls} />
        </Field>
        {rejected.length ? (
          <Field label="Replacing a rejected receipt? (optional)" htmlFor="replaces">
            <Select id="replaces" value={replaces} onValueChange={setReplaces}
              options={[{ value: "", label: "No, this is a new payment" }, ...rejected.map((r) => ({ value: r.id, label: r.label }))]} />
          </Field>
        ) : <div className="hidden md:block" />}
        <div className="md:col-span-2">
          <Field label="Receipt file" htmlFor="file">
            <FileDrop id="file" accept={ACCEPT} maxBytes={MAX} file={file} onFile={pickFile} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Note for staff (optional)" htmlFor="note">
            <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className={`${inputCls} py-2.5`} />
          </Field>
        </div>
        {error ? <div className="md:col-span-2"><Alert tone="bad">{error}</Alert></div> : null}
        <div className="flex justify-end md:col-span-2">
          <Button type="submit" size="lg" disabled={step !== "idle"} className="w-full sm:w-auto">
            {step === "idle" ? <Send /> : <Loader2 className="animate-spin" />}
            {step === "uploading" ? "Uploading file…" : step === "saving" ? "Checking and saving…" : "Submit receipt"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
