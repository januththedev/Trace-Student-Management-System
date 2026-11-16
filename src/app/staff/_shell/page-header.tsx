import type { ReactNode } from "react";

export function PageHeader({ title, sub, actions, eyebrow }: { title: string; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="border-b border-line bg-card">
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-end justify-between gap-4 px-4 py-6 sm:px-6 lg:px-8">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-accent">{eyebrow}</div> : null}
          <h1 className="display text-2xl sm:text-[28px]">{title}</h1>
          {sub ? <p className="mt-1 max-w-3xl text-sm text-muted">{sub}</p> : null}
        </div>
        {actions ? <div className="flex w-full flex-wrap gap-2 sm:w-auto">{actions}</div> : null}
      </div>
    </header>
  );
}
