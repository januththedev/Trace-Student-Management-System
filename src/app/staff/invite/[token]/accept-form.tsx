"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authInputCls, authButtonCls } from "../../_shell/auth-frame";
import { postStaff } from "../../login/request";

export default function AcceptForm({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (data.get("password") !== data.get("confirm")) { setError("The passwords do not match."); return; }
    setBusy(true); setError("");
    try { await postStaff("/api/staff/team/accept", { token, password: data.get("password") }); setDone(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  if (done) return <div role="status"><h2 className="text-xl font-semibold text-white">Your account is ready</h2><p className="my-4 text-white/65">Sign in using your invited email and new password.</p><Link href="/staff/login" className="inline-flex min-h-12 items-center rounded-lg bg-accent px-5 font-semibold text-inv-ink focus-visible:ring-4 focus-visible:ring-accent/30">Continue to sign in</Link></div>;
  return <form onSubmit={submit} className="mt-8 space-y-5" aria-busy={busy}>
    <div><label htmlFor="password" className="mb-2 block text-sm font-medium text-white/90">Choose a password</label><input id="password" name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" required aria-describedby="password-help" className={authInputCls} /><p id="password-help" className="mt-2 text-xs text-white/60">Use at least 12 characters.</p></div>
    <div><label htmlFor="confirm" className="mb-2 block text-sm font-medium text-white/90">Confirm password</label><input id="confirm" name="confirm" type="password" minLength={12} maxLength={256} autoComplete="new-password" required className={authInputCls} /></div>
    {error && <p role="alert" className="rounded-lg bg-bad-soft p-3 text-bad">{error}</p>}
    <button disabled={busy} className={authButtonCls}>{busy ? "Creating your account…" : "Accept invitation"}</button>
  </form>;
}
