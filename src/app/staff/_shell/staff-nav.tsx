"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3, BookOpen, ChevronsUpDown, ClipboardCheck, FileUp, GraduationCap, LayoutDashboard, LogOut, Menu as MenuIcon,
  PhoneCall, Search, ShieldCheck, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { api, ApiError, newIdemKey } from "@/lib/client-api";
import { Dialog as NavigationDialog } from "radix-ui";
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
  const [logoutError, setLogoutError] = useState("");
  const logoutKey = useRef<string | null>(null);
  useEffect(() => { setOpen(false); }, [path]); // eslint-disable-line react-hooks/set-state-in-effect -- close drawer on navigation
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  const active = (h: string) => (h === "/staff" ? path === "/staff" : path.startsWith(h) || h === "/staff/students" && path.startsWith("/staff/enrolments") || h === "/staff/reports" && path.startsWith("/staff/metrics"));
  const groups = GROUPS(isSuper);
  const current = groups.flatMap((g) => g.items).find((i) => active(i.href));

  async function logout() {
    try {
      logoutKey.current ??= newIdemKey();
      await api("/api/staff/auth/logout", { method: "POST", body: {}, idempotencyKey: logoutKey.current });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) { setLogoutError(error instanceof Error ? error.message : "Could not sign out. Please retry."); return; }
    }
    router.replace("/staff/login"); router.refresh();
  }

  const nav = (
    <nav aria-label="Staff navigation" className="staff-navigation flex h-full min-h-0 flex-col pt-[env(safe-area-inset-top)]">
      <div className="staff-brand flex shrink-0 items-center gap-3 border-b border-white/10 px-6">
        <Image src="/brand/t2t-logo.png" alt="" width={40} height={40} className="rounded-lg bg-white p-1" />
        <div className="leading-tight"><p className="text-base font-semibold tracking-tight text-white">T2T Operations</p><p className="mt-1 text-xs text-inv-muted">Student payments</p></div>
      </div>
      <div className="staff-nav-groups min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {groups.map(group => <div key={group.title}>
          <p className="staff-group-label px-3 text-xs font-semibold uppercase tracking-[0.1em] text-inv-muted">{group.title}</p>
          <ul className="staff-nav-links">{group.items.map(item => {
            const on = active(item.href);
            return <li key={item.href}><Link href={item.href} aria-current={on ? "page" : undefined} className={cn("group flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors", on ? "bg-[#c6f0df] font-semibold text-[#123c35] shadow-sm" : "text-inv-muted hover:bg-white/5 hover:text-white")}><item.icon className={cn("size-5 shrink-0", on ? "text-[#123c35]" : "text-inv-muted group-hover:text-white")} />{item.label}</Link></li>;
          })}</ul>
        </div>)}
      </div>
      {logoutError ? <p role="alert" className="mx-4 mb-3 text-sm text-[#ffd5d5]">{logoutError}</p> : null}
      <div className="staff-account shrink-0 border-t border-white/10">
        <Menu><MenuTrigger className="staff-account-trigger btn flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-white/5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-white">{initials(name)}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-white">{name}</span><span className="mt-1 flex items-center gap-1 text-xs text-inv-muted"><ShieldCheck className="size-3" />{role}</span></span><ChevronsUpDown className="size-4 text-inv-muted" />
        </MenuTrigger><MenuContent align="start"><div className="px-3 py-2"><p className="text-sm font-medium">{name}</p><p className="truncate text-xs text-muted">{email}</p></div><MenuSeparator /><MenuItem onSelect={logout} danger><LogOut className="size-4" />Sign out</MenuItem></MenuContent></Menu>
      </div>
    </nav>
  );

  return (
    <NavigationDialog.Root open={open} onOpenChange={setOpen}>
      <div className="min-h-dvh bg-bg">
        <a href="#workspace-content" className="skip-content">Skip to content</a>
        <aside className="on-dark fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-white/10 bg-inv lg:block">{nav}</aside>
        <NavigationDialog.Portal>
          <NavigationDialog.Overlay className="fixed inset-0 z-40 bg-[#071f24]/60 backdrop-blur-sm lg:hidden" />
          <NavigationDialog.Content aria-describedby={undefined} className="on-dark fixed inset-y-0 left-0 z-50 w-[min(320px,90vw)] bg-inv shadow-lg focus:outline-none lg:hidden">
            <NavigationDialog.Title className="sr-only">Staff menu</NavigationDialog.Title>
            <NavigationDialog.Close aria-label="Close menu" className="staff-menu-close btn absolute right-3 z-10 grid size-11 place-items-center rounded-md text-inv-muted hover:bg-white/10"><X className="size-5" /></NavigationDialog.Close>
            {nav}
          </NavigationDialog.Content>
        </NavigationDialog.Portal>
        <div className="lg:pl-64">
          <div className="staff-toolbar sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-line bg-card px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <NavigationDialog.Trigger asChild><button aria-label="Open menu" className="btn grid size-11 shrink-0 place-items-center rounded-md border border-line lg:hidden"><MenuIcon className="size-5" /></button></NavigationDialog.Trigger>
              <div className="min-w-0 text-sm"><span className="hidden text-muted sm:inline">Workspace <span className="mx-3 text-line-strong">/</span></span><span className="font-medium">{current?.label ?? "T2T Operations"}</span></div>
            </div>
            <div className="flex shrink-0 items-center gap-3 sm:gap-5">
              <Link href="/staff/students" className="btn hidden min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm text-muted hover:border-accent hover:text-accent sm:inline-flex"><Search className="size-4" />Find a student</Link>
              <span className="hidden border-l border-line pl-5 text-xs text-muted md:inline-flex md:items-center md:gap-2"><ShieldCheck className="size-4 text-accent" />{role}</span>
              <span aria-label={name} className="grid size-9 place-items-center rounded-full border border-accent/15 bg-accent-soft text-xs font-semibold text-accent">{initials(name)}</span>
            </div>
          </div>
          <div id="workspace-content" tabIndex={-1} className="outline-none">{children}</div>
        </div>
      </div>
    </NavigationDialog.Root>
  );
}
