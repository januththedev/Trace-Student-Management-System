"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3, BookOpen, ChevronsUpDown, ClipboardCheck, FileUp, GraduationCap, LayoutDashboard, LogOut, Menu as MenuIcon,
  PhoneCall, ShieldCheck, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { api } from "@/lib/client-api";
import { cn } from "@/lib/cn";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/kit";

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
const GROUPS = (isSuper: boolean): { title: string; items: Item[] }[] => [
  { title: "Operations", items: [
    { href: "/staff", label: "Command centre", icon: LayoutDashboard },
    { href: "/staff/review", label: "Receipt review", icon: ClipboardCheck },
    { href: "/staff/calls", label: "Calls & follow-ups", icon: PhoneCall },
  ] },
  { title: "Records", items: [
    { href: "/staff/students", label: "Students", icon: GraduationCap },
    { href: "/staff/admissions", label: "Admissions", icon: UserPlus },
    { href: "/staff/programmes", label: "Programmes", icon: BookOpen },
    { href: "/staff/imports", label: "Imports", icon: FileUp },
    { href: "/staff/reports", label: "Reports", icon: BarChart3 },
  ] },
  ...(isSuper ? [{ title: "Administration", items: [
    { href: "/staff/team", label: "Staff", icon: Users },
    { href: "/staff/trash", label: "Trash", icon: Trash2 },
  ] }] : []),
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
}

export function StaffShell({ children, name, email, role, isSuper }: { children: React.ReactNode; name: string; email: string; role: string; isSuper: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [path]); // eslint-disable-line react-hooks/set-state-in-effect -- close drawer on navigation
  const active = (h: string) => (h === "/staff" ? path === "/staff" : path.startsWith(h) || h === "/staff/students" && path.startsWith("/staff/enrolments") || h === "/staff/reports" && path.startsWith("/staff/metrics"));
  const groups = GROUPS(isSuper);
  const current = groups.flatMap((g) => g.items).find((i) => active(i.href));

  async function logout() {
    try { await api("/api/staff/auth/logout", { method: "POST", body: {} }); } catch { /* already signed out */ }
    router.replace("/staff/login");
    router.refresh();
  }

  const nav = (
    <nav aria-label="Staff navigation" className="flex h-full flex-col pt-[env(safe-area-inset-top)]">
      <div className="flex h-16 items-center gap-3 px-5">
        <Image src="/brand/t2t-logo.png" alt="" width={32} height={32} className="rounded-lg bg-white p-0.5 ring-1 ring-white/20" />
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">T2T Operations</p>
          <p className="text-xs text-inv-muted">Student payments</p>
        </div>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 py-4">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-inv-muted/80">{g.title}</p>
            <ul className="space-y-0.5">
              {g.items.map((i) => {
                const on = active(i.href);
                return (
                  <li key={i.href}>
                    <Link href={i.href} aria-current={on ? "page" : undefined}
                      className={cn("group flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
                        on ? "bg-white/[0.09] font-medium text-white shadow-[inset_2px_0_0_0_#5fd0d8]" : "text-inv-muted hover:bg-white/[0.05] hover:text-white")}>
                      <i.icon className={cn("size-[18px]", on ? "text-[#5fd0d8]" : "text-inv-muted group-hover:text-white")} />
                      {i.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Menu>
          <MenuTrigger className="btn flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-white/[0.06]">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-white">{initials(name)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-white">{name}</span>
              <span className="flex items-center gap-1 text-xs text-inv-muted"><ShieldCheck className="size-3" />{role}</span>
            </span>
            <ChevronsUpDown className="size-4 text-inv-muted" />
          </MenuTrigger>
          <MenuContent align="start">
            <div className="px-3 py-2"><p className="text-sm font-medium">{name}</p><p className="truncate text-xs text-muted">{email}</p></div>
            <MenuSeparator />
            <MenuItem onSelect={logout} danger><LogOut className="size-4" /> Sign out</MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh bg-bg">
      <aside className="on-dark fixed inset-y-0 left-0 z-30 hidden w-64 bg-gradient-to-b from-[#0f1f26] to-[#13282f] lg:block">{nav}</aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label="Close menu" className="absolute inset-0 bg-inv/50" onClick={() => setOpen(false)} />
          <aside className="on-dark absolute inset-y-0 left-0 w-72 bg-gradient-to-b from-[#0f1f26] to-[#13282f] shadow-lg animate-in">
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-3 top-3 grid size-11 place-items-center rounded-md text-inv-muted hover:bg-white/10"><X className="size-5" /></button>
            {nav}
          </aside>
        </div>
      ) : null}
      <div className="lg:pl-64">
        <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-card/85 px-4 backdrop-blur-md lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} className="btn grid size-11 place-items-center rounded-md border border-line"><MenuIcon className="size-5" /></button>
          <span className="font-semibold">{current?.label ?? "T2T Operations"}</span>
        </div>
        {children}
      </div>
    </div>
  );
}
