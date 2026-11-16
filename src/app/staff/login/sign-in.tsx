"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { authInputCls, authButtonCls } from "../_shell/auth-frame";
import { postStaff } from "./request";

export default function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      await postStaff("/api/staff/auth/login", { email: form.get("email"), password: form.get("password") });
      router.replace("/staff"); router.refresh();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
    <div><label htmlFor="email" className="mb-2 block text-sm font-medium text-white/90">Work email</label><input id="email" name="email" type="email" required autoComplete="username" autoCapitalize="none" spellCheck={false} enterKeyHint="next" maxLength={254} className={authInputCls} placeholder="you@t2t.lk" /></div>
    <div>
      <label htmlFor="password" className="mb-2 block text-sm font-medium text-white/90">Password</label>
      <div className="relative">
        <input id="password" name="password" type={showPassword ? "text" : "password"} required autoComplete="current-password" autoCapitalize="none" spellCheck={false} enterKeyHint="go" maxLength={256} className={`${authInputCls} pr-14`} aria-describedby={capsLock ? "caps-lock-hint" : undefined} onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} />
        <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-controls="password" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 flex min-h-11 min-w-12 items-center justify-center rounded-r-lg text-white/65 transition-colors hover:bg-white/10 hover:text-white">
          {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
        </button>
      </div>
      {capsLock && <p id="caps-lock-hint" role="status" className="mt-2 text-xs text-amber-200">Caps Lock is on.</p>}
    </div>
    {error && <p role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-3 text-sm text-bad">{error}</p>}
    <button disabled={busy} className={authButtonCls}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{busy ? "Signing in…" : "Sign in to your workspace"}{!busy && <ArrowRight className="size-4" />}</button>
    <p className="text-xs leading-6 text-white/60">Access is by invitation. Contact your Super Admin if you need an account or help signing in.</p>
  </form>;
}
