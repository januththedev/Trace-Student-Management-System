"use client";
import { Fingerprint } from "lucide-react";
import { Disclosure } from "@/components/ui/kit";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Search, Users } from "lucide-react";
import { Alert, Badge, Button, Card, CardHeader, EmptyState } from "@/components/ui";
import { toast } from "@/components/ui/kit";
import { api, newIdemKey } from "@/lib/client-api";
import type { searchStudents } from "@/server/services/directory";
import { Input } from "./form-parts";

type Result = Awaited<ReturnType<typeof searchStudents>>;

export function DirectorySearch({ initial }: { initial: Result }) {
  const [result, setResult] = useState(initial);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function search(body: { q?: string; nic?: string; cursor?: string }, append = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await api<Result>(body.nic ? "/api/staff/students/search" : "/api/staff/students", {
        method: "POST", body, idempotencyKey: newIdemKey(),
      });
      setResult(previous => ({ ...next, rows: append ? [...previous.rows, ...next.rows] : next.rows }));
      setQuery(body.q ?? "");
    } catch (e) { const m = e instanceof Error ? e.message : "Search failed. Try again."; setError(m); toast.error(m); }
    finally { pending.current = false; setBusy(false); }
  }

  function generalSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void search({ q: String(new FormData(e.currentTarget).get("q") ?? "").trim() });
  }

  function exactSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const nic = String(new FormData(form).get("nic") ?? "");
    void search({ nic });
    form.reset();
  }

  return <div className="space-y-5" aria-busy={busy}>
    <Card>
      <CardHeader icon={<Users />} title="Directory search" description="Find students by name, reference or phone" />
      <div className="p-5">
        <form method="post" onSubmit={generalSearch} className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1"><Input name="q" label="Search students" hint="Name, student reference or phone" /></div>
          <Button disabled={busy}><Search /> Find students</Button>
        </form>
      </div>
    </Card>
    <Disclosure className="rounded-lg border border-line bg-card p-4" title={<><Fingerprint aria-hidden className="size-4 text-accent" />Exact NIC search</>} triggerClassName="min-h-11 cursor-pointer font-medium">
      <form method="post" autoComplete="off" onSubmit={exactSearch} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1"><Input name="nic" label="Complete NIC" required hint="Exact match only. Identifiers stay out of URLs and saved browser storage." /></div>
        <Button disabled={busy}><Search /> Find exact match</Button>
      </form>
    </Disclosure>
    {error && <Alert tone="bad">{error}</Alert>}
    <p role="status" className="text-sm text-muted">{busy ? "Searching…" : `${result.count} people match in your scope`}</p>
    {result.rows.length ? <Card className="divide-y divide-line">
      {result.rows.map(student => <div className="flex flex-wrap items-start justify-between gap-3 p-4 transition-colors hover:bg-surface/60" key={student.id}>
        <div className="min-w-0">
          <Link className="u-draw inline-flex min-h-11 items-center font-medium text-accent" href={`/staff/students/${student.id}`}>{student.fullName}</Link>
          <p className="break-words text-sm text-muted">{student.ref} · {student.nicMasked ?? "Identifier unresolved"}</p>
          <p className="break-words text-sm">{student.phone ?? "No phone"} · {student.email ?? "No email"}</p>
          <div className="mt-2 space-y-1">{student.enrolments.map(enrolment => <p className="text-sm" key={enrolment.id}>{enrolment.programmeName} · {enrolment.intakeLabel}</p>)}</div>
        </div>
        <Badge tone={student.status === "ACTIVE" ? "ok" : "neutral"}>{student.status}</Badge>
      </div>)}
    </Card> : <EmptyState icon={<Users />} title="No matching students">Try another name, reference or phone.</EmptyState>}
    {result.nextCursor && <Button variant="secondary" disabled={busy} onClick={() => void search({ q: query, cursor: result.nextCursor! }, true)}>Load more students</Button>}
  </div>;
}
