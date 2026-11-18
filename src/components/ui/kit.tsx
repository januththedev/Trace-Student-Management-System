"use client";
/**
 * T2T component kit (client). Radix primitives styled with the design tokens.
 * Use these instead of native <select>, <input type="date">, <input type="file">, <dialog>.
 */
import * as React from "react";
import { Select as RSelect, Dialog as RDialog, DropdownMenu as RMenu, Tabs as RTabs, Popover as RPopover, Checkbox as RCheckbox, Switch as RSwitch, Tooltip as RTooltip } from "radix-ui";
import { DayPicker, type DropdownProps } from "react-day-picker";
import "react-day-picker/style.css";
import { Toaster as SonnerToaster, toast } from "sonner";
import { Calendar, Check, ChevronDown, FileText, UploadCloud, X } from "lucide-react";
import { cn } from "@/lib/cn";

export { toast };

/* ------------------------------------------------------------------ select */
export interface SelectOption { value: string; label: React.ReactNode; hint?: React.ReactNode; disabled?: boolean }

export function Select({ id, value, onValueChange, options, placeholder = "Select…", name, disabled, required, className, "aria-label": ariaLabel, dark }: {
  id?: string; value: string; onValueChange: (v: string) => void; options: SelectOption[]; placeholder?: string; name?: string; disabled?: boolean; required?: boolean; className?: string; "aria-label"?: string; dark?: boolean;
}) {
  // Radix Select forbids empty-string item values; map "" <-> sentinel.
  const EMPTY = "__t2t_empty__";
  const hasEmpty = options.some((o) => o.value === "");
  return (
    <RSelect.Root value={value === "" ? (hasEmpty ? EMPTY : "") : value} onValueChange={(v) => onValueChange(v === EMPTY ? "" : v)} disabled={disabled} required={required}>
      {/* Submit the public value, never Radix's internal empty-item sentinel. */}
      {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
      <RSelect.Trigger id={id} aria-label={ariaLabel}
        className={cn("btn group flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 text-left text-[15px] shadow-xs outline-none",
          dark ? "border-white/20 bg-white/10 text-white data-[placeholder]:text-white/55 focus-visible:border-white" : "border-line bg-card text-ink data-[placeholder]:text-muted hover:border-line-strong focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-ring",
          className)}>
        <span className="min-w-0 flex-1 truncate"><RSelect.Value placeholder={placeholder} /></span>
        <RSelect.Icon><ChevronDown className="size-4 opacity-60 transition-transform group-data-[state=open]:rotate-180" /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={6}
          className="z-50 max-h-[min(380px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-card p-1 shadow-lg animate-in">
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value || EMPTY} value={o.value === "" ? EMPTY : o.value} disabled={o.disabled}
                className="relative flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-md py-2 pl-3 pr-8 text-sm text-ink outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-soft data-[state=checked]:font-medium">
                <div className="min-w-0">
                  <RSelect.ItemText>{o.label}</RSelect.ItemText>
                  {o.hint ? <div className="truncate text-xs text-muted">{o.hint}</div> : null}
                </div>
                <RSelect.ItemIndicator className="absolute right-2"><Check className="size-4 text-accent" /></RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/* ------------------------------------------------------------- date picker */
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

function CalendarDropdown({ options, value, onChange, disabled, "aria-label": ariaLabel }: DropdownProps) {
  return <Select aria-label={ariaLabel} value={String(value)} disabled={disabled} className="min-h-9 px-2 text-sm"
    options={(options ?? []).map(option => ({ value: String(option.value), label: option.label, disabled: option.disabled }))}
    onValueChange={next => onChange?.({ target: { value: next } } as React.ChangeEvent<HTMLSelectElement>)} />;
}

/** Business-date picker. Value is a YYYY-MM-DD string (Asia/Colombo business date). */
export function DatePicker({ id, value, onChange, max, min, placeholder = "Pick a date", name, className, required }: {
  id?: string; value: string; onChange: (v: string) => void; max?: string; min?: string; placeholder?: string; name?: string; className?: string; required?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild>
        <button id={id} type="button" className={cn("btn flex min-h-11 w-full items-center gap-2 rounded-md border border-line bg-card px-3 text-left text-[15px] shadow-xs hover:border-line-strong focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-ring focus-visible:outline-none", !value && "text-muted", className)}>
          <Calendar className="size-4 text-muted" />
          <span className="flex-1">{value ? fmtDate(value) : placeholder}</span>
          <ChevronDown className="size-4 opacity-60" />
        </button>
      </RPopover.Trigger>
      {name ? required ? <input aria-hidden="true" tabIndex={-1} className="sr-only" name={name} value={value} onChange={() => {}} required onInvalid={() => setOpen(true)} /> : <input type="hidden" name={name} value={value} /> : null}
      <RPopover.Portal>
        <RPopover.Content sideOffset={6} align="start" collisionPadding={16} className="z-50 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-card p-3 shadow-lg animate-in">
          <DayPicker mode="single" weekStartsOn={1} captionLayout="dropdown"
            components={{ Dropdown: CalendarDropdown }}
            selected={value ? fromIso(value) : undefined} defaultMonth={value ? fromIso(value) : undefined}
            startMonth={new Date(2015, 0)} endMonth={new Date(2035, 11)}
            disabled={[...(max ? [{ after: fromIso(max) }] : []), ...(min ? [{ before: fromIso(min) }] : [])]}
            onSelect={(d) => { if (d) { onChange(toIso(d)); setOpen(false); } }} />
          {!required && value ? <button type="button" className="btn mt-2 min-h-11 w-full rounded-md border-t border-line text-sm text-muted hover:bg-surface hover:text-ink" onClick={() => { onChange(""); setOpen(false); }}>Clear date</button> : null}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

/* --------------------------------------------------------------- file drop */
export function FileDrop({ id, accept, maxBytes, file, onFile, hint, disabled }: {
  id?: string; accept: string; maxBytes: number; file: File | null; onFile: (f: File | null) => void; hint?: string; disabled?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const preview = React.useMemo(() => (file && file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [file]);
  React.useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  return (
    <div aria-disabled={disabled} className={disabled ? "pointer-events-none opacity-60" : undefined}>
      <input ref={inputRef} id={id} type="file" accept={accept} disabled={disabled} className="peer sr-only" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {file ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface/60 p-3">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="size-14 rounded-md border border-line object-cover" />
          ) : <div className="grid size-14 place-items-center rounded-md border border-line bg-card"><FileText className="size-6 text-muted" /></div>}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
          </div>
          <button type="button" onClick={() => { onFile(null); if (inputRef.current) inputRef.current.value = ""; }} className="btn grid size-9 place-items-center rounded-md text-muted hover:bg-card hover:text-ink" aria-label="Remove file"><X className="size-4" /></button>
        </div>
      ) : (
        <label htmlFor={id}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
          className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
            over ? "border-accent bg-accent-soft" : "border-line-strong bg-surface/40 hover:border-accent hover:bg-accent-soft/50")}>
          <span className="grid size-11 place-items-center rounded-full bg-card shadow-sm"><UploadCloud className="size-5 text-accent" /></span>
          <span className="text-sm"><span className="font-medium text-accent">Choose a file</span> or drag it here</span>
          <span className="text-xs text-muted">{hint ?? `JPEG, PNG, WebP or PDF · up to ${Math.round(maxBytes / 1048576)} MB`}</span>
        </label>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md", closeLabel = "Close" }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg"; closeLabel?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-inv/45 backdrop-blur-[2px]" />
        <RDialog.Content className={cn("fixed left-1/2 top-1/2 z-50 max-h-[90svh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-card shadow-lg animate-in focus:outline-none",
          size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl")}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div>
              <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-sm text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RDialog.Description>}
            </div>
            <RDialog.Close className="btn grid size-11 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink" aria-label={closeLabel}><X className="size-4" /></RDialog.Close>
          </div>
          <div className="px-6 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface/50 px-6 py-3">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Right-side sheet for detail panels on mobile/tablet. */
export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-inv/45" />
        <RDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-line bg-card shadow-lg animate-sheet focus:outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
            <RDialog.Description className="sr-only">Details</RDialog.Description>
            <RDialog.Close className="btn grid size-11 place-items-center rounded-md text-muted hover:bg-surface" aria-label="Close"><X className="size-4" /></RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* -------------------------------------------------------------- menu/tabs */
export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;
export function MenuContent({ children, align = "end" }: { children: React.ReactNode; align?: "start" | "end" | "center" }) {
  return (
    <RMenu.Portal>
      <RMenu.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-lg border border-line bg-card p-1 shadow-lg animate-in">{children}</RMenu.Content>
    </RMenu.Portal>
  );
}
export function MenuItem({ children, onSelect, danger }: { children: React.ReactNode; onSelect?: () => void; danger?: boolean }) {
  return <RMenu.Item onSelect={onSelect} className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-sm outline-none data-[highlighted]:bg-surface", danger ? "text-bad" : "text-ink")}>{children}</RMenu.Item>;
}
export const MenuSeparator = () => <RMenu.Separator className="my-1 h-px bg-line" />;

export function Tabs({ value, onValueChange, items, children }: { value: string; onValueChange: (v: string) => void; items: { value: string; label: React.ReactNode; count?: number }[]; children?: React.ReactNode }) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange}>
      <RTabs.List className="inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-surface p-1">
        {items.map((t) => (
          <RTabs.Trigger key={t.value} value={t.value} className="btn inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted data-[state=active]:bg-card data-[state=active]:text-ink data-[state=active]:shadow-sm">
            {t.label}{t.count !== undefined ? <span className="rounded-full bg-line px-1.5 text-xs tabular">{t.count}</span> : null}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}
export const TabPanel = RTabs.Content;

/* ------------------------------------------------------- checkbox/switch */
export function Checkbox({ id, checked, onCheckedChange, label, description, dark, required, name, value, disabled }: { id: string; checked: boolean; onCheckedChange: (c: boolean) => void; label: React.ReactNode; description?: React.ReactNode; dark?: boolean; required?: boolean; name?: string; value?: string; disabled?: boolean }) {
  return (
    <div className="flex min-h-11 items-start gap-3 py-2">
      <RCheckbox.Root id={id} checked={checked} onCheckedChange={(c) => onCheckedChange(c === true)} required={required} name={name} value={value} disabled={disabled}
        className={cn("btn mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] border disabled:cursor-not-allowed disabled:opacity-50", dark ? "border-white/40 bg-white/10 data-[state=checked]:border-white data-[state=checked]:bg-white" : "border-line-strong bg-card data-[state=checked]:border-accent data-[state=checked]:bg-accent")}>
        <RCheckbox.Indicator><Check className={cn("size-3.5", dark ? "text-ink" : "text-white")} strokeWidth={3} /></RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id} className={cn("text-sm leading-snug", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>{label}{description ? <span className={cn("block text-xs", dark ? "text-white/60" : "text-muted")}>{description}</span> : null}</label>
    </div>
  );
}

/** Accessible disclosure with an explicit trigger and consistent focus treatment. */
export function Disclosure({ title, children, className, triggerClassName, defaultOpen = false }: {
  title: React.ReactNode; children: React.ReactNode; className?: string; triggerClassName?: string; defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const id = React.useId();
  return <div className={className}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
      className={cn("btn flex min-h-11 w-full items-center justify-between gap-3 rounded-md text-left text-sm font-medium hover:text-accent [&_svg]:shrink-0", triggerClassName)}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">{title}</span>
      <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
    </button>
    <div id={id} hidden={!open} className="pt-3">{children}</div>
  </div>;
}

export function Switch({ id, checked, onCheckedChange, label }: { id: string; checked: boolean; onCheckedChange: (c: boolean) => void; label: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <RSwitch.Root id={id} checked={checked} onCheckedChange={onCheckedChange} className="relative h-6 w-11 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent">
        <RSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[22px]" />
      </RSwitch.Root>
      <label htmlFor={id} className="cursor-pointer text-sm">{label}</label>
    </div>
  );
}

export function Tip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={250}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal><RTooltip.Content sideOffset={6} className="z-50 rounded-md bg-inv px-2.5 py-1.5 text-xs text-inv-ink shadow-md animate-in">{content}</RTooltip.Content></RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}

export function Toaster() {
  return <SonnerToaster position="top-right" richColors closeButton toastOptions={{ style: { fontFamily: "var(--font-host)", borderRadius: 12 } }} />;
}
