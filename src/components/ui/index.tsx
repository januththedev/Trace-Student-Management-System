import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Inbox, XCircle } from "lucide-react";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ buttons */
type Variant = "primary" | "secondary" | "danger" | "ghost" | "dark";
type Size = "sm" | "md" | "lg";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-white shadow-sm hover:bg-accent-strong",
  secondary: "border border-line bg-card text-ink shadow-xs hover:border-line-strong hover:bg-surface/60",
  danger: "bg-bad text-white shadow-sm hover:bg-[#a11f25]",
  ghost: "text-ink-2 hover:bg-surface hover:text-ink",
  dark: "bg-ink text-white shadow-sm hover:bg-ink-2",
};
const sizes: Record<Size, string> = { sm: "min-h-9 px-3 text-sm", md: "min-h-11 px-4 text-sm", lg: "min-h-12 px-5 text-[15px]" };
const base = "btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

export function Button({ variant = "primary", size = "md", className, ...p }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button {...p} className={cn(base, variants[variant], sizes[size], className)} />;
}

export function ButtonLink({ variant = "primary", size = "md", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link {...p} className={cn(base, variants[variant], sizes[size], className)} />;
}

/* -------------------------------------------------------------------- cards */
export function Card({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cn("rounded-xl border border-line bg-card shadow-[0_2px_8px_-4px_rgba(15,31,38,0.08)]", className)} />;
}

export function CardHeader({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-5">
      <div className="flex min-w-0 items-start gap-3">
        {icon ? <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent [&_svg]:size-[18px]">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

export function SectionTitle({ children, action, description }: { children: ReactNode; action?: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold">{children}</h2>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Money({ minor, className, strong }: { minor: number; className?: string; strong?: boolean }) {
  return <span className={cn("tabular whitespace-nowrap", strong && "font-semibold", className)}>{formatMinor(minor)}</span>;
}

/* ------------------------------------------------------------------- badges */
type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "accent";
const tones: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok ring-ok/15", warn: "bg-warn-soft text-warn ring-warn/15", bad: "bg-bad-soft text-bad ring-bad/15",
  info: "bg-info-soft text-info ring-info/15", neutral: "bg-surface text-ink-2 ring-line-strong/60", accent: "bg-accent-soft text-accent-strong ring-accent/15",
};
const dots: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info", neutral: "bg-muted", accent: "bg-accent" };

export function Badge({ tone = "neutral", children, className, dot = true }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {dot ? <span className={cn("size-1.5 rounded-full", dots[tone])} /> : null}{children}
    </span>
  );
}

const instalmentTone: Record<string, [Tone, string]> = {
  UPCOMING: ["neutral", "Upcoming"], DUE_TODAY: ["warn", "Due today"], OVERDUE: ["bad", "Overdue"], PARTIALLY_PAID: ["info", "Partially paid"],
  PAID: ["ok", "Paid"], EXEMPT: ["accent", "Exempt"], CANCELLED: ["neutral", "Cancelled"],
};
/** Settlement status (deliberately separate from review status). */
export function InstalmentBadge({ state, partial }: { state: string; partial?: boolean }) {
  const [tone, label] = instalmentTone[state] ?? ["neutral", state];
  return <span className="inline-flex flex-wrap gap-1"><Badge tone={tone}>{label}</Badge>{partial && state !== "PARTIALLY_PAID" ? <Badge tone="info">Part paid</Badge> : null}</span>;
}

const reviewTone: Record<string, [Tone, string]> = { PENDING_REVIEW: ["warn", "Under review"], APPROVED: ["ok", "Approved"], REJECTED: ["bad", "Rejected"] };
export function ReviewBadge({ status }: { status: string }) {
  const [tone, label] = reviewTone[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

/* -------------------------------------------------------------------- stats */
export function Stat({ label, minor, value, tone, href, hint, icon }: { label: string; minor?: number; value?: ReactNode; tone?: Tone; href?: string; hint?: string; icon?: ReactNode }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-[13px] font-medium text-muted">{label}</span>
        {icon ? <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4", tone ? tones[tone] : "bg-surface text-ink-2")}>{icon}</span> : null}
      </div>
      <div className={cn("mt-4 font-semibold tracking-[-0.04em] tabular", minor !== undefined ? "text-lg sm:text-2xl" : "text-xl sm:text-[28px]", tone === "bad" && "text-bad", tone === "warn" && "text-warn", tone === "ok" && "text-ok")}>
        {minor !== undefined ? <Money minor={minor} /> : value}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </>
  );
  const cls = "block min-w-0 rounded-xl border border-line bg-card p-4 shadow-xs sm:p-5";
  return href ? <Link href={href} className={cn(cls, "lift")}>{body}</Link> : <div className={cls}>{body}</div>;
}

/* -------------------------------------------------------------- empty/field */
export function EmptyState({ title, children, icon, action }: { title: string; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-card px-6 py-12 text-center">
      <span className="mb-3 grid size-12 place-items-center rounded-full bg-surface text-muted [&_svg]:size-5">{icon ?? <Inbox />}</span>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 max-w-sm text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-2">{label}</label>
      {children}
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export const inputCls = "block w-full min-w-0 min-h-11 rounded-md border border-line bg-card px-3 text-[15px] text-ink shadow-xs placeholder:text-muted/80 transition-[border-color,box-shadow] hover:border-line-strong focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent-ring";

const alertIcon: Record<Tone, ReactNode> = { ok: <CheckCircle2 />, warn: <AlertTriangle />, bad: <XCircle />, info: <Info />, neutral: <Info />, accent: <Info /> };
export function Alert({ tone = "info", children, title }: { tone?: Tone; children: ReactNode; title?: ReactNode }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg px-4 py-3 text-sm ring-1 ring-inset [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0", tones[tone])}>
      {alertIcon[tone]}
      <div className="min-w-0">{title ? <p className="font-semibold">{title}</p> : null}<div>{children}</div></div>
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("staff-page-body mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8", className)}>{children}</main>;
}
