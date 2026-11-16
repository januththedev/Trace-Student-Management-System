import Image from "next/image";
import Link from "next/link";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

export function AuthFrame({ children }: { children: ReactNode }) {
  return <main className="on-dark relative isolate flex min-h-dvh flex-col overflow-hidden bg-inv text-white">
    <Image src="/banners/fallback.webp" alt="" fill priority sizes="100vw" className="-z-20 object-cover opacity-40 blur-[6px]" />
    <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgba(13,116,128,0.3),rgba(8,20,25,0.9)_70%)]" />
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 pt-6 sm:px-8">
      <Link href="/" className="flex items-center gap-3 text-sm font-semibold"><Image src="/brand/t2t-logo.png" alt="T2T" width={36} height={36} className="rounded-lg bg-white p-0.5" />T2T Operations</Link>
      <Link href="/" className="u-draw inline-flex min-h-11 items-center text-sm text-white/75 hover:text-white">Student portal</Link>
    </header>
    <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-5 py-10 sm:px-8 lg:grid-cols-[1.1fr_440px]">
      <section className="hidden lg:block">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium"><ShieldCheck className="size-3.5 text-[#8fe3e9]" /> Your daily workspace</p>
        <h1 className="display max-w-lg text-5xl leading-[1.08] text-white">More clarity.<br />Better student support.</h1>
        <p className="mt-5 max-w-sm text-lg leading-relaxed text-white/70">Keep student records, payment reviews and follow-ups moving together.</p>
        <p className="mt-8 flex items-center gap-2 text-sm text-white/65"><LockKeyhole className="size-4 text-[#8fe3e9]" /> T2T staff access · Asia/Colombo</p>
      </section>
      <section className="w-full rounded-2xl border border-white/15 bg-white/[0.08] p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:p-8">
        <span className="mb-4 grid size-11 place-items-center rounded-xl bg-white/10 ring-1 ring-white/20"><LockKeyhole className="size-5 text-[#8fe3e9]" /></span>
        {children}
      </section>
    </div>
  </main>;
}

export const authInputCls = "min-h-12 w-full rounded-md border border-white/20 bg-white/10 px-3.5 text-base text-white shadow-xs outline-none placeholder:text-white/45 transition focus:border-white/70 focus:bg-white/15 focus:ring-4 focus:ring-white/10";
export const authButtonCls = "btn inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-white px-4 text-[15px] font-semibold text-ink shadow-sm hover:bg-[#e6f6f7] disabled:opacity-60";
