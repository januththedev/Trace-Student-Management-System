"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Fingerprint, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import type { PublicIntake } from "@/server/services/catalog";
import { api, ApiError } from "@/lib/client-api";
import { Checkbox, Select } from "@/components/ui/kit";

const LAST_COURSE = "t2t:lastIntake"; // public course id only — never the NIC
const FALLBACK = "/banners/fallback.webp";
const NEUTRAL = "We could not find an eligible enrolment.";

export function EntryForm({ courses, device, signedIn = false, fixedIntakeId }: { courses: PublicIntake[]; device: { maskedNic: string; lastIntakeId: string | null } | null; signedIn?: boolean; fixedIntakeId?: string }) {
  const router = useRouter();
  const [intakeId, setIntakeId] = useState<string>(fixedIntakeId ?? device?.lastIntakeId ?? "");
  const [nic, setNic] = useState("");
  const [useDevice, setUseDevice] = useState<boolean>(!fixedIntakeId && !!device);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bannerOk, setBannerOk] = useState(true);

  useEffect(() => {
    if (fixedIntakeId || intakeId) return;
    try {
      const last = localStorage.getItem(LAST_COURSE);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; hydrate after mount
      if (last && courses.some((c) => c.intakeId === last)) setIntakeId(last);
    } catch { /* storage unavailable */ }
  }, [courses, fixedIntakeId, intakeId]);

  const selected = useMemo(() => courses.find((c) => c.intakeId === intakeId) ?? null, [courses, intakeId]);
  const banner = bannerOk && selected?.bannerPath ? selected.bannerPath : FALLBACK;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    if (!intakeId) { setError("Choose your course and intake."); return; }
    if (!useDevice && nic.trim().length < 10) { setError("Enter your NIC number."); return; }
    setBusy(true);
    try {
      if (useDevice) await api("/api/student/device-entry", { method: "POST", body: { intakeId } });
      else await api("/api/student/entry", { method: "POST", body: { nic, intakeId, remember } });
      try { localStorage.setItem(LAST_COURSE, intakeId); } catch { /* ignore */ }
      setNic("");
      router.replace("/me");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? err.message : err instanceof ApiError && err.status === 404 ? NEUTRAL : err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    try { await api("/api/student/logout", { method: "POST", body: { forgetDevice: true } }); } catch { /* best effort */ }
    try { localStorage.removeItem(LAST_COURSE); sessionStorage.clear(); } catch { /* ignore */ }
    if (fixedIntakeId) {
      try { localStorage.setItem(LAST_COURSE, fixedIntakeId); } catch { /* ignore */ }
    }
    setUseDevice(false); setNic(""); setIntakeId(fixedIntakeId ?? ""); setRemember(false); setBusy(false);
    setNotice("This device has been forgotten.");
    router.refresh();
  }

  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden text-white">
      <Image key={banner} src={banner} alt="" fill priority sizes="100vw" onError={() => setBannerOk(false)} className="-z-20 scale-110 object-cover blur-[6px]" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(120%_90%_at_30%_20%,rgba(9,40,46,0.55)_0%,rgba(8,20,25,0.88)_60%,rgba(6,14,18,0.96)_100%)]" />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 pt-6 sm:px-8">
        <div className="flex items-center gap-3">
          <Image src="/brand/t2t-logo.png" alt="T2T" width={36} height={36} className="rounded-lg bg-white p-0.5" />
          <span className="text-sm font-semibold tracking-wide">T2T Student Portal</span>
        </div>
        <a href="/staff" className="u-draw inline-flex min-h-11 items-center text-sm text-white/75 hover:text-white">Staff sign in</a>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[1.1fr_440px]">
        <section className="hidden lg:block">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur">
            <span className="size-1.5 rounded-full bg-[#5fd0d8]" /> Payments &amp; receipts
          </p>
          <h1 className="display max-w-xl text-5xl leading-[1.05] text-white">{selected ? selected.programmeName : "Your course payments, in one place."}</h1>
          <p className="mt-4 max-w-md text-lg text-white/70">{selected ? selected.intakeLabel : "Check your instalments, upload bank receipts and follow every review decision."}</p>
          <ul className="mt-8 space-y-3 text-sm text-white/75">
            <li className="flex items-center gap-3"><ShieldCheck className="size-4 text-[#5fd0d8]" /> Each course opens only its own payment record</li>
            <li className="flex items-center gap-3"><LockKeyhole className="size-4 text-[#5fd0d8]" /> Receipts are stored privately for staff review</li>
          </ul>
        </section>

        <div className="on-dark w-full rounded-2xl border border-white/15 bg-white/[0.08] p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:p-8">
          <div className="mb-6">
            <div className="mb-3 grid size-11 place-items-center rounded-xl bg-white/10 ring-1 ring-white/20"><Fingerprint className="size-5 text-[#5fd0d8]" /></div>
            <h2 className="text-2xl font-semibold text-white lg:hidden">{selected ? selected.programmeName : "View your enrolment"}</h2>
            <h2 className="hidden text-2xl font-semibold text-white lg:block">Open your enrolment</h2>
            <p className="mt-1 text-sm text-white/65">{fixedIntakeId ? "Enter your NIC number to open this enrolment." : "Choose your course, then enter your NIC number."}</p>
          </div>

          <form onSubmit={submit} noValidate className="space-y-5">
            {fixedIntakeId ? <div className="rounded-xl border border-white/15 bg-white/[0.06] p-4">
              <p className="text-xs uppercase tracking-wide text-white/60">Programme and intake</p>
              <p className="mt-1 font-medium">{selected ? `${selected.programmeName} — ${selected.intakeLabel}` : "Selected intake"}</p>
            </div> : <div className="space-y-1.5">
              <label htmlFor="intake" className="block text-sm font-medium text-white/90">Course and intake</label>
              <Select id="intake" dark value={intakeId} onValueChange={setIntakeId} placeholder="Select your course…"
                options={courses.map((c) => ({ value: c.intakeId, label: `${c.programmeName} — ${c.intakeLabel}` }))} />
            </div>}

            {useDevice && device && !fixedIntakeId ? (
              <div className="rounded-xl border border-white/15 bg-white/[0.06] p-4">
                <p className="text-xs uppercase tracking-wide text-white/60">Continue as</p>
                <p className="mt-1 font-mono text-xl tracking-[0.18em]">{device.maskedNic}</p>
                <button type="button" onClick={() => setUseDevice(false)} className="u-draw mt-2 text-sm text-[#8fe3e9]">Use a different NIC</button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor="nic" className="block text-sm font-medium text-white/90">NIC number</label>
                  <input id="nic" name="nic" inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false}
                    value={nic} onChange={(e) => setNic(e.target.value)} placeholder="199912345678 or 991234567V"
                    className="block min-h-12 w-full rounded-md border border-white/20 bg-white/10 px-3.5 font-mono text-base tracking-wider text-white placeholder:text-white/40 transition focus:border-white/70 focus:bg-white/15 focus:outline-none" />
                </div>
                <Checkbox id="remember" dark checked={remember} onCheckedChange={setRemember} label="Remember on this device" description="Only on your own phone or computer — not on shared devices." />
              </div>
            )}

            {error ? <p role="alert" className="rounded-lg border border-[#ff8a8a]/30 bg-[#b42318]/30 px-3.5 py-2.5 text-sm">{error}</p> : null}
            {notice ? <p role="status" className="rounded-lg bg-white/10 px-3.5 py-2.5 text-sm">{notice}</p> : null}

            <button type="submit" disabled={busy} className="btn flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-white text-[15px] font-semibold text-ink shadow-lg hover:bg-[#e6f6f7] disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}{busy ? "Checking…" : "Continue"}{busy ? null : <ArrowRight className="size-4" />}
            </button>
          </form>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4 text-sm text-white/70">
            {device ? <button type="button" onClick={forget} disabled={busy} className="u-draw min-h-10">Forget this device</button> : <span className="text-xs text-white/50">No password or code is needed.</span>}
            {signedIn ? <a href="/me" className="u-draw min-h-10 leading-10">Back to my open enrolment</a> : null}
          </div>
        </div>
      </div>
    </main>
  );
}
