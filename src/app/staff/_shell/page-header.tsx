import type { ReactNode } from "react";

export function PageHeader({ title, sub, actions, eyebrow }: { title: string; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="bg-bg">
      <div className="staff-page-heading mx-auto flex w-full max-w-[1400px] flex-wrap items-end justify-between gap-4 px-4 pb-2 pt-7 sm:px-6 lg:px-8 lg:pt-9">
        <div className="min-w-0">
          <div className="eyebrow mb-2 text-accent">{eyebrow ?? "T2T workspace"}</div>
          <h1 className="display text-[28px] leading-tight sm:text-[34px]">{title}</h1>
          {sub ? <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{sub}</p> : null}
        </div>
        {actions ? <div className="flex w-full flex-wrap gap-2 sm:w-auto">{actions}</div> : null}
      </div>
    </header>
  );
}
