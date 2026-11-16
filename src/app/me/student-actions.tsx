"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";

export function StudentActions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // Prevent prior financial content reappearing from the back-forward cache after logout.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) window.location.reload(); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  async function leave(forgetDevice: boolean) {
    setBusy(true);
    try { await api("/api/student/logout", { method: "POST", body: { forgetDevice } }); } catch { /* session may already be gone */ }
    if (forgetDevice) { try { localStorage.removeItem("t2t:lastIntake"); sessionStorage.clear(); } catch { /* ignore */ } }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button onClick={() => leave(false)} disabled={busy} className="btn min-h-11 rounded-md border border-white/30 px-4 text-sm font-medium hover:bg-white/10" title="Ends this session. A remembered device stays remembered.">Log out</button>
      <button onClick={() => leave(true)} disabled={busy} className="btn min-h-11 rounded-md bg-white px-4 text-sm font-medium text-ink hover:bg-accent-soft">Forget this device</button>
    </div>
  );
}
