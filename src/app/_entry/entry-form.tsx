"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Fingerprint, Loader2, LockKeyhole, Receipt, ShieldCheck } from "lucide-react";
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
    <main className="entry-page relative isolate flex min-h-dvh flex-col overflow-hidden bg-inv text-white">
      <Image key={banner} src={banner} alt="" fill priority sizes="100vw" onError={() => setBannerOk(false)} className="-z-20 object-cover opacity-45 blur-[2px]" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0a282d]/95 via-[#0a282d]/80 to-[#0a282d]/60" />
      <div aria-hidden className="brand-orbit absolute -bottom-36 -left-28 hidden lg:block" />
      <header className="mx-auto flex w-full max-w-[1360px] items-center justify-between gap-4 px-5 py-6 sm:px-8 lg:px-12">
        <div className="flex items-center gap-3">
          <Image src="/brand/t2t-logo.png" alt="T2T" width={42} height={42} className="rounded-lg bg-white p-1" />
          <div><span className="block text-base font-semibold tracking-tight">T2T</span><span className="block text-xs text-white/65">Student payment portal</span></div>
        </div>
        <a href="/staff" className="btn inline-flex min-h-11 items-center gap-2 rounded-md border border-white/20 px-4 text-sm text-white/90 hover:bg-white/10">Staff sign in <ArrowUpRight className="size-4" /></a>
      </header>

      <div className="entry-layout mx-auto grid w-full max-w-[1360px] flex-1 grid-cols-1 items-center gap-8 px-5 pb-8 pt-4 sm:px-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-16 lg:px-12 lg:py-14">
        <section className="min-w-0">
          <p className="mb-5 flex items-center gap-2 text-sm text-[#a5e6d5]"><span className="size-1.5 rounded-full bg-[#a5e6d5]" />Your student payment space</p>
          <h1 className="entry-heading max-w-2xl text-white">{selected ? selected.programmeName : <><span className="lg:hidden">Your course<br /><span className="text-[#a5e6d5]">payments, clearly.</span></span><span className="hidden lg:inline">Your course.<br />Your payments.<br /><span className="text-[#a5e6d5]">One clear view.</span></span></>}</h1>
          <p className="mt-6 max-w-md text-base leading-relaxed text-white/75 sm:text-lg">{selected ? selected.intakeLabel : "Your schedule, bank receipts and payment decisions, together."}</p>
          <div className="entry-benefits mt-10 hidden max-w-md grid-cols-2 gap-6 border-t border-white/20 pt-6 lg:grid">
            <div><Receipt className="mb-3 size-5 text-[#a5e6d5]" /><p className="text-sm font-medium">Your full payment picture</p><p className="mt-1 text-sm leading-relaxed text-white/60">Instalments, receipts and review decisions.</p></div>
            <div><LockKeyhole className="mb-3 size-5 text-[#a5e6d5]" /><p className="text-sm font-medium">A private course record</p><p className="mt-1 text-sm leading-relaxed text-white/60">Only the enrolment you choose opens.</p></div>
          </div>
        </section>

        <div className="entry-panel on-dark min-w-0 w-full rounded-2xl border border-white/20 bg-[#112e34]/90 p-6 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:p-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div><p className="mb-2 text-xs font-medium tracking-wide text-[#a5e6d5]">Let&apos;s get you in</p><h2 className="text-2xl font-semibold tracking-tight text-white sm:text-[26px]">Open your enrolment</h2><p className="mt-2 text-sm leading-relaxed text-white/65">{fixedIntakeId ? "Enter your NIC number to open this enrolment." : "Choose your course, then enter your NIC number."}</p></div>
            <span className="hidden size-11 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/5 sm:grid"><Fingerprint className="size-5 text-[#a5e6d5]" /></span>
          </div>
          <form onSubmit={submit} noValidate className="space-y-5">
            {fixedIntakeId ? <div className="rounded-lg border border-white/15 bg-white/5 p-4"><p className="text-xs text-white/60">Programme and intake</p><p className="mt-1 font-medium">{selected ? `${selected.programmeName} - ${selected.intakeLabel}` : "Selected intake"}</p></div> : <div className="space-y-2">
              <label htmlFor="intake" className="block text-sm font-medium text-white/90">Course and intake</label>
              <Select id="intake" dark value={intakeId} onValueChange={setIntakeId} placeholder="Select your course..." options={courses.map(c => ({ value: c.intakeId, label: `${c.programmeName} - ${c.intakeLabel}` }))} />
            </div>}
            {useDevice && device && !fixedIntakeId ? <div className="rounded-lg border border-white/15 bg-white/5 p-4"><p className="text-xs text-white/60">Continue as</p><p className="mt-1 font-mono text-xl tracking-[0.18em]">{device.maskedNic}</p><button type="button" onClick={() => setUseDevice(false)} className="u-draw mt-2 min-h-11 text-sm text-[#a5e6d5]">Use a different NIC</button></div> : <div className="space-y-4">
              <div className="space-y-2"><label htmlFor="nic" className="block text-sm font-medium text-white/90">NIC number</label><input id="nic" name="nic" inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={nic} onChange={e => setNic(e.target.value)} placeholder="199912345678 or 991234567V" className="block min-h-12 w-full rounded-md border border-white/25 bg-white/5 px-3.5 font-mono text-base tracking-wide text-white outline-none placeholder:text-white/45 focus:border-[#a5e6d5] focus:ring-4 focus:ring-[#a5e6d5]/10" /></div>
              <Checkbox id="remember" dark checked={remember} onCheckedChange={setRemember} label="Remember on this device" description="Only on your own phone or computer - not on shared devices." />
            </div>}
            {error ? <p role="alert" className="rounded-md border border-[#ff8a8a]/40 bg-[#b42318]/30 px-3.5 py-3 text-sm">{error}</p> : null}
            {notice ? <p role="status" className="rounded-md bg-white/10 px-3.5 py-3 text-sm">{notice}</p> : null}
            <button type="submit" disabled={busy} className="btn flex min-h-13 w-full items-center justify-between gap-3 rounded-md bg-[#c6f0df] px-5 text-base font-semibold text-[#123c35] hover:bg-[#def8ec] disabled:opacity-60"><span className="flex items-center gap-2">{busy ? <Loader2 className="size-4 animate-spin" /> : null}{busy ? "Checking..." : "Continue"}</span><ArrowRight className="size-5" /></button>
          </form>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-white/15 pt-4 text-sm text-white/70">{device ? <button type="button" onClick={forget} disabled={busy} className="u-draw min-h-11">Forget this device</button> : <span className="inline-flex items-center gap-2 text-xs text-white/65"><ShieldCheck className="size-4" />No password or code is needed.</span>}{signedIn ? <a href="/me" className="u-draw min-h-11 leading-11">Back to my open enrolment</a> : null}</div>
        </div>
      </div>
      <footer className="mx-auto flex w-full max-w-[1360px] flex-wrap justify-between gap-3 px-5 pb-6 text-xs text-white/55 sm:px-8 lg:px-12"><span>T2T Student Operations</span><span>One enrolment. One clear payment record.</span></footer>
    </main>
  );
}
